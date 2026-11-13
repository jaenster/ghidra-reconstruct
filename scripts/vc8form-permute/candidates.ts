/**
 * Every vc8form that applies to a function, as tag text, with the body it prints.
 *
 * The search side of the form permuter (permute.ts): it hands over
 * function definitions as the tree prints them and gets back, per function, each form
 * applyVc8Forms implements at each site the body offers. A candidate is kept only when
 * its tag text parses back (parseVc8Form) to a form that applies and changes the body;
 * the body is always the one the parsed text prints, so what the compile measures is
 * exactly what the tag would do. No other edit is ever made: every form is
 * value-preserving by construction, or applyVc8Forms refuses it.
 *
 *   tsx candidates.ts singles <in.json> <out.json> [--types dataTypes.ndjson] [--globals globals.ndjson] [--ops a,b]
 *       in:  [{id, text}]   a function definition each
 *       out: [{id, roundtrip, error?, candidates: [{form, text, adds}]}]
 *   tsx candidates.ts apply <in.json> <out.json>
 *       in:  [{id, text, forms: [tag form text, ...]}]   forms applied in the order the
 *            generator sorts them (vc8FormSpec); same-op forms get `ord` by list order
 *       out: [{id, text?, applied: [form], refused: [{form, why}], ord: {form: n}}]
 *   tsx candidates.ts dh <snapshot dir> <addrs.json> <out.json>
 *       the generator's decompile hash (vc8formBodyHash) and size per address
 */
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parse, emit, NodeKind, applyVc8Forms, definitionOf, parseVc8Form, type Vc8Form } from '../../packages/cpp-parser/dist/index.js';
import type { ASTNode, FunctionDecl, TranslationUnit } from '../../packages/cpp-parser/dist/index.js';
import { vc8FormSpec, vc8formBodyHash } from '../../packages/reconstruct/src/codegen/vc8form-spec.js';
import { normalizeSignatureType } from '../../packages/reconstruct/src/codegen/platform-types.js';
import { respellPlaceholderType } from '../../packages/reconstruct/src/codegen/placeholder-types.js';
import { accessorTwins } from '../../packages/reconstruct/src/codegen/accessor-twins.js';
import { registerEnumTypedefTargets } from '../../packages/reconstruct/src/codegen/enum-width.js';
import type { Vc8Accessor } from '../../packages/cpp-parser/dist/index.js';

type N = ASTNode & Record<string, any>;

/** Printed text as a tag spells it: one line, namespace qualifiers dropped (as `dh` and the pass drop them). */
const unq = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/(?<![\w:])(?:::)?(?:[A-Za-z_]\w*::)+(?=[A-Za-z_~])/g, '');
const pr = (n: ASTNode) => unq(emit(n as never));
/** As printed, qualifiers kept: for an expression a form writes into a new declaration (cache). */
const prq = (n: ASTNode) => emit(n as never).replace(/\s+/g, ' ').trim();
const key = (s: string) => s.replace(/\s+/g, '');

function* walk(root: ASTNode): Generator<N> {
  yield root as N;
  for (const k of Object.keys(root)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (k === 'member' && root.kind === NodeKind.MemberExpr) continue;
    const v = (root as N)[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof x.kind === 'string') yield* walk(x); }
    else if (v && typeof v === 'object' && typeof v.kind === 'string') yield* walk(v);
  }
}

const unparen = (e: N): N => { while (e && e.kind === NodeKind.ParenExpr) e = e.expression; return e; };
const fnOf = (tu: TranslationUnit) => definitionOf(tu);
const body = (tu: TranslationUnit) => emit(tu as never).trimEnd();

// ---------------------------------------------------------------------------------------
// Types, for the forms that declare a local: the Ghidra model's own field and global types.

interface Field { name: string; dataType: string }
let structs = new Map<string, { kind: string; fields?: Field[]; typedefOf?: string }>();
let globals = new Map<string, string>();
/** Typedef and enum names to the integer type the tree declares them as (castout reads a return type's width). */
const typedefTargets: Record<string, string> = {};

/** The tables `acc` reads: the struct fields, the enumerators and the accessors (accessor-twins.ts). */
const accTables: { structFields: Record<string, Record<string, string>>; enumValues: Record<string, number>; accessors: Vc8Accessor[] } =
  { structFields: {}, enumValues: {}, accessors: [] };

function loadTypes(path?: string) {
  if (!path) return;
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l) continue;
    const t = JSON.parse(l);
    if (t.kind === 'ENUM' && Array.isArray(t.values)) for (const v of t.values) accTables.enumValues[v.name] ??= v.value;
    if (t.kind === 'ENUM' && !(t.name in typedefTargets)) registerEnumTypedefTargets([t], typedefTargets);
    if (t.kind === 'TYPEDEF' && t.underlyingType && !(t.name in typedefTargets)) typedefTargets[t.name] = spell(t.underlyingType);
    if (structs.has(t.name)) continue;
    structs.set(t.name, { kind: t.kind, fields: t.fields, typedefOf: t.underlyingType });
    if (t.fields) accTables.structFields[t.name] = Object.fromEntries(t.fields.filter((f: Field) => f.name).map((f: Field) => [f.name, spell(f.dataType)]));
  }
}

/** The header inlines that read one field, from the snapshot's functions beside the types. */
async function loadAccessors(typesPath?: string) {
  if (!typesPath) return;
  const path = typesPath.replace(/dataTypes\.ndjson$/, 'functions.ndjson');
  const hosts: any[] = [];
  const rl = createInterface({ input: createReadStream(path) });
  for await (const l of rl) if (l.includes('"inline-host"')) hosts.push(JSON.parse(l));
  accTables.accessors = accessorTwins(hosts, accTables);
}

async function loadGlobals(path?: string) {
  if (!path) return;
  const rl = createInterface({ input: createReadStream(path) });
  for await (const l of rl) {
    if (!l) continue;
    const g = JSON.parse(l);
    if (g.name && g.dataType && !globals.has(g.name)) globals.set(g.name, g.dataType);
  }
}

/** The global types the generator hands the forms (its `globalTypes`), from the model: which globals are arrays. */
/** `--ops a,b`: only the forms of those ops are proposed. */
let onlyOps: Set<string> | undefined;

let tablesMemo: { globalTypes: Record<string, string>; typedefTargets: Record<string, string> } | undefined;
const tables = () => (tablesMemo ??= { globalTypes: Object.fromEntries([...globals].map(([k, v]) => [k, tidy(v)])), typedefTargets });

const tidy = (t: string) => t.replace(/\bstruct\s+|\bunion\s+|\benum\s+/g, '').replace(/\s*\*/g, '*').replace(/\s+/g, ' ').trim();

/** A model type as the tree spells it: the generator's own respelling (`ushort` is `uint16_t`). */
const spell = (t: string) => tidy(respellPlaceholderType(normalizeSignatureType(t)));

/** A field's type in the model: base type (a struct, union or pointer to one), field name. */
function fieldType(base: string, field: string, arrow: boolean): string | undefined {
  let t = tidy(base);
  if (arrow) { if (!t.endsWith('*')) return undefined; t = t.slice(0, -1).trim(); }
  t = t.replace(/^const /, '');
  for (let hop = 0; hop < 4; hop++) {
    const s = structs.get(t);
    if (!s) return undefined;
    if (s.fields) {
      const f = s.fields.find(x => x.name === field);
      return f ? spell(f.dataType) : undefined;
    }
    if (!s.typedefOf) return undefined;
    t = tidy(s.typedefOf);
  }
  return undefined;
}

/** The type of an lvalue expression the forms may cache: a local, a parameter, a global, a member chain. */
function typeOf(e: N, vars: Map<string, string>): string | undefined {
  e = unparen(e);
  if (e.kind === NodeKind.Identifier) return vars.get(e.name) ?? (globals.has(e.name) ? spell(globals.get(e.name)!) : undefined);
  if (e.kind === NodeKind.QualifiedId) { const s = pr(e); return globals.has(s) ? spell(globals.get(s)!) : undefined; }
  if (e.kind === NodeKind.MemberExpr && e.member?.kind === NodeKind.Identifier) {
    const b = typeOf(e.object, vars);
    return b ? fieldType(b, e.member.name, e.isArrow) : undefined;
  }
  return undefined;
}

/** A type a local may be declared with: no array, no function pointer, nothing Ghidra leaves undefined. */
const declarable = (t: string | undefined): t is string => !!t && !/[\[\]()]/.test(t) && !/^undefined\d*\*?$/.test(t) && t !== 'void';

// ---------------------------------------------------------------------------------------
// Sites

interface Ctx { fn: FunctionDecl; vars: Map<string, string>; locals: Set<string> }

function context(fn: FunctionDecl): Ctx {
  const vars = new Map<string, string>(), locals = new Set<string>();
  for (const p of fn.parameters) if (p.name) vars.set(p.name.name, tidy(emit(p.type as never)));
  for (const n of walk(fn.body!)) if (n.kind === NodeKind.VariableDecl) { vars.set(n.name.name, tidy(emit(n.type as never))); locals.add(n.name.name); }
  return { fn, vars, locals };
}

/** `[,i]`: 0 when the site is the only one of its text, else 1..count. */
function indexed(texts: string[]): Array<{ t: string; i: number }> {
  const count = new Map<string, number>(), out: Array<{ t: string; i: number }> = [];
  for (const t of texts) count.set(key(t), (count.get(key(t)) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const t of texts) {
    const n = (seen.get(key(t)) ?? 0) + 1; seen.set(key(t), n);
    out.push({ t, i: count.get(key(t)) === 1 ? 0 : n });
  }
  return out;
}
const withIdx = (op: string, args: string, i: number, one: boolean) => `${op}(${args}${i > 0 ? `,${i}` : one ? '' : ''})`;

/** What a statement stores to, as the seq form names it, or undefined. */
function seqTarget(s: N): string | undefined {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unparen(s.expression);
    if (e.kind === NodeKind.AssignExpr) return pr(e.left);
    if ((e.kind === NodeKind.UnaryExpr && (e.operator === '++' || e.operator === '--')) || e.kind === NodeKind.PostfixExpr) return pr(e.operand);
  }
  if (s.kind === NodeKind.DeclStmt && s.declarations.length === 1 && s.declarations[0].initializer) return s.declarations[0].name.name;
  return undefined;
}

function* permutations<T>(xs: T[]): Generator<T[]> {
  if (xs.length <= 1) { yield xs; return; }
  for (let i = 0; i < xs.length; i++) for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) yield [xs[i], ...p];
}

const COMMUTES = new Set(['+', '*', '&', '|', '^']);
const COMPARES = new Set(['<', '>', '<=', '>=', '==', '!=']);

/** Every form text worth asking applyVc8Forms about, for one function. */
function sites(c: Ctx, maxAnchors: number): string[] {
  const out = new Set<string>();
  const { fn, vars, locals } = c;
  const all = [...walk(fn.body!)];
  const blocks = all.filter(n => n.kind === NodeKind.CompoundStmt);
  const free = (stem: string) => { for (let k = 0; ; k++) if (!vars.has(`${stem}${k}`)) return `${stem}${k}`; };

  // seq: adjacent stores, every other order of each run of two to four.
  const seqRuns: string[][] = [];
  for (const b of blocks) {
    const st = b.statements as N[];
    for (let k = 0; k < st.length; k++) {
      for (const len of [2, 3, 4]) {
        const run = st.slice(k, k + len).map(seqTarget);
        if (run.length < len || run.some(t => t === undefined)) continue;
        seqRuns.push(run as string[]);
      }
    }
  }
  for (const run of seqRuns) {
    const n = seqRuns.filter(r => r.length === run.length && [...r].sort().join('\0') === [...run].sort().join('\0')).length;
    for (const p of permutations(run)) {
      if (p.every((t, i) => t === run[i])) continue;
      if (n === 1) out.add(`seq(${p.join(',')})`);
      else for (let i = 1; i <= n; i++) out.add(`seq(${p.join(',')},@${i})`);
    }
  }

  // fold, ifsel, coalesce (copy-coalesce's proof decides), split (same type, a new name),
  // width (a type a cast of V names).
  const casts = new Map<string, Set<string>>();
  for (const n of all) {
    if (n.kind !== NodeKind.CStyleCastExpr) continue;
    const e = unparen(n.expression);
    if (e.kind === NodeKind.Identifier && locals.has(e.name)) {
      if (!casts.has(e.name)) casts.set(e.name, new Set());
      casts.get(e.name)!.add(tidy(emit(n.type as never)));
    }
  }
  for (const v of locals) {
    // coalesce before fold: where both print one body, the tag names the proven fold.
    out.add(`coalesce(${v})`);
    out.add(`fold(${v})`);
    out.add(`ifsel(${v})`);
    if (declarable(vars.get(v))) out.add(`split(${v},${vars.get(v)},${v}_2)`);
    for (const t of casts.get(v) ?? []) {
      if (declarable(t) && !t.endsWith('*')) out.add(`width(${v},${t})`);
      // `live` only where own refuses a read initializer: listed after the plain form, a
      // live body equal to the plain one is the same candidate and goes. permute.ts keeps
      // a `live` tag on a MATCH alone.
      if (declarable(t)) { out.add(`own(${v},${t})`); out.add(`own(${v},${t},live)`); }
    }
  }
  // boolflag: a bool local; retwiden: a narrow integer local stored from a call (the forms refuse the rest).
  const NARROW = new Set(['char', 'unsigned char', 'signed char', 'uint8_t', 'int8_t', 'BYTE', 'byte', 'short', 'short int', 'unsigned short',
    'unsigned short int', 'int16_t', 'uint16_t', 'WORD', 'ushort', 'wchar_t']);
  const callStored = new Set<string>();
  for (const n of all) {
    const v = n.kind === NodeKind.AssignExpr && n.operator === '=' ? unparen(n.left) : undefined;
    if (v?.kind === NodeKind.Identifier && unparen(n.right).kind === NodeKind.CallExpr) callStored.add(v.name);
    if (n.kind === NodeKind.VariableDecl && n.initializer && unparen(n.initializer).kind === NodeKind.CallExpr) callStored.add(n.name.name);
  }
  for (const v of locals) {
    if (vars.get(v) === 'bool') out.add(`boolflag(${v})`);
    if (NARROW.has(vars.get(v) ?? '') && callStored.has(v)) out.add(`retwiden(${v})`);
  }
  // width to a full register: a flag or a one- or two-byte local the original keeps in a
  // 32-bit register or slot, cast or not (the frame-width class: `xor r32,r32` before a
  // setcc, a 4-byte slot where the tree declares a byte). doWidth refuses what changes a value.
  const WNARROW = new Set([...NARROW, 'WCHAR', 'uchar', 'UCHAR', 'CHAR', 'SHORT', 'USHORT']);
  const UNSIGNED = /^(unsigned|uint|uchar|UCHAR|BYTE|byte|WORD|ushort|USHORT|wchar_t|WCHAR)/;
  for (const v of locals) {
    const t = vars.get(v) ?? '';
    if (t === 'bool') { out.add(`width(${v},BOOL)`); continue; }
    if (!WNARROW.has(t)) continue;
    out.add(`width(${v},int)`);
    if (UNSIGNED.test(t)) out.add(`width(${v},uint32_t)`);
  }

  // decl: a declaration without initializer moved before another declaration of its block.
  for (const b of blocks) {
    // A declarator without a plain name (a function pointer, an array of them) has no `decl` tag.
    const decls = (b.statements as N[]).filter(s => s.kind === NodeKind.DeclStmt && s.declarations.length === 1)
      .map(s => s.declarations[0]).filter(d => typeof d.name?.name === 'string');
    for (const d of decls) if (!d.initializer) for (const w of decls) if (w !== d) out.add(`decl(${d.name.name},${w.name.name})`);
  }

  // cache: member chains and globals read in the body, typed from the model.
  const cacheable = new Map<string, N>();
  for (const n of all) {
    if (n.kind === NodeKind.MemberExpr || (n.kind === NodeKind.Identifier && !vars.has(n.name) && globals.has(n.name))) cacheable.set(key(pr(n)), n);
  }
  const anchors: string[] = [];
  for (const b of blocks) for (const s of b.statements as N[]) {
    const t = seqTarget(s);
    if (t) anchors.push(t);
    if ((s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.SwitchStmt) && s.condition) anchors.push(pr(s.condition));
  }
  const name = free('t2_c');
  for (const [, e] of cacheable) {
    const t = typeOf(e, vars);
    if (!declarable(t)) continue;
    // The new local's initializer is written from E's text: it keeps the qualifiers the
    // TU needs to name it (a tag's sites ignore qualifiers, so it still finds every E).
    const E = prq(e);
    out.add(`cache(${E},${name},${t})`);
    for (const a of [...new Set(anchors)].slice(0, maxAnchors)) out.add(`cache(${E},${name},${t},@${a})`);
  }
  // cache(E,N): a local stored from E.
  for (const n of all) {
    let v: string | undefined, r: N | undefined;
    if (n.kind === NodeKind.AssignExpr && n.operator === '=' && unparen(n.left).kind === NodeKind.Identifier) { v = unparen(n.left).name; r = n.right; }
    if (n.kind === NodeKind.VariableDecl && n.initializer) { v = n.name.name; r = n.initializer; }
    if (v && r && locals.has(v) && (unparen(r).kind === NodeKind.MemberExpr || unparen(r).kind === NodeKind.Identifier)) out.add(`cache(${pr(unparen(r))},${v})`);
  }

  // Control flow: ifs without an else (nest, merge-tail, continue, select), if/else (arms).
  const ifs = all.filter(n => n.kind === NodeKind.IfStmt && !n.init);
  for (const { t, i } of indexed(ifs.filter(s => !s.elseBranch).map(s => pr(s.condition)))) {
    for (const op of ['nest', 'merge-tail', 'continue', 'select']) out.add(withIdx(op, t, i, true));
    out.add(withIdx('tailguard', t, i, true));
    out.add(withIdx('tailcopy', t, i, true));
  }
  // arms: the i-th if/else on its condition where several share it.
  const elseConds = ifs.filter(s => s.elseBranch).map(s => pr(s.condition));
  for (const t of new Set(elseConds)) {
    const n = elseConds.filter(x => key(x) === key(t)).length;
    out.add(`arms(${t})`); out.add(`arms(${t},wrap)`);
    for (let i = 2; i <= n; i++) { out.add(`arms(${t},${i})`); out.add(`arms(${t},wrap,${i})`); }
  }
  const guards = ifs.filter(s => !s.elseBranch);
  for (let i = 1; i <= guards.length; i++) { out.add(`merge-guards(${i})`); for (let k = 1; k <= 3; k++) out.add(`guards(${k},${i})`); }
  for (const b of blocks) {
    const st = b.statements as N[];
    for (let k = 1; k < st.length; k++) if (st[k].kind === NodeKind.ExprStmt && st[k - 1].kind === NodeKind.IfStmt && st[k - 1].elseBranch) out.add(`dup(${pr(st[k].expression)})`);
  }
  // tsel: an if/else storing the same locals in both arms, read by the call after it. The
  // condition as printed with and without qualifiers (select-argument compares it as printed).
  const elses = ifs.filter(s => s.elseBranch);
  for (const p of [pr, prq]) {
    const texts = elses.map(s => p(s.condition));
    for (const t of new Set(texts)) {
      const n = texts.filter(x => key(x) === key(t)).length;
      out.add(`tsel(${t})`);
      for (let i = 2; i <= n; i++) out.add(`tsel(${t},${i})`);
    }
  }
  // hoist: the plain store that begins the block arm of an if with no else.
  const hoists: string[] = [];
  for (const b of blocks) for (const s of b.statements as N[]) {
    if (s.kind !== NodeKind.IfStmt || s.init || s.elseBranch || s.thenBranch?.kind !== NodeKind.CompoundStmt) continue;
    const arm = s.thenBranch.statements as N[];
    if (arm.length >= 2 && arm[0].kind === NodeKind.ExprStmt) hoists.push(pr(arm[0].expression));
  }
  for (const { t, i } of indexed(hoists)) out.add(withIdx('hoist', t, i, true));

  // retval: a store of a constant to the returned local.
  const returned = new Set(all.filter(n => n.kind === NodeKind.ReturnStmt && n.value && unparen(n.value).kind === NodeKind.Identifier).map(n => unparen(n.value).name));
  for (const n of all) if (n.kind === NodeKind.AssignExpr && n.operator === '=' && unparen(n.left).kind === NodeKind.Identifier && returned.has(unparen(n.left).name)) out.add(`retval(${unparen(n.left).name},${pr(n.right)})`);

  // Expressions.
  const conds = all.filter(n => n.kind === NodeKind.ConditionalExpr);
  for (const { t, i } of indexed(conds.map(c => pr(c.condition)))) out.add(withIdx('tarms', t, i, true));
  const retSel = all.filter(n => n.kind === NodeKind.ReturnStmt && n.value && unparen(n.value).kind === NodeKind.ConditionalExpr).map(n => pr(unparen(n.value).condition));
  for (const { t, i } of indexed(retSel)) out.add(withIdx('unselect', t, i, true));
  const nots = all.filter(n => n.kind === NodeKind.UnaryExpr && n.operator === '!').map(n => pr(unparen(n.operand)));
  for (const { t, i } of indexed(nots)) out.add(withIdx('zero', t, i, true));
  const tested: string[] = [];
  for (const n of all) {
    const at = (e: N | null | undefined) => { if (e) { const u = unparen(e); if (!(u.kind === NodeKind.BinaryExpr && COMPARES.has(u.operator))) tested.push(pr(u)); } };
    if ([NodeKind.IfStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ConditionalExpr].includes(n.kind)) at(n.condition);
    if (n.kind === NodeKind.BinaryExpr && (n.operator === '&&' || n.operator === '||')) { at(n.left); at(n.right); }
  }
  for (const { t, i } of indexed(tested)) out.add(withIdx('nonzero', t, i, true));
  // bool: every truth test - those nonzero reaches, the operand of `!`, a side compared with 0.
  const truth = [...tested];
  for (const n of all) {
    if (n.kind === NodeKind.UnaryExpr && n.operator === '!') truth.push(pr(unparen(n.operand)));
    if (n.kind === NodeKind.BinaryExpr && (n.operator === '==' || n.operator === '!=')) {
      const zero = (e: N) => { const u = unparen(e); return u.kind === NodeKind.IntegerLiteral && BigInt(u.value) === 0n; };
      if (zero(n.right)) truth.push(pr(unparen(n.left))); else if (zero(n.left)) truth.push(pr(unparen(n.right)));
    }
  }
  const truthN = new Map<string, number>();
  for (const t of truth) truthN.set(key(t), (truthN.get(key(t)) ?? 0) + 1);
  for (const t of new Set(truth)) {
    const n = truthN.get(key(t))!;
    if (n === 1) out.add(`bool(${t})`); else for (let i = 1; i <= n; i++) out.add(`bool(${t},${i})`);
  }

  // shift: a narrowed `E >> k` of a local or parameter, both ways (the form refuses the
  // one the body already has, and any site whose cast keeps a bit the shifts disagree on).
  const shifted = new Map<string, number>();
  for (const n of all) {
    if (n.kind !== NodeKind.CStyleCastExpr) continue;
    const sh = unparen(n.expression);
    if (sh.kind !== NodeKind.BinaryExpr || sh.operator !== '>>') continue;
    let e = unparen(sh.left);
    if (e.kind === NodeKind.CStyleCastExpr) e = unparen(e.expression);
    if (e.kind === NodeKind.Identifier) shifted.set(e.name, (shifted.get(e.name) ?? 0) + 1);
  }
  for (const [v, n] of shifted) {
    for (const how of ['sar', 'shr']) {
      if (n === 1) out.add(`shift(${v},${how})`); else for (let i = 1; i <= n; i++) out.add(`shift(${v},${how},${i})`);
    }
  }

  // nestcall: a local stored from one call, the i-th such store when there are several.
  const callStores = new Map<string, number>();
  for (const n of all) {
    let v: string | undefined, r: N | undefined;
    if (n.kind === NodeKind.AssignExpr && n.operator === '=' && unparen(n.left).kind === NodeKind.Identifier) { v = unparen(n.left).name; r = n.right; }
    if (n.kind === NodeKind.VariableDecl && n.initializer) { v = n.name.name; r = n.initializer; }
    if (v && r && unparen(r).kind === NodeKind.CallExpr) callStores.set(v, (callStores.get(v) ?? 0) + 1);
  }
  for (const [v, n] of callStores) {
    if (n === 1) out.add(`nestcall(${v})`); else for (let i = 1; i <= n; i++) out.add(`nestcall(${v},${i})`);
  }
  // fill: the array a memset clears or a pointer zero-loop walks; copy: a copy loop's target.
  const fills = new Map<string, number>(), copies = new Map<string, number>();
  const bump = (m: Map<string, number>, v: string) => m.set(v, (m.get(v) ?? 0) + 1);
  for (const n of all) {
    if (n.kind === NodeKind.CallExpr && pr(n.callee) === 'memset' && n.arguments.length === 3) {
      let d = unparen(n.arguments[0]);
      if (d.kind === NodeKind.BinaryExpr && d.operator === '+') d = unparen(d.left);
      if (d.kind === NodeKind.Identifier) bump(fills, d.name);
    }
    if (n.kind === NodeKind.CompoundStmt) {
      const st = n.statements as N[];
      for (let k = 0; k + 1 < st.length; k++) {
        if (st[k + 1].kind !== NodeKind.ForStmt) continue;
        const s = st[k];
        const r = s.kind === NodeKind.ExprStmt && unparen(s.expression).kind === NodeKind.AssignExpr ? unparen(s.expression).right
          : s.kind === NodeKind.DeclStmt && s.declarations.length === 1 ? s.declarations[0].initializer : undefined;
        if (r && unparen(r).kind === NodeKind.Identifier) bump(fills, unparen(r).name);
      }
    }
    if (n.kind === NodeKind.ForStmt) {
      const first = (n.body?.kind === NodeKind.CompoundStmt ? n.body.statements : [n.body])[0] as N | undefined;
      const e = first?.kind === NodeKind.ExprStmt ? unparen(first.expression) : undefined;
      if (e?.kind === NodeKind.AssignExpr && unparen(e.left).kind === NodeKind.UnaryExpr && unparen(e.left).operator === '*') {
        const d = unparen(unparen(e.left).operand);
        if (d.kind === NodeKind.Identifier) bump(copies, d.name);
      }
    }
  }
  for (const [op, m] of [['fill', fills], ['elems', fills], ['copy', copies]] as const) {
    for (const [v, n] of m) { out.add(`${op}(${v})`); for (let i = 1; i <= Math.min(n, 8); i++) out.add(`${op}(${v},${i})`); }
  }
  // ptrwalk: a for loop counting i up by one, over X[i] (X a name: a local, a parameter, a global).
  const elem = (t: string | undefined) => (t ? (/\[\w*\]$/.test(t) ? t.replace(/\s*\[\w*\]$/, '') : t.endsWith('*') ? t.slice(0, -1).trim() : undefined) : undefined);
  const nameOf = (x: N) => (unparen(x).kind === NodeKind.Identifier || unparen(x).kind === NodeKind.QualifiedId ? prq(unparen(x)) : undefined);
  const walks = new Map<string, number>();
  for (const n of all) {
    if (n.kind !== NodeKind.ForStmt || !n.increment) continue;
    const inc = unparen(n.increment);
    const i = (inc.kind === NodeKind.PostfixExpr || inc.kind === NodeKind.UnaryExpr) && inc.operator === '++' && unparen(inc.operand).kind === NodeKind.Identifier ? unparen(inc.operand).name : undefined;
    if (!i) continue;
    const xs = new Map<string, N>();
    for (const m of [...walk(n.body), ...(n.condition ? walk(n.condition) : [])]) {
      if (m.kind !== NodeKind.SubscriptExpr || unparen(m.index).kind !== NodeKind.Identifier || unparen(m.index).name !== i) continue;
      const x = nameOf(m.array);
      if (x) xs.set(x, unparen(m.array));
    }
    for (const [x, xn] of xs) {
      const t = elem(typeOf(xn, vars));
      if (!declarable(t)) continue;
      const k = `${i}\0${key(x)}`;
      walks.set(k, (walks.get(k) ?? 0) + 1);
      const nth = walks.get(k)!;
      out.add(`ptrwalk(${i},${x},${free('t2_p')},${t})`);
      out.add(`ptrwalk(${i},${x},${free('t2_p')},${t},${nth})`);
    }
  }
  // rowptr: a row X[I] (I no constant), or the base of a flat X[I + k], with X a named table.
  const rows = new Map<string, { x: N; e: string }>();
  for (const n of all) {
    if (n.kind !== NodeKind.SubscriptExpr) continue;
    const x = nameOf(n.array);
    if (!x) continue;
    const ix = unparen(n.index);
    if (ix.kind === NodeKind.IntegerLiteral) continue;
    let base: N = ix;
    if (ix.kind === NodeKind.BinaryExpr && ix.operator === '+') {
      if (unparen(ix.right).kind === NodeKind.IntegerLiteral) base = ix.left; else if (unparen(ix.left).kind === NodeKind.IntegerLiteral) base = ix.right;
    }
    const e = `${x}[${prq(unparen(base))}]`;
    rows.set(key(e), { x: unparen(n.array), e });
  }
  const rname = free('t2_r');
  for (const [, { x, e }] of rows) {
    const t = elem(typeOf(x, vars));
    if (!declarable(t)) continue;
    out.add(`rowptr(${e},${rname},${t})`);
    for (const a of [...new Set(anchors)].slice(0, maxAnchors)) out.add(`rowptr(${e},${rname},${t},@${a})`);
  }
  const cmps = all.filter(n => n.kind === NodeKind.BinaryExpr && COMPARES.has(n.operator)).map(n => pr(n));
  for (const { t, i } of indexed(cmps)) for (const how of ['mirror', 'lit', 'mirror-lit']) out.add(`cmp(${t},${how}${i > 0 ? `,${i}` : ''})`);
  const sw = all.filter(n => n.kind === NodeKind.BinaryExpr && COMMUTES.has(n.operator)).map(n => pr(n));
  for (const { t, i } of indexed(sw)) out.add(withIdx('swap', t, i, true));
  // acc: each read of a field an accessor returns, with and without the null test before it.
  const accField = new Set(accTables.accessors.map(a => a.path[a.path.length - 1]));
  const reads = all.filter(n => n.kind === NodeKind.MemberExpr && n.member?.kind === NodeKind.Identifier && accField.has(n.member.name)).map(n => pr(n));
  for (const { t, i } of indexed(reads)) { out.add(withIdx('acc', t, i, true)); out.add(`acc(${t}${i > 0 ? `,${i}` : ''},bare)`); }
  // roundup: the local an `if (V % G)` rounds up, alone and summed into each parameter.
  const params = fn.parameters.map(p => (p as N).name?.name).filter((n): n is string => typeof n === 'string');
  for (const n of all) {
    if (n.kind !== NodeKind.IfStmt) continue;
    const c = unparen(n.condition);
    if (c.kind !== NodeKind.BinaryExpr || c.operator !== '%' || unparen(c.left).kind !== NodeKind.Identifier) continue;
    const v = unparen(c.left).name;
    if (!locals.has(v)) continue;
    out.add(`roundup(${v})`);
    for (const p of params) out.add(`roundup(${v},${p})`);
  }
  // clamp: a local an if tests against a bound with a relational operator; alone, and the
  // i-th such if where there are several (doClamp refuses what is no adjacent clamp).
  const clamped = new Map<string, number>();
  for (const n of all) {
    if (n.kind !== NodeKind.IfStmt || n.elseBranch) continue;
    const c = unparen(n.condition);
    if (c.kind !== NodeKind.BinaryExpr || !['<', '<=', '>', '>='].includes(c.operator)) continue;
    for (const side of [unparen(c.left), unparen(c.right)]) {
      if (side.kind === NodeKind.Identifier && locals.has(side.name)) clamped.set(side.name, (clamped.get(side.name) ?? 0) + 1);
    }
  }
  for (const [v, n] of clamped) {
    out.add(`clamp(${v})`);
    if (n > 1) for (let i = 1; i <= n; i++) out.add(`clamp(${v},${i})`);
  }
  // join: a top-level initialized local and each other local or parameter its initializer reads.
  for (const s of fn.body!.statements as N[]) {
    if (s.kind !== NodeKind.DeclStmt || s.declarations.length !== 1 || !s.declarations[0].initializer) continue;
    const into = s.declarations[0].name?.name;
    if (typeof into !== 'string') continue;
    for (const n of walk(s.declarations[0].initializer)) {
      if (n.kind === NodeKind.Identifier && vars.has(n.name) && n.name !== into) out.add(`join(${into},${n.name})`);
    }
  }
  // swmerge: a local bounded from above by an if with an else (the range tests around a switch).
  const bounded = new Map<string, number>();
  for (const n of all) {
    if (n.kind !== NodeKind.IfStmt || !n.elseBranch) continue;
    const c = unparen(n.condition);
    if (c.kind !== NodeKind.BinaryExpr || (c.operator !== '<=' && c.operator !== '<') || unparen(c.left).kind !== NodeKind.Identifier) continue;
    const v = unparen(c.left).name;
    if (!locals.has(v) && !params.includes(v)) continue;
    bounded.set(v, (bounded.get(v) ?? 0) + 1);
    out.add(`swmerge(${v},${bounded.get(v)})`);
  }
  // dec: a local read as `V - K` (K a positive unsuffixed literal) at least twice.
  const diffs = new Map<string, number>();
  for (const n of all) {
    if (n.kind !== NodeKind.BinaryExpr || n.operator !== '-') continue;
    const l = unparen(n.left), r = unparen(n.right);
    if (l.kind !== NodeKind.Identifier || !locals.has(l.name) || r.kind !== NodeKind.IntegerLiteral || r.suffix !== '') continue;
    if (r.value <= 0n || r.value > 0x7fffffffn) continue;
    const k = `${l.name},${r.value}`;
    diffs.set(k, (diffs.get(k) ?? 0) + 1);
  }
  for (const [k, n] of diffs) if (n >= 2) out.add(`dec(${k})`);
  // opas: a local or parameter read as `V + 1`, `V - 1` or `V >> K` (K a shift count).
  for (const n of all) {
    if (n.kind !== NodeKind.BinaryExpr || !['+', '-', '>>'].includes(n.operator)) continue;
    const l = unparen(n.left), r = unparen(n.right);
    if (l.kind !== NodeKind.Identifier || !(locals.has(l.name) || params.includes(l.name))) continue;
    if (r.kind !== NodeKind.IntegerLiteral || r.suffix !== '') continue;
    if (n.operator === '>>' ? r.value < 1n || r.value > 31n : r.value !== 1n) continue;
    const k = /^0x[0-9a-fA-F]+$/.test(r.raw ?? '') ? r.raw : String(r.value);
    out.add(`opas(${l.name},${n.operator},${k})`);
  }
  // range: a comparison of a difference `E - L` (L an integer literal) with an integer literal.
  const isLit = (e: N) => unparen(e).kind === NodeKind.IntegerLiteral;
  const isDiff = (e: N): boolean => {
    let d = unparen(e);
    if (d.kind === NodeKind.CStyleCastExpr) d = unparen(d.expression);
    return d.kind === NodeKind.BinaryExpr && d.operator === '-' && unparen(d.left).kind === NodeKind.Identifier && isLit(d.right);
  };
  const ranges = all.filter(n => n.kind === NodeKind.BinaryExpr && ['<', '<=', '>', '>='].includes(n.operator)
    && ((isLit(n.right) && isDiff(n.left)) || (isLit(n.left) && isDiff(n.right)))).map(n => pr(n));
  for (const { t, i } of indexed(ranges)) out.add(withIdx('range', t, i, true));
  // castout: a sum or difference with an operand narrowed by a cast to an integer type.
  const narrowCast = (e: N) => { const x = unparen(e); return x.kind === NodeKind.CStyleCastExpr && unparen(x.expression).kind === NodeKind.Identifier; };
  const castouts = all.filter(n => n.kind === NodeKind.BinaryExpr && (n.operator === '-' || n.operator === '+')
    && (narrowCast(n.left) || (n.operator === '+' && narrowCast(n.right)))).map(n => pr(n));
  for (const { t, i } of indexed(castouts)) out.add(withIdx('castout', t, i, true));
  // signbit: a sign test `E < 0` / `E >= 0` of a local or parameter, or of `(int)` of one.
  const signs = all.filter(n => n.kind === NodeKind.BinaryExpr && (n.operator === '<' || n.operator === '>=')
    && unparen(n.right).kind === NodeKind.IntegerLiteral && unparen(n.right).value === 0n && (() => {
      const l = unparen(n.left);
      return l.kind === NodeKind.Identifier || (l.kind === NodeKind.CStyleCastExpr && unparen(l.expression).kind === NodeKind.Identifier);
    })()).map(n => pr(n));
  for (const { t, i } of indexed(signs)) out.add(withIdx('signbit', t, i, true));
  // switch: a value an if compares for (in)equality; the i-th if of the two-case shape on it.
  const switched = new Map<string, { t: string; n: number }>();
  for (const n of ifs) {
    const c = unparen(n.condition);
    if (c.kind !== NodeKind.BinaryExpr || (c.operator !== '==' && c.operator !== '!=')) continue;
    const t = pr(unparen(c.left)), k = key(t);
    switched.set(k, { t, n: (switched.get(k)?.n ?? 0) + 1 });
  }
  for (const [, { t, n }] of switched) { out.add(`switch(${t})`); for (let i = 2; i <= n; i++) out.add(`switch(${t},${i})`); }
  return [...out];
}

/** The names a form declares, for the phase control: each new local is one more front-end symbol. */
function adds(form: Vc8Form): number {
  return (form.op === 'cache' && form.type) || form.op === 'split' || (form.op === 'own' && form.rename) ? 1 : 0;
}

function tryForm(tu: TranslationUnit, text: string): { text: string; form: Vc8Form } | { why: string } {
  const form = parseVc8Form(text);
  if (!form) return { why: 'does not parse' };
  let why: string | undefined, applied = false;
  let prefix: string[] = [];
  let out: TranslationUnit;
  try {
    out = applyVc8Forms(tu, [{ form }], s => { applied = s.applied; why = s.why; prefix = s.prefix ?? []; }, { ...tables(), ...accTables } as never);
  } catch (e) {
    // A form the pass cannot even attempt is no candidate; say which, it is a pass defect.
    process.stderr.write(`form ${text} threw: ${(e as Error).message.split('\n')[0]}\n`);
    return { why: 'threw' };
  }
  if (!applied) return { why: why ?? 'refused' };
  // A twin the form calls is written ahead of the function, as the unit writes it.
  return { text: [...prefix, body(out)].join('\n\n'), form };
}

export function singles(items: Array<{ id: string; text: string }>, maxAnchors: number) {
  return items.map(({ id, text }) => {
    let tu: TranslationUnit;
    try { tu = parse(text); } catch (e) { return { id, error: `parse: ${(e as Error).message.split('\n')[0]}`, candidates: [] }; }
    const fn = fnOf(tu);
    if (!fn || tu.declarations.length !== 1) return { id, error: 'not one function definition', candidates: [] };
    const roundtrip = body(tu);
    const seen = new Set<string>([key(roundtrip)]);
    const candidates: Array<{ form: string; text: string; adds: number }> = [];
    let forms: string[];
    try { forms = [...sites(context(fn), maxAnchors)].filter(f => !onlyOps || onlyOps.has(f.replace(/\(.*$/s, ''))); } catch (e) { return { id, error: `sites: ${(e as Error).message.split('\n')[0]}`, candidates: [] }; }
    for (const f of forms) {
      const r = tryForm(tu, f);
      if ('why' in r) continue;
      if (seen.has(key(r.text))) continue;
      seen.add(key(r.text));
      candidates.push({ form: f, text: r.text, adds: adds(r.form) });
    }
    return { id, roundtrip, candidates };
  });
}

/**
 * Several forms on one function, in the generator's order: vc8FormSpec sorts a function's
 * tags (declaration forms first, moves last, equal ops by `ord`), so the forms are put
 * through it as tags of a stand-in function, with `ord` following the list order.
 */
function applyMany(items: Array<{ id: string; text: string; forms: string[] }>) {
  return items.map(({ id, text, forms }) => {
    const tu = parse(text);
    const perOp = new Map<string, number>();
    const ord: Record<string, number> = {};
    const tags = forms.map(f => {
      const op = parseVc8Form(f)?.op ?? '?';
      const n = (perOp.get(op) ?? 0) + 1; perOp.set(op, n);
      ord[f] = n;
      return { type: 'vc8form', data: `${f};ev=0000000000;bh=1-00000000;dh=${vc8formBodyHash('')};ord=${n}` };
    });
    const spec = vc8FormSpec({ tags, size: 1, decompiled: '' } as never)!;
    const applied: string[] = [], refused: Array<{ form: string; why: string }> = [];
    const prefix: string[] = [];
    const out = applyVc8Forms(tu, spec.forms, s => {
      const f = s.tag!.slice(0, s.tag!.lastIndexOf(';ev='));
      if (s.applied) applied.push(f); else refused.push({ form: f, why: s.why ?? '' });
      for (const d of s.prefix ?? []) if (!prefix.includes(d)) prefix.push(d);
    }, { ...tables(), ...accTables } as never);
    // `ord` only where two forms share an op.
    for (const f of forms) if ((perOp.get(parseVc8Form(f)?.op ?? '?') ?? 0) < 2) delete ord[f];
    return { id, text: [...prefix, body(out)].join('\n\n'), applied, refused, ord, order: spec.forms.map(x => x.tag.slice(0, x.tag.lastIndexOf(';ev='))) };
  });
}

async function dh(snap: string, addrsPath: string) {
  const want = new Set<string>(JSON.parse(readFileSync(addrsPath, 'utf8')));
  const out: Record<string, { dh: string; size: number; name: string; tags: string[] }> = {};
  const rl = createInterface({ input: createReadStream(`${snap}/functions.ndjson`) });
  for await (const l of rl) {
    const i = l.indexOf('"address":"');
    if (i < 0) continue;
    const a = l.slice(i + 11, i + 19);
    if (!want.has(a)) continue;
    const r = JSON.parse(l);
    out[a] = { dh: vc8formBodyHash(r.decompiled ?? ''), size: Number(r.size), name: r.name, tags: (r.tags ?? []).filter((t: any) => t.type === 'vc8form').map((t: any) => t.data) };
  }
  return out;
}

async function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  const opt = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  if (mode === 'singles') {
    if (opt('--ops')) onlyOps = new Set(opt('--ops')!.split(','));
    loadTypes(opt('--types'));
    await loadAccessors(opt('--types'));
    await loadGlobals(opt('--globals'));
    writeFileSync(b, JSON.stringify(singles(JSON.parse(readFileSync(a, 'utf8')), Number(opt('--max-anchors') ?? 16))));
  } else if (mode === 'apply') {
    await loadGlobals(opt('--globals'));
    loadTypes(opt('--types'));
    await loadAccessors(opt('--types'));
    writeFileSync(b, JSON.stringify(applyMany(JSON.parse(readFileSync(a, 'utf8')))));
  } else if (mode === 'dh') {
    writeFileSync(c, JSON.stringify(await dh(a, b)));
  } else {
    console.error('usage: candidates.ts singles|apply|dh ...');
    process.exit(2);
  }
}

// Run as a script; imported, it only lends `singles` (a check of which candidates a body offers).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(e => { console.error(e); process.exit(1); });

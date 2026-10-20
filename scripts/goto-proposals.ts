/**
 * Label-name proposals for the gotos that stay (design section 6, step 11).
 *
 *   npx tsx scripts/goto-proposals.ts --tree <emitted tree> --census <goto-census out> \
 *       --snapshot <snapshot dir> --out <dir> [--addresses <tsv>] [--apply-to <snapshot copy dir>]
 *
 * Writes into <dir>:
 *   goto-proposals.tsv  one row per Ghidra-named label with gotos: the block's address, the
 *                       function, the current label, its gotos and census classes, the
 *                       proposed name, its kind and evidence - input for the single Ghidra
 *                       writer, who sets the name as a label at that address
 *   goto-residual.tsv   the labels no rule names, and the addresses Ghidra refuses (a function
 *                       entry, outside every function body, not code): they stay tickets
 *   goto-dropped.tsv    rows for an address another function owns (one row per address)
 *   summary.json        counts by kind and by name
 *
 * `--apply-to` copies the snapshot with every proposal applied to the decompiled text and
 * the label-flow keys - what Ghidra will print once the names are set - so a replay can
 * check them (unique, compile, census gates) before anything is written to Ghidra.
 *
 * `--holds <tsv>` (label_address, reason) are rows a re-read found wrong for a reason no rule
 * sees (a misnamed global, a label mid-way through a call's argument set-up): they stay tickets
 * with that reason until Ghidra is fixed.
 *
 * `--facts <file>` is what Ghidra says about each address, one `addr|symbols|entry/name|ok`
 * line (gcheck/q1.java, read-only): the symbols at the address (`name*@namespace;`), the
 * function containing it (`-` for none), whether an instruction starts there (`NOINS`,
 * `NOMEM`). Without it every row is a ticket: an address no one checked is not proposed.
 *
 * Reads only; never writes Ghidra.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, NodeKind, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import { functionAddress } from '../packages/reconstruct/src/goto-census/census.js';
import { proposeName, uniquify, isGhidraLabel, isEvidence, LIBRARY_CASE_ENUMS, type LabelContext, type LabelProposal } from '../packages/reconstruct/src/goto-census/label-names.js';
import { findLabel, gotoPaths, getAt, fallsThrough, LOOPS, isPrefix, type Path } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/paths.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/types.js';
import { LIBRARY_LABELS } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/library-evidence.js';
import { emit } from '@ghidra-mcp/cpp-parser';

type Any = any;
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const tree = opt('--tree'), census = opt('--census'), snapshot = opt('--snapshot'), outDir = opt('--out'), applyTo = opt('--apply-to'), factsFile = opt('--facts'), holdsFile = opt('--holds');
// Addresses the label-flow field lacks (labels the extraction script does not locate), read
// by hand from the asm: function, label, address, evidence.
const extraAddresses = opt('--addresses');
if (!tree || !census || !snapshot || !outDir) {
  console.error('usage: goto-proposals.ts --tree <dir> --census <dir> --snapshot <dir> --out <dir> [--apply-to <dir>]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const noreturn = new Set(DEFAULT_NORETURN_FUNCTIONS);

// label-flow addresses (user labels) from the snapshot
const flowAddr = new Map<string, string>(); // fn|label -> address
for (const l of readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const d = JSON.parse(l);
  for (const [lab, f] of Object.entries((d.labelFlow ?? {}) as Record<string, { address: string }>)) flowAddr.set(`${d.address}|${lab}`, f.address);
}
if (extraAddresses) {
  for (const r of readFileSync(extraAddresses, 'utf8').trim().split('\n').slice(1)) {
    const [fn, label, address] = r.split('\t');
    flowAddr.set(`${fn}|${label}`, address);
  }
}
// Function entries, from the snapshot.
const entries = new Map<string, string>();
for (const l of readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  const d = JSON.parse(l);
  entries.set(String(d.address).toLowerCase(), d.name);
}
// What Ghidra says about each address (read-only query).
interface Fact { mem: boolean; ins: boolean; syms: { name: string; ns: string; primary: boolean }[]; owner: string | null; ownerName: string | null }
const facts = new Map<string, Fact>();
if (factsFile) {
  for (const l of readFileSync(factsFile, 'utf8').split('\n')) {
    const f = l.trim().split('|');
    if (!/^[0-9a-f]{8}$/.test(f[0] ?? '')) continue;
    if (f[1] === 'NOMEM') { facts.set(f[0], { mem: false, ins: false, syms: [], owner: null, ownerName: null }); continue; }
    const syms = (f[1] ?? '').split(';').filter(Boolean).map(x => { const m = /^(.*?)(\*?)@(.*)$/.exec(x)!; return { name: m[1], primary: m[2] === '*', ns: m[3] }; });
    const [owner, ownerName] = f[2] === '-' ? [null, null] : f[2].split('/');
    facts.set(f[0], { mem: true, ins: f[3] === 'ok', syms, owner: owner?.toLowerCase() ?? null, ownerName: ownerName ?? null });
  }
}
/**
 * The block's address: the label-flow address first; else Ghidra's label spelling
 * (`LAB_<addr>`); a `caseD_<x>` suffix is the case VALUE unless Ghidra confirms an instruction
 * at it inside the function (it spells unreachable-value cases by their address).
 */
function labelAddress(fn: string, label: string): string | null {
  const flow = flowAddr.get(`${fn}|${label}`);
  if (flow) return flow;
  const m = /^(?:LAB_|joined_r0x|code_r0x)([0-9a-f]{8})$/i.exec(label);
  if (m) return m[1].toLowerCase();
  const c = /_caseD_([0-9a-f]+)$/i.exec(label);
  if (c) {
    const a = c[1].toLowerCase().padStart(8, '0');
    const f = facts.get(a);
    if (!factsFile || (f && f.ins && f.owner === fn)) return a;
  }
  return null;
}

const holds = new Map<string, string>();
if (holdsFile) for (const l of readFileSync(holdsFile, 'utf8').trim().split('\n').slice(1)) { const [a, why] = l.split('\t'); if (a) holds.set(a, why); }

// census classes per (fn, label)
const classes = new Map<string, Map<string, number>>();
for (const r of readFileSync(join(census, 'gotos.tsv'), 'utf8').trim().split('\n').slice(1)) {
  const f = r.split('\t');
  const k = `${f[0]}|${f[4]}`;
  const m = classes.get(k) ?? new Map<string, number>();
  m.set(f[6], (m.get(f[6]) ?? 0) + 1);
  classes.set(k, m);
}

function walkFiles(d: string, out: string[]): void {
  for (const e of readdirSync(d)) {
    if (e === '.git') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walkFiles(p, out); else if (p.endsWith('.cpp')) out.push(p);
  }
}

const strip = (e: Any): Any => { while (e && (e.kind === NodeKind.ParenExpr || e.kind === NodeKind.CStyleCastExpr)) e = e.expression; return e; };
function firstIdent(e: Any): string | null {
  e = strip(e);
  if (!e) return null;
  if (e.kind === NodeKind.Identifier) return e.name;
  if (e.kind === NodeKind.AssignExpr) return firstIdent(e.left);
  if (e.kind === NodeKind.BinaryExpr) {
    // a comparison against a literal: the non-literal side
    const lit = (x: Any) => { x = strip(x); return x && (x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.NullptrLiteral); };
    if (lit(e.right)) return firstIdent(e.left);
    if (lit(e.left)) return firstIdent(e.right);
    return firstIdent(e.left) ?? firstIdent(e.right);
  }
  if (e.kind === NodeKind.MemberExpr) return e.member?.name ?? null;
  if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) return firstIdent(e.operand);
  if (e.kind === NodeKind.SubscriptExpr) return firstIdent(e.array);
  return null;
}
/** Every identifier a subtree writes: assigned, incremented, decremented. */
function writtenIn(n: Any, out = new Set<string>()): Set<string> {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { n.forEach(x => writtenIn(x, out)); return out; }
  if (n.kind === NodeKind.AssignExpr) { const r = rootOf(n.left); if (r) out.add(r); }
  if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && (n.operator === '++' || n.operator === '--')) { const r = rootOf(n.operand); if (r) out.add(r); }
  for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') writtenIn(v, out);
  return out;
}
function rootOf(e: Any): string | null {
  e = strip(e);
  while (e) {
    if (e.kind === NodeKind.Identifier) return e.name;
    if (e.kind === NodeKind.MemberExpr) e = strip(e.object);
    else if (e.kind === NodeKind.SubscriptExpr) e = strip(e.array);
    else if (e.kind === NodeKind.UnaryExpr) e = strip(e.operand);
    else return null;
  }
  return null;
}
function identsIn(n: Any, out: string[] = []): string[] {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { n.forEach(x => identsIn(x, out)); return out; }
  if (n.kind === NodeKind.Identifier) out.push(n.name);
  for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') identsIn(v, out);
  return out;
}
const ev = (n: string) => { const m = n.replace(/_0\d*$/, ''); return isEvidence(m) ? m : null; };
/**
 * The variable the loop steps, as the source iterates it: a for's increment, else the first
 * variable of its test that the loop body writes (the cursor, not the key it searches for).
 * None when the loop names nothing - the caller then claims no loop variable.
 */
function loopVar(loop: Any, fnBody?: Any, before?: Any): string | null {
  const written = writtenIn([loop.body, loop.increment]);
  // a variable the function also writes outside this loop (and the statement that initialises
  // it right before) is reused for something else: its name fits only one use
  const outside = new Set<string>();
  if (fnBody) {
    const skip = new Set([loop, before].filter(Boolean));
    const walkOut = (n: Any): void => {
      if (!n || typeof n !== 'object' || skip.has(n)) return;
      if (Array.isArray(n)) { n.forEach(walkOut); return; }
      if (n.kind === NodeKind.AssignExpr) { const r = rootOf(n.left); if (r) outside.add(r); }
      if ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr) && (n.operator === '++' || n.operator === '--')) { const r = rootOf(n.operand); if (r) outside.add(r); }
      for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') walkOut(v);
    };
    walkOut(fnBody);
  }
  const ok = (i: string) => written.has(i) && !outside.has(i) && ev(i);
  if (loop.kind === NodeKind.ForStmt) {
    for (const i of identsIn(loop.increment)) if (ok(i)) return ev(i);
  }
  const c = strip(loop.condition);
  if (!c || c.kind === NodeKind.BoolLiteral || c.kind === NodeKind.IntegerLiteral) return null;
  for (const i of identsIn(c)) if (ok(i)) return ev(i);
  return null;
}

/** loopVar for the loop at `path`, with the statement before it as its initialiser. */
function loopVarAt(body: Any, path: Path): string | null {
  const last = path[path.length - 1];
  const before = last && last.f === 'statements' && last.i! > 0 ? (getAt(body, path.slice(0, -1)) as Any).statements[last.i! - 1] : null;
  return loopVar(getAt(body, path), body, before);
}

/** Loops that enclose `p` (outermost first), as paths to the loop statements. */
function enclosingLoops(body: Any, p: Path): Path[] {
  const out: Path[] = [];
  for (let d = 1; d <= p.length; d++) {
    if (p[d - 1].f !== 'body') continue;
    const n = getAt(body, p.slice(0, d - 1));
    if (LOOPS.has(n.kind)) out.push(p.slice(0, d - 1));
  }
  return out;
}

interface Row { address: string | null; fn: string; fnName: string; file: string; label: string; gotos: number; classes: string; p: LabelProposal }
const rows: Row[] = [];
const files: string[] = [];
walkFiles(tree, files);
files.sort();
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/\bgoto\s/.test(src)) continue;
  let tu: Any;
  try { tu = parse(src, { filename: file, recover: true } as Any); } catch { continue; }
  const fns: FunctionDecl[] = [];
  const visit = (d: Any): void => { if (!d) return; if (d.kind === NodeKind.FunctionDecl && d.body) fns.push(d); if (d.declarations) d.declarations.forEach(visit); };
  tu.declarations.forEach(visit);
  for (const fn of fns) {
    const address = functionAddress(fn);
    if (!address) continue;
    const body = fn.body as Any;
    const counts = new Map<string, number>();
    // `case v: goto L;` - the values that only jump to L, with the switch they belong to
    const caseOnly = new Map<string, { vals: string[]; sw: Any }[]>();
    const switches: Any[] = [];
    const walk = (n: Any): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.kind === NodeKind.GotoStmt) counts.set(n.label.name, (counts.get(n.label.name) ?? 0) + 1);
      if ((n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) && switches.length) {
        const vals: string[] = [];
        let s = n;
        while (s && (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt)) { vals.push(s.kind === NodeKind.DefaultStmt ? 'default' : emit(s.value as never).trim()); s = s.statement; }
        if (s?.kind === NodeKind.GotoStmt) caseOnly.set(s.label.name, [...(caseOnly.get(s.label.name) ?? []), { vals, sw: switches[switches.length - 1] }]);
      }
      if (n.kind === NodeKind.SwitchStmt) switches.push(n);
      for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') walk(v);
      if (n.kind === NodeKind.SwitchStmt) switches.pop();
    };
    walk(body);
    const props: { p: LabelProposal; tail: Any[]; row: Row }[] = [];
    const locals = new Set<string>();
    const findLocals = (n: Any): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(findLocals); return; }
      if (n.kind === NodeKind.VariableDecl && n.name?.name) locals.add(n.name.name);
      for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') findLocals(v);
    };
    findLocals(body);
    for (const [label, g] of counts) {
      const slot = findLabel(body, label);
      if (!slot) continue;
      const list = (getAt(body, slot.list) as Any).statements;
      const tail = [slot.inner, ...list.slice(slot.k + 1, slot.m)];
      const lastT = tail.filter((x: Any) => x.kind !== NodeKind.NullStmt).pop();
      const tailFalls = !lastT || fallsThrough(lastT, noreturn);
      const caseValues: string[] = [];
      for (const w of slot.wrappers as Any[]) if (w.kind === NodeKind.CaseStmt) caseValues.push(emit(w.value as never).trim()); else if (w.kind === NodeKind.DefaultStmt) caseValues.push('default');
      // `case a: case b: L: ..` prints as empty sibling cases before the labelled one
      if (caseValues.length) {
        for (let j = slot.k - 1; j >= 0; j--) {
          let w = list[j]; const vals: string[] = []; let empty = true;
          if (w.kind !== NodeKind.CaseStmt && w.kind !== NodeKind.DefaultStmt) break;
          while (w && (w.kind === NodeKind.CaseStmt || w.kind === NodeKind.DefaultStmt)) { vals.push(w.kind === NodeKind.DefaultStmt ? 'default' : emit(w.value as never).trim()); w = w.statement; }
          if (w && w.kind !== NodeKind.NullStmt) empty = false;
          if (!empty) break;
          caseValues.unshift(...vals);
        }
      }
      // A `case v: goto L;` makes L the body of case v only when L lies inside that switch: a
      // label past the switch (the code after it, the loop's bottom, the function's end) is a
      // join the case skips to, not its body (the step-11 re-read: those names were wrong).
      // A label part-way through another case's body that the case before it falls into is
      // that case's tail, shared - not the body of the case that jumps there (zlib inflate's
      // threaded cases excepted: the library says which case each block is).
      if (!caseValues.length) {
        const labelAt: Path = [...slot.list, { f: 'statements', i: slot.k }];
        const ancestors = new Set<Any>();
        for (let d = 0; d < labelAt.length; d++) ancestors.add(getAt(body, labelAt.slice(0, d)));
        const inCase = list.slice(0, slot.k).some((x: Any) => x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt);
        const fallIn = slot.k > 0 && fallsThrough(list[slot.k - 1], noreturn);
        const sharedTail = inCase && fallIn && !LIBRARY_CASE_ENUMS[address];
        // a block Ghidra laid past the switch is still the body of the case when that case's
        // jump is its only way in: nothing falls into it and every goto is the case's
        const only = caseOnly.get(label) ?? [];
        // (no fall-in: the statement before it ends, or it opens an `if (false)` block that only
        // the jump enters; opening any other block means the block's own test enters it too)
        const parentStmt = slot.list.length ? (getAt(body, slot.list.slice(0, -1)) as Any) : null;
        const deadBlock = slot.k === 0 && parentStmt?.kind === NodeKind.IfStmt && slot.list[slot.list.length - 1].f === 'thenBranch'
          && (() => { const c = strip(parentStmt.condition); return c && ((c.kind === NodeKind.BoolLiteral && c.value === false) || (c.kind === NodeKind.IntegerLiteral && BigInt(c.value) === 0n)); })();
        const onlyEntry = only.length > 0 && only.length === g && (slot.k > 0 ? !fallIn : deadBlock);
        for (const c of only) if ((ancestors.has(c.sw) && !sharedTail) || onlyEntry) caseValues.push(...c.vals);
      }
      const blockAddress = labelAddress(address, label);
      const prevStmt = slot.k > 0 ? list[slot.k - 1] : null;
      const fallsInto = prevStmt ? fallsThrough(prevStmt, noreturn) : slot.list.length === 0;
      const endsFunction = slot.list.length === 0 && slot.m === list.length && tailFalls;
      const ctx: LabelContext = { label, tail, tailFalls, caseValues, noreturn, librarySourceLabel: LIBRARY_LABELS[label]?.sourceLabel ?? null,
        fnBody: body, fnAddress: address, address: blockAddress, fallsInto, endsFunction, locals,
        labelOffset: (getAt(body, [...slot.list, { f: 'statements', i: slot.k }]) as Any).location?.start?.offset };
      // Structural positions.
      const sites = gotoPaths(body, label);
      const at: Path = [...slot.list, { f: 'statements', i: slot.k }];
      const labelLoops = enclosingLoops(body, at);
      // follow of the loop right before the label, every jump from inside it (and a nested loop or switch)
      const prev = slot.k > 0 ? list[slot.k - 1] : null;
      if (prev && LOOPS.has(prev.kind)) {
        const lp: Path = [...slot.list, { f: 'statements', i: slot.k - 1 }];
        if (sites.every(s => isPrefix(lp, s)) && sites.some(s => enclosingLoops(body, s).length > enclosingLoops(body, lp).length + 1 || hasSwitchBetween(body, lp, s))) {
          // The follow of the inner loop that runs on to the end of an enclosing loop's body is
          // that loop's continue point (its increment), not the follow of an outer loop.
          if (labelLoops.length && slot.list[slot.list.length - 1].f === 'body' && slot.m === list.length && tailFalls) ctx.loopNextOf = loopVarAt(body, labelLoops[labelLoops.length - 1]);
          else ctx.loopExitOf = loopVarAt(body, lp);
        }
      }
      // continue point: the label ends a loop body, jumped to from a nested loop
      if (ctx.loopExitOf === undefined && ctx.loopNextOf === undefined && labelLoops.length && slot.list[slot.list.length - 1].f === 'body' && slot.m === list.length && tailFalls) {
        const loop = labelLoops[labelLoops.length - 1];
        if (tail.length === 1 && sites.every(s => isPrefix(loop, s)) && sites.some(s => enclosingLoops(body, s).length > labelLoops.length)) ctx.loopNextOf = loopVarAt(body, loop);
      }
      // inside a loop, entered from outside it
      if (ctx.loopExitOf === undefined && ctx.loopNextOf === undefined && labelLoops.length) {
        const outside = labelLoops.filter(lp2 => sites.some(s => !isPrefix(lp2, s)));
        // no variable, no claim: resume_loop names nothing (the descriptive rule does)
        if (outside.length) { const v = loopVarAt(body, outside[outside.length - 1]); if (v) ctx.resumeOf = v; }
      }
      let p = proposeName(ctx);
      if (blockAddress && holds.has(blockAddress)) p = { label, name: label, kind: 'residual', evidence: `held after re-read (proposed ${p.name}): ${holds.get(blockAddress)}` };
      const k = `${address}|${label}`;
      const cls = [...(classes.get(k) ?? new Map()).entries()].map(([c, n]) => `${c}:${n}`).join(' ');
      const row: Row = { address: blockAddress, fn: address, fnName: (fn.name as Any).name?.name ?? (fn.name as Any).name, file: relative(tree, file), label, gotos: g, classes: cls, p };
      props.push({ p, tail, row });
    }
    uniquify(props, locals);
    for (const x of props) {
      if (x.p.kind !== 'residual' && x.p.kind !== 'user' && !/^[A-Za-z_]\w*$/.test(x.p.name)) {
        x.p.evidence = `not an identifier: '${x.p.name}'`; x.p.name = x.row.label; x.p.kind = 'residual';
      }
    }
    for (const x of props) if (isGhidraLabel(x.row.label) || x.p.kind !== 'user') rows.push(x.row);
  }
}

function hasSwitchBetween(body: Any, from: Path, to: Path): boolean {
  for (let d = from.length + 1; d < to.length; d++) {
    if (to[d].f !== 'body') continue;
    if (getAt(body, to.slice(0, d)).kind === NodeKind.SwitchStmt) return true;
  }
  return false;
}

// ---- addresses: what Ghidra says about each (one row per address, no entries, inside the body)
const residualKinds = (r: Row, why: string) => { r.p = { label: r.label, name: r.label, kind: 'residual', evidence: why }; };
const dropped: Row[] = [];
const isDefaultSym = (n: string) => isGhidraLabel(n) || /^(FUN_|DAT_|SUB_|thunk_|EXT_)/.test(n) || /^(switchD|caseD_\w+|default)$/.test(n);
for (const r of rows) {
  if (r.p.kind === 'residual') continue;
  if (!r.address) { residualKinds(r, `no address: the label-flow extraction does not locate ${r.label} (a case label is its value, not its address); read it from the switch table`); continue; }
  if (!factsFile) continue;
  const f = facts.get(r.address);
  if (!f) { residualKinds(r, `address ${r.address} not checked against Ghidra`); continue; }
  if (!f.mem || !f.ins) { residualKinds(r, `address ${r.address} is ${f.mem ? 'not an instruction start' : 'not in memory'} in Ghidra`); continue; }
  const entry = entries.get(r.address);
  if (entry || f.owner === r.address) { residualKinds(r, `${r.address} is the entry of ${entry ?? f.ownerName}: the goto is an inlined callee in the decompile, a structuring ticket, never a label on a function entry`); continue; }
  if (!f.owner) { residualKinds(r, `Ghidra body fix: ${r.address} lies outside every function body (getFunctionContaining is null); fix ${r.fnName}'s body before labelling`); continue; }
  if (f.owner !== r.fn) { r.p.evidence = `${r.address} lies in ${f.ownerName} (${f.owner}); this function jumps into it`; dropped.push(r); continue; }
  const user = f.syms.filter(x => !isDefaultSym(x.name));
  if (user.length) {
    const ex = user.map(x => `${x.name}@${x.ns}`).join(', ');
    if (r.p.kind === 'library') r.p.evidence += `; replaces the existing label ${ex}`;
    else if (r.p.kind !== 'user') r.p = { label: r.label, name: user[0].name, kind: 'user', evidence: `existing Ghidra label ${ex} at the address, kept` };
  }
}
// one row per address: the owner's row; a second row of the owner for one address is a ticket
const seen = new Map<string, Row>();
for (const r of rows) {
  if (!r.address || dropped.includes(r) || r.p.kind === 'residual') continue;
  const o = seen.get(r.address);
  if (o) { r.p.evidence = `${r.address} already proposed as ${o.p.name} (${o.label}); one address takes one label`; dropped.push(r); }
  else seen.set(r.address, r);
}
for (const r of dropped) { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); }
writeFileSync(join(outDir, 'goto-dropped.tsv'), ['label_address\tfunction_address\tfunction\tcurrent_label\tproposed_name\twhy', ...dropped.map(r => [r.address, r.fn, r.fnName, r.label, r.p.name, r.p.evidence].join('\t'))].join('\n') + '\n');

rows.sort((a, b) => (a.fn + a.label).localeCompare(b.fn + b.label));
const hdr = 'label_address\tfunction_address\tfunction\tcurrent_label\tgotos\tcensus_classes\tproposed_name\tkind\tevidence';
const line = (r: Row) => [r.address ?? '?', r.fn, r.fnName, r.label, r.gotos, r.classes, r.p.name, r.p.kind, r.p.evidence].join('\t');
// The descriptive rule's names are candidates, not proposals: two independent re-reads of
// stratified samples measured them at ~45% weak and ~10% wrong (a first statement is rarely
// what the block is for, and the variables they quote are often misnamed). They stay tickets,
// listed with their candidate for an owner-reviewed per-site note.
const candidates = rows.filter(r => r.p.kind === 'descriptive');
writeFileSync(join(outDir, 'goto-descriptive-candidates.tsv'), [hdr, ...candidates.map(line)].join('\n') + '\n');
for (const r of candidates) r.p = { label: r.label, name: r.label, kind: 'residual', evidence: `descriptive candidate ${r.p.name} (${r.p.evidence.replace(/^the block /, '')}) - not proposed: the descriptive rule does not meet the precision bar` };
const named = rows.filter(r => r.p.kind !== 'residual');
writeFileSync(join(outDir, 'goto-proposals.tsv'), [hdr, ...named.map(line)].join('\n') + '\n');
writeFileSync(join(outDir, 'goto-residual.tsv'), [hdr, ...rows.filter(r => r.p.kind === 'residual').map(line)].join('\n') + '\n');
const byKind: Record<string, number> = {}, byName: Record<string, number> = {}, gotosByKind: Record<string, number> = {};
for (const r of rows) {
  byKind[r.p.kind] = (byKind[r.p.kind] ?? 0) + 1;
  gotosByKind[r.p.kind] = (gotosByKind[r.p.kind] ?? 0) + r.gotos;
  const base = r.p.kind === 'descriptive' ? 'descriptive' : r.p.kind === 'residual' ? 'residual' : r.p.name.replace(/\d+$/, '').replace(/^(case|end|next|resume)_.*/, '$1_*');
  byName[base] = (byName[base] ?? 0) + r.gotos;
}
const numbered = rows.filter(r => /[a-z]\d+$/.test(r.p.name) && /already names/.test(r.p.evidence)).length;
const summary = { descriptiveCandidates: candidates.length, dropped: dropped.length, labels: rows.length, gotos: rows.reduce((a, r) => a + r.gotos, 0), byKind, gotosByKind, byName, numberedForUniqueness: numbered, noAddress: rows.filter(r => !r.address).length };
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (applyTo) {
  // The snapshot as Ghidra will print it once the names are set.
  mkdirSync(applyTo, { recursive: true });
  for (const f of readdirSync(snapshot)) if (f !== 'functions.ndjson') copyFileSync(join(snapshot, f), join(applyTo, f));
  const byFn = new Map<string, Map<string, string>>();
  for (const r of named) {
    if (r.p.name === r.label) continue;
    const m = byFn.get(r.fn) ?? new Map<string, string>(); m.set(r.label, r.p.name); byFn.set(r.fn, m);
  }
  const out: string[] = [];
  for (const l of readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const d = JSON.parse(l);
    const m = byFn.get(String(d.address).toLowerCase());
    if (m && d.decompiled) {
      d.decompiled = d.decompiled.replace(/\b([A-Za-z_]\w*)\b/g, (w: string) => m.get(w) ?? w);
      if (d.labelFlow) d.labelFlow = Object.fromEntries(Object.entries(d.labelFlow).map(([k, v]) => [m.get(k) ?? k, v]));
    }
    out.push(JSON.stringify(d));
  }
  writeFileSync(join(applyTo, 'functions.ndjson'), out.join('\n') + '\n');
  if (!existsSync(join(applyTo, 'manifest.json'))) console.error('no manifest copied');
  console.log(`applied ${named.filter(r => r.p.name !== r.label).length} names to ${byFn.size} functions in ${applyTo}`);
}

/**
 * Link-level check of an emitted tree: no two translation units DEFINE the same entity.
 *
 *   npx tsx scripts/duplicate-definitions.ts <tree> [--out <file.tsv>]
 *
 * Every TU compiles alone, and a header only redeclares, so a strict compile cannot see
 * two definitions of one qualified name and signature in two .cpp files - the linker can
 * ("multiple definition of D2Win::Src::Push(D2ControlMsg*)"). This walks every .cpp by
 * AST, tracks the enclosing namespaces, and keys each external-linkage definition:
 *   - a function definition (a body), by qualified name and parameter types,
 *   - a namespace-scope variable definition (not extern, not a const without extern),
 * leaving out what has internal linkage or may be defined in every unit: `static`,
 * `inline`/`constexpr`, an anonymous namespace, a template. Parameter types are compared
 * after the spellings that name one type at link (uint32_t / DWORD / uint...) are folded.
 * It also lists the namespace-scope `extern` variables that some .cpp names but no unit
 * defines - the other half of a link (`MPQ_d2kfixup.mpq` @007d5620: declared and used as
 * MPQ_d2kfixup_mpq, defined nowhere). Exit code 1 when any key is defined twice or any
 * used extern has no definition.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, emit, NodeKind } from '../packages/cpp-parser/src/index.js';

const argv = process.argv.slice(2);
const root = argv[0];
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;
if (!root) { console.error('usage: duplicate-definitions.ts <tree> [--out file.tsv]'); process.exit(2); }

const SAME_TYPE: Record<string, string> = {
  uint32_t: 'unsigned int', uint: 'unsigned int', DWORD: 'unsigned long', UINT: 'unsigned int', unsigned: 'unsigned int',
  int32_t: 'int', INT: 'int', BOOL: 'int', LONG: 'long', ULONG: 'unsigned long',
  uint16_t: 'unsigned short', ushort: 'unsigned short', WORD: 'unsigned short', int16_t: 'short',
  uint8_t: 'unsigned char', byte: 'unsigned char', BYTE: 'unsigned char', uchar: 'unsigned char', int8_t: 'signed char',
  uint64_t: 'unsigned long long', int64_t: 'long long',
};
const typeKey = (t: unknown): string => {
  let s = '';
  try { s = emit(t as never); } catch { return '?'; }
  return s.replace(/\bstruct\s+|\bunion\s+|\benum\s+/g, '').replace(/^::/, '').replace(/\s+/g, ' ').trim()
    .replace(/[A-Za-z_]\w*/g, w => SAME_TYPE[w] ?? w).replace(/\s*\*\s*/g, '*').replace(/\s*&\s*/g, '&');
};
const nameOf = (n: unknown): string => {
  try { return emit(n as never).replace(/\s+/g, ''); } catch { return '?'; }
};

const files: string[] = [];
const headers: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '.git') walk(p); }
    else if (e.name.endsWith('.cpp')) files.push(p);
    else if (e.name.endsWith('.h')) headers.push(p);
  }
})(root);
/** Qualified extern variable -> where declared. */
const externs = new Map<string, string>();
/** Identifier -> the .cpp files that spell it (a use, for the undefined check). */
const spelledBy = new Map<string, Set<string>>();
/** Name -> the .cpp files that give it a definition of their own (internal linkage). */
const internalDefs = new Map<string, Set<string>>();
const note = (m: Map<string, Set<string>>, k: string, f: string) => { let x = m.get(k); if (!x) m.set(k, (x = new Set())); x.add(f); };

const defs = new Map<string, string[]>();
let unparsed = 0;
type Any = any;
for (const f of [...files, ...headers]) {
  const isHeader = f.endsWith('.h');
  let tu: Any;
  try { tu = parse(fs.readFileSync(f, 'utf8')); } catch { if (!isHeader) unparsed++; continue; }
  const rel = path.relative(root, f);
  if (!isHeader) for (const t of (function* walk(n: Any): Generator<string> {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) yield* walk(x); return; }
    if (n.kind === NodeKind.Identifier && typeof n.name === 'string') yield n.name;
    for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') yield* walk(v);
  })(tu)) note(spelledBy, t, rel);
  const visit = (decls: Any[], ns: string[]): void => {
    for (const d of decls ?? []) {
      if (!d) continue;
      if (d.kind === NodeKind.NamespaceDecl) {
        if (!d.name) continue;                               // anonymous: internal linkage
        visit(d.declarations, [...ns, ...nameOf(d.name).split('::')]);
        continue;
      }
      if (d.kind === NodeKind.LinkageSpecDecl || d.kind === NodeKind.ExternCDecl) {
        visit(d.declarations ?? (d.declaration ? [d.declaration] : []), ns);
        continue;
      }
      if (d.kind === NodeKind.FunctionDecl) {
        if (!d.body || isHeader) continue;
        const spec: string[] = d.specifiers ?? [];
        if (spec.includes('static') || spec.includes('inline') || spec.includes('constexpr')) continue;
        const name = nameOf(d.name).replace(/^::/, '');
        const qualified = name.includes('::') && name.startsWith('::') ? name : [...ns, name].join('::');
        const key = `fn ${qualified}(${(d.parameters ?? []).map((p: Any) => typeKey(p.type)).join(',')}${d.isVariadic ? ',...' : ''})`;
        (defs.get(key) ?? defs.set(key, []).get(key)!).push(`${rel}:${d.location?.start?.line ?? '?'}`);
        continue;
      }
      if (d.kind === NodeKind.VariableDecl || d.kind === NodeKind.DeclStmt) {
        const vars: Any[] = d.kind === NodeKind.DeclStmt ? d.declarations : [d];
        for (const v of vars) {
          if (!v || v.kind !== NodeKind.VariableDecl) continue;
          const storage: string[] = [v.storageClass, ...(v.specifiers ?? [])].filter(Boolean);
          if (storage.includes('extern') && !v.initializer) { externs.set([...ns, v.name?.name ?? '?'].join('::'), `${rel}:${v.location?.start?.line ?? '?'}`); continue; }
          if (storage.includes('static') && !isHeader) note(internalDefs, v.name?.name ?? '?', rel);
          if (storage.includes('extern') || storage.includes('static') || storage.includes('inline') || storage.includes('constexpr')) continue;
          const t = (() => { try { return emit(v.type); } catch { return ''; } })();
          if (/^\s*const\b/.test(t) && !storage.includes('extern')) continue;     // namespace-scope const: internal
          if (isHeader) continue;
          const key = `var ${[...ns, v.name?.name ?? '?'].join('::')}`;
          (defs.get(key) ?? defs.set(key, []).get(key)!).push(`${rel}:${v.location?.start?.line ?? '?'}`);
        }
      }
    }
  };
  visit(tu.declarations, []);
}

const dups = [...defs].filter(([, at]) => at.length > 1);
// Used by a unit that has no definition of its own: such a use links to the extern.
const undefinedUsed = [...externs].filter(([q]) => {
  if (defs.has(`var ${q}`)) return false;
  const leaf = q.split('::').pop()!;
  const own = internalDefs.get(leaf) ?? new Set<string>();
  return [...(spelledBy.get(leaf) ?? [])].some(f => !own.has(f));
});
const lines = [
  ...dups.map(([k, at]) => `${k}\t${at.length}\t${at.join(' ')}`),
  ...undefinedUsed.map(([q, at]) => `undefined var ${q}\t0\tdeclared ${at}`),
];
if (outFile) fs.writeFileSync(outFile, lines.join('\n') + (lines.length ? '\n' : ''));
for (const l of lines.slice(0, 60)) console.log(l);
const fnDefs = [...defs.keys()].filter(k => k.startsWith('fn ')).length;
console.log(`${files.length} TUs (${unparsed} unparsed), ${fnDefs} function and ${defs.size - fnDefs} variable definitions with external linkage, ${dups.length} defined more than once, ${undefinedUsed.length} used extern variable(s) defined nowhere`);
process.exit(dups.length > 0 || undefinedUsed.length > 0 ? 1 : 0);

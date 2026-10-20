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
 *   goto-residual.tsv   the labels no rule names (they stay tickets)
 *   summary.json        counts by kind and by name
 *
 * `--apply-to` copies the snapshot with every proposal applied to the decompiled text and
 * the label-flow keys - what Ghidra will print once the names are set - so a replay can
 * check them (unique, compile, census gates) before anything is written to Ghidra.
 *
 * Reads only; never writes Ghidra.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, NodeKind, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import { functionAddress } from '../packages/reconstruct/src/goto-census/census.js';
import { proposeName, uniquify, isGhidraLabel, type LabelContext, type LabelProposal } from '../packages/reconstruct/src/goto-census/label-names.js';
import { findLabel, gotoPaths, getAt, fallsThrough, LOOPS, isPrefix, type Path } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/paths.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/types.js';
import { LIBRARY_LABELS } from '../packages/cpp-parser/src/transform/plugins/builtins/goto-cleanup/library-evidence.js';
import { emit } from '@ghidra-mcp/cpp-parser';

type Any = any;
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const tree = opt('--tree'), census = opt('--census'), snapshot = opt('--snapshot'), outDir = opt('--out'), applyTo = opt('--apply-to');
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
function labelAddress(fn: string, label: string): string | null {
  const m = /^(?:LAB_|joined_r0x|code_r0x)([0-9a-f]{8})$/i.exec(label);
  if (m) return m[1].toLowerCase();
  const c = /_caseD_([0-9a-f]+)$/i.exec(label);
  if (c && c[1].length >= 5) return c[1].toLowerCase().padStart(8, '0');
  return flowAddr.get(`${fn}|${label}`) ?? null;
}

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
/** The variable a loop runs on: a for's init or increment, else what its test compares. */
function loopVar(loop: Any): string | null {
  if (loop.kind === NodeKind.ForStmt) {
    const i = loop.init?.kind === NodeKind.ExprStmt ? firstIdent(loop.init.expression) : loop.init?.kind === NodeKind.DeclStmt ? loop.init.declarations?.[0]?.name?.name ?? null : null;
    return i ?? (loop.increment ? firstIdent(loop.increment) : null) ?? (loop.condition ? firstIdent(loop.condition) : null);
  }
  const c = strip(loop.condition);
  if (!c || c.kind === NodeKind.BoolLiteral || c.kind === NodeKind.IntegerLiteral) return null;
  return firstIdent(c);
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
    const caseOnly = new Map<string, string[]>();
    const walk = (n: Any): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.kind === NodeKind.GotoStmt) counts.set(n.label.name, (counts.get(n.label.name) ?? 0) + 1);
      if (n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) {
        const vals: string[] = [];
        let s = n;
        while (s && (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt)) { vals.push(s.kind === NodeKind.DefaultStmt ? 'default' : emit(s.value as never).trim()); s = s.statement; }
        if (s?.kind === NodeKind.GotoStmt) caseOnly.set(s.label.name, [...(caseOnly.get(s.label.name) ?? []), ...vals]);
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'location' && k !== 'leadingTrivia' && k !== 'trailingTrivia' && v && typeof v === 'object') walk(v);
    };
    walk(body);
    const props: { p: LabelProposal; tail: Any[]; row: Row }[] = [];
    for (const [label, g] of counts) {
      const slot = findLabel(body, label);
      if (!slot) continue;
      const list = (getAt(body, slot.list) as Any).statements;
      const tail = [slot.inner, ...list.slice(slot.k + 1, slot.m)];
      const lastT = tail.filter((x: Any) => x.kind !== NodeKind.NullStmt).pop();
      const tailFalls = !lastT || fallsThrough(lastT, noreturn);
      const caseValues: string[] = [];
      for (const w of slot.wrappers as Any[]) if (w.kind === NodeKind.CaseStmt) caseValues.push(emit(w.value as never).trim()); else if (w.kind === NodeKind.DefaultStmt) caseValues.push('default');
      caseValues.push(...(caseOnly.get(label) ?? []));
      const ctx: LabelContext = { label, tail, tailFalls, caseValues, noreturn, librarySourceLabel: LIBRARY_LABELS[label]?.sourceLabel ?? null };
      // Structural positions.
      const sites = gotoPaths(body, label);
      const at: Path = [...slot.list, { f: 'statements', i: slot.k }];
      const labelLoops = enclosingLoops(body, at);
      // follow of the loop right before the label, every jump from inside it (and a nested loop or switch)
      const prev = slot.k > 0 ? list[slot.k - 1] : null;
      if (prev && LOOPS.has(prev.kind)) {
        const lp: Path = [...slot.list, { f: 'statements', i: slot.k - 1 }];
        if (sites.every(s => isPrefix(lp, s)) && sites.some(s => enclosingLoops(body, s).length > enclosingLoops(body, lp).length + 1 || hasSwitchBetween(body, lp, s))) {
          ctx.loopExitOf = loopVar(prev);
        }
      }
      // continue point: the label ends a loop body, jumped to from a nested loop
      if (ctx.loopExitOf === undefined && labelLoops.length && slot.list[slot.list.length - 1].f === 'body' && slot.m === list.length && tailFalls) {
        const loop = labelLoops[labelLoops.length - 1];
        if (tail.length === 1 && sites.every(s => isPrefix(loop, s)) && sites.some(s => enclosingLoops(body, s).length > labelLoops.length)) ctx.loopNextOf = loopVar(getAt(body, loop));
      }
      // inside a loop, entered from outside it
      if (ctx.loopExitOf === undefined && ctx.loopNextOf === undefined && labelLoops.length) {
        const outside = labelLoops.filter(lp2 => sites.some(s => !isPrefix(lp2, s)));
        if (outside.length) ctx.resumeOf = loopVar(getAt(body, outside[outside.length - 1]));
      }
      const p = proposeName(ctx);
      const k = `${address}|${label}`;
      const cls = [...(classes.get(k) ?? new Map()).entries()].map(([c, n]) => `${c}:${n}`).join(' ');
      const row: Row = { address: labelAddress(address, label), fn: address, fnName: (fn.name as Any).name?.name ?? (fn.name as Any).name, file: relative(tree, file), label, gotos: g, classes: cls, p };
      props.push({ p, tail, row });
    }
    uniquify(props);
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

rows.sort((a, b) => (a.fn + a.label).localeCompare(b.fn + b.label));
const hdr = 'label_address\tfunction_address\tfunction\tcurrent_label\tgotos\tcensus_classes\tproposed_name\tkind\tevidence';
const line = (r: Row) => [r.address ?? '?', r.fn, r.fnName, r.label, r.gotos, r.classes, r.p.name, r.p.kind, r.p.evidence].join('\t');
const named = rows.filter(r => r.p.kind !== 'residual');
writeFileSync(join(outDir, 'goto-proposals.tsv'), [hdr, ...named.map(line)].join('\n') + '\n');
writeFileSync(join(outDir, 'goto-residual.tsv'), [hdr, ...rows.filter(r => r.p.kind === 'residual').map(line)].join('\n') + '\n');
const byKind: Record<string, number> = {}, byName: Record<string, number> = {}, gotosByKind: Record<string, number> = {};
for (const r of rows) {
  byKind[r.p.kind] = (byKind[r.p.kind] ?? 0) + 1;
  gotosByKind[r.p.kind] = (gotosByKind[r.p.kind] ?? 0) + r.gotos;
  const base = r.p.kind === 'descriptive' ? 'descriptive' : r.p.name.replace(/\d+$/, '').replace(/^(case|end|next|resume)_.*/, '$1_*');
  byName[base] = (byName[base] ?? 0) + r.gotos;
}
const numbered = rows.filter(r => /[a-z]\d+$/.test(r.p.name) && /already names/.test(r.p.evidence)).length;
const summary = { labels: rows.length, gotos: rows.reduce((a, r) => a + r.gotos, 0), byKind, gotosByKind, byName, numberedForUniqueness: numbered, noAddress: rows.filter(r => !r.address).length };
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

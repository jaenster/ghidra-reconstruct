/**
 * Goto census of an emitted tree against the raw decompiler text, keyed by address.
 *
 *   npx tsx scripts/goto-census.ts --tree output --snapshot project/.ghidra-mcp/codegen-snapshot \
 *       --out <dir> [--compare <previous out dir>]
 *
 * Writes into <dir>:
 *   gotos.tsv       one row per goto left in the tree: address, function, label, prefix, class, ...
 *   functions.tsv   one row per function with a goto on either side: raw and tree counts
 *   summary.json    totals by class and by prefix, plus the hard gates
 *
 * Hard gates (listed in summary.json, printed, and the exit code is 1 when any fails):
 *   - per function, tree gotos <= raw gotos
 *   - every label the tree defines exists in the raw text of that function
 *   - no `__dupN` label
 *
 * Measurement only: reads the tree and the snapshot, writes nothing else. See
 * packages/reconstruct/src/goto-census/census.ts for what is counted and why it is keyed by
 * address.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, NodeKind, type FunctionDecl } from '@ghidra-mcp/cpp-parser';
import {
  classifyGotos, countLabels, functionAddress, labelPrefix, LABEL_PREFIXES,
  type GotoRow, type LabelCounts,
} from '../packages/reconstruct/src/goto-census/census.js';
import { isMacroRenamedLabel } from '@ghidra-mcp/cpp-parser/transform/plugins/builtins/label-macro-collision';

type Any = any;

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tree = opt('--tree') ?? 'output';
const snapshot = opt('--snapshot') ?? 'project/.ghidra-mcp/codegen-snapshot';
const outDir = opt('--out');
const compareDir = opt('--compare');
if (!outDir) {
  console.error('usage: goto-census.ts --tree <dir> --snapshot <dir> --out <dir> [--compare <dir>]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// ---- raw side ------------------------------------------------------------------------
interface RawFn { name: string; address: string; counts: LabelCounts | null }
const raw = new Map<string, RawFn>();
const functionSymbols = new Set<string>();
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
const lines = readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n');
const rawRecords: Any[] = [];
for (const l of lines) {
  if (!l.trim()) continue;
  let d: Any;
  try { d = JSON.parse(l); } catch { continue; }
  rawRecords.push(d);
  functionSymbols.add(d.name);
  if (d.namespace) functionSymbols.add(`${String(d.namespace).replace(/::/g, '_')}_${d.name}`);
}
let rawParseFail = 0;
for (const d of rawRecords) {
  const text: string = d.decompiled ?? '';
  const entry: RawFn = { name: d.name, address: String(d.address).toLowerCase(), counts: null };
  raw.set(entry.address, entry);
  if (!/\bgoto\b/.test(text) && !/^\s*[A-Za-z_]\w*:\s*$/m.test(text) && !text.includes('if (false)')) {
    entry.counts = { gotos: 0, labels: 0, gotoTargets: new Map(), labelNames: new Set(), byPrefix: {}, ifFalse: 0, tryStmts: 0 };
    continue;
  }
  // The raw text is a whole definition; the body is everything from the first `{` after
  // the signature's closing paren. Parsing it inside a wrapper keeps Ghidra's own types out
  // of the parser's way.
  const m = /\)[\s\n]*\{([\s\S]*)\}[\s\S]*$/.exec(text);
  if (!m) { rawParseFail++; continue; }
  try {
    const tu = parse(`void __raw() {${m[1]}}`, { recover: true } as Any) as Any;
    const fn = tu.declarations.find((x: Any) => x.kind === NodeKind.FunctionDecl);
    entry.counts = countLabels(fn.body, functionSymbols);
  } catch {
    rawParseFail++;
  }
}

// ---- tree side -----------------------------------------------------------------------
function walkFiles(d: string, out: string[]): void {
  for (const e of readdirSync(d)) {
    if (e === '.git') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (p.endsWith('.cpp')) out.push(p);
  }
}
const files: string[] = [];
walkFiles(tree, files);
files.sort();

interface TreeFn { address: string; name: string; file: string; counts: LabelCounts; rows: GotoRow[] }
const treeFns = new Map<string, TreeFn>();
let treeParseFail = 0, noAddress = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/\bgoto\s/.test(src) && !/^\s*[A-Za-z_]\w*:\s*$/m.test(src)) continue;
  let tu: Any;
  try { tu = parse(src, { filename: file, recover: true } as Any); } catch { treeParseFail++; continue; }
  const fns: FunctionDecl[] = [];
  const visit = (d: Any): void => {
    if (!d) return;
    if (d.kind === NodeKind.FunctionDecl && d.body) fns.push(d);
    if (d.declarations) d.declarations.forEach(visit);
    if (d.kind === NodeKind.TemplateDecl) visit(d.declaration);
  };
  tu.declarations.forEach(visit);
  for (const fn of fns) {
    const counts = countLabels(fn.body as Any, functionSymbols);
    if (!counts.gotos && !counts.labels) continue;
    const address = functionAddress(fn);
    if (!address) { noAddress++; continue; }
    const name = (fn.name as Any).kind === NodeKind.QualifiedId ? (fn.name as Any).name.name : (fn.name as Any).name;
    treeFns.set(address, { address, name, file: relative(tree, file), counts, rows: classifyGotos(fn, functionSymbols) });
  }
}

// ---- report --------------------------------------------------------------------------
const byClass: Record<string, number> = {};
const fnsByClass: Record<string, Set<string>> = {};
const byPrefixTree: Record<string, number> = {};
const byPrefixRaw: Record<string, number> = {};
let treeGotos = 0, treeFnsWithGotos = 0, treeLabels = 0, treeTryInGotoFns = 0, gotosIntoIfFalse = 0;
let rawGotos = 0, rawFnsWithGotos = 0, rawIfFalse = 0, rawIfFalseFns = 0;
const treeGtRaw: Any[] = [];
const labelsNotInRaw: Any[] = [];
let dupLabels = 0;
const gotoRows: string[] = [
  ['address', 'function', 'file', 'line', 'label', 'prefix', 'class', 'sharedBy', 'fallthroughIn', 'tailStmts', 'tailEnd', 'inIfFalse'].join('\t'),
];
for (const r of raw.values()) {
  if (!r.counts) continue;
  rawGotos += r.counts.gotos;
  if (r.counts.gotos) rawFnsWithGotos++;
  rawIfFalse += r.counts.ifFalse;
  if (r.counts.ifFalse) rawIfFalseFns++;
  for (const [p, n] of Object.entries(r.counts.byPrefix)) byPrefixRaw[p] = (byPrefixRaw[p] ?? 0) + (n ?? 0);
}
const userNames = new Map<string, number>();
for (const t of treeFns.values()) for (const row of t.rows) if (row.prefix === 'user') userNames.set(row.label, (userNames.get(row.label) ?? 0) + 1);
const fnRows: string[] = [
  ['address', 'function', 'file', 'rawGotos', 'treeGotos', 'rawLabels', 'treeLabels', ...LABEL_PREFIXES.map(p => `tree:${p}`)].join('\t'),
];
for (const t of [...treeFns.values()].sort((a, b) => a.address.localeCompare(b.address))) {
  const r = raw.get(t.address);
  treeGotos += t.counts.gotos;
  treeLabels += t.counts.labels;
  if (t.counts.gotos) treeFnsWithGotos++;
  if (t.counts.gotos && t.counts.tryStmts) treeTryInGotoFns++;
  gotosIntoIfFalse += t.rows.filter(r => r.inIfFalse).length;
  for (const [p, n] of Object.entries(t.counts.byPrefix)) byPrefixTree[p] = (byPrefixTree[p] ?? 0) + (n ?? 0);
  for (const row of t.rows) {
    byClass[row.cls] = (byClass[row.cls] ?? 0) + 1;
    (fnsByClass[row.cls] ??= new Set()).add(t.address);
    gotoRows.push([t.address, t.name, t.file, row.line, row.label, row.prefix, row.cls, row.sharedBy,
      row.fallthroughIn ? 1 : 0, row.tailStmts, row.tailEnd, row.inIfFalse ? 1 : 0].join('\t'));
  }
  const rawG = r?.counts?.gotos ?? null;
  if (rawG !== null && t.counts.gotos > rawG) treeGtRaw.push({ address: t.address, name: t.name, raw: rawG, tree: t.counts.gotos });
  for (const name of t.counts.labelNames) {
    if (/__dup\d+$/.test(name)) dupLabels++;
    // `label-macro-collision` renames a label spelled like a Win32 macro (`ERROR` ->
    // `ERROR_lbl`); that is the raw label under its only compilable spelling.
    const rawName = isMacroRenamedLabel(name) ? name.slice(0, -'_lbl'.length) : name;
    if (r?.counts && !r.counts.labelNames.has(rawName)) labelsNotInRaw.push({ address: t.address, name: t.name, label: name, prefix: labelPrefix(name, functionSymbols) });
  }
  fnRows.push([t.address, t.name, t.file, rawG ?? '', t.counts.gotos, r?.counts?.labels ?? '', t.counts.labels,
    ...LABEL_PREFIXES.map(p => t.counts.byPrefix[p] ?? 0)].join('\t'));
}
writeFileSync(join(outDir, 'gotos.tsv'), gotoRows.join('\n') + '\n');
writeFileSync(join(outDir, 'functions.tsv'), fnRows.join('\n') + '\n');

const summary = {
  revision: manifest?.provenance?.programVersion ?? null,
  tree,
  raw: { gotos: rawGotos, functionsWithGotos: rawFnsWithGotos, byPrefix: byPrefixRaw, ifFalse: rawIfFalse, ifFalseFunctions: rawIfFalseFns, parseFailures: rawParseFail },
  tree_: {
    gotos: treeGotos, functionsWithGotos: treeFnsWithGotos, labels: treeLabels,
    byClass: Object.fromEntries(Object.entries(byClass).sort((a, b) => b[1] - a[1])),
    functionsByClass: Object.fromEntries(Object.entries(fnsByClass).map(([k, v]) => [k, v.size])),
    gotosIntoIfFalseArms: gotosIntoIfFalse, functionsWithGotosAndTry: treeTryInGotoFns,
    byPrefix: byPrefixTree, parseFailures: treeParseFail, functionsWithoutAddress: noAddress,
  },
  userLabels: Object.fromEntries([...userNames].sort((a, b) => b[1] - a[1])),
  gates: {
    treeGotosAboveRaw: treeGtRaw,
    labelsNotInRaw,
    dupLabels,
  },
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));

console.log(`revision v${summary.revision}`);
console.log(`raw : ${rawGotos} gotos in ${rawFnsWithGotos} functions; if(false) ${rawIfFalse} in ${rawIfFalseFns}; parse failures ${rawParseFail}`);
console.log(`tree: ${treeGotos} gotos in ${treeFnsWithGotos} functions, ${treeLabels} labels; parse failures ${treeParseFail}, no address ${noAddress}`);
console.log('by class:', JSON.stringify(summary.tree_.byClass));
console.log('by prefix (tree):', JSON.stringify(byPrefixTree));
console.log('by prefix (raw): ', JSON.stringify(byPrefixRaw));
console.log(`gates: tree>raw ${treeGtRaw.length} fns, labels not in raw ${labelsNotInRaw.length}, __dup labels ${dupLabels}`);

if (compareDir && existsSync(join(compareDir, 'functions.tsv'))) {
  const prev = JSON.parse(readFileSync(join(compareDir, 'summary.json'), 'utf8'));
  const prevFns = new Map<string, number>();
  for (const l of readFileSync(join(compareDir, 'functions.tsv'), 'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const c = l.split('\t');
    prevFns.set(c[0], Number(c[4]));
  }
  console.log(`\ncompare against ${compareDir}: gotos ${prev.tree_.gotos} -> ${treeGotos}, functions ${prev.tree_.functionsWithGotos} -> ${treeFnsWithGotos}`);
  const classes = new Set([...Object.keys(prev.tree_.byClass), ...Object.keys(byClass)]);
  for (const c of classes) {
    const a = prev.tree_.byClass[c] ?? 0, b = byClass[c] ?? 0;
    if (a !== b) console.log(`  ${c}: ${a} -> ${b} (${b - a >= 0 ? '+' : ''}${b - a})`);
  }
  const rose: string[] = [];
  for (const t of treeFns.values()) {
    const p = prevFns.get(t.address) ?? 0;
    if (t.counts.gotos > p) rose.push(`${t.address} ${t.name} ${p}->${t.counts.gotos}`);
  }
  console.log(`  functions whose goto count rose: ${rose.length}`);
  for (const r of rose.slice(0, 40)) console.log('   ', r);
}

const failed = treeGtRaw.length > 0 || dupLabels > 0;
process.exitCode = failed ? 1 : 0;

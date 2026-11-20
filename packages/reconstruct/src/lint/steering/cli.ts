/**
 * The steering lint's command line, reached as `lint/cli.ts steering ...`.
 *
 *   steering --tree <dir> [--baseline f] [--update-baseline] [--details] [--json f] [--vocabulary f]
 *            [--generated <ref>]   pure generator output whose names count as bound (default source/regen)
 *       every hand-owned body (ratchet pins) plus the tree-wide counters
 *   steering --patch <file> --addr <va> [--tree <dir>] [--base <git-ref>] [--json f]
 *       one diff against one function (a raw diff, or a document with ```diff fences)
 *
 * Exit codes: 0 clean; 1 a steering finding (patch: anything the diff introduces that no
 * `// steer-ok:` exempts; tree: a pin finding the baseline does not hold); 2 usage error or a
 * patch that does not apply; 3 a tree-wide counter above its baseline.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ALL_STEERING_CHECK_IDS } from './checks.js';
import {
  COUNTER_IDS, DEFAULT_GENERATED_REF, DEFAULT_STEERING_BASELINE, OUTSIDE_BODY_CHECK_ID, lintSteeringPatch, lintSteeringTree,
  loadSteeringBaseline, saveSteeringBaseline, treeEnv,
} from './run.js';
import { DEFAULT_VOCABULARY } from './vocabulary.js';

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const CHECK_IDS = [...ALL_STEERING_CHECK_IDS, OUTSIDE_BODY_CHECK_ID];

export function steeringMain(argv: string[]): number {
  const tree = resolve(arg(argv, '--tree') ?? process.cwd());
  const patch = arg(argv, '--patch');
  const vocabulary = resolve(arg(argv, '--vocabulary') ?? DEFAULT_VOCABULARY);
  const jsonOut = arg(argv, '--json');
  if (patch) {
    const addr = arg(argv, '--addr');
    if (!addr) { console.error('steering --patch needs --addr <va>'); return 2; }
    let text: string;
    try { text = readFileSync(patch, 'utf8'); } catch { console.error(`cannot read ${patch}`); return 2; }
    const env = treeEnv(tree, vocabulary, arg(argv, '--generated') ?? DEFAULT_GENERATED_REF);
    const r = lintSteeringPatch(env, text, addr, arg(argv, '--base'));
    if ('error' in r) { console.error(`steering: ${r.error}`); return 2; }
    const all = [...r.structural, ...r.introduced];
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify(r, null, 1));
    const live = all.filter(f => !f.exempt);
    console.log(`patch ${patch} against ${r.address} ${r.fn} (${r.file}): ${live.length} steering finding(s), ${all.length - live.length} exempt`);
    for (const f of all) console.log(`  ${f.exempt ? 'exempt ' : ''}${f.check} line ${f.line}: ${f.detail}${f.exempt ? ` [steer-ok: ${f.exempt}]` : ''}`);
    return live.length ? 1 : 0;
  }

  const baselinePath = resolve(arg(argv, '--baseline') ?? DEFAULT_STEERING_BASELINE);
  const t0 = Date.now();
  const env = treeEnv(tree, vocabulary, arg(argv, '--generated') ?? DEFAULT_GENERATED_REF);
  const r = lintSteeringTree(env);
  const base = loadSteeringBaseline(baselinePath);
  const live = r.pins.filter(p => !p.exempt);
  const fresh = base ? live.filter(p => !(p.key in base.pins)) : live;
  const gone = base ? Object.keys(base.pins).filter(k => !live.some(p => p.key === k)) : [];
  console.log(`tree ${tree}: ${env.paths.length} files, ${r.pinCount} hand-owned bodies (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!base) console.log(`baseline ${baselinePath}: none - every finding is new`);
  console.log('\ncounter                   now  baseline');
  let over = false;
  for (const id of COUNTER_IDS) {
    const b = base?.counters[id];
    const n = r.counters[id].total;
    const mark = b === undefined ? '' : n > b ? `  OVER by ${n - b}` : n < b ? `  fell by ${b - n}: tighten with --update-baseline` : '';
    if (b !== undefined && n > b) over = true;
    console.log(`${id.padEnd(22)} ${String(n).padStart(6)} ${String(b ?? '-').padStart(9)}${mark}`);
  }
  console.log('\npin check                 found  new  exempt');
  for (const id of CHECK_IDS) {
    const all = r.pins.filter(p => p.check === id);
    if (!all.length) continue;
    console.log(`${id.padEnd(24)} ${String(all.filter(p => !p.exempt).length).padStart(6)} ${String(fresh.filter(p => p.check === id).length).padStart(4)} ${String(all.filter(p => p.exempt).length).padStart(7)}`);
  }
  const rows = argv.includes('--details') ? r.pins : fresh;
  if (rows.length) {
    console.log(`\n--- ${argv.includes('--details') ? 'all' : 'new'} pin findings ---`);
    for (const p of rows) console.log(`  ${p.address} ${p.fn} [${p.check}] line ${p.line}: ${p.detail}${p.exempt ? ` [steer-ok: ${p.exempt}]` : ''}`);
  }
  if (gone.length) {
    console.log(`\n--- no longer found (${gone.length}) ---`);
    for (const k of gone) console.log(`  ${k}: ${base!.pins[k]}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ counters: r.counters, pins: r.pins }, null, 1));
  if (argv.includes('--update-baseline')) {
    saveSteeringBaseline(baselinePath, r.counters, r.pins);
    console.log(`\nbaseline updated: ${baselinePath}`);
    return 0;
  }
  if (over) {
    console.log('\na steering counter rose above its baseline; the counts may only fall.');
    return 3;
  }
  if (fresh.length) {
    console.log(`\n${fresh.length} NEW steering finding(s) in hand-owned bodies.`);
    return 1;
  }
  return 0;
}

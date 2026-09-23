/**
 * Defect lint over an emitted tree.
 *
 *   npx tsx packages/reconstruct/src/lint/cli.ts <tree> [options]
 *
 *   --baseline <file>      accepted state (default: <tree>/../../docs/data/defect-lint-baseline.json)
 *   --update-baseline      accept the current findings
 *   --details              print every finding, not only the new ones
 *   --check <id>[,<id>]    run only these checks
 *   --snapshot <dir>       extraction snapshot (default: the project's codegen-snapshot)
 *   --json <file>          write every keyed finding as JSON
 *   --no-layout            skip struct-packing-mismatch (it compiles a TU and takes a while)
 *
 * Exit code: 0 clean, 1 when there are NEW findings (candidates to judge, not a failed run),
 * 2 on a usage error.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALL_CHECKS, goneFindings, keyFindings, loadBaseline, loadSnapshot, loadTree, newFindings,
  runChecks, saveBaseline, toBaseline,
} from './index.js';

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(flag + '='));
  return eq?.slice(flag.length + 1);
}

export function main(argv = process.argv.slice(2)): number {
  const tree = argv.find((a, i) => !a.startsWith('--') && !['--baseline', '--check', '--snapshot', '--json'].includes(argv[i - 1]));
  if (!tree) {
    console.error('usage: cli.ts <tree> [--baseline f] [--update-baseline] [--details] [--check ids] [--json f] [--no-layout]');
    return 2;
  }
  const root = resolve(tree);
  const baselinePath = resolve(arg(argv, '--baseline') ?? resolve(root, '../../docs/data/defect-lint-baseline.json'));
  const only = arg(argv, '--check')?.split(',');
  let checks = ALL_CHECKS.filter(c => !only || only.includes(c.id));
  if (argv.includes('--no-layout')) checks = checks.filter(c => c.id !== 'struct-packing-mismatch');
  if (!checks.length) {
    console.error(`no such check: ${only}\navailable: ${ALL_CHECKS.map(c => c.id).join(', ')}`);
    return 2;
  }

  const t0 = Date.now();
  const t = loadTree(root);
  const snap = loadSnapshot(arg(argv, '--snapshot'));
  const { findings, errors } = runChecks(t, snap, checks);
  const keyed = keyFindings(findings);
  const base = loadBaseline(baselinePath);
  const fresh = newFindings(keyed, base);
  const gone = goneFindings(keyed, base).filter(g => checks.some(c => c.id === g.check));

  const unparsed = t.files.flatMap(f => f.parseErrors.map(e => ({ file: f.path, ...e })));
  console.log(`tree ${root}: ${t.files.length} files, ${t.functions.length} functions, ` +
    `${unparsed.length} unparsed declaration(s)${snap ? '' : ', NO SNAPSHOT'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!base) console.log(`baseline ${baselinePath}: none - every finding is new`);
  console.log('');
  console.log(`${'check'.padEnd(26)} ${'found'.padStart(6)} ${'new'.padStart(5)}  what`);
  for (const c of checks) {
    const err = errors.find(e => e.check === c.id);
    if (err) { console.log(`${c.id.padEnd(26)} ${'ERR'.padStart(6)} ${'-'.padStart(5)}  ${err.error}`); continue; }
    const n = keyed.filter(f => f.check === c.id).length;
    const nn = fresh.filter(f => f.check === c.id).length;
    console.log(`${c.id.padEnd(26)} ${String(n).padStart(6)} ${String(nn).padStart(5)}  ${c.blurb}`);
  }

  const details = argv.includes('--details');
  for (const c of checks) {
    const rows = (details ? keyed : fresh).filter(f => f.check === c.id);
    if (!rows.length) continue;
    console.log(`\n--- ${c.id} (${details ? 'all' : 'new'}) ---`);
    for (const f of rows) {
      const where = f.file ? `${f.file}:${f.line}${f.fn ? ` ${f.fn}` : ''}` : f.subject;
      console.log(`  ${where}: ${f.file ? `${f.subject}: ` : ''}${f.detail}`);
    }
  }
  if (gone.length) {
    console.log(`\n--- no longer found (${gone.length}) ---`);
    for (const g of gone) console.log(`  ${g.check}: ${g.detail}`);
  }
  if (unparsed.length) {
    console.log(`\n--- unparsed declarations (not checked) ---`);
    for (const u of unparsed) console.log(`  ${u.file}:${u.line}: ${u.message}`);
  }

  const jsonOut = arg(argv, '--json');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(keyed, null, 1));

  if (argv.includes('--update-baseline')) {
    const merged = toBaseline(keyed, checks.map(c => c.id));
    // Checks not run this time keep their accepted state.
    if (base) for (const [id, keys] of Object.entries(base.checks)) if (!(id in merged.checks)) merged.checks[id] = keys;
    saveBaseline(baselinePath, merged);
    console.log(`\nbaseline updated: ${baselinePath}`);
    return 0;
  }
  if (fresh.length) {
    console.log(`\n${fresh.length} NEW finding(s). Judge each - these are candidates, not errors.`);
    console.log('Accept the current state with --update-baseline.');
    return 1;
  }
  return 0;
}

const invoked = process.argv[1] ?? '';
if (/lint[\\/]cli\.(ts|js)$/.test(invoked)) process.exit(main());

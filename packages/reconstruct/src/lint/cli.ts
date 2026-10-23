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
 *   --fail-on <id>[,<id>]  run these counted checks and FAIL (exit 3) when one is over its
 *                          allowlist; today only ghidra-artifact
 *   --allowlist <file>     per-rule counts for ghidra-artifact
 *                          (default: ghidra-artifact-allowlist.json beside this file)
 *
 * Counted checks (ghidra-artifact) run only when named by --check or --fail-on, are judged
 * by a per-rule count rather than the baseline, and are never written to the baseline.
 *
 * Zero-tolerance checks (plate-template-comment, include-path-case) run in the default sweep, are never baselined,
 * and fail the run on any finding.
 *
 * Exit code: 0 clean, 1 when there are NEW findings (candidates to judge, not a failed run),
 * 2 on a usage error, 3 when a --fail-on check is over its allowlist or a zero-tolerance
 * check found anything.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_CHECKS, COUNTED_CHECKS, GHIDRA_ARTIFACT_CHECK_ID, ZERO_TOLERANCE_CHECKS, artifactGate, goneFindings, keyFindings,
  loadBaseline, loadSnapshot, loadTree, newFindings, runChecks, saveBaseline, toBaseline,
  type ArtifactAllowlist,
} from './index.js';

export const DEFAULT_ARTIFACT_ALLOWLIST = resolve(
  dirname(fileURLToPath(import.meta.url)), 'ghidra-artifact-allowlist.json');

export function loadArtifactAllowlist(path: string): ArtifactAllowlist {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const out: ArtifactAllowlist = {};
  for (const [k, v] of Object.entries(raw.rules ?? raw)) if (typeof v === 'number') out[k] = v;
  return out;
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find(a => a.startsWith(flag + '='));
  return eq?.slice(flag.length + 1);
}

export function main(argv = process.argv.slice(2)): number {
  const tree = argv.find((a, i) => !a.startsWith('--') &&
    !['--baseline', '--check', '--snapshot', '--json', '--fail-on', '--allowlist'].includes(argv[i - 1]));
  if (!tree) {
    console.error('usage: cli.ts <tree> [--baseline f] [--update-baseline] [--details] [--check ids] [--json f] [--no-layout]');
    return 2;
  }
  const root = resolve(tree);
  const baselinePath = resolve(arg(argv, '--baseline') ?? resolve(root, '../../docs/data/defect-lint-baseline.json'));
  const only = arg(argv, '--check')?.split(',');
  const failOn = arg(argv, '--fail-on')?.split(',').filter(Boolean) ?? [];
  for (const id of failOn) {
    if (!COUNTED_CHECKS.has(id)) {
      console.error(`--fail-on: ${id} is not a counted check (counted: ${[...COUNTED_CHECKS].join(', ')})`);
      return 2;
    }
  }
  let checks = ALL_CHECKS.filter(c => only ? only.includes(c.id) : !COUNTED_CHECKS.has(c.id) || failOn.includes(c.id));
  for (const id of failOn) if (!checks.some(c => c.id === id)) checks.push(ALL_CHECKS.find(c => c.id === id)!);
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
  const unbaselined = (id: string) => COUNTED_CHECKS.has(id) || ZERO_TOLERANCE_CHECKS.has(id);
  const fresh = newFindings(keyed, base).filter(f => !unbaselined(f.check));
  const gone = goneFindings(keyed, base)
    .filter(g => checks.some(c => c.id === g.check) && !unbaselined(g.check));

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
    const nn = unbaselined(c.id) ? '-' : String(fresh.filter(f => f.check === c.id).length);
    console.log(`${c.id.padEnd(26)} ${String(n).padStart(6)} ${nn.padStart(5)}  ${c.blurb}`);
  }

  const details = argv.includes('--details');
  for (const c of checks) {
    const rows = (details || ZERO_TOLERANCE_CHECKS.has(c.id) ? keyed : fresh).filter(f => f.check === c.id);
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

  // The counted gate. Every rule is printed, so a class that reached 0 is visible as one.
  let gateFailed = false;
  if (failOn.includes(GHIDRA_ARTIFACT_CHECK_ID) || checks.some(c => c.id === GHIDRA_ARTIFACT_CHECK_ID)) {
    const allowPath = resolve(arg(argv, '--allowlist') ?? DEFAULT_ARTIFACT_ALLOWLIST);
    const { rows, ok } = artifactGate(keyed, loadArtifactAllowlist(allowPath));
    console.log(`\n--- ${GHIDRA_ARTIFACT_CHECK_ID}: count per rule against ${allowPath} ---`);
    for (const r of rows) {
      const note = r.over ? `  OVER by ${r.count - r.allowed}` : r.slack ? `  tighten the allowlist to ${r.count}` : '';
      console.log(`  ${r.rule.padEnd(20)} ${String(r.count).padStart(6)} / ${String(r.allowed).padStart(6)}${note}`);
    }
    if (!ok && failOn.includes(GHIDRA_ARTIFACT_CHECK_ID)) {
      gateFailed = true;
      console.log(`\n${GHIDRA_ARTIFACT_CHECK_ID}: over the allowlist. Lower the class in the generator or fix it in Ghidra;`);
      console.log('the allowlist only ever shrinks.');
    }
  }

  for (const c of checks) {
    if (!ZERO_TOLERANCE_CHECKS.has(c.id)) continue;
    const n = keyed.filter(f => f.check === c.id).length;
    if (!n) continue;
    gateFailed = true;
    console.log(`\n${c.id}: ${n} finding(s) and the allowance is 0. Fix the generator rule or the Ghidra comment.`);
  }

  if (argv.includes('--update-baseline')) {
    const merged = toBaseline(keyed.filter(f => !unbaselined(f.check)),
      checks.map(c => c.id).filter(id => !unbaselined(id)));
    // Checks not run this time keep their accepted state; counted and zero-tolerance checks are never baselined.
    if (base) for (const [id, keys] of Object.entries(base.checks)) if (!(id in merged.checks)) merged.checks[id] = keys;
    for (const id of [...COUNTED_CHECKS, ...ZERO_TOLERANCE_CHECKS]) delete merged.checks[id];
    saveBaseline(baselinePath, merged);
    console.log(`\nbaseline updated: ${baselinePath}`);
    return gateFailed ? 3 : 0;
  }
  if (gateFailed) return 3;
  if (fresh.length) {
    console.log(`\n${fresh.length} NEW finding(s). Judge each - these are candidates, not errors.`);
    console.log('Accept the current state with --update-baseline.');
    return 1;
  }
  return 0;
}

const invoked = process.argv[1] ?? '';
if (/lint[\\/]cli\.(ts|js)$/.test(invoked)) process.exit(main());

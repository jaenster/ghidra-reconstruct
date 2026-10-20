/**
 * Read the goto passes' event log and report what the translation validator found.
 *
 *   GHIDRA_GOTO_REPORT_DIR=<dir> [GHIDRA_GOTO_REPORT_PAIRS=1] npx tsx run.ts --codegen-only
 *   npx tsx scripts/goto-validator-report.ts <dir> [--skeleton] [--out refusals.tsv]
 *
 * Prints refusals grouped by handler and by reason, with every function address, and writes
 * one TSV row per refusal. With `--skeleton` (needs the PAIRS dump) every candidate, proved
 * and refused, is also run as a region control skeleton with the host g++
 * (packages/cpp-parser/src/testing/skeleton.ts):
 *
 *   proved + skeleton mismatch   a hole in the validator - must be 0
 *   refused + skeleton mismatch  the old handler changed behaviour: a real defect
 *   refused + skeleton agrees    either a value fact the validator does not model (a flag
 *                                variable), a site-unique copy, or a validator gap - triage
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, NodeKind, type Statement } from '@ghidra-mcp/cpp-parser';
import { runSkeletons, type SkeletonPair } from '@ghidra-mcp/cpp-parser/testing/skeleton';
import { DEFAULT_NORETURN_FUNCTIONS } from '@ghidra-mcp/cpp-parser/transform/plugins/builtins/goto-cleanup/types';

type Any = any;
const argv = process.argv.slice(2);
const dir = argv[0];
const doSkeleton = argv.includes('--skeleton');
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!dir) { console.error('usage: goto-validator-report.ts <events dir> [--skeleton] [--out file.tsv]'); process.exit(2); }

const events: Any[] = [];
for (const f of readdirSync(dir)) {
  if (!f.startsWith('events-') || !f.endsWith('.ndjson')) continue;
  for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) if (l.trim()) events.push(JSON.parse(l));
}
const refused = events.filter(e => e.event === 'cf-refused');
const proved = events.filter(e => e.event === 'cf-proved');

/** Reason with the statement text cut off: the part that says WHAT disagreed. */
function reasonClass(r: string): string {
  if (/^(before|after): /.test(r)) return r.replace(/ [A-Za-z_]\w*$/, ' <name>');
  if (/^entry /.test(r)) return r.replace(/(label|case):\S+/, '$1:<x>');
  if (/^scope:/.test(r)) return 'scope';
  if (/^dispatch/.test(r)) return 'dispatch: ' + r.replace(/^dispatch .*?: /, '');
  const m = /^(\S+)(?: .*?)?  became  (\S+)/.exec(r);
  if (m) return `${m[1]} became ${m[2]}`;
  return r;
}

const byHandler = new Map<string, Map<string, Set<string>>>();
for (const e of refused) {
  const h = byHandler.get(e.handler) ?? new Map();
  const k = reasonClass(e.reason);
  const s = h.get(k) ?? new Set();
  s.add(e.fn ?? '?');
  h.set(k, s);
  byHandler.set(e.handler, h);
}
console.log(`events: ${proved.length} proved (with pairs), ${refused.length} refused, in ${new Set(refused.map(e => e.fn)).size} functions`);
for (const [h, m] of [...byHandler].sort((a, b) => [...b[1].values()].reduce((n, s) => n + s.size, 0) - [...a[1].values()].reduce((n, s) => n + s.size, 0))) {
  const n = refused.filter(e => e.handler === h).length;
  console.log(`\n${h}: ${n} refusals`);
  for (const [k, fns] of [...m].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${k}  [${fns.size} fns] ${[...fns].slice(0, 12).join(' ')}${fns.size > 12 ? ' ...' : ''}`);
  }
}

function region(text: string): Statement[] | null {
  try {
    const tu = parse(`void __region() ${text}`, { recover: true } as Any) as Any;
    const fn = tu.declarations.find((d: Any) => d.kind === NodeKind.FunctionDecl);
    return fn?.body?.statements ?? null;
  } catch { return null; }
}

const skeletonVerdict = new Map<Any, string>();
if (doSkeleton) {
  const all = [...proved, ...refused].filter(e => typeof e.before === 'string' && typeof e.after === 'string');
  const noreturn = new Set(DEFAULT_NORETURN_FUNCTIONS);
  const BATCH = 150;
  let unparsable = 0, broken = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    const pairs: SkeletonPair[] = [];
    const owners: Any[] = [];
    for (const e of chunk) {
      const b = region(e.before), a = region(e.after);
      if (!b || !a) { unparsable++; skeletonVerdict.set(e, 'unparsable'); continue; }
      pairs.push({ name: `${e.fn}:${e.handler}`, before: b, after: a, region: { entries: e.entries ?? [], followIsExit: !!e.followIsExit } });
      owners.push(e);
    }
    const run = (ps: SkeletonPair[], os: Any[]): void => {
      try {
        const res = runSkeletons(ps, { noreturn });
        // A batch killed at its time limit leaves its unreported pairs unproven; they are
        // retried alone (a single slow pair cannot hold the rest hostage) and, if one alone
        // still times out, reported as `timeout` - never as `same`.
        const slow: number[] = [];
        res.forEach((r, j) => { if (r.timedOut) slow.push(j); else skeletonVerdict.set(os[j], r.ok ? 'same' : 'differs'); });
        if (slow.length === 1 && ps.length === 1) { skeletonVerdict.set(os[0], 'timeout'); return; }
        for (const j of slow) run([ps[j]], [os[j]]);
      } catch (err) {
        // One pair the compiler rejects would sink the batch: bisect down to it.
        if (ps.length === 1) { broken++; skeletonVerdict.set(os[0], 'no-compile'); return; }
        const h = ps.length >> 1;
        run(ps.slice(0, h), os.slice(0, h));
        run(ps.slice(h), os.slice(h));
      }
    };
    run(pairs, owners);
    process.stderr.write(`\rskeleton ${Math.min(i + BATCH, all.length)}/${all.length}`);
  }
  process.stderr.write('\n');
  const tally = (es: Any[]) => {
    const t: Record<string, number> = {};
    for (const e of es) { const v = skeletonVerdict.get(e) ?? 'no-pair'; t[v] = (t[v] ?? 0) + 1; }
    return t;
  };
  console.log(`\nskeleton: proved ${JSON.stringify(tally(proved))}; refused ${JSON.stringify(tally(refused))}; unparsable ${unparsable}, no-compile ${broken}`);
  const unproven = proved.filter(e => skeletonVerdict.get(e) === 'timeout');
  console.log(`  proved but the skeleton timed out (unchecked, not agreement): ${unproven.length}`);
  for (const e of unproven) console.log(`    TIMEOUT ${e.fn} ${e.handler}`);
  const holes = proved.filter(e => skeletonVerdict.get(e) === 'differs');
  for (const e of holes) console.log(`  VALIDATOR HOLE ${e.fn} ${e.handler}`);
  const defects = refused.filter(e => skeletonVerdict.get(e) === 'differs');
  console.log(`  refused AND behaviour differs (old-handler defects): ${defects.length}`);
  for (const e of defects) console.log(`    ${e.fn} ${e.handler}: ${e.reason.slice(0, 160)}`);
}

if (outFile) {
  const rows = ['fn\thandler\treasonClass\tskeleton\treason'];
  for (const e of refused) rows.push([e.fn, e.handler, reasonClass(e.reason), skeletonVerdict.get(e) ?? '', e.reason.replace(/\s+/g, ' ').slice(0, 400)].join('\t'));
  writeFileSync(outFile, rows.join('\n') + '\n');
}

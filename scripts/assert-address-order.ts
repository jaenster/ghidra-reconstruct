/**
 * Does MSVC lay a function's blocks out in source order? The assert oracle answers it.
 *
 *   npx tsx scripts/assert-address-order.ts ~/code/re/diablo2/docs/data/win-assert-oracle.tsv
 *
 * Every 1.14d halt site pushes its own `__LINE__` (`line_1_14d`) at its own address
 * (`addr_1_14d`). Within one function, sort the sites by address and look at each adjacent
 * pair: in source order the line rises. A pair whose two sites come from different source
 * files is an inlined callee - its lines are another file's - so it is reported apart and
 * proves nothing either way.
 *
 * This is the evidence section 3.3 of goto-structuring-design.md rests on: a rule that reads
 * "the block that keeps the address-labelled position is the original" is only as good as
 * this check.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: assert-address-order.ts <win-assert-oracle.tsv>'); process.exit(2); }
const [head, ...rows] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const col = (n: string) => head.indexOf(n);
const cA = col('addr_1_14d'), cF = col('function_addr'), cL = col('line_1_14d'), cS = col('recovered_source_file'), cN = col('function');

interface Site { addr: number; line: number; src: string; fn: string }
const byFn = new Map<string, Site[]>();
for (const r of rows) {
  if (!r[cF] || !r[cL]) continue;
  const line = Number(r[cL]);
  if (!Number.isFinite(line)) continue;
  const arr = byFn.get(r[cF]) ?? [];
  arr.push({ addr: parseInt(r[cA], 16), line, src: r[cS], fn: r[cN] });
  byFn.set(r[cF], arr);
}
let fns = 0, rise = 0, equal = 0, fall = 0, crossFile = 0;
const falls: string[] = [];
for (const [fa, sites] of byFn) {
  if (sites.length < 2) continue;
  fns++;
  sites.sort((a, b) => a.addr - b.addr);
  for (let i = 1; i < sites.length; i++) {
    const a = sites[i - 1], b = sites[i];
    if (a.src !== b.src) { crossFile++; continue; }
    if (b.line > a.line) rise++;
    else if (b.line === a.line) equal++;
    else { fall++; falls.push(`${fa} ${a.fn}: ${a.addr.toString(16)} line ${a.line} -> ${b.addr.toString(16)} line ${b.line} (${a.src})`); }
  }
}
console.log(`sites ${rows.length}, functions with >=2 sites ${fns}`);
console.log(`same-file adjacent pairs: rise ${rise}, equal ${equal}, fall ${fall}; cross-file (inlined) pairs ${crossFile}`);
for (const f of falls) console.log('  fall:', f);

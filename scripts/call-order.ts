/**
 * Fill a frozen codegen snapshot with the per-line call order the regen now extracts
 * (packages/reconstruct/src/extract/call-order.ts), so a replay of an older snapshot sees
 * the same evidence a fresh extraction would. Read-only on Ghidra; the snapshot is copied.
 *
 *   1. npx tsx scripts/call-order.ts --snapshot <dir> --batches <outdir>
 *        writes <outdir>/batch-NN.java: the extraction script for each batch of functions.
 *   2. run each batch on the program and version the snapshot came from (execute_script,
 *      Java, read-only session) and save its output as <outdir>/batch-NN.out
 *   3. npx tsx scripts/call-order.ts --snapshot <dir> --fill <outdir> --out <new snapshot dir>
 *        copies the snapshot, with `callOrder` set on every function the outputs cover.
 *
 * The facts must come from the same program version as the snapshot's decompile text; the
 * codegen drops a function's facts when the line counts disagree or a line does not print
 * the callee it records, but a version that only moved code would pass that check.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { callOrderBatches, callOrderScript, parseCallOrder } from '../packages/reconstruct/src/extract/call-order.js';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const snapshot = opt('--snapshot');
if (!snapshot) { console.error('usage: call-order.ts --snapshot <dir> (--batches <dir> | --fill <dir> --out <dir>)'); process.exit(2); }
const lines = readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n').filter(Boolean);
const fns = lines.map(l => JSON.parse(l));

const batchesDir = opt('--batches');
if (batchesDir) {
  mkdirSync(batchesDir, { recursive: true });
  const batches = callOrderBatches(fns);
  batches.forEach((b, i) => {
    writeFileSync(join(batchesDir, `batch-${String(i).padStart(2, '0')}.java`), callOrderScript(b));
  });
  console.log(`${batches.length} batches, ${batches.reduce((n, b) => n + b.length, 0)} functions -> ${batchesDir}`);
}

const fillDir = opt('--fill');
const out = opt('--out');
if (fillDir) {
  if (!out) { console.error('--fill needs --out'); process.exit(2); }
  const facts = new Map<string, unknown>();
  for (const f of readdirSync(fillDir).filter(f => f.endsWith('.out')).sort()) {
    for (const [fn, rec] of parseCallOrder(readFileSync(join(fillDir, f), 'utf8'))) facts.set(fn, rec);
  }
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(snapshot)) if (f !== 'functions.ndjson') copyFileSync(join(snapshot, f), join(out, f));
  let filled = 0;
  const outLines = fns.map(fn => {
    const rec = facts.get(String(fn.address).toLowerCase().replace(/^0x/, '').padStart(8, '0'));
    if (rec) { fn.callOrder = rec; filled++; }
    return JSON.stringify(fn);
  });
  writeFileSync(join(out, 'functions.ndjson'), outLines.join('\n') + '\n');
  console.log(`${facts.size} rows, ${filled} functions filled -> ${out}`);
}

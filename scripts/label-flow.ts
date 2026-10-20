/**
 * Fill a frozen codegen snapshot with the per-label flow facts the regen now extracts
 * (packages/reconstruct/src/extract/label-flow.ts), so a replay of an older snapshot sees
 * the same evidence a fresh extraction would. Read-only on Ghidra; the snapshot is copied.
 *
 *   1. npx tsx scripts/label-flow.ts --snapshot <dir> --batches <outdir>
 *        writes <outdir>/batch-NN.java: the extraction script for each batch of labels.
 *   2. run each batch on the program the snapshot came from (execute_script, Java,
 *      read-only session) and save its output as <outdir>/batch-NN.out (compact rows:
 *      the item's index in batch-NN.items, `=` for an address the label's name spells)
 *   3. npx tsx scripts/label-flow.ts --snapshot <dir> --fill <outdir> --out <new snapshot dir>
 *        copies the snapshot, with `labelFlow` set on every function the outputs cover.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelFlowItems, labelFlowScript, parseLabelFlow } from '../packages/reconstruct/src/extract/label-flow.js';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const snapshot = opt('--snapshot');
if (!snapshot) { console.error('usage: label-flow.ts --snapshot <dir> (--batches <dir> | --fill <dir> --out <dir>)'); process.exit(2); }
const lines = readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n').filter(Boolean);
const fns = lines.map(l => JSON.parse(l));

const batchesDir = opt('--batches');
if (batchesDir) {
  mkdirSync(batchesDir, { recursive: true });
  const batches = labelFlowItems(fns);
  // Compact rows (keyed by the item's index) keep a hand-carried output small; the item
  // list is written beside each script so --fill can read them back.
  batches.forEach((b, i) => {
    const n = `batch-${String(i).padStart(2, '0')}`;
    writeFileSync(join(batchesDir, `${n}.java`), labelFlowScript(b, true));
    writeFileSync(join(batchesDir, `${n}.items`), b.join('\n') + '\n');
  });
  console.log(`${batches.length} batches, ${batches.reduce((n, b) => n + b.length, 0)} labels -> ${batchesDir}`);
}

const fillDir = opt('--fill');
const out = opt('--out');
if (fillDir) {
  if (!out) { console.error('--fill needs --out'); process.exit(2); }
  const flow = new Map<string, Record<string, unknown>>();
  let rows = 0, unresolved = 0;
  for (const f of readdirSync(fillDir).filter(f => f.endsWith('.out')).sort()) {
    const text = readFileSync(join(fillDir, f), 'utf8');
    const itemsFile = join(fillDir, f.replace(/\.out$/, '.items'));
    const batch = readFileSync(itemsFile, 'utf8').split('\n').filter(Boolean);
    unresolved += (text.match(/\tnull$/gm) ?? []).length;
    for (const [fn, rec] of parseLabelFlow(text, batch)) {
      flow.set(fn, { ...(flow.get(fn) ?? {}), ...rec });
      rows += Object.keys(rec).length;
    }
  }
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(snapshot)) if (f !== 'functions.ndjson') copyFileSync(join(snapshot, f), join(out, f));
  let filled = 0;
  const outLines = fns.map(fn => {
    const rec = flow.get(String(fn.address).toLowerCase().padStart(8, '0'));
    if (rec) { fn.labelFlow = rec; filled++; }
    return JSON.stringify(fn);
  });
  writeFileSync(join(out, 'functions.ndjson'), outLines.join('\n') + '\n');
  console.log(`${rows} labels in ${filled} functions (${unresolved} unresolved) -> ${out}`);
}

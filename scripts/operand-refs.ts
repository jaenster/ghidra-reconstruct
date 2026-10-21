/**
 * Fill a frozen codegen snapshot with the per-function operand references the regen now
 * extracts (packages/reconstruct/src/extract/operand-refs.ts), so a replay of an older
 * snapshot sees the same evidence a fresh extraction would. Read-only on Ghidra; the
 * snapshot is copied.
 *
 *   1. npx tsx scripts/operand-refs.ts --script <file.java>
 *        writes the extraction script (every function).
 *   2. run it on the program the snapshot came from (execute_script, Java, read-only
 *      session) and save its output.
 *   3. npx tsx scripts/operand-refs.ts --snapshot <dir> --fill <output> --out <new snapshot dir>
 *        copies the snapshot, with `operandRefs` set on every function the output covers.
 *      add --scalars-only to add just the `S` rows (unreferenced address-shaped scalars) to
 *      what the snapshot already holds, and leave its references and derived addresses as
 *      they were: a replay then differs from the snapshot's own by that evidence alone.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { operandRefScript, parseOperandRefs, applyOperandRefs } from '../packages/reconstruct/src/extract/operand-refs.js';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const script = opt('--script');
if (script) {
  writeFileSync(script, operandRefScript());
  console.log(`script -> ${script}`);
}

const snapshot = opt('--snapshot');
const fill = opt('--fill');
const out = opt('--out');
if (snapshot && fill) {
  if (!out) { console.error('--fill needs --out'); process.exit(2); }
  const lines = readFileSync(join(snapshot, 'functions.ndjson'), 'utf8').split('\n').filter(Boolean);
  const fns = lines.map(l => JSON.parse(l));
  const facts = parseOperandRefs(readFileSync(fill, 'utf8'));
  let attached = 0;
  if (argv.includes('--scalars-only')) {
    const key = (a: string) => a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
    for (const f of fns) {
      const scalars = facts.get(key(f.address))?.scalars ?? [];
      if (f.operandRefs) delete f.operandRefs.scalars;
      if (scalars.length === 0) continue;
      f.operandRefs = { refs: [], derived: [], ...(f.operandRefs ?? {}), scalars };
      attached++;
    }
  } else {
    attached = applyOperandRefs(facts, fns);
  }
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(snapshot)) if (f !== 'functions.ndjson') copyFileSync(join(snapshot, f), join(out, f));
  writeFileSync(join(out, 'functions.ndjson'), fns.map(f => JSON.stringify(f)).join('\n') + '\n');
  console.log(`${facts.size} functions in the output, ${attached} attached -> ${out}`);
} else if (!script) {
  console.error('usage: operand-refs.ts --script <file> | --snapshot <dir> --fill <output> --out <dir> [--scalars-only]');
  process.exit(2);
}

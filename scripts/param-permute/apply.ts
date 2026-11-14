/**
 * apply.ts - write a permute.ts result into a tree: each kept order re-ordered in its TU.
 *
 *   tsx apply.ts RESULTS.json TREE [--only A,B,...]
 *
 * For a full-build bench of the kept orders together (the oracle's `quick` on TREE).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFile, encodeFile } from '../vc8form-permute/text.js';
import { reorderFunction } from './reorder.js';

const [results, tree, flag, list] = process.argv.slice(2);
if (!results || !tree) { process.stderr.write('usage: tsx apply.ts RESULTS.json TREE [--only A,B,...]\n'); process.exit(2); }
const only = flag === '--only' ? new Set(list.split(',')) : undefined;
const kept: Array<{ address: string; name: string; tu: string; perm: number[] }> = JSON.parse(readFileSync(results, 'utf8')).kept;
const texts = new Map<string, string>();
let n = 0;
for (const k of kept) {
  if (only && !only.has(k.address)) continue;
  const path = join(tree, k.tu + '.cpp');
  const text = texts.get(path) ?? decodeFile(readFileSync(path));
  const r = reorderFunction(text, k.name.slice(k.name.lastIndexOf('::') + 2), k.perm);
  if (r.errors.length) { process.stderr.write(`${k.address}: ${r.errors.join('; ')}\n`); process.exit(1); }
  texts.set(path, r.text);
  n++;
}
for (const [path, text] of texts) writeFileSync(path, encodeFile(text));
process.stdout.write(`${n} orders in ${texts.size} TUs\n`);

/**
 * Rewrite the `dh` of every vc8form tag to the hash the generator checks now
 * (`vc8formBodyHash`, over the namespace-free token form of the decompile).
 *
 * Input is what the generator itself saw: a codegen run with
 * `GHIDRA_VC8FORM_HASHES=<file>` writes one record per tagged function (address, size,
 * both hashes of its decompile as the vc8form pass reads it, its tags). A tag is
 * rewritten only when it is proven against that decompile:
 *
 *   current  its dh is the whitespace-only hash of the decompile now
 *   moved    its dh is the whitespace-only hash of the decompile in --before (a run on
 *            the model the tag was measured on), and that decompile and today's have one
 *            namespace-free form: only qualifiers and line breaks moved
 *
 * A tag already in the new form is left alone; every other tag is stale and is listed,
 * not touched. The output is a plan (JSON) and a Ghidra script that writes it in one
 * transaction, refuses unless its embedded rows hash to the checksum the plan prints,
 * checks each function's name and that it still holds the old tag, and reads every new
 * tag back.
 *
 *   tsx scripts/vc8form-rehash.ts --now now.jsonl [--before before.jsonl] --out plan.json --java Rehash.java
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Vc8FormHashRecord } from '../packages/reconstruct/src/codegen/vc8form-spec.js';
import { planRehash, rehashJava } from '../packages/reconstruct/src/codegen/vc8form-rehash.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function load(path: string): Map<string, Vc8FormHashRecord> {
  const m = new Map<string, Vc8FormHashRecord>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Vc8FormHashRecord;
    m.set(r.address.toLowerCase().replace(/^0x/, '').padStart(8, '0'), r);
  }
  return m;
}

{
  const nowPath = arg('--now'), out = arg('--out'), java = arg('--java'), beforePath = arg('--before');
  if (!nowPath || !out) { console.error('usage: --now now.jsonl [--before before.jsonl] --out plan.json [--java Rehash.java]'); process.exit(2); }
  const plan = planRehash(load(nowPath), beforePath ? load(beforePath) : undefined);
  writeFileSync(out, JSON.stringify(plan, null, 1) + '\n');
  if (java) writeFileSync(java, rehashJava(plan, arg('--tx') ?? 'vc8form tags: dh over the namespace-free form'));
  const by = (k: string) => plan.rows.filter(r => r.reason === k).length;
  console.log(`rows=${plan.rows.length} (current=${by('current')} moved=${by('moved')}) kept=${plan.kept} stale=${plan.stale.length} checksum=${plan.checksum}`);
  for (const s of plan.stale) console.log(`stale ${s.address} ${s.name}: ${s.tag} (${s.why})`);
}

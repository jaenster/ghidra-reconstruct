/**
 * The plan behind scripts/vc8form-rehash.ts: which vc8form tags get the `dh` the
 * generator checks now, proven against the decompile it saw, and the Ghidra script
 * that writes them (see the script for the rules).
 */
import { createHash } from 'node:crypto';
import { parseVc8FormTag, type Vc8FormHashRecord } from './vc8form-spec.js';

export interface RehashRow { address: string; name: string; old: string; new: string; reason: 'current' | 'moved' }
export interface RehashPlan { rows: RehashRow[]; kept: number; stale: Array<{ address: string; name: string; tag: string; why: string }>; checksum: string }

export function planRehash(now: Map<string, Vc8FormHashRecord>, before?: Map<string, Vc8FormHashRecord>): RehashPlan {
  const rows: RehashRow[] = [];
  const stale: RehashPlan['stale'] = [];
  let kept = 0;
  for (const [address, r] of [...now].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const data of r.tags) {
      const tag = parseVc8FormTag(data);
      if (!tag) { stale.push({ address, name: r.name, tag: data, why: 'not a vc8form record' }); continue; }
      if (tag.size !== r.size) { stale.push({ address, name: r.name, tag: data, why: `size ${r.size}, the tag measured ${tag.size}` }); continue; }
      if (tag.body === r.form) { kept++; continue; }
      let reason: RehashRow['reason'] | undefined;
      if (tag.body === r.legacy) reason = 'current';
      else {
        const b = before?.get(address);
        if (b && b.size === r.size && b.legacy === tag.body && b.form === r.form) reason = 'moved';
      }
      if (!reason) { stale.push({ address, name: r.name, tag: data, why: `decompile ${r.legacy}/${r.form}, the tag measured ${tag.body}` }); continue; }
      // Only the dh value changes; the fields after it (`ord`) stay.
      const at = data.lastIndexOf(';dh=') + 4;
      rows.push({ address, name: r.name, old: 'vc8form:' + data, new: 'vc8form:' + data.slice(0, at) + r.form + data.slice(at + tag.body.length), reason });
    }
  }
  return { rows, kept, stale, checksum: rowsChecksum(rows) };
}

/** The checksum the Ghidra script recomputes over its embedded rows. */
export function rowsChecksum(rows: RehashRow[]): string {
  return createHash('sha256').update(rows.map(r => `${r.address}|${r.name}|${r.old}|${r.new}`).join('\n'), 'utf8').digest('hex');
}

const javaString = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function rehashJava(plan: RehashPlan, txName: string): string {
  const R = plan.rows.map(r => `{${[r.address, r.name, r.old, r.new].map(javaString).join(', ')}}`).join(',\n ');
  return `String[][] R = {
 ${R}};
StringBuilder sb = new StringBuilder();
for (int i = 0; i < R.length; i++) { if (i > 0) sb.append("\\n"); sb.append(R[i][0]).append("|").append(R[i][1]).append("|").append(R[i][2]).append("|").append(R[i][3]); }
byte[] dg = java.security.MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes("UTF-8"));
StringBuilder hx = new StringBuilder(); for (byte b : dg) hx.append(String.format("%02x", b));
if (!hx.toString().equals(${javaString(plan.checksum)})) { println("CHECKSUM MISMATCH " + hx + " - nothing written"); return; }
// Every row is checked before anything is written: the function, its name, the old tag.
int bad = 0;
for (String[] r : R) { var f = getFunctionAt(toAddr(r[0]));
 if (f == null || !f.getName().equals(r[1])) { bad++; println("ERR " + r[0] + " " + (f == null ? "no function" : f.getName())); continue; }
 boolean has = false; for (var t : f.getTags()) if (t.getName().equals(r[2]) || t.getName().equals(r[3])) has = true;
 if (!has) { bad++; println("ERR " + r[0] + " holds neither tag"); } }
if (bad > 0) { println("PRECHECK FAILED " + bad + " - nothing written"); return; }
int tx = currentProgram.startTransaction(${javaString(txName)}); int ok = 0, had = 0, err = 0, deleted = 0;
java.util.Set<String> olds = new java.util.HashSet<>();
try {
 for (String[] r : R) { var f = getFunctionAt(toAddr(r[0]));
  boolean hasNew = false, hasOld = false; for (var t : f.getTags()) { if (t.getName().equals(r[3])) hasNew = true; if (t.getName().equals(r[2])) hasOld = true; }
  if (hasNew && !hasOld) { had++; continue; }
  if (!hasNew) f.addTag(r[3]);
  if (hasOld) { f.removeTag(r[2]); olds.add(r[2]); }
  hasNew = false; hasOld = false; for (var t : f.getTags()) { if (t.getName().equals(r[3])) hasNew = true; if (t.getName().equals(r[2])) hasOld = true; }
  if (hasNew && !hasOld) ok++; else { err++; println("ERR readback " + r[0]); } }
 var tm = currentProgram.getFunctionManager().getFunctionTagManager();
 for (String o : olds) { var t = tm.getFunctionTag(o); if (t != null && tm.getUseCount(t) == 0) { t.delete(); deleted++; } }
} finally { currentProgram.endTransaction(tx, true); }
println("rows=" + R.length + " ok=" + ok + " had=" + had + " err=" + err + " deletedTags=" + deleted);
`;
}


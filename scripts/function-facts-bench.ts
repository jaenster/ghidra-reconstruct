/**
 * Check and time the combined per-function fact extraction on a subset of the program.
 *
 *   npx tsx scripts/function-facts-bench.ts equal [--count 300]
 *       the separate extractors and the combined one over the same functions; every fact of
 *       every function must be identical
 *   npx tsx scripts/function-facts-bench.ts bench [--count 500]
 *       cold, warm, and warm after edits made in this worker's copy of the program (never
 *       saved: the program is open read-only): a prototype change, a struct rename, a field
 *       type change. Prints timings, why entries missed, and checks every warm hit against a
 *       fresh extraction.
 *
 * Runs on the local worker (GHIDRA_LOCAL_WORKER=1 and its environment, see
 * packages/reconstruct/src/local-worker.ts). The cache goes to GHIDRA_FACT_CACHE_DIR.
 */

import { rmSync } from 'node:fs';
import { createConnection } from '../packages/reconstruct/src/connection.js';
import type { ExtractedFunction, GhidraConnection } from '../packages/reconstruct/src/types.js';
import { extractLabelFlow } from '../packages/reconstruct/src/extract/label-flow.js';
import { extractCompareSites } from '../packages/reconstruct/src/extract/compare-sites.js';
import { extractBranchLayout } from '../packages/reconstruct/src/extract/branch-layout.js';
import { extractCallOrder } from '../packages/reconstruct/src/extract/call-order.js';
import { extractHaltLines } from '../packages/reconstruct/src/extract/halt-lines.js';
import { extractFunctionFacts, stableJson, FACT_SCRIPT_VERSION, type FunctionFactStats } from '../packages/reconstruct/src/extract/function-facts.js';
import { FactCache, defaultFactCacheDir } from '../packages/reconstruct/src/extract/fact-cache.js';
import { normalizeEntry } from '../packages/reconstruct/src/extract/function-stamps.js';

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const count = Number(opt('--count', mode === 'equal' ? '300' : '500'));
const KEYS = ['compareSites', 'branchLayout', 'callOrder', 'haltLines', 'labelFlow'] as const;

async function script(c: GhidraConnection, code: string): Promise<string> {
  const r = await c.sendCommand<{ success?: boolean; output?: string; error?: string }>(
    'execute_script', { language: 'java', code, scriptTimeout: 600, _commandTimeout: 660000 });
  if (r.success === false || typeof r.output !== 'string') throw new Error(r.error ?? 'no output');
  return r.output;
}

/** Every non-thunk function with its caller count, by address. */
async function listFunctions(c: GhidraConnection): Promise<Array<{ entry: string; name: string; callers: string[] }>> {
  const out = await script(c, `
StringBuilder sb = new StringBuilder();
ghidra.program.model.listing.FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
while (it.hasNext()) {
  ghidra.program.model.listing.Function f = it.next();
  if (f.isThunk() || f.isExternal()) continue;
  StringBuilder cs = new StringBuilder();
  for (ghidra.program.model.listing.Function g : f.getCallingFunctions(monitor)) cs.append(cs.length() > 0 ? "," : "").append(g.getEntryPoint());
  sb.append(f.getEntryPoint()).append('\\t').append(f.getName(true)).append('\\t').append(cs).append('\\n');
}
println(sb.toString());`);
  return out.split('\n').map(l => l.trim().split('\t')).filter(c => c.length >= 2 && /^[0-9a-f]{8}$/i.test(c[0]))
    .map(c => ({ entry: normalizeEntry(c[0]), name: c[1], callers: c[2] ? c[2].split(',').map(normalizeEntry) : [] }));
}

async function decompile(c: GhidraConnection, entries: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const r = await c.sendCommand<{ results: Array<{ address: string; pseudocode: string }> }>(
      'batch_decompile', { addresses: batch, limit: batch.length, decompileTimeout: 60, _commandTimeout: 600000 });
    for (const x of r.results) out.set(normalizeEntry(x.address), x.pseudocode);
  }
  return out;
}

function toFunctions(bodies: Map<string, string>, names: Map<string, string>): ExtractedFunction[] {
  return [...bodies].map(([entry, decompiled]) => ({
    name: names.get(entry) ?? entry, address: entry, signature: '', returnType: '', parameters: [], localVariables: [],
    callingConvention: '', size: 0, isThunk: false, isExternal: false, hasVarArgs: false, calledFunctions: [], decompiled,
  }) as unknown as ExtractedFunction);
}

function evenly<T>(items: T[], n: number): T[] {
  if (n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t = Date.now(); const r = await f(); return [r, Date.now() - t]; };

function report(label: string, ms: number, s: FunctionFactStats): void {
  console.log(`${label}: ${(ms / 1000).toFixed(1)}s  candidates ${s.candidates}, hits ${s.hits}, extracted ${s.extracted}` +
    `, unstable ${s.unstable}, stamp ${(s.stampMs / 1000).toFixed(1)}s, decompile+facts ${(s.extractMs / 1000).toFixed(1)}s, labels ${(s.labelMs / 1000).toFixed(1)}s` +
    `${Object.keys(s.reasons).length ? `, missed: ${JSON.stringify(s.reasons)}` : ''}` +
    `${s.verified ? `, verified ${s.verified} (${s.verifyMismatches.length} mismatched${s.verifyMismatches.length ? `: ${s.verifyMismatches.slice(0, 8).join(' ')}` : ''})` : ''}`);
}

async function main(): Promise<void> {
  const conn = await createConnection(process.env.GHIDRA_PROJECT_PATH ?? 'ghidra://ghidra.typeguru.nl:13100/Diablo2Lod', undefined,
    process.env.GHIDRA_PROGRAM_PATH ?? '/windows/lod/1.14d/Game.exe');
  const all = await listFunctions(conn);
  const names = new Map(all.map(f => [f.entry, f.name]));
  // A callee with many callers, so a prototype change has somewhere to go.
  const target = [...all].filter(f => f.callers.length >= 15 && f.callers.length <= 40).sort((a, b) => a.entry.localeCompare(b.entry))[0];
  const picked = new Set(evenly(all.map(f => f.entry), count));
  if (mode === 'bench') { picked.add(target.entry); for (const c of target.callers) picked.add(c); }
  const [bodies, decompMs] = await time(() => decompile(conn, [...picked]));
  console.log(`subset: ${picked.size} functions, ${bodies.size} decompiled in ${(decompMs / 1000).toFixed(1)}s; target ${target.name} @${target.entry} (${target.callers.length} callers)`);

  if (mode === 'equal') {
    const a = toFunctions(bodies, names);
    const [, sepMs] = await time(async () => {
      await extractLabelFlow(conn, a);
      await extractCompareSites(conn, a);
      await extractBranchLayout(conn, a);
      await extractCallOrder(conn, a);
      await extractHaltLines(conn, a);
    });
    const b = toFunctions(bodies, names);
    const [stats, combMs] = await time(() => extractFunctionFacts(conn, b, { compareSites: true }));
    report('combined', combMs, stats);
    console.log(`separate scripts: ${(sepMs / 1000).toFixed(1)}s`);
    const counts: Record<string, { same: number; differ: number; present: number }> = {};
    const differs: string[] = [];
    for (let i = 0; i < a.length; i++) {
      for (const k of KEYS) {
        const c = (counts[k] ??= { same: 0, differ: 0, present: 0 });
        const x = stableJson(a[i][k] ?? null), y = stableJson(b[i][k] ?? null);
        if (a[i][k] !== undefined) c.present++;
        if (x === y) c.same++; else { c.differ++; differs.push(`${a[i].address} ${k}`); }
      }
    }
    console.log(JSON.stringify(counts));
    if (differs.length) console.log(`DIFFER: ${differs.slice(0, 30).join(', ')}`);
    console.log(differs.length === 0 ? 'EQUAL' : 'NOT EQUAL');
    process.exit(differs.length === 0 ? 0 : 1);
  }

  if (mode === 'bench') {
    const dir = defaultFactCacheDir();
    const key = 'bench-Game.exe';
    rmSync(`${dir}/${key}.ndjson`, { force: true });
    const run = async (label: string, body: Map<string, string>, verify?: 'all') => {
      const cache = new FactCache(key, FACT_SCRIPT_VERSION, dir);
      const fns = toFunctions(body, names);
      const [s, ms] = await time(() => extractFunctionFacts(conn, fns, { compareSites: true, cache }));
      cache.save();
      report(label, ms, s);
      if (verify) {
        // Every hit of the run above, extracted again and compared.
        const again = new FactCache(key, FACT_SCRIPT_VERSION, dir);
        const [v, vms] = await time(() => extractFunctionFacts(conn, toFunctions(body, names), { compareSites: true, cache: again, verify }));
        again.save();
        report(`  verify (${label})`, vms, v);
      }
      return { cache, fns };
    };
    const cold = await run('cold', bodies);
    await run('warm, no change', bodies, 'all');

    // A prototype change: one more parameter on the target.
    await script(conn, `
int tx = currentProgram.startTransaction("bench prototype change");
ghidra.program.model.listing.Function f = getFunctionAt(toAddr("${target.entry}"));
java.util.List<ghidra.program.model.listing.Variable> ps = new java.util.ArrayList<>();
for (ghidra.program.model.listing.Parameter p : f.getParameters()) ps.add(p);
ps.add(new ghidra.program.model.listing.ParameterImpl("benchExtra", ghidra.program.model.data.IntegerDataType.dataType, currentProgram));
f.updateFunction(f.getCallingConventionName(), f.getReturn(), ps, ghidra.program.model.listing.Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true, ghidra.program.model.symbol.SourceType.USER_DEFINED);
currentProgram.endTransaction(tx, true);
println("ok");`);
    const afterProto = await decompile(conn, [...picked]);
    const changedText = [...afterProto].filter(([e, t]) => bodies.get(e) !== t).length;
    console.log(`prototype change on ${target.name}: ${changedText} decompile texts in the subset changed`);
    await run('warm, one prototype change', afterProto, 'all');

    // The struct the most cached functions name, and its most-named neighbour by value.
    const usage = new Map<string, number>();
    for (const f of cold.fns) {
      const e = cold.cache.get(normalizeEntry(f.address));
      for (const id of Object.keys(e?.deps ?? {})) usage.set(id, (usage.get(id) ?? 0) + 1);
    }
    const ranked = [...usage].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    const picks = await script(conn, `
StringBuilder sb = new StringBuilder();
for (String k : "${ranked.slice(0, 200).join(';')}".split(";")) {
  ghidra.program.model.data.DataType d = currentProgram.getDataTypeManager().getDataType(Long.parseLong(k));
  if (d instanceof ghidra.program.model.data.Structure && ((ghidra.program.model.data.Structure) d).getNumDefinedComponents() > 4) sb.append(k).append('\\t').append(d.getPathName()).append('\\n');
}
println(sb.toString());`);
    const structs = picks.split('\n').map(l => l.trim().split('\t')).filter(c => c.length === 2);
    // Renaming can throw inside Ghidra for some types (a pointer whose cached name is
    // missing). An aborted sub-transaction rolls back the whole script's transaction, so
    // each try is its own script.
    let renamed: string[] = ['none'];
    for (const [k] of structs) {
      const got = (await script(conn, `
ghidra.program.model.data.DataType d = currentProgram.getDataTypeManager().getDataType(${k}L);
int tx = currentProgram.startTransaction("bench rename");
d.setName(d.getName() + "Renamed");
currentProgram.endTransaction(tx, true);
println(d.getPathName());`).catch(() => '')).trim();
      if (got) { renamed = [k, got]; break; }
    }
    const [renameId, renamePath] = renamed;
    const fieldPick = structs.find(c => c[0] !== renameId) ?? structs[0];
    const [fieldId, fieldPath] = fieldPick;
    console.log(`rename: ${renamePath} (#${renameId}, named by ${usage.get(renameId)} cached functions); field type: ${fieldPath} (#${fieldId}, ${usage.get(fieldId)})`);
    console.log(`  cached dependents: rename ${cold.cache.dependents([renameId]).length}, field type ${cold.cache.dependents([fieldId]).length}`);

    const afterRename = await decompile(conn, [...picked]);
    {
      const dep = cold.cache.dependents([renameId])[0];
      const shortOld = renamePath.split('/').pop()!.replace(/Renamed$/, '');
      const now = (await script(conn, `println(currentProgram.getDataTypeManager().getDataType(${renameId}L).getPathName());`)).trim();
      console.log(`  after rename: type reads ${now}; ${dep} text names old ${afterRename.get(dep)?.includes(shortOld + ' ') ?? '?'} / new ${afterRename.get(dep)?.includes(shortOld + 'Renamed') ?? '?'}`);
    }
    console.log(`struct rename: ${[...afterRename].filter(([e, t]) => afterProto.get(e) !== t).length} decompile texts in the subset changed`);
    const r = await run('warm, struct rename', afterRename, 'all');

    // The last defined field of the second struct: undefined4 <-> int keeps the layout but
    // changes the type; a 4-byte field becomes two shorts otherwise.
    const fieldOut = await script(conn, `
int tx = currentProgram.startTransaction("bench field type");
ghidra.program.model.data.Structure s = (ghidra.program.model.data.Structure) currentProgram.getDataTypeManager().getDataType(${fieldId}L);
ghidra.program.model.data.DataTypeComponent pick = null;
for (ghidra.program.model.data.DataTypeComponent c : s.getDefinedComponents()) if (c.getLength() == 4 && !(c.getDataType() instanceof ghidra.program.model.data.Pointer)) pick = c;
String what = "none";
if (pick != null) {
  ghidra.program.model.data.DataType to = pick.getDataType() instanceof ghidra.program.model.data.IntegerDataType
    ? ghidra.program.model.data.UnsignedIntegerDataType.dataType : ghidra.program.model.data.IntegerDataType.dataType;
  s.replace(pick.getOrdinal(), to, 4, pick.getFieldName(), pick.getComment());
  what = pick.getFieldName() + "@" + pick.getOffset() + " " + pick.getDataType().getName() + " -> " + to.getName();
}
currentProgram.endTransaction(tx, true);
println(what);`);
    const afterField = await decompile(conn, [...picked]);
    console.log(`field type change ${fieldOut.trim()}: ${[...afterField].filter(([e, t]) => afterRename.get(e) !== t).length} decompile texts in the subset changed`);
    await run('warm, field type change', afterField, 'all');
    void r;
    process.exit(0);
  }
  console.error('usage: function-facts-bench.ts equal|bench [--count N]');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });

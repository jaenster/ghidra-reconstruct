/**
 * Parallel generation.
 *
 * Generation is 63% of a full regen (616.5s of 979.2s on 2026-09-02, 1131 files)
 * and it was one single-threaded pass. It splits into a GLOBAL SETUP that every
 * process must do in full — the type-ownership pass, the module graph, the
 * funcdef and enum registries, the declaration-closure model — and a PER-UNIT
 * emission loop that is the bulk of the cost. Only the second half parallelises,
 * so the floor is the setup, and this module reports the split rather than
 * promising a speedup it cannot reach.
 *
 * The shape is deliberate:
 *
 *  - workers are started FIRST, so they load and run while the coordinator's own
 *    synchronous stage 1 blocks the main thread's event loop;
 *  - each worker rebuilds every table from the whole snapshot and emits only its
 *    slice of the FILES;
 *  - the cross-file aggregations — the declaration closure, which globals an
 *    output file claimed, how many bodies name each identifier, the funcdef
 *    arity tallies — are merged on the coordinator and computed exactly once,
 *    after every shard has reported.
 *
 * Correctness is not argued, it is diffed: `scripts/verify-parallel-codegen.sh`
 * generates the tree both ways and requires them to be byte-identical.
 */

import { Worker } from 'worker_threads';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFile, appendFile, mkdtemp, rm } from 'fs/promises';
import { readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';

import {
  generateProjectStage1,
  generateProjectStage2,
  mergeShardOutput,
  assertNoShardPlaceholders,
  shardClaimCount,
  type ShardOutput,
} from './codegen/index.js';
import type {
  AnalyzedDataSymbol,
  DetectedClass,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedNamespace,
  ExtractedString,
  ProgramInfo,
  ReconstructOptions,
  ReconstructedProject,
} from './types.js';
import type { CodegenWorkerData } from './codegen-worker.js';

export interface ParallelGenerationOptions {
  /** Total shards, coordinator included. 1 means "generate serially". */
  workers: number;
  /** Snapshot the workers replay. Must be the one this run's inputs came from. */
  snapshotDir: string;
  /** Module each worker imports for process-wide emitter configuration. */
  bootstrap?: string;
  /** The coordinator's parse-error log; per-worker logs are appended to it. */
  parseErrorLogPath?: string;
}

export interface ParallelGenerationInputs {
  projectName: string;
  functions: ExtractedFunction[];
  classes: DetectedClass[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  namespaces: ExtractedNamespace[];
  options: ReconstructOptions;
  programInfo?: ProgramInfo;
  strings?: ExtractedString[];
}

/** Newest mtime anywhere under `dir`, or 0 when it does not exist. */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { newest = Math.max(newest, statSync(p).mtimeMs); } catch { /* raced */ }
    }
  };
  walk(dir);
  return newest;
}

/** Memoised: the walk is the same answer for every shard of a run. */
let cachedEntry: { path: string; stale?: string } | undefined;

/**
 * Where the worker entry lives — always the COMPILED build.
 *
 * Loading nine worker threads through the TypeScript loader serialised them on
 * it: each shard sat idle for a minute or more resolving and transpiling the
 * module graph before doing any work, and the whole run went at a third of the
 * CPU it should have. Workers therefore run plain Node against `dist` with the
 * loader off (`execArgv: []`), which makes the build part of the contract — so
 * a stale `dist` is refused rather than silently generating half the tree from
 * yesterday's emitter.
 */
function workerEntry(): { path: string; stale?: string } {
  if (cachedEntry) return cachedEntry;
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.js')) {
    cachedEntry = { path: join(dirname(here), 'codegen-worker.js') };
    return cachedEntry;
  }

  const srcDir = dirname(here);                    // <pkg>/src
  const pkgDir = dirname(srcDir);                  // <pkg>
  const packagesDir = dirname(pkgDir);             // packages/
  const distEntry = join(pkgDir, 'dist', 'codegen-worker.js');

  const stale: string[] = [];
  for (const pkg of ['reconstruct', 'cpp-parser', 'shared']) {
    const src = join(packagesDir, pkg, 'src');
    const dist = join(packagesDir, pkg, 'dist');
    const srcAt = newestMtime(src);
    if (srcAt === 0) continue;
    const distAt = newestMtime(dist);
    if (distAt < srcAt) stale.push(`${pkg} (${distAt === 0 ? 'no dist' : 'dist older than src'})`);
  }
  cachedEntry = { path: distEntry, stale: stale.length > 0 ? stale.join(', ') : undefined };
  return cachedEntry;
}

function startShard(
  index: number,
  count: number,
  opts: ParallelGenerationOptions,
  projectName: string,
  options: ReconstructOptions,
  parseErrorLogPath: string | undefined
): Promise<ShardOutput> {
  const data: CodegenWorkerData = {
    snapshotDir: opts.snapshotDir,
    options,
    shard: { index, count },
    projectName,
    bootstrap: opts.bootstrap,
    parseErrorLogPath,
  };
  const entry = workerEntry();
  if (entry.stale) {
    return Promise.reject(new Error(
      `parallel generation runs the workers from dist/, and it is behind src/: ${entry.stale}. ` +
      `Run \`npx tsc -b\` and try again — half a tree from a stale emitter is worse than a slow one.`
    ));
  }
  return new Promise<ShardOutput>((resolve, reject) => {
    const worker = new Worker(entry.path, {
      workerData: data,
      // No TypeScript loader: see workerEntry(). Inheriting the parent's
      // execArgv is what serialised the shards on it.
      execArgv: [],
      // ONLY the stack. The decompiled ASTs nest deeply enough that the entry
      // point re-execs itself with --stack-size=8192, and a worker on the 4 MB
      // default overflows on the same bodies — but setting a heap limit here
      // stops V8 sizing the heap from the machine, and a shard holding a ~1 GB
      // model then scavenges continuously: eight shards cost SIX TIMES the CPU
      // of one serial run and finished slower than it.
      resourceLimits: { stackSizeMb: 16 },
    });
    let settled = false;
    worker.on('message', (msg: { ok: boolean; output?: ShardOutput; error?: string }) => {
      settled = true;
      if (msg.ok && msg.output) resolve(msg.output);
      else reject(new Error(`generation shard ${index} failed:\n${msg.error ?? '(no error)'}`));
      void worker.terminate();
    });
    worker.on('error', err => { settled = true; reject(err); });
    worker.on('exit', code => {
      if (!settled) reject(new Error(`generation shard ${index} exited with code ${code} before reporting`));
    });
  });
}

/**
 * Generate the project across `opts.workers` shards and return the same
 * `ReconstructedProject` a serial run returns.
 *
 * `workers <= 1` runs stage 1 and stage 2 back to back with no sharding at all —
 * the same code path a serial run takes, with no worker spawned.
 */
export async function generateProjectParallel(
  inputs: ParallelGenerationInputs,
  opts: ParallelGenerationOptions
): Promise<ReconstructedProject> {
  const count = Math.max(1, Math.floor(opts.workers));

  if (count === 1) {
    const state = generateProjectStage1(
      inputs.projectName, inputs.functions, inputs.classes, inputs.dataTypes,
      inputs.globals, inputs.namespaces, inputs.options, inputs.programInfo, inputs.strings
    );
    return generateProjectStage2(state);
  }

  // Per-shard parse-error logs: the emitter appends to one file, and N threads
  // appending to the coordinator's would interleave lines mid-message.
  const logDir = opts.parseErrorLogPath ? await mkdtemp(join(tmpdir(), 'recon-shard-')) : undefined;
  const shardLogPath = (i: number) => (logDir ? join(logDir, `parse-errors-${i}.log`) : undefined);

  // Started before the coordinator's own stage 1: worker threads run
  // independently of this thread's event loop, so they are already doing their
  // setup while the synchronous call below blocks it.
  const pending: Promise<ShardOutput>[] = [];
  for (let i = 1; i < count; i++) {
    pending.push(startShard(i, count, opts, inputs.projectName, inputs.options, shardLogPath(i)));
  }

  const t0 = Date.now();
  const state = generateProjectStage1(
    inputs.projectName, inputs.functions, inputs.classes, inputs.dataTypes,
    inputs.globals, inputs.namespaces, inputs.options, inputs.programInfo, inputs.strings,
    { index: 0, count }
  );
  const coordinatorMs = Date.now() - t0;
  const coordinatorClaims = shardClaimCount();

  let outputs: ShardOutput[];
  try {
    outputs = await Promise.all(pending);
  } catch (e) {
    if (logDir) await rm(logDir, { recursive: true, force: true });
    throw e;
  }
  const shardsMs = Date.now() - t0;

  for (const out of outputs) mergeShardOutput(state, out);
  assertNoShardPlaceholders(state);

  if (opts.parseErrorLogPath && logDir) {
    for (let i = 1; i < count; i++) {
      const p = shardLogPath(i)!;
      const text = await readFile(p, 'utf8').catch(() => '');
      if (text) await appendFile(opts.parseErrorLogPath, text, 'utf8');
    }
    await rm(logDir, { recursive: true, force: true });
  }

  const shardClaims = outputs.reduce((a, o) => a + o.claimedGlobals.length, coordinatorClaims);
  console.log(
    `Parallel generation: ${count} shards, coordinator's own shard ${(coordinatorMs / 1000).toFixed(1)}s, ` +
    `slowest shard ${(shardsMs / 1000).toFixed(1)}s, ${shardClaims} globals claimed across shards ` +
    `(${coordinatorClaims} by the coordinator)`
  );

  return generateProjectStage2(state);
}

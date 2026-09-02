/**
 * One shard of a parallel generation run.
 *
 * The worker replays the SAME extraction snapshot the coordinator generates
 * from, rebuilds every global table from the FULL model, and then emits only
 * the files its shard owns. Nothing about the model is partitioned — a worker
 * that ingested only its own functions would build a typedef/enum/funcdef
 * registry with holes, and the cast and qualification passes would decline to
 * act where a serial run acts. The tree would still compile. It would just be
 * different, and only a byte-for-byte diff would ever notice.
 *
 * Each worker_thread has its own module instances, so the module-level
 * registries (`setKnownEnumWidths`, `setKnownFuncDefs`, the shape tables) need
 * no locking — only their own initialisation, which stage 1 does.
 */

import { parentPort, workerData } from 'worker_threads';

import { readSnapshot } from './snapshot.js';
import { applyResolvedTypes } from './extract/functions.js';
import { generateProjectStage1, takeShardOutput, shardClaimCount, type ShardSpec } from './codegen/index.js';
import { configureCodegen } from './codegen-defaults.js';
import type { ReconstructOptions } from './types.js';

export interface CodegenWorkerData {
  snapshotDir: string;
  options: ReconstructOptions;
  shard: ShardSpec;
  projectName?: string;
  /**
   * Optional override for the process-wide emitter configuration. Absent means
   * the package's own `configureCodegen`, which is what run.ts applies.
   *
   * A worker runs the COMPILED build with no TypeScript loader, so an override
   * has to be a specifier plain Node can import — a `.js` file or a package
   * name, never a `.ts` path.
   */
  bootstrap?: string;
  /** Per-worker parse-error log; the coordinator concatenates them in shard order. */
  parseErrorLogPath?: string;
}

async function main(): Promise<void> {
  const data = workerData as CodegenWorkerData;

  // A shard re-runs the whole setup, so it re-prints the whole setup banner.
  // One copy of that is information; nine are noise, and they interleave with
  // the coordinator's. Only warnings and errors get through.
  const log = console.log;
  console.log = () => {};
  // Milestones on stderr, which is NOT silenced: without them a shard is a black
  // box and "the shards are slow" cannot be told apart from "the shards spend
  // two minutes loading modules before they start".
  const t0 = Date.now();
  const at = (what: string) => {
    if (process.env.RECON_GEN_TIMING === '1') {
      console.error(`  [shard ${data.shard.index}] ${what} at +${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  };
  try {
    if (data.bootstrap) {
      const mod = await import(data.bootstrap) as { configureCodegen?: (logPath?: string) => void };
      mod.configureCodegen?.(data.parseErrorLogPath);
    } else {
      configureCodegen(data.parseErrorLogPath);
    }

    at('bootstrap done');
    const snapshot = await readSnapshot(data.snapshotDir);
    const functions = snapshot.functions;
    applyResolvedTypes(functions);
    at('snapshot loaded');

    const state = generateProjectStage1(
      data.projectName || snapshot.manifest.projectName,
      functions,
      snapshot.classes,
      snapshot.dataTypes,
      snapshot.globals,
      snapshot.namespaces,
      data.options,
      snapshot.manifest.provenance.programInfo,
      snapshot.strings,
      data.shard
    );

    at('generation done');
    const output = takeShardOutput(state);
    at(`serialised (${output.files.length} files, ${shardClaimCount()} globals claimed)`);
    parentPort!.postMessage({ ok: true, output });
  } catch (e) {
    console.log = log;
    parentPort!.postMessage({
      ok: false,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
}

void main();

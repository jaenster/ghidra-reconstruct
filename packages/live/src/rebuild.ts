/**
 * Rebuilding the tree: write the patched snapshot, then replay it through the
 * codegen-only path in a child process.
 *
 * This is not fast and the code must not pretend otherwise. Generation measures
 * ~559 s (stage1 ~556 s, stage2 ~3 s). What the daemon removes is extraction and
 * the ~79 s analysis, not codegen — so a rebuild is roughly ten minutes today,
 * against roughly twenty for a full regen. The win is that it happens without a
 * human, from the exact Ghidra state the change stream described, and that its
 * output is byte-identical to the batch regen's because it is the same code
 * reading the same snapshot.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveSnapshotModel, type LiveSnapshotModel } from './snapshot-model.js';

export interface RebuildOptions {
  /** Where the tree is written. Normally the regen worktree. */
  outputDir: string;
  /** Holds project.json and the parse-error log. */
  projectDir: string;
  projectName?: string;
  /** Directory for the child's stdout logs. */
  logDir: string;
  log?: (message: string) => void;

  /**
   * Units to actually re-emit. Everything else is copied from `reuseDir`.
   *
   * `null` means re-emit everything, which is what a cold start, a rebuilt
   * generator, or any uncertainty in the dirty-unit selection asks for. An empty
   * array means genuinely nothing changed and every unit is reused.
   */
  emitUnits?: string[] | null;
  /**
   * The previous complete tree. Reused units are read from here, so it must be a
   * tree this same generator build produced - mixing builds mixes behaviours.
   */
  reuseDir?: string;
  /** Per-unit identifier tallies, carried between runs. */
  identCachePath?: string;
}

export interface RebuildResult {
  ok: boolean;
  durationMs: number;
  /** As reported by the child's RESULT line; -1 when it never got that far. */
  filesWritten: number;
  /** Last ~50 lines of the child's stdout, for `status`. */
  stdoutTail: string[];
  logPath: string;
  exitCode: number | null;
  /** Parsed RESULT payload, when the child produced one. */
  stats?: Record<string, number>;
}

/** How much of the child's output `status` keeps. Enough to see the failure. */
const TAIL_LINES = 50;

/**
 * Save the model and regenerate.
 *
 * The snapshot is written FIRST and unconditionally, so the child reads a
 * snapshot that exists on disk rather than anything held in this process. That
 * is what makes the child equivalent to `run.ts --codegen-only`: there is no
 * private channel between the two, only the snapshot.
 */
export async function rebuild(
  model: LiveSnapshotModel,
  options: RebuildOptions,
): Promise<RebuildResult> {
  const log = options.log ?? (() => {});
  const started = Date.now();

  // Reuse engages only when there is a previous tree AND a decided unit set. A
  // null unit set means "everything", and the way to say that to the generator is
  // to not enable reuse at all.
  const reuseUnitsEnabled =
    options.reuseDir !== undefined &&
    options.emitUnits !== null &&
    options.emitUnits !== undefined &&
    existsSync(options.reuseDir);
  (options as RebuildOptions & { reuseUnitsEnabled: boolean }).reuseUnitsEnabled = reuseUnitsEnabled;

  log(reuseUnitsEnabled
    ? `incremental: re-emitting ${options.emitUnits!.length} unit(s), reusing the rest from ${options.reuseDir}`
    : 'full emission: every unit generated');

  await saveSnapshotModel(model);
  log(`snapshot written to ${model.snapshotDir}`);

  await mkdir(options.logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(options.logDir, `rebuild-${stamp}.log`);

  const child = resolveChildEntry();
  const args = ['--stack-size=8192', ...child.nodeArgs, child.entry];

  log(`generating: node ${args.join(' ')} -> ${logPath}`);

  const proc = spawn(process.execPath, args, {
    env: {
      ...process.env,
      RECON_CHILD_PROJECT_DIR: options.projectDir,
      RECON_CHILD_OUTPUT_DIR: options.outputDir,
      RECON_CHILD_SNAPSHOT_DIR: model.snapshotDir,
      RECON_CHILD_PROJECT_NAME: options.projectName ?? 'Reconstructed',
      // Incremental emission. Both must be set for reuse to engage: without a
      // reuse directory the generator has nothing to copy from and re-emits
      // everything, which is the safe default rather than an error.
      ...((options as RebuildOptions & { reuseUnitsEnabled?: boolean }).reuseUnitsEnabled
        ? {
            RECON_REUSE_DIR: options.reuseDir!,
            RECON_EMIT_UNITS: (options.emitUnits ?? []).join(','),
          }
        : {}),
      ...(options.identCachePath ? { RECON_UNIT_IDENT_CACHE: options.identCachePath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logStream = createWriteStream(logPath, { encoding: 'utf8' });
  const tail: string[] = [];
  let carry = '';
  let resultLine: string | null = null;

  const consume = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    logStream.write(text);
    carry += text;
    let nl: number;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      if (line.startsWith('RESULT ')) resultLine = line.slice('RESULT '.length);
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
    }
  };

  proc.stdout.on('data', consume);
  proc.stderr.on('data', consume);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', code => resolve(code));
  });

  if (carry.length > 0) {
    tail.push(carry);
    if (tail.length > TAIL_LINES) tail.shift();
  }
  logStream.end();

  let stats: Record<string, number> | undefined;
  if (resultLine) {
    try { stats = JSON.parse(resultLine) as Record<string, number>; } catch { /* keep the tail */ }
  }

  const durationMs = Date.now() - started;
  const ok = exitCode === 0 && stats !== undefined;
  log(ok
    ? `generation complete in ${(durationMs / 1000).toFixed(1)}s, ${stats?.filesWritten ?? '?'} files`
    : `generation FAILED (exit ${exitCode}) after ${(durationMs / 1000).toFixed(1)}s; see ${logPath}`);

  return {
    ok,
    durationMs,
    filesWritten: stats?.filesWritten ?? -1,
    stdoutTail: tail,
    logPath,
    exitCode,
    stats,
  };
}

/**
 * Where the child entry point lives, and what node needs to run it.
 *
 * Built, it is the sibling `codegen-run.js` and node runs it directly. Under
 * `tsx` — which is how this is developed — `import.meta.url` points into `src`
 * and the `.js` sibling does not exist, so the `.ts` source is run through tsx's
 * loader instead. Guessing wrong here produces MODULE_NOT_FOUND from a child
 * whose stderr nobody reads until the rebuild has already been reported failed.
 */
function resolveChildEntry(): { entry: string; nodeArgs: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, 'codegen-run.js');
  if (existsSync(compiled)) return { entry: compiled, nodeArgs: [] };

  const source = join(here, 'codegen-run.ts');
  if (existsSync(source)) return { entry: source, nodeArgs: ['--import', 'tsx'] };

  throw new Error(`No codegen-run entry point beside ${here}; build the live package first.`);
}

/**
 * The live loop.
 *
 * Ghidra changes -> the daemon's journal -> a coalesced batch -> the affected
 * records re-extracted into the snapshot model -> the snapshot rewritten ->
 * generation replayed in a child -> the tree synced, committed on the regen
 * branch, and merged into the modified worktree.
 *
 * The value is not speed. A rebuild is roughly ten minutes: generation alone is
 * ~559 s and only extraction (~20 min) and analysis (~79 s) are removed. The
 * value is that the tree follows Ghidra without a human driving `run-regen.sh`,
 * and that its output is byte-identical to that script's because it replays the
 * same snapshot through the same codegen.
 *
 * The one failure this loop must never commit is a tree built from a model that
 * has silently fallen behind Ghidra. It compiles, it looks current, and the
 * whole debugging session it costs happens somewhere else entirely. So the
 * loop STOPS on any evidence of a gap and waits for an operator.
 */

import { readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { readFile, readdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createConnection,
  closeConnection,
  type GhidraConnection,
  type ReconstructionOptions,
} from '@ghidra-mcp/reconstruct';
import { decompileFunction } from '@ghidra-mcp/reconstruct/extract/functions';

import { applyEvents, type ChangeEvent as ModelChangeEvent, type ModelIndices } from './model.js';
import {
  loadSnapshotModel,
  loadLiveState,
  saveLiveState,
  indexSnapshotModel,
  countModel,
  type LiveSnapshotModel,
} from './snapshot-model.js';
import { ChangeStream, type ChangeEvent } from './events.js';
import { rebuild, type RebuildResult } from './rebuild.js';
import { commitRegen, mergeIntoModified, assertNotBranch, currentBranch, type MergeResult } from './git.js';
import { WorkQueue } from './queue.js';
import { verifyResume } from './events.js';
import { buildFingerprint, checkBuild } from './build-fingerprint.js';
import {
  selectDirtyUnits,
  computeHashCache,
  loadBuildInfo,
  type SymbolHashCache,
} from './dirty-units.js';
import { NEVER_TOUCH, isNeverTouch } from './paths.js';

const run = promisify(execFile);

interface Config {
  regenDir: string;
  modifiedDir: string;
  daemonUrl: string;
  token?: string;
  sessionId?: string;
  projectDir: string;
  projectPath: string;
  programPath: string;
  projectName: string;
  snapshotDir: string;
  seedSnapshotDir: string;
  /** Workspace root, used to fingerprint the generator's compiled output. */
  repoRoot: string;
  /** Generation writes here first; the tree is then synced into `regenDir`. */
  stagingDir: string;
  logDir: string;
  httpPort: number;
}

/**
 * An environment variable that has no sensible default, with an error that says
 * what to set rather than failing later on an empty path.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The live daemon has no default for it: it is a deployment ` +
      `fact, not something this package can guess. See recon/runs/start-live.sh.`,
    );
  }
  return value;
}

function loadConfig(): Config {
  const projectDir = process.env.RECON_PROJECT_DIR
    ?? join(process.cwd(), 'project');
  return {
    // No defaults for these. This package ships in a public, target-neutral repo:
    // baking one target's checkout paths in would be both wrong for every other
    // caller and a quiet way to leak where someone's tree lives. The launcher that
    // knows the target supplies them.
    regenDir: requireEnv('D2_REGEN_DIR'),
    modifiedDir: requireEnv('D2_MODIFIED_DIR'),
    daemonUrl: (process.env.GHIDRA_MCP_URL ?? 'http://localhost:8432').replace(/\/+$/, ''),
    // GHIDRA_MCP_TOKEN is what `connection.ts` and run-regen.sh already use, so
    // it is accepted as a fallback rather than making the operator export the
    // same secret twice under two names.
    token: process.env.GHIDRA_MCP_API_TOKEN ?? process.env.GHIDRA_MCP_TOKEN,
    sessionId: process.env.GHIDRA_SESSION,
    projectDir,
    // Likewise: a server URL and a program path are deployment facts, not defaults.
    projectPath: requireEnv('GHIDRA_PROJECT_PATH'),
    programPath: process.env.GHIDRA_PROGRAM_PATH ?? '',
    projectName: process.env.GHIDRA_PROJECT_NAME ?? 'Reconstructed',
    // The daemon keeps its OWN snapshot, seeded from the batch one at startup and
    // owned by it thereafter.
    //
    // `codegen-snapshot` is what `run.ts` REWRITES at the end of every batch
    // regen. Pointing the daemon at it means a regen silently replaces the model
    // the daemon is holding: the next incremental rebuild is computed from a model
    // that changed underneath it, the output disagrees with both the old and the
    // new tree, and nothing in the logs says why. That happened during
    // development and read as a broken optimisation for a while - 173 files
    // differing that had nothing to do with the change under test.
    snapshotDir: process.env.GHIDRA_LIVE_SNAPSHOT_DIR
      ?? join(projectDir, '.ghidra-mcp', 'live-snapshot'),
    /** Where to seed from when the daemon has no snapshot of its own yet. */
    repoRoot: process.env.RECON_REPO_ROOT ?? join(projectDir, '..'),
    seedSnapshotDir: process.env.GHIDRA_SNAPSHOT_DIR
      ?? join(projectDir, '.ghidra-mcp', 'codegen-snapshot'),
    stagingDir: process.env.GHIDRA_OUTPUT_DIR ?? join(process.cwd(), 'output'),
    logDir: process.env.D2_LIVE_LOG_DIR ?? join(projectDir, '.ghidra-mcp', 'live-logs'),
    httpPort: Number(process.env.D2_LIVE_HTTP_PORT ?? '8433'),
  };
}

interface AppliedRecord {
  seq: number;
  kind: string;
  target: string;
  key: string;
  name?: string;
  at: string;
}

interface LastRebuild {
  at: string;
  durationMs: number;
  filesWritten: number;
  ok: boolean;
  logPath: string;
  commit?: string;
}

export class LiveLoop {
  private readonly cfg: Config;
  private model!: LiveSnapshotModel;
  private indices!: ModelIndices;
  private connection!: GhidraConnection;
  private stream!: ChangeStream;

  private readonly applied: AppliedRecord[] = [];
  private lastRebuild: LastRebuild | null = null;
  private lastMerge: (MergeResult & { at: string }) | null = null;
  private lastCommit: string | null = null;

  /**
   * Set when the journal could not cover the gap, or a batch reported that the
   * model can no longer be trusted incrementally. While it is set NO events are
   * applied and NOTHING is committed — the loop is deliberately stuck, because
   * the alternative is a tree that is confidently wrong.
   */
  private needsFullResync: string | null = null;
  /**
   * Every operation that touches the model, the tree or git runs through here,
   * one at a time. An operator's `rebuild` or `full_regen` arriving mid-batch is
   * queued behind it rather than refused - being told 'busy, try again' is how
   * work gets silently dropped.
   */
  private readonly queue = new WorkQueue(m => this.log(m));

  /** Symbol hashes as of the last committed rebuild; null forces a full re-emit. */
  private hashCache: SymbolHashCache | null = null;

  /** What the last rebuild decided to re-emit, for `status`. */
  private lastSelection: ReturnType<typeof selectDirtyUnits> | null = null;

  /** The generator build the cached output was emitted by. */
  private buildId: string | null = null;
  /** Set while a rebuild is in flight, so `status` can say what it is doing. */
  private phase = 'idle';

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Copy the batch pipeline's snapshot into the daemon's own directory the first
   * time it starts, then never look at it again.
   *
   * Seeding rather than sharing: a batch regen rewrites its snapshot wholesale at
   * the end of every run, and a daemon reading that directory would find its model
   * replaced mid-life with no event to explain it. Once seeded, a regen and the
   * daemon can run side by side and disagree only about wall-clock freshness,
   * which `status` reports and an operator can resolve with a deliberate reseed.
   */
  private async seedSnapshotIfMissing(): Promise<void> {
    const manifest = join(this.cfg.snapshotDir, 'manifest.json');
    if (existsSync(manifest)) return;
    if (!existsSync(join(this.cfg.seedSnapshotDir, 'manifest.json'))) {
      throw new Error(
        `no snapshot to start from: neither ${this.cfg.snapshotDir} nor ` +
        `${this.cfg.seedSnapshotDir} holds a manifest.json. Run a batch regen first.`,
      );
    }
    this.log(`seeding ${this.cfg.snapshotDir} from ${this.cfg.seedSnapshotDir}`);
    await cp(this.cfg.seedSnapshotDir, this.cfg.snapshotDir, { recursive: true });
  }

  private log(message: string): void {
    // stderr, always: the stdio MCP transport owns stdout, and one stray log
    // line on it corrupts the JSON-RPC framing for the whole session.
    console.error(`[live ${new Date().toISOString()}] ${message}`);
  }

  async start(): Promise<void> {
    // Before anything reads or writes: `master` is the integration branch and
    // carries no worktree by design. A loop that found itself there would
    // commit generated code onto the branch the two others merge through.
    await assertNotBranch(this.cfg.modifiedDir, 'master');
    const modifiedBranch = await currentBranch(this.cfg.modifiedDir);
    const regenBranch = await currentBranch(this.cfg.regenDir);
    this.log(`regen ${this.cfg.regenDir} on '${regenBranch}', modified ${this.cfg.modifiedDir} on '${modifiedBranch}'`);

    await this.seedSnapshotIfMissing();

    const state = await loadLiveState(this.cfg.snapshotDir, this.cfg.programPath);
    this.log(`persisted seq ${state.seq}`);

    const options: ReconstructionOptions = {
      daemonUrl: this.cfg.daemonUrl,
      programPath: this.cfg.programPath,
      decompileTimeout: 60,
      excludeLibraryCode: false,
    };

    this.model = await loadSnapshotModel(this.cfg.snapshotDir, options, state.seq);
    this.indices = indexSnapshotModel(this.model);
    const counts = countModel(this.model);
    this.log(`model: ${counts.functions} functions, ${counts.dataTypes} types, ${counts.globals} globals`);

    // Attach to a nominated session when one is given. A daemon that resolves by
    // program path will CREATE a session when it finds none, which on a shared
    // server means spawning a worker for a 14k-function program - not something to
    // do as a side effect of starting up.
    this.connection = await createConnection(
      this.cfg.projectPath, this.cfg.daemonUrl, this.cfg.programPath, this.cfg.sessionId,
    );

    // Prove the journal can still serve everything after `seq` before trusting a
    // word of the persisted state. A restart that resumes across a gap carries a
    // model missing those changes for the rest of its life.
    const resume = await verifyResume(
      (cmd, params) => this.connection.sendCommand(cmd, params),
      state.seq,
      this.hashCache !== null,
    );
    this.log(`resume check: ${resume.reason}`);
    if (!resume.resumable) {
      this.hashCache = null;   // force a full re-emit
      this.declareResync(`cannot resume at seq ${state.seq}: ${resume.reason}`);
    } else {
      this.hashCache = (state.hashCache as SymbolHashCache | null) ?? null;
      if (!this.hashCache) {
        this.log('no hash cache persisted; the first rebuild re-emits everything');
      }

      // A rebuilt generator invalidates every cached unit, but NOT the model - the
      // model came from Ghidra and is still exactly right. So this forces a full
      // re-emit rather than a resync.
      const build = checkBuild(
        (state as { buildId?: string }).buildId,
        await buildFingerprint(this.cfg.repoRoot),
      );
      this.buildId = build.fingerprint;
      if (!build.reusable) {
        this.log(`generator check: ${build.reason}`);
        this.hashCache = null;
      } else {
        this.log(`generator check: ${build.reason}`);
      }
    }

    const sessionId = this.cfg.sessionId ?? this.connection.sessionId;
    this.log(`subscribed to session ${sessionId}`);

    this.stream = new ChangeStream({
      daemonUrl: this.cfg.daemonUrl,
      sessionId,
      token: this.cfg.token,
      since: state.seq,
      onBatch: batch => this.onBatch(batch),
      onTruncated: info => this.onTruncated(info),
      log: m => this.log(m),
    });
    this.stream.start();
  }

  async stop(): Promise<void> {
    this.stream?.stop();
    if (this.connection) await closeConnection(this.connection).catch(() => {});
  }

  /**
   * A gap in the journal. The model is behind Ghidra by an unknown amount and
   * no local reasoning can close it: nothing says WHICH symbols moved.
   *
   * Logged loudly and left stuck rather than rebuilt from what is in hand. A
   * rebuild here would produce a tree that is stale in an unknown place, commit
   * it, and merge it — and every one of those steps looks like a success.
   */
  /**
   * Declare the in-memory model untrustworthy and stop applying changes.
   *
   * Every path that discovers a gap ends here rather than carrying on quietly:
   * a truncated stream, a failed resume, an undo. The daemon keeps answering
   * `status` so an operator can see why, but refuses to compute anything from a
   * model whose relationship to the program is unknown.
   */
  private declareResync(reason: string): void {
    this.needsFullResync = reason;
    this.log('!'.repeat(72));
    this.log(`FULL RESYNC REQUIRED: ${reason}`);
    this.log('!'.repeat(72));
    this.queue.block(reason);
  }

  private onTruncated(info: { since: number; head: number }): void {
    this.needsFullResync =
      `The change journal could not cover seq ${info.since}..${info.head}. ` +
      `The model is behind Ghidra by an unknown amount. Nothing is being applied or committed. ` +
      `Re-run the full pipeline to rewrite the snapshot, or call the 'rebuild' tool to accept the ` +
      `current model as-is.`;
    this.stream.pause();
    this.log('!'.repeat(72));
    this.log(`FULL RESYNC REQUIRED: ${this.needsFullResync}`);
    // Refuse work rather than queue it: everything after this would be computed
    // from a model nobody has confirmed still matches the program.
    this.queue.block(this.needsFullResync);
    this.log('!'.repeat(72));
  }

  private async onBatch(batch: ChangeEvent[]): Promise<void> {
    if (this.needsFullResync) {
      this.log(`${batch.length} event(s) ignored: waiting for a full resync`);
      return;
    }
    let events = batch;
    await this.queue.submit({
      kind: 'apply',
      describe: `seq ${batch[0].seq}..${batch[batch.length - 1].seq} (${batch.length} event(s))`,
      // A burst that arrives while an earlier batch is still waiting becomes one
      // rebuild covering both, rather than two rebuilds where the first is
      // already stale by the time it finishes.
      absorb: (next) => {
        const more = (next as unknown as { events?: ChangeEvent[] }).events;
        if (!more) return false;
        events = [...events, ...more];
        return true;
      },
      events,
      run: async () => { await this.applyAndRebuild(events); },
    } as never);
  }

  private async applyAndRebuild(batch: ChangeEvent[]): Promise<void> {
    try {
      this.phase = 'applying';
      this.log(`batch of ${batch.length} event(s), seq ${batch[0].seq}..${batch[batch.length - 1].seq}`);

      const result = await applyEvents(
        this.model,
        this.indices,
        batch as unknown as ModelChangeEvent[],
        this.connection,
        m => this.log(`  ${m}`),
      );

      for (const e of batch) {
        this.applied.push({
          seq: e.seq, kind: e.kind, target: e.target, key: e.key,
          name: e.newName ?? e.oldName, at: new Date(e.ts || Date.now()).toISOString(),
        });
      }
      // Bounded: this is a status aid, not a journal. The daemon's journal is
      // the journal.
      while (this.applied.length > 500) this.applied.shift();

      if (result.needsFullResync) {
        this.onTruncated({ since: this.model.seq, head: this.model.seq });
        return;
      }

      this.log(
        `applied: ${result.touchedFunctions.length} functions, ` +
        `${result.touchedGlobals.length} globals, ${result.touchedDataTypes.length} types` +
        (result.escalatedToFullDecompile ? ' (escalated to a full decompile)' : ''),
      );

      await this.rebuildAndPublish();
    } finally {
      this.phase = 'idle';
    }
  }

  /**
   * Generate, sync, commit, merge — in that order, and each step gated on the
   * previous one succeeding.
   *
   * The seq is persisted only after the commit lands. A crash between
   * generation and commit therefore replays the batch, which costs ten minutes
   * and produces the identical tree; a seq persisted early would skip the batch
   * and produce a tree missing an edit nobody would think to look for.
   */
  /**
   * Re-check the generator immediately before generating. A build that lands while
   * the daemon is alive is the mixed-tree hazard: re-emitted units would carry the
   * new behaviour while every reused unit still carries the old.
   */
  private async guardBuild(): Promise<void> {
    const build = checkBuild(this.buildId, await buildFingerprint(this.cfg.repoRoot));
    if (!build.reusable) {
      this.log(`generator changed mid-life: ${build.reason}`);
      this.hashCache = null;
      this.buildId = build.fingerprint;
    }
  }

  private async rebuildAndPublish(): Promise<RebuildResult> {
    // A generator rebuilt since the cached output was produced invalidates every
    // reusable unit, so this must run BEFORE the dirty set is chosen.
    await this.guardBuild();

    this.phase = 'selecting';
    const identCachePath = join(dirname(this.cfg.snapshotDir), 'unit-identifiers.json');
    let identCacheEmpty = true;
    try {
      const raw = readFileSync(identCachePath, 'utf-8');
      identCacheEmpty = Object.keys(JSON.parse(raw) as Record<string, unknown>).length === 0;
    } catch {
      identCacheEmpty = true;   // missing or unreadable: no records to replay
    }

    const selection = selectDirtyUnits({
      buildInfo: await loadBuildInfo(join(this.cfg.projectDir, '.ghidra-mcp', 'buildinfo.json')),
      previous: this.hashCache,
      identCacheEmpty,
      functions: this.model.primary.functions,
      dataTypes: this.model.primary.dataTypes,
      globals: this.model.primary.globals,
    });
    this.lastSelection = selection;
    this.log(`dirty units: ${selection.reason}`);

    this.phase = 'generating';
    const result = await rebuild(this.model, {
      outputDir: this.cfg.stagingDir,
      projectDir: this.cfg.projectDir,
      projectName: this.cfg.projectName,
      logDir: this.cfg.logDir,
      log: m => this.log(m),
      emitUnits: selection.units,
      reuseDir: this.cfg.stagingDir,
      // BESIDE the snapshot directory, never inside it - for the same reason
      // stateFilePath() is: writeSnapshot swaps the whole directory out by rename,
      // so anything within it is destroyed on every save. Kept inside, the per-unit
      // identifier cache was wiped immediately before each generation, so every
      // incremental run loaded 0 records and replayed nothing. That is what deleted
      // 1216 lines of globals.h and 195 of globals.cpp and still committed clean.
      identCachePath,
    });

    this.lastRebuild = {
      at: new Date().toISOString(),
      durationMs: result.durationMs,
      filesWritten: result.filesWritten,
      ok: result.ok,
      logPath: result.logPath,
    };
    if (!result.ok) {
      this.log(`generation failed; nothing synced, nothing committed. See ${result.logPath}`);
      return result;
    }

    // The cache describes what the tree on disk was built from. Updating it only
    // after a successful generation means a failed one leaves the previous cache
    // in place and the next attempt re-selects the same units, rather than
    // believing work was done that was not.
    this.hashCache = computeHashCache({
      functions: this.model.primary.functions,
      dataTypes: this.model.primary.dataTypes,
      globals: this.model.primary.globals,
    });

    this.phase = 'syncing';
    await syncTree(this.cfg.stagingDir, this.cfg.regenDir);

    this.phase = 'committing';
    const commit = await commitRegen(this.cfg.regenDir, this.commitMessage(result));
    this.lastCommit = commit.sha ?? null;
    this.log(commit.committed ? `committed ${commit.sha}` : 'nothing changed in the tree');

    // Only now: the tree that corresponds to this seq is on disk and in git.
    // Written only AFTER the commit succeeded, so a crash in between means the
    // last batch is applied again on restart rather than skipped. Re-extracting a
    // symbol that has not moved yields the same record, so at-least-once is safe
    // here and at-most-once would not be.
    await saveLiveState(this.cfg.snapshotDir, {
      hashCache: this.hashCache,
      buildId: this.buildId,
      seq: this.model.seq,
      programPath: this.cfg.programPath,
      updatedAt: new Date().toISOString(),
    });
    if (this.lastRebuild) this.lastRebuild.commit = commit.sha;

    this.phase = 'merging';
    const merge = await mergeIntoModified(this.cfg.modifiedDir, 'source/regen');
    this.lastMerge = { ...merge, at: new Date().toISOString() };
    if (merge.state === 'conflict') {
      this.log(`merge CONFLICT in ${merge.conflictFiles?.length ?? 0} file(s); markers left in ${this.cfg.modifiedDir}`);
      // Stop here. Merging the next batch onto a tree with conflict markers in it
      // buries the conflict under more generated code and leaves nobody able to
      // tell which hunk was whose.
      this.queue.block(
        `merge conflict in ${this.cfg.modifiedDir}: ${(merge.conflictFiles ?? []).slice(0, 5).join(', ')}. ` +
        'Resolve it, then call retry_merge.',
      );
    } else if (merge.state === 'error') {
      // Not a conflict: nothing to resolve, so blocking on 'retry_merge' would be
      // asking for an action that cannot help. Say what git said and stop.
      this.log(`merge FAILED: ${merge.message}`);
      this.queue.block(`git merge failed in ${this.cfg.modifiedDir}: ${merge.message}`);
    } else if (merge.state === 'dirty') {
      this.log(`merge skipped: ${merge.message}`);
    } else {
      this.log(`merge ${merge.state}`);
    }

    this.phase = 'idle';
    return result;
  }

  private commitMessage(result: RebuildResult): string {
    const version = this.model.manifest.provenance.programVersion ?? 'unknown';
    const seq = this.model.seq;
    return `regen: ${this.cfg.programPath} v${version} at change seq ${seq}\n\n` +
      `${result.filesWritten} files generated in ${(result.durationMs / 1000).toFixed(1)}s ` +
      `from the live snapshot.`;
  }

  // ---------------------------------------------------------------------------
  // Control surface. Everything below is what `mcp.ts` calls.
  // ---------------------------------------------------------------------------

  status(): unknown {
    return {
      seq: this.model.seq,
      lastAppliedSeq: this.stream.lastAppliedSeq,
      counts: countModel(this.model),
      program: {
        path: this.cfg.programPath,
        ghidraVersion: this.model.manifest.provenance.programVersion,
        snapshotWrittenAt: this.model.manifest.provenance.writtenAt,
      },
      phase: this.phase,
      paused: this.stream.isPaused,
      streamConnected: this.stream.isConnected,
      queuedEvents: this.stream.queuedCount,
      needsFullResync: this.needsFullResync,
      queue: this.queue.status(),
      lastSelection: this.lastSelection
        ? {
            reason: this.lastSelection.reason,
            units: this.lastSelection.units === null ? 'ALL' : this.lastSelection.units.length,
            changedSymbols: this.lastSelection.changedSymbols.length,
          }
        : null,
      lastRebuild: this.lastRebuild,
      lastCommit: this.lastCommit,
      merge: this.lastMerge,
      dirs: { regen: this.cfg.regenDir, modified: this.cfg.modifiedDir, staging: this.cfg.stagingDir },
    };
  }

  changesApplied(limit: number): unknown {
    return { events: this.applied.slice(-limit) };
  }

  /**
   * Which generated files a symbol reaches.
   *
   * The symbol's own file comes from the emitted `.map` sidecars, which are the
   * generator's own record of where each function landed — not a guess. The
   * callers come from the model's call index, because a rename respells the
   * CALL SITE, which lives in the caller's file, not in the renamed function's.
   */
  async impact(symbol: string): Promise<unknown> {
    const maps = await loadSourceMapIndex(this.cfg.regenDir);
    const key = normalizeAddress(symbol);

    const fn = this.indices.fnByAddr.get(key)
      ?? this.model.primary.functions.find(f => f.name === symbol);
    const global = this.indices.globalByAddr.get(key)
      ?? this.model.primary.globals.find(g => g.name === symbol);

    if (!fn && !global) {
      return { symbol, found: false, note: 'Not a function or global in the model.' };
    }

    const files = new Set<string>();
    const callers: string[] = [];

    if (fn) {
      const own = maps.byAddress.get(normalizeAddress(fn.address));
      if (own) files.add(own);
      for (const alias of [normalizeAddress(fn.address), fn.name]) {
        for (const caller of this.indices.callersOf.get(alias) ?? []) {
          const callerFn = this.indices.fnByAddr.get(caller);
          if (!callerFn) continue;
          callers.push(callerFn.name);
          const file = maps.byAddress.get(normalizeAddress(callerFn.address));
          if (file) files.add(file);
        }
      }
    }

    if (global) {
      for (const name of global.referencingFunctions ?? []) {
        const bare = name.split('::').pop() ?? name;
        const reader = this.model.primary.functions.find(f => f.name === bare);
        if (!reader) continue;
        callers.push(reader.name);
        const file = maps.byAddress.get(normalizeAddress(reader.address));
        if (file) files.add(file);
      }
    }

    return {
      symbol,
      found: true,
      kind: fn ? 'function' : 'global',
      address: fn?.address ?? global?.address,
      files: [...files].sort(),
      callers: [...new Set(callers)].sort(),
      note: 'Files a rebuild would rewrite for this symbol.',
    };
  }

  /**
   * Force a rebuild now.
   *
   * Also the operator's way out of a full-resync stop: calling this is the
   * explicit statement that the model in hand is trusted. It clears the flag
   * and unpauses, because leaving it set after a deliberate rebuild would mean
   * the loop never restarts.
   */
  async rebuildNow(): Promise<unknown> {
    return this.queue.submit({
      kind: 'rebuild',
      describe: 'operator-requested rebuild',
      run: () => this.doRebuildNow(),
    });
  }

  private async doRebuildNow(): Promise<unknown> {
    try {
      if (this.needsFullResync) {
        this.log('operator forced a rebuild; clearing the full-resync stop');
        this.needsFullResync = null;
        this.stream.resume();
      }
      const result = await this.rebuildAndPublish();
      return { started: true, ok: result.ok, durationMs: result.durationMs, filesWritten: result.filesWritten };
    } finally {
      this.phase = 'idle';
    }
  }

  /**
   * The oracle: generate the same snapshot into a scratch directory and diff it
   * against the live tree.
   *
   * A clean diff is the evidence that the incremental path produced exactly what
   * a batch regen would have. Anything else is the bug this whole design exists
   * to make visible, so the differing files are named rather than counted.
   */
  async fullRegen(): Promise<unknown> {
    return this.queue.submit({
      kind: 'full-regen',
      describe: 'oracle: full generation into a scratch tree, then diff',
      run: () => this.doFullRegen(),
    });
  }

  private async doFullRegen(): Promise<unknown> {
    const scratch = await mkdtemp(join(tmpdir(), 'live-oracle-'));
    try {
      this.phase = 'oracle';
      const result = await rebuild(this.model, {
        outputDir: scratch,
        projectDir: this.cfg.projectDir,
        projectName: this.cfg.projectName,
        logDir: this.cfg.logDir,
        log: m => this.log(m),
      });
      if (!result.ok) {
        return { ok: false, logPath: result.logPath, stdoutTail: result.stdoutTail };
      }

      const differing = await diffTrees(scratch, this.cfg.regenDir);
      return {
        ok: true,
        identical: differing.length === 0,
        durationMs: result.durationMs,
        differingFiles: differing,
        note: differing.length === 0
          ? 'The live tree is byte-identical to a fresh generation of the same snapshot.'
          : 'These files differ between the live tree and a fresh generation. Repo-owned files are excluded.',
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
      this.phase = 'idle';
    }
  }

  /**
   * The emitted C++ for one function, next to Ghidra's decompilation of it now.
   *
   * This is the direct answer to "is the tree behind Ghidra here", which no
   * amount of sequence-number bookkeeping can settle on its own.
   */
  async diffFunction(address: string): Promise<unknown> {
    const key = normalizeAddress(address);
    const fn = this.indices.fnByAddr.get(key);
    if (!fn) return { address, found: false, note: 'Not a function in the model.' };

    const maps = await loadSourceMapIndex(this.cfg.regenDir);
    const file = maps.byAddress.get(key);

    let emitted: string | null = null;
    if (file) {
      emitted = await extractEmittedFunction(join(this.cfg.regenDir, file), key);
    }

    let ghidra: string | null = null;
    let ghidraError: string | undefined;
    try {
      ghidra = await decompileFunction(this.connection, fn.address, 60);
    } catch (e) {
      ghidraError = (e as Error).message;
    }

    return {
      address: fn.address,
      name: fn.name,
      file,
      emitted,
      modelBody: fn.decompiled ?? null,
      ghidra,
      ghidraError,
      modelMatchesGhidra: ghidra !== null && fn.decompiled === ghidra,
      note: 'modelMatchesGhidra false means the model is behind Ghidra for this function.',
    };
  }

  mergeStatus(): unknown {
    return {
      modifiedDir: this.cfg.modifiedDir,
      last: this.lastMerge,
      note: this.lastMerge?.state === 'conflict'
        ? 'Conflict markers are still in the worktree. Resolve them there, commit, then call retry_merge.'
        : undefined,
    };
  }

  async retryMerge(): Promise<unknown> {
    return this.queue.submit({
      kind: 'merge',
      describe: 'operator-requested merge retry',
      run: () => this.doRetryMerge(),
    });
  }

  private async doRetryMerge(): Promise<unknown> {
    const merge = await mergeIntoModified(this.cfg.modifiedDir, 'source/regen');
    this.lastMerge = { ...merge, at: new Date().toISOString() };
    return this.lastMerge;
  }

  pause(): unknown {
    this.stream.pause();
    this.log('paused by operator');
    return { paused: true, queued: this.stream.queuedCount };
  }

  resume(): unknown {
    if (this.needsFullResync) {
      return { paused: true, refused: true, reason: this.needsFullResync };
    }
    this.stream.resume();
    this.log('resumed by operator');
    return { paused: false, queued: this.stream.queuedCount };
  }
}

// -----------------------------------------------------------------------------
// Tree plumbing
// -----------------------------------------------------------------------------

/**
 * rsync the generated tree into the regen worktree.
 *
 * `--delete`, and the same exclusions run-regen.sh uses, because a file the
 * generator stops emitting must not linger and keep contributing compile errors
 * — six such strays once inflated a measurement by 14. The exclusions come from
 * `paths.ts`, which is the shared statement of what in that repo is NOT
 * generator output; without them `--delete` removes .gitignore and the whole
 * metrics history on every run.
 */
async function syncTree(from: string, to: string): Promise<void> {
  const excludes = ['.git', '.idea/', '.DS_Store', ...NEVER_TOUCH]
    .flatMap(entry => ['--exclude', entry]);
  await run('rsync', ['-a', '--delete', `${from.replace(/\/*$/, '')}/`, `${to.replace(/\/*$/, '')}/`, ...excludes], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Files that differ between two trees, excluding everything the regen tree owns
 * rather than generates.
 *
 * `diff -r --brief` exits 1 when there are differences, which is the normal
 * outcome here and not an error.
 */
async function diffTrees(candidate: string, live: string): Promise<string[]> {
  let stdout: string;
  try {
    const out = await run('diff', ['-r', '--brief', candidate, live], { maxBuffer: 64 * 1024 * 1024 });
    stdout = out.stdout;
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    if (typeof err.code !== 'number' || err.code > 1) throw e;
    stdout = err.stdout ?? '';
  }

  const differing: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // "Files A/x/y and B/x/y differ" | "Only in A/x: y"
    const both = /^Files (.+?) and (.+?) differ$/.exec(line);
    const only = /^Only in (.+?): (.+)$/.exec(line);
    let rel: string | null = null;
    if (both) {
      rel = relative(candidate, both[1]);
    } else if (only) {
      const dir = only[1];
      const base = dir.startsWith(candidate) ? candidate : live;
      rel = join(relative(base, dir), only[2]);
    }
    if (rel && !isNeverTouch(rel)) differing.push(rel);
  }
  return differing.sort();
}

interface SourceMapIndex {
  /** Normalised address -> output-relative .cpp path. */
  byAddress: Map<string, string>;
}

let sourceMapCache: { root: string; mtimeKey: string; index: SourceMapIndex } | null = null;

/**
 * Address -> emitted file, read from the `.map` sidecars the generator writes.
 *
 * These are the generator's own record of where each function landed. Deriving
 * the same mapping from the module config would be a second implementation of
 * the file-placement rules, and the two would disagree the first time a
 * placement rule changed.
 */
async function loadSourceMapIndex(root: string): Promise<SourceMapIndex> {
  const files = await findMapFiles(root);
  const mtimeKey = `${files.length}`;
  if (sourceMapCache && sourceMapCache.root === root && sourceMapCache.mtimeKey === mtimeKey) {
    return sourceMapCache.index;
  }

  const byAddress = new Map<string, string>();
  for (const path of files) {
    try {
      const map = JSON.parse(await readFile(path, 'utf8')) as {
        file?: string;
        functions?: { address?: string }[];
      };
      // The `.map` sits beside its .cpp, so the relative path of one is the
      // relative path of the other minus the suffix.
      const rel = relative(root, path).replace(/\.map$/, '');
      for (const fn of map.functions ?? []) {
        if (fn.address) byAddress.set(normalizeAddress(fn.address), rel);
      }
      void map.file;
    } catch {
      // A half-written map during a sync is not worth failing a status query.
    }
  }

  const index = { byAddress };
  sourceMapCache = { root, mtimeKey, index };
  return index;
}

async function findMapFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.map')) out.push(path);
    }
  };
  await walk(root);
  return out.sort();
}

/**
 * The emitted text for one function, sliced out of its .cpp.
 *
 * The generator stamps each function with a `// 1.14d ... <address>` banner, so
 * the block runs from the comment above that banner to the start of the next
 * one. This is a DISPLAY heuristic and nothing depends on it being exact: it
 * feeds an operator's eyes, never a transform. A transform over emitted text
 * would go through the AST instead.
 */
async function extractEmittedFunction(path: string, addressKey: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const banner = (line: string) => line.startsWith('// Diablo 2 ') || /^\/\/ 1\.\d+/.test(line);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\/\/ 1\.\d+/.test(lines[i])) continue;
    if (!lines[i].toLowerCase().includes(addressKey)) continue;
    start = i;
    while (start > 0 && banner(lines[start - 1])) start--;
    break;
  }
  if (start < 0) return null;

  let end = start + 1;
  while (end < lines.length && !(banner(lines[end]) && end > start + 1)) end++;
  return lines.slice(start, end).join('\n').trimEnd();
}

/** The hex tail of a Ghidra address, lower case, no `0x`. Matches `model.ts`. */
function normalizeAddress(address: string): string {
  const bare = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return bare.replace(/^0x/i, '').toLowerCase();
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  const loop = new LiveLoop(cfg);
  await loop.start();

  const { serveStdio, serveHttp } = await import('./mcp.js');
  const http = await serveHttp(loop, cfg.httpPort);
  console.error(`[live] control endpoint on http://127.0.0.1:${http.port}/`);
  await serveStdio(loop);

  const shutdown = async () => {
    await loop.stop();
    await http.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Only when run directly, so the class stays importable by a test or a script.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}

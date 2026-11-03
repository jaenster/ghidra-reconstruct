/**
 * The rolling model verifier: while the daemon has nothing else to do, read functions and
 * types from Ghidra again, a few at a time, and compare them with the model.
 *
 * The incremental path decides what to re-extract from the change records, and a full
 * codegen of the model it keeps cannot see a record it failed to re-read: v1858 retyped
 * three struct fields, the readers reached them through a global and never spelled the
 * struct, and the model kept their old text while every proof compared the generator with
 * itself. Ghidra is the only oracle for that, so the sweep asks it.
 *
 * Reads go through the same worker and the same code as a refresh (`fetchFunctionRecord`,
 * `readFunctionFacts`, `attachOperandRefs`, `rereadDataType`), over copies, so a match
 * means a refresh would have written what the model holds. A mismatch is handed back to
 * the daemon as an ordinary change event for that symbol, which applies it through
 * `applyEvents` and re-emits incrementally: the verifier itself never writes the model,
 * and never writes anything to Ghidra.
 *
 * It yields to everything. A step starts only after the daemon has been idle for a quiet
 * period, a running step stops handing out reads the moment the daemon is not idle, and a
 * step that was interrupted is thrown away rather than half-counted. The cursor persists
 * beside the snapshot, so a restart resumes the sweep where it stopped.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { extractDataTypes, type ExtractedDataType, type ExtractedFunction, type GhidraConnection } from '@ghidra-mcp/reconstruct';
import { attachOperandRefs } from '@ghidra-mcp/reconstruct/extract/operand-refs';
import { DETAIL_KINDS } from '@ghidra-mcp/reconstruct/extract/types';
import { stableJson } from '@ghidra-mcp/reconstruct/extract/function-facts';

import {
  addressKey,
  dataTypeKey,
  fetchFunctionRecord,
  ghidraName,
  TYPE_ORDER_EVENT,
  typeOrderDrift,
  readFunctionFacts,
  rereadDataType,
  readGlobalRecords,
  type ChangeEvent,
  type LiveLog,
  type LiveModel,
  type ModelIndices,
} from './model.js';

export interface VerifierConfig {
  enabled: boolean;
  /** Functions read per step. */
  batchSize: number;
  /** Types read per step. */
  typeBatchSize: number;
  /** Global addresses read per step: one label script and one listing call per step. */
  globalBatchSize: number;
  /** Reads in flight at once within a step. */
  concurrency: number;
  /** Pause between steps. */
  pauseMs: number;
  /** How long the daemon must have been idle before a step starts. */
  quietMs: number;
  /** Mismatches kept for `status`. */
  keepMismatches: number;
}

/**
 * Settings from the environment. Defaults: 16 functions, 64 types or 200 global addresses
 * per step, 4 reads in
 * flight, 2 s between steps, 30 s of quiet first. On by default only against the local
 * worker: there the reads hit a private copy of the program, while a cloud source shares
 * its worker with every other session.
 */
export function verifierConfigFromEnv(env: NodeJS.ProcessEnv, localWorker: boolean): VerifierConfig {
  const num = (name: string, fallback: number, min = 0): number => {
    const v = Number(env[name]);
    return Number.isFinite(v) && env[name] !== '' && env[name] !== undefined ? Math.max(min, v) : fallback;
  };
  const flag = env.D2_LIVE_VERIFY;
  return {
    enabled: flag === undefined || flag === '' ? localWorker : flag !== '0',
    batchSize: num('D2_LIVE_VERIFY_BATCH', 16, 1),
    typeBatchSize: num('D2_LIVE_VERIFY_TYPE_BATCH', 64, 1),
    globalBatchSize: num('D2_LIVE_VERIFY_GLOBAL_BATCH', 200, 1),
    concurrency: num('D2_LIVE_VERIFY_CONCURRENCY', 4, 1),
    pauseMs: num('D2_LIVE_VERIFY_PAUSE_MS', 2000),
    quietMs: num('D2_LIVE_VERIFY_QUIET_MS', 30000),
    keepMismatches: num('D2_LIVE_VERIFY_KEEP', 200, 1),
  };
}

export interface VerifierHost {
  model(): LiveModel;
  indices(): ModelIndices;
  client(): GhidraConnection;
  /** Nothing queued, running, publishing, held, paused or blocked. */
  idle(): boolean;
  /**
   * Bring the model up to date for these symbols through the ordinary path (applyEvents,
   * then an incremental rebuild and publish). Resolves once that ran.
   */
  applyStale(events: ChangeEvent[], describe: string): Promise<void>;
  /**
   * Whether the worker reads a different program version than the model is at. Asked
   * before and after a step's reads: a step whose reads may have seen another version
   * says nothing about this one. Absent: the source cannot tell, and nothing is checked.
   */
  versionMoved?(): Promise<boolean>;
  log: LiveLog;
}

export interface VerifierMismatch {
  at: string;
  kind: 'function' | 'datatype' | 'global' | 'type order';
  /** Address key, the type's name + NUL + category, or `#<position>` for the type order. */
  key: string;
  name: string;
  /** Which record fields differ. */
  fields: string[];
  /** Model lines ("-") against Ghidra's ("+") around the first difference in the body. */
  diff?: string;
  /** Whether the stale record was queued for the ordinary update, or why not. */
  applied: 'queued' | 'applied' | 'not applied' | string;
  /** Found by the sweep or by `verify_now`. */
  source: 'sweep' | 'verify_now';
}

export interface VerifierCursor {
  /** Which list the sweep is walking. */
  phase: 'functions' | 'datatypes' | 'globals';
  /** The last key verified in that list; null at its start. */
  key: string | null;
}

/** Persisted beside the snapshot (live-verifier.json). */
export interface VerifierState {
  cursor: VerifierCursor;
  cycle: number;
  cycleStartedAt: string | null;
  /** Functions and types verified (matched or not) in the current cycle. */
  sweptThisCycle: number;
  lastFullCycleMs: number | null;
  lastCycleEndedAt: string | null;
  mismatchesTotal: number;
  /** Reads that could not be compared (decompile or facts failed). */
  unverifiedTotal: number;
  mismatches: VerifierMismatch[];
}

export interface FunctionCheck {
  key: string;
  name: string;
  status: 'match' | 'mismatch' | 'unverified' | 'missing';
  fields?: string[];
  diff?: string;
  /** The signature moved: callers decompile differently too. */
  signatureMoved?: boolean;
  note?: string;
}

export interface TypeCheck {
  key: string;
  name: string;
  status: 'match' | 'mismatch' | 'unverified';
  fields?: string[];
  note?: string;
}

export interface GlobalCheck {
  /** Address key. */
  key: string;
  /** The label names at the address, the model's and Ghidra's. */
  name: string;
  status: 'match' | 'mismatch' | 'unverified';
  /** `label.field` for each differing field; `label (gone)` / `label (new)` for a label. */
  fields?: string[];
  note?: string;
}

/** Fields whose change also moves what callers print. */
const SIGNATURE_FIELDS = new Set([
  'name', 'signature', 'returnType', 'parameters', 'callingConvention', 'hasVarArgs',
  'isInline', 'noReturn', 'namespace', 'customStorage', 'callFixup', 'stackPurge',
]);

/** Derived from the body after a refresh (recomputeCallEdges), never read from Ghidra. */
const DERIVED_FIELDS = new Set(['calledFunctions']);

function differingFields(a: object, b: object, skip: ReadonlySet<string> = DERIVED_FIELDS): string[] {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const out: string[] = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    const va = ra[k];
    const vb = rb[k];
    if (va === undefined && vb === undefined) continue;
    if (stableJson(va) !== stableJson(vb)) out.push(k);
  }
  return out.sort();
}

/**
 * A short line diff: the first differing region of two texts, a line of context either
 * side, at most `max` lines of each.
 */
export function shortDiff(before: string, after: string, max = 6): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) { tailA--; tailB--; }
  const out: string[] = [`@@ line ${head + 1}`];
  if (head > 0) out.push(`  ${a[head - 1].trim()}`);
  const removed = a.slice(head, tailA + 1);
  const added = b.slice(head, tailB + 1);
  for (const l of removed.slice(0, max)) out.push(`- ${l.trim()}`);
  if (removed.length > max) out.push(`- ... ${removed.length - max} more`);
  for (const l of added.slice(0, max)) out.push(`+ ${l.trim()}`);
  if (added.length > max) out.push(`+ ... ${added.length - max} more`);
  return out.join('\n');
}

/**
 * Read these functions as a refresh would and compare them with the model. Never
 * mutates the model: the reads land on copies. `interrupted` stops handing out further
 * reads; the functions not read come back `unverified`.
 */
export async function checkFunctions(
  model: LiveModel,
  indices: ModelIndices,
  client: GhidraConnection,
  addrs: readonly string[],
  opts: { concurrency: number; log: LiveLog; interrupted?: () => boolean },
): Promise<FunctionCheck[]> {
  const timeout = model.options.decompileTimeout ?? 30;
  const quiet: LiveLog = () => {};
  const fetched: Array<{ record: ExtractedFunction; decompileFailed: boolean } | null | 'skipped'> =
    new Array(addrs.length).fill('skipped');
  let next = 0;
  const lanes = Math.max(1, Math.min(opts.concurrency, addrs.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let i = next++; i < addrs.length; i = next++) {
      if (opts.interrupted?.()) return;
      const existing = indices.fnByAddr.get(addrs[i]);
      // A copy: fetchFunctionRecord spreads the record it is given, but the facts and
      // operand references below are written in place.
      const base = existing ? structuredClone(existing) : undefined;
      try {
        fetched[i] = await fetchFunctionRecord(client, base, addrs[i], { reextractInfo: true, timeout, log: quiet });
      } catch (e) {
        opts.log(`verify ${addrs[i]}: read failed (${(e as Error).message})`);
        fetched[i] = 'skipped';
      }
    }
  }));

  const fresh: ExtractedFunction[] = [];
  for (const f of fetched) if (f && f !== 'skipped' && !f.decompileFailed) fresh.push(f.record);
  let factsOk = true;
  if (fresh.length > 0 && !opts.interrupted?.()) {
    factsOk = await readFunctionFacts(model, client, fresh, quiet);
    await attachOperandRefs(client, fresh, fresh.map(f => addressKey(f.address)));
  } else if (fresh.length > 0) {
    factsOk = false;
  }

  return addrs.map((key, i): FunctionCheck => {
    const existing = indices.fnByAddr.get(key);
    const name = existing?.name ?? key;
    const f = fetched[i];
    if (f === 'skipped') return { key, name, status: 'unverified', note: 'not read' };
    if (f === null) return { key, name, status: 'missing', note: 'Ghidra has no function here' };
    if (f.decompileFailed) return { key, name, status: 'unverified', note: 'decompile failed' };
    if (!factsOk) return { key, name, status: 'unverified', note: 'facts not read' };
    // A function Ghidra has and the model does not is a structural change, which the
    // daemon answers with a resync, not a refresh.
    if (!existing) return { key, name: f.record.name, status: 'unverified', note: 'not in the model' };
    const fields = differingFields(existing, f.record);
    if (fields.length === 0) return { key, name, status: 'match' };
    return {
      key, name, status: 'mismatch', fields,
      diff: fields.includes('decompiled') ? shortDiff(existing.decompiled ?? '', f.record.decompiled ?? '') : undefined,
      signatureMoved: fields.some(k => SIGNATURE_FIELDS.has(k)),
    };
  });
}

/** Read these types' details as a refresh would and compare them with the model. */
export async function checkDataTypes(
  model: LiveModel,
  client: GhidraConnection,
  keys: readonly string[],
  opts: { concurrency: number; log: LiveLog; interrupted?: () => boolean },
): Promise<TypeCheck[]> {
  const byKey = new Map<string, ExtractedDataType>();
  for (const dt of model.primary.dataTypes) byKey.set(dataTypeKey(dt.name, dt.category), dt);
  const out: TypeCheck[] = keys.map(key => ({ key, name: byKey.get(key)?.name ?? key, status: 'unverified', note: 'not read' }));
  // Pointers and arrays are read from the listing, as a refresh reads them: once per
  // check, and only when one of these keys needs it.
  let listingRead: Promise<ExtractedDataType[] | null> | undefined;
  const typeListing = () => (listingRead ??= extractDataTypes(client, { limit: 10000 }).catch(() => null));
  let next = 0;
  const lanes = Math.max(1, Math.min(opts.concurrency, keys.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let i = next++; i < keys.length; i = next++) {
      if (opts.interrupted?.()) return;
      const existing = byKey.get(keys[i]);
      if (!existing) { out[i] = { key: keys[i], name: keys[i], status: 'unverified', note: 'not in the model' }; continue; }
      try {
        const fresh = await rereadDataType(client, ghidraName(existing), existing.category, existing, typeListing);
        const fields = differingFields(existing, fresh, new Set());
        out[i] = fields.length === 0
          ? { key: keys[i], name: existing.name, status: 'match' }
          : { key: keys[i], name: existing.name, status: 'mismatch', fields };
      } catch (e) {
        out[i] = { key: keys[i], name: existing.name, status: 'unverified', note: (e as Error).message };
      }
    }
  }));
  return out;
}

/**
 * Read the globals at these addresses as a reconcile would (readGlobalRecords) and compare
 * them with the model's records there: the same labels, and for each the same record.
 */
export async function checkGlobals(
  model: LiveModel,
  client: GhidraConnection,
  addrs: readonly string[],
  opts: { log: LiveLog },
): Promise<GlobalCheck[]> {
  const quiet: LiveLog = () => {};
  const inModel = new Map<string, Array<LiveModel['primary']['globals'][number]>>();
  const wanted = new Set(addrs);
  for (const g of model.primary.globals) {
    if (g.platform) continue;
    const a = addressKey(g.address);
    if (!wanted.has(a)) continue;
    let list = inModel.get(a);
    if (!list) inModel.set(a, (list = []));
    list.push(g);
  }
  let read;
  try {
    read = await readGlobalRecords(model, client, addrs, quiet);
  } catch (e) {
    opts.log(`verify globals: read failed (${(e as Error).message})`);
    read = null;
  }
  return addrs.map((key): GlobalCheck => {
    const have = inModel.get(key) ?? [];
    const name = have.map(g => g.name).join(', ') || key;
    if (!read) return { key, name, status: 'unverified', note: 'labels not read' };
    const names = read.labels.get(key)?.names ?? [];
    const fields: string[] = [];
    let unverified: string | null = null;
    for (const g of have) if (!names.includes(g.name)) fields.push(`${g.name} (gone)`);
    for (const label of names) {
      const k = `${key}\t${label}`;
      const existing = have.find(g => g.name === label);
      if (!read.records.has(k)) { unverified = `${label} not read`; continue; }
      const fresh = read.records.get(k)!;
      if (!fresh) { if (existing) fields.push(`${label} (no record)`); continue; }
      if (!existing) { fields.push(`${label} (new)`); continue; }
      const differ = differingFields(existing, fresh, new Set());
      // read_data_value answers a failure with nothing, the same as no data: bytes the model
      // has and the read lacks are a failed read, not evidence of a change.
      if (differ.includes('initializedData') && (read.initializedDataFailed || fresh.initializedData === undefined)) {
        unverified = `${label} initialized data not read`;
        differ.splice(differ.indexOf('initializedData'), 1);
      }
      for (const f of differ) fields.push(`${label}.${f}`);
    }
    if (fields.length > 0) return { key, name, status: 'mismatch', fields };
    if (unverified) return { key, name, status: 'unverified', note: unverified };
    return { key, name, status: 'match' };
  });
}

/** The change event that sends one stale function through the ordinary update. */
export function functionEvent(check: FunctionCheck): ChangeEvent {
  return {
    seq: 0,
    kind: 'function.changed',
    target: 'function',
    key: check.key,
    txDescription: 'model verifier',
    // Only a body that moved on its own leaves the callers as they were.
    callersUnaffected: !check.signatureMoved,
  };
}

/** A stale global goes through the reconcile, which also re-decompiles its readers. */
export function globalEvent(check: GlobalCheck): ChangeEvent {
  return { seq: 0, kind: 'data.changed', target: 'global', key: check.key, txDescription: 'model verifier' };
}

export function dataTypeEvent(check: TypeCheck): ChangeEvent {
  return { seq: 0, kind: 'datatype.changed', target: 'datatype', key: check.key, txDescription: 'model verifier' };
}

/** Address keys in numeric order: shorter first, then by hex digits. */
function compareAddressKeys(a: string, b: string): number {
  return (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
}

function freshState(): VerifierState {
  return {
    cursor: { phase: 'functions', key: null },
    cycle: 0,
    cycleStartedAt: null,
    sweptThisCycle: 0,
    lastFullCycleMs: null,
    lastCycleEndedAt: null,
    mismatchesTotal: 0,
    unverifiedTotal: 0,
    mismatches: [],
  };
}

export type StepOutcome = 'disabled' | 'busy' | 'interrupted' | 'verified' | 'cycle-complete';

export class ModelVerifier {
  private state: VerifierState = freshState();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** When the daemon was last seen busy; `start` counts as busy, so the quiet period runs from there. */
  private lastBusyAt = Number.NEGATIVE_INFINITY;
  /** One step or verify_now at a time. */
  private running: Promise<unknown> = Promise.resolve();
  private stepping = false;
  private lastStep: { at: string; outcome: StepOutcome; checked: number; ms: number } | null = null;

  constructor(
    private readonly host: VerifierHost,
    private readonly cfg: VerifierConfig,
    /** Where the cursor persists; null keeps it in memory (tests). */
    private readonly statePath: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (!this.statePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<VerifierState>;
      this.state = { ...freshState(), ...parsed, cursor: { ...freshState().cursor, ...(parsed.cursor ?? {}) } };
    } catch {
      this.state = freshState();
    }
  }

  private async save(): Promise<void> {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(tmp, this.statePath);
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.host.log('model verifier: off (D2_LIVE_VERIFY)');
      return;
    }
    this.stopped = false;
    this.lastBusyAt = this.now();
    this.host.log(
      `model verifier: ${this.cfg.batchSize} functions / ${this.cfg.typeBatchSize} types per step, ` +
      `${this.cfg.pauseMs} ms apart, after ${this.cfg.quietMs / 1000}s idle; ` +
      `resuming at ${this.state.cursor.phase} ${this.state.cursor.key ?? '(start)'}`,
    );
    this.schedule(this.cfg.pauseMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.step();
    } catch (e) {
      this.host.log(`model verifier: step failed (${(e as Error).message})`);
    }
    this.schedule(this.cfg.pauseMs);
  }

  /** The sweep's next keys in the current phase, after the cursor. */
  private nextKeys(): { phase: VerifierCursor['phase']; keys: string[] } {
    const model = this.host.model();
    const { phase, key } = this.state.cursor;
    if (phase === 'functions') {
      const all = model.primary.functions
        .filter(f => !f.platform)
        .map(f => addressKey(f.address))
        .sort(compareAddressKeys);
      const after = key === null ? all : all.filter(k => compareAddressKeys(k, key) > 0);
      return { phase, keys: after.slice(0, this.cfg.batchSize) };
    }
    if (phase === 'globals') {
      const all = [...new Set(model.primary.globals.filter(g => !g.platform && g.address).map(g => addressKey(g.address)))]
        .sort(compareAddressKeys);
      const after = key === null ? all : all.filter(k => compareAddressKeys(k, key) > 0);
      return { phase, keys: after.slice(0, this.cfg.globalBatchSize) };
    }
    const all = model.primary.dataTypes
      .filter(dt => DETAIL_KINDS.has(dt.kind))
      .map(dt => dataTypeKey(dt.name, dt.category))
      .sort();
    const after = key === null ? all : all.filter(k => k > key);
    return { phase, keys: after.slice(0, this.cfg.typeBatchSize) };
  }

  /**
   * One step of the sweep, when the daemon is idle and has been for the quiet period.
   * Public so tests drive it without timers.
   */
  async step(): Promise<StepOutcome> {
    if (!this.cfg.enabled) return 'disabled';
    if (!this.host.idle()) { this.lastBusyAt = this.now(); return 'busy'; }
    if (this.now() - this.lastBusyAt < this.cfg.quietMs) return 'busy';
    const run = this.running.then(() => this.doStep());
    this.running = run.catch(() => {});
    return run;
  }

  private async doStep(): Promise<StepOutcome> {
    if (!this.host.idle()) { this.lastBusyAt = this.now(); return 'busy'; }
    this.stepping = true;
    const t0 = this.now();
    try {
      if (!this.state.cycleStartedAt) {
        this.state.cycle++;
        this.state.cycleStartedAt = new Date(t0).toISOString();
        this.state.sweptThisCycle = 0;
      }
      const { phase, keys } = this.nextKeys();
      if (keys.length === 0) {
        // Once a cycle, between the functions and the types: the type list's order is a
        // whole-program input no per-record read can see.
        if (phase === 'functions') {
          const outcome = await this.checkTypeOrder(t0);
          if (outcome) return outcome;
        }
        if (phase !== 'globals') {
          this.state.cursor = { phase: phase === 'functions' ? 'datatypes' : 'globals', key: null };
          await this.save();
          return 'verified';
        }
        return await this.endCycle();
      }

      const interrupted = () => !this.host.idle();
      // The reads must see the version the model is at; a worker that already followed a
      // check-in answers for the next one, and its batch is about to arrive.
      if (await this.host.versionMoved?.()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
      const model = this.host.model();
      const events: ChangeEvent[] = [];
      const found: VerifierMismatch[] = [];
      let unverified = 0;
      if (phase === 'functions') {
        const checks = await checkFunctions(model, this.host.indices(), this.host.client(), keys,
          { concurrency: this.cfg.concurrency, log: this.host.log, interrupted });
        // An event arrived while reading: the worker may already hold the next version,
        // so nothing read in this step is evidence about the model's. Thrown away whole.
        if (interrupted()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
        for (const c of checks) {
          if (c.status === 'unverified' || c.status === 'missing') { unverified++; continue; }
          if (c.status !== 'mismatch') continue;
          events.push(functionEvent(c));
          found.push(this.mismatch('function', c.key, c.name, c.fields ?? [], c.diff, 'sweep'));
        }
      } else if (phase === 'globals') {
        const checks = await checkGlobals(model, this.host.client(), keys, { log: this.host.log });
        if (interrupted()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
        for (const c of checks) {
          if (c.status === 'unverified') { unverified++; continue; }
          if (c.status !== 'mismatch') continue;
          events.push(globalEvent(c));
          found.push(this.mismatch('global', c.key, c.name, c.fields ?? [], undefined, 'sweep'));
        }
      } else {
        const checks = await checkDataTypes(model, this.host.client(), keys,
          { concurrency: this.cfg.concurrency, log: this.host.log, interrupted });
        if (interrupted()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
        for (const c of checks) {
          if (c.status === 'unverified') { unverified++; continue; }
          if (c.status !== 'mismatch') continue;
          events.push(dataTypeEvent(c));
          found.push(this.mismatch('datatype', c.key, c.name, c.fields ?? [], undefined, 'sweep'));
        }
      }

      if (await this.host.versionMoved?.()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
      this.state.cursor = { phase, key: keys[keys.length - 1] };
      this.state.sweptThisCycle += keys.length;
      this.state.unverifiedTotal += unverified;
      await this.save();
      this.record('verified', keys.length, t0);
      if (events.length > 0) await this.apply(events, found);
      return 'verified';
    } finally {
      this.stepping = false;
    }
  }

  /**
   * Compare the model's type order with one listing call. A drift is logged as MODEL
   * STALE (type order) with its first differing position and sent through the ordinary
   * update, which reorders the list; the headers that emit the moved types re-emit (typeOrder in dirty-units).
   * Returns an outcome only when the step has to stop here.
   */
  private async checkTypeOrder(t0: number): Promise<StepOutcome | null> {
    if (await this.host.versionMoved?.()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
    let listing: ExtractedDataType[];
    try {
      listing = await extractDataTypes(this.host.client(), { limit: 10000 });
    } catch (e) {
      this.state.unverifiedTotal++;
      this.host.log(`model verifier: type order not checked (${(e as Error).message})`);
      return null;
    }
    if (!this.host.idle() || await this.host.versionMoved?.()) { this.lastBusyAt = this.now(); this.record('interrupted', 0, t0); return 'interrupted'; }
    const drift = typeOrderDrift(this.host.model().primary.dataTypes, listing);
    if (!drift) return null;
    const found = [this.mismatch('type order', `#${drift.index}`, drift.model, [drift.listing], undefined, 'sweep')];
    await this.apply([{ seq: 0, kind: TYPE_ORDER_EVENT, target: 'datatype', key: '', txDescription: 'model verifier' }], found);
    return null;
  }

  private async endCycle(): Promise<StepOutcome> {
    const started = this.state.cycleStartedAt ? Date.parse(this.state.cycleStartedAt) : this.now();
    this.state.lastFullCycleMs = this.now() - started;
    this.state.lastCycleEndedAt = new Date(this.now()).toISOString();
    this.host.log(
      `model verifier: cycle ${this.state.cycle} complete, ${this.state.sweptThisCycle} symbols in ` +
      `${Math.round(this.state.lastFullCycleMs / 60000)} min, ${this.state.mismatchesTotal} mismatch(es) so far`,
    );
    this.state.cursor = { phase: 'functions', key: null };
    this.state.cycleStartedAt = null;
    await this.save();
    return 'cycle-complete';
  }

  private record(outcome: StepOutcome, checked: number, t0: number): void {
    this.lastStep = { at: new Date(this.now()).toISOString(), outcome, checked, ms: this.now() - t0 };
  }

  private mismatch(
    kind: VerifierMismatch['kind'], key: string, name: string, fields: string[], diff: string | undefined,
    source: VerifierMismatch['source'],
  ): VerifierMismatch {
    const m: VerifierMismatch = { at: new Date(this.now()).toISOString(), kind, key, name, fields, diff, applied: 'queued', source };
    this.host.log('#'.repeat(72));
    this.host.log(kind === 'type order'
      ? `MODEL STALE: type order at position ${key.slice(1)}: the model has ${name}, the listing ${fields[0]}`
      : `MODEL STALE: ${kind} ${name} (${key.replace('\u0000', ' in ')}): ${fields.join(', ')} differ from Ghidra`);
    if (diff) for (const line of diff.split('\n')) this.host.log(`  ${line}`);
    this.host.log('#'.repeat(72));
    this.state.mismatchesTotal++;
    this.state.mismatches.push(m);
    while (this.state.mismatches.length > this.cfg.keepMismatches) this.state.mismatches.shift();
    return m;
  }

  private async apply(events: ChangeEvent[], found: VerifierMismatch[]): Promise<void> {
    const names = found.map(m => m.name).slice(0, 5).join(', ');
    try {
      await this.host.applyStale(events, `model verifier: ${found.length} stale (${names}${found.length > 5 ? ', ...' : ''})`);
      for (const m of found) m.applied = 'applied';
    } catch (e) {
      for (const m of found) m.applied = `not applied: ${(e as Error).message}`;
      this.host.log(`model verifier: the update for ${names} did not run (${(e as Error).message})`);
    }
    await this.save();
  }

  /**
   * Check these function addresses now, whatever the daemon is doing (reads only), and
   * send the stale ones through the ordinary update unless `apply` is false.
   */
  async verifyNow(addresses: readonly string[], opts: { apply?: boolean; types?: readonly string[]; globals?: readonly string[] } = {}): Promise<unknown> {
    const run = this.running.then(async () => {
      const keys = addresses.map(addressKey);
      const model = this.host.model();
      const fnChecks = keys.length > 0
        ? await checkFunctions(model, this.host.indices(), this.host.client(), keys, { concurrency: this.cfg.concurrency, log: this.host.log })
        : [];
      const typeKeys = (opts.types ?? []).map(t => {
        if (t.includes('\u0000')) return t;
        const hit = model.primary.dataTypes.find(dt => dt.name === t || `${dt.category === '/' ? '' : dt.category}/${dt.name}` === t);
        return hit ? dataTypeKey(hit.name, hit.category) : t;
      });
      const typeChecks = typeKeys.length > 0
        ? await checkDataTypes(model, this.host.client(), typeKeys, { concurrency: this.cfg.concurrency, log: this.host.log })
        : [];
      const globalChecks = (opts.globals ?? []).length > 0
        ? await checkGlobals(model, this.host.client(), (opts.globals ?? []).map(addressKey), { log: this.host.log })
        : [];
      const events: ChangeEvent[] = [];
      const found: VerifierMismatch[] = [];
      for (const c of globalChecks) {
        if (c.status !== 'mismatch') continue;
        events.push(globalEvent(c));
        found.push(this.mismatch('global', c.key, c.name, c.fields ?? [], undefined, 'verify_now'));
      }
      for (const c of fnChecks) {
        if (c.status !== 'mismatch') continue;
        events.push(functionEvent(c));
        found.push(this.mismatch('function', c.key, c.name, c.fields ?? [], c.diff, 'verify_now'));
      }
      for (const c of typeChecks) {
        if (c.status !== 'mismatch') continue;
        events.push(dataTypeEvent(c));
        found.push(this.mismatch('datatype', c.key, c.name, c.fields ?? [], undefined, 'verify_now'));
      }
      if (opts.apply === false) for (const m of found) m.applied = 'not applied: apply=false';
      await this.save();
      const applying = opts.apply !== false && events.length > 0 ? this.apply(events, found) : null;
      return { functions: fnChecks, datatypes: typeChecks, globals: globalChecks, stale: found.length, applying: applying ? 'queued' : 'nothing to apply', _wait: applying };
    });
    this.running = run.catch(() => {});
    const result = await run;
    // Answer once the reads are in; the update runs on the daemon's queue.
    const { _wait, ...answer } = result;
    void _wait;
    return answer;
  }

  /** For the daemon's `status`: the counters and the last few mismatches. */
  summary(): unknown {
    const full = this.status() as { mismatches: VerifierMismatch[]; config: unknown };
    const { config: _config, ...rest } = full;
    void _config;
    return { ...rest, mismatches: full.mismatches.slice(-5).map(({ diff: _diff, ...m }) => m) };
  }

  status(): unknown {
    return {
      enabled: this.cfg.enabled,
      running: this.stepping,
      cursor: this.state.cursor,
      cycle: this.state.cycle,
      sweptThisCycle: this.state.sweptThisCycle,
      cycleStartedAt: this.state.cycleStartedAt,
      lastFullCycleMs: this.state.lastFullCycleMs,
      lastCycleEndedAt: this.state.lastCycleEndedAt,
      mismatchesTotal: this.state.mismatchesTotal,
      unverifiedTotal: this.state.unverifiedTotal,
      mismatches: this.state.mismatches,
      lastStep: this.lastStep,
      config: this.cfg,
    };
  }
}

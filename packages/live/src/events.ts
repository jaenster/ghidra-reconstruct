/**
 * The change stream: an SSE subscription to the daemon's per-session journal,
 * coalesced into batches the rebuild can act on.
 *
 * Two properties matter more than anything else here.
 *
 * RESUME, NEVER SKIP. Every reconnect resumes from the last seq the consumer
 * actually APPLIED, not the last one received. The daemon replays the backlog
 * before any live event, so a reconnect is indistinguishable from never having
 * disconnected — but only if the number handed back is the applied one. A gap
 * in the journal reads exactly like "nothing changed", which is the failure
 * that produces a confidently wrong tree.
 *
 * COALESCE, NEVER SPLIT. Ghidra flushes change records on a 500 ms timer, so one
 * human edit arrives as several events, and a retype fans out over dozens. A
 * rebuild is ~10 minutes, so rebuilding per event is not merely wasteful — it
 * would rebuild from a half-applied edit. Events are collected until the stream
 * has been quiet for a while, and a rebuild is handed the whole batch.
 */

/**
 * One program change, in the order it happened.
 *
 * Structurally identical to `ChangeEvent` in `@ghidra-mcp/shared/protocol`, and
 * declared here rather than imported because that type lives in the OTHER repo:
 * this package must not take a source dependency across a repo boundary that no
 * build or version constraint enforces. The wire format is the contract, and it
 * is checked at the parse below.
 */
export interface ChangeEvent {
  seq: number;
  mod: number;
  ts: number;
  kind: string;
  target: 'function' | 'global' | 'datatype' | 'program';
  /** Function entry point, global address, or datatype path name. */
  key: string;
  oldName?: string;
  newName?: string;
  txId?: number;
  txDescription?: string;
}

export interface ChangeStreamOptions {
  daemonUrl: string;
  sessionId: string;
  token?: string;
  /**
   * Where to resume. Exclusive: the daemon delivers everything AFTER this.
   * Must be the last seq the consumer applied, never the last one it saw.
   */
  since: number;
  /**
   * Quiet window before a batch is released. 3 s comfortably covers Ghidra's
   * 500 ms flush timer and the several flushes one interactive edit produces,
   * while staying negligible against a ~10 minute rebuild.
   */
  quietMs?: number;
  onBatch: (events: ChangeEvent[]) => Promise<void> | void;
  /**
   * The journal could not cover the gap. The model is now provably behind
   * Ghidra by an unknown amount and nothing incremental can close it.
   */
  onTruncated: (info: { since: number; head: number }) => void;
  log?: (message: string) => void;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class ChangeStream {
  private readonly opts: Required<Pick<ChangeStreamOptions, 'quietMs'>> & ChangeStreamOptions;
  private controller: AbortController | null = null;
  private stopped = false;
  private paused = false;
  /** Highest seq the consumer confirmed applying. The resume point, always. */
  private appliedSeq: number;
  private queue: ChangeEvent[] = [];
  private quietTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private backoffMs = RECONNECT_MIN_MS;
  private connected = false;

  constructor(options: ChangeStreamOptions) {
    this.opts = { quietMs: 3_000, ...options };
    this.appliedSeq = options.since;
  }

  get lastAppliedSeq(): number { return this.appliedSeq; }
  get isPaused(): boolean { return this.paused; }
  get isConnected(): boolean { return this.connected; }
  get queuedCount(): number { return this.queue.length; }

  /**
   * Stop releasing batches. The subscription stays up and events keep queueing,
   * so a pause loses nothing — unpausing releases everything that accumulated.
   */
  pause(): void { this.paused = true; }

  resume(): void {
    this.paused = false;
    this.scheduleDrain();
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /**
   * Connect, consume, reconnect. Never resumes at the live edge: the resume
   * point is `appliedSeq` on every attempt, including the first one after a
   * crash mid-batch, so an event whose batch never completed is redelivered.
   */
  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        // A clean end of stream is the daemon closing the connection, not an
        // error, but it still needs the backoff — reconnecting in a tight loop
        // against a restarting daemon is what turns a blip into an outage.
        this.log('change stream closed by the daemon; reconnecting');
      } catch (e) {
        if (this.stopped) return;
        this.log(`change stream error: ${(e as Error).message}`);
      }
      this.connected = false;
      if (this.stopped) return;
      await delay(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    }
  }

  private async connectOnce(): Promise<void> {
    const url = `${this.opts.daemonUrl.replace(/\/+$/, '')}/changes/${encodeURIComponent(this.opts.sessionId)}`
      + `?since=${this.appliedSeq}`;
    this.controller = new AbortController();

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;

    const response = await fetch(url, { headers, signal: this.controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
    }

    // Only now: a connection that reached the first byte is the evidence that
    // the backoff should reset. Resetting on the attempt instead would hammer a
    // daemon that accepts and immediately refuses.
    this.backoffMs = RECONNECT_MIN_MS;
    this.connected = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. A partial frame stays in the
      // buffer: parsing on chunk boundaries instead would truncate a large
      // event's JSON and lose the change it described.
      let split: number;
      while ((split = indexOfFrameEnd(buffer)) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^(\r?\n){2}/, '');
        this.handleFrame(frame);
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith(':')) continue; // comment / keepalive
      const colon = rawLine.indexOf(':');
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
      const value = colon < 0 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      // `id:` carries the seq, but the seq inside the payload is authoritative
      // and already typed. Reading the id would add a second source of truth
      // for the one number that must never disagree with itself.
    }
    if (dataLines.length === 0) return;

    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      this.log(`change stream: unparseable ${event} frame, ignored`);
      return;
    }

    switch (event) {
      case 'connected':
        this.log(`change stream connected, resuming after seq ${this.appliedSeq}`);
        return;
      case 'truncated': {
        const info = payload as { since?: number; head?: number };
        this.opts.onTruncated({ since: info.since ?? this.appliedSeq, head: info.head ?? 0 });
        return;
      }
      case 'error':
        this.log(`change stream server error: ${JSON.stringify(payload)}`);
        return;
      case 'change': {
        const change = payload as Partial<ChangeEvent>;
        if (typeof change.seq !== 'number' || typeof change.key !== 'string' || !change.target) {
          // The wire contract is the only thing binding this to the other repo.
          // A shape that does not match is a protocol change, and swallowing it
          // would drop real edits without a word.
          this.log(`change stream: event does not match the expected shape, ignored: ${JSON.stringify(payload)}`);
          return;
        }
        if (change.seq <= this.appliedSeq) return; // redelivered across a reconnect
        this.queue.push(change as ChangeEvent);
        this.scheduleDrain();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Restart the quiet window. Every arriving event pushes the release out, so a
   * burst is delivered once, after it stops.
   */
  private scheduleDrain(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => { void this.drain(); }, this.opts.quietMs);
  }

  /**
   * Hand the whole queue to the consumer.
   *
   * `draining` is the guard that makes a rebuild see a WHOLE batch: events that
   * arrive while the callback is running go into a fresh queue and are released
   * as the next batch. A rebuild therefore never observes half of an edit, and
   * never has its input mutated underneath it.
   */
  private async drain(): Promise<void> {
    if (this.draining || this.paused || this.stopped) return;
    if (this.queue.length === 0) return;

    this.draining = true;
    const batch = this.queue;
    this.queue = [];
    try {
      await this.opts.onBatch(batch);
      // Advance ONLY after the consumer returns. A crash mid-batch leaves the
      // resume point where it was, and the batch is redelivered — the model is
      // rebuilt from a state it has actually seen rather than one it assumed.
      this.appliedSeq = Math.max(this.appliedSeq, ...batch.map(e => e.seq));
    } catch (e) {
      this.log(`batch handler failed: ${(e as Error).message}; the batch will be redelivered on reconnect`);
      // Put it back at the front so nothing is lost if the stream stays up.
      this.queue = [...batch, ...this.queue];
    } finally {
      this.draining = false;
    }
    if (this.queue.length > 0) this.scheduleDrain();
  }

  /**
   * Move the resume point forward without a batch — used after a full resync,
   * where the model was rebuilt from scratch and every earlier event is moot.
   */
  markApplied(seq: number): void {
    this.appliedSeq = Math.max(this.appliedSeq, seq);
  }
}

/** Index of the blank line that ends a frame, or -1. Handles CRLF and LF. */
function indexOfFrameEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Can the daemon resume at `seq`, or did it miss changes while it was down?
 *
 * This is the whole value of a sequenced journal over a dirty set: the question is
 * answerable rather than assumed. A restart is safe only when the journal can
 * still serve everything AFTER the last sequence the daemon committed. Three ways
 * that fails, and all three are silent if nobody asks:
 *
 * - the journal rotated past `seq` while the daemon was down, so the events in
 *   between are gone;
 * - the journal was reset (a fresh project directory, or the file removed), which
 *   shows up as a head BELOW the daemon's own sequence;
 * - the first event on offer is not `seq + 1`, meaning a gap in the middle.
 *
 * Resuming through any of them produces a model that is missing changes and a tree
 * that is wrong in a way nothing downstream reports. The answer to all three is a
 * full resync, which is slow and correct.
 */
export interface ResumeCheck {
  resumable: boolean;
  reason: string;
  head: number;
  /** Sequence of the oldest event the journal can still serve, when known. */
  firstAvailable?: number;
}

export async function verifyResume(
  sendCommand: <T>(command: string, params?: Record<string, unknown>) => Promise<T>,
  seq: number,
): Promise<ResumeCheck> {
  let result: { events?: Array<{ seq: number }>; head?: number };
  try {
    result = await sendCommand<{ events?: Array<{ seq: number }>; head?: number }>(
      'get_changes',
      { since: seq, limit: 1 },
    );
  } catch (err) {
    return {
      resumable: false,
      reason: `could not read the change journal: ${err instanceof Error ? err.message : String(err)}`,
      head: -1,
    };
  }

  const head = result.head ?? 0;
  const events = result.events ?? [];

  if (seq === 0) {
    return { resumable: true, reason: 'starting from the beginning of the journal', head };
  }
  if (head < seq) {
    return {
      resumable: false,
      reason:
        `journal head is ${head} but this daemon committed up to ${seq}: the journal ` +
        `was reset, so its sequence numbers no longer refer to the same history`,
      head,
    };
  }
  if (head === seq) {
    return { resumable: true, reason: 'nothing changed while the daemon was down', head };
  }
  if (events.length === 0) {
    return {
      resumable: false,
      reason: `journal head is ${head} but it can serve nothing after ${seq}: the entries in between were rotated away`,
      head,
    };
  }
  if (events[0]!.seq !== seq + 1) {
    return {
      resumable: false,
      reason: `first available event is ${events[0]!.seq}, expected ${seq + 1}: ${events[0]!.seq - seq - 1} change(s) were lost`,
      head,
      firstAvailable: events[0]!.seq,
    };
  }
  return {
    resumable: true,
    reason: `${head - seq} change(s) to catch up on, contiguous from ${seq + 1}`,
    head,
    firstAvailable: events[0]!.seq,
  };
}

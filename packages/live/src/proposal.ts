/**
 * A commit boundary for one approved community proposal.
 *
 * Ordinarily the loop folds whatever arrived into one batch and commits it under
 * the owner's name. A proposal is different: it is one contributor's change,
 * applied to Ghidra as one transaction and checked in as one version, and the
 * regen output of exactly that change has to land as exactly one commit authored
 * by that contributor. Anything else in the commit would be credited to someone
 * who did not write it, and anything of theirs left out would be credited to the
 * owner.
 *
 * The protocol, driven by whoever applies the proposal:
 *
 *   1. `begin`  - before touching Ghidra. Batches stop being released and the
 *                 journal head is recorded. Everything at or below it is "before".
 *   2. the caller applies the proposal in one transaction and checks it in.
 *   3. `commit` - waits for the check-in to show up in the journal, commits the
 *                 "before" events as an ordinary batch, then the window between
 *                 the head recorded in (1) and the check-in, alone, with the
 *                 contributor as author. Batching then resumes.
 *
 * The hold in (1) is what makes isolation possible at all: without it the change
 * stream releases the proposal's events after three quiet seconds and they are
 * folded into an ordinary commit before anyone asks.
 *
 * What it cannot see. The journal does not say who made a change, only which
 * transaction was most recently started when a flush ran (Ghidra flushes on a
 * 500 ms timer). So a second writer on the same session is detected when its
 * edits carry a different transaction, and refused; two writers whose edits land
 * in the same flush are indistinguishable, and that is the residual risk.
 */

import type { ChangeEvent } from './events.js';
import { expandChangedTypes } from './dirty-units.js';
import type { loadBuildInfo } from './dirty-units.js';
import type { ExtractedDataType } from '@ghidra-mcp/reconstruct';

/** Ghidra's transaction name for the metadata write a check-in makes. */
export const CHECKIN_TX = 'Update Metadata';

/** The approver every proposal commit names unless told otherwise. */
export const DEFAULT_APPROVER = 'jaenster';

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export type ProposalErrorCode =
  | 'invalid'          // the request itself is malformed
  | 'busy'             // another proposal holds the boundary
  | 'no-hold'          // commit without begin and without sinceSeq
  | 'timeout'          // the check-in never appeared in the journal
  | 'already-batched'  // part of the window went into an ordinary commit
  | 'mixed'            // the window holds changes that are not provably the proposal's
  | 'gap'              // the journal cannot serve the range contiguously
  | 'nothing-changed'  // the window regenerated to an identical tree
  | 'dirty-tree'       // the regen worktree has changes no commit accounts for
  | 'failed';          // apply, generation or the ordinary commit before it failed

export class ProposalError extends Error {
  override readonly name = 'ProposalError';
  constructor(readonly code: ProposalErrorCode, message: string) {
    super(message);
  }
}

export interface ProposalIdentity {
  /** The proposal number, as `#<id>` in the trailer. */
  proposal: number;
  /** GitHub login of the contributor. */
  login: string;
  /** GitHub numeric user id, for the noreply address. */
  userId: number;
  /** One title line for the subject. Optional. */
  title?: string;
  /** Each becomes one `Reviewed-by:` trailer, in order. */
  reviewedBy?: string[];
  /** The `Approved-by:` trailer. Defaults to the owner. */
  approvedBy?: string;
}

function singleLine(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProposalError('invalid', `'${field}' must be a non-empty string`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new ProposalError('invalid', `'${field}' must be one line`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ProposalError('invalid', `'${field}' is longer than ${max} characters`);
  }
  return trimmed;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProposalError('invalid', `'${field}' must be a positive integer`);
  }
  return value;
}

/** Check a request's identity fields and return them normalised. */
export function parseIdentity(args: Record<string, unknown>): ProposalIdentity {
  const proposal = positiveInt(args.proposal, 'proposal');
  const login = singleLine(args.login, 'login', 39);
  if (!GITHUB_LOGIN.test(login)) {
    throw new ProposalError('invalid', `'login' is not a GitHub login: ${JSON.stringify(login)}`);
  }
  const userId = positiveInt(args.userId, 'userId');

  let reviewedBy: string[] | undefined;
  if (args.reviewedBy !== undefined) {
    const raw = typeof args.reviewedBy === 'string' ? [args.reviewedBy] : args.reviewedBy;
    if (!Array.isArray(raw)) {
      throw new ProposalError('invalid', `'reviewedBy' must be a string or an array of strings`);
    }
    reviewedBy = raw.map((r, i) => singleLine(r, `reviewedBy[${i}]`));
  }

  return {
    proposal,
    login,
    userId,
    title: args.title === undefined ? undefined : singleLine(args.title, 'title'),
    reviewedBy,
    approvedBy: args.approvedBy === undefined ? undefined : singleLine(args.approvedBy, 'approvedBy'),
  };
}

/** `login <id+login@users.noreply.github.com>`, the address GitHub links to the account. */
export function formatAuthor(login: string, userId: number): string {
  return `${login} <${userId}+${login}@users.noreply.github.com>`;
}

/** The `Proposal:` trailer line; also what makes a commit findable again. */
export function proposalTrailer(proposal: number): string {
  return `Proposal: #${proposal}`;
}

export interface MessageContext {
  programPath: string;
  ghidraVersion: number;
  since: number;
  until: number;
}

/**
 * The commit message: a subject, one line of provenance, then the trailers as the
 * final paragraph so `git interpret-trailers` reads them.
 */
export function formatProposalMessage(id: ProposalIdentity, ctx: MessageContext): string {
  const subject = id.title
    ? `regen: proposal #${id.proposal}: ${id.title}`
    : `regen: proposal #${id.proposal} from ${id.login}`;
  const body =
    `${ctx.programPath} v${ctx.ghidraVersion}, change seq ${ctx.since + 1}..${ctx.until}, ` +
    `regenerated on its own.`;
  const trailers = [
    proposalTrailer(id.proposal),
    ...(id.reviewedBy ?? []).map(r => `Reviewed-by: ${r}`),
    `Approved-by: ${id.approvedBy ?? DEFAULT_APPROVER}`,
  ];
  return `${subject}\n\n${body}\n\n${trailers.join('\n')}`;
}

// -----------------------------------------------------------------------------
// The window
// -----------------------------------------------------------------------------

/** The journal entry a check-in writes: a program restore under the metadata transaction. */
export function isCheckinMarker(e: ChangeEvent): boolean {
  return e.kind === 'restored' && e.target === 'program' && e.txDescription === CHECKIN_TX;
}

export interface TransactionSummary {
  txId: number;
  txDescription?: string;
  events: number;
}

export interface IsolationVerdict {
  ok: boolean;
  /** Set when not ok. */
  code?: ProposalErrorCode;
  reason: string;
  /** Events that change the program, i.e. the window minus check-in markers. */
  content: number;
  transactions: TransactionSummary[];
}

/**
 * Can the window be attributed to one proposal?
 *
 * One transaction, or refuse. The proposal is applied as one transaction, so a
 * second transaction id in the window is a second writer (or a proposal applied
 * in pieces, which cannot be told apart from one). Events stamped with the
 * check-in's own transaction are allowed: they are the tail of a flush that
 * landed together with the check-in.
 */
export function checkIsolation(
  window: readonly ChangeEvent[],
  expectTxDescription?: string,
): IsolationVerdict {
  const content = window.filter(e => !isCheckinMarker(e));
  const txs = new Map<number, TransactionSummary>();
  for (const e of content) {
    if (e.txId === undefined || e.txDescription === CHECKIN_TX) continue;
    const t = txs.get(e.txId) ?? { txId: e.txId, txDescription: e.txDescription, events: 0 };
    t.events++;
    txs.set(e.txId, t);
  }
  const transactions = [...txs.values()];
  const no = (code: ProposalErrorCode, reason: string): IsolationVerdict =>
    ({ ok: false, code, reason, content: content.length, transactions });

  if (content.length === 0) {
    return no('nothing-changed', 'the window holds no program change, only the check-in');
  }
  const restore = content.find(e => e.kind === 'restored');
  if (restore) {
    return no('mixed', `seq ${restore.seq} is an undo/redo/rollback; no event says what it changed`);
  }
  const unstamped = content.filter(e => e.txId === undefined);
  if (unstamped.length > 0) {
    return no('mixed',
      `${unstamped.length} event(s) carry no transaction (first: seq ${unstamped[0]!.seq}); ` +
      'they cannot be tied to the proposal');
  }
  if (transactions.length === 0) {
    return no('mixed', 'every event is stamped with the check-in transaction; the proposal\'s own is not visible');
  }
  if (transactions.length > 1) {
    return no('mixed',
      `${transactions.length} transactions in the window ` +
      `(${transactions.map(t => `${t.txId} "${t.txDescription ?? ''}" x${t.events}`).join(', ')}); ` +
      'another writer changed the program between begin and the check-in');
  }
  const only = transactions[0]!;
  if (expectTxDescription !== undefined && only.txDescription !== expectTxDescription) {
    return no('mixed',
      `the window's transaction is "${only.txDescription ?? ''}", expected "${expectTxDescription}"`);
  }
  return {
    ok: true,
    reason: `${content.length} event(s), one transaction (${only.txId} "${only.txDescription ?? ''}")`,
    content: content.length,
    transactions,
  };
}

/**
 * Read `(from, to]` from the journal and prove it is complete.
 *
 * A range with a hole in it would commit a proposal with part of its change
 * missing, and the missing part would then land in the next ordinary commit under
 * the owner's name. So contiguity is checked, not assumed.
 */
export async function readRange(
  journal: JournalReader,
  from: number,
  to: number,
  pageSize = 1000,
): Promise<ChangeEvent[]> {
  const out: ChangeEvent[] = [];
  let cursor = from;
  while (cursor < to) {
    const page = await journal(cursor, pageSize);
    const events = page.events.filter(e => e.seq > cursor && e.seq <= to).sort((a, b) => a.seq - b.seq);
    if (events.length === 0) {
      throw new ProposalError('gap',
        `the journal served nothing after seq ${cursor} (head ${page.head}) while ${to} was expected`);
    }
    for (const e of events) {
      if (e.seq !== cursor + 1) {
        throw new ProposalError('gap', `the journal skips from seq ${cursor} to ${e.seq}`);
      }
      out.push(e);
      cursor = e.seq;
    }
  }
  return out;
}

export type JournalReader = (since: number, limit: number) => Promise<{ events: ChangeEvent[]; head: number }>;

// -----------------------------------------------------------------------------
// Prediction, for the dry run
// -----------------------------------------------------------------------------

type BuildInfo = NonNullable<Awaited<ReturnType<typeof loadBuildInfo>>>;

export interface Prediction {
  units: string[] | null;
  files: string[];
  symbols: string[];
  note: string;
}

/**
 * Which units a set of changed names reaches, by the same owns-or-depends rule
 * the real selection uses, but from the event names rather than from re-extracted
 * hashes. It is a forecast: the real selection runs after the records are
 * re-extracted, and can only be equal or wider (a retype that fans out through
 * containment is followed here too, a cast that moves without a name is not).
 */
export function predictUnits(
  buildInfo: BuildInfo | null,
  names: Iterable<string>,
  typeNames: Iterable<string>,
  dataTypes: ReadonlyArray<ExtractedDataType>,
): Prediction {
  const symbols = [...new Set(names)].filter(Boolean).sort();
  if (!buildInfo?.modules) {
    return { units: null, files: [], symbols, note: 'no buildinfo; a real run would re-emit everything' };
  }
  const changed = new Set<string>([...symbols, ...expandChangedTypes(typeNames, dataTypes)]);
  const hit = buildInfo.modules.filter(m =>
    (m.functionNames ?? []).some(n => changed.has(n)) ||
    (m.ownedTypeNames ?? []).some(n => changed.has(n)) ||
    (m.deps ?? []).some(d => changed.has(d.symbol)));
  return {
    units: [...new Set(hit.map(m => m.unitName))].sort(),
    files: [...new Set(hit.map(m => m.implPath))].sort(),
    symbols,
    note:
      'Forecast from the last generation\'s dependency graph. Aggregate outputs ' +
      '(globals.h/.cpp, the type headers) are regenerated on every run and may also change.',
  };
}

// -----------------------------------------------------------------------------
// The boundary
// -----------------------------------------------------------------------------

export interface PublishOutcome {
  ok: boolean;
  /** True when the events reached the model, whether or not a commit followed. */
  applied: boolean;
  committed: boolean;
  sha?: string;
  reason?: string;
  merge?: unknown;
}

/** What the boundary needs from the loop. `main.ts` implements it; tests fake it. */
export interface BoundaryHost {
  readonly programPath: string;
  journal: JournalReader;
  /** Highest seq whose effect is in the committed tree. */
  committedSeq(): number;
  /** Stop releasing batches (events keep queueing). */
  holdStream(): void;
  /** Undo `holdStream`, leaving an operator's own pause in place. */
  releaseStream(): void;
  /** Run on the loop's work queue, exclusive with every rebuild and merge. */
  exclusive<T>(describe: string, run: () => Promise<T>): Promise<T>;
  /**
   * Apply `events` and run the normal rebuild/commit/merge. `commit` null is an
   * ordinary batch commit; otherwise the message and author to commit with.
   * An empty `events` re-runs only the rebuild (the retry after a failed one).
   */
  publish(events: ChangeEvent[], commit: { message: string; author: string } | null): Promise<PublishOutcome>;
  /** The sha of a commit already carrying this proposal's trailer, if any. */
  existingCommit(proposal: number): Promise<string | null>;
  treeClean(): Promise<boolean>;
  predict(events: ChangeEvent[]): Promise<Prediction>;
  /** Events at or below `seq` must not be applied again by the ordinary path. */
  consumed(seq: number): void;
  log(message: string): void;
}

export interface Hold {
  proposal: number;
  since: number;
  startedAt: string;
  expiresAt: string;
}

export interface CommitRequest {
  identity: ProposalIdentity;
  ghidraVersion: number;
  /** Overrides the hold's start. The caller read the journal head before applying. */
  sinceSeq?: number;
  /** The last seq of the proposal. Default: the first check-in after `since`. */
  untilSeq?: number;
  timeoutMs?: number;
  pollMs?: number;
  expectTxDescription?: string;
  dryRun?: boolean;
}

export interface CommitReport {
  ok: true;
  proposal: number;
  sha: string;
  alreadyCommitted?: boolean;
  /** The ordinary batch commit that landed first, when there were pending events. */
  batchCommit?: string | null;
  window?: { since: number; until: number; events: number };
  transaction?: TransactionSummary;
  merge?: unknown;
}

export interface DryRunReport {
  ok: true;
  dryRun: true;
  proposal: number;
  wouldCommit: boolean;
  reason: string;
  code?: ProposalErrorCode;
  author: string;
  message: string;
  pendingBefore: number;
  window: { since: number; until: number; events: Array<Pick<ChangeEvent, 'seq' | 'kind' | 'target' | 'key' | 'newName' | 'oldName' | 'txId' | 'txDescription'>> };
  transactions: TransactionSummary[];
  predicted: Prediction;
}

const DEFAULT_HOLD_MS = 15 * 60_000;
const MAX_HOLD_MS = 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The state machine behind `proposal_begin`, `proposal_commit` and `proposal_abort`.
 * One proposal at a time: the boundary is a property of the single change stream.
 */
export class ProposalBoundary {
  private hold: (Hold & { timer: NodeJS.Timeout }) | null = null;
  /**
   * A proposal whose events reached the model but whose commit did not land
   * (generation failed). The stream stays held: releasing it would let the next
   * ordinary batch commit the proposal's output under the owner's name.
   */
  private unattributed: { identity: ProposalIdentity; ghidraVersion: number; since: number; until: number } | null = null;

  constructor(private readonly host: BoundaryHost, private readonly now: () => number = Date.now) {}

  /** True while the stream must not be resumed by anyone else. */
  get holding(): boolean {
    return this.hold !== null || this.unattributed !== null;
  }

  /** The proposal whose changes are in the model but not yet committed, if any. */
  get unattributedProposal(): number | null {
    return this.unattributed?.identity.proposal ?? null;
  }

  status(): unknown {
    if (!this.hold && !this.unattributed) return null;
    return {
      hold: this.hold ? { proposal: this.hold.proposal, since: this.hold.since, startedAt: this.hold.startedAt, expiresAt: this.hold.expiresAt } : null,
      unattributed: this.unattributed
        ? { proposal: this.unattributed.identity.proposal, since: this.unattributed.since, until: this.unattributed.until }
        : null,
    };
  }

  async begin(proposal: number, holdMs = DEFAULT_HOLD_MS): Promise<Hold> {
    positiveInt(proposal, 'proposal');
    if (!(holdMs > 0) || holdMs > MAX_HOLD_MS) {
      throw new ProposalError('invalid', `'holdMs' must be in (0, ${MAX_HOLD_MS}]`);
    }
    const other = this.hold?.proposal ?? this.unattributed?.identity.proposal;
    if (other !== undefined && other !== proposal) {
      throw new ProposalError('busy', `proposal #${other} holds the boundary; commit or abort it first`);
    }
    if (this.hold) return this.publicHold();

    // Hold FIRST, then read the head. Any event in a batch already released was
    // in the journal before the head is read, so it is at or below `since` and
    // belongs to the ordinary commit, never to the window.
    this.host.holdStream();
    let head: number;
    try {
      head = (await this.host.journal(this.host.committedSeq(), 1)).head;
    } catch (e) {
      if (!this.unattributed) this.host.releaseStream();
      throw e;
    }
    const startedAt = this.now();
    const expires = startedAt + holdMs;
    const timer = setTimeout(() => this.expire(proposal), holdMs);
    timer.unref?.();
    this.hold = {
      proposal,
      since: head,
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      timer,
    };
    this.host.log(`proposal #${proposal}: holding batches from seq ${head} until ${this.hold.expiresAt}`);
    return this.publicHold();
  }

  abort(proposal: number): { released: boolean; note?: string } {
    positiveInt(proposal, 'proposal');
    let released = false;
    let note: string | undefined;
    if (this.unattributed?.identity.proposal === proposal) {
      note = `the applied changes of #${proposal} (seq ${this.unattributed.since + 1}..` +
        `${this.unattributed.until}) will be committed by the next ordinary batch`;
      this.unattributed = null;
      released = true;
    }
    if (this.hold?.proposal === proposal) {
      clearTimeout(this.hold.timer);
      this.hold = null;
      released = true;
    }
    if (released) {
      this.host.log(`proposal #${proposal}: aborted${note ? `; ${note}` : ''}`);
      if (!this.holding) this.host.releaseStream();
    }
    return { released, note };
  }

  async commit(req: CommitRequest): Promise<CommitReport | DryRunReport> {
    const { identity } = req;
    const ghidraVersion = positiveInt(req.ghidraVersion, 'ghidraVersion');
    const id = identity.proposal;

    const other = this.hold?.proposal ?? this.unattributed?.identity.proposal;
    if (other !== undefined && other !== id) {
      throw new ProposalError('busy', `proposal #${other} holds the boundary`);
    }

    const existing = await this.host.existingCommit(id);
    if (existing) {
      if (!req.dryRun) this.finish(id);
      return { ok: true, proposal: id, sha: existing, alreadyCommitted: true };
    }

    if (this.unattributed && !req.dryRun) return this.retryUnattributed();

    const since = req.sinceSeq ?? this.hold?.since;
    if (since === undefined) {
      throw new ProposalError('no-hold',
        `no proposal_begin for #${id} and no sinceSeq; without a hold the window ` +
        'is batched into an ordinary commit before it can be isolated');
    }
    if (!Number.isSafeInteger(since) || since < 0) throw new ProposalError('invalid', `'sinceSeq' must be >= 0`);

    const until = req.untilSeq ?? await this.waitForCheckin(since, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.pollMs ?? 1000);
    if (!Number.isSafeInteger(until) || until <= since) {
      throw new ProposalError('invalid', `'untilSeq' must be greater than the start of the window (${since})`);
    }

    const window = await readRange(this.host.journal, since, until);
    const verdict = checkIsolation(window, req.expectTxDescription);
    const message = formatProposalMessage(identity, { programPath: this.host.programPath, ghidraVersion, since, until });
    const author = formatAuthor(identity.login, identity.userId);

    if (req.dryRun) {
      const committed = this.host.committedSeq();
      return {
        ok: true,
        dryRun: true,
        proposal: id,
        wouldCommit: verdict.ok && committed <= since,
        reason: committed > since
          ? `the daemon already committed up to seq ${committed}, past the window's start ${since}`
          : verdict.reason,
        code: committed > since ? 'already-batched' : verdict.code,
        author,
        message,
        pendingBefore: Math.max(0, since - committed),
        window: {
          since, until,
          events: window.map(e => ({
            seq: e.seq, kind: e.kind, target: e.target, key: e.key,
            newName: e.newName, oldName: e.oldName, txId: e.txId, txDescription: e.txDescription,
          })),
        },
        transactions: verdict.transactions,
        predicted: await this.host.predict(window),
      };
    }

    if (!verdict.ok) {
      this.finish(id);
      throw new ProposalError(verdict.code ?? 'mixed',
        `proposal #${id} refused: ${verdict.reason}. Nothing was committed for it; ` +
        'its changes go into the next ordinary batch commit.');
    }

    try {
      return await this.host.exclusive(`proposal #${id} (seq ${since + 1}..${until})`, async () => {
        const committed = this.host.committedSeq();
        if (committed > since) {
          throw new ProposalError('already-batched',
            `the daemon already applied up to seq ${committed}, inside the window ${since + 1}..${until}; ` +
            'those changes are in an ordinary commit and cannot be attributed');
        }

        let batchCommit: string | null = null;
        if (committed < since) {
          const before = await readRange(this.host.journal, committed, since);
          this.host.log(`proposal #${id}: committing ${before.length} earlier event(s) as an ordinary batch first`);
          const outcome = await this.host.publish(before, null);
          if (!outcome.ok) {
            throw new ProposalError('failed',
              `the ordinary commit before proposal #${id} failed (${outcome.reason ?? 'unknown'}); nothing attributed`);
          }
          batchCommit = outcome.sha ?? null;
        }
        if (this.host.committedSeq() !== since) {
          throw new ProposalError('failed',
            `after the ordinary batch the daemon is at seq ${this.host.committedSeq()}, expected ${since}`);
        }
        if (!(await this.host.treeClean())) {
          throw new ProposalError('dirty-tree',
            'the regen worktree has uncommitted changes that are not this proposal\'s; refusing to mix them in');
        }

        const outcome = await this.host.publish(window, { message, author });
        if (!outcome.ok) {
          if (outcome.applied) this.unattributed = { identity, ghidraVersion, since, until };
          throw new ProposalError('failed',
            `proposal #${id}: ${outcome.reason ?? 'rebuild failed'}` +
            (outcome.applied
              ? '. Batches stay held; call proposal_commit again to retry, or proposal_abort to give up.'
              : ''));
        }
        this.host.consumed(until);
        if (!outcome.committed) {
          throw new ProposalError('nothing-changed',
            `proposal #${id}: seq ${since + 1}..${until} regenerated to an identical tree; no commit made`);
        }
        this.host.log(`proposal #${id}: committed ${outcome.sha} as ${author}`);
        return {
          ok: true as const,
          proposal: id,
          sha: outcome.sha!,
          batchCommit,
          window: { since, until, events: window.length },
          transaction: verdict.transactions[0],
          merge: outcome.merge,
        };
      });
    } finally {
      this.finish(id);
    }
  }

  private async retryUnattributed(): Promise<CommitReport> {
    const u = this.unattributed!;
    const message = formatProposalMessage(u.identity, {
      programPath: this.host.programPath, ghidraVersion: u.ghidraVersion, since: u.since, until: u.until,
    });
    const author = formatAuthor(u.identity.login, u.identity.userId);
    return this.host.exclusive(`proposal #${u.identity.proposal} retry`, async () => {
      if (!(await this.host.treeClean())) {
        // A failed generation never syncs, so the tree should still be at the last commit.
        throw new ProposalError('dirty-tree', 'the regen worktree has uncommitted changes; refusing to retry over them');
      }
      const outcome = await this.host.publish([], { message, author });
      if (!outcome.ok) {
        throw new ProposalError('failed', `proposal #${u.identity.proposal}: ${outcome.reason ?? 'rebuild failed'} again`);
      }
      this.unattributed = null;
      this.host.consumed(u.until);
      this.finish(u.identity.proposal);
      if (!outcome.committed) {
        throw new ProposalError('nothing-changed', `proposal #${u.identity.proposal}: regenerated to an identical tree`);
      }
      return {
        ok: true as const, proposal: u.identity.proposal, sha: outcome.sha!,
        window: { since: u.since, until: u.until, events: u.until - u.since }, merge: outcome.merge,
      };
    });
  }

  /**
   * The seq of the first check-in after `since`, polling until `timeoutMs`.
   * The hold is kept on a timeout, so the caller can simply ask again.
   */
  private async waitForCheckin(since: number, timeoutMs: number, pollMs: number): Promise<number> {
    const deadline = this.now() + timeoutMs;
    let cursor = since;
    for (;;) {
      const page = await this.host.journal(cursor, 1000);
      const events = page.events.filter(e => e.seq > cursor).sort((a, b) => a.seq - b.seq);
      for (const e of events) {
        if (isCheckinMarker(e)) return e.seq;
        cursor = e.seq;
      }
      if (events.length > 0) continue;   // more pages may be waiting
      if (this.now() >= deadline) {
        throw new ProposalError('timeout',
          `no Ghidra check-in appeared in the journal after seq ${since} within ${timeoutMs} ms ` +
          `(read up to ${cursor}). Batches are still held; retry, pass untilSeq, or proposal_abort.`);
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  private finish(proposal: number): void {
    if (this.hold?.proposal === proposal) {
      clearTimeout(this.hold.timer);
      this.hold = null;
    }
    if (!this.holding) this.host.releaseStream();
  }

  private expire(proposal: number): void {
    if (this.hold?.proposal !== proposal) return;
    this.hold = null;
    if (this.unattributed) {
      this.host.log(`proposal #${proposal}: hold expired, but its applied changes are uncommitted; still holding`);
      return;
    }
    this.host.log(`proposal #${proposal}: hold expired; ordinary batching resumes`);
    this.host.releaseStream();
  }

  private publicHold(): Hold {
    const { proposal, since, startedAt, expiresAt } = this.hold!;
    return { proposal, since, startedAt, expiresAt };
  }
}

/**
 * The proposal boundary end to end against a real git repository.
 *
 * The host is a stand-in for the live loop: "regenerating" an event writes one
 * file per touched key and commits through the real `commitRegen`, on the real
 * work queue. What is under test is the part that decides which events go into
 * which commit and under whose name - that, and that the ordinary commit is
 * byte-for-byte what it was before an author option existed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { commitRegen, isClean, findCommitWithLine } from '../git.js';
import { WorkQueue } from '../queue.js';
import {
  ProposalBoundary,
  ProposalError,
  proposalTrailer,
  predictUnits,
  CHECKIN_TX,
  type BoundaryHost,
  type CommitReport,
  type DryRunReport,
} from '../proposal.js';
import type { ChangeEvent } from '../events.js';

const OWNER = { name: 'Regen Owner', email: 'owner@example.invalid' };

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir }).toString();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-commit-'));
  gitIn(dir, 'init', '-q', '-b', 'source/regen');
  gitIn(dir, 'config', 'user.name', OWNER.name);
  gitIn(dir, 'config', 'user.email', OWNER.email);
  // Keep the owner's global hooks out of a throwaway repository.
  gitIn(dir, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'README'), 'tree\n');
  gitIn(dir, 'add', 'README');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let txCounter = 100;
const edit = (seq: number, key: string, txId: number, txDescription = 'Rename'): ChangeEvent => ({
  seq, mod: seq, ts: seq, kind: 'symbol.renamed', target: 'function', key,
  newName: `Fn_${key}`, txId, txDescription,
});
const checkin = (seq: number): ChangeEvent => ({
  seq, mod: seq, ts: seq, kind: 'restored', target: 'program', key: '*',
  txId: ++txCounter, txDescription: CHECKIN_TX,
});

/** A loop in miniature: a journal, a committed seq, a held-or-not stream, a tree. */
class FakeLoop {
  readonly journal: ChangeEvent[] = [];
  seq = 0;
  held = false;
  holds = 0;
  releases = 0;
  consumedThrough = 0;
  readonly queue = new WorkQueue();
  readonly logs: string[] = [];

  constructor(readonly dir: string) {}

  push(...events: ChangeEvent[]): void { this.journal.push(...events); }

  /** What the change stream would do with a released batch: an ordinary commit. */
  async ordinaryBatch(): Promise<string | undefined> {
    const batch = this.journal.filter(e => e.seq > Math.max(this.seq, this.consumedThrough));
    if (batch.length === 0) return undefined;
    return (await this.regen(batch, null)).sha;
  }

  private async regen(events: ChangeEvent[], commit: { message: string; author: string } | null) {
    mkdirSync(join(this.dir, 'units'), { recursive: true });
    for (const e of events) {
      if (e.target === 'program') continue;
      writeFileSync(join(this.dir, 'units', `${e.key}.cpp`), `// ${e.newName} (seq ${e.seq})\n`);
    }
    if (events.length) this.seq = Math.max(this.seq, ...events.map(e => e.seq));
    const message = commit?.message ?? `regen: batch through seq ${this.seq}`;
    return commit
      ? commitRegen(this.dir, message, { author: commit.author })
      : commitRegen(this.dir, message);
  }

  host(): BoundaryHost {
    return {
      programPath: 'Test/Game.exe',
      journal: async (since, limit) => ({
        events: this.journal.filter(e => e.seq > since).slice(0, limit),
        head: this.journal.length ? this.journal[this.journal.length - 1]!.seq : 0,
      }),
      committedSeq: () => this.seq,
      holdStream: () => { this.held = true; this.holds++; },
      releaseStream: () => { this.held = false; this.releases++; },
      exclusive: (describe, run) => this.queue.submit({ kind: 'proposal', describe, run }),
      publish: async (events, commit) => {
        const c = await this.regen(events, commit);
        return { ok: true, applied: true, committed: c.committed, sha: c.sha };
      },
      existingCommit: p => findCommitWithLine(this.dir, proposalTrailer(p)),
      treeClean: () => isClean(this.dir),
      predict: async events => predictUnits(
        { symbolIndex: {}, symbolHashes: {}, modules: [
          { id: 'u', unitName: 'Unit', implPath: 'units/Unit.cpp', functionNames: events.map(e => e.newName ?? '') },
        ] },
        events.map(e => e.newName ?? ''), [], [],
      ),
      consumed: seq => { this.consumedThrough = Math.max(this.consumedThrough, seq); },
      log: m => { this.logs.push(m); },
    };
  }
}

function log(dir: string): Array<{ sha: string; author: string; committer: string; subject: string; body: string }> {
  const raw = gitIn(dir, 'log', '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%s%x1f%b%x1e');
  return raw.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
    const [sha, author, committer, subject, body] = r.split('\x1f');
    return { sha: sha!, author: author!, committer: committer!, subject: subject!, body: body ?? '' };
  });
}

function changedFiles(dir: string, sha: string): string[] {
  return gitIn(dir, 'show', '--name-only', '--format=', sha).split('\n').filter(Boolean).sort();
}

const identity = { proposal: 42, login: 'octo-cat', userId: 583231, reviewedBy: ['alice'] };
const contributor = 'octo-cat <583231+octo-cat@users.noreply.github.com>';
const owner = `${OWNER.name} <${OWNER.email}>`;

describe('proposal commit boundary', () => {
  let dir: string;
  let loop: FakeLoop;
  let boundary: ProposalBoundary;

  beforeEach(() => {
    dir = initRepo();
    loop = new FakeLoop(dir);
    boundary = new ProposalBoundary(loop.host());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('turns one pending edit and one proposal into two commits with the right authors', async () => {
    // Someone else's edit is waiting in the stream when the proposal starts.
    loop.push(edit(1, 'a', 1));
    const hold = await boundary.begin(42);
    assert.equal(hold.since, 1);
    assert.equal(loop.held, true);

    // The proposal: one transaction, then the check-in.
    loop.push(edit(2, 'b', 2, 'Proposal 42'), edit(3, 'c', 2, 'Proposal 42'), checkin(4));

    const report = await boundary.commit({ identity, ghidraVersion: 1311 }) as CommitReport;
    assert.equal(report.ok, true);
    assert.deepEqual(report.window, { since: 1, until: 4, events: 3 });
    assert.equal(loop.held, false, 'batching resumes after the proposal commit');

    const commits = log(dir);
    assert.equal(commits.length, 3);   // proposal, ordinary batch, init
    const [proposalCommit, batchCommit] = commits;

    assert.equal(batchCommit!.sha, report.batchCommit);
    assert.equal(batchCommit!.author, owner);
    assert.equal(batchCommit!.subject, 'regen: batch through seq 1');
    assert.deepEqual(changedFiles(dir, batchCommit!.sha), ['units/a.cpp']);

    assert.equal(proposalCommit!.sha, report.sha);
    assert.equal(proposalCommit!.author, contributor);
    assert.equal(proposalCommit!.committer, owner, 'the committer stays the owner');
    assert.equal(proposalCommit!.subject, 'regen: proposal #42 from octo-cat');
    assert.deepEqual(changedFiles(dir, proposalCommit!.sha), ['units/b.cpp', 'units/c.cpp']);
    const trailers = gitIn(dir, 'show', '-s', '--format=%(trailers:only,unfold)', proposalCommit!.sha).trim();
    assert.equal(trailers, 'Proposal: #42\nReviewed-by: alice\nApproved-by: jaenster');

    // The stream's copies of seq 2..4 must not be applied a second time.
    assert.equal(loop.consumedThrough, 4);
    assert.equal(await loop.ordinaryBatch(), undefined);
  });

  it('leaves edits after the check-in to the next ordinary commit', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'), checkin(2), edit(3, 'late', 5));
    const report = await boundary.commit({ identity, ghidraVersion: 1311 }) as CommitReport;
    assert.deepEqual(changedFiles(dir, report.sha), ['units/b.cpp']);
    const next = await loop.ordinaryBatch();
    assert.ok(next);
    assert.deepEqual(changedFiles(dir, next!), ['units/late.cpp']);
    assert.equal(log(dir)[0]!.author, owner);
  });

  it('refuses a window with another writer in it and commits nothing for it', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'), edit(2, 'intruder', 3, 'Rename'), checkin(3));
    await assert.rejects(
      () => boundary.commit({ identity, ghidraVersion: 1311 }),
      (e: ProposalError) => e.code === 'mixed' && /2 transactions/.test(e.message),
    );
    assert.equal(log(dir).length, 1, 'no commit at all');
    assert.equal(loop.held, false, 'the hold is released so ordinary batching resumes');
    assert.equal(boundary.holding, false);
  });

  it('refuses when part of the window already went into an ordinary commit', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'), checkin(2));
    await loop.ordinaryBatch();   // e.g. the hold expired and the stream ran
    await assert.rejects(
      () => boundary.commit({ identity, ghidraVersion: 1311 }),
      (e: ProposalError) => e.code === 'already-batched',
    );
    assert.equal(log(dir).filter(c => c.author === contributor).length, 0);
  });

  it('times out without a check-in and keeps holding so the caller can retry', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'));
    await assert.rejects(
      () => boundary.commit({ identity, ghidraVersion: 1311, timeoutMs: 30, pollMs: 5 }),
      (e: ProposalError) => e.code === 'timeout',
    );
    assert.equal(loop.held, true);
    loop.push(checkin(2));
    const report = await boundary.commit({ identity, ghidraVersion: 1311 }) as CommitReport;
    assert.equal(log(dir)[0]!.sha, report.sha);
  });

  it('is idempotent: a retried commit returns the one that landed', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'), checkin(2));
    const first = await boundary.commit({ identity, ghidraVersion: 1311 }) as CommitReport;
    const again = await boundary.commit({ identity, ghidraVersion: 1311 }) as CommitReport;
    assert.equal(again.sha, first.sha);
    assert.equal(again.alreadyCommitted, true);
    assert.equal(log(dir).length, 2);
  });

  it('dry run reports the window and the predicted files and changes nothing', async () => {
    loop.push(edit(1, 'a', 1));
    await boundary.begin(42);
    loop.push(edit(2, 'b', 2, 'Proposal 42'), checkin(3));
    const head = gitIn(dir, 'rev-parse', 'HEAD').trim();

    const dry = await boundary.commit({ identity, ghidraVersion: 1311, dryRun: true }) as DryRunReport;
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldCommit, true, dry.reason);
    assert.equal(dry.pendingBefore, 1);
    assert.equal(dry.author, contributor);
    assert.deepEqual(dry.window.events.map(e => e.seq), [2, 3]);
    assert.deepEqual(dry.predicted.files, ['units/Unit.cpp']);
    assert.match(dry.message, /Proposal: #42/);

    assert.equal(gitIn(dir, 'rev-parse', 'HEAD').trim(), head, 'no commit');
    assert.equal(loop.seq, 0, 'nothing applied');
    assert.equal(loop.held, true, 'the hold survives a dry run');

    const mixed = await boundary.commit({
      identity, ghidraVersion: 1311, dryRun: true, expectTxDescription: 'Nope',
    }) as DryRunReport;
    assert.equal(mixed.wouldCommit, false);
    assert.equal(mixed.code, 'mixed');
  });

  it('allows one proposal at a time', async () => {
    await boundary.begin(42);
    await assert.rejects(() => boundary.begin(43), (e: ProposalError) => e.code === 'busy');
    await assert.rejects(
      () => boundary.commit({ identity: { ...identity, proposal: 43 }, ghidraVersion: 1 }),
      (e: ProposalError) => e.code === 'busy',
    );
    assert.equal(boundary.abort(42).released, true);
    assert.equal(loop.held, false);
    await boundary.begin(43);
  });

  it('refuses a commit with no hold and no explicit start', async () => {
    loop.push(edit(1, 'b', 2), checkin(2));
    await assert.rejects(
      () => boundary.commit({ identity, ghidraVersion: 1 }),
      (e: ProposalError) => e.code === 'no-hold',
    );
    // With an explicit start the caller takes the race on itself, and it is checked.
    const report = await boundary.commit({ identity, ghidraVersion: 1, sinceSeq: 0 }) as CommitReport;
    assert.equal(log(dir)[0]!.sha, report.sha);
  });

  it('refuses to fold uncommitted tree changes into the proposal', async () => {
    await boundary.begin(42);
    loop.push(edit(1, 'b', 2, 'Proposal 42'), checkin(2));
    writeFileSync(join(dir, 'stray.txt'), 'not generated\n');
    await assert.rejects(
      () => boundary.commit({ identity, ghidraVersion: 1311 }),
      (e: ProposalError) => e.code === 'dirty-tree',
    );
    assert.equal(log(dir).length, 1);
  });

  it('releases the stream when the hold expires', async () => {
    await boundary.begin(42, 20);
    assert.equal(loop.held, true);
    await new Promise(r => setTimeout(r, 60));
    assert.equal(loop.held, false);
    assert.equal(boundary.holding, false);
  });
});

describe('the ordinary commit is unchanged', () => {
  /**
   * The same tree, message, identity and clock committed once through
   * `commitRegen` and once through plain `git add -A && git commit -m`, which is
   * what `commitRegen` did before it took an author. Equal shas means equal
   * commit objects, byte for byte.
   */
  it('produces the same commit object as a plain git commit', async () => {
    const a = initRepo();
    const b = initRepo();
    const saved = { ...process.env };
    try {
      process.env.GIT_AUTHOR_DATE = '2026-01-02T00:00:00Z';
      process.env.GIT_COMMITTER_DATE = '2026-01-02T00:00:00Z';
      const env = { ...process.env };
      // Same root commit in both, so the parents match.
      const reset = (d: string) => execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--amend', '-m', 'init', '--date', '2026-01-01T00:00:00Z'], { cwd: d, env });
      reset(a);
      reset(b);
      assert.equal(gitIn(a, 'rev-parse', 'HEAD'), gitIn(b, 'rev-parse', 'HEAD'));

      for (const d of [a, b]) writeFileSync(join(d, 'unit.cpp'), 'int x;\n');
      const message = 'regen: P v1 at change seq 5\n\n3 files generated in 1.0s from the live snapshot.';

      const ours = await commitRegen(a, message);
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: b, env });
      execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', message], { cwd: b, env });

      assert.equal(ours.committed, true);
      assert.equal(ours.sha, gitIn(b, 'rev-parse', 'HEAD').trim());
    } finally {
      process.env = saved;
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('still reports a clean tree as nothing to commit', async () => {
    const d = initRepo();
    try {
      assert.deepEqual(await commitRegen(d, 'nothing'), { committed: false });
      assert.deepEqual(await commitRegen(d, 'nothing', { author: contributor }), { committed: false });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

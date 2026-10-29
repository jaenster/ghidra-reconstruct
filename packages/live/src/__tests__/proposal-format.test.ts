/**
 * The author line and trailers a proposal commit carries, and the rule that
 * decides whether a journal window can be credited to one proposal at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import {
  formatAuthor,
  formatProposalMessage,
  parseIdentity,
  checkIsolation,
  readRange,
  predictUnits,
  isCheckinMarker,
  ProposalError,
  CHECKIN_TX,
} from '../proposal.js';
import type { ChangeEvent } from '../events.js';

const ev = (seq: number, extra: Partial<ChangeEvent> = {}): ChangeEvent => ({
  seq, mod: seq, ts: 0, kind: 'symbol.renamed', target: 'function', key: `00${seq}000`,
  txId: 7, txDescription: 'Proposal 42', ...extra,
});
const checkin = (seq: number): ChangeEvent =>
  ev(seq, { kind: 'restored', target: 'program', key: '*', txId: 9, txDescription: CHECKIN_TX });

describe('author and message', () => {
  it('uses the GitHub noreply address with the numeric id', () => {
    assert.equal(formatAuthor('octo-cat', 583231), 'octo-cat <583231+octo-cat@users.noreply.github.com>');
  });

  it('ends in trailers git itself parses, in order', () => {
    const msg = formatProposalMessage(
      { proposal: 42, login: 'octo-cat', userId: 1, title: 'Name the shrine dispatcher', reviewedBy: ['alice', 'bob'] },
      { programPath: 'Diablo2Lod/windows/lod/1.14d/Game.exe', ghidraVersion: 1311, since: 100, until: 104 },
    );
    assert.equal(msg.split('\n')[0], 'regen: proposal #42: Name the shrine dispatcher');
    assert.match(msg, /v1311, change seq 101\.\.104/);
    const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: msg }).toString();
    assert.equal(parsed, 'Proposal: #42\nReviewed-by: alice\nReviewed-by: bob\nApproved-by: jaenster\n');
  });

  it('omits Reviewed-by when there is no reviewer and keeps the approver default', () => {
    const msg = formatProposalMessage(
      { proposal: 7, login: 'x', userId: 2 },
      { programPath: 'P', ghidraVersion: 3, since: 0, until: 1 },
    );
    assert.equal(msg.split('\n')[0], 'regen: proposal #7 from x');
    const parsed = execFileSync('git', ['interpret-trailers', '--parse'], { input: msg }).toString();
    assert.equal(parsed, 'Proposal: #7\nApproved-by: jaenster\n');
  });

  it('rejects input that would forge a header or a trailer', () => {
    const base = { proposal: 1, login: 'ok', userId: 1 };
    assert.throws(() => parseIdentity({ ...base, login: 'bad login' }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, login: 'x>' }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, login: '-lead' }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, title: 'a\nApproved-by: someone' }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, reviewedBy: ['ok', 'x\ny'] }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, userId: 0 }), ProposalError);
    assert.throws(() => parseIdentity({ ...base, proposal: 1.5 }), ProposalError);
    assert.deepEqual(parseIdentity({ ...base, reviewedBy: 'alice' }).reviewedBy, ['alice']);
  });
});

describe('isolation', () => {
  it('accepts one transaction plus the check-in', () => {
    const v = checkIsolation([ev(1), ev(2), checkin(3)]);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.content, 2);
    assert.deepEqual(v.transactions.map(t => t.txId), [7]);
  });

  it('accepts a tail flushed under the check-in transaction', () => {
    const v = checkIsolation([ev(1), ev(2, { txId: 9, txDescription: CHECKIN_TX }), checkin(3)]);
    assert.equal(v.ok, true, v.reason);
  });

  it('refuses a second writer', () => {
    const v = checkIsolation([ev(1), ev(2, { txId: 8, txDescription: 'Rename' }), checkin(3)]);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'mixed');
    assert.match(v.reason, /2 transactions/);
  });

  it('refuses an undo, an unstamped event and an empty window', () => {
    assert.equal(checkIsolation([ev(1), ev(2, { kind: 'restored', target: 'program', txDescription: 'Undo' }), checkin(3)]).code, 'mixed');
    assert.equal(checkIsolation([ev(1, { txId: undefined, txDescription: undefined }), checkin(2)]).code, 'mixed');
    assert.equal(checkIsolation([checkin(1)]).code, 'nothing-changed');
  });

  it('honours an expected transaction name', () => {
    assert.equal(checkIsolation([ev(1), checkin(2)], 'Proposal 42').ok, true);
    assert.equal(checkIsolation([ev(1), checkin(2)], 'Something else').code, 'mixed');
  });

  it('recognises only the metadata restore as a check-in', () => {
    assert.equal(isCheckinMarker(checkin(1)), true);
    assert.equal(isCheckinMarker(ev(1, { kind: 'restored', target: 'program', txDescription: 'Undo' })), false);
  });
});

describe('readRange', () => {
  const journalOf = (events: ChangeEvent[]) => async (since: number, limit: number) => ({
    events: events.filter(e => e.seq > since).slice(0, limit),
    head: events.length ? events[events.length - 1]!.seq : 0,
  });

  it('pages through a contiguous range', async () => {
    const all = [1, 2, 3, 4, 5].map(n => ev(n));
    const got = await readRange(journalOf(all), 1, 5, 2);
    assert.deepEqual(got.map(e => e.seq), [2, 3, 4, 5]);
  });

  it('refuses a hole', async () => {
    const all = [1, 2, 4, 5].map(n => ev(n));
    await assert.rejects(() => readRange(journalOf(all), 1, 5), (e: ProposalError) => e.code === 'gap');
  });
});

describe('predictUnits', () => {
  it('names the units that own or depend on a changed symbol', () => {
    const buildInfo = {
      symbolIndex: {}, symbolHashes: {},
      modules: [
        { id: 'a', unitName: 'A', implPath: 'src/A.cpp', functionNames: ['ShrineDispatch'], deps: [] },
        { id: 'b', unitName: 'B', implPath: 'src/B.cpp', functionNames: ['Other'], deps: [{ symbol: 'ShrineDispatch', strength: 'call' }] },
        { id: 'c', unitName: 'C', implPath: 'src/C.cpp', functionNames: ['Unrelated'], deps: [] },
      ],
    };
    const p = predictUnits(buildInfo, ['ShrineDispatch'], [], []);
    assert.deepEqual(p.units, ['A', 'B']);
    assert.deepEqual(p.files, ['src/A.cpp', 'src/B.cpp']);
  });

  it('says "everything" without a build graph', () => {
    assert.equal(predictUnits(null, ['x'], [], []).units, null);
  });
});

/**
 * Resuming is only safe when the journal can still serve everything after the
 * daemon's own sequence. These cover the answers that are NOT obvious, and in
 * particular the one that was wrong in production.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { verifyResume } from '../events.js';

const journal = (head: number, events: Array<{ seq: number }> = []) =>
  async <T>(_cmd: string, _params?: Record<string, unknown>): Promise<T> =>
    ({ events, head } as unknown as T);

describe('verifyResume', () => {
  it('resumes a genuinely fresh daemon: seq 0 and nothing on disk', async () => {
    const r = await verifyResume(journal(0), 0, false);
    assert.equal(r.resumable, true);
  });

  it('REFUSES seq 0 when a model is already on disk', async () => {
    // The production failure, 2026-09-04. A worker restart rebuilds the journal
    // empty while live-snapshot survives, so head and seq are both 0 and the old
    // check called that resumable. The daemon then emitted its stale model and
    // committed "v892 at change seq 0" while Ghidra was at v894.
    const r = await verifyResume(journal(0), 0, true);
    assert.equal(r.resumable, false);
    assert.match(r.reason, /persisted model/);
  });

  it('refuses a reset journal: head below the daemon sequence', async () => {
    const r = await verifyResume(journal(3), 40, true);
    assert.equal(r.resumable, false);
    assert.match(r.reason, /reset/);
  });

  it('resumes when nothing changed while it was down', async () => {
    const r = await verifyResume(journal(40), 40, true);
    assert.equal(r.resumable, true);
  });

  it('refuses when the entries after seq were rotated away', async () => {
    const r = await verifyResume(journal(90, []), 40, true);
    assert.equal(r.resumable, false);
    assert.match(r.reason, /rotated/);
  });

  it('refuses when the journal cannot be read at all', async () => {
    const boom = async <T>(): Promise<T> => { throw new Error('no such command'); };
    const r = await verifyResume(boom, 40, true);
    assert.equal(r.resumable, false);
    assert.equal(r.head, -1);
  });
});

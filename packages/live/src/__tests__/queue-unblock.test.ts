/**
 * A blocked queue must be recoverable without restarting the daemon.
 *
 * `block()` had no counterpart in practice: `unblock()` existed but nothing ever
 * called it, so a merge conflict was a one-way door. The daemon then rejected
 * every batch with "daemon is blocked", the change stream redelivered the same
 * batch every three seconds for ever, and the only way out was a restart - three
 * of them in one session, each after the conflict had already been resolved and
 * committed. These pin the contract that makes retry_merge able to work at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WorkQueue } from '../queue.js';

const task = (kind: 'rebuild' | 'merge' | 'apply', run: () => Promise<unknown>) =>
  ({ kind, describe: kind, run }) as never;

describe('WorkQueue blocking', () => {
  it('rejects ordinary work while blocked', async () => {
    const q = new WorkQueue();
    q.block('merge conflict');
    await assert.rejects(
      () => q.submit(task('rebuild', async () => 'ran')),
      /daemon is blocked/,
    );
  });

  it('still admits a merge task while blocked - that is the recovery path', async () => {
    const q = new WorkQueue();
    q.block('merge conflict');
    assert.equal(await q.submit(task('merge', async () => 'merged')), 'merged');
  });

  it('unblock() lets ordinary work run again', async () => {
    const q = new WorkQueue();
    q.block('merge conflict');
    assert.equal(q.isBlocked, true);
    q.unblock();
    assert.equal(q.isBlocked, false);
    assert.equal(await q.submit(task('rebuild', async () => 'ran')), 'ran');
  });

  it('unblock() on a queue that was never blocked is a no-op', () => {
    const q = new WorkQueue();
    q.unblock();
    assert.equal(q.isBlocked, false);
  });
});

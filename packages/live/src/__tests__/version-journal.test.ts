/**
 * The local worker's journal is keyed by Ghidra Server version: seq = version * 1e6 + i.
 * Sequence numbers jump between versions and a version can carry no events at all, so
 * the contiguity rules of the cloud journal must not apply to it, while a server whose
 * history is below the daemon's position must still stop the loop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { verifyResume, PollingChangeStream, SEQ_PER_VERSION, type ChangeEvent } from '../events.js';

const V = (version: number, i = 0) => version * SEQ_PER_VERSION + i;

const versioned = (head: number, version: number, events: Array<{ seq: number }> = []) =>
  async <T>(_cmd: string, _params?: Record<string, unknown>): Promise<T> =>
    ({ events, head, version } as unknown as T);

describe('verifyResume on a version-keyed journal', () => {
  it('resumes across a version jump: the next event is not seq + 1 by design', async () => {
    const r = await verifyResume(versioned(V(1815, 3), 1815, [{ seq: V(1815, 1) }]), V(1813), true);
    assert.equal(r.resumable, true);
  });

  it('resumes when newer versions recorded nothing', async () => {
    const r = await verifyResume(versioned(V(1815), 1815, []), V(1813), true);
    assert.equal(r.resumable, true);
  });

  it('refuses a server whose latest version is below the daemon position', async () => {
    const r = await verifyResume(versioned(V(1810), 1810, []), V(1813, 4), true);
    assert.equal(r.resumable, false);
    assert.match(r.reason, /reset/);
  });
});

function event(seq: number, key: string): ChangeEvent {
  return { seq, mod: 0, ts: 0, kind: 'function.changed', target: 'function', key };
}

describe('PollingChangeStream', () => {
  it('hands a version over as one batch and resumes after its last event', async () => {
    const asked: number[] = [];
    const answers = [
      { events: [event(V(1814, 1), '00401000'), event(V(1814, 2), '00402000')], head: V(1814, 2), version: 1814 },
      { events: [], head: V(1814, 2), version: 1814 },
    ];
    const batches: ChangeEvent[][] = [];
    let done!: () => void;
    const finished = new Promise<void>(r => { done = r; });
    const stream = new PollingChangeStream({
      since: V(1813),
      intervalMs: 1,
      sendCommand: async <T>(_cmd: string, params?: Record<string, unknown>) => {
        asked.push(params!.since as number);
        const a = answers.shift();
        if (!a) { done(); return { events: [], head: V(1814, 2), version: 1814 } as unknown as T; }
        return a as unknown as T;
      },
      onBatch: b => { batches.push(b); },
      onTruncated: () => assert.fail('not truncated'),
    });
    stream.start();
    await finished;
    stream.stop();
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map(e => e.key), ['00401000', '00402000']);
    assert.equal(asked[0], V(1813));
    assert.equal(asked[1], V(1814, 2));
    assert.equal(stream.lastAppliedSeq, V(1814, 2));
  });

  it('moves past a version that recorded nothing', async () => {
    let calls = 0;
    let done!: () => void;
    const finished = new Promise<void>(r => { done = r; });
    const stream = new PollingChangeStream({
      since: V(1813),
      intervalMs: 1,
      sendCommand: async <T>() => {
        if (++calls === 2) done();
        return { events: [], head: V(1815), version: 1815 } as unknown as T;
      },
      onBatch: () => assert.fail('no batch'),
      onTruncated: () => assert.fail('not truncated'),
    });
    stream.start();
    await finished;
    stream.stop();
    assert.equal(stream.lastAppliedSeq, V(1815));
  });

  it('stops and reports when the head falls below its position', async () => {
    let truncated: { since: number; head: number } | null = null;
    let done!: () => void;
    const finished = new Promise<void>(r => { done = r; });
    const stream = new PollingChangeStream({
      since: V(1813, 2),
      intervalMs: 1,
      sendCommand: async <T>() => ({ events: [], head: V(1810), version: 1810 } as unknown as T),
      onBatch: () => assert.fail('no batch'),
      onTruncated: info => { truncated = info; done(); },
    });
    stream.start();
    await finished;
    stream.stop();
    assert.deepEqual(truncated, { since: V(1813, 2), head: V(1810) });
    assert.equal(stream.isPaused, true);
  });

  it('asks again for a batch whose handler failed', async () => {
    const asked: number[] = [];
    let attempts = 0;
    let done!: () => void;
    const finished = new Promise<void>(r => { done = r; });
    const stream = new PollingChangeStream({
      since: V(1813),
      intervalMs: 1,
      sendCommand: async <T>(_cmd: string, params?: Record<string, unknown>) => {
        asked.push(params!.since as number);
        return { events: [event(V(1814, 1), '00401000')], head: V(1814, 1), version: 1814 } as unknown as T;
      },
      onBatch: () => {
        if (++attempts === 1) throw new Error('boom');
        done();
      },
      onTruncated: () => assert.fail('not truncated'),
    });
    stream.start();
    await finished;
    stream.stop();
    assert.deepEqual(asked.slice(0, 2), [V(1813), V(1813)]);
  });
});

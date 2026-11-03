/**
 * A commit to the hand-written sources the generator reads is an input change no
 * Ghidra event reports. The daemon notices it by fingerprint and rebuilds once.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { ForeignSourceWatch, type ForeignWatchHost } from '../foreign-watch.js';

function host(opts: { now?: string; built?: string | null; host?: Partial<ForeignWatchHost> } = {}) {
  const calls: Array<[string | null, string]> = [];
  const state = { now: opts.now ?? 'a', built: opts.built === undefined ? 'a' : opts.built };
  const over = opts.host ?? {};
  const h: ForeignWatchHost = {
    current: () => state.now,
    built: () => state.built,
    idle: () => true,
    rebuild: async (from, to) => { calls.push([from, to]); state.built = to; return 9; },
    log: () => {},
    ...over,
  };
  return { h, calls, state };
}

test('an unchanged fingerprint rebuilds nothing', async () => {
  const { h, calls } = host();
  assert.equal(await new ForeignSourceWatch(h).check(), 'unchanged');
  assert.equal(calls.length, 0);
});

test('a changed fingerprint rebuilds once and records the units it changed', async () => {
  const { h, calls, state } = host();
  const w = new ForeignSourceWatch(h);
  state.now = 'b';
  assert.equal(await w.check(), 'rebuilt');
  assert.deepStrictEqual(calls, [['a', 'b']]);
  assert.equal(w.last?.unitsChanged, 9);
  // The generation recorded 'b': the next poll is quiet.
  assert.equal(await w.check(), 'unchanged');
  assert.equal(calls.length, 1);
});

test('a tree generated before fingerprints were recorded is rebuilt once', async () => {
  const { h, calls } = host({ built: null });
  assert.equal(await new ForeignSourceWatch(h).check(), 'rebuilt');
  assert.deepStrictEqual(calls, [[null, 'a']]);
});

test('nothing is queued while the daemon is busy, blocked or held', async () => {
  const { h, calls, state } = host({ host: { idle: () => false } });
  state.now = 'b';
  assert.equal(await new ForeignSourceWatch(h).check(), 'busy');
  assert.equal(calls.length, 0);
});

test('a failed rebuild is not retried for the same change', async () => {
  let n = 0;
  const { h, state } = host({ host: { rebuild: async () => { n++; throw new Error('generation failed'); } } });
  const w = new ForeignSourceWatch(h);
  state.now = 'b';
  assert.equal(await w.check(), 'failed');
  assert.equal(await w.check(), 'failed');
  assert.equal(n, 1);
  state.now = 'c';
  assert.equal(await w.check(), 'failed');
  assert.equal(n, 2);
});

test('unreadable sources are reported, not treated as a change', async () => {
  const { h, calls } = host({ host: { current: () => { throw new Error('not committed'); } } });
  assert.equal(await new ForeignSourceWatch(h).check(), 'unreadable');
  assert.equal(calls.length, 0);
});

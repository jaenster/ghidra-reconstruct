/**
 * The change poller must survive any failing poll and must notice when it stops
 * completing polls at all: on 2026-11-12 it went silent after a Ghidra Server outage
 * and a check-in went unseen for over an hour.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PollingChangeStream, SEQ_PER_VERSION, type PollClock } from '../events.js';

interface Timer { id: number; at: number; every: number; fn: () => void }

/** A clock that only moves when the test advances it. */
class FakeClock implements PollClock {
  private t = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { return this.add(fn, ms, 0); }
  setInterval(fn: () => void, ms: number): unknown { return this.add(fn, ms, ms); }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter(x => x.id !== h); }
  clearInterval(h: unknown): void { this.clearTimeout(h); }

  private add(fn: () => void, ms: number, every: number): number {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, every, fn });
    return id;
  }

  /** Run every timer due within `ms`, letting the promises each one starts settle. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = due.at;
      if (due.every > 0) due.at += due.every;
      else this.timers = this.timers.filter(x => x !== due);
      due.fn();
      await flush();
    }
    this.t = end;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r));
}

const V = (version: number) => version * SEQ_PER_VERSION;
const empty = { events: [], head: V(2078), version: 2078 };

describe('PollingChangeStream backoff', () => {
  it('keeps polling after errors, doubling the wait up to the cap', async () => {
    const clock = new FakeClock();
    const asked: number[] = [];
    const logs: string[] = [];
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 1_000, maxBackoffMs: 8_000, clock,
      sendCommand: async <T>() => { asked.push(clock.now()); throw new Error('Not connected to repository server'); },
      onBatch: () => assert.fail('no batch'),
      onTruncated: () => assert.fail('not truncated'),
      log: m => logs.push(m),
    });
    stream.start();
    await clock.advance(40_000);
    stream.stop();
    const gaps = asked.slice(1).map((t, i) => t - asked[i]!);
    assert.deepEqual(gaps.slice(0, 6), [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    assert.match(logs[0]!, /^change poller: get_changes every 1000ms \(timeout 600s\); watchdog every 60s restarts the loop after 900s without a completed poll$/);
    assert.match(logs[1]!, /change poll failed \(1 in a row, next try in 1000ms\): Not connected/);
    assert.equal(stream.health.pollsCompleted, 0);
    assert.equal(stream.health.failuresInARow > 0, true);
    assert.equal(stream.loopGeneration, 1, 'failing polls are not a stall');
  });

  it('drops back to the normal interval after a success', async () => {
    const clock = new FakeClock();
    const asked: number[] = [];
    const logs: string[] = [];
    let n = 0;
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 1_000, maxBackoffMs: 60_000, clock,
      sendCommand: async <T>() => {
        asked.push(clock.now());
        if (++n <= 4) throw new Error('No route to host');
        return empty as unknown as T;
      },
      onBatch: () => assert.fail('no batch'),
      onTruncated: () => assert.fail('not truncated'),
      log: m => logs.push(m),
    });
    stream.start();
    await clock.advance(30_000);
    stream.stop();
    const gaps = asked.slice(1).map((t, i) => t - asked[i]!);
    // four failures (1s, 2s, 4s, 8s), then a success and the plain interval again
    assert.deepEqual(gaps.slice(0, 7), [1_000, 2_000, 4_000, 8_000, 1_000, 1_000, 1_000]);
    assert.ok(logs.includes('change poll recovered after 4 failure(s)'));
  });
});

describe('PollingChangeStream watchdog', () => {
  it('times out a hung get_changes and carries on', async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    let n = 0;
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 1_000, pollTimeoutMs: 10_000, stallMs: 60_000, watchdogMs: 5_000, clock,
      sendCommand: <T>() => (++n === 1 ? new Promise<T>(() => {}) : Promise.resolve(empty as unknown as T)),
      onBatch: () => assert.fail('no batch'),
      onTruncated: () => assert.fail('not truncated'),
      log: m => logs.push(m),
    });
    stream.start();
    await clock.advance(20_000);
    stream.stop();
    assert.ok(logs.some(l => /get_changes timed out after 10000ms/.test(l)));
    assert.ok(n > 2);
    assert.equal(stream.loopGeneration, 1);
  });

  it('restarts a loop that stopped completing polls, and the old one never runs again', async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    const calls: Array<{ at: number; inFlight: number }> = [];
    let inFlight = 0;
    let n = 0;
    const batches: number[] = [];
    // The first call never answers and the timeout is out of reach: only the watchdog can
    // end it. Its answer is then released late, to prove the old loop ignores it.
    let releaseHung!: (v: unknown) => void;
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 1_000, pollTimeoutMs: 24 * 3_600_000, stallMs: 5 * 60_000, watchdogMs: 60_000, clock,
      sendCommand: <T>() => {
        calls.push({ at: clock.now(), inFlight });
        if (++n === 1) {
          inFlight++;
          return new Promise<T>(r => { releaseHung = v => { inFlight--; r(v as T); }; });
        }
        return Promise.resolve(empty as unknown as T);
      },
      onBatch: b => { batches.push(b.length); },
      onTruncated: () => assert.fail('not truncated'),
      log: m => logs.push(m),
    });
    stream.start();
    await clock.advance(4 * 60_000);
    assert.equal(calls.length, 1, 'stuck in the first poll');
    assert.equal(stream.loopGeneration, 1);

    await clock.advance(2 * 60_000);
    const alarm = logs.find(l => l.startsWith('ERROR: change poller stalled'));
    assert.ok(alarm, logs.join('\n'));
    assert.match(alarm!, /no get_changes poll completed for 300s \(threshold 300s\)/);
    assert.match(alarm!, /restarting the poll loop \(loop 2\)/);
    assert.equal(stream.loopGeneration, 2);
    const afterRestart = calls.length;
    assert.ok(afterRestart > 1, 'the new loop polls');

    // The hung call answers now with a version the new loop must not be handed twice.
    releaseHung({ events: [{ seq: V(2079) + 1, mod: 0, ts: 0, kind: 'function.changed', target: 'function', key: 'x' }], head: V(2079) + 1, version: 2079 });
    await clock.advance(10_000);
    stream.stop();
    assert.deepEqual(batches, [], 'the abandoned loop applied nothing');
    // One loop: the polls after the restart are the interval apart, never doubled up.
    const later = calls.slice(1).map(c => c.at);
    const gaps = later.slice(1).map((t, i) => t - later[i]!);
    assert.ok(gaps.every(g => g === 1_000), `gaps ${gaps.join(',')}`);
    assert.equal(logs.filter(l => l.startsWith('ERROR: change poller stalled')).length, 1);
  });

  it('does not fire while paused or while a batch is applied', async () => {
    const clock = new FakeClock();
    const logs: string[] = [];
    let n = 0;
    let finishBatch!: () => void;
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 1_000, stallMs: 60_000, watchdogMs: 10_000, clock,
      sendCommand: async <T>() => {
        if (++n === 1) return { events: [{ seq: V(2079) + 1, mod: 0, ts: 0, kind: 'function.changed', target: 'function', key: 'x' }], head: V(2079) + 1, version: 2079 } as unknown as T;
        return { events: [], head: V(2079) + 1, version: 2079 } as unknown as T;
      },
      onBatch: () => new Promise<void>(r => { finishBatch = r; }),
      onTruncated: () => assert.fail('not truncated'),
      log: m => logs.push(m),
    });
    stream.start();
    await clock.advance(5 * 60_000);   // a long rebuild
    finishBatch();
    await clock.advance(5_000);
    stream.pause();
    await clock.advance(5 * 60_000);   // an operator pause
    stream.resume();
    await clock.advance(5_000);
    stream.stop();
    assert.equal(logs.filter(l => l.startsWith('ERROR')).length, 0, logs.join('\n'));
    assert.equal(stream.loopGeneration, 1);
    assert.equal(stream.lastAppliedSeq, V(2079) + 1);
  });
});

describe('PollingChangeStream health', () => {
  it('counts completed polls and their age for the status endpoint', async () => {
    const clock = new FakeClock();
    let up = true;
    const stream = new PollingChangeStream({
      since: V(2078), intervalMs: 2_000, clock,
      sendCommand: async <T>() => { if (!up) throw new Error('Not connected to repository server'); return empty as unknown as T; },
      onBatch: () => assert.fail('no batch'),
      onTruncated: () => assert.fail('not truncated'),
    });
    assert.equal(stream.health.lastPollAt, null);
    stream.start();
    await clock.advance(10_000);
    const h = stream.health;
    assert.ok(h.pollsCompleted >= 5, JSON.stringify(h));
    assert.equal(h.loops, 1);
    assert.equal(h.failuresInARow, 0);
    assert.ok(h.lastPollAgeS !== null && h.lastPollAgeS <= 2, JSON.stringify(h));
    assert.equal(h.stallThresholdS, 900);
    up = false;
    await clock.advance(10_000);
    stream.stop();
    const d = stream.health;
    assert.equal(d.pollsCompleted, h.pollsCompleted, 'a failed poll is not a completed one');
    assert.ok(d.failuresInARow > 0 && d.lastPollAgeS! >= 8, JSON.stringify(d));
    assert.match(d.lastError!, /Not connected/);
  });
});

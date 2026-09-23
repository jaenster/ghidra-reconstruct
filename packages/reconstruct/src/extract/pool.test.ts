/**
 * The windowed extractors must assemble exactly what the one-flight-at-a-time
 * walks assembled, whatever order the daemon answers in. Every test here drives
 * a fake connection that answers after a random delay, so completion order is
 * scrambled, and compares against the order the old code produced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { mapWindowed } from './pool.js';
import { extractDataType, hydrateDataTypeDetails } from './types.js';
import { extractAllGlobals, fetchInitializedData } from './globals.js';
import { extractAllFunctions } from './functions.js';
import type { AnalyzedDataSymbol, ExtractedDataType, GhidraConnection } from '../types.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Deterministic pseudo-random delays, so a failure reproduces. */
function jitter(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % 7;
  };
}

function fakeConnection(
  handler: (command: string, params: Record<string, unknown>) => unknown,
  seed = 1,
  onCall?: (delta: number) => void,
): GhidraConnection {
  const delay = jitter(seed);
  return {
    sessionId: 'test',
    async close() {},
    async sendCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
      onCall?.(1);
      try {
        await sleep(delay());
        return handler(command, params ?? {}) as T;
      } finally {
        onCall?.(-1);
      }
    },
  };
}

describe('mapWindowed', () => {
  it('returns results in input order and never exceeds the window', async () => {
    const items = Array.from({ length: 57 }, (_, i) => i);
    const delay = jitter(7);
    let live = 0;
    let peak = 0;
    const out = await mapWindowed(items, 5, async i => {
      live++;
      peak = Math.max(peak, live);
      await sleep(delay());
      live--;
      return i * 2;
    });
    assert.deepEqual(out, items.map(i => i * 2));
    assert.ok(peak <= 5, `peak ${peak} exceeded the window`);
    assert.ok(peak > 1, 'the window was never used');
  });

  it('handles an empty list and a window wider than the list', async () => {
    assert.deepEqual(await mapWindowed([], 8, async x => x), []);
    assert.deepEqual(await mapWindowed([1, 2], 8, async x => x + 1), [2, 3]);
  });

  it('reports every settlement exactly once', async () => {
    const seen: number[] = [];
    await mapWindowed([1, 2, 3, 4], 2, async x => x, done => seen.push(done));
    assert.deepEqual(seen, [1, 2, 3, 4]);
  });
});

/** The type-detail hydration exactly as it was before the window: flights, applied between flights. */
async function legacyHydrate(connection: GhidraConnection, dataTypes: ExtractedDataType[], batchSize: number) {
  const index = new Map<string, number>();
  for (let i = 0; i < dataTypes.length; i++) index.set(`${dataTypes[i].name}\u0000${dataTypes[i].category}`, i);
  const pending: number[] = [];
  for (let i = 0; i < dataTypes.length; i++) {
    if (['STRUCTURE', 'UNION', 'ENUM', 'TYPEDEF', 'FUNCTION_DEFINITION'].includes(dataTypes[i].kind)) pending.push(i);
  }
  const apply = (slot: number, detail: ExtractedDataType) => {
    dataTypes[index.get(`${detail.name}\u0000${detail.category}`) ?? slot] = detail;
  };
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async slot => {
      const t = dataTypes[slot];
      return { slot, detail: await extractDataType(connection, t.name, t.category) };
    }));
    for (const r of results) apply(r.slot, r.detail);
  }
}

function listing(n: number): ExtractedDataType[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `T${i}`, category: i % 3 === 0 ? '/A' : '/B', kind: 'STRUCTURE', size: 4, fields: [],
  } as unknown as ExtractedDataType));
}

describe('hydrateDataTypeDetails under a window', () => {
  it('matches the flights when every detail lands on its own slot', async () => {
    for (const seed of [1, 2, 3]) {
      const conn = fakeConnection((_c, p) => ({ name: p.name, category: p.category, type: 'Structure', length: 4 }), seed);
      const a = listing(45);
      await hydrateDataTypeDetails(conn, a, { batchSize: 6 });
      assert.deepEqual(a.map(t => `${t.name}${t.category}`), listing(45).map(t => `${t.name}${t.category}`));
    }
  });

  it('matches the flights when a detail resolves to another slot', async () => {
    // T4's detail names T7: it lands on T7's slot before (legacy) or after (window)
    // T7's own fetch is issued. Either way T7 is fetched by the same name and
    // category, and the two details land on slot 7 in pending order.
    const handler = (_c: string, p: Record<string, unknown>) =>
      p.name === 'T4'
        ? { name: 'T7', category: '/B', type: 'Structure', length: 12 }
        : { name: p.name, category: p.category, type: 'Structure', length: 4 };
    for (const [seedA, seedB] of [[9, 11], [3, 4], [5, 1]]) {
      const expected = listing(20);
      await legacyHydrate(fakeConnection(handler, seedA), expected, 3);
      const actual = listing(20);
      await hydrateDataTypeDetails(fakeConnection(handler, seedB), actual, { batchSize: 3 });
      assert.equal(JSON.stringify(actual), JSON.stringify(expected));
      assert.equal(actual[7].size, 4, "T7's own detail lands last, as in the flights");
    }
  });
});

describe('windowed pages keep the one-at-a-time order', () => {
  it('extractAllGlobals splices pages back by offset', async () => {
    const all = Array.from({ length: 1234 }, (_, i) => ({ name: `g${i}`, address: (0x400000 + i * 4).toString(16), dataType: 'int', size: 4 }));
    const conn = fakeConnection((command, p) => {
      if (command === 'list_data_symbols') {
        const off = Number(p.offset), lim = Number(p.limit);
        return { globals: all.slice(off, off + lim), total: all.length };
      }
      if (command === 'list_comments') return { comments: [], total: 0 };
      throw new Error(command);
    }, 5);
    const prev = process.env.GHIDRA_GLOBALS_PAGE_CONCURRENCY;
    process.env.GHIDRA_GLOBALS_PAGE_CONCURRENCY = '4';
    try {
      const got = await extractAllGlobals(conn);
      assert.deepEqual(got.map(g => g.name), all.map(g => g.name));
    } finally {
      if (prev === undefined) delete process.env.GHIDRA_GLOBALS_PAGE_CONCURRENCY;
      else process.env.GHIDRA_GLOBALS_PAGE_CONCURRENCY = prev;
    }
  });

  it('extractAllFunctions splices pages back by offset', async () => {
    const all = Array.from({ length: 777 }, (_, i) => ({
      name: `f${i}`, address: (0x401000 + i * 16).toString(16), signature: `void f${i}(void)`,
      returnType: 'void', parameters: [], localVariables: [],
    }));
    const conn = fakeConnection((command, p) => {
      if (command === 'list_functions') {
        const off = Number(p.offset), lim = Number(p.limit);
        return { functions: all.slice(off, off + lim), total: all.length };
      }
      throw new Error(command);
    }, 6);
    const prev = process.env.GHIDRA_LIST_PAGE_CONCURRENCY;
    process.env.GHIDRA_LIST_PAGE_CONCURRENCY = '3';
    try {
      const got = await extractAllFunctions(conn, { decompile: false });
      assert.deepEqual(got.map(f => f.name), all.map(f => f.name));
    } finally {
      if (prev === undefined) delete process.env.GHIDRA_LIST_PAGE_CONCURRENCY;
      else process.env.GHIDRA_LIST_PAGE_CONCURRENCY = prev;
    }
  });

  it('fetchInitializedData stores each value on its own global', async () => {
    const globals = Array.from({ length: 90 }, (_, i) => ({
      name: `d${i}`, address: (0x700000 + i * 64).toString(16), dataType: 'D2Strc', size: 64,
      isInitialized: true,
    })) as unknown as AnalyzedDataSymbol[];
    let live = 0, peak = 0;
    const conn = fakeConnection(
      (_c, p) => ({ value: { kind: 'bytes', address: p.address } }),
      8,
      d => { live += d; peak = Math.max(peak, live); },
    );
    const prev = process.env.GHIDRA_DATA_CONCURRENCY;
    process.env.GHIDRA_DATA_CONCURRENCY = '7';
    try {
      await fetchInitializedData(conn, globals);
    } finally {
      if (prev === undefined) delete process.env.GHIDRA_DATA_CONCURRENCY;
      else process.env.GHIDRA_DATA_CONCURRENCY = prev;
    }
    for (const g of globals) {
      assert.equal((g.initializedData as unknown as { address: string }).address, g.address);
    }
    assert.ok(peak <= 7 && peak > 1, `peak ${peak}`);
  });
});

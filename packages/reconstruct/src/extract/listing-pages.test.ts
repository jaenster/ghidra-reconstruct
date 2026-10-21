/**
 * The worker's list_namespaces and list_comments answer `total` with the size of
 * the page they return, not of the whole set. A walk that trusts `total` stops at
 * the first full page; these fakes answer exactly as the worker does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractAllNamespaces } from './namespaces.js';
import { extractAllGlobals } from './globals.js';
import { extractAllStrings } from './strings.js';
import type { GhidraConnection } from '../types.js';

/** The size of the whole set, for the listing that reports it. */
const wholeSize = new Map<string, number>();

function pagedAsTheWorker(handler: (command: string, off: number, lim: number) => Record<string, unknown[]> | undefined, unpaged = false): GhidraConnection {
  return {
    sessionId: 'test',
    unpaged,
    async close() {},
    async sendCommand<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
      const res = handler(command, Number(params.offset ?? 0), Number(params.limit ?? 100));
      if (!res) throw new Error(`unexpected ${command}`);
      const [key, rows] = Object.entries(res)[0];
      // list_data_symbols is the one listing whose total is the whole set's.
      return { [key]: rows, total: command === 'list_data_symbols' ? wholeSize.get(command) ?? rows.length : rows.length } as T;
    },
  };
}

describe('listings whose total is the page size', () => {
  it('extractAllNamespaces reads past the first full page', async () => {
    const all = Array.from({ length: 1234 }, (_, i) => ({ name: `N${i}`, fullPath: `M::N${i}`, isClass: i % 2 === 0, functionCount: i }));
    const conn = pagedAsTheWorker((command, off, lim) =>
      command === 'list_namespaces' ? { namespaces: all.slice(off, off + lim) } : undefined);
    const got = await extractAllNamespaces(conn);
    assert.deepEqual(got.map(n => n.fullPath), all.map(n => n.fullPath));
  });

  it('extractAllNamespaces stops on an exact multiple of the page size', async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({ name: `N${i}`, fullPath: `N${i}`, isClass: false, functionCount: 0 }));
    let calls = 0;
    const conn = pagedAsTheWorker((command, off, lim) => {
      calls++;
      return command === 'list_namespaces' ? { namespaces: all.slice(off, off + lim) } : undefined;
    });
    assert.equal((await extractAllNamespaces(conn)).length, 200);
    assert.equal(calls, 3, 'two full pages, then the empty one that ends the walk');
  });

  it('extractAllGlobals joins PLATE comments from every page', async () => {
    const globals = Array.from({ length: 3 }, (_, i) => ({ name: `g${i}`, address: (0x6f0000 + i * 4).toString(16), dataType: 'int', size: 4 }));
    // 1200 function comments first, as on Game.exe, then the ones on the globals.
    const comments = [
      ...Array.from({ length: 1200 }, (_, i) => ({ address: (0x401000 + i * 16).toString(16), comment: `f${i}` })),
      ...globals.map(g => ({ address: g.address, comment: `about ${g.name}` })),
    ];
    const conn = pagedAsTheWorker((command, off, lim) => {
      if (command === 'list_data_symbols') { wholeSize.set(command, globals.length); return { globals: globals.slice(off, off + lim) }; }
      if (command === 'list_comments') return { comments: comments.slice(off, off + lim) };
      if (command === 'execute_script') return undefined;
      return undefined;
    });
    const got = await extractAllGlobals(conn);
    assert.deepEqual(got.map(g => g.comment), globals.map(g => `about ${g.name}`));
  });
});

describe('an unpaged transport', () => {
  // The same fake as above, which slices exactly as the worker does; only the
  // page size differs. Every listing must come back whole from ONE call, with
  // the rows the paged walk assembled, in its order.
  const namespaces = Array.from({ length: 1234 }, (_, i) => ({ name: `N${i}`, fullPath: `M::N${i}`, isClass: false, functionCount: 0 }));
  const strings = Array.from({ length: 2345 }, (_, i) => ({ address: (0x6e0000 + i * 8).toString(16), value: `s${i}`, length: 2 }));
  const globals = Array.from({ length: 3456 }, (_, i) => ({ name: `g${i}`, address: (0x6f0000 + i * 4).toString(16), dataType: 'int', size: 4 }));
  const comments = globals.map(g => ({ address: g.address, comment: `about ${g.name}` }));
  const handler = (calls: Map<string, number>) => (command: string, off: number, lim: number) => {
    calls.set(command, (calls.get(command) ?? 0) + 1);
    if (command === 'list_namespaces') return { namespaces: namespaces.slice(off, off + lim) };
    if (command === 'list_strings') return { strings: strings.slice(off, off + lim) };
    if (command === 'list_data_symbols') { wholeSize.set(command, globals.length); return { globals: globals.slice(off, off + lim) }; }
    if (command === 'list_comments') return { comments: comments.slice(off, off + lim) };
    return undefined;
  };

  it('reads each listing in one call, row for row what the pages gave', async () => {
    const pagedCalls = new Map<string, number>(), oneCalls = new Map<string, number>();
    const paged = pagedAsTheWorker(handler(pagedCalls));
    const whole = pagedAsTheWorker(handler(oneCalls), true);
    assert.deepEqual(await extractAllNamespaces(whole), await extractAllNamespaces(paged));
    assert.deepEqual(await extractAllStrings(whole), await extractAllStrings(paged));
    assert.deepEqual(await extractAllGlobals(whole), await extractAllGlobals(paged));
    for (const c of ['list_namespaces', 'list_strings', 'list_data_symbols', 'list_comments']) {
      assert.equal(oneCalls.get(c), 1, c);
      assert.ok((pagedCalls.get(c) ?? 0) > 1, c);
    }
  });
});

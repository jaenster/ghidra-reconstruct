/**
 * The worker's list_namespaces and list_comments answer `total` with the size of
 * the page they return, not of the whole set. A walk that trusts `total` stops at
 * the first full page; these fakes answer exactly as the worker does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractAllNamespaces } from './namespaces.js';
import { extractAllGlobals } from './globals.js';
import type { GhidraConnection } from '../types.js';

function pagedAsTheWorker(handler: (command: string, off: number, lim: number) => Record<string, unknown[]> | undefined): GhidraConnection {
  return {
    sessionId: 'test',
    async close() {},
    async sendCommand<T>(command: string, params: Record<string, unknown> = {}): Promise<T> {
      const res = handler(command, Number(params.offset ?? 0), Number(params.limit ?? 100));
      if (!res) throw new Error(`unexpected ${command}`);
      const [key, rows] = Object.entries(res)[0];
      return { [key]: rows, total: rows.length } as T;
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
      if (command === 'list_data_symbols') return { globals: globals.slice(off, off + lim) };
      if (command === 'list_comments') return { comments: comments.slice(off, off + lim) };
      if (command === 'execute_script') return undefined;
      return undefined;
    });
    const got = await extractAllGlobals(conn);
    assert.deepEqual(got.map(g => g.comment), globals.map(g => `about ${g.name}`));
  });
});

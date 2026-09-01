/**
 * `extractAllStrings` must not trust `list_strings`' `total` field.
 *
 * The daemon reports `total` as the size of the page it just returned, not the
 * size of the result set — asking for one string answers `total: 1`. Read as an
 * overall count it says "you have them all" after every full page, so the loop
 * terminated after the first 500 and every consumer of the string table saw a
 * truncated view. A short page is the only termination signal that holds
 * regardless of what `total` means.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { extractAllStrings } from '../extract/strings.js';

/** A connection that serves `count` strings, reporting `total` the way the daemon does. */
function fakeConnection(count: number, pageSize = 500) {
  const calls: Array<{ offset: number; limit: number }> = [];
  const connection = {
    async sendCommand(_cmd: string, params: { offset: number; limit: number }) {
      calls.push({ offset: params.offset, limit: params.limit });
      const start = params.offset;
      const end = Math.min(start + params.limit, count);
      const strings = [];
      for (let i = start; i < end; i++) {
        strings.push({ address: (0x600000 + i * 16).toString(16), value: `s${i}`, length: 4 });
      }
      // The daemon's semantics: `total` describes THIS page.
      return { strings, total: strings.length };
    },
  };
  return { connection, calls, pageSize };
}

describe('extractAllStrings pagination', () => {
  it('keeps paging past the first full page', async () => {
    const { connection } = fakeConnection(1200);
    const out = await extractAllStrings(connection as never);
    assert.strictEqual(out.length, 1200, 'must not stop at the first page');
  });

  it('stops on a short page rather than looping forever', async () => {
    const { connection, calls } = fakeConnection(1000);
    const out = await extractAllStrings(connection as never);
    assert.strictEqual(out.length, 1000);
    // 500, 500, then an empty page proves the end.
    assert.strictEqual(calls.length, 3, `expected three requests, got ${calls.length}`);
  });

  it('handles a result set smaller than one page', async () => {
    const { connection, calls } = fakeConnection(7);
    const out = await extractAllStrings(connection as never);
    assert.strictEqual(out.length, 7);
    assert.strictEqual(calls.length, 1);
  });

  it('handles an empty result set', async () => {
    const { connection } = fakeConnection(0);
    const out = await extractAllStrings(connection as never);
    assert.strictEqual(out.length, 0);
  });
});

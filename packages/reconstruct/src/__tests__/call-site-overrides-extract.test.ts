/** The call-site override script's rows land on the functions that own the calls. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { applyCallSiteOverrides } from '../extract/functions.js';
import type { ExtractedFunction } from '../types.js';

describe('applyCallSiteOverrides', () => {
  it('attaches rows by entry address, in call-address order', () => {
    const fns = [{ address: '006bd780' }, { address: '00401000' }] as ExtractedFunction[];
    const n = applyCallSiteOverrides([
      '006bd780\t006be01a\tdt_43fbd679\t6',
      'Game.exe.ram:006bd780\t006bdeeb\tdt_9d1fdd79\t1',
      'garbage',
      '',
    ].join('\n'), fns);
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(fns[0].callSiteOverrides, [
      { callAddress: '006bdeeb', funcdef: 'dt_9d1fdd79', arity: 1 },
      { callAddress: '006be01a', funcdef: 'dt_43fbd679', arity: 6 },
    ]);
    assert.strictEqual(fns[1].callSiteOverrides, undefined);
  });
});

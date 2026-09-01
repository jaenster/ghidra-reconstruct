/**
 * D2's 16-bit char is `uint16_t`, so a wide lookup table is declared
 * `uint16_t Table[256]`. Emitting its elements as CHAR literals makes every code
 * unit >= 0x80 a negative `char`, which cannot narrow into the slot:
 *
 *   globals.cpp:74111: error: narrowing conversion of ''\37777777600''
 *                             from 'char' to 'uint16_t'
 *
 * A char literal only belongs in a char-shaped slot; any wider integer slot takes
 * the numeric code unit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitDataValue } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

const chars = (...cs: string[]): DataValue => ({
  kind: 'array',
  elements: cs.map(c => ({ kind: 'scalar', value: c }) as DataValue),
});

describe('char-valued initializer element in a non-char slot', () => {
  it('emits the numeric code unit for a uint16_t array', () => {
    const out = emitDataValue(chars('A', '', 'ÿ'), 0, 'uint16_t[3]');
    assert.strictEqual(out, '{ 0x41, 0x80, 0xff }');
  });

  it('keeps char literals for a char array', () => {
    const out = emitDataValue(chars('A', 'B'), 0, 'char[2]');
    assert.strictEqual(out, "{ 'A', 'B' }");
  });

  it('keeps the hex escape for a high code unit in a char array', () => {
    const out = emitDataValue(chars(''), 0, 'char[1]');
    assert.strictEqual(out, "{ '\\x80' }");
  });

  it('keeps char literals when the slot type is unknown', () => {
    const out = emitDataValue(chars('A'), 0, undefined);
    assert.strictEqual(out, "{ 'A' }");
  });
});

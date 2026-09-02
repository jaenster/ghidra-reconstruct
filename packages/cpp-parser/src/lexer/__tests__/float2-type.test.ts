/**
 * `float2` is Ghidra's 2-byte float. It reaches the tree only where a function
 * that genuinely returns 16 bits has its result recomposed from a synthetic
 * upper half and cast back down, so what the emitted C++ has to do is carry the
 * low 16 bits and compile. There is no portable 2-byte C++ float on the
 * i686-w64-mingw32 target, so it maps to the 2-byte integer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isGhidraType, getStandardEquivalent, GHIDRA_FLOAT_TYPES } from '../ghidra-types.js';

describe('float2', () => {
  it('was already recognised as a Ghidra type - only the mapping was missing', () => {
    assert.ok(GHIDRA_FLOAT_TYPES.has('float2'));
    assert.ok(isGhidraType('float2'));
  });

  it('maps to a real C++ type instead of returning null', () => {
    assert.strictEqual(getStandardEquivalent('float2'), 'uint16_t');
  });

  it('float10 keeps its own mapping', () => {
    assert.strictEqual(getStandardEquivalent('float10'), 'long double');
    assert.strictEqual(getStandardEquivalent('float8'), 'double');
  });
});

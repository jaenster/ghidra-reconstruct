/**
 * An array object cannot be initialized from a scalar. Ghidra records a single
 * value for a symbol whose type is `T[N]` when only the first element carries
 * data, and the emitter used to write that straight through as
 * `CRITICAL_SECTION g[256] = 0;` — which is not C++ at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { braceArrayInitializer, declaresArrayObject } from '../codegen/globals-header.js';

describe('array initializers are brace-enclosed', () => {
  it('knows which types declare an array object', () => {
    assert.equal(declaresArrayObject('CRITICAL_SECTION[256]'), true);
    assert.equal(declaresArrayObject('undefined1 *[30]'), true);
    assert.equal(declaresArrayObject('char[5][4]'), true);
    // A pointer TO an array is a pointer; `T (*p)[N] = 0` is perfectly legal.
    assert.equal(declaresArrayObject('char[4] *'), false);
    assert.equal(declaresArrayObject('uint32_t'), false);
    assert.equal(declaresArrayObject('D2UnitStrc *'), false);
  });

  it('turns an all-zero array initializer into {}', () => {
    assert.equal(braceArrayInitializer('CRITICAL_SECTION[256]', '0'), '{}');
    assert.equal(braceArrayInitializer('undefined1 *[30]', 'nullptr'), '{}');
  });

  it('keeps a non-zero scalar as the first element', () => {
    assert.equal(braceArrayInitializer('uint32_t[8]', '0x1'), '{ 0x1 }');
  });

  it('leaves a scalar declaration and an existing brace list alone', () => {
    assert.equal(braceArrayInitializer('uint32_t', '0'), '0');
    assert.equal(braceArrayInitializer('uint32_t[4]', '{ 1, 2 }'), '{ 1, 2 }');
  });
});

import { test } from 'node:test';
import assert from 'node:assert';
import { inferType } from '@ghidra-mcp/reconstruct/extract/globals';

/**
 * Codegen prefers `suggestedType`, which is DERIVED from `dataType`. The daemon's
 * incremental path merges a freshly extracted row over the old record, and the
 * derived field is not part of that row - so a type changed in Ghidra kept the old
 * spelling. Retyping a scalar to the array it really is then emitted an array-sized
 * initializer against a scalar declaration, and the loop that clears the array wrote
 * past a four-byte object.
 */
test('an array dataType derives an array suggestedType', () => {
  assert.equal(inferType('uint32_t[2048]'), 'uint32_t[2048]');
  assert.equal(inferType('D2GameStrc *[1025]'), 'D2GameStrc *[1025]');
});

test('a scalar dataType still maps through the builtin table', () => {
  assert.equal(typeof inferType('int'), 'string');
  assert.equal(inferType('D2UIFlagDescStrc *[38]'), 'D2UIFlagDescStrc *[38]');
});

/**
 * Tests for the Array-Cast Assignment plugin.
 *
 * `a = (byte[4])x;` is Ghidra's spelling for a whole-register store into a stack
 * slot modelled as an array. It is not valid C++, so it must become the scalar
 * store the machine code actually performs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { arrayCastAssignPlugin } from '../builtins/array-cast-assign.js';

function transformCode(code: string): string {
  const ast = parse(code);
  const transformer = arrayCastAssignPlugin.createTransformer({});
  return emit(transformer(ast) as AnyNode).trim();
}

describe('array-cast-assign', () => {
  it('rewrites a 4-byte whole-array store into a uint32_t store', () => {
    const out = transformCode('void f(void) { byte a[4]; uint x; a = (byte[4])x; }');
    assert.match(out, /\*\(uint32_t\s*\*\)\(?a\)?\s*=\s*x;/);
    assert.ok(!out.includes('(byte[4])'), 'the array cast must be gone');
  });

  it('handles 1, 2 and 8 byte widths', () => {
    assert.match(transformCode('void f(void) { byte a[1]; uint x; a = (byte[1])x; }'),
                 /\*\(uint8_t\s*\*\)\(?a\)?\s*=\s*x;/);
    assert.match(transformCode('void f(void) { byte a[2]; uint x; a = (byte[2])x; }'),
                 /\*\(uint16_t\s*\*\)\(?a\)?\s*=\s*x;/);
    assert.match(transformCode('void f(void) { byte a[8]; uint x; a = (byte[8])x; }'),
                 /\*\(uint64_t\s*\*\)\(?a\)?\s*=\s*x;/);
  });

  it('uses the element width, not the element count', () => {
    // uint16_t[2] is 4 bytes, so the store is 32-bit.
    assert.match(transformCode('void f(void) { uint16_t a[2]; uint x; a = (uint16_t[2])x; }'),
                 /\*\(uint32_t\s*\*\)\(?a\)?\s*=\s*x;/);
  });

  it('leaves an unsupported width alone rather than guessing', () => {
    // 3 bytes has no scalar store; a wrong width here would corrupt silently,
    // so the compile error is the better outcome.
    const out = transformCode('void f(void) { byte a[3]; uint x; a = (byte[3])x; }');
    assert.ok(out.includes('(byte[3])'), 'unsupported widths must be left unchanged');
  });

  it('leaves ordinary assignments and scalar casts alone', () => {
    assert.match(transformCode('void f(void) { uint x; uint y; x = y; }'), /x\s*=\s*y;/);
    const scalar = transformCode('void f(void) { uint x; int y; x = (uint)y; }');
    assert.ok(scalar.includes('(uint)'), 'a scalar cast must survive');
  });

  it('leaves compound assignment alone', () => {
    const out = transformCode('void f(void) { byte a[4]; uint x; a += (byte[4])x; }');
    assert.ok(out.includes('(byte[4])'));
  });
});

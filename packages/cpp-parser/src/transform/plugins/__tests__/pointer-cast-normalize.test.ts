/**
 * Tests for Pointer Cast Normalize Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pointerCastNormalizePlugin } from '../builtins/pointer-cast-normalize.js';

describe('pointerCastNormalizePlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = pointerCastNormalizePlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('(int)&expr → (uintptr_t)&expr', () => {
    it('should convert (int)&var', () => {
      const input = `void foo() { int x = (int)&y; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(uintptr_t)&y'), `Expected (uintptr_t)&y in: ${output}`);
      assert.ok(!output.includes('(int)&'), `Should not contain (int)& in: ${output}`);
    });

    it('should convert (int)&struct.member', () => {
      const input = `void foo() { int x = (int)&pStruct->field; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(uintptr_t)&'), `Expected (uintptr_t)& in: ${output}`);
    });

    it('should convert (int)&local + offset', () => {
      const input = `void foo() { int x = (int)&local_2c + 4; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(uintptr_t)&local_2c'), `Expected (uintptr_t)&local_2c in: ${output}`);
    });
  });

  describe('(uint32_t)&expr → (uintptr_t)&expr', () => {
    it('should convert (uint32_t)&var', () => {
      const input = `void foo() { uint32_t x = (uint32_t)&y; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(uintptr_t)&y'), `Expected (uintptr_t)&y in: ${output}`);
    });
  });

  describe('(int32_t)&expr → (uintptr_t)&expr', () => {
    it('should convert (int32_t)&var', () => {
      const input = `void foo() { int32_t x = (int32_t)&y; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(uintptr_t)&y'), `Expected (uintptr_t)&y in: ${output}`);
    });
  });

  describe('should NOT convert non-address-of casts', () => {
    it('should NOT convert (int)var (no address-of)', () => {
      const input = `void foo() { int x = (int)ptr; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(int)ptr'), `Should keep (int)ptr in: ${output}`);
    });

    it('should NOT convert (int)(expr)', () => {
      const input = `void foo() { int x = (int)(a + b); }`;
      const output = transformCode(input);
      assert.ok(!output.includes('uintptr_t'), `Should not contain uintptr_t in: ${output}`);
    });

    it('should NOT convert (unsigned int)&var', () => {
      const input = `void foo() { unsigned int x = (unsigned int)&y; }`;
      const output = transformCode(input);
      // unsigned int has modifiers, so it should not match
      assert.ok(!output.includes('uintptr_t'), `Should not convert modified type in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(pointerCastNormalizePlugin.id, 'pointer-cast-normalize');
      assert.strictEqual(pointerCastNormalizePlugin.defaultEnabled, true);
      assert.strictEqual(pointerCastNormalizePlugin.priority, 16);
      assert.ok(pointerCastNormalizePlugin.tags?.includes('portability'));
    });
  });
});

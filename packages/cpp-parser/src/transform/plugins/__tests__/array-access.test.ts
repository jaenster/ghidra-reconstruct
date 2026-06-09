/**
 * Array Access Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { arrayAccessPlugin } from '../builtins/array-access.js';

describe('arrayAccessPlugin', () => {
  const transformer = arrayAccessPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('pointer dereference to subscript', () => {
    it('should transform *(ptr + i) to ptr[i]', () => {
      const code = `void f(int *ptr, int i) { int x = *(ptr + i); }`;
      const result = transform(code);
      assert.ok(result.includes('ptr[i]'), `Expected ptr[i] in: ${result}`);
      assert.ok(!result.includes('*(ptr + i)'), `Should not contain *(ptr + i) in: ${result}`);
    });

    it('should transform *(i + ptr) to ptr[i]', () => {
      const code = `void f(int *ptr, int i) { int x = *(i + ptr); }`;
      const result = transform(code);
      assert.ok(result.includes('ptr[i]'), `Expected ptr[i] in: ${result}`);
    });

    it('should transform *(arr + 0) to arr[0]', () => {
      const code = `void f(int *arr) { int x = *(arr + 0); }`;
      const result = transform(code);
      assert.ok(result.includes('arr[0]'), `Expected arr[0] in: ${result}`);
    });
  });

  describe('cast pointer arithmetic', () => {
    it('should transform *(int*)(param_1 + i) to subscript', () => {
      const code = `void f(void *param_1, int i) { int x = *(int *)(param_1 + i); }`;
      const result = transform(code);
      // Should have subscript notation
      assert.ok(result.includes('[i]'), `Expected [i] in: ${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('should not transform *ptr', () => {
      const code = `void f(int *ptr) { int x = *ptr; }`;
      const result = transform(code);
      assert.ok(result.includes('*ptr'), `Expected *ptr to be preserved in: ${result}`);
    });

    it('should not transform *(ptr - i)', () => {
      // Subtraction is not addition, might have different semantics
      const code = `void f(int *ptr, int i) { int x = *(ptr - i); }`;
      const result = transform(code);
      assert.ok(result.includes('*(ptr - i)'), `Expected *(ptr - i) to be preserved in: ${result}`);
    });
  });

  describe('subscript zero to deref (optional)', () => {
    it('should transform ptr[0] to *ptr when enabled', () => {
      const transformerWithDeref = arrayAccessPlugin.createTransformer({
        subscriptZeroToDeref: true,
      });

      const code = `void f(int *ptr) { int x = ptr[0]; }`;
      const ast = parse(code);
      const transformed = transformerWithDeref(ast);
      const result = emit(transformed as AnyNode).trim();

      assert.ok(result.includes('*ptr'), `Expected *ptr in: ${result}`);
    });

    it('should not transform ptr[0] when disabled (default)', () => {
      const code = `void f(int *ptr) { int x = ptr[0]; }`;
      const result = transform(code);
      assert.ok(result.includes('ptr[0]'), `Expected ptr[0] to be preserved in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(arrayAccessPlugin.id, 'array-access');
      assert.strictEqual(arrayAccessPlugin.defaultEnabled, true);
      assert.ok(arrayAccessPlugin.tags?.includes('core'));
    });
  });
});

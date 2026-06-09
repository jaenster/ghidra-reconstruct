/**
 * Struct Field Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { structFieldPlugin } from '../builtins/struct-field.js';

describe('structFieldPlugin', () => {
  const transformer = structFieldPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('field offset patterns', () => {
    it('should transform *(int*)(ptr + 4) to field access', () => {
      const code = `void f(void *ptr) { int x = *(int *)(ptr + 4); }`;
      const result = transform(code);
      // Should have arrow notation
      assert.ok(result.includes('->'), `Expected -> in: ${result}`);
      // When cast type is int*, produces int_4 (type-aware field name)
      assert.ok(result.includes('int_4'), `Expected int_4 in: ${result}`);
    });

    it('should transform *(long*)(ptr + 8) to field access', () => {
      const code = `void f(void *ptr) { long x = *(long *)(ptr + 8); }`;
      const result = transform(code);
      assert.ok(result.includes('->'), `Expected -> in: ${result}`);
    });

    it('should not transform offset 0 (just a cast)', () => {
      const code = `void f(void *ptr) { int x = *(int *)(ptr + 0); }`;
      const result = transform(code);
      // Offset 0 should not be transformed as it's just a cast
      assert.ok(!result.includes('field_0'), `Should not contain field_0 in: ${result}`);
    });

    it('should generate hex field names', () => {
      const code = `void f(void *ptr) { int x = *(int *)(ptr + 16); }`;
      const result = transform(code);
      // 16 decimal = 10 hex, with int* cast produces int_10
      assert.ok(result.includes('int_10'), `Expected int_10 in: ${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('should not transform non-cast dereference', () => {
      const code = `void f(int *ptr, int i) { int x = *(ptr + i); }`;
      // This should be handled by array-access, not struct-field
      const result = transform(code);
      // Should not have arrow notation from this transform
      assert.ok(!result.match(/->\s*field_/), `Should not contain ->field_ in: ${result}`);
    });

    it('should not transform subtraction', () => {
      const code = `void f(void *ptr) { int x = *(int *)(ptr - 4); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Should not contain -> in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(structFieldPlugin.id, 'struct-field');
      assert.strictEqual(structFieldPlugin.defaultEnabled, true);
      assert.ok(structFieldPlugin.tags?.includes('core'));
    });
  });
});

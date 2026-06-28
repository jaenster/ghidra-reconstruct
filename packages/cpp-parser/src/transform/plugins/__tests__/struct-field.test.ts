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
    // Memberization is valid only when the access lands on a STRUCT pointer.
    // A base already cast to a struct pointer carries that type through.
    it('should memberize a struct-pointer cast base', () => {
      const code = `void f(void *p) { int x = *(int *)((struct S *)p + 4); }`;
      const result = transform(code);
      assert.ok(result.includes('->'), `Expected -> in: ${result}`);
      assert.ok(result.includes('int_4'), `Expected int_4 in: ${result}`);
    });

    it('should generate hex field names for a struct-pointer base', () => {
      const code = `void f(void *p) { int x = *(int *)((struct S *)p + 16); }`;
      const result = transform(code);
      // 16 decimal = 10 hex, int* deref → int_10
      assert.ok(result.includes('int_10'), `Expected int_10 in: ${result}`);
    });

    // A bare scalar-pointer deref must NOT be memberized — `((int *)ptr)->int_4`
    // never compiles (int has no members). The faithful deref is kept.
    it('should NOT memberize a bare int-pointer cast', () => {
      const code = `void f(void *ptr) { int x = *(int *)(ptr + 4); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Scalar ptr must stay a deref: ${result}`);
    });

    it('should NOT memberize a bare long-pointer cast', () => {
      const code = `void f(void *ptr) { long x = *(long *)(ptr + 8); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Scalar ptr must stay a deref: ${result}`);
    });

    it('should not transform offset 0 (just a cast)', () => {
      const code = `void f(void *p) { int x = *(int *)((struct S *)p + 0); }`;
      const result = transform(code);
      assert.ok(!result.includes('field_0'), `Should not contain field_0 in: ${result}`);
      assert.ok(!result.includes('int_0'), `Should not contain int_0 in: ${result}`);
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

    it('should not memberize a computed scalar-pointer-cast base', () => {
      // `(char *)((int)p + n)` is a raw computed pointer, not a struct lvalue.
      // Memberizing would emit `((char *)...)->str_c`, invalid since char has no
      // members. The faithful deref must survive untouched.
      const code = `void f(void *p, int n) { char x = *(char *)((char *)((int)p + n) + 12); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Should leave deref, not char*->member: ${result}`);
    });

    it('should not memberize an (int)-cast (non-pointer) base', () => {
      // `(int)p` is not a pointer at all; `((int)p)->field_4` is "base operand is
      // not a pointer". Leave the deref.
      const code = `void f(void *p) { int x = *(int *)((int)p + 4); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Should not produce int->field: ${result}`);
    });

    it('should not memberize a double-pointer cast', () => {
      // `((T **)p)->field_4` → `->` yields `T *` (still a pointer); `.field_4` on
      // it is "request for member in pointer type". Leave the deref.
      const code = `void f(void *p) { int x = *(int *)((struct S **)p + 4); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Double ptr must stay a deref: ${result}`);
    });

    it('should not memberize a pointer-arithmetic (BinaryExpr) base', () => {
      // The real D2 pattern: base = `(int)tbl + n` (arithmetic), offset 12 split
      // off, then the transform wraps base in the deref cast →
      // `((char *)((int)tbl + n))->str_c`, invalid (char has no str_c). Skip.
      const code = `void f(void *tbl, int n) { char x = *(char *)((int)tbl + n + 12); }`;
      const result = transform(code);
      assert.ok(!result.includes('->'), `Should not produce char*->str_c: ${result}`);
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

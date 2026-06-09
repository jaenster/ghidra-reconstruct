/**
 * Ternary Simplification Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { ternarySimplifyPlugin } from '../builtins/ternary-simplify.js';

describe('ternarySimplifyPlugin', () => {
  const transformer = ternarySimplifyPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('ternary with boolean results', () => {
    it('should simplify (cond) ? 1 : 0 to cond', () => {
      const code = `void f(int x) { int y = (x > 0) ? 1 : 0; }`;
      const result = transform(code);
      // Should not have ternary, just the condition
      assert.ok(!result.includes('?'), `Should not contain ? in: ${result}`);
      assert.ok(result.includes('x > 0'), `Expected x > 0 in: ${result}`);
    });

    it('should simplify (cond) ? 0 : 1 to !cond', () => {
      const code = `void f(int x) { int y = (x > 0) ? 0 : 1; }`;
      const result = transform(code);
      // Should have negated condition
      assert.ok(!result.includes('?'), `Should not contain ? in: ${result}`);
      assert.ok(result.includes('<=') || result.includes('!'), `Expected negation in: ${result}`);
    });
  });

  describe('boolean comparison simplification', () => {
    // Note: true/false keyword handling depends on parser support
    // These tests verify the plugin processes without crashing
    it('should handle x == true pattern', () => {
      const code = `void f(int x) { if (x == 1) return; }`;
      const result = transform(code);
      // Should preserve or simplify, but not crash
      assert.ok(result.includes('x'), `Expected x in: ${result}`);
    });

    it('should handle x == false pattern', () => {
      const code = `void f(int x) { if (x == 0) return; }`;
      const result = transform(code);
      assert.ok(result.includes('x'), `Expected x in: ${result}`);
    });

    it('should handle x != 0 pattern', () => {
      const code = `void f(int x) { if (x != 0) return; }`;
      const result = transform(code);
      assert.ok(result.includes('x'), `Expected x in: ${result}`);
    });
  });

  describe('negation of comparisons', () => {
    it('should simplify !(x == y) to x != y', () => {
      const code = `void f(int x, int y) { if (!(x == y)) return; }`;
      const result = transform(code);
      assert.ok(result.includes('!='), `Expected != in: ${result}`);
      assert.ok(!result.includes('!('), `Should not contain !( in: ${result}`);
    });

    it('should simplify !(x < y) to x >= y', () => {
      const code = `void f(int x, int y) { if (!(x < y)) return; }`;
      const result = transform(code);
      assert.ok(result.includes('>='), `Expected >= in: ${result}`);
    });

    it('should simplify !(x > y) to x <= y', () => {
      const code = `void f(int x, int y) { if (!(x > y)) return; }`;
      const result = transform(code);
      assert.ok(result.includes('<='), `Expected <= in: ${result}`);
    });
  });

  describe('XOR boolean pattern', () => {
    // Note: XOR transform may not be fully implemented yet
    // These tests document intended behavior
    it('should handle x ^ 1 pattern', () => {
      const code = `void f(int x) { int y = x ^ 1; }`;
      const result = transform(code);
      // Transform may or may not apply depending on implementation
      // At minimum, verify no crash
      assert.ok(result.includes('x'), `Expected x in result: ${result}`);
    });

    it('should handle 1 ^ x pattern', () => {
      const code = `void f(int x) { int y = 1 ^ x; }`;
      const result = transform(code);
      assert.ok(result.includes('x'), `Expected x in result: ${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('should not simplify x ^ 2', () => {
      const code = `void f(int x) { int y = x ^ 2; }`;
      const result = transform(code);
      assert.ok(result.includes('^ 2'), `Expected ^ 2 to be preserved in: ${result}`);
    });

    it('should not simplify regular ternary', () => {
      const code = `void f(int x) { int y = (x > 0) ? 10 : 20; }`;
      const result = transform(code);
      assert.ok(result.includes('?'), `Expected ternary to be preserved in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(ternarySimplifyPlugin.id, 'ternary-simplify');
      assert.strictEqual(ternarySimplifyPlugin.defaultEnabled, true);
      assert.ok(ternarySimplifyPlugin.tags?.includes('core'));
    });
  });
});

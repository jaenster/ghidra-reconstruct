/**
 * Tests for CONCAT Macro Transform Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { concatTransformPlugin } from '../builtins/concat-transform.js';

describe('concatTransformPlugin', () => {
  function transformCode(code: string, wrapInParens = true): string {
    const ast = parse(code);
    const transformer = concatTransformPlugin.createTransformer({ wrapInParens });
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('CONCAT31 (3 high bytes, 1 low byte)', () => {
    it('should transform CONCAT31 to bit operations', () => {
      const input = `void foo() { int x = CONCAT31(a, b); }`;
      const output = transformCode(input);
      // Should become: (a << 8) | b
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      assert.ok(output.includes('8'), `Expected shift of 8 in: ${output}`);
      assert.ok(!output.includes('CONCAT31'), `Should not contain CONCAT31 in: ${output}`);
    });

    it('should use correct shift amount for CONCAT31', () => {
      const input = `void foo() { int x = CONCAT31(high, low); }`;
      const output = transformCode(input);
      // 1 low byte = 8 bits shift
      assert.ok(output.includes('<< 8'), `Expected << 8 in: ${output}`);
    });
  });

  describe('CONCAT22 (2 high bytes, 2 low bytes)', () => {
    it('should transform CONCAT22 to bit operations', () => {
      const input = `void foo() { int x = CONCAT22(a, b); }`;
      const output = transformCode(input);
      // Should become: (a << 16) | b
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      assert.ok(output.includes('16'), `Expected shift of 16 in: ${output}`);
      assert.ok(!output.includes('CONCAT22'), `Should not contain CONCAT22 in: ${output}`);
    });
  });

  describe('CONCAT44 (4 high bytes, 4 low bytes)', () => {
    it('should transform CONCAT44 to bit operations', () => {
      const input = `void foo() { long long x = CONCAT44(a, b); }`;
      const output = transformCode(input);
      // Should become: (a << 32) | b
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      assert.ok(output.includes('32'), `Expected shift of 32 in: ${output}`);
      assert.ok(!output.includes('CONCAT44'), `Should not contain CONCAT44 in: ${output}`);
    });
  });

  describe('CONCAT11 (1 high byte, 1 low byte)', () => {
    it('should transform CONCAT11 to bit operations', () => {
      const input = `void foo() { short x = CONCAT11(a, b); }`;
      const output = transformCode(input);
      // Should become: (a << 8) | b
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      assert.ok(output.includes('8'), `Expected shift of 8 in: ${output}`);
      assert.ok(!output.includes('CONCAT11'), `Should not contain CONCAT11 in: ${output}`);
    });
  });

  describe('wrapInParens option', () => {
    it('should wrap result in parentheses by default', () => {
      const input = `void foo() { int x = CONCAT31(a, b); }`;
      const output = transformCode(input, true);
      // The ParenExpr wrapper is transparent in the emitter, but the expression is
      // correct — and both halves carry the cast to the assembled width, without
      // which `a << 8` is computed in whatever width `a` happens to have.
      assert.ok(output.includes('(uint32_t)a << 8 | (uint32_t)b & 0xffu'), `Expected concat result in: ${output}`);
    });

    it('should not wrap when wrapInParens=false', () => {
      const input = `void foo() { int x = CONCAT31(a, b); }`;
      const output = transformCode(input, false);
      // Should have shift and OR but no outer wrapping parens
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      // The expression shouldn't have extra outer parens
      assert.ok(output.includes('(uint32_t)a << 8 | (uint32_t)b & 0xffu'), `Expected unwrapped in: ${output}`);
    });
  });

  describe('non-transformable patterns', () => {
    it('should NOT transform regular function calls', () => {
      const input = `void foo() { int x = someFunction(a, b); }`;
      const output = transformCode(input);
      assert.ok(output.includes('someFunction'), `Should preserve function call in: ${output}`);
    });

    it('should NOT transform CONCAT with wrong argument count', () => {
      const input = `void foo() { int x = CONCAT31(a); }`;
      const output = transformCode(input);
      assert.ok(output.includes('CONCAT31'), `Should preserve CONCAT31 in: ${output}`);
    });

    it('should NOT transform non-CONCAT identifiers', () => {
      const input = `void foo() { int x = CONCATENATE(a, b); }`;
      const output = transformCode(input);
      assert.ok(output.includes('CONCATENATE'), `Should preserve CONCATENATE in: ${output}`);
    });
  });

  describe('complex expressions', () => {
    it('should transform CONCAT with complex arguments', () => {
      const input = `void foo() { int x = CONCAT31((int)high >> 8, ptr[0]); }`;
      const output = transformCode(input);
      assert.ok(output.includes('<<'), `Expected shift in: ${output}`);
      assert.ok(output.includes('|'), `Expected OR in: ${output}`);
      assert.ok(!output.includes('CONCAT31'), `Should not contain CONCAT31 in: ${output}`);
    });

    it('should transform nested CONCAT calls', () => {
      const input = `void foo() { int x = CONCAT22(CONCAT11(a, b), c); }`;
      const output = transformCode(input);
      // Both CONCAT calls should be transformed
      assert.ok(!output.includes('CONCAT'), `Should not contain any CONCAT in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(concatTransformPlugin.id, 'concat-transform');
      assert.strictEqual(concatTransformPlugin.defaultEnabled, true);
      assert.strictEqual(concatTransformPlugin.priority, 20);
      assert.ok(concatTransformPlugin.tags?.includes('cleanup'));
      assert.ok(concatTransformPlugin.tags?.includes('ghidra'));
      assert.ok(concatTransformPlugin.tags?.includes('macros'));
    });
  });
});

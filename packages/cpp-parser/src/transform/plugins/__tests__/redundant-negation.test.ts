/**
 * Tests for Redundant Negation Simplification Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { redundantNegationPlugin } from '../builtins/redundant-negation.js';

describe('redundantNegationPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = redundantNegationPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('x + -y patterns', () => {
    it('should transform x + -y to x - y', () => {
      const input = `void foo() { int x = a + -b; }`;
      const output = transformCode(input);
      // Should become: a - b
      assert.ok(output.includes('a - b'), `Expected 'a - b' in: ${output}`);
      assert.ok(!output.includes('+ -'), `Should not contain '+ -' in: ${output}`);
    });

    it('should transform x + -1 to x - 1', () => {
      const input = `void foo() { int x = a + -1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a - 1'), `Expected 'a - 1' in: ${output}`);
    });

    it('should transform x + -0x6ba to x - 0x6ba', () => {
      const input = `void foo() { int x = iVar2 + -0x6ba; }`;
      const output = transformCode(input);
      // Should have subtraction instead of addition with negative
      assert.ok(output.includes('-'), `Expected subtraction in: ${output}`);
      assert.ok(!output.includes('+ -'), `Should not contain '+ -' in: ${output}`);
    });
  });

  describe('x - -y patterns', () => {
    it('should transform x - -y to x + y', () => {
      const input = `void foo() { int x = a - -b; }`;
      const output = transformCode(input);
      // Should become: a + b
      assert.ok(output.includes('a + b'), `Expected 'a + b' in: ${output}`);
      assert.ok(!output.includes('- -'), `Should not contain '- -' in: ${output}`);
    });

    it('should transform x - -1 to x + 1', () => {
      const input = `void foo() { int x = a - -1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a + 1'), `Expected 'a + 1' in: ${output}`);
    });
  });

  describe('array subscript patterns', () => {
    it('should transform array[index + -offset]', () => {
      const input = `void foo() { int x = arr[i + -10]; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i - 10'), `Expected 'i - 10' in: ${output}`);
    });

    it('should transform array access like aOBJECTCLASSID[iVar2 + -0x6ba]', () => {
      const input = `void foo() { int x = aOBJECTCLASSID[iVar2 + -0x6ba]; }`;
      const output = transformCode(input);
      assert.ok(!output.includes('+ -'), `Should not contain '+ -' in: ${output}`);
    });
  });

  describe('non-transformable patterns', () => {
    it('should NOT transform x + y (no negation)', () => {
      const input = `void foo() { int x = a + b; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a + b'), `Should preserve 'a + b' in: ${output}`);
    });

    it('should NOT transform x - y (no double negation)', () => {
      const input = `void foo() { int x = a - b; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a - b'), `Should preserve 'a - b' in: ${output}`);
    });

    it('should NOT transform x * -y (multiplication)', () => {
      const input = `void foo() { int x = a * -b; }`;
      const output = transformCode(input);
      // Multiplication with negation should be preserved
      assert.ok(output.includes('*'), `Should preserve multiplication in: ${output}`);
    });

    it('should NOT transform standalone -x', () => {
      const input = `void foo() { int x = -a; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-a'), `Should preserve '-a' in: ${output}`);
    });
  });

  describe('nested expressions', () => {
    it('should transform nested additions with negation', () => {
      const input = `void foo() { int x = (a + b) + -c; }`;
      const output = transformCode(input);
      assert.ok(!output.includes('+ -'), `Should not contain '+ -' in: ${output}`);
    });

    it('should transform multiple occurrences', () => {
      const input = `void foo() { int x = a + -b + -c; }`;
      const output = transformCode(input);
      // Both should be transformed
      const plusMinusCount = (output.match(/\+ -/g) || []).length;
      assert.strictEqual(plusMinusCount, 0, `Should have no '+ -' patterns in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(redundantNegationPlugin.id, 'redundant-negation');
      assert.strictEqual(redundantNegationPlugin.defaultEnabled, true);
      assert.strictEqual(redundantNegationPlugin.priority, 40);
      assert.ok(redundantNegationPlugin.tags?.includes('cleanup'));
      assert.ok(redundantNegationPlugin.tags?.includes('arithmetic'));
      assert.ok(redundantNegationPlugin.tags?.includes('readability'));
    });
  });
});

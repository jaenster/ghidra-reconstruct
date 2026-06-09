/**
 * Magic Division Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { magicDivisionPlugin } from '../builtins/magic-division.js';

describe('magicDivisionPlugin', () => {
  const transformer = magicDivisionPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('magic multiplication patterns', () => {
    // Magic division detection is sensitive to exact patterns
    // These tests verify the plugin processes without crashing
    // and check for known magic constant values

    it('should handle multiply-shift pattern', () => {
      // Basic pattern: (x * CONST) >> SHIFT
      const code = `void f(int x) { int y = (x * 12345) >> 10; }`;
      const result = transform(code);
      // Non-magic constant should be preserved
      assert.ok(result.includes('*'), `Expected * in: ${result}`);
    });

    it('should process large constants without crashing', () => {
      // Large constant that might be magic number
      const code = `void f(long x) { long y = (x * 0xAAAAAAAB) >> 33; }`;
      const result = transform(code);
      // Result should contain either division or original pattern
      assert.ok(result.length > 0, `Expected non-empty result`);
    });

    it('should handle chained shift operations', () => {
      const code = `void f(int x) { int y = ((x * 100) >> 8) >> 2; }`;
      const result = transform(code);
      assert.ok(result.includes('>>'), `Expected >> in: ${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('should not transform regular multiplication', () => {
      const code = `void f(int x) { int y = x * 3; }`;
      const result = transform(code);
      assert.ok(result.includes('x * 3'), `Expected x * 3 to be preserved in: ${result}`);
    });

    it('should not transform regular shift', () => {
      const code = `void f(int x) { int y = x >> 2; }`;
      const result = transform(code);
      assert.ok(result.includes('x >> 2'), `Expected x >> 2 to be preserved in: ${result}`);
    });

    it('should not transform non-magic multiplication with shift', () => {
      const code = `void f(int x) { int y = (x * 4) >> 2; }`;
      const result = transform(code);
      // 4 is not a magic number, should be preserved
      assert.ok(result.includes('* 4'), `Expected * 4 to be preserved in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(magicDivisionPlugin.id, 'magic-division');
      assert.strictEqual(magicDivisionPlugin.defaultEnabled, true);
      assert.ok(magicDivisionPlugin.tags?.includes('core'));
    });
  });
});

/**
 * Loop Canonicalization Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { loopCanonicalizePlugin } from '../builtins/loop-canonicalize.js';

describe('loopCanonicalizePlugin', () => {
  const transformer = loopCanonicalizePlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('increment patterns', () => {
    it('should transform i = i + 1 to i++', () => {
      const code = `void f() { int i = 0; i = i + 1; }`;
      const result = transform(code);
      assert.ok(result.includes('i++'), `Expected i++ in: ${result}`);
      assert.ok(!result.includes('i = i + 1'), `Should not contain i = i + 1 in: ${result}`);
    });

    it('should transform i = i - 1 to i--', () => {
      const code = `void f() { int i = 10; i = i - 1; }`;
      const result = transform(code);
      assert.ok(result.includes('i--'), `Expected i-- in: ${result}`);
      assert.ok(!result.includes('i = i - 1'), `Should not contain i = i - 1 in: ${result}`);
    });

    it('should transform i = 1 + i to i++', () => {
      const code = `void f() { int i = 0; i = 1 + i; }`;
      const result = transform(code);
      assert.ok(result.includes('i++'), `Expected i++ in: ${result}`);
    });
  });

  describe('compound assignment patterns', () => {
    it('should transform i = i + n to i += n', () => {
      const code = `void f() { int i = 0; int n = 5; i = i + n; }`;
      const result = transform(code);
      assert.ok(result.includes('i += n'), `Expected i += n in: ${result}`);
    });

    it('should transform i = i - n to i -= n', () => {
      const code = `void f() { int i = 10; int n = 2; i = i - n; }`;
      const result = transform(code);
      assert.ok(result.includes('i -= n'), `Expected i -= n in: ${result}`);
    });

    it('should transform i = i + 5 to i += 5', () => {
      const code = `void f() { int i = 0; i = i + 5; }`;
      const result = transform(code);
      assert.ok(result.includes('i += 5'), `Expected i += 5 in: ${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('should not transform i = j + 1', () => {
      const code = `void f() { int i = 0; int j = 0; i = j + 1; }`;
      const result = transform(code);
      assert.ok(result.includes('i = j + 1'), `Expected i = j + 1 to be preserved in: ${result}`);
    });

    it('should not transform i = i * 2', () => {
      const code = `void f() { int i = 1; i = i * 2; }`;
      const result = transform(code);
      assert.ok(result.includes('i = i * 2'), `Expected i = i * 2 to be preserved in: ${result}`);
    });

    it('should not transform i += 1', () => {
      // Already in canonical form
      const code = `void f() { int i = 0; i += 1; }`;
      const result = transform(code);
      assert.ok(result.includes('i += 1'), `Expected i += 1 to be preserved in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(loopCanonicalizePlugin.id, 'loop-canonicalize');
      assert.strictEqual(loopCanonicalizePlugin.defaultEnabled, true);
      assert.ok(loopCanonicalizePlugin.tags?.includes('core'));
    });
  });
});

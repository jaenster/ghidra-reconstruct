/**
 * Tests for Increment/Decrement Simplification Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { incrementSimplifyPlugin } from '../builtins/increment-simplify.js';

describe('incrementSimplifyPlugin', () => {
  function transformCode(code: string, options = {}): string {
    const ast = parse(code);
    const transformer = incrementSimplifyPlugin.createTransformer(options);
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('increment patterns (x = x + 1 → x++)', () => {
    it('should convert simple variable increment', () => {
      const input = `void foo() { i = i + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i++'), `Expected i++ in: ${output}`);
      assert.ok(!output.includes('i + 1'), `Should not contain i + 1 in: ${output}`);
    });

    it('should convert member access increment', () => {
      const input = `void foo() { obj->count = obj->count + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('obj->count++'), `Expected obj->count++ in: ${output}`);
    });

    it('should convert qualified name increment', () => {
      const input = `void foo() { Draw::LightMap::nSize = Draw::LightMap::nSize + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Draw::LightMap::nSize++'), `Expected qualified name++ in: ${output}`);
    });

    it('should convert array element increment', () => {
      const input = `void foo() { arr[i] = arr[i] + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('arr[i]++'), `Expected arr[i]++ in: ${output}`);
    });
  });

  describe('decrement patterns (x = x - 1 → x--)', () => {
    it('should convert simple variable decrement', () => {
      const input = `void foo() { i = i - 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i--'), `Expected i-- in: ${output}`);
      assert.ok(!output.includes('i - 1'), `Should not contain i - 1 in: ${output}`);
    });

    it('should convert member access decrement', () => {
      const input = `void foo() { obj->count = obj->count - 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('obj->count--'), `Expected obj->count-- in: ${output}`);
    });
  });

  describe('negative one patterns', () => {
    it('should convert x = x + -1 to x--', () => {
      const input = `void foo() { i = i + -1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i--'), `Expected i-- in: ${output}`);
    });

    it('should convert x = x - -1 to x++', () => {
      const input = `void foo() { i = i - -1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i++'), `Expected i++ in: ${output}`);
    });
  });

  describe('compound assignment patterns (x = x op y → x op= y)', () => {
    it('should convert x = x + n to x += n', () => {
      const input = `void foo() { i = i + 5; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i += 5'), `Expected i += 5 in: ${output}`);
    });

    it('should convert x = x - n to x -= n', () => {
      const input = `void foo() { i = i - 10; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i -= 10'), `Expected i -= 10 in: ${output}`);
    });

    it('should convert x = x * n to x *= n', () => {
      const input = `void foo() { i = i * 2; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i *= 2'), `Expected i *= 2 in: ${output}`);
    });

    it('should convert x = x / n to x /= n', () => {
      const input = `void foo() { i = i / 4; }`;
      const output = transformCode(input);
      assert.ok(output.includes('i /= 4'), `Expected i /= 4 in: ${output}`);
    });

    it('should convert x = x & mask to x &= mask', () => {
      const input = `void foo() { flags = flags & 0xff; }`;
      const output = transformCode(input);
      assert.ok(output.includes('flags &= 0xff'), `Expected flags &= 0xff in: ${output}`);
    });

    it('should convert x = x | mask to x |= mask', () => {
      const input = `void foo() { flags = flags | 0x10; }`;
      const output = transformCode(input);
      assert.ok(output.includes('flags |= 0x10'), `Expected flags |= 0x10 in: ${output}`);
    });

    it('should convert x = x ^ mask to x ^= mask', () => {
      const input = `void foo() { flags = flags ^ bit; }`;
      const output = transformCode(input);
      assert.ok(output.includes('flags ^= bit'), `Expected flags ^= bit in: ${output}`);
    });

    it('should convert x = x << n to x <<= n', () => {
      const input = `void foo() { val = val << 2; }`;
      const output = transformCode(input);
      assert.ok(output.includes('val <<= 2'), `Expected val <<= 2 in: ${output}`);
    });

    it('should convert x = x >> n to x >>= n', () => {
      const input = `void foo() { val = val >> 3; }`;
      const output = transformCode(input);
      assert.ok(output.includes('val >>= 3'), `Expected val >>= 3 in: ${output}`);
    });
  });

  describe('non-matching patterns', () => {
    it('should NOT convert x = y + 1 (different variables)', () => {
      const input = `void foo() { x = y + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('x = y + 1'), `Should preserve x = y + 1 in: ${output}`);
      assert.ok(!output.includes('++'), `Should not have ++ in: ${output}`);
    });

    it('should NOT convert already compound assignment', () => {
      const input = `void foo() { x += 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('x += 1'), `Should preserve x += 1 in: ${output}`);
    });

    it('should NOT convert logical operators', () => {
      const input = `void foo() { x = x && y; }`;
      const output = transformCode(input);
      assert.ok(output.includes('x = x && y'), `Should preserve x = x && y in: ${output}`);
    });

    it('should NOT convert comparison operators', () => {
      const input = `void foo() { x = x == y; }`;
      const output = transformCode(input);
      assert.ok(output.includes('x = x == y'), `Should preserve x = x == y in: ${output}`);
    });

    it('should NOT convert Bla::x = Bla::y + 1 (different member)', () => {
      const input = `void foo() { Bla::x = Bla::y + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Bla::y + 1'), `Should preserve different member in: ${output}`);
      assert.ok(!output.includes('++'), `Should not have ++ in: ${output}`);
    });

    it('should NOT convert Foo::x = Bar::x + 1 (different namespace)', () => {
      const input = `void foo() { Foo::x = Bar::x + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Bar::x + 1'), `Should preserve different namespace in: ${output}`);
      assert.ok(!output.includes('++'), `Should not have ++ in: ${output}`);
    });

    it('should NOT convert a->b = a->c + 1 (different member)', () => {
      const input = `void foo() { a->b = a->c + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a->c + 1'), `Should preserve different member in: ${output}`);
      assert.ok(!output.includes('++'), `Should not have ++ in: ${output}`);
    });

    it('should NOT convert arr[i] = arr[j] + 1 (different index)', () => {
      const input = `void foo() { arr[i] = arr[j] + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('arr[j] + 1'), `Should preserve different index in: ${output}`);
      assert.ok(!output.includes('++'), `Should not have ++ in: ${output}`);
    });
  });

  describe('complex qualified names (AST-based comparison)', () => {
    it('should convert Bla::x = Bla::x + 1', () => {
      const input = `void foo() { Bla::x = Bla::x + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Bla::x++'), `Expected Bla::x++ in: ${output}`);
    });

    it('should convert deeply nested namespace Bla::Foo::x = Bla::Foo::x + 1', () => {
      const input = `void foo() { Bla::Foo::x = Bla::Foo::x + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Bla::Foo::x++'), `Expected Bla::Foo::x++ in: ${output}`);
    });

    it('should convert global ::var = ::var + 1', () => {
      const input = `void foo() { ::global = ::global + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('::global++'), `Expected ::global++ in: ${output}`);
    });

    it('should convert chained member a->b->c = a->b->c + 1', () => {
      const input = `void foo() { a->b->c = a->b->c + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('a->b->c++'), `Expected a->b->c++ in: ${output}`);
    });

    it('should convert multi-dimensional arr[i][j] = arr[i][j] + 1', () => {
      const input = `void foo() { arr[i][j] = arr[i][j] + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('arr[i][j]++'), `Expected arr[i][j]++ in: ${output}`);
    });

    it('should convert deref pointer (*ptr)->val = (*ptr)->val + 1', () => {
      const input = `void foo() { (*ptr)->val = (*ptr)->val + 1; }`;
      const output = transformCode(input);
      assert.ok(output.includes('(*ptr)->val++'), `Expected (*ptr)->val++ in: ${output}`);
    });

    it('should convert qualified compound Ns::Class::m = Ns::Class::m * 2', () => {
      const input = `void foo() { Ns::Class::m = Ns::Class::m * 2; }`;
      const output = transformCode(input);
      assert.ok(output.includes('Ns::Class::m *= 2'), `Expected Ns::Class::m *= 2 in: ${output}`);
    });
  });

  describe('simpleOnly option', () => {
    it('should convert member access when simpleOnly=false', () => {
      const input = `void foo() { obj->val = obj->val + 1; }`;
      const output = transformCode(input, { simpleOnly: false });
      assert.ok(output.includes('obj->val++'), `Expected obj->val++ in: ${output}`);
    });

    it('should NOT convert member access when simpleOnly=true', () => {
      const input = `void foo() { obj->val = obj->val + 1; }`;
      const output = transformCode(input, { simpleOnly: true });
      assert.ok(output.includes('obj->val = obj->val + 1'), `Should preserve when simpleOnly in: ${output}`);
    });
  });

  describe('usePostfix option', () => {
    it('should use compound when usePostfix=false', () => {
      const input = `void foo() { i = i + 1; }`;
      const output = transformCode(input, { usePostfix: false });
      assert.ok(output.includes('i += 1'), `Expected i += 1 when usePostfix=false in: ${output}`);
      assert.ok(!output.includes('i++'), `Should not have i++ when usePostfix=false in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(incrementSimplifyPlugin.id, 'increment-simplify');
      assert.strictEqual(incrementSimplifyPlugin.defaultEnabled, true);
      assert.strictEqual(incrementSimplifyPlugin.priority, 35);
      assert.ok(incrementSimplifyPlugin.tags?.includes('cleanup'));
      assert.ok(incrementSimplifyPlugin.tags?.includes('readability'));
    });
  });
});

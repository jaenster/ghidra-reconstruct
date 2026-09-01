/**
 * Tests for Signed Literal Cleanup Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { signedLiteralPlugin } from '../builtins/signed-literal.js';

describe('signedLiteralPlugin', () => {
  function transformCode(code: string, onlyKnown = false): string {
    const ast = parse(code);
    const transformer = signedLiteralPlugin.createTransformer({ onlyKnownValues: onlyKnown });
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe("Ghidra's double negative on a constant", () => {
    it('rewrites --2147483648 to a single negation', () => {
      const output = transformCode('void foo() { int x = --2147483648; }');
      assert.ok(!output.includes('--'), `should not keep the double negative: ${output}`);
      assert.ok(output.includes('-2147483648'), output);
    });

    it('rewrites --0x80000000 to the same value', () => {
      const output = transformCode('void foo() { int x = --0x80000000; }');
      assert.ok(!output.includes('--'), `should not keep the double negative: ${output}`);
      assert.ok(output.includes('-2147483648'), output);
    });

    it('rewrites a double negative the hardcoded pair never covered', () => {
      // The predecessor was two literal string replacements, so `--0x100` and
      // every other magnitude fell straight through.
      const output = transformCode('void foo() { int x = --256; }');
      assert.ok(!output.includes('--'), `should not keep the double negative: ${output}`);
      assert.ok(output.includes('-256'), output);
    });

    it('leaves a real pre-decrement of a variable alone', () => {
      const output = transformCode('void foo() { --nCount; }');
      assert.ok(output.includes('--nCount'), output);
    });

    it('leaves the same characters inside a string literal alone', () => {
      const output = transformCode('void foo() { Log("value --2147483648 seen"); }');
      assert.ok(output.includes('"value --2147483648 seen"'), output);
    });
  });

  describe('32-bit negative values', () => {
    it('should convert 0xffffffff to -1', () => {
      const input = `void foo() { int x = 0xffffffff; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-1'), `Expected -1 in: ${output}`);
      assert.ok(!output.includes('0xffffffff'), `Should not contain hex in: ${output}`);
    });

    it('should convert 0xfffffffe to -2', () => {
      const input = `void foo() { int x = 0xfffffffe; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-2'), `Expected -2 in: ${output}`);
    });

    it('should convert 0x80000000 to -2147483648', () => {
      const input = `void foo() { int x = 0x80000000; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-2147483648'), `Expected INT_MIN value in: ${output}`);
    });

    it('should convert other negative values in range', () => {
      const input = `void foo() { int x = 0xfffffff0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-16'), `Expected -16 in: ${output}`);
    });
  });

  describe('64-bit negative values', () => {
    it('should convert 0xffffffffffffffff to -1', () => {
      const input = `void foo() { long x = 0xffffffffffffffff; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-1'), `Expected -1 in: ${output}`);
    });

    it('should convert 0xfffffffffffffffe to -2', () => {
      const input = `void foo() { long x = 0xfffffffffffffffe; }`;
      const output = transformCode(input);
      assert.ok(output.includes('-2'), `Expected -2 in: ${output}`);
    });
  });

  describe('comparison context', () => {
    it('should convert in equality comparison', () => {
      const input = `void foo(int nMessageIndex) { if (nMessageIndex == 0xffffffff) { return; } }`;
      const output = transformCode(input);
      assert.ok(output.includes('== -1'), `Expected == -1 in: ${output}`);
    });

    it('should convert in inequality comparison', () => {
      const input = `void foo(int result) { if (result != 0xffffffff) { process(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('!= -1'), `Expected != -1 in: ${output}`);
    });
  });

  describe('return statements', () => {
    it('should convert in return statement', () => {
      const input = `int getError() { return 0xffffffff; }`;
      const output = transformCode(input);
      assert.ok(output.includes('return -1'), `Expected return -1 in: ${output}`);
    });
  });

  describe('non-convertible patterns', () => {
    it('should NOT convert small values', () => {
      const input = `void foo() { int x = 0x100; }`;
      const output = transformCode(input);
      assert.ok(!output.includes('-'), `Should not contain negative in: ${output}`);
      assert.ok(output.includes('0x100') || output.includes('256'), `Should contain original value in: ${output}`);
    });

    it('should NOT convert mid-range values', () => {
      const input = `void foo() { int x = 0x7fffffff; }`;
      const output = transformCode(input);
      // INT_MAX should not be converted to negative
      assert.ok(!output.includes('-'), `Should not contain negative in: ${output}`);
    });
  });

  describe('onlyKnownValues option', () => {
    it('should convert known values when onlyKnownValues=true', () => {
      const input = `void foo() { int x = 0xffffffff; }`;
      const output = transformCode(input, true);
      assert.ok(output.includes('-1'), `Expected -1 in: ${output}`);
    });

    it('should NOT convert unknown values when onlyKnownValues=true', () => {
      const input = `void foo() { int x = 0xfffffeff; }`;  // -257, not in known list
      const output = transformCode(input, true);
      // Should keep hex since it's not in the known values map
      assert.ok(output.includes('0xfffffeff'), `Should keep hex when not known: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(signedLiteralPlugin.id, 'signed-literal');
      assert.strictEqual(signedLiteralPlugin.defaultEnabled, true);
      assert.strictEqual(signedLiteralPlugin.priority, 30);
      assert.ok(signedLiteralPlugin.tags?.includes('cleanup'));
      assert.ok(signedLiteralPlugin.tags?.includes('readability'));
    });
  });
});

/**
 * Tests for Function Pointer Literal Resolution Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrLiteralPlugin, type FuncPtrLiteralOptions } from '../builtins/func-ptr-literal.js';

describe('funcPtrLiteralPlugin', () => {
  function transformCode(code: string, addressMap: Map<bigint, string>): string {
    const ast = parse(code);
    const opts: FuncPtrLiteralOptions = { functionAddressMap: addressMap };
    const transformer = funcPtrLiteralPlugin.createTransformer(opts);
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  const testMap = new Map<bigint, string>([
    [0x5011f0n, 'D2WINBUTTON_HandleFormMouseEvent'],
    [0xcd40n, 'SBMP_ValidateTGAHeader'],
    [0x1ad80n, 'SNET_InsertConnectionNode'],
    [0x400100n, 'SomeFunc'],
  ]);

  describe('valid function pointer replacements', () => {
    it('should replace literal in assignment', () => {
      const input = `void foo() { int fpCallback = 0x5011f0; }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('D2WINBUTTON_HandleFormMouseEvent'), `Expected func name in: ${output}`);
      assert.ok(!output.includes('0x5011f0'), `Should not contain hex in: ${output}`);
    });

    it('should replace literal in ternary', () => {
      const input = `void foo(int cond) { int fp = cond ? 0x5011f0 : 0; }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('D2WINBUTTON_HandleFormMouseEvent'), `Expected func name in: ${output}`);
    });

    it('should replace literal in equality comparison', () => {
      const input = `void foo(int x) { if (x == 0x5011f0) { return; } }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('D2WINBUTTON_HandleFormMouseEvent'), `Expected func name in: ${output}`);
    });

    it('should replace literal in return statement', () => {
      const input = `int foo() { return 0x400100; }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('SomeFunc'), `Expected func name in: ${output}`);
    });
  });

  describe('arithmetic false positive prevention', () => {
    it('should NOT replace literal used as addition offset', () => {
      const input = `void foo(int pPalette) { int x = pPalette + 0xcd40; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SBMP_ValidateTGAHeader'), `Should NOT replace arithmetic operand in: ${output}`);
      assert.ok(output.includes('0xcd40'), `Should keep hex literal in: ${output}`);
    });

    it('should NOT replace literal used as subtraction offset', () => {
      const input = `void foo(int base) { int x = base - 0x1ad80; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SNET_InsertConnectionNode'), `Should NOT replace arithmetic operand in: ${output}`);
      assert.ok(output.includes('0x1ad80'), `Should keep hex literal in: ${output}`);
    });

    it('should NOT replace literal on left side of addition', () => {
      const input = `void foo(int offset) { int x = 0xcd40 + offset; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SBMP_ValidateTGAHeader'), `Should NOT replace left arithmetic operand in: ${output}`);
    });

    it('should NOT replace literal in bitwise AND', () => {
      const input = `void foo(int flags) { int x = flags & 0xcd40; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SBMP_ValidateTGAHeader'), `Should NOT replace bitwise operand in: ${output}`);
    });

    it('should NOT replace literal in multiplication', () => {
      const input = `void foo(int n) { int x = n * 0xcd40; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SBMP_ValidateTGAHeader'), `Should NOT replace multiply operand in: ${output}`);
    });

    it('should NOT replace literal in shift', () => {
      const input = `void foo(int n) { int x = 0xcd40 >> n; }`;
      const output = transformCode(input, testMap);
      assert.ok(!output.includes('SBMP_ValidateTGAHeader'), `Should NOT replace shift operand in: ${output}`);
    });
  });

  describe('non-arithmetic operators should still replace', () => {
    it('should replace literal in equality check', () => {
      const input = `void foo(int x) { if (x == 0xcd40) {} }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('SBMP_ValidateTGAHeader'), `Should replace in equality: ${output}`);
    });

    it('should replace literal in inequality check', () => {
      const input = `void foo(int x) { if (x != 0x5011f0) {} }`;
      const output = transformCode(input, testMap);
      assert.ok(output.includes('D2WINBUTTON_HandleFormMouseEvent'), `Should replace in inequality: ${output}`);
    });
  });

  describe('no address map', () => {
    it('should not transform anything with empty map', () => {
      const input = `void foo() { int x = 0x5011f0; }`;
      const output = transformCode(input, new Map());
      assert.ok(output.includes('0x5011f0'), `Should keep original: ${output}`);
    });
  });
});

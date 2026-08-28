/**
 * Tests for Function Pointer Literal Resolution Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrLiteralPlugin, type FuncPtrLiteralOptions, type FuncPtrTarget } from '../builtins/func-ptr-literal.js';

describe('funcPtrLiteralPlugin', () => {
  function transformCode(code: string, addressMap: Map<bigint, FuncPtrTarget>): string {
    const ast = parse(code);
    const opts: FuncPtrLiteralOptions = { functionAddressMap: addressMap };
    const transformer = funcPtrLiteralPlugin.createTransformer(opts);
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  const testMap = new Map<bigint, FuncPtrTarget>([
    [0x5011f0n, { name: 'D2WINBUTTON_HandleFormMouseEvent' }],
    [0xcd40n, { name: 'SBMP_ValidateTGAHeader' }],
    [0x1ad80n, { name: 'SNET_InsertConnectionNode' }],
    [0x400100n, { name: 'SomeFunc' }],
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

  describe('the namespace the function is defined in', () => {
    const scoped = new Map<bigint, FuncPtrTarget>([
      [0x5f1380n, { name: 'MONSTERAI_FindFallenForRevival', namespaceSegments: ['D2Game', 'Monster', 'AI'] }],
      [0xcd40n, { name: 'SBMP_ValidateTGAHeader', namespaceSegments: [] }],
    ]);

    it('spells the reference with the qualifier of the definition', () => {
      const input = `void foo() { int fp = 0x5f1380; }`;
      const output = transformCode(input, scoped);
      assert.ok(
        output.includes('D2Game::Monster::AI::MONSTERAI_FindFallenForRevival'),
        `Expected the qualified reference in: ${output}`
      );
    });

    it('leaves a root-scope function bare', () => {
      const input = `void foo() { int fp = 0xcd40; }`;
      const output = transformCode(input, scoped);
      assert.ok(output.includes('SBMP_ValidateTGAHeader'), `Expected the name in: ${output}`);
      assert.ok(!output.includes('::'), `Expected no qualifier in: ${output}`);
    });

    it('still reverts a qualified replacement used as an arithmetic operand', () => {
      const input = `void foo(int base) { int x = base + 0x5f1380; }`;
      const output = transformCode(input, scoped);
      assert.ok(!output.includes('MONSTERAI_FindFallenForRevival'), `Should NOT replace arithmetic operand in: ${output}`);
      assert.ok(output.includes('0x5f1380'), `Should keep hex literal in: ${output}`);
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

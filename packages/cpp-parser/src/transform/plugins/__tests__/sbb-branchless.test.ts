/**
 * SBB Branchless Conditional Plugin Tests
 *
 * Tests the x86 SBB+AND branchless pattern:
 *   -(uint32_t)(cond) & addr  →  cond ? addr : nullptr
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sbbBranchlessPlugin } from '../builtins/sbb-branchless.js';

describe('sbbBranchlessPlugin', () => {
  const transformer = sbbBranchlessPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('realistic Ghidra patterns', () => {
    it('transforms (uint8_t*)(-(uint32_t)(cond) & addr) with outer cast', () => {
      const code = `
typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
struct S { int bEnabled; };
void f(S* param_2) {
  uint8_t* pFunc;
  pFunc = (uint8_t*)(-(uint32_t)(param_2->bEnabled) & 0x5c3370);
}`;
      const result = transform(code);
      assert.ok(result.includes('param_2->bEnabled ?'), `Expected ternary, got:\n${result}`);
      assert.ok(result.includes('0x5c3370'), `Expected addr in result:\n${result}`);
      assert.ok(result.includes('nullptr'), `Expected nullptr in result:\n${result}`);
      assert.ok(!result.includes('-('), `Expected no negation:\n${result}`);
      assert.ok(!result.includes('(uint8_t*)'), `Expected outer cast stripped:\n${result}`);
    });

    it('transforms raw -(uint32_t)(cond) & value without outer cast (uses 0 not nullptr)', () => {
      const code = `
typedef unsigned int uint32_t;
struct S { int flag; };
void f(S* s) { int r = -(uint32_t)(s->flag) & 0x1234; }`;
      const result = transform(code);
      assert.ok(result.includes('s->flag ?'), `Expected ternary:\n${result}`);
      // No outer pointer cast → false branch is 0, not nullptr
      assert.ok(result.includes(': 0'), `Expected : 0 (not nullptr):\n${result}`);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr in arithmetic context:\n${result}`);
    });

    it('transforms -(uint32_t)(x != 0) & addr variant', () => {
      const code = `
typedef unsigned int uint32_t;
struct S { int flag; };
void f(S* s) { int r = -(uint32_t)(s->flag != 0) & 0x5c3370; }`;
      const result = transform(code);
      assert.ok(result.includes('s->flag != 0 ?'), `Expected ternary with !=:\n${result}`);
      assert.ok(result.includes(': 0'), `Expected : 0 in arithmetic context:\n${result}`);
    });

    it('transforms with named function symbol as addr', () => {
      const code = `
typedef unsigned int uint32_t;
struct S { int bEnabled; };
void MyCallback(void);
void f(S* s) {
  void* p = (void*)(-(uint32_t)(s->bEnabled) & (uint32_t)MyCallback);
}`;
      const result = transform(code);
      assert.ok(result.includes('s->bEnabled ?'), `Expected ternary:\n${result}`);
      assert.ok(result.includes('nullptr'), `Expected nullptr:\n${result}`);
      assert.ok(!result.includes('-('), `Expected no negation:\n${result}`);
    });
  });

  describe('constant folding of (cond ? offset : 0) + base', () => {
    it('folds (cond ? 0x13fa : 0) + 0x44324456 to cond ? 0x44325850 : 0x44324456', () => {
      const code = `
typedef unsigned int uint32_t;
struct S { int flag; };
void f(S* s) {
  int local = (-(uint32_t)(s->flag) & 0x13fa) + 0x44324456;
}`;
      const result = transform(code);
      assert.ok(result.includes('0x44325850'), `Expected true-branch addr:\\n${result}`);
      assert.ok(result.includes('0x44324456'), `Expected false-branch addr:\\n${result}`);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr in arithmetic fold:\\n${result}`);
    });

    it('folds with subtraction: (cond ? offset : 0) - base to cond ? (base-offset) : base', () => {
      const code = `
typedef unsigned int uint32_t;
struct S { int flag; };
void f(S* s) {
  int r = (-(uint32_t)(s->flag) & 0x10) - 0x44324456;
}`;
      const result = transform(code);
      // 0x44324456 - 0x10 = 0x44324446
      assert.ok(result.includes('0x44324446'), `Expected true-branch addr:\\n${result}`);
      assert.ok(result.includes('0x44324456'), `Expected false-branch addr:\\n${result}`);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr:\\n${result}`);
    });
  });

  describe('non-pointer cast: no nullptr, no cast strip', () => {
    it('does not use nullptr when outer cast is int32_t', () => {
      const code = `
typedef unsigned int uint32_t;
typedef int int32_t;
struct S { int bEnabled; };
void f(S* s) {
  int r = (int32_t)(-(uint32_t)(s->bEnabled) & 0x5c3370);
}`;
      const result = transform(code);
      // Non-pointer cast: should NOT upgrade 0 to nullptr
      assert.ok(!result.includes('nullptr'), `Expected no nullptr for int32_t cast:\\n${result}`);
    });
  });

  describe('preserves non-matching patterns', () => {
    it('does not transform regular bitwise AND', () => {
      const code = `void f(int x) { int r = x & 0xff; }`;
      const result = transform(code);
      assert.ok(result.includes('& 0xff'), `Expected unchanged:\n${result}`);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr:\n${result}`);
    });

    it('does not transform AND with zero addr', () => {
      const code = `
typedef unsigned int uint32_t;
void f(int x) { int r = -(uint32_t)(x) & 0; }`;
      const result = transform(code);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr:\n${result}`);
    });

    it('does not transform arithmetic negation (x + -y)', () => {
      const code = `void f(int x, int y) { int r = x + -y; }`;
      const result = transform(code);
      assert.ok(result.includes('-y'), `Expected unchanged:\n${result}`);
      assert.ok(!result.includes('nullptr'), `Expected no nullptr:\n${result}`);
    });

    it('does not transform AND of two non-negated values', () => {
      const code = `void f(int x, int y) { int r = x & y; }`;
      const result = transform(code);
      assert.ok(result.includes('x & y'), `Expected unchanged:\n${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('has correct plugin structure', () => {
      assert.strictEqual(sbbBranchlessPlugin.id, 'sbb-branchless');
      assert.strictEqual(sbbBranchlessPlugin.defaultEnabled, true);
      assert.ok(sbbBranchlessPlugin.priority > 40, 'priority should be > 40 (after redundant-negation)');
      assert.ok(sbbBranchlessPlugin.priority < 55, 'priority should be < 55 (before ternary-simplify)');
    });
  });
});

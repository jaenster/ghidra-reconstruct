/**
 * Tests for Boolean Expression Cleanup Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { booleanCleanupPlugin } from '../builtins/boolean-cleanup.js';

describe('booleanCleanupPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = booleanCleanupPlugin.createTransformer();
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('an integer 0 is not the literal false', () => {
    // `x != false` is `x` because a bool is already 0 or 1. `x != 0` is not:
    // the SETNZ at 0040ee0e writes `nSlot = (uint)(*szFileName != 0)`, and
    // dropping the comparison made the slot index the file name's first char.
    it('keeps (uint)(x != 0) where the value is assigned', () => {
      const out = transformCode(`void f(byte *s) { uint n; n = (uint)(*s != 0); }`);
      assert.ok(out.includes('(*s != 0)'), `lost the 0/1 normalisation: ${out}`);
    });

    it('keeps x != 1 and x == 1, which are not !x and x for an int', () => {
      assert.ok(transformCode(`void f(int x) { if (x != 1) { g(); } }`).includes('x != 1'));
      assert.ok(transformCode(`void f(int x) { if (x == 1) { g(); } }`).includes('x == 1'));
    });
  });

  describe('false comparisons', () => {
    it('should simplify expr != false to expr', () => {
      const input = `void foo(bool isReady) { if (isReady != false) { doSomething(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (isReady)'), `Expected simplified condition in: ${output}`);
      assert.ok(!output.includes('false'), `Should not contain false in: ${output}`);
    });

    it('should simplify expr == false to !expr', () => {
      const input = `void foo(bool isReady) { if (isReady == false) { doSomething(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (!isReady)'), `Expected negated condition in: ${output}`);
    });

    it('should simplify false != expr to expr', () => {
      const input = `void foo(bool isValid) { if (false != isValid) { process(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (isValid)'), `Expected simplified condition in: ${output}`);
    });

    it('should simplify false == expr to !expr', () => {
      const input = `void foo(bool isValid) { if (false == isValid) { process(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (!isValid)'), `Expected negated condition in: ${output}`);
    });
  });

  describe('true comparisons', () => {
    it('should simplify expr == true to expr', () => {
      const input = `void foo(bool isEnabled) { if (isEnabled == true) { enable(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (isEnabled)'), `Expected simplified condition in: ${output}`);
      assert.ok(!output.includes('true'), `Should not contain true in: ${output}`);
    });

    it('should simplify expr != true to !expr', () => {
      const input = `void foo(bool isEnabled) { if (isEnabled != true) { disable(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (!isEnabled)'), `Expected negated condition in: ${output}`);
    });

    it('should simplify true == expr to expr', () => {
      const input = `void foo(bool isActive) { if (true == isActive) { activate(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (isActive)'), `Expected simplified condition in: ${output}`);
    });

    it('should simplify true != expr to !expr', () => {
      const input = `void foo(bool isActive) { if (true != isActive) { deactivate(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (!isActive)'), `Expected negated condition in: ${output}`);
    });
  });

  describe('zero comparisons with bitwise AND', () => {
    it('should simplify (flags & MASK) != 0 to (flags & MASK)', () => {
      const input = `void foo(int flags) { if ((flags & 0x10) != 0) { handleFlag(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if ((flags & 0x10))') || output.includes('if (flags & 0x10)'),
        `Expected simplified flag check in: ${output}`);
      assert.ok(!output.includes('!= 0'), `Should not contain != 0 in: ${output}`);
    });

    it('should simplify (flags & MASK) == 0 to !(flags & MASK)', () => {
      const input = `void foo(int flags) { if ((flags & 0x10) == 0) { noFlag(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('!'), `Expected negation in: ${output}`);
    });

    it('should simplify 0 != (x & mask) to (x & mask)', () => {
      const input = `void foo(int state) { if (0 != (state & 0xFF)) { process(); } }`;
      const output = transformCode(input);
      assert.ok(!output.includes('0 !='), `Should not contain 0 != in: ${output}`);
    });
  });

  describe('zero comparisons with boolean expressions', () => {
    it('should simplify comparison result != 0 to comparison', () => {
      const input = `void foo(int a, int b) { if ((a > b) != 0) { greater(); } }`;
      const output = transformCode(input);
      // The comparison itself is already boolean
      assert.ok(!output.includes('!= 0'), `Should not contain != 0 in: ${output}`);
    });

    it('should simplify logical result != 0', () => {
      const input = `void foo(int x, int y) { if ((x && y) != 0) { both(); } }`;
      const output = transformCode(input);
      assert.ok(!output.includes('!= 0'), `Should not contain != 0 in: ${output}`);
    });
  });

  describe('double negation', () => {
    it('should simplify !!boolExpr to boolExpr when boolean-like', () => {
      const input = `void foo(int a, int b) { bool result = !!(a == b); }`;
      const output = transformCode(input);
      // Double negation of comparison should be simplified
      assert.ok(output.includes('a == b'), `Expected comparison in: ${output}`);
    });

    it('should simplify !!negation to original', () => {
      const input = `void foo(bool isValid) { bool result = !!(!isValid); }`;
      const output = transformCode(input);
      // !!(!x) should simplify since !x is boolean
      assert.ok(!output.includes('!!'), `Should not contain !! in: ${output}`);
    });
  });

  describe('member access patterns', () => {
    it('should simplify member access with false comparison', () => {
      const input = `void foo(QuestData* pQuestData) { if (pQuestData->bIsNotIntroduction != false) { intro(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('if (pQuestData->bIsNotIntroduction)'),
        `Expected simplified member access in: ${output}`);
    });
  });

  describe('plugin options', () => {
    it('should respect simplifyFalseComparison option', () => {
      const ast = parse(`void foo(bool x) { if (x != false) { a(); } }`);
      const transformer = booleanCleanupPlugin.createTransformer({
        simplifyFalseComparison: false
      });
      const result = emit(transformer(ast) as AnyNode);
      assert.ok(result.includes('!= false'), `Should keep != false when disabled: ${result}`);
    });

    it('should respect simplifyTrueComparison option', () => {
      const ast = parse(`void foo(bool x) { if (x == true) { a(); } }`);
      const transformer = booleanCleanupPlugin.createTransformer({
        simplifyTrueComparison: false
      });
      const result = emit(transformer(ast) as AnyNode);
      assert.ok(result.includes('== true'), `Should keep == true when disabled: ${result}`);
    });
  });

  describe('nullptr comparisons', () => {
    it('should simplify ptr != nullptr to ptr', () => {
      const input = `void foo(int* p) { if (p != nullptr) { work(); } }`;
      const output = transformCode(input);
      assert.strictEqual(output, 'void foo(int* p) {\n  if (p) {\n    work();\n  }\n}');
    });

    it('should simplify ptr == nullptr to !ptr', () => {
      const input = `void foo(int* p) { if (p == nullptr) { fail(); } }`;
      const output = transformCode(input);
      assert.strictEqual(output, 'void foo(int* p) {\n  if (!p) {\n    fail();\n  }\n}');
    });

    it('should simplify nullptr != ptr to ptr', () => {
      const input = `void foo(int* p) { if (nullptr != p) { work(); } }`;
      const output = transformCode(input);
      assert.strictEqual(output, 'void foo(int* p) {\n  if (p) {\n    work();\n  }\n}');
    });

    it('should simplify nullptr == ptr to !ptr', () => {
      const input = `void foo(int* p) { if (nullptr == p) { fail(); } }`;
      const output = transformCode(input);
      assert.strictEqual(output, 'void foo(int* p) {\n  if (!p) {\n    fail();\n  }\n}');
    });

    it('should not simplify non-nullptr comparisons', () => {
      const input = `void foo(int* p, int* q) { if (p != q) { work(); } }`;
      const output = transformCode(input);
      assert.strictEqual(output, 'void foo(int* p, int* q) {\n  if (p != q) {\n    work();\n  }\n}');
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(booleanCleanupPlugin.id, 'boolean-cleanup');
      assert.strictEqual(booleanCleanupPlugin.defaultEnabled, true);
      assert.strictEqual(booleanCleanupPlugin.priority, 50);
      assert.ok(booleanCleanupPlugin.tags?.includes('boolean'));
      assert.ok(booleanCleanupPlugin.tags?.includes('cleanup'));
    });
  });
});

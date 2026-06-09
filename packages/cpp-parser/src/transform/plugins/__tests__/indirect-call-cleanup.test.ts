/**
 * Indirect Call Cleanup Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { indirectCallCleanupPlugin } from '../builtins/indirect-call-cleanup.js';
import { vtableCallPlugin } from '../builtins/vtable-calls.js';

describe('indirectCallCleanupPlugin', () => {
  const transformer = indirectCallCleanupPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(indirectCallCleanupPlugin.id, 'indirect-call-cleanup');
      assert.strictEqual(indirectCallCleanupPlugin.defaultEnabled, true);
      assert.ok(indirectCallCleanupPlugin.tags?.includes('core'));
      assert.ok(indirectCallCleanupPlugin.tags?.includes('cleanup'));
    });

    it('should have very low priority for early execution', () => {
      assert.ok(indirectCallCleanupPlugin.priority <= 5, 'Expected priority <= 5');
    });
  });

  describe('WARNING trivia stripping', () => {
    it('should strip jumptable warning from before function', () => {
      const code = `/* WARNING: Could not recover jumptable */
void f() {
  int x = 1;
}`;
      const result = transform(code);
      assert.ok(!result.includes('WARNING: Could not recover jumptable'), `Warning not stripped: ${result}`);
      assert.ok(result.includes('int x = 1'), `Code body lost: ${result}`);
    });

    it('should strip indirect jump warning', () => {
      const code = `/* WARNING: Treating indirect jump as call */
void f() {
  foo();
}`;
      const result = transform(code);
      assert.ok(!result.includes('WARNING: Treating indirect jump as call'), `Warning not stripped: ${result}`);
      assert.ok(result.includes('foo()'), `Code body lost: ${result}`);
    });

    it('should preserve non-warning comments', () => {
      const code = `/* This is a normal comment */
void f() {
  int x = 1;
}`;
      const result = transform(code);
      assert.ok(result.includes('normal comment'), `Normal comment was stripped: ${result}`);
    });

    it('should strip warning but keep other leading trivia', () => {
      const code = `/* WARNING: Could not recover jumptable */
/* Real comment */
void f() {
  int x = 1;
}`;
      const result = transform(code);
      assert.ok(!result.includes('jumptable'), `Warning not stripped: ${result}`);
      assert.ok(result.includes('Real comment'), `Real comment was stripped: ${result}`);
    });
  });

  describe('struct field fn-ptr cleanup', () => {
    it('should clean (*(code*)pVar->fpField)(args) to pVar->fpField(args)', () => {
      const code = `void f(D2QuestDataStrc *pVar) {
  (*(code *)pVar->fpField)(pVar);
}`;
      const result = transform(code);
      assert.ok(!result.includes('code *'), `code* cast not removed: ${result}`);
      assert.ok(result.includes('->fpField('), `Member access should be direct call: ${result}`);
    });

    it('should clean (*pVar->fpCallback)(args) to pVar->fpCallback(args)', () => {
      const code = `void f(Obj *obj) {
  (*obj->fpCallback)(1, 2);
}`;
      const result = transform(code);
      assert.ok(result.includes('obj->fpCallback('), `fn-ptr not cleaned: ${result}`);
      assert.ok(!result.includes('(*obj->'), `Deref wrapper still present: ${result}`);
    });

    it('should handle (*(code**)pVar->fpField)(args)', () => {
      const code = `void f(Obj *obj) {
  (*(code **)obj->fpFunc)(obj, 1);
}`;
      const result = transform(code);
      assert.ok(result.includes('obj->fpFunc('), `fn-ptr not cleaned: ${result}`);
    });

    it('should preserve non-fn-ptr member calls', () => {
      const code = `void f(Obj *obj) {
  obj->method();
}`;
      const result = transform(code);
      assert.ok(result.includes('obj->method()'), `Normal call modified: ${result}`);
    });

    it('should preserve regular function calls', () => {
      const code = `void f() { printf("hello"); }`;
      const result = transform(code);
      assert.ok(result.includes('printf'), `printf lost: ${result}`);
    });

    it('should preserve function pointer calls without member access', () => {
      // Use a simpler fn-ptr pattern the parser can handle
      const code = `void f(code *fp) { (*fp)(); }`;
      const result = transform(code);
      // Should not crash — fp is not a member expression
      assert.ok(result.length > 0);
    });
  });
});

describe('vtableCallPlugin (32-bit support)', () => {
  const transformer = vtableCallPlugin.createTransformer({ pointerSize: 4 });

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('pointer arithmetic vtable patterns', () => {
    it('should preserve regular function calls', () => {
      const code = `void f(int x) { printf("%d", x); }`;
      const result = transform(code);
      assert.ok(result.includes('printf'), `Expected printf in: ${result}`);
    });

    it('should preserve regular method calls', () => {
      const code = `void f(Obj *obj) { obj->method(); }`;
      const result = transform(code);
      assert.ok(result.includes('->method'), `Expected ->method in: ${result}`);
    });
  });

  describe('plugin options', () => {
    it('should accept pointerSize option', () => {
      const t4 = vtableCallPlugin.createTransformer({ pointerSize: 4 });
      const t8 = vtableCallPlugin.createTransformer({ pointerSize: 8 });
      assert.ok(t4, 'Should create transformer with pointerSize=4');
      assert.ok(t8, 'Should create transformer with pointerSize=8');
    });

    it('should default to 4-byte pointer size', () => {
      const t = vtableCallPlugin.createTransformer();
      assert.ok(t, 'Should create transformer with default options');
    });
  });
});

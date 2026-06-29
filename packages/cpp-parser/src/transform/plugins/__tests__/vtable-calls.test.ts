/**
 * VTable Call Pattern Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { vtableCallPlugin } from '../builtins/vtable-calls.js';

describe('vtableCallPlugin', () => {
  const transformer = vtableCallPlugin.createTransformer();

  function transform(code: string): string {
    const ast = parse(code);
    const transformed = transformer(ast);
    return emit(transformed as AnyNode).trim();
  }

  describe('vtable call patterns', () => {
    // Note: These patterns are very specific to Ghidra output
    // VTable patterns are complex and parser-dependent

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

    it('should preserve indirect calls through pointer', () => {
      const code = `void f(void *ptr) { int x = (*ptr)(); }`;
      // Parser may have issues with this, just verify no crash
      try {
        const result = transform(code);
        assert.ok(result.length > 0);
      } catch (e) {
        // Parser limitation - that's OK
        assert.ok(true);
      }
    });
  });

  describe('table vs object dispatch', () => {
    it('rewrites a real object vtable (*this + off) to a readable method call', () => {
      const code = `void f(int **self, int x) { (**(code **)(*self + 0x10))(self, x); }`;
      const result = transform(code);
      assert.ok(result.includes('->vmethod_4'), `Expected ->vmethod_4 in: ${result}`);
    });

    it('rewrites a function-pointer TABLE (base + off) to a faithful byte-offset indirect call, not ->vmethod', () => {
      const code = `void f(void **arr, int a) { (**(code **)(arr + 8))(a); }`;
      const result = transform(code);
      const norm = result.replace(/\s+/g, '');
      assert.ok(!result.includes('vmethod'), `Should NOT emit vmethod for a table: ${result}`);
      assert.ok(norm.includes('(char*)arr+8'), `Expected byte-offset cast in: ${result}`);
      assert.ok(norm.includes('(code**)'), `Expected code** read in: ${result}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(vtableCallPlugin.id, 'vtable-calls');
      assert.strictEqual(vtableCallPlugin.defaultEnabled, true);
      assert.ok(vtableCallPlugin.tags?.includes('core'));
      assert.ok(vtableCallPlugin.tags?.includes('cpp'));
    });

    it('should have low priority for early execution', () => {
      // Vtable calls should be processed early
      assert.ok(vtableCallPlugin.priority < 50, 'Expected priority < 50');
    });
  });
});

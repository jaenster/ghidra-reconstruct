/**
 * Tests for Nullptr Cleanup Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { nullptrCleanupPlugin } from '../builtins/nullptr-cleanup.js';

describe('nullptrCleanupPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = nullptrCleanupPlugin.createTransformer();
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('basic nullptr conversion', () => {
    it('should convert (void*)0x0 to nullptr', () => {
      const input = `void foo() { void* ptr = (void*)0x0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
      assert.ok(!output.includes('0x0'), `Should not contain 0x0 in: ${output}`);
    });

    it('should convert (int*)0x0 to nullptr', () => {
      const input = `void foo() { int* ptr = (int*)0x0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
    });

    it('should convert (Type*)0 to nullptr', () => {
      const input = `void foo() { char* ptr = (char*)0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
    });

    it('should convert struct pointer casts to nullptr', () => {
      const input = `void foo() { D2UnitStrc* pUnit = (D2UnitStrc*)0x0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
    });
  });

  describe('comparison context', () => {
    it('should convert in equality comparison', () => {
      const input = `void foo(D2UnitStrc* pUnit) { if (pUnit == (D2UnitStrc*)0x0) { return; } }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
      assert.ok(output.includes('== nullptr'), `Expected == nullptr in: ${output}`);
    });

    it('should convert in inequality comparison', () => {
      const input = `void foo(void* ptr) { if (ptr != (void*)0x0) { doSomething(); } }`;
      const output = transformCode(input);
      assert.ok(output.includes('!= nullptr'), `Expected != nullptr in: ${output}`);
    });
  });

  describe('return statements', () => {
    it('should convert in return statement', () => {
      const input = `int* getPtr() { return (int*)0x0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('return nullptr'), `Expected return nullptr in: ${output}`);
    });
  });

  describe('assignment context', () => {
    it('should convert in member assignment', () => {
      const input = `void clear(LightMap* pLightMap) { pLightMap->pPixels = (int*)0x0; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
    });
  });

  describe('small-address DAT_ to cast deref', () => {
    it('should convert _DAT_00000014 to *(int32_t*)0x14', () => {
      const input = `void foo() { _DAT_00000014 = 0xffffffff; }`;
      const output = transformCode(input);
      assert.ok(output.includes('*(int32_t*)0x14'), `Expected cast deref in: ${output}`);
      assert.ok(!output.includes('_DAT_00000014'), `Should not contain DAT_ ref in: ${output}`);
    });

    it('should convert DAT_00000004 without underscore prefix', () => {
      const input = `void foo() { int x = DAT_00000004; }`;
      const output = transformCode(input);
      assert.ok(output.includes('*(int32_t*)0x4'), `Expected cast deref in: ${output}`);
    });

    it('should NOT convert addresses >= 0x1000', () => {
      const input = `void foo() { int x = _DAT_00401000; }`;
      const output = transformCode(input);
      assert.ok(output.includes('_DAT_00401000'), `Should keep real global: ${output}`);
      assert.ok(!output.includes('int32_t'), `Should not add cast: ${output}`);
    });

    it('should still convert &DAT_00000000 to nullptr', () => {
      const input = `void foo() { void* ptr = &DAT_00000000; }`;
      const output = transformCode(input);
      assert.ok(output.includes('nullptr'), `Expected nullptr in: ${output}`);
    });
  });

  describe('non-convertible patterns', () => {
    it('should NOT convert non-zero cast', () => {
      const input = `void foo() { int* ptr = (int*)0x1000; }`;
      const output = transformCode(input);
      assert.ok(!output.includes('nullptr'), `Should not contain nullptr in: ${output}`);
      assert.ok(output.includes('0x1000'), `Should contain 0x1000 in: ${output}`);
    });

    it('should NOT convert non-pointer cast', () => {
      const input = `void foo() { int val = (int)0x0; }`;
      const output = transformCode(input);
      assert.ok(!output.includes('nullptr'), `Should not contain nullptr in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(nullptrCleanupPlugin.id, 'nullptr-cleanup');
      assert.strictEqual(nullptrCleanupPlugin.defaultEnabled, true);
      assert.strictEqual(nullptrCleanupPlugin.priority, 25);
      assert.ok(nullptrCleanupPlugin.tags?.includes('cleanup'));
    });
  });
});

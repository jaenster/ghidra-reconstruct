/**
 * Plugin System Integration Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { PluginRegistry, registerPlugins } from '../registry.js';
import { allBuiltinPlugins, defaultRegistry } from '../index.js';

describe('Plugin System Integration', () => {
  describe('defaultRegistry', () => {
    it('should have all built-in plugins registered', () => {
      assert.ok(defaultRegistry.size > 0);

      // Check for key plugins
      assert.strictEqual(defaultRegistry.has('ghidra-clean-names'), true);
      assert.strictEqual(defaultRegistry.has('ghidra-remove-casts'), true);
      assert.strictEqual(defaultRegistry.has('loop-canonicalize'), true);
      assert.strictEqual(defaultRegistry.has('array-access'), true);
      assert.strictEqual(defaultRegistry.has('struct-field'), true);
    });

    it('should create a working pipeline', () => {
      const pipeline = defaultRegistry.createPipeline({ preset: 'quick' });
      assert.ok(pipeline);
      assert.ok(pipeline.getSteps().length > 0);
    });
  });

  describe('full transform pipeline', () => {
    let registry: PluginRegistry;

    beforeEach(() => {
      registry = new PluginRegistry();
      registerPlugins(registry, allBuiltinPlugins);
    });

    function transform(code: string, preset: 'quick' | 'full' = 'quick'): string {
      const ast = parse(code);
      const pipeline = registry.createPipeline({ preset });
      const result = pipeline.execute(ast);
      return emit(result.ast as AnyNode).trim();
    }

    it('should transform Ghidra-style function', () => {
      const code = `
void FUN_00401000(int param_1) {
  int local_8 = 0;
  local_8 = local_8 + 1;
}
`;
      const result = transform(code);

      // FUN_ names are preserved; param_ and local_ are kept as-is (only xVar temporaries get renamed)
      assert.ok(result.includes('FUN_'), `Expected FUN_ in: ${result}`);
      assert.ok(result.includes('param_1'), `Expected param_1 preserved in: ${result}`);
      assert.ok(result.includes('local_8'), `Expected local_8 preserved in: ${result}`);

      // Should canonicalize increment
      assert.ok(
        result.match(/local_8\s*\+\+/) || result.match(/local_8\s*\+=\s*1/),
        `Expected increment pattern in: ${result}`
      );
    });

    it('should not let struct-field undo a SUBPIECE byte access', () => {
      // Ghidra emits `x._3_1_` (byte 3, size 1, of scalar x). The subpiece plugin
      // rewrites it to `*(uint8_t *)((char *)&x + 3)`. struct-field must NOT then
      // re-match that and emit the invalid `((char *)&x)->field_3` (char has no
      // members). Regression for the cast-hell bucket.
      const code = `
int getByte(int x) {
  return (int)x._3_1_;
}
`;
      const result = transform(code, 'full');
      assert.ok(
        !/->field_3/.test(result),
        `SUBPIECE access must not become ((char*)&x)->field_3: ${result}`
      );
      assert.ok(
        /\(char\s*\*\)\s*&/.test(result) && /\+\s*3/.test(result),
        `Expected valid byte-range form *(T*)((char*)&x + 3): ${result}`
      );
    });

    it('should cast a pointer-struct var initialized from a chained member access', () => {
      // Offset-0 union deref: the dest type and the union member type differ but
      // alias the same pointer — cast to the declared type so it compiles.
      const code = `
void f() {
  D2QuestDataA1Q1Strc* p = pQuestData->pQuestSpecificData.pA1Q5;
}
`;
      const result = transform(code, 'full');
      assert.ok(
        /=\s*\(D2QuestDataA1Q1Strc\s*\*\)\s*pQuestData->pQuestSpecificData\.pA1Q5/.test(result),
        `Expected cast to declared type: ${result}`
      );
    });

    it('should NOT cast a simple (non-chained) member init', () => {
      const code = `
void f() {
  D2UnitStrc* p = obj.field;
}
`;
      const result = transform(code, 'full');
      assert.ok(!/\(D2UnitStrc\s*\*\)\s*obj\.field/.test(result), `Should not cast simple member init: ${result}`);
    });

    it('should handle pointer arithmetic', () => {
      const code = `
void f(int *arr, int i) {
  int x = *(arr + i);
}
`;
      const result = transform(code);
      assert.ok(result.includes('['), `Expected [ in: ${result}`);
    });

    it('should simplify boolean expressions', () => {
      const code = `
void f(int x) {
  if (x != 0) {
    return;
  }
}
`;
      const result = transform(code);
      // Should simplify x != 0 to just x
      assert.ok(!result.includes('!= 0'), `Should not contain != 0 in: ${result}`);
    });

    it('should track pipeline steps', () => {
      const code = `void FUN_00401000(int param_1) { }`;
      const ast = parse(code);
      const pipeline = registry.createPipeline({
        preset: 'quick',
        trackSteps: true,
      });

      const result = pipeline.execute(ast);

      assert.ok(result.steps.length > 0);
      assert.ok(result.totalChanges >= 0);
    });
  });

  describe('version hashing', () => {
    it('should generate different hashes for different plugin sets', () => {
      const registry1 = new PluginRegistry();
      const registry2 = new PluginRegistry();

      registerPlugins(registry1, allBuiltinPlugins.slice(0, 3));
      registerPlugins(registry2, allBuiltinPlugins.slice(0, 5));

      const hash1 = registry1.getVersionHash();
      const hash2 = registry2.getVersionHash();

      assert.notStrictEqual(hash1, hash2);
    });

    it('should generate same hash for same plugins', () => {
      const registry1 = new PluginRegistry();
      const registry2 = new PluginRegistry();

      registerPlugins(registry1, allBuiltinPlugins);
      registerPlugins(registry2, allBuiltinPlugins);

      const hash1 = registry1.getVersionHash();
      const hash2 = registry2.getVersionHash();

      assert.strictEqual(hash1, hash2);
    });
  });

  describe('preset configurations', () => {
    it('should enable different plugins for quick vs full', () => {
      const quickEnabled = defaultRegistry.getEnabled({ preset: 'quick' });
      const fullEnabled = defaultRegistry.getEnabled({ preset: 'full' });

      // Full should enable at least as many as quick
      assert.ok(fullEnabled.length >= quickEnabled.length);

      // Quick should only have core plugins
      for (const plugin of quickEnabled) {
        assert.ok(
          plugin.tags?.includes('core'),
          `Plugin ${plugin.id} should have 'core' tag`
        );
      }
    });
  });
});

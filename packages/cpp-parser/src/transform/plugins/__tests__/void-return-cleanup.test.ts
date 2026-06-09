import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { voidReturnCleanupPlugin } from '../builtins/void-return-cleanup.js';

describe('voidReturnCleanupPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = voidReturnCleanupPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should remove trailing return from void function', () => {
    const output = transformCode('void foo() { work(); return; }');
    assert.strictEqual(output, 'void foo() {\n  work();\n}');
  });

  it('should remove return from void function with only return', () => {
    const output = transformCode('void foo() { return; }');
    assert.strictEqual(output, 'void foo() {}');
  });

  it('should not remove return from non-void function', () => {
    const output = transformCode('int foo() { return 0; }');
    assert.ok(output.includes('return 0;'), 'return with value should be preserved');
  });

  it('should not remove return with value from void function', () => {
    const output = transformCode('void foo() { return (void)0; }');
    assert.ok(output.includes('return'), 'return with cast expression should be preserved');
  });

  it('should only remove trailing return, preserving non-trailing returns', () => {
    const output = transformCode('void foo() { if (c) return; work(); return; }');
    assert.ok(output.includes('if (c)'), 'if statement should be preserved');
    assert.ok(output.includes('return;'), 'inner return should be preserved');
    assert.ok(output.includes('work();'), 'work call should be preserved');
    // The trailing return should be gone, but the inner one stays
    const returnCount = (output.match(/return;/g) || []).length;
    assert.strictEqual(returnCount, 1, 'should have exactly one return (the inner one)');
  });

  it('should not remove return from void pointer function', () => {
    const output = transformCode('void* foo() { return ptr; }');
    assert.ok(output.includes('return ptr;'), 'return should be preserved for void* function');
  });

  it('should handle real-world DRLG function', () => {
    const input = `void DRLG_MapWorldToScreenCoords(int32_t* pX, int32_t* pY) {
  int x = *pX;
  int y = *pY;
  *pX = x - y >> 1;
  *pY = y + x >> 2;
  return;
}`;
    const output = transformCode(input);
    assert.ok(!output.endsWith('return;\n}'), 'trailing return should be removed');
    assert.ok(output.includes('*pY = y + x >> 2;'), 'last real statement preserved');
    assert.ok(!output.includes('return;'), 'no return statement at all');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(voidReturnCleanupPlugin.id, 'void-return-cleanup');
    assert.strictEqual(voidReturnCleanupPlugin.priority, 90);
    assert.strictEqual(voidReturnCleanupPlugin.defaultEnabled, true);
    assert.ok(voidReturnCleanupPlugin.tags?.includes('cleanup'));
  });
});

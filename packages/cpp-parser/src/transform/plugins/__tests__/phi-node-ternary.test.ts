import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { phiNodeTernaryPlugin } from '../builtins/phi-node-ternary.js';

describe('phiNodeTernaryPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = phiNodeTernaryPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should convert basic phi-node to ternary', () => {
    const output = transformCode('void f() { int x; if (c) { x = 1; } else { x = 2; } }');
    assert.strictEqual(output, 'void f() {\n  int x = c ? 1 : 2;\n}');
  });

  it('should convert with complex expressions', () => {
    const output = transformCode('void f() { int x; if (a > b) { x = foo(); } else { x = bar(); } }');
    assert.strictEqual(output, 'void f() {\n  int x = a > b ? foo() : bar();\n}');
  });

  it('should convert pointer types', () => {
    const output = transformCode('void f() { int* p; if (c) { p = &a; } else { p = &b; } }');
    assert.strictEqual(output, 'void f() {\n  int* p = c ? &a : &b;\n}');
  });

  it('should not convert when branch has extra statements', () => {
    const output = transformCode('void f() { int x; if (c) { x = 1; extra(); } else { x = 2; } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  if (c) {\n    x = 1;\n    extra();\n  } else {\n    x = 2;\n  }\n}');
  });

  it('should not convert when else is missing', () => {
    const output = transformCode('void f() { int x; if (c) { x = 1; } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  if (c) {\n    x = 1;\n  }\n}');
  });

  it('should not convert when branches assign to different variables', () => {
    const output = transformCode('void f() { int x; if (c) { x = 1; } else { y = 2; } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  if (c) {\n    x = 1;\n  } else {\n    y = 2;\n  }\n}');
  });

  it('should not convert when variable is used in condition', () => {
    const output = transformCode('void f() { int x; if (x) { x = 1; } else { x = 2; } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  if (x) {\n    x = 1;\n  } else {\n    x = 2;\n  }\n}');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(phiNodeTernaryPlugin.id, 'phi-node-ternary');
    assert.strictEqual(phiNodeTernaryPlugin.priority, 63);
    assert.strictEqual(phiNodeTernaryPlugin.defaultEnabled, true);
    assert.ok(phiNodeTernaryPlugin.tags?.includes('cleanup'));
  });
});

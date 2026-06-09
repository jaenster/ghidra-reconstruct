import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { redundantParenCleanupPlugin } from '../builtins/redundant-paren-cleanup.js';

describe('redundantParenCleanupPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = redundantParenCleanupPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should strip ParenExpr from if condition', () => {
    const output = transformCode('void f() { if ((x > 5)) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x > 5) {\n    work();\n  }\n}');
  });

  it('should strip ParenExpr from while condition', () => {
    const output = transformCode('void f() { while ((x)) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  while (x) {\n    work();\n  }\n}');
  });

  it('should strip ParenExpr from do-while condition', () => {
    const output = transformCode('void f() { do { work(); } while ((x)); }');
    assert.strictEqual(output, 'void f() {\n  do {\n    work();\n  } while (x);\n}');
  });

  it('should strip ParenExpr from switch condition', () => {
    const output = transformCode('void f() { switch ((x)) { case 1: break; } }');
    assert.strictEqual(output, 'void f() {\n  switch (x) {\n    case 1:\n      break;\n  }\n}');
  });

  it('should strip nested ParenExpr', () => {
    const output = transformCode('void f() { if (((x))) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x) {\n    work();\n  }\n}');
  });

  it('should not strip necessary ParenExpr in expressions', () => {
    const output = transformCode('void f() { int x = (a + b) * c; }');
    assert.strictEqual(output, 'void f() {\n  int x = (a + b) * c;\n}');
  });

  it('should not modify if condition without ParenExpr', () => {
    const output = transformCode('void f() { if (x > 5) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x > 5) {\n    work();\n  }\n}');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(redundantParenCleanupPlugin.id, 'redundant-paren-cleanup');
    assert.strictEqual(redundantParenCleanupPlugin.priority, 56);
    assert.strictEqual(redundantParenCleanupPlugin.defaultEnabled, true);
    assert.ok(redundantParenCleanupPlugin.tags?.includes('cleanup'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { deadBranchCleanupPlugin } from '../builtins/dead-branch-cleanup.js';

describe('deadBranchCleanupPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = deadBranchCleanupPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should eliminate if(true) single statement', () => {
    const output = transformCode('void f() { if (true) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  work();\n}');
  });

  it('should eliminate if(true) multi-statement (unwrap)', () => {
    const output = transformCode('void f() { if (true) { a(); b(); } }');
    assert.strictEqual(output, 'void f() {\n  a();\n  b();\n}');
  });

  it('should eliminate if(false) entirely', () => {
    const output = transformCode('void f() { if (false) { dead(); } }');
    assert.strictEqual(output, 'void f() {}');
  });

  it('should keep else branch when if(false)', () => {
    const output = transformCode('void f() { if (false) { dead(); } else { alive(); } }');
    assert.strictEqual(output, 'void f() {\n  alive();\n}');
  });

  it('should keep then branch when if(true) with else', () => {
    const output = transformCode('void f() { if (true) { a(); } else { b(); } }');
    assert.strictEqual(output, 'void f() {\n  a();\n}');
  });

  it('should promote else-if when if(false)', () => {
    const output = transformCode('void f() { if (false) { dead(); } else if (c) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    work();\n  }\n}');
  });

  it('should handle nested if(true)/if(false)', () => {
    const output = transformCode('void f() { if (true) { if (false) { dead(); } } }');
    assert.strictEqual(output, 'void f() {}');
  });

  it('should simplify else if(true) to else', () => {
    const output = transformCode('void f() { if (c) { a(); } else if (true) { b(); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    a();\n  } else {\n    b();\n  }\n}');
  });

  it('should eliminate else if(false) without else', () => {
    const output = transformCode('void f() { if (c) { a(); } else if (false) { dead(); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    a();\n  }\n}');
  });

  it('should promote else after else if(false) with else', () => {
    const output = transformCode('void f() { if (c) { a(); } else if (false) { dead(); } else { b(); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    a();\n  } else {\n    b();\n  }\n}');
  });

  // Expression-level dead branch cleanup
  it('should simplify expr && true to expr', () => {
    const output = transformCode('void f() { if (x && true) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x) {\n    work();\n  }\n}');
  });

  it('should simplify expr || false to expr', () => {
    const output = transformCode('void f() { if (x || false) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x) {\n    work();\n  }\n}');
  });

  it('should simplify expr && false to false', () => {
    const output = transformCode('void f() { if (x && false) { work(); } }');
    assert.strictEqual(output, 'void f() {}');
  });

  it('should simplify expr || true to true', () => {
    const output = transformCode('void f() { if (x || true) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  work();\n}');
  });

  it('should not modify non-literal conditions', () => {
    const output = transformCode('void f() { if (x) { work(); } }');
    assert.strictEqual(output, 'void f() {\n  if (x) {\n    work();\n  }\n}');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(deadBranchCleanupPlugin.id, 'dead-branch-cleanup');
    assert.strictEqual(deadBranchCleanupPlugin.priority, 58);
    assert.strictEqual(deadBranchCleanupPlugin.defaultEnabled, true);
    assert.ok(deadBranchCleanupPlugin.tags?.includes('cleanup'));
  });
});

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

  // ======================================
  // Jumped-into constant-false blocks
  //
  // Ghidra expresses "reachable only by jumping in" as `if (false) { L: body }`
  // with a `goto L;` elsewhere. Deleting that arm silently drops live code and
  // leaves a bodyless label, so the function can fall off its end.
  // ======================================

  it('should keep an if(false) block whose label is a goto target', () => {
    const output = transformCode(`
uint32_t f(int x) {
  if (false) {
switchD_004fec73_caseD_2:
    body();
    return 0;
  }
  else {
    switch (x) {
    case 1:
      a();
      break;
    default:
      goto switchD_004fec73_caseD_2;
    }
  }
  return 1;
}
`);
    assert.ok(output.includes('body();'), `body was deleted:\n${output}`);
    assert.ok(output.includes('switchD_004fec73_caseD_2:'), `label lost:\n${output}`);
    assert.ok(output.includes('goto switchD_004fec73_caseD_2;'), `goto lost:\n${output}`);
  });

  it('should still drop an if(false) block whose label nothing targets', () => {
    const output = transformCode('void f() { if (false) { LAB_1: dead(); } }');
    assert.strictEqual(output, 'void f() {}');
  });

  it('should keep a discarded else branch whose label is a goto target', () => {
    const output = transformCode(`
void f(int x) {
  if (true) { a(); }
  else { LAB_dead: b(); }
  if (x) goto LAB_dead;
}
`);
    assert.ok(output.includes('b();'), `else body deleted:\n${output}`);
  });

  it('should keep a case-level if(false) body that is jumped into', () => {
    const output = transformCode(`
void f(int x) {
  switch (x) {
  case 1:
    if (false) { LAB_x: body(); }
    break;
  case 2:
    goto LAB_x;
  }
}
`);
    assert.ok(output.includes('body();'), `case body deleted:\n${output}`);
  });

  it('should keep an else-if(false) branch that is jumped into', () => {
    const output = transformCode(`
void f(int x) {
  if (x) { a(); }
  else if (false) { LAB_y: b(); }
  if (x) goto LAB_y;
}
`);
    assert.ok(output.includes('b();'), `else-if body deleted:\n${output}`);
  });

  it('should have correct metadata', () => {
    assert.strictEqual(deadBranchCleanupPlugin.id, 'dead-branch-cleanup');
    assert.strictEqual(deadBranchCleanupPlugin.priority, 58);
    assert.strictEqual(deadBranchCleanupPlugin.defaultEnabled, true);
    assert.ok(deadBranchCleanupPlugin.tags?.includes('cleanup'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { declScopeSinkPlugin } from '../builtins/decl-scope-sink.js';

describe('declScopeSinkPlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = declScopeSinkPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should sink declaration into then-branch', () => {
    const output = transformCode('void f() { int x; if (c) { x = 5; use(x); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    int x;\n    x = 5;\n    use(x);\n  }\n}');
  });

  it('should sink declaration into else-branch', () => {
    const output = transformCode('void f() { int x; if (c) { a(); } else { x = 1; use(x); } }');
    assert.strictEqual(output, 'void f() {\n  if (c) {\n    a();\n  } else {\n    int x;\n    x = 1;\n    use(x);\n  }\n}');
  });

  it('should not sink when variable is used in condition', () => {
    const output = transformCode('void f() { int x = get(); if (x > 0) { use(x); } }');
    assert.strictEqual(output, 'void f() {\n  int x = get();\n  if (x > 0) {\n    use(x);\n  }\n}');
  });

  it('should not sink when variable is used in both branches', () => {
    const output = transformCode('void f() { int x; if (c) { x = 1; } else { x = 2; } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  if (c) {\n    x = 1;\n  } else {\n    x = 2;\n  }\n}');
  });

  it('should not sink when variable is used in two sibling statements', () => {
    const output = transformCode('void f() { int x; foo(x); bar(x); }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  foo(x);\n  bar(x);\n}');
  });

  it('should sink into for-loop body', () => {
    const output = transformCode('void f() { int x; for (i = 0; i < n; i++) { use(x); } }');
    assert.strictEqual(output, 'void f() {\n  for (i = 0; i < n; i++) {\n    int x;\n    use(x);\n  }\n}');
  });

  it('should sink into while-loop body', () => {
    const output = transformCode('void f() { int x; while (c) { use(x); } }');
    assert.strictEqual(output, 'void f() {\n  while (c) {\n    int x;\n    use(x);\n  }\n}');
  });

  it('should not sink when variable is in for-condition', () => {
    const output = transformCode('void f() { int x; for (; x < n; ) { use(x); } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  for (; x < n;) {\n    use(x);\n  }\n}');
  });

  it('should not sink when variable is in while-condition', () => {
    const output = transformCode('void f() { int x; while (x) { use(x); } }');
    assert.strictEqual(output, 'void f() {\n  int x;\n  while (x) {\n    use(x);\n  }\n}');
  });

  it('should not sink static variables', () => {
    const output = transformCode('void f() { static int x; if (c) { x++; } }');
    assert.strictEqual(output, 'void f() {\n  static int x;\n  if (c) {\n    x++;\n  }\n}');
  });

  it('should have correct metadata', () => {
    assert.strictEqual(declScopeSinkPlugin.id, 'decl-scope-sink');
    assert.strictEqual(declScopeSinkPlugin.priority, 62);
    assert.strictEqual(declScopeSinkPlugin.defaultEnabled, true);
    assert.ok(declScopeSinkPlugin.tags?.includes('cleanup'));
  });
});

describe('declScopeSinkPlugin — frame-slot residue', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = declScopeSinkPlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode).trim();
  }

  it('does not sink while an unresolved stack0x frame address is still present', () => {
    // `stack-frame-address` runs at priority 520 and turns `&stack0xfffffeef`
    // into `&szNameCopy - 1`. Sinking `szNameCopy` into the loop first leaves
    // that later reference naming an out-of-scope variable.
    const out = transformCode(
      'void f() { char szNameCopy[260]; uint8_t* p; p = &stack0xfffffeef; while (c) { use(szNameCopy); } }'
    );
    assert.ok(/^\s*char szNameCopy\[260\];/m.test(out.split('\n')[1] ?? ''), `sunk anyway:\n${out}`);
  });

  it('still sinks in a function with no frame-slot residue', () => {
    const out = transformCode('void f() { int x; while (c) { use(x); } }');
    assert.strictEqual(out, 'void f() {\n  while (c) {\n    int x;\n    use(x);\n  }\n}');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { declScopeSinkPlugin } from '../builtins/decl-scope-sink.js';
import { declInitMergePlugin } from '../builtins/decl-init-merge.js';

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

describe('declScopeSinkPlugin — loop back-edge liveness', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    return emit(declScopeSinkPlugin.createTransformer({})(ast) as AnyNode).trim();
  }

  function mergeThenSink(code: string): string {
    const ast = parse(code);
    const merged = declInitMergePlugin.createTransformer({})(ast);
    return emit(declScopeSinkPlugin.createTransformer({})(merged) as AnyNode).trim();
  }

  it('keeps a cursor assigned before a do-while outside the loop', () => {
    // Storm::SMem::SMemOneTimeInit (Game.exe 00411cd0). Sinking the cursor
    // resets it to the array base on every iteration, so element [0] is
    // initialised 256 times and [1..255] are left zeroed.
    const output = transformCode(
      'void f() { CRITICAL_SECTION* lpCriticalSection = DebugMemoryCriticalSection; int nCount = 0x100;'
      + ' do { InitializeCriticalSection(lpCriticalSection); lpCriticalSection = lpCriticalSection + 1;'
      + ' nCount = nCount + -1; } while (nCount != 0); }'
    );
    assert.strictEqual(
      output,
      'void f() {\n'
      + '  CRITICAL_SECTION* lpCriticalSection = DebugMemoryCriticalSection;\n'
      + '  int nCount = 0x100;\n'
      + '  do {\n'
      + '    InitializeCriticalSection(lpCriticalSection);\n'
      + '    lpCriticalSection = lpCriticalSection + 1;\n'
      + '    nCount = nCount + -1;\n'
      + '  } while (nCount != 0);\n'
      + '}'
    );
  });

  it('keeps the cursor out of the loop on the raw decompiler shape', () => {
    // What Ghidra actually emits: bare declarations at function top, the
    // assignment before the loop. decl-init-merge merges the two, and the sink
    // must not then carry the merged declaration into the body.
    const output = mergeThenSink(
      'void f() { CRITICAL_SECTION* lpCriticalSection; int nCount;'
      + ' lpCriticalSection = DebugMemoryCriticalSection; nCount = 0x100;'
      + ' do { InitializeCriticalSection(lpCriticalSection); lpCriticalSection = lpCriticalSection + 1;'
      + ' nCount = nCount + -1; } while (nCount != 0); }'
    );
    assert.strictEqual(
      output,
      'void f() {\n'
      + '  CRITICAL_SECTION* lpCriticalSection = DebugMemoryCriticalSection;\n'
      + '  int nCount = 0x100;\n'
      + '  do {\n'
      + '    InitializeCriticalSection(lpCriticalSection);\n'
      + '    lpCriticalSection = lpCriticalSection + 1;\n'
      + '    nCount = nCount + -1;\n'
      + '  } while (nCount != 0);\n'
      + '}'
    );
  });

  it('keeps a cursor advanced inside a for body outside the loop', () => {
    const output = transformCode('void f() { int* p = base; for (i = 0; i < n; i++) { use(p); p++; } }');
    assert.strictEqual(
      output,
      'void f() {\n  int* p = base;\n  for (i = 0; i < n; i++) {\n    use(p);\n    p++;\n  }\n}'
    );
  });

  it('keeps a cursor advanced inside a while body outside the loop', () => {
    const output = transformCode('void f() { int* p = base; while (c) { use(p); p = p + 1; } }');
    assert.strictEqual(
      output,
      'void f() {\n  int* p = base;\n  while (c) {\n    use(p);\n    p = p + 1;\n  }\n}'
    );
  });

  it('keeps an accumulator read before it is written outside the loop', () => {
    const output = transformCode('void f() { int total = 0; while (c) { total = total + step(); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int total = 0;\n  while (c) {\n    total = total + step();\n  }\n}'
    );
  });

  it('keeps a declaration out when only one path through the body writes it', () => {
    const output = transformCode('void f() { int v = 0; while (c) { if (d) { v = next(); } use(v); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int v = 0;\n  while (c) {\n    if (d) {\n      v = next();\n    }\n    use(v);\n  }\n}'
    );
  });

  it('still sinks a temporary that every iteration overwrites before reading', () => {
    const output = transformCode('void f() { int tmp; while (c) { tmp = next(); use(tmp); } }');
    assert.strictEqual(
      output,
      'void f() {\n  while (c) {\n    int tmp;\n    tmp = next();\n    use(tmp);\n  }\n}'
    );
  });

  it('still sinks an initialised declaration into an if branch', () => {
    // No back-edge, so nothing can observe a previous iteration's value.
    const output = transformCode('void f() { int x = get(); if (c) { use(x); x++; report(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  if (c) {\n    int x = get();\n    use(x);\n    x++;\n    report(x);\n  }\n}'
    );
  });
});

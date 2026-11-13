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

  it('keeps a call-initialised declaration out of the if branch that uses it', () => {
    // The call ran unconditionally; sunk, it runs only when `c` holds.
    const output = transformCode('void f() { int x = get(); if (c) { use(x); x++; report(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = get();\n  if (c) {\n    use(x);\n    x++;\n    report(x);\n  }\n}'
    );
  });

  it('keeps a buffer-filling call outside the branch that reads the buffer', () => {
    // D2Launch UIMENU_MainMenu (1.14d 004336c0). Sinking the SStrPrintf left
    // szVersionText uninitialised whenever bBUILD was 0, and the main menu
    // rendered stack residue instead of the version string.
    const output = transformCode(
      'void f() { char buf[64]; size_t n = SStrPrintf(buf, 64, "v"); '
      + 'if (ini->bBUILD) { SStrPrintf(buf + n, 64 - n, " %d", 71); } SetText(buf); }'
    );
    assert.match(output, /size_t n = SStrPrintf\(buf, 64, "v"\);\n\s+if \(ini->bBUILD\)/);
  });

  it('keeps a call-initialised declaration out of a loop body', () => {
    const output = transformCode('void f() { int x = get(); while (c) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = get();\n  while (c) {\n    use(x);\n  }\n}'
    );
  });

  it('keeps an assignment-initialised declaration where it is', () => {
    const output = transformCode('void f() { int x = (g = 1); if (c) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = g = 1;\n  if (c) {\n    use(x);\n  }\n}'
    );
  });

  it('keeps a call nested inside a larger initialiser expression where it is', () => {
    const output = transformCode('void f() { int x = base + get(); if (c) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = base + get();\n  if (c) {\n    use(x);\n  }\n}'
    );
  });

  it('still sinks a literal-initialised declaration into an if branch', () => {
    const output = transformCode('void f() { int x = 5; if (c) { use(x); x++; report(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  if (c) {\n    int x = 5;\n    use(x);\n    x++;\n    report(x);\n  }\n}'
    );
  });

  it('still sinks a plain read into an if branch', () => {
    const output = transformCode('void f() { int x = g_count; if (c) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  if (c) {\n    int x = g_count;\n    use(x);\n  }\n}'
    );
  });

  it('keeps a read whose source is overwritten before the sink site', () => {
    const output = transformCode('void f() { int x = g_count; g_count = 0; if (c) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = g_count;\n  g_count = 0;\n  if (c) {\n    use(x);\n  }\n}'
    );
  });

  it('keeps a read through a pointer that a crossed call may change', () => {
    // SCMD_0x38_NpcMenuSelect 0054bca0: the original loads the GUID before the call.
    const output = transformCode('void f(P* p) { int g = p->guid; int r = check(p); if (r == 0) { use(g, r); } }');
    assert.strictEqual(
      output,
      'void f(P* p) {\n  int g = p->guid;\n  int r = check(p);\n  if (r == 0) {\n    use(g, r);\n  }\n}'
    );
  });

  it('keeps a read through a pointer that a crossed store may change', () => {
    const output = transformCode('void f(P* p, P* q) { int g = p->guid; q->guid = 0; if (c) { use(g); } }');
    assert.strictEqual(
      output,
      'void f(P* p, P* q) {\n  int g = p->guid;\n  q->guid = 0;\n  if (c) {\n    use(g);\n  }\n}'
    );
  });

  it('still sinks a read through a pointer past pure statements', () => {
    const output = transformCode('void f(P* p) { int g = p->guid; int r = p->n + 1; if (r == 0) { use(g); } }');
    assert.strictEqual(
      output,
      'void f(P* p) {\n  int r = p->n + 1;\n  if (r == 0) {\n    int g = p->guid;\n    use(g);\n  }\n}'
    );
  });

  it('keeps a read whose source the if condition mutates', () => {
    const output = transformCode('void f() { int x = n; if (n++) { use(x); } }');
    assert.strictEqual(
      output,
      'void f() {\n  int x = n;\n  if (n++) {\n    use(x);\n  }\n}'
    );
  });
});

describe('declScopeSinkPlugin aliasing', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = declScopeSinkPlugin.createTransformer({});
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('should not sink a pointer read into a loop that stores through a pointer', () => {
    const output = transformCode(
      'void f() { Vtx* v2 = third->pNext; do { edge->pNext = fresh; use(v2); } while (1); }');
    assert.ok(output.includes('Vtx* v2 = third->pNext;\n  do'),
      `initializer must stay outside the loop, got:\n${output}`);
  });

  it('should not sink an array read into a loop that stores through a subscript', () => {
    const output = transformCode(
      'void f() { int n = table[i]; do { table[j] = 1; use(n); } while (1); }');
    assert.ok(output.includes('int n = table[i];\n  do'),
      `initializer must stay outside the loop, got:\n${output}`);
  });

  it('should still sink a pointer read into a loop that neither calls nor stores through a pointer', () => {
    const output = transformCode(
      'void f() { Vtx* v2 = third->pNext; do { n = n + v2->nX; } while (1); }');
    assert.ok(output.includes('do {\n    Vtx* v2 = third->pNext;'),
      `invariant read should still sink, got:\n${output}`);
  });

  // DRLGOUTROOM_PlaceAct5SpecialPresets 0067da70: the original reads pDrlgLevelData once,
  // before the loop; each iteration calls a function that is handed pLevel.
  it('should not sink a pointer read into a loop that calls', () => {
    const output = transformCode(
      'void f(Lvl* pLevel) { Wild* pWild = pLevel->pData; do { n = n + pWild->nW; Spawn(pLevel, n); } while (n < 9); }');
    assert.ok(/Wild\* pWild = pLevel->pData;\s*do \{/.test(output),
      `initializer must stay outside the loop, got:\n${output}`);
  });
});

describe('declScopeSinkPlugin pinned initialising store', () => {
  function transformCode(code: string): string {
    return emit(declScopeSinkPlugin.createTransformer({})(parse(code)) as AnyNode).trim();
  }

  // WndProcB 00451b30 as Ghidra prints it (after decl-init-merge): bHandled is zeroed
  // at entry, before HandleWinProcMsg, and its address goes to SMsgDispatchMessage.
  const WNDPROC = `LRESULT f(HWND hWnd, uint32_t uMsg, WPARAM wParam, LPARAM lParam) {
    BOOL bHandled = 0;
    HandleWinProcMsg(uMsg, wParam, lParam);
    BOOL nHandled = IsPlaybackActive();
    if (!nHandled || uMsg == 0x10) {
      nHandled = SMsgDispatchMessage(hWnd, uMsg, wParam, lParam, &bHandled, &r);
      if (nHandled && bHandled) { return r; }
    }
    return DefWindowProcA(hWnd, uMsg, wParam, lParam);
  }`;

  it('keeps an address-taken initialised local ahead of the calls it preceded', () => {
    const output = transformCode(WNDPROC);
    assert.ok(/\{\s*BOOL bHandled = 0;\s*HandleWinProcMsg/.test(output),
      `bHandled = 0 must stay at entry, got:\n${output}`);
  });

  it('keeps it ahead of a call in the if condition', () => {
    const output = transformCode('void f() { int x = 0; if (g()) { h(&x); } }');
    assert.ok(output.includes('int x = 0;\n  if (g())'), `got:\n${output}`);
  });

  it('keeps it out of a loop whose condition calls', () => {
    const output = transformCode('void f() { int x = 0; while (next()) { h(&x); } }');
    assert.ok(output.includes('int x = 0;\n  while'), `got:\n${output}`);
  });

  it('still sinks it when no call runs before the target', () => {
    const output = transformCode('void f() { int x = 0; if (c) { h(&x); } }');
    assert.ok(output.includes('if (c) {\n    int x = 0;'), `got:\n${output}`);
  });

  it('still sinks an initialised local whose address is never taken', () => {
    const output = transformCode('void f() { int x = 0; g(); if (c) { h(x); } }');
    assert.ok(output.includes('if (c) {\n    int x = 0;'), `got:\n${output}`);
  });

  it('still sinks an address-taken local that has no initialiser', () => {
    const output = transformCode('void f() { int x; g(); if (c) { h(&x); } }');
    assert.ok(output.includes('if (c) {\n    int x;'), `got:\n${output}`);
  });
});

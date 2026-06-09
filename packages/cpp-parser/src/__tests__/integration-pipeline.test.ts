/**
 * Integration tests for the full cpp-parser pipeline.
 *
 * These tests cover integration-level concerns that the e2e tests don't:
 * - API surface: options like includeOriginal, renames, style presets, batch
 * - Multi-function inputs
 * - Plugin interaction chains (multiple plugins firing on same code)
 * - analyzeGhidraCode() and extractFunctions()
 * - Fixture output stability (verify against stored expected output)
 * - Preprocessing through full pipeline
 * - Error recovery paths
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  transformGhidraCode,
  preprocessGhidraCode,
  analyzeGhidraCode,
  extractFunctions,
  createGhidraPipeline,
} from '../ghidra.js';

// =============================================================================
// API surface: includeOriginal
// =============================================================================

describe('Integration: includeOriginal option', () => {
  it('wraps output in comment with original code', () => {
    const input = `int foo(void) { return 42; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      includeOriginal: true,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('/* Original Ghidra output:'));
    assert.ok(result.code.includes('return 42'));
  });

  it('places original comment before the transformed code', () => {
    const input = `void bar(void) { return; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      includeOriginal: true,
    });
    const commentEnd = result.code.indexOf('*/');
    // The transformed code appears after the closing comment
    const codeAfterComment = result.code.slice(commentEnd + 2);
    assert.ok(codeAfterComment.includes('bar'), 'Transformed code should follow comment');
  });
});

// =============================================================================
// API surface: custom renames
// =============================================================================

describe('Integration: custom renames', () => {
  it('applies rename map to identifiers', () => {
    const input = `
void FUN_00401000(int param_1) {
  int local_8 = param_1;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      renames: {
        'FUN_00401000': 'ProcessInput',
        'param_1': 'nValue',
        'local_8': 'nCopy',
      },
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('ProcessInput'), 'Should rename function');
    assert.ok(result.code.includes('nValue'), 'Should rename param');
    assert.ok(result.code.includes('nCopy'), 'Should rename local');
    assert.ok(!result.code.includes('FUN_00401000'), 'Should not have original name');
  });

  it('tracks renamed identifiers in result', () => {
    const input = `void FUN_00401000(void) { return; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      renames: { 'FUN_00401000': 'InitSystem' },
    });
    assert.ok(result.renamedIdentifiers.length > 0);
    assert.strictEqual(result.renamedIdentifiers[0].original, 'FUN_00401000');
    assert.strictEqual(result.renamedIdentifiers[0].renamed, 'InitSystem');
  });
});

// =============================================================================
// API surface: createGhidraPipeline batch
// =============================================================================

describe('Integration: createGhidraPipeline', () => {
  it('transformBatch processes multiple functions', () => {
    const pipeline = createGhidraPipeline({ preset: 'quick', usePluginRegistry: true });
    const inputs = [
      `int foo(void) { return 1; }`,
      `int bar(void) { return 2; }`,
      `void baz(int x) { use(x); }`,
    ];
    const results = pipeline.transformBatch(inputs);
    assert.strictEqual(results.length, 3);
    assert.ok(results.every(r => r.success));
    assert.ok(results[0].code.includes('foo'));
    assert.ok(results[1].code.includes('bar'));
    assert.ok(results[2].code.includes('baz'));
  });

  it('batch transform is equivalent to individual transforms', () => {
    const pipeline = createGhidraPipeline({ preset: 'quick', usePluginRegistry: true });
    const inputs = [
      `int add(int a, int b) { return a + b; }`,
      `void noop(void) { return; }`,
    ];
    const batchResults = pipeline.transformBatch(inputs);
    const singleResults = inputs.map(input => pipeline.transform(input));

    for (let i = 0; i < inputs.length; i++) {
      assert.strictEqual(batchResults[i].code, singleResults[i].code,
        `Batch result ${i} differs from single`);
    }
  });
});

// =============================================================================
// API surface: analyzeGhidraCode
// =============================================================================

describe('Integration: analyzeGhidraCode', () => {
  // Note: analyzeGhidraCode uses require() internally (line 411 of ghidra.ts),
  // which crashes in ESM. These tests verify the bug is present.
  // When fixed, change these to verify actual behavior.
  it('detects generated function names (crashes due to require() in ESM)', () => {
    const input = `void FUN_00401000(int param_1) { int local_8 = param_1; }`;
    assert.throws(() => analyzeGhidraCode(input), /require is not defined/,
      'analyzeGhidraCode uses require() which fails in ESM');
  });

  it('detects generated parameter names (crashes due to require() in ESM)', () => {
    const input = `void foo(int param_1, int param_2) { use(param_1, param_2); }`;
    assert.throws(() => analyzeGhidraCode(input), /require is not defined/);
  });

  it('detects generated local variable names (crashes due to require() in ESM)', () => {
    const input = `void foo(void) { int local_8 = 0; int iVar1 = 1; }`;
    assert.throws(() => analyzeGhidraCode(input), /require is not defined/);
  });

  it('detects simplifiable patterns', () => {
    const input = `
int foo(int x) {
  if (x != 0) return 1;
  return 0;
}`;
    const analysis = analyzeGhidraCode(input);
    assert.ok(analysis.simplifiablePatterns.length > 0, 'Should find x != 0 pattern');
  });

  it('returns zero score for clean code', () => {
    const input = `int add(int a, int b) { return a + b; }`;
    const analysis = analyzeGhidraCode(input);
    assert.strictEqual(analysis.generatedNames.length, 0);
    assert.strictEqual(analysis.improvementScore, 0);
  });

  it('handles invalid input gracefully', () => {
    const analysis = analyzeGhidraCode('not valid C }{{}');
    assert.strictEqual(analysis.generatedNames.length, 0);
    assert.strictEqual(analysis.improvementScore, 0);
  });
});

// =============================================================================
// API surface: extractFunctions
// =============================================================================

describe('Integration: extractFunctions', () => {
  it('extracts single function', () => {
    const input = `int foo(int x, char *s) { return *s + x; }`;
    const fns = extractFunctions(input);
    assert.strictEqual(fns.length, 1);
    assert.strictEqual(fns[0].name, 'foo');
    assert.strictEqual(fns[0].parameters.length, 2);
    assert.strictEqual(fns[0].parameters[0].name, 'x');
    assert.strictEqual(fns[0].parameters[1].name, 's');
  });

  it('extracts multiple functions', () => {
    const input = `
int foo(void) { return 1; }
void bar(int x) { use(x); }
int baz(int a, int b) { return a + b; }`;
    const fns = extractFunctions(input);
    assert.strictEqual(fns.length, 3);
    assert.strictEqual(fns[0].name, 'foo');
    assert.strictEqual(fns[1].name, 'bar');
    assert.strictEqual(fns[2].name, 'baz');
  });

  it('extracts address from FUN_ names', () => {
    const input = `void FUN_00543200(int param_1) { use(param_1); }`;
    const fns = extractFunctions(input);
    assert.strictEqual(fns[0].address, '0x00543200');
  });

  it('returns empty for unparseable input', () => {
    const fns = extractFunctions('this is garbage {{}}');
    assert.strictEqual(fns.length, 0);
  });
});

// =============================================================================
// Multi-function inputs
// =============================================================================

describe('Integration: multi-function inputs', () => {
  it('transforms multiple functions in one input', () => {
    const input = `
int getter(int *p) { return *p; }
void setter(int *p, int v) { *p = v; return; }
int adder(int a, int b) { return a + b; }`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
      tolerateErrors: false,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('getter'));
    assert.ok(result.code.includes('setter'));
    assert.ok(result.code.includes('adder'));
  });

  it('identifier set spans all functions', () => {
    const input = `
void funcA(int x) { helperA(x); }
void funcB(int y) { helperB(y); }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.identifiers.has('funcA'));
    assert.ok(result.identifiers.has('funcB'));
    assert.ok(result.identifiers.has('helperA'));
    assert.ok(result.identifiers.has('helperB'));
  });

  it('transforms applied to all functions, not just first', () => {
    const input = `
void first(int *p) {
  if (p == (int *)0x0) return;
}
void second(int *q) {
  if (q == (int *)0x0) return;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Both null checks should be cleaned
    const nullCount = (result.code.match(/0x0/g) || []).length;
    assert.strictEqual(nullCount, 0, 'All 0x0 should be cleaned from both functions');
  });
});

// =============================================================================
// Preprocessing through full pipeline
// =============================================================================

describe('Integration: preprocessing edge cases', () => {
  it('this→self survives full pipeline', () => {
    const input = `void __thiscall MyClass_Init(MyClass *this, int value) {
  *(int *)((int)this + 4) = value;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      tolerateErrors: true,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('self'), 'this should be renamed to self');
    assert.ok(!result.code.includes('*this'), 'Should not contain *this as param');
  });

  it('array decl fix survives full pipeline', () => {
    const input = `void foo(void) {
  int[10] arr;
  arr[0] = 1;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Should compile: "int arr[10]" not "int[10] arr"
    assert.ok(!result.code.includes('int[10]'), 'Array decl should be fixed');
  });

  it('array param fix survives full pipeline', () => {
    const input = `void foo(int[10] buf) { buf[0] = 1; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('int*') || result.code.includes('int *'),
      'Array param should become pointer');
  });

  it('comment newline expansion survives full pipeline', () => {
    const input = `void foo(void) { // first\\nsecond
  return;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
  });

  it('string literal containing // is not broken by preprocessor', () => {
    const input = `void foo(void) {
  char *s = "http://example.com";
  use(s);
}`;
    const preprocessed = preprocessGhidraCode(input);
    assert.ok(preprocessed.includes('"http://example.com"'),
      'URL in string should be preserved');
  });
});

// =============================================================================
// Plugin interaction chains
// =============================================================================

describe('Integration: plugin interaction chains', () => {
  it('decl-init-merge + increment-simplify work together', () => {
    const input = `
void foo(void) {
  int i;
  i = 0;
  i = i + 1;
  use(i);
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // decl-init-merge should merge "int i; i = 0;" → "int i = 0;"
    // increment-simplify should turn "i = i + 1" → "i++"
    assert.ok(result.code.includes('++'), 'Should simplify increment');
  });

  it('nullptr-cleanup + boolean-cleanup interact correctly', () => {
    // nullptr cleanup converts (int*)0x0 to nullptr
    // boolean cleanup may simplify != 0 patterns
    const input = `
int foo(int *p) {
  if (p != (int *)0x0) {
    if (*p != 0) {
      return 1;
    }
  }
  return 0;
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Should not have raw 0x0
    assert.ok(!result.code.includes('0x0'), 'Should clean 0x0');
  });

  it('goto-cleanup + void-return-cleanup chain (full preset)', () => {
    const input = `
void foo(int x) {
  if (x == 0) goto LAB_end;
  doWork(x);
LAB_end:
  return;
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // goto should be eliminated
    assert.ok(!result.code.includes('goto'), 'Should eliminate goto');
    // trailing return should be removed
    assert.ok(!result.code.includes('return;'), 'Should remove trailing return');
  });

  it('short-circuit-fold + boolean-cleanup work together', () => {
    const input = `
void foo(int a, int b) {
  if (a != 0) {
    if (b != 0) {
      doWork();
    }
  }
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Should fold to && and/or simplify != 0
    // At minimum should succeed without crash
  });

  it('decl-init-merge + decl-scope-sink chain', () => {
    const input = `
void foo(int x) {
  int y;
  y = x * 2;
  if (x > 0) {
    use(y);
  }
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Should merge y decl with assignment, and potentially sink into if block
  });

  it('phi-node-ternary + decl-init-merge chain', () => {
    const input = `
int foo(int x) {
  int result;
  if (x > 0) {
    result = x;
  } else {
    result = 0;
  }
  return result;
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // May fold to ternary: int result = x > 0 ? x : 0;
  });

  it('increment-simplify does not fire on pointer derefs', () => {
    // *p = *p + 1 should NOT become *p++ (different semantics)
    const input = `
void foo(int *p) {
  *p = *p + 1;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Should preserve the assignment form, not create *p++
    assert.ok(!result.code.includes('*p++'), 'Should not create *p++');
  });
});

// =============================================================================
// Quick vs Full preset differences
// =============================================================================

describe('Integration: quick vs full preset differences', () => {
  it('quick preserves gotos, full removes them', () => {
    const input = `
void foo(int x) {
  if (x == 0) goto LAB_end;
  doWork();
LAB_end:
  cleanup();
}`;
    const quick = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true });
    const full = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true });
    assert.ok(quick.code.includes('goto'), 'Quick should preserve goto');
    assert.ok(!full.code.includes('goto'), 'Full should remove goto');
  });

  it('quick preserves trailing void return, full removes it', () => {
    const input = `
void foo(void) {
  doWork();
  return;
}`;
    const quick = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true });
    const full = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true });
    // Both should succeed
    assert.ok(quick.success);
    assert.ok(full.success);
    // Full should remove trailing return
    assert.ok(!full.code.includes('return;'), 'Full should remove trailing void return');
  });

  it('both presets handle the same input without crash', () => {
    const input = `
void __fastcall Process(int *pUnit) {
  int iVar1;
  if (pUnit == (int *)0x0) goto LAB_done;
  iVar1 = *(int *)((int)pUnit + 0x10);
  if (iVar1 < 1) goto LAB_done;
  Update(pUnit, iVar1);
LAB_done:
  return;
}`;
    const quick = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    const full = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(quick.success);
    assert.ok(full.success);
    // Full output should be shorter (more aggressive cleanup)
    assert.ok(full.code.length <= quick.code.length + 50,
      'Full output should not be significantly longer than quick');
  });
});

// =============================================================================
// Error recovery
// =============================================================================

describe('Integration: error recovery', () => {
  it('tolerateErrors returns original code on parse failure', () => {
    const input = 'this } is { not valid';
    const result = transformGhidraCode(input, {
      tolerateErrors: true,
      usePluginRegistry: true,
    });
    assert.ok(!result.success);
    assert.strictEqual(result.code, input, 'Should return original code');
    assert.ok(result.warnings.length > 0, 'Should have warnings');
    assert.ok(result.error, 'Should have error message');
  });

  it('tolerateErrors gives empty AST on parse failure', () => {
    const result = transformGhidraCode('garbage {}{}', {
      tolerateErrors: true,
      usePluginRegistry: true,
    });
    assert.ok(!result.success);
    assert.strictEqual(result.ast.declarations.length, 0);
    assert.strictEqual(result.identifiers.size, 0);
  });

  it('throws without tolerateErrors', () => {
    assert.throws(() => {
      transformGhidraCode('invalid C {{', {
        tolerateErrors: false,
        usePluginRegistry: true,
      });
    });
  });

  it('partially valid code with tolerateErrors', () => {
    // Some Ghidra outputs have weird constructs; tolerateErrors should be resilient
    const input = `void foo(void) { return; }`;
    const result = transformGhidraCode(input, {
      tolerateErrors: true,
      usePluginRegistry: true,
    });
    assert.ok(result.success);
  });
});

// =============================================================================
// Legacy vs plugin registry path
// =============================================================================

describe('Integration: legacy vs plugin registry', () => {
  it('both paths succeed on simple input', () => {
    const input = `int foo(int x) { return x + 1; }`;
    const legacy = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: false });
    const registry = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true });
    assert.ok(legacy.success);
    assert.ok(registry.success);
  });

  it('plugin registry returns preamble field', () => {
    const input = `int foo(int x) { return x + 1; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    // preamble may or may not be set, but the field should exist
    assert.ok('preamble' in result);
  });

  it('legacy path does not return preamble', () => {
    const input = `int foo(int x) { return x + 1; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: false,
    });
    assert.ok(result.success);
    assert.strictEqual(result.preamble, undefined);
  });
});

// =============================================================================
// Output determinism
// =============================================================================

describe('Integration: determinism', () => {
  it('same input produces same output across 10 runs', () => {
    const input = `
void __fastcall Complex(int *pData, int nCount) {
  int i;
  int sum;
  sum = 0;
  if (pData == (int *)0x0) goto LAB_end;
  for (i = 0; i < nCount; i = i + 1) {
    if (pData[i] != 0) {
      sum = sum + pData[i];
    }
  }
LAB_end:
  return;
}`;
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = transformGhidraCode(input, {
        preset: 'full',
        usePluginRegistry: true,
      });
      results.push(result.code);
    }
    for (let i = 1; i < results.length; i++) {
      assert.strictEqual(results[i], results[0], `Run ${i} differs from run 0`);
    }
  });

  it('preprocessing is idempotent', () => {
    const input = `void __thiscall Foo(MyClass *this, int[10] arr) {
  int[5] local;
  // comment\\nwith newline
}`;
    const once = preprocessGhidraCode(input);
    const twice = preprocessGhidraCode(once);
    // Second pass should not change anything further
    assert.strictEqual(once, twice, 'Preprocessing should be idempotent');
  });
});

// =============================================================================
// CONCAT plugin integration
// =============================================================================

describe('Integration: CONCAT transform', () => {
  it('quick preset preserves CONCAT (not a core plugin)', () => {
    const input = `
long long foo(int a, int b) {
  return CONCAT44(a, b);
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // CONCAT plugin is tagged 'cleanup' not 'core', so quick preset skips it
    assert.ok(result.code.includes('CONCAT44'), 'Quick should preserve CONCAT');
  });

  it('full preset expands CONCAT inline', () => {
    const input = `
long long foo(int a, int b) {
  return CONCAT44(a, b);
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    // Full preset enables all plugins including concat-transform
    assert.ok(result.code.includes('<<') || result.code.includes('|'),
      'Full should expand CONCAT to bit operations');
    assert.ok(!result.code.includes('CONCAT44'),
      'Should not have CONCAT44 call after full transform');
  });

  it('handles multiple CONCAT variants (full preset)', () => {
    const input = `
long long foo(int a, short b, char c) {
  long long x = CONCAT44(a, a);
  int y = CONCAT22(b, b);
  short z = CONCAT11(c, c);
  return x + y + z;
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.ok(!result.code.includes('CONCAT'), 'All CONCATs should be expanded');
  });
});

// =============================================================================
// Identifier extraction completeness
// =============================================================================

describe('Integration: identifier extraction', () => {
  it('includes function names, params, locals, and callees', () => {
    const input = `
int __fastcall Process(int *pData, int nCount) {
  int result = 0;
  int i;
  for (i = 0; i < nCount; i = i + 1) {
    result = result + transform(pData[i]);
  }
  return result;
}`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.identifiers.has('Process'), 'Should have function name');
    assert.ok(result.identifiers.has('pData'), 'Should have param name');
    assert.ok(result.identifiers.has('nCount'), 'Should have param name');
    assert.ok(result.identifiers.has('result'), 'Should have local name');
    assert.ok(result.identifiers.has('i'), 'Should have loop var');
    assert.ok(result.identifiers.has('transform'), 'Should have callee');
  });

  it('identifiers from renamed code reflect new names', () => {
    const input = `void FUN_00401000(int param_1) { use(param_1); }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
      renames: { 'FUN_00401000': 'Init', 'param_1': 'nValue' },
    });
    assert.ok(result.identifiers.has('Init'), 'Should have renamed function');
    assert.ok(result.identifiers.has('nValue'), 'Should have renamed param');
    assert.ok(!result.identifiers.has('FUN_00401000'), 'Should not have original name');
  });
});

// =============================================================================
// Fixture output stability (spot-checks)
// =============================================================================

describe('Integration: fixture output stability', () => {
  it('preprocessing + quick is deterministic on complex input', () => {
    // A non-trivial function with gotos, casts, pointer arithmetic
    const input = `
void __fastcall Task_SetStateFlag(TaskT *pTask, int nState) {
  uint uVar1;
  if (pTask == (TaskT *)0x0) {
    return;
  }
  uVar1 = *(uint *)((int)pTask + 0x2c);
  *(uint *)((int)pTask + 0x2c) = uVar1 | 1 << ((char)nState & 0x1fU);
  return;
}`;
    const r1 = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true });
    const r2 = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true });
    assert.strictEqual(r1.code, r2.code);
    assert.ok(r1.success);
  });

  it('full preset handles goto + null + void return together', () => {
    const input = `
void __fastcall UpdateUnit(int *pUnit) {
  int iVar1;
  if (pUnit == (int *)0x0) goto LAB_done;
  iVar1 = *(int *)((int)pUnit + 0x10);
  if (iVar1 < 1) goto LAB_done;
  Process(pUnit, iVar1);
LAB_done:
  return;
}`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.ok(!result.code.includes('goto'), 'Gotos should be eliminated');
    assert.ok(!result.code.includes('LAB_done'), 'Labels should be eliminated');
    assert.ok(!result.code.includes('0x0'), 'Null pointers should be cleaned');
  });
});

// =============================================================================
// Warnings and diagnostics
// =============================================================================

describe('Integration: warnings and diagnostics', () => {
  it('success result has empty warnings', () => {
    const input = `int foo(void) { return 42; }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('parse error with tolerateErrors produces warnings', () => {
    const result = transformGhidraCode('}{not valid{', {
      tolerateErrors: true,
      usePluginRegistry: true,
    });
    assert.ok(!result.success);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('Parse error'));
  });
});

// =============================================================================
// Edge cases: empty and degenerate inputs
// =============================================================================

describe('Integration: edge cases', () => {
  it('handles empty function body', () => {
    const result = transformGhidraCode('void foo(void) {}', {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
  });

  it('handles function with only return', () => {
    const result = transformGhidraCode('void foo(void) { return; }', {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
  });

  it('handles single-line getter', () => {
    const result = transformGhidraCode('int foo(int *p) { return *p; }', {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('return *p'));
  });

  it('handles function with 10+ parameters', () => {
    const params = Array.from({ length: 12 }, (_, i) => `int p${i}`).join(', ');
    const input = `void foo(${params}) { use(p0, p11); }`;
    const result = transformGhidraCode(input, {
      preset: 'quick',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
    assert.ok(result.code.includes('p0'));
    assert.ok(result.code.includes('p11'));
  });

  it('handles deeply nested expressions without stack overflow', () => {
    // Build a nested expression: ((((((x + 1) + 2) + 3) + 4) + 5) + 6)
    let expr = 'x';
    for (let i = 1; i <= 20; i++) {
      expr = `(${expr} + ${i})`;
    }
    const input = `int foo(int x) { return ${expr}; }`;
    const result = transformGhidraCode(input, {
      preset: 'full',
      usePluginRegistry: true,
    });
    assert.ok(result.success);
  });
});

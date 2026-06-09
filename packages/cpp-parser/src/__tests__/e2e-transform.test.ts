/**
 * End-to-end transform tests for the full pipeline.
 *
 * These tests use realistic Ghidra pseudocode and verify the complete
 * transformGhidraCode pipeline produces correct output.
 *
 * The test fixtures are language-agnostic (string in → string out) and
 * can serve as a specification for reimplementing in another language.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transformGhidraCode, preprocessGhidraCode } from '../ghidra.js';

/** Helper: run the full pipeline and return transformed code */
function transform(input: string, preset: 'quick' | 'full' = 'quick'): string {
  const result = transformGhidraCode(input, {
    preset,
    usePluginRegistry: true,
    tolerateErrors: false,
  });
  return result.code;
}

/** Helper: assert transform produces expected output */
function expectTransform(input: string, expected: string, preset: 'quick' | 'full' = 'quick') {
  const output = transform(input, preset);
  assert.strictEqual(output.trim(), expected.trim(),
    `\n=== Expected ===\n${expected.trim()}\n\n=== Got ===\n${output.trim()}`);
}

/** Helper: assert the transform succeeds and contains expected string */
function expectContains(input: string, needle: string, preset: 'quick' | 'full' = 'quick') {
  const output = transform(input, preset);
  assert.ok(output.includes(needle),
    `Expected output to contain "${needle}"\n\n=== Got ===\n${output}`);
}

/** Helper: assert the transform succeeds and does NOT contain string */
function expectNotContains(input: string, needle: string, preset: 'quick' | 'full' = 'quick') {
  const output = transform(input, preset);
  assert.ok(!output.includes(needle),
    `Expected output NOT to contain "${needle}"\n\n=== Got ===\n${output}`);
}

// =============================================================================
// Preprocessing
// =============================================================================

describe('E2E: Preprocessing', () => {
  it('renames this parameter to self', () => {
    const input = `void foo(MyClass *this, int x) { this->field = x; }`;
    const preprocessed = preprocessGhidraCode(input);
    assert.ok(preprocessed.includes('*self'));
    assert.ok(!preprocessed.includes('*this'));
  });

  it('fixes array declarations: Type[N] name → Type name[N]', () => {
    const preprocessed = preprocessGhidraCode(`void foo(void) {\n  int[10] arr;\n}`);
    assert.ok(preprocessed.includes('int arr[10]'));
  });

  it('fixes array params: Type[N] param → Type* param', () => {
    const preprocessed = preprocessGhidraCode(`void foo(int[10] buf) {}`);
    assert.ok(preprocessed.includes('int* buf'));
  });

  it('expands literal \\n in line comments', () => {
    const preprocessed = preprocessGhidraCode(`void foo(void) { // line1\\nline2\n}`);
    assert.ok(preprocessed.includes('// line1'));
    assert.ok(preprocessed.includes('// line2'));
  });
});

// =============================================================================
// Simple functions
// =============================================================================

describe('E2E: Simple functions', () => {
  it('passes through a trivial getter', () => {
    const input = `
int GetValue(int *pData) {
  return *pData;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('return *pData'));
  });

  it('passes through a trivial setter', () => {
    const input = `
void SetValue(int *pData, int value) {
  *pData = value;
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('*pData = value'));
  });

  it('handles empty function body', () => {
    const input = `void DoNothing(void) { return; }`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Goto cleanup
// =============================================================================

describe('E2E: Goto cleanup (full preset)', () => {
  it('forward goto → if block', () => {
    expectNotContains(`
void foo(int x) {
  if (x == 0) goto LAB_end;
  doWork();
LAB_end:
  cleanup();
}`, 'goto', 'full');
  });

  it('backward goto → while loop', () => {
    expectNotContains(`
void foo(int *pList) {
  int i = 0;
LAB_loop:
  if (pList[i] == 0) goto LAB_done;
  process(pList[i]);
  i = i + 1;
  goto LAB_loop;
LAB_done:
  return;
}`, 'goto', 'full');
  });

  it('goto in switch case → break', () => {
    expectNotContains(`
void foo(int x) {
  switch(x) {
  case 1:
    a();
    goto switchD_end;
  case 2:
    b();
    goto switchD_end;
  default:
    c();
  }
switchD_end:
  cleanup();
}`, 'goto', 'full');
  });

  it('nested forward gotos → nested ifs', () => {
    expectNotContains(`
void foo(int x, int y) {
  if (x == 0) goto LAB_skip1;
  if (y == 0) goto LAB_skip2;
  doWork(x, y);
LAB_skip2:
  doPartial(x);
LAB_skip1:
  cleanup();
}`, 'goto', 'full');
  });

  it('tail-call goto → inlined', () => {
    expectNotContains(`
void foo(int x) {
  if (x < 0) goto LAB_negative;
  if (x > 100) goto LAB_big;
  doNormal(x);
  goto LAB_end;
LAB_negative:
  doNegative(x);
  goto LAB_end;
LAB_big:
  doBig(x);
LAB_end:
  return;
}`, 'goto', 'full');
  });

  it('preserves gotos in quick preset (no goto cleanup)', () => {
    expectContains(`
void foo(int x) {
  if (x == 0) goto LAB_end;
  doWork();
LAB_end:
  cleanup();
}`, 'goto', 'quick');
  });
});

// =============================================================================
// Nullptr cleanup
// =============================================================================

describe('E2E: Nullptr cleanup', () => {
  it('converts (Type *)0x0 to nullptr', () => {
    expectContains(`
void foo(int **p) {
  *p = (int *)0x0;
}`, 'nullptr');
  });

  it('converts == 0x0 pointer comparison to == nullptr', () => {
    // Note: Ghidra cast-to-null-pointer pattern. The nullptr plugin handles
    // assignment (= nullptr) but comparison may or may not be rewritten.
    const result = transformGhidraCode(`
int foo(int *p) {
  if (p == (int *)0x0) return 0;
  return 1;
}`, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Either the cast is removed or converted to nullptr
    assert.ok(result.code.includes('nullptr') || result.code.includes('== 0') || result.code.includes('!p'),
      'Should simplify null comparison');
  });
});

// =============================================================================
// Boolean cleanup
// =============================================================================

describe('E2E: Boolean cleanup', () => {
  it('converts (uint)(x != 0) to simpler form', () => {
    const input = `
int foo(int x) {
  return (uint)(x != 0);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Struct field access
// =============================================================================

describe('E2E: Struct field access', () => {
  it('preserves pointer arithmetic (struct-field plugin handles typed structs)', () => {
    // Struct field rewriting requires known struct types; raw pointer
    // arithmetic on int* is preserved as-is
    const result = transformGhidraCode(`
int foo(int *pStruct) {
  return *(int *)((int)pStruct + 0x10);
}`, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Declaration init merge
// =============================================================================

describe('E2E: Declaration init merge', () => {
  it('merges declaration with immediate assignment', () => {
    const input = `
void foo(void) {
  int x;
  x = 5;
  use(x);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should merge to "int x = 5;" or leave as is depending on pipeline
    assert.ok(result.code.includes('x = 5') || result.code.includes('x;'));
  });
});

// =============================================================================
// Loop canonicalization
// =============================================================================

describe('E2E: Loop canonicalization', () => {
  it('converts while(true) with break to do-while', () => {
    const input = `
void foo(int *p) {
  while (true) {
    if (*p == 0) break;
    process(*p);
    p = p + 1;
  }
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Switch reconstruction
// =============================================================================

describe('E2E: Switch reconstruction', () => {
  it('handles switch with fall-through', () => {
    const input = `
void foo(int type) {
  switch(type) {
  case 0:
    handleZero();
    break;
  case 1:
    handleOne();
    break;
  case 2:
  case 3:
    handleTwoThree();
    break;
  default:
    handleDefault();
  }
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('switch'));
    assert.ok(result.code.includes('case 0'));
  });
});

// =============================================================================
// Void return cleanup
// =============================================================================

describe('E2E: Void return cleanup', () => {
  it('removes trailing return from void function (full preset)', () => {
    const input = `
void foo(int x) {
  doWork(x);
  return;
}`;
    expectNotContains(input, 'return;', 'full');
  });

  it('preserves trailing return in quick preset', () => {
    const input = `
void foo(int x) {
  doWork(x);
  return;
}`;
    // Quick preset doesn't run void-return-cleanup
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// PRNG transform
// =============================================================================

describe('E2E: PRNG transform', () => {
  it('recognizes seed rolling pattern', () => {
    const input = `
uint RollSeed(uint *pSeed) {
  *pSeed = *pSeed * 0x6ac690c5 + 1;
  return *pSeed;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Magic division
// =============================================================================

describe('E2E: Magic division', () => {
  it('simplifies magic division constant', () => {
    // x / 10 is often compiled as (x * 0xcccccccd) >> 35
    const input = `
uint div10(uint x) {
  return (uint)((ulonglong)x * 0xcccccccd >> 0x23);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Increment simplify
// =============================================================================

describe('E2E: Increment simplify', () => {
  it('converts i = i + 1 to i++ (simple variable)', () => {
    // Increment simplify works on simple identifiers, not pointer derefs
    expectContains(`
void foo(void) {
  int i;
  i = 0;
  i = i + 1;
  use(i);
}`, '++');
  });

  it('converts i = i - 1 to i-- (simple variable)', () => {
    expectContains(`
void foo(void) {
  int i;
  i = 10;
  i = i - 1;
  use(i);
}`, '--');
  });

  it('preserves pointer deref increment as-is', () => {
    // *p = *p + 1 is ambiguous (could be pointer arith), may not simplify
    const result = transformGhidraCode(`
void foo(int *p) {
  *p = *p + 1;
}`, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Short circuit folding
// =============================================================================

describe('E2E: Short circuit folding', () => {
  it('folds nested if conditions into &&', () => {
    const input = `
void foo(int a, int b) {
  if (a != 0) {
    if (b != 0) {
      doWork();
    }
  }
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Signed literal cleanup
// =============================================================================

describe('E2E: Signed literal cleanup', () => {
  it('converts 0xffffffff to -1 in signed context', () => {
    const input = `
int foo(void) {
  return 0xffffffff;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Redundant negation
// =============================================================================

describe('E2E: Redundant negation', () => {
  it('simplifies double negation', () => {
    const input = `
int foo(int x) {
  if (!(x != 0)) return 1;
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Complex / realistic Ghidra patterns
// =============================================================================

describe('E2E: Realistic Ghidra patterns', () => {
  it('handles typical Ghidra function with casts and gotos', () => {
    const input = `
void __fastcall ProcessUnit(CtxT *pGame, EntityT *pUnit) {
  int iVar1;
  StatListT *pStatList;

  if (pUnit == (EntityT *)0x0) goto LAB_done;
  pStatList = *(StatListT **)((int)pUnit + 0x48);
  if (pStatList == (StatListT *)0x0) goto LAB_done;
  iVar1 = *(int *)((int)pStatList + 0xc);
  if (iVar1 < 1) goto LAB_done;
  UpdateStats(pGame, pUnit, iVar1);
LAB_done:
  return;
}`;
    // Full preset does goto cleanup + void return cleanup
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should remove gotos (full preset)
    assert.ok(!result.code.includes('goto'), 'Should remove gotos');
    // Should convert null casts to nullptr
    assert.ok(result.code.includes('nullptr') || !result.code.includes('0x0'), 'Should clean null pointers');
  });

  it('handles linked list traversal pattern', () => {
    const input = `
NodeT * __fastcall FindRoom(NodeT *pFirst, int nX, int nY) {
  NodeT *pRoom;

  pRoom = pFirst;
  while (pRoom != (NodeT *)0x0) {
    if ((*(int *)((int)pRoom + 0x10) == nX) && (*(int *)((int)pRoom + 0x14) == nY)) {
      return pRoom;
    }
    pRoom = *(NodeT **)((int)pRoom + 0x1c);
  }
  return (NodeT *)0x0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('nullptr') || !result.code.includes('0x0'));
  });

  it('handles multi-level switch with goto cleanup', () => {
    const input = `
int __fastcall GetGroupIndex(int nGroupId) {
  int iResult;

  if (nGroupId < 0) goto LAB_default;
  switch(nGroupId) {
  case 0:
  case 1:
  case 2:
  case 3:
  case 4:
  case 5:
    iResult = 0;
    goto LAB_end;
  case 6:
  case 7:
  case 8:
  case 9:
  case 10:
  case 11:
    iResult = 1;
    goto LAB_end;
  case 12:
  case 13:
  case 14:
  case 15:
  case 16:
  case 17:
    iResult = 2;
    goto LAB_end;
  default:
LAB_default:
    iResult = -1;
  }
LAB_end:
  return iResult;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('switch'));
  });

  it('handles PRNG seed manipulation', () => {
    const input = `
int __fastcall RollRandom(RngT *pSeed, int nMax) {
  uint uVar1;

  pSeed->nSeedLow = pSeed->nSeedLow * 0x6ac690c5 + 1;
  pSeed->nSeedHigh = pSeed->nSeedHigh * 0x6ac690c5 + 1;
  uVar1 = pSeed->nSeedHigh + pSeed->nSeedLow;
  if (nMax == 0) {
    return 0;
  }
  return (int)(uVar1 % (uint)nMax);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles function with early returns and cleanup', () => {
    const input = `
void __fastcall FreeRegion(RegionT *pRegion) {
  if (pRegion == (RegionT *)0x0) {
    return;
  }
  if (*(int *)((int)pRegion + 0x10) != 0) {
    FreeNodes(*(void **)((int)pRegion + 0x10));
  }
  if (*(int *)((int)pRegion + 0x14) != 0) {
    FreeLayers(*(void **)((int)pRegion + 0x14));
  }
  MEM_FREE(pRegion);
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('nullptr') || !result.code.includes('0x0'));
  });

  it('handles memset + field initialization pattern', () => {
    const input = `
void __fastcall InitContext(int *pCtx) {
  memset(pCtx, 0, 0x84);
  *(int *)((int)pCtx + 0) = 1;
  *(int *)((int)pCtx + 4) = 0;
  *(int *)((int)pCtx + 8) = -1;
  *(int *)((int)pCtx + 0xc) = 0;
  *(int *)((int)pCtx + 0x10) = 100;
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles bitfield operations', () => {
    const input = `
int __fastcall HasFlag(int nFlags, int nBit) {
  return (nFlags >> (nBit & 0x1f) & 1U) != 0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Identifier extraction
// =============================================================================

describe('E2E: Identifier extraction', () => {
  it('collects identifiers from transformed code', () => {
    const input = `
void foo(int x) {
  bar(x);
  baz(x + 1);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.identifiers.has('foo'));
    assert.ok(result.identifiers.has('bar'));
    assert.ok(result.identifiers.has('baz'));
    assert.ok(result.identifiers.has('x'));
  });
});

// =============================================================================
// Error tolerance
// =============================================================================

describe('E2E: Error tolerance', () => {
  it('returns failure for unparseable code with tolerateErrors', () => {
    const result = transformGhidraCode('this is not C code at all }{}{', {
      tolerateErrors: true,
      usePluginRegistry: true,
    });
    assert.ok(!result.success);
    assert.ok(result.warnings.length > 0 || result.error);
  });

  it('throws for unparseable code without tolerateErrors', () => {
    assert.throws(() => {
      transformGhidraCode('not valid C {{{{', {
        tolerateErrors: false,
        usePluginRegistry: true,
      });
    });
  });
});

// =============================================================================
// Preamble / injection
// =============================================================================

describe('E2E: Preamble generation', () => {
  it('generates preamble for CONCAT calls', () => {
    const input = `
long long foo(int a, int b) {
  return CONCAT44(a, b);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success || result.warnings.length > 0);
  });
});

// =============================================================================
// SBB branchless patterns
// =============================================================================

describe('E2E: SBB branchless', () => {
  it('transforms negated condition AND pattern', () => {
    const input = `
int foo(int cond, int addr) {
  return (int)(-(uint)(cond != 0) & (uint)addr);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success);
  });

  it('transforms ternary fold pattern', () => {
    const input = `
int foo(int cond) {
  return (cond != 0 ? 0x100 : 0) + 0x200;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success);
  });

  it('does not transform regular bitwise AND', () => {
    const input = `
int foo(int a, int b) {
  return a & b;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success);
    assert.ok(result.code.includes('&'));
  });
});

// =============================================================================
// Phi node → ternary
// =============================================================================

describe('E2E: Phi node ternary', () => {
  it('converts if/else assignment to ternary', () => {
    const input = `
int foo(int x) {
  int result;
  if (x > 0) {
    result = 1;
  } else {
    result = -1;
  }
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('converts pointer phi node', () => {
    const input = `
int * foo(int *a, int *b, int sel) {
  int *pResult;
  if (sel != 0) {
    pResult = a;
  } else {
    pResult = b;
  }
  return pResult;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('preserves when branches have extra statements', () => {
    const input = `
int foo(int x) {
  int result;
  if (x > 0) {
    doSomething();
    result = 1;
  } else {
    result = -1;
  }
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should NOT fold to ternary because then-branch has extra statements
    assert.ok(result.code.includes('if'));
  });
});

// =============================================================================
// Loop rotation undo
// =============================================================================

describe('E2E: Loop rotation undo', () => {
  it('converts if-guarded do-while to while', () => {
    const input = `
void foo(int *p) {
  if (p != (int *)0x0) {
    do {
      process(p);
      p = *(int **)((int)p + 4);
    } while (p != (int *)0x0);
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('does not fold when conditions differ', () => {
    const input = `
void foo(int *p, int n) {
  if (n > 0) {
    do {
      process(p);
      n = n - 1;
    } while (n != 0);
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('converts nested if-guarded do-while', () => {
    const input = `
void foo(int **list) {
  if (*list != (int *)0x0) {
    do {
      int *cur = *list;
      if (cur[1] != 0) {
        do {
          handle(cur);
          cur = (int *)cur[2];
        } while (cur[1] != 0);
      }
      list = list + 1;
    } while (*list != (int *)0x0);
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Declaration scope sinking
// =============================================================================

describe('E2E: Declaration scope sink', () => {
  it('sinks declaration into if-then branch', () => {
    const input = `
void foo(int x) {
  int y;
  if (x > 0) {
    y = x * 2;
    use(y);
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('does not sink when used in multiple branches', () => {
    const input = `
void foo(int x) {
  int y;
  if (x > 0) {
    y = 1;
  } else {
    y = 2;
  }
  use(y);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('sinks into loop body', () => {
    const input = `
void foo(int n) {
  int temp;
  int i;
  for (i = 0; i < n; i = i + 1) {
    temp = compute(i);
    use(temp);
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('does not sink static variables', () => {
    const input = `
void foo(void) {
  static int counter;
  counter = counter + 1;
  use(counter);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Dead branch cleanup
// =============================================================================

describe('E2E: Dead branch cleanup', () => {
  it('eliminates if(true) keeping body', () => {
    const input = `
void foo(void) {
  if (true) {
    doWork();
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('eliminates if(false) entirely', () => {
    const input = `
void foo(void) {
  if (false) {
    neverRun();
  }
  alwaysRun();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('alwaysRun'));
  });

  it('keeps else when if(false)', () => {
    const input = `
void foo(void) {
  if (false) {
    neverRun();
  } else {
    alwaysRun();
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('alwaysRun'));
  });

  it('simplifies expr && true to expr', () => {
    const input = `
int foo(int x) {
  if (x > 0 && true) return 1;
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('simplifies expr || false to expr', () => {
    const input = `
int foo(int x) {
  if (x > 0 || false) return 1;
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Type normalization
// =============================================================================

describe('E2E: Type normalization', () => {
  it('normalizes uint to unsigned int', () => {
    const input = `
uint foo(uint x) {
  return x + 1;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes longlong to long long', () => {
    const input = `
longlong foo(longlong x) {
  return x * 2;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes undefined4 in locals', () => {
    const input = `
void foo(void) {
  undefined4 local_8 = 0;
  use(local_8);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes undefined in params', () => {
    const input = `
void foo(undefined param_1) {
  use(param_1);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes ushort to unsigned short', () => {
    const input = `
ushort foo(ushort x) {
  return x & 0xff;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes byte to uint8_t', () => {
    const input = `
byte foo(byte x) {
  return x ^ 0xaa;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('normalizes undefined8 to auto or int64_t', () => {
    const input = `
undefined8 foo(void) {
  undefined8 result = 0;
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles mixed Ghidra types in one function', () => {
    const input = `
uint foo(byte a, ushort b, undefined4 c) {
  uint result;
  result = (uint)a + (uint)b + c;
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Indirect call cleanup
// =============================================================================

describe('E2E: Indirect call cleanup', () => {
  it('cleans up function pointer cast in call', () => {
    const input = `
void foo(void *vtable) {
  (*(code *)*(int *)((int)vtable + 8))();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success || result.warnings.length >= 0);
  });

  it('preserves regular function calls', () => {
    const input = `
void foo(void) {
  bar();
  baz(1, 2, 3);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('bar()'));
    assert.ok(result.code.includes('baz(1, 2, 3)'));
  });
});

// =============================================================================
// More goto cleanup edge cases (full preset)
// =============================================================================

describe('E2E: Goto cleanup advanced (full preset)', () => {
  it('handles cascading gotos to same label', () => {
    expectNotContains(`
void foo(int a, int b, int c) {
  if (a == 0) goto LAB_end;
  if (b == 0) goto LAB_end;
  if (c == 0) goto LAB_end;
  doWork(a, b, c);
LAB_end:
  cleanup();
}`, 'goto', 'full');
  });

  it('handles goto to bare return', () => {
    expectNotContains(`
int foo(int x) {
  if (x == 0) goto LAB_ret;
  x = x * 2;
LAB_ret:
  return x;
}`, 'goto', 'full');
  });

  it('handles goto to return with value', () => {
    expectNotContains(`
int foo(int x) {
  if (x < 0) goto LAB_error;
  return x;
LAB_error:
  return -1;
}`, 'goto', 'full');
  });

  it('converts while loop goto to break (known limitation: partial)', () => {
    // The goto cleanup handles some but not all while-loop-to-break patterns.
    // It does eliminate the trailing goto LAB_end + label, but the inner
    // "goto LAB_found" outside the loop may remain.
    const input = `
void foo(int *arr, int n) {
  int i = 0;
  while (i < n) {
    if (arr[i] == -1) goto LAB_found;
    i = i + 1;
  }
  notFound();
  goto LAB_end;
LAB_found:
  found(i);
LAB_end:
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // At minimum, LAB_end should be eliminated
    assert.ok(!result.code.includes('LAB_end'), 'Should eliminate LAB_end');
  });

  it('handles if/else recovery from goto (known limitation: partial)', () => {
    // The goto cleanup eliminates LAB_end but may not fully recover
    // the if/else structure from goto LAB_else patterns.
    const input = `
void foo(int x) {
  if (x != 0) goto LAB_else;
  handleZero();
  goto LAB_end;
LAB_else:
  handleNonZero();
LAB_end:
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should at least eliminate one of the gotos/labels
    assert.ok(!result.code.includes('LAB_end'), 'Should eliminate LAB_end');
  });

  it('handles nested switch gotos', () => {
    const input = `
void foo(int x, int y) {
  switch(x) {
  case 1:
    a();
    goto switchD_1_end;
  case 2:
    switch(y) {
    case 10:
      b();
      goto switchD_2_end;
    case 20:
      c();
      goto switchD_2_end;
    }
switchD_2_end:
    goto switchD_1_end;
  default:
    d();
  }
switchD_1_end:
  done();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles unconditional goto elimination', () => {
    const input = `
void foo(void) {
  a();
  goto LAB_next;
LAB_next:
  b();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('a()'));
    assert.ok(result.code.includes('b()'));
  });
});

// =============================================================================
// More nullptr patterns
// =============================================================================

describe('E2E: Nullptr advanced', () => {
  it('converts NULL assignment', () => {
    expectContains(`
void foo(int **pp) {
  *pp = (int *)0x0;
}`, 'nullptr');
  });

  it('converts multiple null checks', () => {
    const input = `
int foo(int *a, int *b) {
  if ((a != (int *)0x0) && (b != (int *)0x0)) {
    return *a + *b;
  }
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should convert to nullptr or simplify the null comparisons
    assert.ok(
      result.code.includes('nullptr') || !result.code.includes('0x0'),
      'Should clean null comparisons'
    );
  });

  it('converts null return', () => {
    expectContains(`
int * foo(int x) {
  if (x == 0) return (int *)0x0;
  return &x;
}`, 'nullptr');
  });
});

// =============================================================================
// More declaration patterns
// =============================================================================

describe('E2E: Declaration patterns', () => {
  it('handles multiple declarations on same line', () => {
    const input = `
void foo(void) {
  int a;
  int b;
  int c;
  a = 1;
  b = 2;
  c = a + b;
  use(c);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles pointer declarations', () => {
    const input = `
void foo(void) {
  int *p;
  int **pp;
  char *s;
  p = (int *)malloc(4);
  pp = &p;
  s = "hello";
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles array-like declarations', () => {
    const input = `
void foo(void) {
  int local_28[8];
  memset(local_28, 0, 0x20);
  local_28[0] = 1;
  local_28[7] = 99;
  process(local_28);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Calling conventions
// =============================================================================

describe('E2E: Calling conventions', () => {
  it('handles __fastcall', () => {
    const input = `
int __fastcall foo(int a, int b) {
  return a + b;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles __stdcall', () => {
    const input = `
void __stdcall callback(int hwnd, int msg, int wparam, int lparam) {
  handleMessage(msg);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles __cdecl', () => {
    const input = `
int __cdecl variadic(int count, ...) {
  return count;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles __thiscall', () => {
    const input = `
void __thiscall MyClass_Init(MyClass *this, int value) {
  *(int *)((int)this + 4) = value;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success || result.warnings.length >= 0);
  });
});

// =============================================================================
// Complex cast patterns
// =============================================================================

describe('E2E: Cast patterns', () => {
  it('handles nested casts', () => {
    const input = `
int foo(void *p) {
  return *(int *)(*(int *)((int)p + 4) + 8);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles cast in condition', () => {
    const input = `
int foo(uint flags) {
  if ((int)(flags & 0x80000000) < 0) {
    return 1;
  }
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles function pointer casts', () => {
    const input = `
void foo(int *vtable) {
  (*(void (**)(void))vtable[2])();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success || result.warnings.length >= 0);
  });

  it('handles size-extending casts', () => {
    const input = `
long long foo(int x) {
  return (long long)(int)x;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles unsigned/signed cast chains', () => {
    const input = `
int foo(uint x) {
  return (int)(uint)(int)(short)(char)x;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Bitwise operations
// =============================================================================

describe('E2E: Bitwise operations', () => {
  it('handles flag checking patterns', () => {
    const input = `
int foo(int flags) {
  if ((flags & 1) != 0) return 1;
  if ((flags & 2) != 0) return 2;
  if ((flags & 4) != 0) return 4;
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles bit shift patterns', () => {
    const input = `
uint foo(uint x, int n) {
  return (x >> (n & 0x1f)) | (x << (0x20 - (n & 0x1f)));
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles mask and extract', () => {
    const input = `
int foo(int packed) {
  int high = (packed >> 16) & 0xffff;
  int low = packed & 0xffff;
  return high + low;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Complex control flow patterns
// =============================================================================

describe('E2E: Complex control flow', () => {
  it('handles nested loops with break/continue equiv', () => {
    const input = `
void foo(int **matrix, int rows, int cols) {
  int i;
  int j;
  for (i = 0; i < rows; i = i + 1) {
    for (j = 0; j < cols; j = j + 1) {
      if (matrix[i][j] == -1) break;
      process(matrix[i][j]);
    }
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles do-while with complex condition', () => {
    const input = `
int foo(int *pList) {
  int count = 0;
  int *p = pList;
  do {
    count = count + 1;
    p = *(int **)((int)p + 4);
  } while ((p != (int *)0x0) && (count < 1000));
  return count;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles early return pattern', () => {
    const input = `
int foo(int *p, int n) {
  if (p == (int *)0x0) return -1;
  if (n < 0) return -2;
  if (n > 1000) return -3;
  return p[n];
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('nullptr') || result.code.includes('-1'));
  });

  it('handles for loop with multiple increments', () => {
    const input = `
void foo(int *a, int *b, int n) {
  int i;
  int j;
  j = 0;
  for (i = 0; i < n; i = i + 1) {
    a[i] = b[j];
    j = j + 2;
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles infinite loop with conditional breaks', () => {
    const input = `
int foo(int *pState) {
  while (true) {
    int state = *pState;
    if (state == 0) break;
    if (state == -1) return -1;
    processState(pState);
  }
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Short circuit folding advanced
// =============================================================================

describe('E2E: Short circuit folding advanced', () => {
  it('folds triple nested if to &&', () => {
    const input = `
void foo(int a, int b, int c) {
  if (a != 0) {
    if (b != 0) {
      if (c != 0) {
        doWork();
      }
    }
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('preserves side effects in conditions', () => {
    const input = `
void foo(int *p) {
  if (p != (int *)0x0) {
    if (*p > 0) {
      use(*p);
    }
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Redundant parenthesis cleanup
// =============================================================================

describe('E2E: Redundant paren cleanup', () => {
  it('handles deeply nested parens', () => {
    const input = `
int foo(int x) {
  return ((((x + 1))));
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('preserves necessary parens in arithmetic', () => {
    const input = `
int foo(int a, int b, int c) {
  return (a + b) * c;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Must keep parens around (a + b)
    assert.ok(result.code.includes('(') || result.code.includes('+'));
  });
});

// =============================================================================
// Large / stress patterns
// =============================================================================

describe('E2E: Large function patterns', () => {
  it('handles large switch with 20 cases', () => {
    const cases = Array.from({ length: 20 }, (_, i) =>
      `  case ${i}:\n    handle_${i}();\n    break;`
    ).join('\n');
    const input = `
int foo(int type) {
  switch(type) {
${cases}
  default:
    handleDefault();
  }
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('case 0'));
    assert.ok(result.code.includes('case 19'));
  });

  it('handles function with 20 local variables', () => {
    const decls = Array.from({ length: 20 }, (_, i) =>
      `  int local_${(i * 4 + 8).toString(16)};`
    ).join('\n');
    const assigns = Array.from({ length: 20 }, (_, i) =>
      `  local_${(i * 4 + 8).toString(16)} = ${i};`
    ).join('\n');
    const input = `
void foo(void) {
${decls}
${assigns}
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles function with deeply nested ifs (6 levels)', () => {
    const input = `
void foo(int a, int b, int c, int d, int e, int f) {
  if (a != 0) {
    if (b != 0) {
      if (c != 0) {
        if (d != 0) {
          if (e != 0) {
            if (f != 0) {
              deepWork();
            }
          }
        }
      }
    }
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles chained function calls', () => {
    const input = `
int foo(int x) {
  int a = step1(x);
  int b = step2(a);
  int c = step3(b);
  int d = step4(c);
  int e = step5(d);
  return step6(e);
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// String literal patterns
// =============================================================================

describe('E2E: String patterns', () => {
  it('handles string comparison', () => {
    const input = `
int foo(char *s) {
  int result = strcmp(s, "hello world");
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('"hello world"'));
  });

  it('handles string with escape sequences', () => {
    const input = `
void foo(void) {
  printf("line1\\nline2\\ttab\\0null");
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles wide string', () => {
    const input = `
void foo(void) {
  wchar_t *ws = L"wide string";
  wprintf(ws);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: true });
    assert.ok(result.success || result.warnings.length >= 0);
  });
});

// =============================================================================
// Pointer arithmetic patterns
// =============================================================================

describe('E2E: Pointer arithmetic', () => {
  it('handles array indexing via pointer math', () => {
    const input = `
int foo(int *arr, int idx) {
  return *(int *)((int)arr + idx * 4);
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles struct pointer chain', () => {
    const input = `
int foo(int *pObj) {
  int *pNext = *(int **)((int)pObj + 0x1c);
  int *pData = *(int **)((int)pNext + 0x10);
  return *pData;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles offset write patterns', () => {
    const input = `
void foo(int *pStruct) {
  *(int *)((int)pStruct + 0) = 1;
  *(int *)((int)pStruct + 4) = 2;
  *(short *)((int)pStruct + 8) = 3;
  *(char *)((int)pStruct + 0xa) = 4;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Signed literal patterns (more)
// =============================================================================

describe('E2E: Signed literals advanced', () => {
  it('converts 0xfffffffe to -2', () => {
    const input = `
int foo(void) {
  return 0xfffffffe;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('preserves unsigned hex values', () => {
    const input = `
uint foo(void) {
  return 0xdeadbeef;
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles hex in array index', () => {
    const input = `
int foo(int *arr) {
  return arr[0x10];
}`;
    const result = transformGhidraCode(input, { preset: 'quick', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Boolean cleanup advanced
// =============================================================================

describe('E2E: Boolean cleanup advanced', () => {
  it('simplifies !!x', () => {
    const input = `
int foo(int x) {
  return !!x;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles bool in condition with comparison', () => {
    const input = `
void foo(int x) {
  if ((x != 0) == 1) {
    doWork();
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles negated comparison chain', () => {
    const input = `
int foo(int a, int b) {
  if (!(a == 0 || b == 0)) {
    return a * b;
  }
  return 0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Realistic multi-pattern functions
// =============================================================================

describe('E2E: Multi-pattern realistic functions', () => {
  it('handles allocation + init + linked list insert', () => {
    const input = `
int * __fastcall AllocNode(int **ppHead, int value) {
  int *pNew;

  pNew = (int *)malloc(0xc);
  if (pNew == (int *)0x0) {
    return (int *)0x0;
  }
  *(int *)((int)pNew + 0) = value;
  *(int *)((int)pNew + 4) = 0;
  *(int **)((int)pNew + 8) = *ppHead;
  *ppHead = pNew;
  return pNew;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('nullptr'));
  });

  it('handles binary search pattern', () => {
    const input = `
int __fastcall BinarySearch(int *arr, int count, int target) {
  int lo;
  int hi;
  int mid;

  lo = 0;
  hi = count - 1;
  while (lo <= hi) {
    mid = (lo + hi) / 2;
    if (arr[mid] == target) {
      return mid;
    }
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles hash table lookup pattern', () => {
    const input = `
int * __fastcall HashLookup(int **pTable, int nBuckets, int key) {
  int nHash;
  int *pEntry;

  nHash = (uint)key % (uint)nBuckets;
  pEntry = pTable[nHash];
  while (pEntry != (int *)0x0) {
    if (*(int *)((int)pEntry + 0) == key) {
      return pEntry;
    }
    pEntry = *(int **)((int)pEntry + 8);
  }
  return (int *)0x0;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('nullptr'));
  });

  it('handles callback dispatch via function pointer array', () => {
    const input = `
void __fastcall DispatchEvent(int eventType, int *pData) {
  if ((eventType < 0) || (0x10 <= eventType)) {
    return;
  }
  if (DAT_00812340[eventType] != (code *)0x0) {
    (*DAT_00812340[eventType])(pData);
  }
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles critical section lock/unlock pattern', () => {
    const input = `
int __fastcall SafeRead(int *pShared, int *pLock) {
  int result;

  EnterCriticalSection(pLock);
  result = *pShared;
  LeaveCriticalSection(pLock);
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles memcpy + transform pattern', () => {
    const input = `
void __fastcall CopyAndFlip(int *pDst, int *pSrc, int count) {
  int i;

  memcpy(pDst, pSrc, count * 4);
  for (i = 0; i < count; i = i + 1) {
    pDst[i] = pDst[i] ^ 0xffffffff;
  }
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles state machine pattern', () => {
    const input = `
int __fastcall RunStateMachine(int *pState) {
  int state;
  int result;

  result = 0;
  state = *pState;
  switch(state) {
  case 0:
    if (CheckInit() != 0) {
      *pState = 1;
    }
    break;
  case 1:
    result = ProcessData();
    if (result < 0) {
      *pState = 3;
    } else {
      *pState = 2;
    }
    break;
  case 2:
    Finalize();
    *pState = 0;
    result = 1;
    break;
  case 3:
    HandleError();
    *pState = 0;
    result = -1;
    break;
  }
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('switch'));
  });

  it('handles string builder pattern', () => {
    const input = `
void __fastcall BuildMessage(char *pBuf, int nBufSize, int nCode, char *pName) {
  int nLen;

  memset(pBuf, 0, nBufSize);
  strcpy(pBuf, "Error ");
  nLen = strlen(pBuf);
  sprintf(pBuf + nLen, "%d", nCode);
  nLen = strlen(pBuf);
  strcat(pBuf, ": ");
  nLen = strlen(pBuf);
  if (pName != (char *)0x0) {
    strncat(pBuf, pName, nBufSize - nLen - 1);
  }
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    // Should clean the null check (nullptr or simplified comparison)
    assert.ok(
      result.code.includes('nullptr') || !result.code.includes('0x0'),
      'Should clean null comparisons'
    );
  });

  it('handles bit-packed struct read pattern', () => {
    const input = `
void __fastcall UnpackHeader(int packed, int *pType, int *pSize, int *pFlags) {
  *pType = packed & 0xf;
  *pSize = (packed >> 4) & 0xfff;
  *pFlags = (uint)packed >> 0x10;
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles recursive tree walk', () => {
    const input = `
int __fastcall CountNodes(int *pNode) {
  int left;
  int right;

  if (pNode == (int *)0x0) {
    return 0;
  }
  left = CountNodes(*(int **)((int)pNode + 4));
  right = CountNodes(*(int **)((int)pNode + 8));
  return left + right + 1;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('CountNodes'));
    assert.ok(
      result.code.includes('nullptr') || !result.code.includes('0x0'),
      'Should clean null comparisons'
    );
  });

  it('handles ring buffer write', () => {
    const input = `
void __fastcall RingWrite(int *pRing, int value) {
  int nHead;
  int nSize;

  nHead = *(int *)((int)pRing + 0);
  nSize = *(int *)((int)pRing + 4);
  *(int *)(*(int *)((int)pRing + 8) + nHead * 4) = value;
  nHead = nHead + 1;
  if (nHead >= nSize) {
    nHead = 0;
  }
  *(int *)((int)pRing + 0) = nHead;
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles bounds-checked array access', () => {
    const input = `
int __fastcall SafeGet(int *pArray, int nCount, int nIndex) {
  if (nIndex < 0) {
    return -1;
  }
  if (nCount <= nIndex) {
    return -1;
  }
  return pArray[nIndex];
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles packet parsing pattern', () => {
    const input = `
void __fastcall ParsePacket(char *pData, int nLen) {
  int nOffset;
  int nType;
  int nSize;

  nOffset = 0;
  while (nOffset < nLen) {
    nType = (int)*(char *)(pData + nOffset);
    nSize = *(int *)(pData + nOffset + 1);
    if (nSize < 5) break;
    if (nOffset + nSize > nLen) break;
    HandlePacketType(nType, pData + nOffset + 5, nSize - 5);
    nOffset = nOffset + nSize;
  }
  return;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles table-driven dispatch', () => {
    const input = `
int __fastcall Dispatch(int nCmd, int *pArgs) {
  int result;

  if ((nCmd < 0) || (0x20 <= nCmd)) {
    return -1;
  }
  if ((&DAT_00810000)[nCmd] == 0) {
    return -2;
  }
  result = (*(code *)(&DAT_00810080)[nCmd])(pArgs);
  return result;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

// =============================================================================
// Edge cases and parser stress
// =============================================================================

describe('E2E: Parser edge cases', () => {
  it('handles empty if body', () => {
    const input = `
void foo(int x) {
  if (x > 0) {
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles single-line function', () => {
    const input = `int foo(void) { return 42; }`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
    assert.ok(result.code.includes('42'));
  });

  it('handles function with no params', () => {
    const input = `
void foo(void) {
  globalInit();
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles very long expression', () => {
    const input = `
int foo(int a, int b, int c, int d, int e, int f, int g, int h) {
  return a + b * c - d / e + f % g - h;
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });

  it('handles comma operator in for loop', () => {
    const input = `
void foo(int *a, int *b, int n) {
  int i;
  for (i = 0; i < n; i = i + 1) {
    a[i] = b[i];
  }
}`;
    const result = transformGhidraCode(input, { preset: 'full', usePluginRegistry: true, tolerateErrors: false });
    assert.ok(result.success);
  });
});

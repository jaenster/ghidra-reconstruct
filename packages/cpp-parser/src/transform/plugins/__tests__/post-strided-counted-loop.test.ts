import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { postStridedCountedLoopPlugin } from '../builtins/post-strided-counted-loop.js';

const source = `void f() {
  uint16_t* pStringOut = 0;
  if (gsRareAffixTable.nSize <= 0) {
    return;
  }
  int nIdx = 0;
  do {
    uint32_t nStringId;
    nStringId = Lookup(gsRareAffixTable.pTable[nIdx].name, &pStringOut);
    gsRareAffixTable.pTable[nIdx].wNameStrId = (short int)nStringId;
    nIdx++;
  } while (nIdx < gsRareAffixTable.nSize);
}`;

const TYPES = {
  globalTypes: { gsRareAffixTable: 'D2RareAffixTableStrc' },
  structFields: { D2RareAffixTableStrc: { nSize: 'int' } },
};

function tx(code: string, options: Record<string, unknown> = TYPES): string {
  return emit(postStridedCountedLoopPlugin.createTransformer(options)(parse(code)) as AnyNode).trim();
}

function unchanged(code: string, options: Record<string, unknown> = TYPES): void {
  assert.strictEqual(tx(code, options), emit(parse(code) as AnyNode).trim());
}

describe('postStridedCountedLoopPlugin', () => {
  it('recovers the counted for loop after the byte offset has folded into the row index', () => {
    const out = tx(source);
    assert.ok(out.includes('for (int nIdx = 0; nIdx < gsRareAffixTable.nSize; nIdx++) {'), out);
    assert.ok(!out.includes('if (gsRareAffixTable.nSize <= 0)'), out);
    assert.ok(!out.includes('do {'), out);
  });

  it('leaves a guard with a different bound', () => {
    unchanged(source.replace('if (gsRareAffixTable.nSize <= 0)', 'if (otherSize <= 0)'));
  });

  it('leaves a loop followed by work the early return skips', () => {
    unchanged(source.replace('  } while (nIdx < gsRareAffixTable.nSize);',
      '  } while (nIdx < gsRareAffixTable.nSize);\n  Publish();'));
  });

  it('leaves a loop with a continue, whose step semantics differ', () => {
    unchanged(source.replace('    nIdx++;', '    if (Skip(nIdx)) continue;\n    nIdx++;'));
  });

  it('leaves a body-local class whose destructor can observe the counter', () => {
    const watched = 'void f(int bound) { if (bound <= 0) return; int i = 0; do { Watch w; Tick(); i++; } while (i < bound); }';
    unchanged(watched);
  });

  it('leaves a nonzero initial counter', () => {
    unchanged(source.replace('int nIdx = 0;', 'int nIdx = 1;'));
  });

  it('leaves an unproven bound type', () => {
    unchanged(source, {});
  });

  it('leaves a float bound because NaN reaches the do body once', () => {
    const floating = 'void f(float bound) { if (bound <= 0) return; int i = 0; do { Tick(); i++; } while (i < bound); }';
    assert.strictEqual(Number.NaN <= 0, false);
    assert.strictEqual(0 < Number.NaN, false);
    unchanged(floating);
  });

  it('leaves a class counter with an overloaded comparison', () => {
    const overloaded = 'void f(int bound) { if (bound <= 0) return; Counter i = 0; do { Tick(); i++; } while (i < bound); }';
    unchanged(overloaded);
  });

  it('leaves an unsigned counter against a signed bound', () => {
    const unsigned = 'void f(int bound) { if (bound <= 0) return; unsigned int i = 0; do { Tick(); i++; } while (i < bound); }';
    unchanged(unsigned);
  });

  it('uses the exact counter declaration when an earlier nested local has the same name', () => {
    const prefix = 'void f(int bound, bool flag) { if (flag) { int i = 42; Sink(i); }';
    // With bound < 0, the original returns but `0u < bound` enters the loop.
    const unsigned = `${prefix} if (bound <= 0) return; unsigned int i = 0; do { Tick(); i++; } while (i < bound); }`;
    unchanged(unsigned);
    const signed = unsigned.replace('int i = 42', 'unsigned int i = 42').replace('unsigned int i = 0', 'int i = 0');
    assert.ok(tx(signed).includes('for (int i = 0; i < bound; i++) {'));
  });

  it('leaves volatile bound storage', () => {
    unchanged('void f(volatile int bound) { if (bound <= 0) return; int i = 0; do { Tick(); i++; } while (i < bound); }');
    unchanged(source, { ...TYPES, structFields: { D2RareAffixTableStrc: { nSize: 'volatile int' } } });
  });

  it('leaves a volatile counter, which a for test would read before the first body call', () => {
    unchanged('void f(int bound) { if (bound <= 0) return; volatile int i = 0; do { Tick(); i++; } while (i < bound); }');
  });

  it('leaves volatile typedefs on either side of the comparison', () => {
    const alias = { typedefTargets: { VInt: 'volatile int' } };
    unchanged('void f(VInt bound) { if (bound <= 0) return; int i = 0; do { Tick(); i++; } while (i < bound); }', alias);
    unchanged('void f(int bound) { if (bound <= 0) return; VInt i = 0; do { Tick(); i++; } while (i < bound); }', alias);
  });

  it('leaves a static counter that retains a previous call’s value', () => {
    unchanged('void f(int bound) { if (bound <= 0) return; static int i = 0; do { Tick(); i++; } while (i < bound); }');
  });

  it('leaves a shadowed counter whose final increment binds to the body local', () => {
    const shadowed = 'void f(int bound) { if (bound <= 0) return; int i = 0; do { int i = 0; Tick(); i++; } while (i < bound); }';
    unchanged(shadowed);
  });

  it('leaves a bound whose global type is obscured by a body-local declaration', () => {
    const shadowed = 'void f() { if (bound <= 0) return; int i = 0; do { int bound = 1; Tick(); i++; } while (i < bound); }';
    unchanged(shadowed, { globalTypes: { bound: 'float' } });
    unchanged(shadowed, { globalTypes: { bound: 'volatile int' } });
  });

  it('leaves a volatile parameter that shadows a typed global member owner', () => {
    const direct = 'void f(volatile D2RareAffixTableStrc gsRareAffixTable) { if (gsRareAffixTable.nSize <= 0) return; int i = 0; do { Tick(); i++; } while (i < gsRareAffixTable.nSize); }';
    unchanged(direct);
    const aliased = direct.replace('volatile D2RareAffixTableStrc', 'VRare');
    unchanged(aliased, { ...TYPES, typedefTargets: { VRare: 'volatile D2RareAffixTableStrc' } });
  });

  it('uses a bare parameter’s own type instead of a same-named global fact', () => {
    const bare = 'void f(int bound) { if (bound <= 0) return; int i = 0; do { Tick(); i++; } while (i < bound); }';
    assert.ok(tx(bare, { globalTypes: { bound: 'float' } }).includes('for (int i = 0; i < bound; i++) {'));
    unchanged(bare.replace('int bound', 'volatile int bound'), { globalTypes: { bound: 'int' } });
  });

  it('leaves a nested guard comment that the parser preserves', () => {
    const commented = source.replace('    return;', '    // keep\n    return;');
    assert.ok(emit(parse(commented) as AnyNode).includes('// keep'));
    unchanged(commented);
  });

  it('leaves the lowqualityitems arrangement whose counter is initialized before the guard', () => {
    const earlierInit = source.replace('  if (gsRareAffixTable.nSize <= 0) {\n    return;\n  }\n  int nIdx = 0;',
      '  int nIdx = 0;\n  if (gsRareAffixTable.nSize <= 0) {\n    return;\n  }');
    unchanged(earlierInit);
  });

  it('leaves a guard that returns a value', () => {
    unchanged(source.replace('void f()', 'int f()').replace('    return;', '    return 1;').replace(/\n}$/, '\n  return 0;\n}'));
  });
});

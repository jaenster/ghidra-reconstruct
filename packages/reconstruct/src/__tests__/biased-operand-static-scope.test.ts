/**
 * A 1-based byte table read through `table - 1` is a reference to the table.
 *
 * D2COMP_LoadGuildEmblemIcon (005053a0) reads gaGlideEmblemSecondaryColorTableEntries
 * (byte[12] @0087e82c) as `MOV AL,[EDX + 0x87e82b]`. The operand addresses the last
 * byte of the datum before it, so Ghidra's only xref to the table is its initializer's,
 * D2COMP_InitEmblemColorTables, and the table was scoped `static` inside that one body.
 * `biased-table-index` then respelled the reader against the table, globals.h declared
 * an extern for it, and the loader read an object nothing defines while the
 * initializer filled a different one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { reconcileStaticScopeWithBodyReferences } from '../codegen/index.js';
import type { AnalyzedDataSymbol, ExtractedFunction } from '../types.js';

function fn(name: string, decompiled: string, refs: { ins: string; op: number; to: string; type: string; encoded: boolean }[] = []): ExtractedFunction {
  return {
    name, address: '00505000', signature: '', returnType: 'void', parameters: [], localVariables: [],
    callingConvention: '__stdcall', size: 64, isThunk: false, isExternal: false, hasVarArgs: false,
    decompiled, operandRefs: { refs, derived: [] },
  } as unknown as ExtractedFunction;
}

const table = (): AnalyzedDataSymbol => ({
  name: 'gaGlideEmblemSecondaryColorTableEntries', address: '0087e82c', dataType: 'byte[12]',
  suggestedType: 'byte[12]', size: 12, isInitialized: true, value: null, xrefCount: 1,
  scope: 'static-local', ownerFunction: 'D2COMP_InitEmblemColorTables',
} as unknown as AnalyzedDataSymbol);

/** The datum the operand lands in: it ends where the table starts. */
const before = (): AnalyzedDataSymbol => ({
  name: 'gaCompTwoHandedWeaponClass', address: '0087e430', dataType: 'int[255]', suggestedType: 'int[255]',
  size: 0x3fc, isInitialized: true, value: null, xrefCount: 3, scope: 'global',
} as unknown as AnalyzedDataSymbol);

const init = fn('D2COMP_InitEmblemColorTables', 'void f(){ gaGlideEmblemSecondaryColorTableEntries[i] = c; }',
  [{ ins: '005055f0', op: 0, to: '0087e82c', type: 'WRITE', encoded: true }]);
const files = new Map([['D2COMP_InitEmblemColorTables', 'D2Win/Src/D2Comp.cpp'], ['D2COMP_LoadGuildEmblemIcon', 'D2Win/Src/D2Comp.cpp']]);

describe('a biased operand below a static-local table', () => {
  it('promotes the table another body reads through table - 1', () => {
    const t = table();
    const load = fn('D2COMP_LoadGuildEmblemIcon', 'void g(){ x = *(undefined1 *)((int)gaCompTwoHandedWeaponClass + b + 0x3fb); }',
      [{ ins: '0050544a', op: 1, to: '0087e82b', type: 'READ', encoded: true }]);
    reconcileStaticScopeWithBodyReferences([before(), t], [init, load], files, new Set(), '00400000', []);
    assert.strictEqual(t.scope, 'global');
    assert.strictEqual(t.ownerFunction, undefined);
  });

  it('leaves it static when only the owner reads it, or the operand is not encoded or too far below', () => {
    for (const r of [
      { ins: '0050544a', op: 1, to: '0087e82b', type: 'READ', encoded: false },
      { ins: '0050544a', op: 1, to: '0087e823', type: 'READ', encoded: true },
    ]) {
      const t = table();
      const load = fn('D2COMP_LoadGuildEmblemIcon', 'void g(){ x = *(undefined1 *)((int)gaCompTwoHandedWeaponClass + b + 0x3fb); }', [r]);
      reconcileStaticScopeWithBodyReferences([before(), t], [init, load], files, new Set(), '00400000', []);
      assert.strictEqual(t.scope, 'static-local', JSON.stringify(r));
    }
    const t = table();
    const ownBiased = fn('D2COMP_InitEmblemColorTables', 'void f(){ gaGlideEmblemSecondaryColorTableEntries[i] = c; }',
      [{ ins: '005055f0', op: 0, to: '0087e82b', type: 'WRITE', encoded: true }]);
    reconcileStaticScopeWithBodyReferences([before(), t], [ownBiased], files, new Set(), '00400000', []);
    assert.strictEqual(t.scope, 'static-local');
  });

  it('leaves it static when the body reads the neighbour\'s own last bytes (no variable index)', () => {
    // The layout matches (an operand 4 below the table, in the datum that ends there),
    // but the decompile reads gaCompTwoHandedWeaponClass[254]: the pass names no table.
    const t = table();
    const load = fn('D2COMP_LoadGuildEmblemIcon', 'void g(){ x = gaCompTwoHandedWeaponClass[254]; }',
      [{ ins: '0050544a', op: 1, to: '0087e828', type: 'READ', encoded: true }]);
    reconcileStaticScopeWithBodyReferences([before(), t], [init, load], files, new Set(), '00400000', []);
    assert.strictEqual(t.scope, 'static-local');
  });
});

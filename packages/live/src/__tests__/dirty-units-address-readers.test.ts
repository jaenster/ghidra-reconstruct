/**
 * Rules that spell a body from something the body does not name, and so no
 * dependency edge carries: `exact-float-constant` (the float datum an instruction
 * reads), `global-run-clear` (the run of globals a memset clears by name) and
 * `frame-funclet-inline` (the funclet put back into its one caller).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { selectDirtyUnits, computeHashCache } from '../dirty-units.js';
import type { ExtractedFunction, ExtractedDataType, AnalyzedDataSymbol } from '@ghidra-mcp/reconstruct';

const reader = {
  name: 'CLIENT_AdjustMemoryBudget', address: '00457300', namespace: 'D2Client::UI::Draw',
  decompiled: 'void f() { g(x * 9.536743e-07); }', parameters: [], localVariables: [], returnType: 'void',
  operandRefs: { refs: [{ ins: '00457380', op: 1, to: '006cccb0', type: 'READ', encoded: true }], derived: [], scalars: [], functions: [] },
} as unknown as ExtractedFunction;
const bystander = {
  name: 'Other', address: '00400000', namespace: 'D2Client::UI::Other',
  decompiled: 'void o() { h(gnCount); }', parameters: [], localVariables: [], returnType: 'void',
  operandRefs: { refs: [{ ins: '00400010', op: 1, to: '00700000', type: 'READ', encoded: true }], derived: [], scalars: [], functions: [] },
} as unknown as ExtractedFunction;

const mb = (value: string) => ({ name: 'gdBytesToMegabytes', address: '006cccb0', dataType: 'double', size: 8, value, scope: 'global', isInitialized: true }) as unknown as AnalyzedDataSymbol;
const count = (value: string) => ({ name: 'gnCount', address: '00700000', dataType: 'int', size: 4, value, scope: 'global', isInitialized: true }) as unknown as AnalyzedDataSymbol;

const buildInfo = {
  modules: [
    { id: 'D2Client/UI/Draw.h', implPath: 'D2Client/UI/Draw.cpp', unitName: 'D2Client/UI/Draw', deps: [], functionNames: ['CLIENT_AdjustMemoryBudget'] },
    { id: 'D2Client/UI/Other.h', implPath: 'D2Client/UI/Other.cpp', unitName: 'D2Client/UI/Other', deps: [], functionNames: ['Other'] },
  ],
  symbolIndex: {}, symbolHashes: {},
};

function select(globalsBefore: AnalyzedDataSymbol[], globalsNow: AnalyzedDataSymbol[]) {
  const functions = [reader, bystander];
  const dataTypes: ExtractedDataType[] = [];
  const previous = computeHashCache({ functions, dataTypes, globals: globalsBefore });
  return selectDirtyUnits({
    buildInfo: buildInfo as never, previous, identCacheEmpty: false, functions, dataTypes, globals: globalsNow,
  });
}

describe('a unit reading a global it does not name', () => {
  it('is dirty when the datum\'s value changes', () => {
    const r = select([mb('9.536743E-7'), count('1')], [mb('9.5367431640625E-7'), count('1')]);
    assert.deepStrictEqual(r.units, ['D2Client/UI/Draw']);
  });

  it('is not made dirty by a change of an integer datum it does not read', () => {
    const r = select([mb('9.5367431640625E-7'), count('1')], [mb('9.5367431640625E-7'), count('2')]);
    assert.ok(!(r.units ?? []).includes('D2Client/UI/Draw'), String(r.units));
  });

  it('is dirty when a global its memset clears by name is renamed (global-run-clear)', () => {
    const clearer = {
      name: 'TEXT_InitTextDisplaySettings', address: '0049d440', namespace: 'D2Client::UI::Draw',
      decompiled: 'void f() { memset(&DialogHandle, 0, 0x10); }', parameters: [], localVariables: [], returnType: 'void',
      operandRefs: { refs: [{ ins: '0049d450', op: 0, to: '007bf1b0', type: 'WRITE', encoded: true }], derived: [], scalars: [], functions: [] },
    } as unknown as ExtractedFunction;
    const g = (name: string, address: string) => ({ name, address, dataType: 'int', size: 4, scope: 'global', isInitialized: false }) as unknown as AnalyzedDataSymbol;
    const before = [g('DialogHandle', '007bf1b0'), g('gpTextMessageLogHead', '007bf1b4')];
    const now = [g('DialogHandle', '007bf1b0'), g('gpTextLogHead', '007bf1b4')];
    const functions = [clearer, bystander];
    const previous = computeHashCache({ functions, dataTypes: [], globals: before });
    const info = { ...buildInfo, modules: [{ ...buildInfo.modules[0], functionNames: ['TEXT_InitTextDisplaySettings'] }, buildInfo.modules[1]] };
    const r = selectDirtyUnits({ buildInfo: info as never, previous, identCacheEmpty: false, functions, dataTypes: [], globals: now });
    assert.deepStrictEqual(r.units, ['D2Client/UI/Draw']);
  });

  it('dirties the caller\'s unit when an inlined frame funclet changes (frame-funclet-inline)', () => {
    const funclet = {
      name: 'D2FILE_CleanupCryptHandles', address: '00517df5', namespace: 'D2Client::UI::Other', returnType: 'void',
      decompiled: 'void D2FILE_CleanupCryptHandles(DWORD dwNull,int nFrameBase) { f(*(int *)(nFrameBase + -0x24)); }',
      parameters: [{ name: 'dwNull', dataType: 'DWORD', storage: 'EBX:4' }, { name: 'nFrameBase', dataType: 'int', storage: 'EBP:4' }],
      localVariables: [],
    } as unknown as ExtractedFunction;
    const parent = {
      name: 'D2FILE_GetSignerOrganization', address: '00517c30', namespace: 'D2Client::UI::Draw', returnType: 'int',
      decompiled: 'int f() { D2FILE_CleanupCryptHandles(0,&stack0xfffffffc); return 0; }', parameters: [], localVariables: [],
    } as unknown as ExtractedFunction;
    const info = { ...buildInfo, modules: [
      { ...buildInfo.modules[0], functionNames: ['D2FILE_GetSignerOrganization'] },
      { ...buildInfo.modules[1], functionNames: ['D2FILE_CleanupCryptHandles'] },
    ] };
    const before = [funclet, parent];
    const now = [{ ...funclet, decompiled: funclet.decompiled!.replace('-0x24', '-0x28') }, parent];
    const previous = computeHashCache({ functions: before, dataTypes: [], globals: [] });
    const r = selectDirtyUnits({ buildInfo: info as never, previous, identCacheEmpty: false, functions: now, dataTypes: [], globals: [] });
    assert.deepStrictEqual([...(r.units ?? [])].sort(), ['D2Client/UI/Draw', 'D2Client/UI/Other']);
  });
});

/**
 * The inlined-call plan builds the cast tables without the write-effects table,
 * which only the unit generator reads. Leaving it out must change nothing else.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildFuncPtrArgCastTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction } from '../types.js';

const SETTER = {
  name: 'UNIT_SetFlag', namespace: 'D2Common::Units', address: '00620000',
  signature: '', returnType: 'void',
  parameters: [{ name: 'pUnit', dataType: 'D2UnitStrc *', ordinal: 0, storage: 'ECX:4' }],
  localVariables: [], callingConvention: '__fastcall', size: 0x20,
  isThunk: false, isExternal: false, hasVarArgs: false,
  decompiled: 'void __fastcall UNIT_SetFlag(D2UnitStrc *pUnit)\n{\n  gnFlag = 1;\n  pUnit->dwFlags = 2;\n  return;\n}\n',
} as unknown as ExtractedFunction;

const UNIT = {
  name: 'D2UnitStrc', kind: 'STRUCTURE', size: 8,
  fields: [
    { name: 'dwType', dataType: 'uint32_t', offset: 0, size: 4 },
    { name: 'dwFlags', dataType: 'uint32_t', offset: 4, size: 4 },
  ],
} as unknown as ExtractedDataType;

const FLAG = {
  name: 'gnFlag', address: '00700000', dataType: 'int', size: 4, scope: 'global',
} as unknown as AnalyzedDataSymbol;

describe('cast tables built without write effects', () => {
  it('equal the full build in every other table', () => {
    const full = buildFuncPtrArgCastTables([SETTER], [FLAG], [], [UNIT], []);
    const lean = buildFuncPtrArgCastTables([SETTER], [FLAG], [], [UNIT], [], [], { writeEffects: false });
    assert.ok(full.writeEffects && Object.keys(full.writeEffects).length > 0, 'the fixture has write effects');
    assert.strictEqual(lean.writeEffects, undefined);
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      if (key === 'writeEffects' || typeof full[key] === 'function') continue;
      if (key === 'outParams' || key === 'paramReach') continue; // oracles: closures over the same inputs
      assert.deepStrictEqual(lean[key], full[key], key);
    }
  });
});

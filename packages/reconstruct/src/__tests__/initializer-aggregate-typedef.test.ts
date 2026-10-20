/**
 * Two initializer gaps the v1234 types exposed, both where a slot names an
 * aggregate THROUGH A TYPEDEF.
 *
 *  - `gaCrtFileHandleTable` 0x0074a1e8 is `FILE[20]`, and Ghidra's `FILE` is
 *    `typedef _iobuf FILE` (/mbstring.h). The struct layout is keyed on `_iobuf`,
 *    so every field was typed as nothing and `&DAT_00993c80` (a `uint8_t`) went
 *    into `char * _ptr` with no cast: "invalid conversion from uint8_t* to char*".
 *  - `gliPerfCounterStart` 0x007c9350, a static local of D2GFX_CalculateGammaRamp,
 *    is `LARGE_INTEGER` (typedef of the union `_LARGE_INTEGER`) holding a zero
 *    scalar. `static LARGE_INTEGER g = 0;` converts to nothing; `{}` is the same
 *    eight zero bytes.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue, generateStaticLocalDeclaration, setGlobalInitializerTypes, setKnownFuncDefTypedefs,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedDataType } from '../types.js';

const DATA_TYPES = [
  {
    name: '_iobuf', kind: 'STRUCTURE', category: '/mbstring.h', size: 32,
    fields: [
      { name: '_ptr', dataType: 'char *', offset: 0, size: 4 },
      { name: '_cnt', dataType: 'int', offset: 4, size: 4 },
      { name: '_base', dataType: 'char *', offset: 8, size: 4 },
      { name: '_flag', dataType: 'int', offset: 12, size: 4 },
    ],
  },
  { name: 'FILE', kind: 'TYPEDEF', category: '/mbstring.h', size: 32, underlyingType: '_iobuf' },
  {
    name: '_LARGE_INTEGER', kind: 'UNION', category: '/winnt.h', size: 8,
    fields: [{ name: 'QuadPart', dataType: 'longlong', offset: 0, size: 8 }],
  },
  { name: 'LARGE_INTEGER', kind: 'TYPEDEF', category: '/winnt.h', size: 8, underlyingType: '_LARGE_INTEGER' },
] as unknown as ExtractedDataType[];

describe('initializers for aggregates named through a typedef', () => {
  beforeEach(() => {
    setAggregateTypeNames(DATA_TYPES as any);
    setGlobalInitializerTypes(DATA_TYPES);
    setMultidimArrayGlobals([{ name: 'DAT_00993c80', dataType: 'uint8_t', suggestedType: 'uint8_t' }]);
  });

  it('types the fields of a struct reached through its typedef', () => {
    const file: DataValue = {
      kind: 'struct',
      fields: [
        { name: '_ptr', value: { kind: 'pointer', value: 'DAT_00993c80' } },
        { name: '_cnt', value: { kind: 'scalar', value: '0x0' } },
        { name: '_base', value: { kind: 'pointer', value: 'DAT_00993c80' } },
        { name: '_flag', value: { kind: 'scalar', value: '0x101' } },
      ],
    } as DataValue;
    const out = emitDataValue(file, 0, 'FILE');
    assert.equal(out, [
      '{',
      '    /* ._ptr = */ (char*)&DAT_00993c80,',
      '    /* ._cnt = */ 0x0,',
      '    /* ._base = */ (char*)&DAT_00993c80,',
      '    /* ._flag = */ 0x101',
      '}',
    ].join('\n'));
  });

  it('zero-initialises a union-typed static local with {}', () => {
    const decl = generateStaticLocalDeclaration({
      name: 'gliPerfCounterStart', address: '007c9350', dataType: 'LARGE_INTEGER', size: 8,
      scope: 'static-local', suggestedType: 'LARGE_INTEGER', ownerFunction: 'D2GFX_CalculateGammaRamp',
      initializedData: { kind: 'scalar', value: '0' },
    } as unknown as AnalyzedDataSymbol);
    assert.equal(decl, 'static LARGE_INTEGER gliPerfCounterStart = {};');
  });

  it('leaves a zero scalar in a scalar slot as 0', () => {
    assert.equal(emitDataValue({ kind: 'scalar', value: '0' } as DataValue, 0, 'int'), '0');
    assert.equal(emitDataValue({ kind: 'scalar', value: '0' } as DataValue, 0, 'LARGE_INTEGER *'), '0');
  });

  // __lc_category (006f3168) slots 0 and 1 hold LAB_00691b68 / LAB_0069e86b: code Ghidra
  // has no function at (each is `xor eax,eax; ret`, the CRT's __init_dummy). The address
  // has to be cast to the slot's funcdef, as the hex path already does; `(void*)` does
  // not convert to a function pointer.
  it('casts an unresolved code label to a funcdef slot type', () => {
    setKnownFuncDefTypedefs(['fnCrtLocaleCategoryInit']);
    const out = emitDataValue({ kind: 'pointer', value: 'LAB_00691b68' } as DataValue, 0, 'fnCrtLocaleCategoryInit *');
    assert.equal(out, '(fnCrtLocaleCategoryInit)0x00691b68');
  });
});

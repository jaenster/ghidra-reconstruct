/**
 * Regression test: a pointer slot inside a global's initializer must be spelled
 * with the STATIC TYPE of the slot, not with whatever `&<symbol>` happens to be.
 *
 * `emitDataValue` used to emit `&<name>` for every symbol-valued pointer, with no
 * knowledge of what it was initializing. In `recon/diablo-2/globals.cpp` that is
 * 214 hard errors, all on one table family:
 *
 *   globals.cpp:7998  /* .pMonSeqTxt = *\/ &gaMonSeqAnimData,
 *     -> cannot convert 'void**' to 'D2MonSeqTxt*' in initialization
 *   globals.cpp:8018  /* .pMonSeqTxt = *\/ &D2MonSeqMonsterTbls_ARRAY_007468a0[14].pMonSeqTxt,
 *     -> cannot convert 'D2MonSeqTxt**' to 'D2MonSeqTxt*'
 *
 * Three distinct shapes, one cause — the emitter never saw the field type:
 *   - the target is a 1-D ARRAY of the pointee type: the bare name decays to
 *     exactly the right pointer, so the `&` is simply wrong;
 *   - the target is an OBJECT of the pointee type: `&name` is right;
 *   - Ghidra types the target as something else, or the address lands on a FIELD
 *     inside another table: no `&`/decay spelling has the slot's type, and only
 *     a cast to the declared slot type preserves the address with the right type.
 *
 * Fixtures are verbatim from recon/diablo-2 (1.14d Game.exe):
 *   globals.h:1706  extern void* gaMonSeqAnimData;
 *   globals.h:1704  extern void* DAT_007466dc;
 *   globals.cpp:7996 D2MonSeqMonsterTbls D2MonSeqMonsterTbls_ARRAY_00746978[22]
 *
 * NOTE for the Ghidra owner: the DATA is what forces the cast branch here.
 * `gaMonSeqAnimData` @ 0x746xxx is `undefined` in the database (it arrives as
 * `void*`) though the tables point at it as a `D2MonSeqTxt` array, and
 * `D2MonSeqMonsterTbls.pMonSeqTxt` is typed `D2MonSeqTxt*` while several entries
 * hold the address of another `D2MonSeqMonsterTbls` element. Typing those two
 * correctly removes the cast branch entirely.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { DataValue, ExtractedDataType } from '../types.js';

/** Ghidra `/D2Common/D2MonSeqMonsterTbls` — 3 fields, pointer first. */
const DATA_TYPES = [
  {
    name: 'D2MonSeqMonsterTbls',
    kind: 'STRUCTURE',
    category: '/D2Common',
    size: 12,
    fields: [
      { name: 'pMonSeqTxt', dataType: 'D2MonSeqTxt *', offset: 0, size: 4 },
      { name: 'nCounter1', dataType: 'int', offset: 4, size: 4 },
      { name: 'nCounter2', dataType: 'int', offset: 8, size: 4 },
    ],
  },
  {
    name: 'D2MonSeqTxt',
    kind: 'STRUCTURE',
    category: '/D2Common',
    size: 8,
    fields: [{ name: 'nMode', dataType: 'int', offset: 0, size: 4 }],
  },
] as unknown as ExtractedDataType[];

/** The globals those initializers point at, exactly as globals.h declares them. */
const GLOBALS = [
  // Ghidra `undefined` -> `auto` -> `void*`: the head of a D2MonSeqTxt table.
  { name: 'gaMonSeqAnimData', dataType: 'void*', suggestedType: 'void*' },
  { name: 'DAT_007466dc', dataType: 'void*', suggestedType: 'void*' },
  // A correctly-typed 1-D array of the pointee type.
  { name: 'gaMonSeqTxtTable', dataType: 'D2MonSeqTxt[8]', suggestedType: 'D2MonSeqTxt[8]' },
  // A correctly-typed single object of the pointee type.
  { name: 'gMonSeqTxtSingle', dataType: 'D2MonSeqTxt', suggestedType: 'D2MonSeqTxt' },
];

const entry = (ptr: DataValue): DataValue => ({
  kind: 'struct',
  fields: [
    { name: 'pMonSeqTxt', value: ptr },
    { name: 'nCounter1', value: { kind: 'scalar', value: '0xe' } },
    { name: 'nCounter2', value: { kind: 'scalar', value: '0xe' } },
  ],
});

describe('pointer slots in global initializers are typed by the slot, not by &', () => {
  beforeEach(() => {
    setMultidimArrayGlobals(GLOBALS);
    setGlobalInitializerTypes(DATA_TYPES);
  });

  it('decays a 1-D array of the pointee type instead of taking its address', () => {
    const out = emitDataValue(
      entry({ kind: 'pointer', value: 'gaMonSeqTxtTable' }),
      0,
      'D2MonSeqMonsterTbls'
    );
    assert.match(out, /\.pMonSeqTxt = \*\/ gaMonSeqTxtTable,/);
    assert.doesNotMatch(out, /&gaMonSeqTxtTable/);
  });

  it('keeps a plain & when the target IS an object of the pointee type', () => {
    const out = emitDataValue(
      entry({ kind: 'pointer', value: 'gMonSeqTxtSingle' }),
      0,
      'D2MonSeqMonsterTbls'
    );
    assert.match(out, /\.pMonSeqTxt = \*\/ &gMonSeqTxtSingle,/);
    assert.doesNotMatch(out, /\(D2MonSeqTxt\*\)/);
  });

  it('casts to the slot type when Ghidra types the target as something else', () => {
    // globals.h:1706 `extern void* gaMonSeqAnimData;` -> `&` is `void**`.
    const out = emitDataValue(
      entry({ kind: 'pointer', value: 'gaMonSeqAnimData' }),
      0,
      'D2MonSeqMonsterTbls'
    );
    assert.match(out, /\.pMonSeqTxt = \*\/ \(D2MonSeqTxt\*\)&gaMonSeqAnimData,/);
  });

  it('casts to the slot type when the address lands on a field of another table', () => {
    const out = emitDataValue(
      entry({ kind: 'pointer', value: 'D2MonSeqMonsterTbls_ARRAY_007468a0[14].pMonSeqTxt' }),
      0,
      'D2MonSeqMonsterTbls'
    );
    assert.match(
      out,
      /\(D2MonSeqTxt\*\)&D2MonSeqMonsterTbls_ARRAY_007468a0\[14\]\.pMonSeqTxt/
    );
  });

  it('threads the element type through an array of structs', () => {
    const table: DataValue = {
      kind: 'array',
      elements: [
        entry({ kind: 'pointer', value: 'gaMonSeqAnimData' }),
        entry({ kind: 'pointer', value: 'gaMonSeqTxtTable' }),
      ],
    };
    const out = emitDataValue(table, 0, 'D2MonSeqMonsterTbls[22]');
    assert.match(out, /\(D2MonSeqTxt\*\)&gaMonSeqAnimData/);
    assert.match(out, /\*\/ gaMonSeqTxtTable,/);
  });

  it('leaves a null pointer slot as nullptr', () => {
    const out = emitDataValue(entry({ kind: 'pointer', value: '0x0' }), 0, 'D2MonSeqMonsterTbls');
    assert.match(out, /\.pMonSeqTxt = \*\/ nullptr,/);
  });
});

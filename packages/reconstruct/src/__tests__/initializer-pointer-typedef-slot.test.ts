/**
 * A slot spelled through a typedef is still the slot the typedef stands for.
 *
 * `globals.D2Win.cpp` carries
 *
 *   pointer aFontNames[15] = { (void*)0x006dc978, (void*)0x006dc970, ... };
 *
 * fifteen string constants, and `D2WINFONT_BuildFontPath` hands each to
 * `wsprintfA("%s%s%s", ..., aFontNames[i])` — so the recompiled executable reads
 * 0x006DC970 while it is building a font path, which is where the main menu dies.
 *
 * `d2_platform.h` has `typedef void* pointer;`. The slot IS a pointer; what it
 * has not got is a STAR IN ITS SPELLING, and both address resolvers decided
 * "pointer slot?" with `/\*\s*$/` over the spelling. `castPointerInitializer`
 * had this exact bug and `pointerTypedefNames` was built to answer it — the two
 * resolvers here simply never asked. So the shape has to be read off the
 * RESOLVED type, and the cast written with the DECLARED one.
 *
 * The same star-less spellings reach these paths as array element and struct
 * field types everywhere: `LPVOID`, `PVOID`, `LPCVOID` and the HANDLE family,
 * which Ghidra records as typedefs with NO target, and `LPCSTR`/`LPSTR`, which
 * it records with one. Both origins have to resolve, or the fix covers half the
 * spellings that carry the defect.
 *
 * The aggregate rule needs nothing: fifteen of fifteen is well past its bar. But
 * the array path and the lone-slot path must agree about the shape, because a
 * `pointer` array reaches one and a `pointer` field the other.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';

/** Two of the fifteen font names, as `list_strings` reports them. */
const STRINGS = [
  ['006dc978', 'FONT16'],
  ['006dc970', 'FONT24'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const GLOBALS = [
  { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

const FONT16 = 's_FONT16_006dc978';
const FONT24 = 's_FONT24_006dc970';

/** Ghidra's own typedefs: a two-level pointer chain, and one that ends at an integer. */
const DATA_TYPES = [
  { name: 'FontNamePtr', kind: 'TYPEDEF', underlyingType: 'pointer' },
  { name: 'LPCSTR', kind: 'TYPEDEF', underlyingType: 'CHAR *' },
  { name: 'D2Count', kind: 'TYPEDEF', underlyingType: 'uint32_t' },
];

function install(): void {
  setMultidimArrayGlobals([]);
  setGlobalInitializerTypes(undefined);
  setAggregateTypeNames(DATA_TYPES);
  const tables = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set([...tables.stringConstantNames, 'gnFrameCount']),
    imageBase: '0x400000',
  });
}

const ptr = (v: string): DataValue => ({ kind: 'pointer', value: v });
const scalar = (v: string): DataValue => ({ kind: 'scalar', value: v });

/** The font table's shape: pointer elements, the last one null. */
const FONT_TABLE: DataValue = {
  kind: 'array',
  elements: [ptr('0x006dc978'), ptr('0x006dc970'), ptr('0x0')],
};

describe('an address in a slot spelled through a typedef', () => {
  beforeEach(install);

  it('resolves the font table `pointer[N]` holds', () => {
    const out = emitDataValue(FONT_TABLE, 0, 'pointer[3]');
    assert.ok(out.includes(FONT16), `expected the label in: ${out}`);
    assert.ok(out.includes(FONT24), `expected the label in: ${out}`);
    assert.ok(!/0x006dc9/.test(out), `no absolute address may survive: ${out}`);
  });

  it('keeps the null element null', () => {
    const out = emitDataValue(FONT_TABLE, 0, 'pointer[3]');
    assert.ok(out.includes('nullptr'), `the null slot stays null: ${out}`);
  });

  it('spells the cast with the DECLARED type, not the resolved one', () => {
    // `char[N]` decays to `char*`, which a `void*` slot takes only through a
    // cast — and the cast the reader should see is the slot they declared.
    const out = emitDataValue(FONT_TABLE, 0, 'pointer[3]');
    assert.ok(out.includes(`(pointer)${FONT16}`), `got: ${out}`);
  });

  it('follows a typedef OF a typedef', () => {
    const out = emitDataValue(FONT_TABLE, 0, 'FontNamePtr[3]');
    assert.ok(out.includes(`(FontNamePtr)${FONT16}`), `got: ${out}`);
  });

  it('resolves the SDK spellings Ghidra records with no target', () => {
    for (const slot of ['LPVOID', 'PVOID', 'LPCVOID', 'HANDLE']) {
      const out = emitDataValue(FONT_TABLE, 0, `${slot}[3]`);
      assert.ok(out.includes(`(${slot})${FONT16}`), `${slot}: ${out}`);
    }
  });

  it('resolves the SDK spellings Ghidra records WITH a target', () => {
    const out = emitDataValue(FONT_TABLE, 0, 'LPCSTR[3]');
    assert.ok(out.includes(`(LPCSTR)${FONT16}`), `got: ${out}`);
  });

  it('agrees between the array path and the lone-slot path', () => {
    // A `pointer` array reaches one, a `pointer` field the other; a shape test
    // that differed between them would resolve a table and not its neighbour.
    assert.strictEqual(emitDataValue(ptr('0x006dc978'), 0, 'pointer'), `(pointer)${FONT16}`);
    assert.strictEqual(emitDataValue(ptr('0x006dc978'), 0, 'LPVOID'), `(LPVOID)${FONT16}`);
  });

  it('still takes a data global through the address-of it needs', () => {
    assert.strictEqual(emitDataValue(ptr('0x006fb0a4'), 0, 'pointer'), '(pointer)&gnFrameCount');
  });

  it('leaves an INTEGER slot on the integral spelling and the aggregate rule', () => {
    const table: DataValue = {
      kind: 'array', elements: [scalar('0x6dc978'), scalar('0x6dc970')],
    };
    const out = emitDataValue(table, 0, 'uint[2]');
    assert.ok(out.includes(`(uint)(uintptr_t)${FONT16}`), `got: ${out}`);
    assert.ok(!out.includes(`(uint)${FONT16}`), `never the pointer spelling: ${out}`);
    // And a lone one is still a coincidence, not a table.
    assert.strictEqual(emitDataValue(scalar('0x6dc978'), 0, 'uint'), '0x6dc978');
  });

  it('reads an INTEGER typedef as the integer it stands for', () => {
    // The same resolution, asked the other way: `D2Count` is `uint32_t`, so the
    // address goes through `uintptr_t` and never becomes a pointer.
    const table: DataValue = {
      kind: 'array', elements: [scalar('0x6dc978'), scalar('0x6dc970')],
    };
    const out = emitDataValue(table, 0, 'D2Count[2]');
    assert.ok(out.includes(`(D2Count)(uintptr_t)${FONT16}`), `got: ${out}`);
  });

  it('is not fooled by an ARRAY spelling, which is no pointer slot', () => {
    // A remaining `[N]` after the outer dimension came off is a 2-D row, and a
    // row is not an assignable pointer.
    const out = emitDataValue(ptr('0x006dc978'), 0, 'pointer[4]');
    assert.ok(out.includes('0x006dc978'), `got: ${out}`);
  });
});

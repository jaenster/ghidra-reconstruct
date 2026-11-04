/**
 * The pointer tables whose last entry stayed a raw 1.14d address.
 *
 * Every gaLanguageNames copy ends in a pointer to `"14"` (006cc77c), gaErrorTypeNames
 * and gnExcelRecordFieldNotFound point at `"???"` (006ccb30), gaChatCommandTable at
 * `"@"` (006d727c), gaDefenseReductionTable at `"Stam"`/`"Life"` (006e160c, ...,
 * `char[5]`) and `"Dam"` (006e1664, `char[4]`). Ghidra labels all of them; the tree
 * emitted `(char*)0x006cc77c` because none was in the snapshot's string list: the
 * extraction asked for strings of four characters or more, and the string table
 * refused a `char[N]` datum. A pointer into .rdata that nothing relocates reads the
 * original program's address in the rebuild.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  renderGlobalScalarInitializer,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import { stringDefinition } from '../codegen/declaration-closure.js';
import { extractAllStrings } from '../extract/strings.js';
import { DEFAULT_MIN_STRING_LENGTH } from '../extract/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString, GhidraConnection } from '../types.js';

/** As `list_strings` reports them (MemoryOps.listStrings: value, its length, the type name). */
const STRINGS = [
  ['006cc81c', 'English', 'string'],
  ['006cc77c', '14', 'TerminatedCString'],
  ['006ccb30', '???', 'TerminatedCString'],
  ['006d727c', '@', 'TerminatedCString'],
  ['006e160c', 'Stam', 'char[5]'],
  ['006e1664', 'Dam', 'char[4]'],
  ['006d0000', 'szAlready', 'char[16]'],
  ['006d0100', 'Other', 'string'],
].map(([address, value, encoding]) => ({
  address, value, length: value.length, encoding, xrefCount: 1,
})) as ExtractedString[];

/** A named global whose char[16] Ghidra also lists as a string, at the same address. */
const GLOBALS = [
  { name: 'gszNamedBuffer', address: '006d0000', size: 16, dataType: 'char[16]', scope: 'global' },
  { name: 'gszOther', address: '006d0100', size: 6, dataType: 'char[6]', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

function install(strings = STRINGS): void {
  const tables = buildGlobalAddressExtentTables(GLOBALS, strings);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set([...tables.stringConstantNames, 'gszNamedBuffer', 'gszOther']),
    imageBase: '0x400000',
  });
}

const pointer = (v: string): DataValue => ({ kind: 'pointer', value: v });

describe('pointers to short and char[N] strings', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    install();
  });

  it('the extraction asks Ghidra for every string, not only four characters and up', async () => {
    assert.strictEqual(DEFAULT_MIN_STRING_LENGTH, 1);
    const conn = {
      async sendCommand<T>(_c: string, params?: Record<string, unknown>): Promise<T> {
        const min = Number(params?.minLength ?? 4);
        const page = Number(params?.offset ?? 0) === 0 ? STRINGS.filter(s => s.value.length >= min) : [];
        return { strings: page, total: page.length } as T;
      },
    } as unknown as GhidraConnection;
    const got = await extractAllStrings(conn, { minLength: DEFAULT_MIN_STRING_LENGTH });
    assert.ok(got.some(s => s.address === '006cc77c'), 'the "14" every gaLanguageNames copy ends in');
    assert.ok(got.some(s => s.address === '006ccb30'), 'the "???" of gaErrorTypeNames');
  });

  it('names "14" where gaLanguageNames ends', () => {
    assert.strictEqual(emitDataValue(pointer('s_14_006cc77c'), 0, 'char *'), 's_14_006cc77c');
  });

  it('names "???" through its sanitized label, for an array element and a 4-byte global', () => {
    const out = emitDataValue(pointer('s_???_006ccb30'), 0, 'char *');
    assert.strictEqual(out, 's_____006ccb30');
    // gnExcelRecordFieldNotFound: a 4-byte char* whose value is the bare word.
    assert.strictEqual(renderGlobalScalarInitializer('006ccb30', 'char *'), 's_____006ccb30');
  });

  it('names "@" of gaChatCommandTable and the char[N] damage names', () => {
    assert.strictEqual(emitDataValue(pointer('s___006d727c'), 0, 'char *'), 's___006d727c');
    assert.strictEqual(emitDataValue(pointer('s_Stam_006e160c'), 0, 'char *'), 's_Stam_006e160c');
    assert.strictEqual(emitDataValue(pointer('s_Dam_006e1664'), 0, 'char *'), 's_Dam_006e1664');
  });

  it('defines a char[N] string at its declared size', () => {
    assert.deepStrictEqual(
      stringDefinition('s_Stam_006e160c', { value: 'Stam', length: 4, encoding: 'char[5]' }),
      { def: 'char s_Stam_006e160c[5] = "Stam";' },
    );
    assert.ok('reason' in stringDefinition('s_x', { value: 'Stamina', length: 7, encoding: 'char[5]' }));
  });

  it('never gives a named global\'s address a second, synthesized name', () => {
    const tables = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
    assert.ok(!tables.stringConstantNames.some(n => n.endsWith('_006d0000')), tables.stringConstantNames.join(','));
    assert.strictEqual(renderGlobalScalarInitializer('006d0000', 'char *'), '(char *)&gszNamedBuffer');
    // A plain string listed at a global's base made the address ambiguous: nine in v1931.
    assert.strictEqual(renderGlobalScalarInitializer('006d0100', 'char *'), '(char *)&gszOther');
  });
});

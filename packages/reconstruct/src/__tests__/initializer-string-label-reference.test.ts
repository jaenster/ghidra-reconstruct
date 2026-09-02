/**
 * A Ghidra string label is a NAME the tree can declare, not an address to fall
 * back to.
 *
 * `globals.D2Win.cpp` emitted
 *
 *   pointer aFontNames[15] = { (void*)0x006dc978, (void*)0x006dc970, ... };
 *
 * and `D2WINFONT_BuildFontPath` handed each element to `wsprintfA` as a `%s`,
 * so the recompiled executable read 0x006DC978 while building a font path.
 *
 * The snapshot says the elements are not numbers at all:
 *
 *   { "kind": "pointer", "value": "s_Font8_006dc978" }   ... x14, then DAT_00000000
 *
 * so they never reach the numeric resolver. They reach `emitPointerToSymbol`,
 * whose `unresolvedSymbolAddress` rule demotes `s_<text>_<addr>` back to its
 * address on the reasoning that "the generator emits no such declaration, so
 * `&s_Font8_006dc978` is an undeclared identifier". That reasoning is now stale:
 * the declaration closure gives every REFERENCED string constant an
 * `extern char N[];` in globals.h and exactly one definition. The label is
 * declarable, and demoting it throws away the one spelling that survives
 * relinking.
 *
 * So the demotion has to ask the address table first — the same table, the same
 * rule — and only fall back to the literal when nothing there can be named.
 *
 * Two things this pins that are NOT the fix, because both were proposed and
 * both were wrong: there is exactly one `Font8` in the snapshot, at the WINDOWS
 * address, so nothing is deduped by value; and the type reaches the emitter
 * intact (`pointer[15]`), so nothing is losing it.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  initializerAddressReferences,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';

/** The font-name run, exactly as `strings.ndjson` carries it. */
const STRINGS = [
  ['006dc978', 'Font8'],
  ['006dc970', 'Font16'],
  ['006dc968', 'Font30'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const GLOBALS = [
  { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

function install(): void {
  setMultidimArrayGlobals([]);
  setGlobalInitializerTypes(undefined);
  setAggregateTypeNames([]);
  const tables = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set([...tables.stringConstantNames, 'gnFrameCount']),
    imageBase: '0x400000',
  });
}

const ptr = (value: string): DataValue => ({ kind: 'pointer', value });

/** The table as the snapshot carries it: label names, then Ghidra's null. */
const FONT_TABLE: DataValue = {
  kind: 'array',
  elements: [ptr('s_Font8_006dc978'), ptr('s_Font16_006dc970'), ptr('DAT_00000000')],
};

describe('a string label named by a data initializer', () => {
  beforeEach(install);

  it('keeps the name in the `pointer` slot the font table declares', () => {
    const out = emitDataValue(FONT_TABLE, 0, 'pointer[3]');
    assert.ok(out.includes('s_Font8_006dc978'), `expected the label in: ${out}`);
    assert.ok(out.includes('s_Font16_006dc970'), `expected the label in: ${out}`);
    assert.ok(!/0x006dc9/.test(out), `no absolute address may survive: ${out}`);
  });

  it('keeps Ghidra\'s null element null', () => {
    assert.ok(emitDataValue(FONT_TABLE, 0, 'pointer[3]').includes('nullptr'));
  });

  it('decays into a char slot with no address-of', () => {
    // `char[N]` decays to `char*`; `&name` would be `char(*)[N]`.
    assert.strictEqual(
      emitDataValue(ptr('s_Font8_006dc978'), 0, 'char *'), 's_Font8_006dc978');
  });

  it('casts into a slot the decay does not fit', () => {
    assert.strictEqual(
      emitDataValue(ptr('s_Font8_006dc978'), 0, 'pointer'), '(pointer)s_Font8_006dc978');
  });

  it('records the name, so the closure declares and defines it', () => {
    emitDataValue(FONT_TABLE, 0, 'pointer[3]');
    const named = initializerAddressReferences();
    assert.ok(named.has('s_Font8_006dc978'), `expected it among ${[...named].join(', ')}`);
  });

  it('still demotes a label the table cannot name', () => {
    // No string record, nothing declarable: the address IS the content, and the
    // old rule is still the right one.
    const out = emitDataValue(ptr('s_Nope_00612340'), 0, 'pointer');
    assert.ok(out.includes('0x00612340'), `got: ${out}`);
    assert.ok(!out.includes('s_Nope'), `names nothing that is not declared: ${out}`);
  });

  it('still demotes an INTERIOR reference into a label', () => {
    // `base + n` is not a base, and the table is keyed by base.
    const out = emitDataValue(ptr('s_Font8_006dc978+2'), 0, 'pointer');
    assert.ok(out.includes('0x006dc97a'), `the interior literal stands: ${out}`);
  });

  it('leaves an integral slot on the integral spelling', () => {
    const out = emitDataValue(ptr('s_Font8_006dc978'), 0, 'uint');
    assert.ok(out.includes('(uint)(uintptr_t)s_Font8_006dc978') || out.includes('0x006dc978'),
      `got: ${out}`);
    assert.ok(!/^\(void\*\)/.test(out), `never a void* cast in an integer slot: ${out}`);
  });

  it('still resolves an ordinary global named the ordinary way', () => {
    assert.strictEqual(emitDataValue(ptr('gnFrameCount'), 0, 'int *'), '&gnFrameCount');
  });
});

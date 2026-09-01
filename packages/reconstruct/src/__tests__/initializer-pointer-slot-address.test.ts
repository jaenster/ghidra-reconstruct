/**
 * An address literal in a POINTER slot is an address, and one exact base proves it.
 *
 * `StaticInit_6cadf0` carries
 *
 *   static char * fnCursorVisibilityHook = (char *)0x006cc8b8;
 *   gpszWindowClassName = fnCursorVisibilityHook;
 *
 * and `0x006cc8b8` is the base of the string constant `"Diablo II"`. That value
 * reaches `RegisterClassA` as `lpszClassName`, so the recompiled executable
 * faults inside user32 reading an absolute 1.14d address that means nothing
 * after relinking. The same shape covers a whole run of globals —
 * `gpszD2LngFileName`, `gpszPaletteAct1Dat`, `szBnNewsChannelName` — because a
 * four-byte pointer never gets `initializedData` (`fetchInitializedData` only
 * asks Ghidra for `size > 4`), so its Ghidra `value` goes to
 * `renderGlobalScalarInitializer`, whether it is a global or a static local.
 *
 * The aggregate rule that guards the ARRAY path deliberately does NOT apply
 * here. That rule exists because an INTEGER slot could plausibly hold a number
 * that collides with an address, and only the slot's neighbours can say
 * otherwise. A slot whose declared type is a pointer is a slot that holds an
 * address — one exact base is evidence enough on its own, which is the same
 * standard `emitPointerToSymbol` already applies when Ghidra hands back a NAME
 * instead of a word.
 *
 * Exact bases only, as everywhere on this side: an interior address (base + n)
 * has no base in the table and keeps its literal.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateStaticLocalDeclaration,
  renderGlobalScalarInitializer,
  setInitializerAddressTable,
  initializerAddressReferences,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';

/** `"Diablo II"` at 006cc8b8, as `list_strings` reports it. */
const STRINGS = [
  ['006cc8b8', 'Diablo II'],
  ['006cc928', 'modstate0'],
  ['006cc920', 'modstate1'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const GLOBALS = [
  { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

function install(globals: AnalyzedDataSymbol[] = GLOBALS, strings = STRINGS): void {
  const tables = buildGlobalAddressExtentTables(globals, strings);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set([
      ...tables.stringConstantNames,
      ...globals.filter(g => g.scope === 'global').map(g => g.suggestedName || g.name),
    ]),
    imageBase: '0x400000',
  });
}

const pointer = (v: string): DataValue => ({ kind: 'pointer', value: v });
const scalar = (v: string): DataValue => ({ kind: 'scalar', value: v });

describe('an address literal in a pointer slot', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    install();
  });

  it('emits the bare string label for the window class name', () => {
    // `char[N]` decays to `char*`; `&name` would be `char(*)[N]`, and
    // `array-global-address-of` runs at priority 46 — before the address passes
    // — so a spurious `&` would never be cleaned up.
    const symbol = {
      name: 'fnCursorVisibilityHook',
      address: '006fbd60',
      size: 4,
      dataType: 'char *',
      scope: 'static-local',
      ownerFunction: 'StaticInit_6cadf0',
      value: '006cc8b8',
    } as unknown as AnalyzedDataSymbol;
    assert.strictEqual(
      generateStaticLocalDeclaration(symbol),
      'static char * fnCursorVisibilityHook = s_Diablo_II_006cc8b8;',
    );
  });

  it('resolves a GLOBAL pointer slot the same way as the function-local static', () => {
    // `char * gpszD2LngFileName = (char *)0x006d5ee0;` in globals.cpp is the same
    // defect: same renderer, same table, no `initializedData` on a 4-byte slot.
    assert.strictEqual(
      renderGlobalScalarInitializer('006cc8b8', 'char *'),
      's_Diablo_II_006cc8b8',
    );
  });

  it('resolves a pointer DataValue carrying the same word', () => {
    assert.strictEqual(emitDataValue(pointer('0x006cc8b8'), 0, 'char *'), 's_Diablo_II_006cc8b8');
  });

  it('needs no neighbour to corroborate it — one exact base is enough', () => {
    // The aggregate rule guards integer slots. A pointer slot holds an address
    // by declaration, so a lone match is not a coincidence worth doubting.
    const out = emitDataValue(pointer('0x006cc8b8'), 0, 'char *');
    assert.ok(!out.includes('0x006cc8b8'), `no absolute address may survive: ${out}`);
  });

  it('spells the slot type on any pairing a bare decay would not fit', () => {
    // `char[N]` decays to `char*` and to nothing else, so every other pointee
    // needs the cast that carries the address across unchanged.
    assert.strictEqual(
      emitDataValue(pointer('0x006cc8b8'), 0, 'uint8_t *'),
      '(uint8_t *)s_Diablo_II_006cc8b8',
    );
  });

  it('resolves a non-string global with the address-of it needs', () => {
    assert.strictEqual(
      emitDataValue(pointer('0x006fb0a4'), 0, 'int *'),
      '(int *)&gnFrameCount',
    );
  });

  it('leaves a pointer to a NAMED symbol exactly as it already was', () => {
    // The existing symbol path: Ghidra handed back a name, not a word.
    setMultidimArrayGlobals([{ name: 'gnFrameCount', dataType: 'int' }]);
    assert.strictEqual(emitDataValue(pointer('gnFrameCount'), 0, 'int *'), '&gnFrameCount');
    setMultidimArrayGlobals([]);
    // And a name Ghidra invented for a bare address still becomes that address.
    assert.strictEqual(emitDataValue(pointer('DAT_000a0000'), 0, 'int *'), '(int*)0x000a0000');
  });

  it('keeps a null pointer slot null', () => {
    assert.strictEqual(emitDataValue(pointer('0x00000000'), 0, 'char *'), 'nullptr');
    assert.strictEqual(emitDataValue(pointer('0x0'), 0, 'char *'), 'nullptr');
  });

  it('declines an INTERIOR address into a string', () => {
    // The table is keyed by base and the resolution is exact. `base + 3` names
    // no object here, and `s_x + 3` would be a guess about the extent that the
    // pointer case has no surrounding expression to check.
    const out = emitDataValue(pointer('0x006cc8bb'), 0, 'char *');
    assert.ok(out.includes('0x006cc8bb'), `the interior literal must stand: ${out}`);
    assert.ok(!out.includes('s_Diablo_II'), `and must not be spelled as the base: ${out}`);
  });

  it('leaves an INTEGER slot to the aggregate rule, untouched', () => {
    // A lone integer scalar on an exact base is still a number as far as this
    // side can tell.
    assert.strictEqual(emitDataValue(scalar('0x6cc8b8'), 0, 'uint'), '0x6cc8b8');
    // And a table of them still takes the integral spelling, not a pointer one.
    const table: DataValue = {
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0x6cc920')],
    };
    const out = emitDataValue(table, 0, 'uint');
    assert.ok(out.includes('(uint)(uintptr_t)s_modstate0_006cc928'), `got: ${out}`);
    assert.ok(!out.includes('&s_modstate'), `no address-of on an array: ${out}`);
  });

  it('records the name it referenced, so the closure declares it', () => {
    emitDataValue(pointer('0x006cc8b8'), 0, 'char *');
    assert.ok(
      initializerAddressReferences().has('s_Diablo_II_006cc8b8'),
      `expected the label among ${[...initializerAddressReferences()].join(', ')}`,
    );
  });

  it('never resolves a symbol the initializer could not name', () => {
    const fileLocal = [
      { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'file-local' },
    ] as unknown as AnalyzedDataSymbol[];
    install(fileLocal);
    const out = emitDataValue(pointer('0x006fb0a4'), 0, 'int *');
    assert.ok(out.includes('0x006fb0a4'), `the unreachable symbol keeps its literal: ${out}`);
  });

  it('holds the image-base floor', () => {
    install(GLOBALS, STRINGS);
    setInitializerAddressTable({
      globalAddresses: buildGlobalAddressExtentTables(GLOBALS, STRINGS).globalAddresses,
      stringConstantNames: buildGlobalAddressExtentTables(GLOBALS, STRINGS).stringConstantNames,
      referenceableNames: new Set(
        buildGlobalAddressExtentTables(GLOBALS, STRINGS).stringConstantNames),
      imageBase: '0x1000000',
    });
    const out = emitDataValue(pointer('0x006cc8b8'), 0, 'char *');
    assert.ok(out.includes('0x006cc8b8'), `below the floor stays a literal: ${out}`);
  });
});

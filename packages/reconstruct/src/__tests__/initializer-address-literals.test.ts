/**
 * An address literal in a DATA INITIALIZER is not reachable from the AST pass.
 *
 * `Fog/Engine/Application.cpp` carries
 *
 *   static uint gApplicationModeCommandLineArgumentArray[6] =
 *       { 0x6cc928, 0x6cc920, 0x6cc918, 0x6cc90c, 0x6cc900, 0x6cc8f8 };
 *
 * six absolute 1.14d `.rdata` addresses, each the base of a string constant.
 * `CLIENT_CheckIfApplicationModeIsInCommandLineAndSetItToArgument` casts each to
 * `char*` and walks it, so the recompiled executable reads unmapped memory at
 * 0x006CC928 — intermittently, because ASLR sometimes leaves the page mapped.
 *
 * `global-address-literal` cannot reach it: this block is emitted as TEXT by
 * `generateStaticLocalsBlock`, which `impl.ts` appends AFTER the body has been
 * parsed, transformed and emitted. The literals are `DataValue` scalars, not AST
 * nodes. So the resolution has to happen here, against the SAME table the pass
 * uses — `buildGlobalAddressExtentTables`.
 *
 * The rules are stricter than the pass's, because an initializer scalar has no
 * surrounding expression to corroborate it: exact bases only, and the decision
 * is taken per ARRAY — every non-zero element has to land on a symbol base, and
 * there have to be at least two of them. Six of six is a pointer table; one of
 * six is a coincidence.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  generateStaticLocalDeclaration,
  setInitializerAddressTable,
  initializerAddressReferences,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';

/** The six application-mode names, as `list_strings` reports them. */
const MODE_STRINGS = [
  ['006cc928', 'modstate0'],
  ['006cc920', 'modstate1'],
  ['006cc918', 'modstate2'],
  ['006cc90c', 'modstate3xx'],
  ['006cc900', 'modstate4xxxx'],
  ['006cc8f8', 'modstate5'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const GLOBALS = [
  { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

function install(globals: AnalyzedDataSymbol[] = GLOBALS, strings = MODE_STRINGS): void {
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

const scalar = (v: string): DataValue => ({ kind: 'scalar', value: v });

const MODE_TABLE: DataValue = {
  kind: 'array',
  elements: [
    scalar('0x6cc928'), scalar('0x6cc920'), scalar('0x6cc918'),
    scalar('0x6cc90c'), scalar('0x6cc900'), scalar('0x6cc8f8'),
  ],
};

describe('address literals in a data initializer', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    install();
  });

  it('resolves all six modstate addresses in the array they appear in', () => {
    const out = emitDataValue(MODE_TABLE, 0, 'uint');
    for (const [address, value] of [
      ['006cc928', 'modstate0'], ['006cc920', 'modstate1'], ['006cc918', 'modstate2'],
      ['006cc90c', 'modstate3xx'], ['006cc900', 'modstate4xxxx'], ['006cc8f8', 'modstate5'],
    ]) {
      assert.ok(
        out.includes(`s_${value}_${address}`),
        `expected the label for ${address} in: ${out}`,
      );
    }
    assert.ok(!/0x6cc9/.test(out), `no absolute address may survive: ${out}`);
  });

  it('spells the reference so it fits the integral slot it is stored in', () => {
    // The slot is `uint`. A `char[N]` name decays to `char*`, which is not an
    // integer — the conversion has to be written, and written so the braced
    // initializer sees a `uint` and never narrows.
    const out = emitDataValue(MODE_TABLE, 0, 'uint');
    assert.ok(
      out.includes('(uint)(uintptr_t)s_modstate0_006cc928'),
      `expected the integral spelling in: ${out}`,
    );
    // Never `&name`: that is `char(*)[N]`, one indirection off.
    assert.ok(!out.includes('&s_modstate'), `no address-of on an array: ${out}`);
  });

  it('emits the whole static-local line the way the .cpp needs it', () => {
    const symbol = {
      name: 'gApplicationModeCommandLineArgumentArray',
      address: '006cc958',
      size: 24,
      dataType: 'uint32_t',
      scope: 'static-local',
      ownerFunction: 'CLIENT_CheckIfApplicationModeIsInCommandLineAndSetItToArgument',
      initializedData: MODE_TABLE,
    } as unknown as AnalyzedDataSymbol;
    const line = generateStaticLocalDeclaration(symbol);
    assert.ok(line, 'expected a declaration');
    assert.ok(
      line!.startsWith('static uint32_t gApplicationModeCommandLineArgumentArray[6] = {'),
      `expected the array declaration, got: ${line}`,
    );
    assert.ok(line!.includes('(uint32_t)(uintptr_t)s_modstate0_006cc928'), `got: ${line}`);
  });

  it('records the names it referenced, so the closure declares them', () => {
    emitDataValue(MODE_TABLE, 0, 'uint');
    const named = initializerAddressReferences();
    for (const n of ['s_modstate0_006cc928', 's_modstate5_006cc8f8']) {
      assert.ok(named.has(n), `expected ${n} among ${[...named].join(', ')}`);
    }
  });

  it('leaves an array alone when only some elements resolve', () => {
    // One of six landing on a symbol is a coincidence, and rewriting it would
    // put a symbol reference next to five raw numbers in the same table.
    const mixed: DataValue = {
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0x10'), scalar('0x20'), scalar('0x30')],
    };
    const out = emitDataValue(mixed, 0, 'uint');
    assert.ok(out.includes('0x6cc928'), `the literal must stand: ${out}`);
    assert.ok(!out.includes('s_modstate'), `nothing may resolve: ${out}`);
  });

  it('leaves a lone scalar alone even when it hits a symbol base exactly', () => {
    const out = emitDataValue(scalar('0x6cc928'), 0, 'uint');
    assert.strictEqual(out, '0x6cc928');
    // A one-element array is a lone scalar too — there is no neighbour to
    // corroborate it.
    const single: DataValue = { kind: 'array', elements: [scalar('0x6cc928')] };
    assert.ok(emitDataValue(single, 0, 'uint').includes('0x6cc928'));
  });

  it('needs two resolved neighbours, not one and a pile of zeros', () => {
    const sparse: DataValue = {
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0'), scalar('0'), scalar('0')],
    };
    const out = emitDataValue(sparse, 0, 'uint');
    assert.ok(out.includes('0x6cc928'), `one symbol is not a table: ${out}`);
  });

  it('keeps zero slots as zero', () => {
    const withHoles: DataValue = {
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0'), scalar('0x6cc918')],
    };
    const out = emitDataValue(withHoles, 0, 'uint');
    assert.ok(out.includes('s_modstate0_006cc928'), `got: ${out}`);
    assert.ok(out.includes('s_modstate2_006cc918'), `got: ${out}`);
    assert.match(out, /\b0\b/, `the null slot stays null: ${out}`);
    assert.ok(!out.includes('(uintptr_t)0'), `zero is never a symbol: ${out}`);
  });

  it('resolves an ordinary global with the address-of it needs', () => {
    const pair: DataValue = {
      kind: 'array',
      elements: [scalar('0x6fb0a4'), scalar('0x6cc928')],
    };
    const out = emitDataValue(pair, 0, 'uint');
    assert.ok(out.includes('(uint)(uintptr_t)&gnFrameCount'), `expected &global in: ${out}`);
    assert.ok(out.includes('(uint)(uintptr_t)s_modstate0_006cc928'), `and the string in: ${out}`);
  });

  it('never resolves a symbol the initializer could not name', () => {
    // A file-local static is emitted `static` inside one .cpp; a reference to it
    // from anywhere else is undefined at link. Not referenceable, not resolved.
    const fileLocal = [
      { name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'file-local' },
    ] as unknown as AnalyzedDataSymbol[];
    install(fileLocal);
    const pair: DataValue = {
      kind: 'array',
      elements: [scalar('0x6fb0a4'), scalar('0x6cc928')],
    };
    const out = emitDataValue(pair, 0, 'uint');
    assert.ok(out.includes('0x6fb0a4'), `the unreachable symbol keeps its literal: ${out}`);
    assert.ok(!out.includes('s_modstate'), `and its neighbour is not resolved alone: ${out}`);
  });

  it('holds the image-base floor and the kernel ceiling', () => {
    const out = emitDataValue({
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0x6cc920')],
    }, 0, 'uint');
    assert.ok(out.includes('s_modstate0_006cc928'), `sanity: ${out}`);

    // A table built with an image base ABOVE these addresses admits neither.
    install(GLOBALS, MODE_STRINGS);
    setInitializerAddressTable({
      globalAddresses: buildGlobalAddressExtentTables(GLOBALS, MODE_STRINGS).globalAddresses,
      stringConstantNames: buildGlobalAddressExtentTables(GLOBALS, MODE_STRINGS).stringConstantNames,
      referenceableNames: new Set(
        buildGlobalAddressExtentTables(GLOBALS, MODE_STRINGS).stringConstantNames),
      imageBase: '0x1000000',
    });
    const above = emitDataValue({
      kind: 'array',
      elements: [scalar('0x6cc928'), scalar('0x6cc920')],
    }, 0, 'uint');
    assert.ok(above.includes('0x6cc928'), `below the floor stays a literal: ${above}`);
  });
});

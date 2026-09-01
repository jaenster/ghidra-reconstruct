/**
 * A string resolved by a CENTRAL GLOBALS unit's initializer must still be
 * declared, and the ordering says it is not.
 *
 * `generateGlobalsHeader` builds the declaration closure — the `extern char
 * s_X[];` in globals.h and the single matching definition the shared unit emits
 * — and `emitCentralGlobalsUnits` runs AFTER it. So a name that only a globals
 * unit's initializer resolves is added to `initializerAddressReferences()` too
 * late for the header that had to declare it:
 *
 *   globals.cpp:46909: error: 's_D2_LNG_006d5ee0' was not declared in this scope
 *
 * seventeen times over `globals.cpp`, `globals.Bnclient.cpp` and
 * `globals.D2Multi.cpp`.
 *
 * A static-local block does not have the problem — `impl.ts` emits it during
 * `generateFilesForFunctions`, earlier than either — which is exactly why
 * `s_Diablo_II_006cc8b8` came out declared and `s_D2_LNG_006d5ee0` did not. The
 * contrast is the whole diagnosis: it is not that the partitioned units take a
 * different path, it is that they run after the header.
 *
 * The gap is the RESOLUTION's, not the pointer slot's: an integer slot spelled
 * `(uint)(uintptr_t)s_name` in a partitioned unit loses its declaration the same
 * way, so both are pinned here.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateGlobalsHeader,
  generateGlobalsImpl,
  resetDeclaredNames,
  setDeclarationClosureDataContent,
  setDeclarationClosureEmitters,
  setDeclarationClosureModel,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { buildGlobalAddressExtentTables, ghidraStringLabelName } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol, DataValue, ExtractedString, ReconstructOptions,
} from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** The three `D2Lang` strings, as `list_strings` reports them. */
const STRINGS = [
  ['006d5ee0', 'D2.LNG'],
  ['006cc928', 'modstate0'],
  ['006cc920', 'modstate1'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const LNG_LABEL = ghidraStringLabelName(0x006d5ee0, 'D2.LNG');
const MODE_LABEL = ghidraStringLabelName(0x006cc928, 'modstate0');

/**
 * `char * gpszD2LngFileName = (char *)0x006d5ee0;` — a four-byte pointer, so
 * `fetchInitializedData` never fetched a `DataValue` for it and its Ghidra
 * `value` is all there is.
 */
const LNG_NAME_PTR = {
  name: 'gpszD2LngFileName', address: '006fc1a4', dataType: 'char *',
  suggestedType: 'char *', size: 4, isInitialized: true, value: '006d5ee0',
  xrefCount: 2, scope: 'global',
} as AnalyzedDataSymbol;

/** The integer-slot table, which DOES carry data and takes the other renderer. */
const MODE_TABLE: DataValue = {
  kind: 'array',
  elements: [{ kind: 'scalar', value: '0x6cc928' }, { kind: 'scalar', value: '0x6cc920' }],
};

const MODE_ARRAY = {
  name: 'gApplicationModeArray', address: '006cc958', dataType: 'uint32_t[2]',
  suggestedType: 'uint32_t[2]', size: 8, isInitialized: true,
  initializedData: MODE_TABLE, xrefCount: 1, scope: 'global',
} as unknown as AnalyzedDataSymbol;

const GLOBALS = [LNG_NAME_PTR, MODE_ARRAY];

function installAddressTable(): void {
  const tables = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set(tables.stringConstantNames),
    imageBase: '0x400000',
  });
}

describe('a string a globals UNIT resolves is declared by the header before it', () => {
  beforeEach(() => {
    resetDeclaredNames();
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    setDeclarationClosureModel([], []);
    setDeclarationClosureEmitters(new Set<string>(), () => null);
    setDeclarationClosureDataContent(
      STRINGS.map(s => ({ address: s.address, value: s.value, length: s.length, encoding: 'string' })));
    installAddressTable();
  });

  /**
   * Production order, and nothing else: the header first, then the units. No
   * function body names any of these labels, so the header has to have learned
   * about them from the initializers it is about to be followed by.
   */
  function emitInProductionOrder(): { header: string; owner: string; partition: string } {
    const header = generateGlobalsHeader(
      GLOBALS, options, [], undefined, undefined, new Map<string, number>([['gnUnrelated', 1]]));
    const owner = generateGlobalsImpl(
      GLOBALS, options, 'globals.h', undefined, new Set([MODE_ARRAY]), true);
    const partition = generateGlobalsImpl(
      GLOBALS, options, 'globals.h', undefined, new Set([LNG_NAME_PTR]));
    return { header, owner, partition };
  }

  it('declares the string a PARTITIONED unit\'s pointer slot resolves', () => {
    const { header, partition } = emitInProductionOrder();
    assert.match(partition, new RegExp(`= ${LNG_LABEL};`),
      'the partition unit must reference the label');
    assert.match(header, new RegExp(`^extern char ${LNG_LABEL}\\[\\];$`, 'm'),
      'and globals.h must have declared it');
  });

  it('defines it exactly once, in the unit that owns the closure', () => {
    const { owner, partition } = emitInProductionOrder();
    assert.match(owner, new RegExp(`^char ${LNG_LABEL}\\[\\] = "D2\\.LNG";$`, 'm'));
    assert.doesNotMatch(partition, new RegExp(`char ${LNG_LABEL}\\[\\] =`));
  });

  it('does the same for the INTEGER-slot spelling, not just pointer slots', () => {
    const { header, owner } = emitInProductionOrder();
    assert.match(owner, new RegExp(`\\(uintptr_t\\)${MODE_LABEL}`),
      'the integer slot keeps its own spelling');
    assert.match(header, new RegExp(`^extern char ${MODE_LABEL}\\[\\];$`, 'm'),
      'and it too must be declared');
  });

  it('records nothing for a slot that resolves to no symbol', () => {
    const unrelated = [{
      name: 'gnPlainNumber', address: '006fc200', dataType: 'int', suggestedType: 'int',
      size: 4, isInitialized: true, value: '0x10', xrefCount: 1, scope: 'global',
    } as AnalyzedDataSymbol];
    const header = generateGlobalsHeader(
      unrelated, options, [], undefined, undefined, new Map<string, number>());
    assert.doesNotMatch(header, /extern char s_/);
  });
});

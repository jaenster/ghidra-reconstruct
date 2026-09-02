/**
 * The extern and the definition read the same type off the same record, and the
 * test says so out loud.
 *
 * `globals.D2Win.cpp` carried
 *
 *   pointer aFontNames[15] = { (void*)0x006dc978, (void*)0x006dc970, ... };
 *
 * while `globals.h` carried `extern pointer aFontNames[15];` — a declaration
 * that knows the element type beside a definition that had apparently lost it.
 * That asymmetry read like a type going missing somewhere in the globals-unit
 * route, and it cost a diagnosis cycle: it was not real. Both sides compute
 * `normalizeGlobalDeclType(suggestedType || dataType)` off the SAME symbol, so
 * the route cannot lose it; the file was simply four hours older than the run it
 * was read as, and the `(void*)` spelling is what an EMPTY type produces — whose
 * own declaration would have been `extern  aFontNames;`.
 *
 * So the pair is pinned here, end to end, through the two emitters the tree
 * actually uses: if a declaration ever again knows an element type its
 * definition does not, this fails instead of looking like a live crash.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateExternDeclaration,
  generateGlobalsImpl,
  resetDeclaredNames,
  setDeclarationClosureEmitters,
  setDeclarationClosureModel,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol, DataValue, ExtractedString, ReconstructOptions,
} from '../types.js';

const options = {
  outputDir: '/tmp/test', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** Three of the fifteen font names D2WINFONT_BuildFontPath walks. */
const STRINGS = [
  ['006dc978', 'FONT16'],
  ['006dc970', 'FONT24'],
  ['006dc968', 'FONT30'],
].map(([address, value]) => ({
  address, value, length: value.length, encoding: 'string', xrefCount: 1,
})) as ExtractedString[];

const TABLE: DataValue = {
  kind: 'array',
  elements: [
    { kind: 'pointer', value: '0x006dc978' },
    { kind: 'pointer', value: '0x006dc970' },
    { kind: 'pointer', value: '0x006dc968' },
    { kind: 'pointer', value: '0x0' },
  ],
};

/** `pointer` is `typedef void* pointer` — an array of it, exactly as Ghidra models it. */
const A_FONT_NAMES = {
  name: 'aFontNames', address: '006fc000', size: 16,
  dataType: 'pointer[4]', suggestedType: 'pointer[4]',
  isInitialized: true, scope: 'global', xrefCount: 2, initializedData: TABLE,
} as unknown as AnalyzedDataSymbol;

function install(): void {
  resetDeclaredNames();
  setMultidimArrayGlobals([]);
  setGlobalInitializerTypes(undefined);
  setDeclarationClosureModel([], []);
  setDeclarationClosureEmitters(new Set<string>(), () => null);
  setAggregateTypeNames([]);
  const tables = buildGlobalAddressExtentTables([], STRINGS);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set(tables.stringConstantNames),
    imageBase: '0x400000',
  });
}

/** The unit as the tree emits it: one partition, not the closure owner. */
function partitionUnit(): string {
  return generateGlobalsImpl(
    [A_FONT_NAMES], options, 'globals.h', undefined, new Set([A_FONT_NAMES]));
}

describe('a typedef-pointer array in a partitioned globals unit', () => {
  beforeEach(install);

  it('declares the element type', () => {
    assert.strictEqual(
      generateExternDeclaration(A_FONT_NAMES), 'extern pointer aFontNames[4];');
  });

  it('defines it with the SAME element type the extern declared', () => {
    assert.ok(
      partitionUnit().includes('pointer aFontNames[4] = {'),
      `definition must match the extern:\n${partitionUnit()}`);
  });

  it('resolves every font name, so wsprintfA gets a string and not an address', () => {
    const out = partitionUnit();
    for (const label of ['s_FONT16_006dc978', 's_FONT24_006dc970', 's_FONT30_006dc968']) {
      assert.ok(out.includes(`(pointer)${label}`), `expected ${label} in:\n${out}`);
    }
    assert.ok(!/0x006dc9/.test(out), `no absolute address may survive:\n${out}`);
  });

  it('keeps the terminating null null', () => {
    assert.ok(partitionUnit().includes('nullptr'));
  });

  it('never spells the element `void*` while the extern says `pointer`', () => {
    // `(void*)` in this slot is the signature of an EMPTY declared type, whose
    // extern would have read `extern  aFontNames;`. The two cannot disagree.
    const out = partitionUnit();
    assert.ok(!out.includes('(void*)'), `the declared spelling is the cast:\n${out}`);
  });
});

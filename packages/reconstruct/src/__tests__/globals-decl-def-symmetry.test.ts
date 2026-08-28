/**
 * Regression test: globals.h and globals.cpp must declare and define the SAME
 * set of symbols with the SAME types. Every divergence between the two emitters
 * is a compile error in globals.cpp.
 *
 * Two divergences existed, both visible in recon/diablo-2:
 *
 * 1. TYPE. `generateExternDeclaration` mapped Ghidra's no-C-equivalent artifact
 *    types (`Alignment`, `IMAGE_*`, `VS_VERSION_INFO`) to `uint8_t`; the three
 *    definition blocks did not:
 *      globals.cpp:42    IMAGE_DOS_HEADER IMAGE_DOS_HEADER__00400000 = { ... };
 *        -> conflicting declaration (globals.h says uint8_t)
 *      globals.cpp:69958 Alignment LAB_00687d4a = align(1);
 *        -> 'Alignment' does not name a type
 *
 * 2. SET. globals.h filtered switch-jump-table symbols, relative-offset jump
 *    entries and array-element aliases out of the declaration set; globals.cpp
 *    filtered none of them, so it defined symbols nothing declares — including
 *    `LAB_*`/`SUB_*` alignment padding that is not program data at all.
 *
 * A third, related shape: Ghidra names a table after its element type, so the
 * variable name and the type name collide —
 *   globals.h:4772   extern D2NpcMenuOptions D2NpcMenuOptions[48];
 *   globals.cpp:75773 D2NpcMenuOptions D2NpcMenuOptions[48] = { ... };
 *     -> 'D2NpcMenuOptions' does not name a type  (the variable now hides the class)
 * The elaborated specifier `struct D2NpcMenuOptions` is unambiguous in both.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  generateExternDeclaration,
  generateGlobalsImpl,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/** globals.cpp:69958 — x86 alignment padding Ghidra labels as data. */
const ALIGNMENT_PAD: AnalyzedDataSymbol = {
  name: 'LAB_00687d4a', address: '00687d4a', dataType: 'Alignment',
  suggestedType: 'Alignment', size: 1, isInitialized: true, value: 'align(1)',
  xrefCount: 0, scope: 'global',
} as AnalyzedDataSymbol;

/** globals.cpp:42 — the PE header Ghidra types with the SDK struct. */
const DOS_HEADER: AnalyzedDataSymbol = {
  name: 'IMAGE_DOS_HEADER__00400000', address: '00400000', dataType: 'IMAGE_DOS_HEADER',
  suggestedType: 'IMAGE_DOS_HEADER', size: 64, isInitialized: true, value: '0',
  xrefCount: 1, scope: 'global',
} as AnalyzedDataSymbol;

/** globals.h:4772 — the table named after its own element struct. */
const SELF_NAMED_TABLE: AnalyzedDataSymbol = {
  name: 'D2NpcMenuOptions', address: '006fb3a0', dataType: 'D2NpcMenuOptions[48]',
  suggestedType: 'D2NpcMenuOptions[48]', size: 48 * 16, isInitialized: true, value: '0',
  xrefCount: 9, scope: 'global',
} as AnalyzedDataSymbol;

const DATA_TYPES = [
  { name: 'D2NpcMenuOptions', kind: 'STRUCTURE', category: '/D2Client', size: 16, fields: [] },
] as unknown as ExtractedDataType[];

describe('globals.h and globals.cpp agree on type and on membership', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('maps a no-C-equivalent artifact type the same way on both sides', () => {
    assert.strictEqual(
      generateExternDeclaration(DOS_HEADER),
      'extern uint8_t IMAGE_DOS_HEADER__00400000;'
    );
    const impl = generateGlobalsImpl([DOS_HEADER], options);
    assert.doesNotMatch(impl, /^IMAGE_DOS_HEADER\s+IMAGE_DOS_HEADER__00400000/m);
    assert.match(impl, /^uint8_t IMAGE_DOS_HEADER__00400000 = 0;$/m);
  });

  it('does not DEFINE alignment padding that globals.h refuses to declare', () => {
    // `LAB_*` is filtered from the declaration set by isSwitchTableSymbol.
    const impl = generateGlobalsImpl([ALIGNMENT_PAD], options);
    assert.doesNotMatch(impl, /LAB_00687d4a/);
    assert.doesNotMatch(impl, /Alignment/);
    assert.doesNotMatch(impl, /align\(1\)/);
  });

  it('does not DEFINE a per-element alias of an array it also defines', () => {
    const parent = { ...SELF_NAMED_TABLE, name: 'pAutoMapDC6', dataType: 'DC6*[4]', suggestedType: 'DC6*[4]' } as AnalyzedDataSymbol;
    const element = { ...parent, name: 'pAutoMapDC6[1]', address: '006fb3a4' } as AnalyzedDataSymbol;
    const impl = generateGlobalsImpl([parent, element], options);
    assert.doesNotMatch(impl, /pAutoMapDC6\[1\]\s*=/);
  });

  it('elaborates a struct type that collides with a global variable name', () => {
    setMultidimArrayGlobals([SELF_NAMED_TABLE]);
    setGlobalInitializerTypes(DATA_TYPES);
    assert.strictEqual(
      generateExternDeclaration(SELF_NAMED_TABLE),
      'extern struct D2NpcMenuOptions D2NpcMenuOptions[48];'
    );
    const impl = generateGlobalsImpl([SELF_NAMED_TABLE], options);
    assert.match(impl, /^struct D2NpcMenuOptions D2NpcMenuOptions\[48\]/m);
  });

  it('elaborates EVERY use of the colliding type, not just the colliding symbol', () => {
    // Once the variable D2NpcMenuOptions exists, the name denotes the variable
    // for the rest of the TU — so a second global of that type needs the
    // elaborated specifier too, wherever it is declared.
    setMultidimArrayGlobals([SELF_NAMED_TABLE]);
    setGlobalInitializerTypes(DATA_TYPES);
    const plain = { ...SELF_NAMED_TABLE, name: 'gaNpcMenuOptions' } as AnalyzedDataSymbol;
    assert.strictEqual(
      generateExternDeclaration(plain),
      'extern struct D2NpcMenuOptions gaNpcMenuOptions[48];'
    );
  });

  it('leaves a struct type that collides with nothing unelaborated', () => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(DATA_TYPES);
    const plain = { ...SELF_NAMED_TABLE, name: 'gaNpcMenuOptions' } as AnalyzedDataSymbol;
    assert.strictEqual(
      generateExternDeclaration(plain),
      'extern D2NpcMenuOptions gaNpcMenuOptions[48];'
    );
  });
});

/**
 * BSS (uninitialized) global *definitions* must normalize their type exactly the
 * way the extern *declaration* does. If the two paths disagree, globals.cpp and
 * globals.h declare the same symbol differently and the build breaks on a
 * mismatch that neither file looks wrong on its own.
 *
 * All four declaration paths - the extern in globals.h, the definition in
 * globals.cpp, the co-located definition in a struct .cpp, and the static local
 * injected into a body - route through `normalizeGhidraType` for this reason.
 *
 * Two spellings arrive from Ghidra that are not C++:
 *
 *   `undefined` / `auto`   a slot whose type is undecided. It is ONE BYTE, and
 *                          the replacement has to keep the width: `void*` (what
 *                          this test asserted until 446a700) turned a 1-byte
 *                          integer slot into a 4-byte pointer, which is a
 *                          silently wrong stride wherever the symbol is indexed.
 *                          `uint8_t` is what `undefined1` already maps to.
 *   `T *32`                Ghidra's pointer-SIZE annotation, meaning "a 32-bit
 *                          pointer to T" - not C syntax. `void *32 x;` is
 *                          "expected unqualified-id before numeric constant".
 *                          357 data symbols still carry it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  generateGlobalsImpl,
  generateColocatedGlobalsImpl,
  generateExternDeclaration,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

/**
 * Real 1.14d Game.exe BSS symbol, verbatim from the extraction snapshot:
 * Ghidra types it bare `undefined` and models it as ONE byte. The `p` in the
 * name is Blizzard's, not a width - the slot really is 1 byte wide.
 */
const UNDEFINED_BSS: AnalyzedDataSymbol = {
  name: 'pTradePage2GridScreenCoordinates',
  address: '007bca30',
  dataType: 'undefined',
  suggestedType: 'uint8_t',
  size: 1,
  isInitialized: false,
  xrefCount: 3,
  scope: 'global',
  namespace: 'D2Client::UI::Inv',
};

/**
 * `auto` is the older spelling of the same undecided slot. No global in the
 * current snapshot arrives as `auto` any more, so this is a defensive case:
 * it pins that if the spelling comes back it lands on the same 1-byte answer
 * rather than silently on a pointer.
 */
const AUTO_BSS: AnalyzedDataSymbol = {
  ...UNDEFINED_BSS, name: 'pLegacyAutoSlot', dataType: 'auto', suggestedType: undefined,
};

/**
 * The same slot with no `suggestedType` at all. It keeps Ghidra's own spelling,
 * which is legal only because d2_platform.h carries `typedef uint8_t undefined;`
 * - so the width is right on this path too. Pinned because dropping that typedef
 * would turn every one of these into "'undefined' does not name a type" and the
 * failure would point at the header, not at here.
 */
const BARE_UNDEFINED: AnalyzedDataSymbol = {
  ...UNDEFINED_BSS, name: 'pBareUndefinedSlot', suggestedType: undefined,
};

/**
 * `ExceptionList` is the real TEB field Ghidra hands back as `void *32`, but it
 * is INITIALIZED in the program. No uninitialized `*32` symbol exists, so
 * running it through the BSS path is a constructed case - the point being that
 * the normalization is a property of the path, not of the symbol that took it.
 */
const PTR32_BSS: AnalyzedDataSymbol = {
  name: 'ExceptionList',
  address: 'ffdff000',
  dataType: 'void *32',
  size: 4,
  isInitialized: false,
  xrefCount: 2,
  scope: 'global',
  namespace: 'D2Client::UI::Inv',
};

describe('BSS global definitions normalize their type like the extern does', () => {
  it('emits a one-byte slot for `undefined`, keeping the width', () => {
    const out = generateGlobalsImpl([UNDEFINED_BSS], options);
    assert.match(out, /^uint8_t\s+pTradePage2GridScreenCoordinates;$/m);
    // The pre-446a700 answer widened a 1-byte slot to a 4-byte pointer.
    assert.doesNotMatch(out, /^void\*\s+pTradePage2GridScreenCoordinates;$/m);
  });

  it('gives the legacy `auto` spelling the same one-byte answer', () => {
    const out = generateGlobalsImpl([AUTO_BSS], options);
    // `auto x;` with no initializer is "declaration of variable with deduced
    // type requires an initializer" - it must not survive to the output.
    assert.doesNotMatch(out, /^auto\s+pLegacyAutoSlot;$/m);
    assert.match(out, /^uint8_t\s+pLegacyAutoSlot;$/m);
  });

  it('leaves bare `undefined`, which d2_platform.h typedefs to uint8_t', () => {
    const out = generateGlobalsImpl([BARE_UNDEFINED], options);
    assert.match(out, /^undefined\s+pBareUndefinedSlot;$/m);
    assert.doesNotMatch(out, /^void\*\s+pBareUndefinedSlot;$/m);
  });

  it('strips the Ghidra pointer-size annotation from a BSS definition', () => {
    const out = generateGlobalsImpl([PTR32_BSS], options);
    assert.doesNotMatch(out, /void\s*\*\s*32\s+ExceptionList;/);
    assert.match(out, /^void\*\s+ExceptionList;$/m);
  });

  it('applies the same normalization in the co-located BSS block', () => {
    const out = generateColocatedGlobalsImpl([UNDEFINED_BSS, PTR32_BSS], options);
    assert.doesNotMatch(out, /void\s*\*\s*32\s+ExceptionList;/);
    assert.match(out, /^uint8_t\s+pTradePage2GridScreenCoordinates;$/m);
    assert.match(out, /^void\*\s+ExceptionList;$/m);
  });

  it('the definition agrees with the extern declaration it must match', () => {
    assert.strictEqual(
      generateExternDeclaration(UNDEFINED_BSS),
      'extern uint8_t pTradePage2GridScreenCoordinates;'
    );
    assert.strictEqual(
      generateExternDeclaration(PTR32_BSS),
      'extern void* ExceptionList;'
    );
  });
});

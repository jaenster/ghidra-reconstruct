/**
 * Regression test: BSS (uninitialized) global *definitions* must normalize the
 * type the same way the extern *declaration* does.
 *
 * `generateExternDeclaration` (globals-header.ts ~482) does:
 *
 *     if (type === 'auto') type = 'void*';
 *     type = type.replace(/\s*\*\s*\d+\b/g, '*');   // "void *32" -> "void*"
 *
 * Both "Uninitialized data (BSS)" blocks in `generateGlobalsImpl` and
 * `generateColocatedGlobalsImpl` do a bare
 * `const type = global.suggestedType || global.dataType;` with no normalization,
 * so globals.cpp ends up disagreeing with globals.h:
 *
 *   recon/diablo-2/globals.h:4801   extern void* pTradePage2GridScreenCoordinates;
 *   recon/diablo-2/globals.cpp:90476  auto pTradePage2GridScreenCoordinates;
 *
 * `auto x;` with no initializer is a hard error ("declaration of variable with
 * deduced type requires an initializer") - ~911 of them in the tree.
 *
 * The same missing `*NN` strip leaks Ghidra's pointer-size syntax into the
 * definition; `void *32` is visible on initialized globals at
 * recon/diablo-2/globals.cpp:70704 (`void *32 ExceptionList = ...`) and on a
 * static local at recon/diablo-2/D2Common/DataTbls/BeltsTbls.cpp:19
 * (`static D2BeltsTxt *32 pTxtBelts = 0;`) - ~52 errors.
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

/** globals.h:4801 / globals.cpp:90476 - real 1.14d Game.exe BSS symbol. */
const AUTO_BSS: AnalyzedDataSymbol = {
  name: 'pTradePage2GridScreenCoordinates',
  address: '006fc140',
  dataType: 'auto',
  size: 4,
  isInitialized: false,
  xrefCount: 3,
  scope: 'global',
  namespace: 'D2Client::UI::Inv',
};

/** globals.cpp:70704 - the TEB field type Ghidra hands back as "void *32". */
const PTR32_BSS: AnalyzedDataSymbol = {
  name: 'ExceptionList',
  address: '006fc200',
  dataType: 'void *32',
  size: 4,
  isInitialized: false,
  xrefCount: 2,
  scope: 'global',
  namespace: 'D2Client::UI::Inv',
};

describe('BSS global definitions normalize their type like the extern does', () => {
  it('emits `void* NAME;` for a dataType of `auto`, never `auto NAME;`', () => {
    const out = generateGlobalsImpl([AUTO_BSS], options);

    // `auto pTradePage2GridScreenCoordinates;` does not compile.
    assert.doesNotMatch(out, /^auto\s+pTradePage2GridScreenCoordinates;$/m);
    assert.match(out, /^void\*\s+pTradePage2GridScreenCoordinates;$/m);
  });

  it('strips the Ghidra pointer-size annotation from a BSS definition', () => {
    const out = generateGlobalsImpl([PTR32_BSS], options);

    // `void *32 ExceptionList;` -> "expected unqualified-id before numeric constant"
    assert.doesNotMatch(out, /void\s*\*\s*32\s+ExceptionList;/);
    assert.match(out, /^void\*\s+ExceptionList;$/m);
  });

  it('applies the same normalization in the co-located BSS block', () => {
    const out = generateColocatedGlobalsImpl([AUTO_BSS, PTR32_BSS], options);

    assert.doesNotMatch(out, /^auto\s+pTradePage2GridScreenCoordinates;$/m);
    assert.doesNotMatch(out, /void\s*\*\s*32\s+ExceptionList;/);
    assert.match(out, /^void\*\s+pTradePage2GridScreenCoordinates;$/m);
    assert.match(out, /^void\*\s+ExceptionList;$/m);
  });

  it('the definition agrees with the extern declaration it must match', () => {
    // This half already works - it is the contract the definition side breaks.
    assert.strictEqual(
      generateExternDeclaration(AUTO_BSS),
      'extern void* pTradePage2GridScreenCoordinates;'
    );
    assert.strictEqual(
      generateExternDeclaration(PTR32_BSS),
      'extern void* ExceptionList;'
    );
  });
});

/**
 * Ghidra renders a `char`'s value as the CHARACTER, not as a number, and a
 * `char[N]`'s value as the text of its bytes. Three emitters turned that into an
 * initializer by hand and all three got it wrong in different ways:
 *
 *   globals.cpp:173879  char CHAR_C_006ed5b4 = C;              -> 'C' undeclared
 *   globals.cpp:173866  char gTxtCompilationMemPool[4] = { end };
 *   globals.cpp:173843  char szOOGPasswordDialogTimeFmt = ;    (the value was a CR)
 *   Storm/Source/SBig.cpp:37  static char s__D_0070888c[4] = { .D };
 *   globals.cpp:167691  GroupIconResource Rsrc_GroupIcon_65_409 = GroupIcon;
 *
 * All fixtures are verbatim from the emitted tree at ba138d8d9 and their values
 * verbatim from the extraction snapshot.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  renderGlobalScalarInitializer,
  generateGlobalsImpl,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
  setKnownFuncDefTypedefs,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

function global(over: Partial<AnalyzedDataSymbol>): AnalyzedDataSymbol {
  return {
    name: 'x', address: '00600000', dataType: 'char', suggestedType: 'char',
    size: 1, isInitialized: true, xrefCount: 1, scope: 'global', ...over,
  } as AnalyzedDataSymbol;
}

describe('character data whose value Ghidra renders as text', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('quotes a single character instead of emitting it as an identifier', () => {
    assert.strictEqual(renderGlobalScalarInitializer('C', 'char'), "'C'");
  });

  it('escapes a control byte instead of breaking the line in half', () => {
    // szOOGPasswordDialogTimeFmt @006cff08 — the value IS a carriage return.
    assert.strictEqual(renderGlobalScalarInitializer('\r', 'char'), "'\\x0d'");
  });

  it('spreads a char array over its declared length, NUL-padded', () => {
    // gTxtCompilationMemPool @006d9060 is char[4] holding "end\0".
    assert.strictEqual(renderGlobalScalarInitializer('end', 'char[4]', 4), "'e', 'n', 'd', 0");
    // gsCharSelContext @006d5830 is char[4] holding "*".
    assert.strictEqual(renderGlobalScalarInitializer('*', 'char[4]', 4), "'*', 0, 0, 0");
  });

  it('escapes a backslash byte rather than starting an escape sequence', () => {
    // szKOR @006dc9d8 is char[4] and its fourth byte is 0x5C.
    assert.strictEqual(renderGlobalScalarInitializer('KOR\\', 'char[4]', 4), "'K', 'O', 'R', '\\\\'");
  });

  it('leaves a byte-typed global as a NUMBER — Ghidra renders those as hex', () => {
    // The distinction that matters: `uint8_t x = '0'` is 0x30, not 0.
    assert.strictEqual(renderGlobalScalarInitializer('0', 'uint8_t'), '0');
    assert.strictEqual(renderGlobalScalarInitializer('0x10', 'uint8_t'), '0x10');
  });

  it('treats a resource pseudo-type\'s value as listing text, not as a symbol', () => {
    assert.strictEqual(renderGlobalScalarInitializer('GroupIcon', 'GroupIconResource'), '{}');
    assert.strictEqual(renderGlobalScalarInitializer('<Icon-Image>', 'IconResource'), '{}');
  });

  it('carries all of it through the globals.cpp emitter', () => {
    const impl = generateGlobalsImpl([
      global({ name: 'CHAR_C_006ed5b4', address: '006ed5b4', value: 'C' }),
      global({
        name: 'gTxtCompilationMemPool', address: '006d9060', value: 'end',
        dataType: 'char[4]', suggestedType: 'char[4]', size: 4,
      }),
    ], options);
    assert.match(impl, /^char CHAR_C_006ed5b4 = 'C';$/m);
    assert.match(impl, /^char gTxtCompilationMemPool\[4\] = \{ 'e', 'n', 'd', 0 \};$/m);
  });
});

describe('a funcdef-typed slot initialised from an address', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('casts to the typedef, which already carries the indirection', () => {
    // gaKeyBindingEnabled @00712698 — Ghidra types it `pfnD2CmdHandler *`
    // because it models the funcdef as the FUNCTION, while the emitted typedef
    // is `void (__stdcall *pfnD2CmdHandler)()`. The declaration printer strips
    // the star; this renderer did not, so the cast was one star wider than the
    // declaration it initialised.
    setKnownFuncDefTypedefs(new Set(['pfnD2CmdHandler']));
    try {
      assert.strictEqual(
        renderGlobalScalarInitializer('00468940', 'pfnD2CmdHandler *'),
        '(pfnD2CmdHandler)0x00468940',
      );
    } finally {
      setKnownFuncDefTypedefs(new Set());
    }
  });

  it('leaves an ordinary pointer slot with the star it really has', () => {
    assert.strictEqual(
      renderGlobalScalarInitializer('006d8768', 'uint8_t *'),
      '(uint8_t *)0x006d8768',
    );
  });
});

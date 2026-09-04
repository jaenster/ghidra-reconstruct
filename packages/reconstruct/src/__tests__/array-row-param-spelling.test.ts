/**
 * A `T (*)[N]` PARAMETER has to be spelled the same way on both sides.
 *
 * Ghidra records `D2GFX_SetPaletteTable(LPPALETTEENTRY[72] *)`. Flattened to
 * `LPPALETTEENTRY *` the body's `*pPaletteTable` reaches the first palette
 * pointer instead of the 72-entry row, so the spelling goes through the
 * `D2Row_LPPALETTEENTRY_72` typedef.
 *
 * That reached the DECLARATION only: `impl.ts` carried its own copy of
 * `sigType` without the row branch, so the definition still said
 * `LPPALETTEENTRY *`. Two spellings are two mangled names, and the definition
 * stopped satisfying the declaration — three undefined symbols at link, of
 * which two were this very function and its palette sibling.
 *
 * The declaration and the definition must agree on every parameter spelling;
 * there is no signature path that may hold its own opinion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateFunctionDeclaration, sigType } from '../codegen/header.js';
import { generateImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

function fn(over: Partial<ExtractedFunction> & { name: string }): ExtractedFunction {
  return {
    address: '0x006fa0e0',
    signature: `void ${over.name}(void)`,
    returnType: 'void',
    parameters: [],
    localVariables: [],
    callingConvention: '__stdcall',
    size: 32,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    decompiled: '',
    ...over,
  } as ExtractedFunction;
}

/** The parameter list the emitted text declares for `name`, whitespace-folded. */
function paramList(code: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`).exec(code);
  assert.ok(m, `no signature for ${name} in:\n${code}`);
  return m![1].replace(/\s+/g, ' ').trim();
}

describe('a pointer-to-array parameter', () => {
  const setPaletteTable = fn({
    name: 'D2GFX_SetPaletteTable',
    parameters: [{ name: 'pPaletteTable', dataType: 'LPPALETTEENTRY[72] *' }],
    decompiled: [
      'void __stdcall D2GFX_SetPaletteTable(LPPALETTEENTRY (*pPaletteTable)[72])',
      '{',
      '  return;',
      '}',
    ].join('\n'),
  } as Partial<ExtractedFunction> & { name: string });

  const allocMonsterRegion = fn({
    name: 'AllocMonsterRegion',
    address: '0x006324b0',
    returnType: 'int',
    parameters: [{ name: 'pRegions', dataType: 'D2MonsterRegionStrc[1024] *' }],
    decompiled: [
      'int __fastcall AllocMonsterRegion(D2MonsterRegionStrc (*pRegions)[1024])',
      '{',
      '  return 0;',
      '}',
    ].join('\n'),
  } as Partial<ExtractedFunction> & { name: string });

  it('spells the row through its typedef, not through the element', () => {
    assert.strictEqual(sigType('LPPALETTEENTRY[72] *'), 'D2Row_LPPALETTEENTRY_72 *');
    assert.strictEqual(
      sigType('D2MonsterRegionStrc[1024] *'),
      'D2Row_D2MonsterRegionStrc_1024 *',
    );
  });

  for (const func of [setPaletteTable, allocMonsterRegion]) {
    it(`declares and defines ${func.name} with the same parameter type`, () => {
      const decl = generateFunctionDeclaration(func, options);
      const impl = generateImplementation(
        'D2gfx/D2GFX', [func], undefined, 'D2gfx/D2GFX.h', options,
        undefined, undefined, new Set<string>(),
      );

      const declared = paramList(decl, func.name);
      const defined = paramList(impl, func.name);

      assert.match(declared, /^D2Row_\w+_\d+ \*/, `declaration flattened: ${declared}`);
      assert.strictEqual(
        defined, declared,
        'definition and declaration must mangle to the same symbol',
      );
    });
  }
});

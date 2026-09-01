/**
 * Regression test: globals.h emits function-pointer typedefs in full, so every
 * type named in their signature needs a declaration above them.
 *
 * Real 1.14d Game.exe case. `MISSILESSRVDMGFUNCS` (a static local in
 * D2Game/Missiles/MissilesMode.cpp) is typed `D2MissileSrvDmgFunc *[31]`, so the
 * typedef is only ever reached through a POINTER. The by-value worklist in
 * collectGlobalForwardDeclarations therefore never walks its signature, yet the
 * pointer-only branch still emits the whole typedef:
 *
 *   recon/diablo-2/globals.h:401
 *     typedef void (*D2MissileSrvDmgFunc)(D2GameStrc * pGame, D2UnitStrc * pMissile,
 *                                         D2UnitStrc * pTarget,
 *                                         D2MissileDamageDataStrc * pDamage);
 *
 * `D2MissileDamageDataStrc` has no `struct D2MissileDamageDataStrc;` above it and
 * no header of its own included, so every TU that includes globals.h dies with
 * "'D2MissileDamageDataStrc' has not been declared" — 353 errors across 237 of
 * the 405 generated files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateGlobalsHeader } from '../codegen/globals-header.js';
import type {
  AnalyzedDataSymbol,
  ExtractedDataType,
  ExtractedFunctionDefinition,
  ExtractedStruct,
  ReconstructOptions,
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

/** D2Game/Missiles/MissilesMode.cpp:5650 — `static D2MissileSrvDmgFunc MISSILESSRVDMGFUNCS[31]`. */
const MISSILE_DMG_TABLE: AnalyzedDataSymbol = {
  name: 'MISSILESSRVDMGFUNCS',
  address: '006fdc78',
  dataType: 'D2MissileSrvDmgFunc *[31]',
  size: 124,
  isInitialized: true,
  xrefCount: 1,
  scope: 'static-local',
  ownerFunction: 'MISSILES_SrvDoFunc',
};

/** The Ghidra funcdef behind globals.h:401. */
const D2MissileSrvDmgFunc: ExtractedFunctionDefinition = {
  name: 'D2MissileSrvDmgFunc',
  category: '/Diablo2/MISSILE',
  size: 4,
  kind: 'FUNCTION_DEFINITION',
  returnType: 'void',
  parameters: [
    { name: 'pGame', dataType: 'D2GameStrc *', ordinal: 0 },
    { name: 'pMissile', dataType: 'D2UnitStrc *', ordinal: 1 },
    { name: 'pTarget', dataType: 'D2UnitStrc *', ordinal: 2 },
    { name: 'pDamage', dataType: 'D2MissileDamageDataStrc *', ordinal: 3 },
  ],
};

/** D2Game/D2MissileDamageDataStrc.h:12 — the type that goes undeclared. */
const D2MissileDamageDataStrc: ExtractedStruct = {
  name: 'D2MissileDamageDataStrc',
  category: '/Diablo2/MISSILE',
  size: 0x60,
  kind: 'STRUCTURE',
  fields: [
    { name: 'nFlags', dataType: 'int', offset: 0x00, size: 4 },
    { name: 'nMinDamage', dataType: 'int', offset: 0x04, size: 4 },
    { name: 'nMaxDamage', dataType: 'int', offset: 0x08, size: 4 },
  ],
};

const dataTypes: ExtractedDataType[] = [D2MissileSrvDmgFunc, D2MissileDamageDataStrc];

describe('function-pointer typedefs declare the types their signature names', () => {
  it('forward-declares a struct that only a pointer-reached funcdef parameter names', () => {
    const out = generateGlobalsHeader([MISSILE_DMG_TABLE], options, dataTypes);

    // The typedef must still be emitted...
    assert.match(out, /typedef void \(\*D2MissileSrvDmgFunc\)\(/);
    // ...and the parameter type it names must be declared.
    assert.match(out, /^struct D2MissileDamageDataStrc;$/m);
  });

  it('declares every signature type before the typedef that uses it', () => {
    const out = generateGlobalsHeader([MISSILE_DMG_TABLE], options, dataTypes);
    const lines = out.split('\n');
    const typedefAt = lines.findIndex(l => l.includes('(*D2MissileSrvDmgFunc)'));
    assert.ok(typedefAt >= 0, 'typedef not emitted at all');

    for (const param of ['D2GameStrc', 'D2UnitStrc', 'D2MissileDamageDataStrc']) {
      const declAt = lines.findIndex(l => new RegExp(`^struct ${param};$`).test(l));
      assert.ok(declAt >= 0, `${param} is never declared`);
      assert.ok(declAt < typedefAt, `${param} is declared after the typedef that uses it`);
    }
  });

  it('follows a funcdef whose parameter is itself a funcdef typedef', () => {
    const outer: ExtractedFunctionDefinition = {
      name: 'D2ObjectsInitFnFunc',
      category: '/Diablo2/OBJECT',
      size: 4,
      kind: 'FUNCTION_DEFINITION',
      returnType: 'void',
      parameters: [{ name: 'pfn', dataType: 'D2MissileSrvDmgFunc *', ordinal: 0 }],
    };
    const g: AnalyzedDataSymbol = { ...MISSILE_DMG_TABLE, dataType: 'D2ObjectsInitFnFunc *[4]' };

    const out = generateGlobalsHeader([g], options, [outer, ...dataTypes]);

    assert.match(out, /typedef void \(\*D2ObjectsInitFnFunc\)\(/);
    assert.match(out, /typedef void \(\*D2MissileSrvDmgFunc\)\(/);
    assert.match(out, /^struct D2MissileDamageDataStrc;$/m);
  });

  it('does not promote a signature type to a full definition it does not need', () => {
    const out = generateGlobalsHeader([MISSILE_DMG_TABLE], options, dataTypes);

    // An incomplete type is legal in a function-type parameter list, so the
    // struct body must NOT be dragged into globals.h.
    assert.doesNotMatch(out, /^struct D2MissileDamageDataStrc \{/m);
  });
});

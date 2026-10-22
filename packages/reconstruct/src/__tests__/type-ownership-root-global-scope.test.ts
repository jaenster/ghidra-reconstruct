/**
 * A root-level global of a struct whose owner header holds only the type keeps
 * `scope = 'global'`, and a pointer initializer aimed at it names it.
 *
 * Real 1.14d case (Game.exe v1667): `gsAutoMapSeed` is a root-level `D2SeedStrc`
 * and `D2SeedStrc` lives in a header with no unit. The struct-colocation pass
 * matched the global's namespace (none) against the type's unit namespace
 * (none), demoted the global, and the initializer address table was built from
 * `scope === 'global'` symbols only. So
 *
 *   D2SeedStrc * psDataTableSeed = (D2SeedStrc *)0x0096c8c8;
 *
 * was emitted with the 1.14d address of `gsAutoMapSeed`. It compiles and links;
 * the rebuilt executable faults at startup writing through it. The same shape
 * produced `gpAncientsCloudSeed = (D2SeedStrc *)0x007b5680` (gAncientsCloudSeed).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { computeTypeOwnership } from '../modules/type-ownership.js';
import { buildGlobalAddressExtentTables, initializerReferenceableNames } from '../codegen/index.js';
import {
  renderGlobalScalarInitializer,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ExtractedFunction, ExtractedStruct } from '../types.js';

function func(name: string, ns: string, params: { name: string; dataType: string }[]): ExtractedFunction {
  return {
    name,
    address: '0x401000',
    signature: `void ${name}()`,
    returnType: 'void',
    parameters: params.map((p, i) => ({ ...p, size: 4, ordinal: i, storage: 'stack' })),
    localVariables: [],
    callingConvention: '__cdecl',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    namespace: ns,
    calledFunctions: [],
  } as ExtractedFunction;
}

const SEED: ExtractedStruct = {
  name: 'D2SeedStrc',
  category: '/test',
  size: 8,
  kind: 'STRUCTURE',
  fields: [
    { name: 'nSeedLow', dataType: 'uint', offset: 0, size: 4 },
    { name: 'nSeedHigh', dataType: 'uint', offset: 4, size: 4 },
  ],
} as ExtractedStruct;

const LVLTBLS = 'D2Common::DATATBLS::LvlTbls';

function rootSeedGlobal(): AnalyzedDataSymbol {
  return {
    name: 'gsAutoMapSeed',
    address: '0096c8c8',
    dataType: 'D2SeedStrc',
    size: 8,
    scope: 'global',
    referencingFunctions: ['GetRandomCellNo'],
  } as unknown as AnalyzedDataSymbol;
}

function classify(globals: AnalyzedDataSymbol[], typeHeader: string | undefined): void {
  computeTypeOwnership({
    organized: new Map([[LVLTBLS, [func('GetRandomCellNo', LVLTBLS, [{ name: 'pSeed', dataType: 'D2SeedStrc *' }])]]]),
    classes: [],
    dataTypes: [SEED],
    globals,
    unitHeaderPaths: new Map([[LVLTBLS, 'D2Common/DATATBLS/LvlTbls.h']]),
    typeOwnershipOverrides: typeHeader ? new Map([['D2SeedStrc', typeHeader]]) : new Map(),
  });
}

describe('computeTypeOwnership: a root-level global of a type in a type-only header', () => {
  it('stays global', () => {
    const g = rootSeedGlobal();
    classify([g], 'D2Common/D2SeedStrc.h');
    assert.strictEqual(g.scope, 'global');
    assert.strictEqual(g.ownerStructHeader, undefined);
    assert.strictEqual(g.ownerStructType, undefined);
  });

  it('stays global when its type has no owner header at all', () => {
    const g = { ...rootSeedGlobal(), name: 'gAncientsCloudSeed', address: '007b5680' } as AnalyzedDataSymbol;
    // No override and no unit references the type by value: it is never placed.
    computeTypeOwnership({
      organized: new Map(), classes: [], dataTypes: [SEED], globals: [g], unitHeaderPaths: new Map(),
      typeOwnershipOverrides: new Map(),
    });
    assert.strictEqual(g.scope, 'global');
  });

  it('still co-locates a global that shares its type unit namespace', () => {
    const SEEDNS = 'D2Common::Seed::D2SeedStrc';
    const g = { ...rootSeedGlobal(), namespace: SEEDNS } as AnalyzedDataSymbol;
    computeTypeOwnership({
      organized: new Map([[SEEDNS, [func('InitSeed', SEEDNS, [{ name: 'pSeed', dataType: 'D2SeedStrc *' }])]]]),
      classes: [], dataTypes: [SEED], globals: [g],
      unitHeaderPaths: new Map([[SEEDNS, 'D2Common/Seed/D2SeedStrc.h']]),
      typeOwnershipOverrides: new Map([['D2SeedStrc', 'D2Common/Seed/D2SeedStrc.h']]),
    });
    assert.strictEqual(g.scope, 'struct-colocated');
    assert.strictEqual(g.ownerStructHeader, 'D2Common/Seed/D2SeedStrc.h');
  });
});

describe('a pointer initializer aimed at that global', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
  });

  it('names it instead of emitting its 1.14d address', () => {
    const target = rootSeedGlobal();
    classify([target], 'D2Common/D2SeedStrc.h');

    const tables = buildGlobalAddressExtentTables([target], []);
    setInitializerAddressTable({
      globalAddresses: tables.globalAddresses,
      stringConstantNames: tables.stringConstantNames,
      referenceableNames: initializerReferenceableNames([target], tables.stringConstantNames),
      imageBase: '0x400000',
    });
    try {
      const rendered = renderGlobalScalarInitializer('0x0096c8c8', 'D2SeedStrc *');
      assert.match(rendered, /&gsAutoMapSeed\b/);
      assert.doesNotMatch(rendered, /0x0*96c8c8/i);
    } finally {
      setInitializerAddressTable();
    }
  });
});

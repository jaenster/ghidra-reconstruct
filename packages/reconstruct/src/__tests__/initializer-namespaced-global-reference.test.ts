/**
 * An initializer names a namespaced global by its namespace.
 *
 * Ghidra qualifies a pointer to a symbol's own start (`Fog::Src::ErrorManager::
 * s_English_006cc81c`), but three other spellings reach the emitter bare and were
 * emitted bare, which was right only while every datum sat at root scope. Once
 * the globals module split (Game.exe v1952..v1969) put them in module namespaces:
 *
 *   static D2SeedStrc * psDataTableSeed = (D2SeedStrc *)&gsAutoMapSeed;
 *     the word 0x0096c8c8 resolved through the address table to a bare name;
 *     gsAutoMapSeed is D2Common::DATATBLS::LvlTbls::gsAutoMapSeed.
 *   (void*)&gaGlidePerspectiveVertices[1].fX
 *     Ghidra's interior path spells the bare label.
 *   (char*)&D2Common::Txt::Cube::s_set_006d5bcc
 *     a qualified SECOND label at the address: the definition carries the other
 *     name (gpCubeRecipeItemTypeFlags_7), so the reference has to go through the
 *     address table, as the bare `s_set_006d5bcc` did before the move.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  renderGlobalScalarInitializer,
  setInitializerAddressTable,
  setInitializerGlobalNamespaces,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue } from '../types.js';

const GLOBALS = [
  { name: 'gsAutoMapSeed', address: '0096c8c8', size: 8, dataType: 'D2SeedStrc', scope: 'global' },
  { name: 'gaGlidePerspectiveVertices', address: '0072f400', size: 0x1e0, dataType: 'D2GlideVertexStrc[15]', scope: 'global' },
  { name: 'gpCubeRecipeItemTypeFlags_7', address: '006d5bcc', size: 4, dataType: 'char[4]', scope: 'global' },
  { name: 'gnRootCounter', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' },
] as unknown as AnalyzedDataSymbol[];

const NAMESPACES: Record<string, readonly string[]> = {
  gsAutoMapSeed: ['D2Common', 'DATATBLS', 'LvlTbls'],
  gaGlidePerspectiveVertices: ['D2Glide', 'Renderer', 'Glide'],
  gpCubeRecipeItemTypeFlags_7: ['D2Common', 'Txt', 'Cube'],
  gnRootCounter: [],
};

function install(): void {
  const tables = buildGlobalAddressExtentTables(GLOBALS, []);
  setInitializerAddressTable({
    globalAddresses: tables.globalAddresses,
    stringConstantNames: tables.stringConstantNames,
    referenceableNames: new Set(GLOBALS.map(g => g.name)),
    imageBase: '0x400000',
  });
  setInitializerGlobalNamespaces(NAMESPACES);
}

const pointer = (v: string): DataValue => ({ kind: 'pointer', value: v });

describe('an initializer reference to a namespaced global', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    install();
  });
  afterEach(() => {
    setInitializerGlobalNamespaces(undefined);
    setInitializerAddressTable(undefined);
  });

  it('qualifies a name the address table resolves', () => {
    assert.strictEqual(
      renderGlobalScalarInitializer('0096c8c8', 'D2SeedStrc *'),
      '(D2SeedStrc *)&D2Common::DATATBLS::LvlTbls::gsAutoMapSeed');
  });

  it('leaves a root-scope global bare', () => {
    assert.strictEqual(renderGlobalScalarInitializer('006fb0a4', 'int *'), '(int *)&gnRootCounter');
  });

  it('qualifies the base of an interior path', () => {
    assert.strictEqual(
      emitDataValue(pointer('gaGlidePerspectiveVertices[1].fX'), 0, 'void *'),
      '(void*)&D2Glide::Renderer::Glide::gaGlidePerspectiveVertices[1].fX');
  });

  it('names a qualified second label through the definition at its address', () => {
    assert.strictEqual(
      emitDataValue(pointer('D2Common::Txt::Cube::s_set_006d5bcc'), 0, 'char *'),
      '(char *)&D2Common::Txt::Cube::gpCubeRecipeItemTypeFlags_7');
  });

  it('keeps a reference Ghidra already qualified', () => {
    assert.strictEqual(
      emitDataValue(pointer('D2Common::DATATBLS::LvlTbls::gsAutoMapSeed'), 0, 'D2SeedStrc *'),
      '(D2SeedStrc*)&D2Common::DATATBLS::LvlTbls::gsAutoMapSeed');
  });
});

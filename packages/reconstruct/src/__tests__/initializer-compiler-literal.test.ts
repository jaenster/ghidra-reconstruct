/**
 * A pooled string literal in a data initializer is spelled as the literal.
 *
 * `{ (char*)&Fog::Src::ErrorManager::s_English_006cc81c, ... }` named a variable the
 * source never had: VC8 pooled `"English"` from the table's own initializer. With the
 * label classified as compiler output (compiler-data.ts) the table reads
 * `{ (char*)"English", ... }`, and nothing is recorded for the declaration closure.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  initializerAddressReferences,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setInitializerCompilerLiterals,
  setMultidimArrayGlobals,
} from '../codegen/globals-header.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { buildGlobalAddressExtentTables } from '../codegen/index.js';
import type { AnalyzedDataSymbol, DataValue, ExtractedString } from '../types.js';

const STRINGS = [{ address: '006dc978', value: 'Font8', length: 5, encoding: 'string', xrefCount: 1 }] as ExtractedString[];
const GLOBALS = [{ name: 'gnFrameCount', address: '006fb0a4', size: 4, dataType: 'int', scope: 'global' }] as unknown as AnalyzedDataSymbol[];
const ptr = (value: string): DataValue => ({ kind: 'pointer', value });

describe('a compiler literal named by a data initializer', () => {
  beforeEach(() => {
    setMultidimArrayGlobals([]);
    setGlobalInitializerTypes(undefined);
    setAggregateTypeNames([]);
    const tables = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
    setInitializerAddressTable({
      globalAddresses: tables.globalAddresses,
      stringConstantNames: tables.stringConstantNames,
      referenceableNames: new Set([...tables.stringConstantNames, 'gnFrameCount']),
      imageBase: '0x400000',
    });
    setInitializerCompilerLiterals(
      new Map([['s_Font8_006dc978', '(char*)"Font8"'], ['s_English_006cc81c', '(char*)"English"']]),
      new Map([[0x6dc978, '(char*)"Font8"']]),
    );
  });
  afterEach(() => setInitializerCompilerLiterals());

  it('spells a label as the literal in a char slot', () => {
    assert.strictEqual(emitDataValue(ptr('s_Font8_006dc978'), 0, 'char *'), '(char*)"Font8"');
  });

  it('spells a qualified label as the literal', () => {
    assert.strictEqual(emitDataValue(ptr('Fog::Src::ErrorManager::s_English_006cc81c'), 0, 'char *'), '(char*)"English"');
  });

  it('casts into a slot of another pointer type', () => {
    assert.strictEqual(emitDataValue(ptr('s_Font8_006dc978'), 0, 'void *'), '(void*)(char*)"Font8"');
  });

  it('spells an address word in a pointer slot as the literal', () => {
    assert.strictEqual(emitDataValue(ptr('006dc978'), 0, 'char *'), '(char*)"Font8"');
  });

  it('records nothing for the closure to declare', () => {
    emitDataValue(ptr('s_Font8_006dc978'), 0, 'char *');
    assert.ok(!initializerAddressReferences().has('s_Font8_006dc978'));
  });

  it('leaves an ordinary global alone', () => {
    assert.strictEqual(emitDataValue(ptr('gnFrameCount'), 0, 'int *'), '&gnFrameCount');
  });
});

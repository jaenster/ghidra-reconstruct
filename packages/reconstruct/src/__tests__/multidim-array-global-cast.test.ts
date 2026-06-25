/**
 * A pointer field initialized with the address of a multidimensional-array
 * global (`char[5][4]`) gets `&gaName` = `char(*)[5][4]`, which is NOT assignable
 * to the `char*` field (and unlike a 1-D array, dropping `&` still leaves
 * `char(*)[4]`). emitDataValue must cast: `(char*)&gaName`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitDataValue, setMultidimArrayGlobals } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

describe('multidim-array global initializer cast', () => {
  it('casts &<2D-array-global> to the element pointer type', () => {
    setMultidimArrayGlobals([
      { name: 'gaQ33_Hell_AmazonBowCodes', dataType: 'char[5][4]' },
      { name: 'gaSomeUnitTable', dataType: 'D2UnitStrc[8][8]' },
    ]);
    const ptr = (value: string): DataValue => ({ kind: 'pointer', value });
    assert.strictEqual(emitDataValue(ptr('gaQ33_Hell_AmazonBowCodes')), '(char*)&gaQ33_Hell_AmazonBowCodes');
    assert.strictEqual(emitDataValue(ptr('gaSomeUnitTable')), '(D2UnitStrc*)&gaSomeUnitTable');
  });

  it('leaves a normal symbol pointer as plain address-of', () => {
    setMultidimArrayGlobals([]);
    assert.strictEqual(emitDataValue({ kind: 'pointer', value: 'gSomeGlobal' }), '&gSomeGlobal');
  });
});

/**
 * A pointer-to-pointer slot takes the address of a pointer global as it is.
 *
 * `FORMS_PredefinedFormStrc.pDC6` is `DC6 **`: the form table stores the ADDRESS
 * of a `DC6 *` global such as `DC6_FrontEnd_blizno`. `&DC6_FrontEnd_blizno` is
 * already `DC6 **`, so it needs no cast. The pointee used to be computed by
 * stripping EVERY star off the slot, which made it `DC6`, made the symbol's
 * `DC6 *` look mismatched, and cast the address to `(DC6*)` — one level short,
 * and a hard error on every row of the table.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  setInitializerAddressTable,
  setMultidimArrayGlobals,
  setGlobalInitializerTypes,
} from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

const pointer = (v: string): DataValue => ({ kind: 'pointer', value: v });

const GLOBALS = [
  { name: 'DC6_FrontEnd_blizno', dataType: 'DC6 *' },
  { name: 'gnFrameCount', dataType: 'int' },
  { name: 'gpszTitle', dataType: 'char *' },
  { name: 'gaFrames', dataType: 'DC6 *[4]' },
  { name: 'gaPlainFrames', dataType: 'DC6[4]' },
];

describe('an address in a pointer-to-pointer slot', () => {
  beforeEach(() => {
    setGlobalInitializerTypes(undefined);
    setInitializerAddressTable({
      globalAddresses: new Map(),
      stringConstantNames: new Set(),
      referenceableNames: new Set(GLOBALS.map(g => g.name)),
      imageBase: '0x400000',
    } as never);
    setMultidimArrayGlobals(GLOBALS);
  });

  it('takes &sym bare when the symbol is the slot pointee', () => {
    assert.strictEqual(emitDataValue(pointer('DC6_FrontEnd_blizno'), 0, 'DC6 **'), '&DC6_FrontEnd_blizno');
  });

  it('casts to the FULL slot type when the symbol is something else', () => {
    assert.strictEqual(emitDataValue(pointer('gnFrameCount'), 0, 'DC6 **'), '(DC6**)&gnFrameCount');
  });

  it('casts a char* global into a char** slot only when it must', () => {
    assert.strictEqual(emitDataValue(pointer('gpszTitle'), 0, 'char **'), '&gpszTitle');
    assert.strictEqual(emitDataValue(pointer('gnFrameCount'), 0, 'char **'), '(char**)&gnFrameCount');
  });

  it('decays an array of pointers into a pointer-to-pointer slot', () => {
    assert.strictEqual(emitDataValue(pointer('gaFrames'), 0, 'DC6 **'), 'gaFrames');
    assert.strictEqual(emitDataValue(pointer('gaPlainFrames'), 0, 'DC6 **'), '(DC6**)gaPlainFrames');
  });

  it('casts an array of pointers into a single-pointer slot', () => {
    // `DC6 *[4]` decays to `DC6 **`, which a `DC6 *` slot does not take.
    assert.strictEqual(emitDataValue(pointer('gaFrames'), 0, 'DC6 *'), '(DC6*)gaFrames');
  });

  it('keeps every single-level T* case as it was', () => {
    assert.strictEqual(emitDataValue(pointer('gnFrameCount'), 0, 'int *'), '&gnFrameCount');
    assert.strictEqual(emitDataValue(pointer('gaPlainFrames'), 0, 'DC6 *'), 'gaPlainFrames');
    // `&DC6_FrontEnd_blizno` is `DC6 **`, which a `DC6 *` slot does not take.
    assert.strictEqual(emitDataValue(pointer('DC6_FrontEnd_blizno'), 0, 'DC6 *'), '(DC6*)&DC6_FrontEnd_blizno');
    assert.strictEqual(emitDataValue(pointer('gnFrameCount'), 0, 'DC6 *'), '(DC6*)&gnFrameCount');
  });

  it('spells an invented address name at the slot depth', () => {
    assert.strictEqual(emitDataValue(pointer('DAT_000a0000'), 0, 'DC6 **'), '(DC6**)0x000a0000');
  });
});

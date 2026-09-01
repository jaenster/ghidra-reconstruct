/**
 * Ghidra hands a pointer initializer a name it invented for a bare address —
 * `DAT_000a0000`, `LAB_0057ee77_1`, `s_umod_006e6f60`, `ffffffff`. Nothing
 * declares those, so `&DAT_000a0000` is an undeclared identifier:
 *
 *   globals.cpp: error: 'DAT_000a0000' was not declared in this scope
 *
 * The name carries the address it stood for, and that address IS the slot's
 * content, so the initializer is spelled as the address. A real symbol that
 * merely looks like one of these keeps its reference.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { emitDataValue, setMultidimArrayGlobals } from '../codegen/globals-header.js';
import type { DataValue } from '../types.js';

const ptr = (value: string): DataValue => ({ kind: 'pointer', value });

describe('pointer initializer naming an address Ghidra had no symbol for', () => {
  it('emits the address, cast to the slot type', () => {
    setMultidimArrayGlobals([]);
    assert.strictEqual(emitDataValue(ptr('DAT_000a0000'), 0, 'D2MonSeqTxt *'), '(D2MonSeqTxt*)0x000a0000');
    assert.strictEqual(emitDataValue(ptr('LAB_0057ee77_1'), 0, 'void *'), '(void*)0x0057ee77');
    assert.strictEqual(emitDataValue(ptr('s_umod_006e6f60'), 0, 'char *'), '(char*)0x006e6f60');
  });

  it('spells the all-ones address -1, which is all ones at any width', () => {
    // This value used to come out as `(void*)0xffffffff`, which on a 64-bit
    // rebuild is 0x00000000FFFFFFFF and no longer equal to -1. It is not an
    // address Ghidra failed to name; it is D2's invalid-pointer sentinel.
    setMultidimArrayGlobals([]);
    assert.strictEqual(emitDataValue(ptr('ffffffff'), 0, 'void *'), '(void*)-1');
  });

  it('keeps the reference when the globals table really declares the name', () => {
    setMultidimArrayGlobals([{ name: 'DAT_000a0000', dataType: 'int' }]);
    assert.strictEqual(emitDataValue(ptr('DAT_000a0000'), 0, 'int *'), '&DAT_000a0000');
    setMultidimArrayGlobals([]);
  });

  it('leaves an ordinary symbol name alone', () => {
    setMultidimArrayGlobals([{ name: 'gnSomeGlobal', dataType: 'int' }]);
    assert.strictEqual(emitDataValue(ptr('gnSomeGlobal'), 0, 'int *'), '&gnSomeGlobal');
    setMultidimArrayGlobals([]);
  });
});

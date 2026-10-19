/** Every declaration's Ghidra placeholder type name is respelled as its own typedef. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { respellPlaceholderType, respellPlaceholderTypes } from '../codegen/placeholder-types.js';
import type { ExtractedDataType, ExtractedFunction } from '../types.js';

describe('respellPlaceholderType', () => {
  it('respells whole names inside any decoration, and nothing else', () => {
    assert.strictEqual(respellPlaceholderType('byte[256]'), 'uint8_t[256]');
    assert.strictEqual(respellPlaceholderType('ushort *'), 'uint16_t *');
    assert.strictEqual(respellPlaceholderType('pointer[12]'), 'void *[12]');
    assert.strictEqual(respellPlaceholderType('vtable *'), 'void *');
    assert.strictEqual(respellPlaceholderType('D2UintStrc *'), 'D2UintStrc *');
    assert.strictEqual(respellPlaceholderType('code *'), 'code *');
  });
  it('rewrites the model in place: signatures, locals, globals, fields, typedefs, funcdefs', () => {
    const fn = { returnType: 'uint', parameters: [{ dataType: 'byte *' }], localVariables: [{ dataType: 'dword' }] } as unknown as ExtractedFunction;
    const g = { dataType: 'ushort[4]', suggestedType: 'ushort[4]' };
    const dts = [
      { kind: 'STRUCTURE', fields: [{ dataType: 'uchar' }] },
      { kind: 'TYPEDEF', underlyingType: 'ulonglong' },
      { kind: 'FUNCTION_DEFINITION', returnType: 'uint', parameters: [{ dataType: 'longlong' }] },
    ] as unknown as ExtractedDataType[];
    assert.strictEqual(respellPlaceholderTypes([fn], [g], dts), 9);
    assert.deepStrictEqual([fn.returnType, fn.parameters[0].dataType, fn.localVariables[0].dataType], ['uint32_t', 'uint8_t *', 'uint32_t']);
    assert.strictEqual(g.dataType, 'uint16_t[4]');
    assert.strictEqual(respellPlaceholderTypes([fn], [g], dts), 0, 'idempotent');
  });
});

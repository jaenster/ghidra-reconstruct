import { describe, it } from 'node:test';
import assert from 'node:assert';
import { layoutFieldType } from './layout-field-type.js';

describe('layoutFieldType: Ghidra string types as the char arrays the header emits', () => {
  it('a plain string is a char array of the field size', () => {
    assert.strictEqual(layoutFieldType('string', 64), 'char[64]');
    assert.strictEqual(layoutFieldType('TerminatedCString', 32), 'char[32]');
  });
  it('a sized string and a string table keep their own extents', () => {
    assert.strictEqual(layoutFieldType('string {60}', 60), 'char[60]');
    assert.strictEqual(layoutFieldType('string {60} [32]', 0x780), 'char[32][60]');
  });
  it('every other type is kept', () => {
    assert.strictEqual(layoutFieldType('WCHAR[64]', 128), 'WCHAR[64]');
    assert.strictEqual(layoutFieldType('string *', 4), 'string *');
    assert.strictEqual(layoutFieldType('string', 0), 'string');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeDataValue } from '../codegen/platform-types.js';

describe('normalizeDataValue: GUID', () => {
  it('emits the GUID fields, not a zero GUID (FOLDERID_SavedGames, 0x006cca6c)', () => {
    assert.strictEqual(
      normalizeDataValue('4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4'),
      '{0x4c5c32ff, 0xbb9d, 0x43b0, {0xb5, 0xb4, 0x2d, 0x72, 0xe5, 0x4e, 0xaa, 0xa4}} /* 4c5c32ff-bb9d-43b0-b5b4-2d72e54eaaa4 */',
    );
  });

  it('keeps Data1..3 as the numbers the registry form spells and Data4 in memory order', () => {
    // IID_IDirectSound3DBuffer: the struct path emits Data4 as a5 21 00 20 af 0b e5 60.
    assert.strictEqual(
      normalizeDataValue('279AFA86-4981-11CE-A521-0020AF0BE560'),
      '{0x279afa86, 0x4981, 0x11ce, {0xa5, 0x21, 0x00, 0x20, 0xaf, 0x0b, 0xe5, 0x60}} /* 279AFA86-4981-11CE-A521-0020AF0BE560 */',
    );
  });

  it('spells GUID_NULL out too', () => {
    assert.match(normalizeDataValue('00000000-0000-0000-0000-000000000000'), /^\{0x00000000, 0x0000, 0x0000, \{0x00(, 0x00){7}\}\}/);
  });
});

/**
 * MSVC's one-compare range check `(unsigned)(x - lo) < n` stays unsigned in the tree.
 * Ghidra prints it without a cast (its ushort/byte/enum difference is unsigned); C++
 * promotes uint16_t/uint8_t to int and the tree spells 4-byte enums int, which made the
 * check accept x < lo. Real sites: INPUT_HelpCloseButtonDown `nMouseY - 0x18 < 0x21`,
 * ROOM_GetLevelLightColor `eLevelId - LEVEL_RiverOfFlame < 2`, GetItemColor
 * `(uint8_t)pItemsTxt->bTransform - 1 < 8`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createUnsignedRangeCompareTransformer } from '../builtins/unsigned-range-compare.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const OPTS = {
  unsignedEnums: ['eD2LevelId'], enumTypes: ['eD2LevelId', 'eSigned'],
  enumConstants: ['LEVEL_RiverOfFlame', 'MINUS_ONE'],
  structFields: { D2ItemsTxt: { bTransform: 'char' } },
};
const transform = (code: string) => emit(createUnsignedRangeCompareTransformer(OPTS)(parse(code)) as AnyNode).trim();

describe('unsigned-range-compare', () => {
  it('a uint16_t range check gets its unsigned compare back', () => {
    assert.match(transform('int f(uint16_t nMouseY) { return nMouseY - 0x18 < 0x21; }'), /\(uint32_t\)\(nMouseY - 0x18\) < 0x21/);
  });
  it('an unsigned enum, and a constant on the left', () => {
    assert.match(transform('int f(eD2LevelId eLevelId) { return 2 > eLevelId - LEVEL_RiverOfFlame; }'), /2 > \(uint32_t\)\(eLevelId - LEVEL_RiverOfFlame\)/);
  });
  it('a uint8_t cast operand', () => {
    assert.match(transform('int f(D2ItemsTxt *p) { return (uint8_t)p->bTransform - 1 < 8; }'), /\(uint32_t\)\(\(uint8_t\)p->bTransform - 1\) < 8/);
  });
  it('leaves signed operands, int32_t, signed enums and non-constant bounds alone', () => {
    for (const src of [
      'int f(int16_t x) { return x - 3 < 5; }',
      'int f(int32_t x) { return x - 3 < 5; }',
      'int f(eSigned x) { return x - 3 < 5; }',
      'int f(uint16_t x, int n) { return x - 3 < n; }',
    ]) assert.ok(!transform(src).includes('(uint32_t)'), src);
  });
  it('the compiled check matches the machine for every uint16_t', { skip: !hasNativeGpp() }, () => {
    const fn = transform('int f(uint16_t nMouseY) { return nMouseY - 0x18 < 0x21; }');
    const out = compileAndRun(`#include <cstdint>\n#include <cstdio>\n${fn}`,
      'int bad = 0; for (uint32_t y = 0; y <= 0xffff; y++) { int machine = (uint32_t)y - 0x18u < 0x21u; if (f((uint16_t)y) != machine) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(out.trim(), '0');
  });
});

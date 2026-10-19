/**
 * The odd-width integer typedefs (`typedef uint32_t uint3;` ...) are emitted only while a
 * declaration in the program spells the type. They approximate a 3/5/6/7-byte integer
 * with a wider one, so a body that still reached one would silently read or write the
 * wrong width; three-byte-access lowers the 3-byte loads, and anything else is better as a
 * compile error than as a typedef.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generatePlatformHeader, oddWidthTypesSpelled } from '../codegen/platform-types.js';

describe('odd-width integer typedefs', () => {
  it('finds the types declarations spell, as whole words', () => {
    const used = oddWidthTypesSpelled(['uint3 *', 'int32_t', 'D2Uint3Strc *', undefined, 'undefined3[2]']);
    assert.deepStrictEqual([...used].sort(), ['uint3', 'undefined3']);
  });

  it('emits only the used ones when told which are used', () => {
    const h = generatePlatformHeader({ oddWidthTypesUsed: new Set(['uint3']) });
    assert.match(h, /typedef uint32_t uint3;/);
    assert.ok(!/typedef \w+ (int3|int5|uint5|int6|uint6|int7|undefined3);/.test(h), 'unused typedef emitted');
  });

  it('emits none when no declaration spells one (TILECMP_ApplyFunctionToPixels at v1099 takes uint8_t *)', () => {
    const h = generatePlatformHeader({ oddWidthTypesUsed: new Set() });
    assert.ok(!/typedef \w+ (u?int[3567]|uint[56]|undefined3);/.test(h));
  });

  it('keeps all of them for a caller that does not say', () => {
    const h = generatePlatformHeader({});
    assert.match(h, /typedef int32_t int3;/);
    assert.match(h, /typedef uint8_t undefined3;/);
  });
});

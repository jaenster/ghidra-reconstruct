/**
 * An integer-only struct no code holds by value gets no constructors.
 *
 * The conversion constructors make a struct a non-aggregate, so its data is spelled
 * as constructor calls, and in C++03 that is dynamic initialisation: VC8 fills
 * MERC_GetWeaponAnimIndex's gaMercWeaponAnimMap[14] (0x006632c0) at run time
 * behind a `$S` guard. A struct that only data and pointers name needs no
 * conversion into it, so it is emitted as the plain aggregate and its data as the
 * brace list.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import {
  generateStructDeclaration, hasConvertingConstructor, setConstructorBearingStructs, valueNamedTypeNames,
} from '../codegen/header.js';
import { emitDataValue } from '../codegen/globals-header.js';
import type { ExtractedStruct, StructField } from '../types.js';

const fields = (...specs: Array<[string, string, number, number]>): StructField[] =>
  specs.map(([name, dataType, offset, size]) => ({ name, dataType, offset, size }) as StructField);

const ANIM = { kind: 'STRUCTURE', name: 'D2MercWeaponAnimMapStrc', size: 8, fields: fields(['nAnimIndex', 'int32_t', 0, 4], ['nWeaponClass', 'int32_t', 4, 4]) };
const TIMER = { kind: 'STRUCTURE', name: 'D2ClientTimerStrc', size: 8, fields: fields(['dwStartTick', 'DWORD', 0, 4], ['dwDurationMs', 'DWORD', 4, 4]) };
const SEED = { kind: 'STRUCTURE', name: 'D2SeedStrc', size: 8, fields: fields(['nLowSeed', 'uint32_t', 0, 4], ['nHighSeed', 'uint32_t', 4, 4]) };
const COORD = { kind: 'STRUCTURE', name: 'D2CoordStrc', size: 8, fields: fields(['nX', 'int', 0, 4], ['nY', 'int', 4, 4]) };
const CAST = { kind: 'STRUCTURE', name: 'D2CastStrc', size: 8, fields: fields(['a', 'int', 0, 4], ['b', 'int', 4, 4]) };
const SIZED = { kind: 'STRUCTURE', name: 'D2SizedStrc', size: 8, fields: fields(['a', 'int', 0, 4], ['b', 'int', 4, 4]) };

const scalar = (value: string) => ({ kind: 'scalar', value }) as const;
const row = (a: string, b: string, names = ['nAnimIndex', 'nWeaponClass']) =>
  ({ kind: 'struct', fields: [{ name: names[0], value: scalar(a) }, { name: names[1], value: scalar(b) }] });

describe('aggregate-only structs', () => {
  before(() => {
    setConstructorBearingStructs([ANIM, TIMER, SEED, COORD, CAST, SIZED], [
      // Read through a pointer only: no conversion into either can exist.
      'uint32_t __fastcall GAMEDATA_CheckTimerExpired(D2ClientTimerStrc *pTimer) { return pTimer->dwStartTick; }',
      'void f(void) { x = ((D2MercWeaponAnimMapStrc * const)p)->nAnimIndex; }',
      // A value return and a value local: the conversion constructor is load-bearing.
      'D2SeedStrc __fastcall SEED_Get(void) { return CONCAT44(a, b); }',
      'void g(void) { D2CoordStrc sSpawnCoord; sSpawnCoord = h(); }',
      // A by-value cast and sizeof count as value uses too.
      'void k(void) { y = (D2CastStrc)z; n = sizeof(D2SizedStrc); }',
    ]);
  });

  it('keeps constructors only where code names the struct by value', () => {
    assert.ok(!hasConvertingConstructor('D2MercWeaponAnimMapStrc', ANIM.fields));
    assert.ok(!hasConvertingConstructor('D2ClientTimerStrc', TIMER.fields));
    assert.ok(hasConvertingConstructor('D2SeedStrc', SEED.fields));
    assert.ok(hasConvertingConstructor('D2CoordStrc', COORD.fields));
    assert.ok(hasConvertingConstructor('D2CastStrc', CAST.fields));
    assert.ok(hasConvertingConstructor('D2SizedStrc', SIZED.fields));
  });

  it('declares the aggregate with the conversion operator and no constructor', () => {
    const decl = generateStructDeclaration(ANIM as unknown as ExtractedStruct);
    assert.match(decl, /operator uint64_t\(\) const/, decl);
    assert.ok(!/D2MercWeaponAnimMapStrc\(/.test(decl), decl);
    const kept = generateStructDeclaration(SEED as unknown as ExtractedStruct);
    assert.match(kept, /D2SeedStrc\(uint64_t v\)/, kept);
    assert.match(kept, /D2SeedStrc\(uint32_t a0, uint32_t a1\)/, kept);
  });

  it('spells its table as a brace list with the same values in the same order', () => {
    const out = emitDataValue({ kind: 'array', elements: [row('0', '0'), row('0x1', '0x3'), row('0x2', '0x6')] } as never, 0, 'D2MercWeaponAnimMapStrc[3]');
    assert.ok(!/D2MercWeaponAnimMapStrc\(/.test(out), out);
    const rows = [...out.matchAll(/\/\* \.nAnimIndex = \*\/ (\S+),\s*\/\* \.nWeaponClass = \*\/ (\S+)\s*\}/g)].map(m => `${m[1]}/${m[2]}`);
    assert.deepStrictEqual(rows, ['0x1/0x3', '0x2/0x6'], out);
    // The all-zero row is the value-initialised element, first.
    assert.match(out, /^\{\s*\{\},\s*\{/, out);
  });

  it('value-initialises an all-zero one with braces, not a constructor call', () => {
    const out = emitDataValue(row('0', '0', ['dwStartTick', 'dwDurationMs']) as never, 0, 'D2ClientTimerStrc');
    assert.strictEqual(out, '{}');
  });

  it('still calls the constructors of a struct code holds by value', () => {
    const out = emitDataValue(row('0x1', '0x2', ['nLowSeed', 'nHighSeed']) as never, 0, 'D2SeedStrc');
    assert.match(out, /^D2SeedStrc\(/, out);
  });
});

describe('valueNamedTypeNames', () => {
  const c = new Set(['T', 'U']);
  it('ignores pointers, also through cv-qualifiers', () => {
    assert.deepStrictEqual([...valueNamedTypeNames(['T *p; struct U * const q; (T const *)x;'], c)], []);
  });
  it('counts a declaration, a parameter, a cast and an array', () => {
    assert.deepStrictEqual([...valueNamedTypeNames(['void f(T t);'], c)], ['T']);
    assert.deepStrictEqual([...valueNamedTypeNames(['x = (U)y;'], c)], ['U']);
    assert.deepStrictEqual([...valueNamedTypeNames(['T a[4];'], c)], ['T']);
    assert.deepStrictEqual([...valueNamedTypeNames(['T'], c)], ['T']);
  });
  it('ignores a name that merely contains a candidate', () => {
    assert.deepStrictEqual([...valueNamedTypeNames(['TT x; pU->T2 = 0;'], c)], []);
  });
});

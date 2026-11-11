/**
 * Tests for the arithmetic-idiom folds.
 *
 * Two layers: the rewrites the pass makes (and the ones it must refuse), and a
 * value check that compiles each original/folded pair with the host C compiler
 * and compares them over edge values - INT_MIN, -1, 0, wrap-around, 2^32-1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileTo, exePath, hasNativeGpp, runExe } from '../../../testing/native-cpp.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  arithIdiomsPlugin, getArithIdiomStats, resetArithIdiomStats, type ArithIdiomsOptions,
} from '../builtins/arith-idioms.js';

const OPTIONS: ArithIdiomsOptions = {
  structFields: {
    D2SeedStrc: { nSeedLow: 'uint32_t', nSeedHigh: 'uint32_t' },
    SignedPair: { nLow: 'int', nHigh: 'int' },
    D2UnionStrc: { nA: 'uint32_t', nB: 'uint32_t' },
  },
  structFieldOffsets: {
    D2SeedStrc: { nSeedLow: 0, nSeedHigh: 4 },
    SignedPair: { nLow: 0, nHigh: 4 },
    D2UnionStrc: { nA: 0, nB: 4 },
  },
  aggregateSizes: { D2SeedStrc: 8, SignedPair: 8, D2UnionStrc: 8 },
  unionNames: ['D2UnionStrc'],
  globalTypes: { gnWidth: 'int', gdwCount: 'uint32_t', gqwTotal: 'uint64_t' },
};

function run(body: string, decls = ''): string {
  const ast = parse(`void f(${decls}) { ${body} }`);
  const out = arithIdiomsPlugin.createTransformer(OPTIONS)(ast);
  const text = emit(out as AnyNode);
  const m = /\{([\s\S]*)\}\s*$/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim();
}

describe('arith-idioms', () => {
  describe('seed low dword', () => {
    it('folds the seed remainder to %', () => {
      const out = run(
        'x = s.nSeedLow + (int)(((uint64_t)d2_bits_of(s) & 0xffffffff) / 3) * -3 + 2;',
        'D2SeedStrc s, int x');
      assert.strictEqual(out, 'x = s.nSeedLow % 3 + 2;');
    });

    it('folds the divisibility test', () => {
      const out = run(
        'if (s.nSeedLow != (int)(((uint64_t)d2_bits_of(s) & 0xffffffff) / 10) * 10) { x = 1; }',
        'D2SeedStrc s, int x');
      assert.strictEqual(out, 'if (s.nSeedLow % 10 != 0) { x = 1; }');
    });

    it('narrows a remainder by an unsigned divisor', () => {
      const out = run(
        'r = (uint32_t)(((uint64_t)d2_bits_of(s) & 0xffffffff) % (uint64_t)n);',
        'D2SeedStrc s, uint32_t n, uint32_t r');
      assert.strictEqual(out, 'r = (uint32_t)(s.nSeedLow % n);');
    });

    it('narrows a quotient by a constant', () => {
      const out = run(
        'r = (int)(((uint64_t)d2_bits_of(s) & 0xffffffff) / 7);',
        'D2SeedStrc s, int r');
      assert.strictEqual(out, 'r = (int)(s.nSeedLow / 7);');
    });

    it('keeps the 64-bit division by a signed divisor', () => {
      // (uint64_t)n sign-extends: dividing by 2^64-5 is not dividing by 2^32-5.
      const out = run(
        'r = (uint32_t)(((uint64_t)d2_bits_of(s) & 0xffffffff) % (uint64_t)n);',
        'D2SeedStrc s, int n, uint32_t r');
      assert.strictEqual(out, 'r = (uint32_t)((uint64_t)s.nSeedLow % (uint64_t)n);');
    });

    it('drops the widening where only the truth is used', () => {
      assert.strictEqual(
        run('if ((uint64_t)d2_bits_of(s) & 1) { x = 1; }', 'D2SeedStrc s, int x'),
        'if (s.nSeedLow & 1) { x = 1; }');
      assert.strictEqual(
        run('x = !((uint64_t)d2_bits_of(s) & 3) && y;', 'D2SeedStrc s, int x, int y'),
        'x = !(s.nSeedLow & 3) && y;');
    });

    it('keeps the 64-bit type where the value is used', () => {
      assert.strictEqual(
        run('q = ((uint64_t)d2_bits_of(s) & 1) + 3;', 'D2SeedStrc s, uint64_t q'),
        'q = (uint64_t)(s.nSeedLow & 1) + 3;');
    });

    it('reads a narrow cast of the bits as the low dword', () => {
      assert.strictEqual(run('x = (int)d2_bits_of(s);', 'D2SeedStrc s, int x'), 'x = (int)s.nSeedLow;');
    });

    it('refuses a mask that reaches the high dword', () => {
      const out = run('q = (uint64_t)d2_bits_of(s) & 0x100000000;', 'D2SeedStrc s, uint64_t q');
      assert.strictEqual(out, 'q = (uint64_t)d2_bits_of(s) & 0x100000000;');
    });

    it('refuses a signed low member, a union and an unknown type', () => {
      for (const decl of ['SignedPair s', 'D2UnionStrc s', 'Mystery s']) {
        const out = run('x = (int)(((uint64_t)d2_bits_of(s) & 0xffffffff) / 3);', `${decl}, int x`);
        assert.ok(out.includes('d2_bits_of'), `${decl}: ${out}`);
      }
    });
  });

  describe('modulo', () => {
    it('folds an unsigned remainder', () => {
      assert.strictEqual(run('r = u + (int)(u / 0x23) * -0x23;', 'uint32_t u, uint32_t r'), 'r = u % 0x23;');
      assert.strictEqual(run('r = u - u / 5 * 5;', 'uint32_t u, uint32_t r'), 'r = u % 5;');
    });

    it('folds a signed remainder', () => {
      assert.strictEqual(run('r = n - n / 3 * 3;', 'int n, int r'), 'r = n % 3;');
    });

    it('refuses a different multiplier, operand or a type change', () => {
      assert.strictEqual(run('r = n + n / 5 * -2;', 'int n, int r'), 'r = n + n / 5 * -2;');
      assert.strictEqual(run('r = a + b / 5 * -5;', 'int a, int b, int r'), 'r = a + b / 5 * -5;');
      // (uint32_t) on a signed quotient makes the sum unsigned; n % 3 is int.
      assert.strictEqual(run('r = n + (uint32_t)(n / 3) * -3;', 'int n, int r'),
        'r = n + (uint32_t)(n / 3) * -3;');
      // A 64-bit x: the int cast truncates the quotient.
      assert.strictEqual(run('r = q + (int)(q / 3) * -3;', 'uint64_t q, uint64_t r'),
        'r = q + (int)(q / 3) * -3;');
    });

    it('refuses an operand with a side effect', () => {
      const out = run('r = g() + (int)(g() / 3) * -3;', 'int r');
      assert.ok(out.includes('g() / 3'), out);
    });
  });

  describe('power-of-two division', () => {
    it('folds the bias of a signed int', () => {
      assert.strictEqual(run('x = (int)(gnWidth + (gnWidth >> 0x1f & 3U)) >> 2;', 'int x'), 'x = gnWidth / 4;');
      assert.strictEqual(run('x = (int)(a + (a >> 0x1f & 0xffffU)) >> 0x10;', 'int a, int x'), 'x = a / 65536;');
      assert.strictEqual(run('x = a + (a >> 0x1f & 1) >> 1;', 'int a, int x'), 'x = a / 2;');
    });

    it('folds the bias written first', () => {
      // MISSILE_GetPoisonNovaRadius 004cc950.
      assert.strictEqual(run('x = 0xc - ((int)((a >> 0x1f & 3U) + a) >> 2);', 'int a, int x'), 'x = 0xc - a / 4;');
      assert.strictEqual(run('x = (int)((a >> 0x1f & 7U) + a) >> 2;', 'int a, int x'), 'x = (int)((a >> 0x1f & 7U) + a) >> 2;');
    });

    it('folds a product operand', () => {
      assert.strictEqual(run('x = (int)(a * b + (a * b >> 0x1f & 0xffU)) >> 8;', 'int a, int b, int x'),
        'x = a * b / 256;');
    });

    it('casts an unsigned dividend to int', () => {
      assert.strictEqual(run('x = (int)(u + ((int)u >> 0x1f & 7U)) >> 3;', 'uint32_t u, int x'), 'x = (int)u / 8;');
    });

    it('keeps it inside a larger expression', () => {
      assert.strictEqual(run('x = -((int)(a + (a >> 0x1f & 3U)) >> 2);', 'int a, int x'), 'x = -(a / 4);');
    });

    it('refuses a mismatched mask, a logical shift and an unsigned sign', () => {
      assert.strictEqual(run('x = (int)(a + (a >> 0x1f & 7U)) >> 2;', 'int a, int x'),
        'x = (int)(a + (a >> 0x1f & 7U)) >> 2;');
      // No (int): the sum is unsigned and the shift is logical.
      assert.strictEqual(run('x = a + (a >> 0x1f & 3U) >> 2;', 'int a, int x'), 'x = a + (a >> 0x1f & 3U) >> 2;');
      // u >> 31 of an unsigned is 0 or 1, not a sign.
      assert.strictEqual(run('x = (int)(u + (u >> 0x1f & 3U)) >> 2;', 'uint32_t u, int x'),
        'x = (int)(u + (u >> 0x1f & 3U)) >> 2;');
      // A 64-bit operand: bit 31 is not its sign.
      assert.strictEqual(run('x = (int)(q + (q >> 0x1f & 3U)) >> 2;', 'int64_t q, int x'),
        'x = (int)(q + (q >> 0x1f & 3U)) >> 2;');
      // Unknown type.
      assert.strictEqual(run('x = (int)(z + (z >> 0x1f & 3U)) >> 2;', 'int x'),
        'x = (int)(z + (z >> 0x1f & 3U)) >> 2;');
    });
  });

  describe('abs', () => {
    it('folds the sign-mask difference of a signed int', () => {
      // INPUT_HandleMouseWheel 0044c400.
      assert.strictEqual(run('if ((gnWidth ^ gnWidth >> 0x1f) - (gnWidth >> 0x1f) >= 0x78) { x = 1; }', 'int x'),
        'if (abs(gnWidth) >= 0x78) { x = 1; }');
      assert.strictEqual(run('x = (a ^ (int)a >> 0x1f) - ((int)a >> 0x1f);', 'int a, int x'), 'x = abs(a);');
    });

    it('gives an unsigned dword its unsigned difference back', () => {
      // WEATHER_ApproximateDistance 00474080: `cdq; mov ecx, eax; xor ecx, edx; sub ecx, edx`.
      assert.strictEqual(run('x = (u ^ (int)u >> 0x1f) - ((int)u >> 0x1f);', 'uint32_t u, int x'),
        'x = (uint32_t)abs((int)u);');
    });

    it('refuses mismatched operands and a 64-bit value', () => {
      assert.strictEqual(run('x = (a ^ b >> 0x1f) - (b >> 0x1f);', 'int a, int b, int x'), 'x = (a ^ b >> 0x1f) - (b >> 0x1f);');
      assert.strictEqual(run('x = (q ^ q >> 0x1f) - (q >> 0x1f);', 'int64_t q, int x'), 'x = (q ^ q >> 0x1f) - (q >> 0x1f);');
    });
  });

  describe('shifts under a narrowing cast', () => {
    it('shifts a signed value arithmetically where the cast drops the top bits', () => {
      // CLIENT_SetUnitLightColor 004609a0: `sar eax, 0x10` / `sar ecx, 8`.
      assert.strictEqual(run('b = (uint8_t)((uint32_t)n >> 0x10);', 'int n, uint8_t b'), 'b = (uint8_t)(n >> 0x10);');
      assert.strictEqual(run('w = (uint16_t)((uint32_t)n >> 8);', 'int n, uint16_t w'), 'w = (uint16_t)(n >> 8);');
      assert.strictEqual(run('b = (uint8_t)((uint32_t)h >> 8);', 'int16_t h, uint8_t b'), 'b = (uint8_t)(h >> 8);');
    });

    it('refuses a top bit the cast keeps, bool, an unsigned value and a wide target', () => {
      assert.strictEqual(run('w = (uint16_t)((uint32_t)n >> 0x11);', 'int n, uint16_t w'), 'w = (uint16_t)((uint32_t)n >> 0x11);');
      // HIWORD's spelling: the original is split between shr and sar there.
      assert.strictEqual(run('w = (int16_t)((uint32_t)n >> 0x10);', 'int n, int16_t w'), 'w = (int16_t)((uint32_t)n >> 0x10);');
      assert.strictEqual(run('c = (bool)((uint32_t)n >> 0x1f);', 'int n, bool c'), 'c = (bool)((uint32_t)n >> 0x1f);');
      assert.strictEqual(run('b = (uint8_t)((uint32_t)u >> 8);', 'uint32_t u, uint8_t b'), 'b = (uint8_t)((uint32_t)u >> 8);');
      assert.strictEqual(run('r = (int)((uint32_t)n >> 8);', 'int n, int r'), 'r = (int)((uint32_t)n >> 8);');
      assert.strictEqual(run('b = (uint8_t)((uint32_t)q >> 8);', 'int64_t q, uint8_t b'), 'b = (uint8_t)((uint32_t)q >> 8);');
    });

    it('folds the power-of-two bias of an unsigned sum the cast truncates', () => {
      // VIEW_AllocByteTable 00475b80: `cdq; and edx, 0xffff; add eax, edx; sar eax, 0x10`.
      assert.strictEqual(run('b = (uint8_t)(n + (n >> 0x1f & 0xffffU) >> 0x10);', 'int n, uint8_t b'), 'b = (uint8_t)(n / 65536);');
      // Not when the cast keeps a bit the shifts disagree on.
      assert.strictEqual(run('w = (uint16_t)(n + (n >> 0x1f & 0x1ffffU) >> 0x11);', 'int n, uint16_t w'),
        'w = (uint16_t)(n + (n >> 0x1f & 0x1ffffU) >> 0x11);');
    });
  });

  describe('divisibility through an unsigned dividend', () => {
    it('folds x != (uint32_t)x / N * N of an int', () => {
      // ClientSideGameLoop 0044c790.
      assert.strictEqual(run('if (gnWidth != (uint32_t)gnWidth / 0xd * 0xd) { x = 1; }', 'int x'),
        'if ((uint32_t)gnWidth % 0xd != 0) { x = 1; }');
    });

    it('refuses another value, another multiplier and a narrow value', () => {
      assert.strictEqual(run('if (a != (uint32_t)b / 0xd * 0xd) { x = 1; }', 'int a, int b, int x'),
        'if (a != (uint32_t)b / 0xd * 0xd) { x = 1; }');
      assert.strictEqual(run('if (a != (uint32_t)a / 0xd * 0xc) { x = 1; }', 'int a, int x'),
        'if (a != (uint32_t)a / 0xd * 0xc) { x = 1; }');
      assert.strictEqual(run('if (h != (uint32_t)h / 0xd * 0xd) { x = 1; }', 'int16_t h, int x'),
        'if (h != (uint32_t)h / 0xd * 0xd) { x = 1; }');
    });
  });

  describe('multiply by a reciprocal', () => {
    it('folds a proven reciprocal of an unsigned dword', () => {
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0xaaaaaaab >> 0x21);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)(u / 3);');
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0x51eb851f >> 0x25);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)(u / 100);');
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0xcccccccd >> 0x23);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)(u / 10);');
    });

    it('refuses a constant that only approximates a divisor', () => {
      // ~u / 14, and wrong for u = 14.
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0x24924925 >> 0x21);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)((uint64_t)u * 0x24924925 >> 0x21);');
      // The signed /7 constant: exact for 31-bit dividends only.
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0x92492493 >> 0x22);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)((uint64_t)u * 0x92492493 >> 0x22);');
      // ceil(2^32 / 7) at shift 32 is off by one near the top of the range.
      assert.strictEqual(run('r = (uint32_t)((uint64_t)u * 0x24924925 >> 0x20);', 'uint32_t u, uint32_t r'),
        'r = (uint32_t)((uint64_t)u * 0x24924925 >> 0x20);');
    });

    it('refuses the high half of a plain product', () => {
      const body = 'r = (int)((uint64_t)u * 2 >> 0x20) != 0;';
      assert.strictEqual(run(body, 'uint32_t u, int r'), body);
    });

    it('refuses the signed high multiply and a signed operand', () => {
      assert.strictEqual(run('x = (int)((int64_t)n * 0x55555556 >> 0x20) - (n >> 0x1f);', 'int n, int x'),
        'x = (int)((int64_t)n * 0x55555556 >> 0x20) - (n >> 0x1f);');
      assert.strictEqual(run('r = (uint32_t)((uint64_t)n * 0xaaaaaaab >> 0x21);', 'int n, uint32_t r'),
        'r = (uint32_t)((uint64_t)n * 0xaaaaaaab >> 0x21);');
    });
  });

  describe('64-bit runtime helpers', () => {
    it('folds __alldiv of one 64-bit value by a constant', () => {
      assert.strictEqual(
        run('l = __alldiv((uint32_t)l, (uint32_t)((uint64_t)l >> 0x20), 100, 0);', 'int64_t l'),
        'l = l / 100;');
    });

    it('folds a product dividend and a zero-extended divisor', () => {
      assert.strictEqual(
        run('r = __alldiv((uint32_t)((int64_t)(int)a * (int64_t)(int)b), (uint32_t)((uint64_t)((int64_t)(int)a * (int64_t)(int)b) >> 0x20), n + 1, 0);',
          'int a, int b, int n, int64_t r'),
        'r = (int64_t)(int)a * (int64_t)(int)b / (uint32_t)(n + 1);');
    });

    it('folds sign-extended halves', () => {
      assert.strictEqual(run('r = __allmul(n, (int)n >> 0x1f, 0x3c, 0);', 'int n, int64_t r'),
        'r = (int64_t)n * 0x3c;');
      assert.strictEqual(run('r = __aulldiv((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), d, (int)d >> 0x1f);',
        'uint64_t q, int d, uint64_t r'), 'r = q / d;');
    });

    it('casts a 64-bit unsigned divisor of a signed division', () => {
      assert.strictEqual(
        run('r = __allrem((uint32_t)a, (uint32_t)((uint64_t)a >> 0x20), (uint32_t)gqwTotal, (uint32_t)((uint64_t)gqwTotal >> 0x20));',
          'int64_t a, int64_t r'),
        'r = a % (int64_t)gqwTotal;');
    });

    // MakeMissile, 004cd540: the CRT's own spelling, `_alldiv`.
    it('folds the CRT spelling of the helpers', () => {
      assert.strictEqual(run('r = _allmul(n, (int)n >> 0x1f, 0x4b, 0);', 'int n, int64_t r'), 'r = (int64_t)n * 0x4b;');
      assert.strictEqual(run('r = _allmul(u, 0, m, 0);', 'uint32_t u, uint32_t m, int64_t r'), 'r = (int64_t)u * m;');
      assert.strictEqual(run('l = _alldiv((uint32_t)l, (uint32_t)((uint64_t)l >> 0x20), 100, 0);', 'int64_t l'), 'l = l / 100;');
      assert.strictEqual(run('r = _aulldiv((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), 10, 0);', 'uint64_t q, uint64_t r'), 'r = q / 10;');
      assert.strictEqual(run('r = _allrem(n, (int)n >> 0x1f, 7, 0);', 'int n, int64_t r'), 'r = (int64_t)n % 7;');
    });

    it('reads the high dword through a 64-bit shift or from memory', () => {
      assert.strictEqual(run('r = _alldiv((uint32_t)q, (uint32_t)(q >> 0x20), 0x400, 0);', 'int64_t q, int64_t r'), 'r = q / 0x400;');
      assert.strictEqual(run('r = _allmul((uint32_t)q, *(uint32_t*)((char*)&q + 4), 0x21, 0);', 'uint64_t q, int64_t r'),
        'r = (int64_t)q * 0x21;');
      assert.strictEqual(run('r = _allmul(n, 0, (uint32_t)q, *(int*)((uintptr_t)&q + 4));', 'uint32_t n, uint64_t q, int64_t r'),
        'r = (int64_t)n * (int64_t)q;');
      // pointer-cast-normalize spells the signed `(int)&q` as `(intptr_t)&q`.
      assert.strictEqual(run('r = _allmul(n, 0, (uint32_t)q, *(int*)((intptr_t)&q + 4));', 'uint32_t n, uint64_t q, int64_t r'),
        'r = (int64_t)n * (int64_t)q;');
    });

    it('refuses a high dword read from another value or a narrow one', () => {
      const other = 'r = _allmul((uint32_t)q, *(uint32_t*)((char*)&p + 4), 0x21, 0);';
      assert.strictEqual(run(other, 'uint64_t q, uint64_t p, int64_t r'), other);
      const narrow = 'r = _allmul((uint32_t)n, *(uint32_t*)((char*)&n + 4), 0x21, 0);';
      assert.strictEqual(run(narrow, 'int n, int64_t r'), narrow);
    });

    it('refuses halves that are not one value', () => {
      const body = 'r = __alldiv(a - b, c - d - (uint32_t)(a < b), 600000000, 0);';
      assert.strictEqual(run(body, 'uint32_t a, uint32_t b, uint32_t c, uint32_t d, int64_t r'),
        'r = __alldiv(a - b, c - d - (uint32_t)(a < b), 600000000, 0);');
      const parts = 'r = __allmul(f.LowPart, f.HighPart, 1000, 0);';
      assert.strictEqual(run(parts, 'LARGE_INTEGER f, int64_t r'), parts);
    });
  });

  it('counts each fold', () => {
    resetArithIdiomStats();
    run('x = s.nSeedLow + (int)(((uint64_t)d2_bits_of(s) & 0xffffffff) / 3) * -3;', 'D2SeedStrc s, int x');
    const st = getArithIdiomStats();
    assert.strictEqual(st['low-dword'], 1);
    assert.strictEqual(st['narrow-div'], 1);
    assert.strictEqual(st['modulo'], 1);
  });
});

/**
 * Compile every original/folded pair and compare them. Signed overflow in the
 * ORIGINAL forms (`q * -N` on an int) is what MSVC wraps, so the check builds
 * with -fwrapv.
 */
/**
 * `body` one statement per line, inside `void f(decls)`. Each line's code sits at 16 * line;
 * an `if` line given in `jumps` has its conditional branch at `16 * (line - 1) + gap`, gap
 * bytes after the line above it.
 */
function runLines(lines: string[], decls: string, jumps: Record<number, number> = {}, layout = true): string {
  const src = [`void f(${decls}) {`, ...lines, '}'];
  const at = new Map<number, number[]>();
  src.forEach((_, i) => at.set(i + 1, [16 * (i + 1)]));
  const ifs = new Map<number, number>();
  for (const [l, gap] of Object.entries(jumps)) ifs.set(Number(l) + 1, 16 * Number(l) + gap);
  const opts: ArithIdiomsOptions = { ...OPTIONS, branchLayout: layout ? { lines: at, ifs } : undefined };
  const text = emit(arithIdiomsPlugin.createTransformer(opts)(parse(src.join('\n'))) as AnyNode);
  const m = /\{([\s\S]*)\}\s*$/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim();
}

describe('arith-idioms on a comparison', () => {
  // Q20_StatusFilter, 005b8cc0: `setne cl; lea ecx, [ecx+ecx+0xb]`.
  it('writes a scaled comparison plus a constant as the select', () => {
    assert.strictEqual(run("c = (b != 0) * '\\x02' + '\\v';", 'int b, char c'), 'c = b != 0 ? 13 : 11;');
    assert.strictEqual(run('r = (n == 3) * 2 + 0xdf;', 'int n, int r'), 'r = n == 3 ? 0xe1 : 0xdf;');
    assert.strictEqual(run('r = 5 - (n < 0) * 4;', 'int n, int r'), 'r = n < 0 ? 1 : 5;');
    assert.strictEqual(run('r = (n != 0) * 2 - 1;', 'int n, int r'), 'r = n != 0 ? 1 : -1;');
  });

  // MAINMENU_CreateMessageBox, 0042f540: `neg ecx; sbb ecx, ecx; add ecx, 0x11f`.
  it('writes a constant minus a comparison as the select, in the type of the sum', () => {
    assert.strictEqual(run('r = 0x11f - (uint32_t)(p != 0);', 'int p, uint32_t r'), 'r = p != 0 ? 0x11eU : 0x11fU;');
    assert.strictEqual(run('r = (b != 0) + 0x80000001;', 'int b, uint32_t r'), 'r = b != 0 ? 0x80000002 : 0x80000001;');
  });

  it('leaves arithmetic on anything but a comparison and literals', () => {
    assert.strictEqual(run('r = (n != 0) * k + 1;', 'int n, int k, int r'), 'r = (n != 0) * k + 1;');
    assert.strictEqual(run('r = n * 2 + 1;', 'int n, int r'), 'r = n * 2 + 1;');
    assert.strictEqual(run('r = (n != 0) * 2 + 0x7fffffff;', 'int n, int r'), 'r = (n != 0) * 2 + 0x7fffffff;');
  });
});

describe('arith-idioms statement pairs', () => {
  const rem = (m: string, fix: string, gap = 5) => runLines([
    `  r = n & ${m};`,
    '  if ((int)r < 0) {',
    `    r = ${fix};`,
    '  }',
    '  g = r;',
  ], 'uint32_t n, uint32_t r, uint32_t g', { 2: gap });

  // fpLDE4, 00676450: `and eax, 0x80000003; jns; dec eax; or eax, -4; inc eax`.
  it('writes the signed power-of-two remainder back as %', () => {
    assert.strictEqual(rem('0x80000001', '(r - 1 | -2) + 1'), 'r = (int)n % 2; g = r;');
    assert.strictEqual(rem('0x80000003', '(r - 1 | 0xfffffffc) + 1'), 'r = (int)n % 4; g = r;');
    assert.strictEqual(rem('0x80000007', '(r + -1 | -8) + 1'), 'r = (int)n % 8; g = r;');
  });

  it('declares the remainder where the AND was declared', () => {
    const out = runLines([
      '  int r = n & 0x8000000f;',
      '  if (r < 0) {',
      '    r = (r - 1 | -0x10) + 1;',
      '  }',
      '  g = r;',
    ], 'int n, int g', { 2: 6 });
    assert.strictEqual(out, 'int r = n % 16; g = r;');
  });

  it('leaves the remainder without the jump right after the AND, or with a mask it is not', () => {
    assert.ok(rem('0x80000001', '(r - 1 | -2) + 1', 12).includes('& 0x80000001'));
    assert.ok(rem('0x80000003', '(r - 1 | -2) + 1').includes('& 0x80000003'));
    assert.ok(rem('0x80000005', '(r - 1 | -6) + 1').includes('& 0x80000005'));
    const noFacts = runLines(['  r = n & 0x80000001;', '  if ((int)r < 0) {', '    r = (r - 1 | -2) + 1;', '  }'],
      'uint32_t n, uint32_t r', { 2: 5 }, false);
    assert.ok(noFacts.includes('& 0x80000001'), noFacts);
  });

  // CLIENT_AdjustMemoryBudget, 00457300: `fild dword; test; jge; fadd 2^32`.
  it('writes the unsigned conversion back', () => {
    const conv = (fix: string, t = 'float') => runLines([
      `  f = (${t})(int)u;`,
      '  if ((int)u < 0) {',
      `    ${fix};`,
      '  }',
    ], `uint32_t u, ${t} f`, { 2: 9 });
    assert.strictEqual(conv('f = f + 4.2949673e+09'), 'f = (float)u;');
    assert.strictEqual(conv('f += 4294967296.0', 'double'), 'f = (double)u;');
    assert.ok(conv('f += 4.0e+09').includes('(int)u'));
  });

  it('the remainder and the double conversion have the value of what they replace', { skip: !hasNativeGpp() }, () => {
    const pairs: Array<{ t: string; lines: string[] }> = [];
    for (const k of [1, 2, 4, 30]) {
      const m = (1n << BigInt(k)) - 1n;
      pairs.push({ t: 'uint32_t', lines: [`  r = n & 0x${(0x80000000n | m).toString(16)};`, '  if ((int)r < 0) {', `    r = (r - 1 | -0x${(m + 1n).toString(16)}) + 1;`, '  }'] });
    }
    pairs.push({ t: 'double', lines: ['  r = (double)(int)n;', '  if ((int)n < 0) {', '    r += 4294967296.0;', '  }'] });
    let src = '#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\nstatic int failures = 0;\n';
    let main = 'int main(void) {\n';
    pairs.forEach((c, i) => {
      const folded = runLines(c.lines, `uint32_t n, ${c.t} r`, { 2: 5 });
      assert.ok(!folded.includes('if'), folded);
      src += `static ${c.t} a${i}(uint32_t n) { ${c.t} r; ${c.lines.join(' ')} return r; }\n`;
      src += `static ${c.t} b${i}(uint32_t n) { ${c.t} r; ${folded} return r; }\n`;
      main += `  { uint32_t v[] = { 0u, 1u, 2u, 3u, 4u, 5u, 7u, 8u, 0x3fffffffu, 0x40000000u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xbfffffffu, 0xc0000000u, 0xfffffff8u, 0xfffffffdu, 0xfffffffeu, 0xffffffffu };`
        + ` for (unsigned k = 0; k < sizeof v / sizeof v[0]; k++) { ${c.t} x = a${i}(v[k]), y = b${i}(v[k]); if (memcmp(&x, &y, sizeof x)) { printf("pair ${i} value %u\\n", k); failures++; } } }\n`;
    });
    main += '  return failures ? 1 : 0;\n}\n';
    const dir = mkdtempSync(join(tmpdir(), 'arith-pairs-'));
    writeFileSync(join(dir, 'check.c'), src + main);
    try {
      const exe = exePath(join(dir, 'check'));
      const cc = compileTo(join(dir, 'check.c'), exe, ['-O0', '-w', '-fwrapv']);
      assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
      const res = runExe(exe);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arith-idioms signed reciprocal', () => {
  const div = (a: string, b: string, decls = 'int x, int t') => runLines([`  ${a}`, `  ${b}`, '  g(t);'], decls);

  // UIMENU_PleaseReadAfterCreatingAccount, 004325b0: `imul -0x66666667; sar edx, 2; shr; add`.
  it('writes the high product, shift and sign back as the division', () => {
    assert.strictEqual(div('int t = (int)((uint64_t)((int64_t)(int)u * -0x66666667) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);', 'uint32_t u'),
      'int t = (int)u / -10; g(t);');
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'), 't = x / 10; g(t);');
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)x * 0x55555556) >> 0x20);', 't = t - (t >> 0x1f);'), 't = x / 3; g(t);');
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)(x * k) * 0x51eb851f) >> 0x20);', 't = (t >> 5) - (t >> 0x1f);', 'int x, int k, int t'),
      't = x * k / 100; g(t);');
  });

  it('takes the corrections: x added back, x subtracted, and an unsigned spelling of M', () => {
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)x * -0x6db6db6d) >> 0x20) + x;', 't = (t >> 2) - (t >> 0x1f);'), 't = x / 7; g(t);');
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)x * 0x92492493) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'), 't = x / 7; g(t);');
    assert.strictEqual(div('t = (int)((uint64_t)((int64_t)(int)(uint32_t)c * 0x55555555) >> 0x20) - (uint32_t)c;', 't = (t >> 1) - (t >> 0x1f);', 'char c, int t'),
      't = (int)(uint32_t)c / -3; g(t);');
  });

  it('refuses a constant, shift or correction that is not a reciprocal', () => {
    for (const [a, b] of [
      ['t = (int)((uint64_t)((int64_t)x * 0x66666666) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'],
      // 2^33 / 6, but not the reciprocal a compiler takes for 6.
      ['t = (int)((uint64_t)((int64_t)x * 0x55555556) >> 0x20);', 't = (t >> 1) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20) + x;', 't = (t >> 2) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x24924925) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20);', 't = t >> 2;'],
      ['t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20);', 't = (t >> 2) - (x >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20);', 'g(t);'],
    ]) {
      assert.ok(div(a, b).includes('>> 0x20'), `${a} ${b}`);
    }
    // An unsigned dividend, or an unsigned t, is another operation.
    assert.ok(div('t = (int)((uint64_t)((int64_t)u * 0x66666667) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);', 'uint32_t u, int t').includes('>> 0x20'));
    assert.ok(div('t = (int)((uint64_t)((int64_t)x * 0x66666667) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);', 'int x, uint32_t t').includes('>> 0x20'));
  });

  it('the division has the value of the reciprocal it replaces', { skip: !hasNativeGpp() }, () => {
    const cases: Array<[string, string]> = [
      ['t = (int)((uint64_t)((int64_t)x * -0x66666667) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x55555556) >> 0x20);', 't = t - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x55555555) >> 0x20) - x;', 't = (t >> 1) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x92492493) >> 0x20);', 't = (t >> 2) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * -0x51eb851f) >> 0x20);', 't = (t >> 5) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x77777777) >> 0x20) - x;', 't = (t >> 3) - (t >> 0x1f);'],
      ['t = (int)((uint64_t)((int64_t)x * 0x40000001) >> 0x20);', 't = (t >> 29) - (t >> 0x1f);'],
    ];
    let src = '#include <stdint.h>\n#include <stdio.h>\nstatic int failures = 0;\n';
    let main = 'int main(void) {\n';
    cases.forEach(([a, b], i) => {
      const folded = div(a, b).replace(' g(t);', '');
      assert.ok(folded.includes(' / '), folded);
      src += `static int a${i}(int x) { int t; ${a} ${b} return t; }\n`;
      src += `static int b${i}(int x) { int t; ${folded} return t; }\n`;
      // Every 32-bit value near a multiple of the stride, and both ends of the range.
      main += `  for (int64_t v = -0x80000000LL; v <= 0x7fffffffLL; v += (v > -0x80000000LL + 300 && v < 0x7fffffffLL - 300 && (v < -300 || v > 300)) ? 4093 : 1)`
        + ` { int x = (int)v; if (a${i}(x) != b${i}(x)) { printf("case ${i} value %d\\n", x); failures++; break; } }\n`;
    });
    main += '  return failures ? 1 : 0;\n}\n';
    const dir = mkdtempSync(join(tmpdir(), 'arith-sdiv-'));
    writeFileSync(join(dir, 'check.c'), src + main);
    try {
      const exe = exePath(join(dir, 'check'));
      const cc = compileTo(join(dir, 'check.c'), exe, ['-O1', '-w', '-fwrapv']);
      assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
      const res = runExe(exe);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arith-idioms values', () => {
  it('every fold has the value of what it replaces', { skip: !hasNativeGpp() }, () => {
    const cases: Array<{ decls: string; body: string; values: string }> = [
      { decls: 'uint32_t u, uint32_t r', body: 'r = u + (int)(u / 0x23) * -0x23;', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = u - u / 7 * 7;', values: 'U' },
      { decls: 'int n, int r', body: 'r = n - n / 3 * 3;', values: 'S' },
      { decls: 'int n, int r', body: 'r = n + n / 10 * -10;', values: 'S' },
      { decls: 'uint32_t u, int r', body: 'r = u != (int)(u / 10) * 10;', values: 'U' },
      { decls: 'int n, int r', body: 'r = n == n / 4 * 4;', values: 'S' },
      { decls: 'int n, int r', body: 'r = (int)(n + (n >> 0x1f & 3U)) >> 2;', values: 'S' },
      { decls: 'int n, int r', body: 'r = n + (n >> 0x1f & 1) >> 1;', values: 'S' },
      { decls: 'int n, int r', body: 'r = (int)((n >> 0x1f & 3U) + n) >> 2;', values: 'S' },
      { decls: 'int n, int r', body: 'r = (n ^ n >> 0x1f) - (n >> 0x1f);', values: 'S' },
      { decls: 'int n, int r', body: 'r = n != (uint32_t)n / 0xd * 0xd;', values: 'S' },
      { decls: 'int n, int r', body: 'r = (int)(n + (n >> 0x1f & 0xffffU)) >> 0x10;', values: 'S' },
      { decls: 'uint32_t u, int r', body: 'r = (int)(u + ((int)u >> 0x1f & 7U)) >> 3;', values: 'U' },
      { decls: 'int16_t h, int r', body: 'r = h + (h >> 0x1f & 0xff) >> 8;', values: 'S' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (uint32_t)((uint64_t)u % (uint64_t)0x80000001);', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (uint32_t)((uint64_t)u / 3);', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (uint32_t)((uint64_t)u * 0xaaaaaaab >> 0x21);', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (uint32_t)((uint64_t)u * 0x51eb851f >> 0x25);', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (uint32_t)((uint64_t)u * 0x10624dd3 >> 0x26);', values: 'U' },
      { decls: 'int64_t q, int64_t r', body: 'r = __alldiv((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), 100, 0);', values: 'Q' },
      { decls: 'int n, int64_t r', body: 'r = __alldiv((uint32_t)n, (uint32_t)((uint64_t)n >> 0x20), n | 1, (int)(n | 1) >> 0x1f);', values: 'S' },
      { decls: 'int n, int64_t r', body: 'r = __allrem((uint32_t)n, (uint32_t)((uint64_t)n >> 0x20), (uint32_t)n | 1, 0);', values: 'S' },
      { decls: 'int n, int64_t r', body: 'r = __allmul(n, (int)n >> 0x1f, 0x3c, 0);', values: 'S' },
      { decls: 'int64_t q, uint64_t r', body: 'r = __aulldiv((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), 0xfffffff1, 0);', values: 'Q' },
      { decls: 'int64_t q, uint64_t r', body: 'r = __aullrem((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), (uint32_t)q | 1, (int)((uint32_t)q | 1) >> 0x1f);', values: 'Q' },
      { decls: 'int n, int64_t r', body: 'r = _allmul(n, (int)n >> 0x1f, 0x4b, 0);', values: 'S' },
      { decls: 'uint32_t u, int64_t r', body: 'r = _allmul(u, 0, 0x3b9aca07, 0);', values: 'U' },
      { decls: 'int n, int64_t r', body: 'r = _alldiv((uint32_t)((int64_t)n * 0x4b), (uint32_t)((uint64_t)((int64_t)n * 0x4b) >> 0x20), 100, 0);', values: 'S' },
      { decls: 'int n, int64_t r', body: 'r = _allrem(n, (int)n >> 0x1f, 7, 0);', values: 'S' },
      { decls: 'int64_t q, uint64_t r', body: 'r = _aulldiv((uint32_t)q, (uint32_t)((uint64_t)q >> 0x20), 10, 0);', values: 'Q' },
      { decls: 'int64_t q, int64_t r', body: 'r = _alldiv((uint32_t)q, (uint32_t)(q >> 0x20), 0x400, 0);', values: 'Q' },
      { decls: 'int64_t q, int64_t r', body: 'r = _allmul((uint32_t)q, *(uint32_t*)((char*)&q + 4), 0x21, 0);', values: 'Q' },
      { decls: 'uint64_t q, int64_t r', body: 'r = _allmul(0x1234567u, 0, (uint32_t)q, *(int*)((uintptr_t)&q + 4));', values: 'Q' },
      { decls: 'int n, int r', body: "r = (n != 0) * '\\x02' + '\\v';", values: 'S' },
      { decls: 'int n, int r', body: 'r = 5 - (n < 0) * 4;', values: 'S' },
      { decls: 'int n, uint32_t r', body: 'r = 0x11f - (uint32_t)(n != 0);', values: 'S' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (u > 7) + 0x80000001;', values: 'U' },
      { decls: 'uint32_t u, int r', body: 'r = (u == 0) * 2 - 1;', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = (u ^ (int)u >> 0x1f) - ((int)u >> 0x1f);', values: 'U' },
      { decls: 'int n, uint8_t r', body: 'r = (uint8_t)((uint32_t)n >> 0x10);', values: 'S' },
      { decls: 'int n, uint16_t r', body: 'r = (uint16_t)((uint32_t)n >> 8);', values: 'S' },
      { decls: 'int n, uint8_t r', body: 'r = (uint8_t)((uint32_t)n >> 0x18);', values: 'S' },
      { decls: 'int n, uint8_t r', body: 'r = (uint8_t)(n + (n >> 0x1f & 0xffffU) >> 0x10);', values: 'S' },
      { decls: 'int n, uint16_t r', body: 'r = (uint16_t)(n + (n >> 0x1f & 0xffU) >> 8);', values: 'S' },
    ];
    const VALUES: Record<string, string> = {
      U: '0u, 1u, 2u, 3u, 6u, 7u, 9u, 10u, 34u, 35u, 36u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xfffffffeu, 0xffffffffu, 123456789u',
      S: '0, 1, -1, 2, -2, 3, -3, 4, -4, 7, -7, 255, -255, 256, -256, 65535, -65535, 65536, -65536, 0x7fffffff, (int)0x80000000, (int)0x80000001, -123456789',
      Q: '0, 1, -1, 99, -99, 100, -100, 101, -101, 0x7fffffffLL, -0x80000000LL, 0xffffffffLL, 0x100000000LL, -0x100000001LL, 0x7fffffffffffffffLL, (int64_t)0x8000000000000000ULL, 1234567890123LL',
    };
    let src = '#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n'
      + 'static inline int64_t __alldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) / (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }\n'
      + 'static inline int64_t __allmul(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (int64_t)((lo1 | ((uint64_t)hi1 << 32)) * (lo2 | ((uint64_t)hi2 << 32))); }\n'
      + 'static inline int64_t __allrem(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) % (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }\n'
      + 'static inline uint64_t __aulldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) / (lo2 | ((uint64_t)hi2 << 32)); }\n'
      + 'static inline uint64_t __aullrem(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) % (lo2 | ((uint64_t)hi2 << 32)); }\n'
      + '#define _alldiv __alldiv\n#define _allmul __allmul\n#define _allrem __allrem\n#define _aulldiv __aulldiv\n'
      + 'static int failures = 0;\n';
    let main = 'int main(void) {\n';
    cases.forEach((c, i) => {
      const folded = run(c.body, c.decls);
      assert.notStrictEqual(folded, c.body, `case ${i} did not fold: ${c.body}`);
      const [argDecl, resDecl] = c.decls.split(',').map(s => s.trim());
      const [argT, arg] = argDecl.split(' ');
      const [resT] = resDecl.split(' ');
      src += `static ${resT} a${i}(${argT} ${arg}) { ${resT} r; ${c.body} return r; }\n`;
      src += `static ${resT} b${i}(${argT} ${arg}) { ${resT} r; ${folded} return r; }\n`;
      main += `  { ${argT} v[] = { ${VALUES[c.values]} }; for (unsigned k = 0; k < sizeof v / sizeof v[0]; k++) {`
        + ` ${resT} x = a${i}(v[k]), y = b${i}(v[k]); if (memcmp(&x, &y, sizeof x)) { printf("case ${i} value %u\\n", k); failures++; } } }\n`;
    });
    main += '  return failures ? 1 : 0;\n}\n';
    // Division by zero cannot happen: every divisor above is a constant or forced odd.
    const dir = mkdtempSync(join(tmpdir(), 'arith-idioms-'));
    writeFileSync(join(dir, 'check.c'), src + main);
    try {
      const exe = exePath(join(dir, 'check'));
      const cc = compileTo(join(dir, 'check.c'), exe, ['-O0', '-w', '-fwrapv']);
      assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
      const run = runExe(exe);
      assert.strictEqual(run.stdout, '');
      assert.strictEqual(run.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 32-bit operations the decompiler printed 64 bits wide, which VC8 then compiles to the
 * long helpers (`_alldiv`, `_aulldiv`, `_aullrem`, `_allmul`) where the original has one
 * `idiv`, `div` or `imul`. The proof of each fold is in its comment in arith-idioms.ts; the
 * value checks below compile both sides with the host compiler (-fwrapv: the target wraps)
 * and compare them over every pair of edge values, and the reciprocals over every 32-bit
 * value near a multiple of a stride.
 */
describe('arith-idioms widened 32-bit arithmetic', () => {
  // SetAnimationSpeed(pUnit, (int32_t)(0xa00 / (int64_t)nDistance)), 004c5620: `cdq; idiv`.
  it('narrows a signed division of sign-extended dwords', () => {
    assert.strictEqual(run('r = (int)(0xa00 / (int64_t)n);', 'int n, int r'), 'r = (int)(0xa00 / n);');
    assert.strictEqual(run('r = (int)(0x7fffffff / (int64_t)(int)k);', 'uint32_t k, int r'), 'r = (int)(0x7fffffff / (int)k);');
    assert.strictEqual(run('r = (int)(100000 / (int64_t)(n / 64 + 1));', 'int n, int r'), 'r = (int)(100000 / (n / 64 + 1));');
    // 004e1400: the AnimLen byte shifted in 64 bits stays below 2^16.
    assert.strictEqual(run('r = (int32_t)((int64_t)((uint64_t)(uint8_t)c << 8) / (int64_t)n);', 'uint8_t c, int n, int r'),
      'r = (int32_t)(((uint8_t)c << 8) / n);');
    // 00542b40: a byte zero-extended, then read as signed.
    assert.strictEqual(run('r = d - (int)((int64_t)(uint64_t)b / (int64_t)n);', 'uint8_t b, int n, int d, int r'), 'r = d - (int)(b / n);');
    assert.strictEqual(run('r = (int)((int64_t)x % (int64_t)n);', 'int x, int n, int r'), 'r = (int)(x % n);');
  });

  it('keeps a division whose operands are not int32 values', () => {
    for (const [body, decls] of [
      // A zero-extended dword can reach 2^32 - 1.
      ['r = (int)((int64_t)(uint64_t)u / (int64_t)n);', 'uint32_t u, int n, int r'],
      ['r = (int)((int64_t)u / (int64_t)n);', 'uint32_t u, int n, int r'],
      // Sign-extended into an unsigned 64-bit value: huge, not negative.
      ['r = (int)((uint64_t)x / (uint64_t)n);', 'int x, int n, int r'],
      // A byte shifted past bit 31.
      ['r = (int)((int64_t)((uint64_t)(uint8_t)c << 0x18) / (int64_t)n);', 'uint8_t c, int n, int r'],
      // The quotient used as 64 bits.
      ['q = (int64_t)x / (int64_t)n;', 'int x, int n, int64_t q'],
    ]) {
      assert.strictEqual(run(body, decls), body, body);
    }
  });

  // nSpawnX = (int)nRngProduct + (int)((nRngProduct & 0xffffffff) / 5) * -5 - 2 + ptCenter.x, 0046c320.
  it('divides the low dword of a 64-bit value in 32 bits, and folds the remainder', () => {
    assert.strictEqual(run('r = (int)E + (int)((E & 0xffffffff) / 5) * -5 - 2;', 'uint64_t E, int r'), 'r = (int)((uint32_t)E % 5) - 2;');
    assert.strictEqual(run('r = (uint32_t)((E & 0xffffffff) % (uint64_t)k);', 'uint64_t E, uint32_t k, uint32_t r'), 'r = (uint32_t)((uint32_t)E % k);');
    // 005a5560: the byte spelling keeps its arithmetic; only the division narrows.
    assert.strictEqual(run('r = (uint8_t)((char)E + (char)((E & 0xffffffff) / 100) * -100);', 'uint64_t E, uint8_t r'),
      'r = (uint8_t)((char)E + (char)((uint32_t)E / 100) * -100);');
    // 00473e50: the low dword of a product is a 32-bit product.
    assert.strictEqual(run('r = (int)(((int64_t)(int)a * (int64_t)g & 0xffffffffU) / (uint64_t)d);', 'int a, uint32_t g, uint32_t d, int r'),
      'r = (int)((uint32_t)((int)a * g) / d);');
  });

  it('keeps a mask, a divisor or a remainder it cannot narrow', () => {
    for (const [body, decls] of [
      ['r = (uint32_t)((E & 0xfffffffff) / 5);', 'uint64_t E, uint32_t r'],
      ['r = (uint32_t)((E & 0xffffffff) / (uint64_t)n);', 'uint64_t E, int n, uint32_t r'],
      ['r = (uint32_t)((E & 0xffffffff) / F);', 'uint64_t E, uint64_t F, uint32_t r'],
    ]) {
      assert.strictEqual(run(body, decls), body, body);
    }
    // A different value on the left of the remainder.
    assert.ok(run('r = (int)F + (int)((E & 0xffffffff) / 5) * -5;', 'uint64_t E, uint64_t F, int r').includes('* -5'));
  });

  // int x = (int)(0x10001 / (uint64_t)value), 005242f0: `xor edx, edx; div`.
  it('narrows a constant divided by a zero-extended dword', () => {
    assert.strictEqual(run('r = (int)(0x10001 / (uint64_t)v);', 'uint32_t v, int r'), 'r = (int)(0x10001 / v);');
    assert.strictEqual(run('r = (uint32_t)(0x10001 % (uint64_t)v);', 'uint32_t v, uint32_t r'), 'r = (uint32_t)(0x10001 % v);');
    // A signed divisor is sign-extended by the cast, and a constant past INT_MAX is not an int.
    assert.strictEqual(run('r = (int)(0x10001 / (uint64_t)n);', 'int n, int r'), 'r = (int)(0x10001 / (uint64_t)n);');
    assert.strictEqual(run('r = (int)(0x80000000 / (uint64_t)v);', 'uint32_t v, int r'), 'r = (int)(0x80000000 / (uint64_t)v);');
  });

  // return (int)((uint64_t)sSeedUpdated.nSeedLow * 0xe6c2b449), 00472610: `imul`.
  it('narrows a truncated 64-bit product', () => {
    assert.strictEqual(run('r = (int)((uint64_t)s * 0xe6c2b449);', 'uint32_t s, int r'), 'r = (int)(s * 0xe6c2b449);');
    assert.strictEqual(run('r = (int)((int64_t)a * (int64_t)b);', 'int a, int b, int r'), 'r = (int)((uint32_t)a * b);');
    assert.strictEqual(run('r = (short)((int64_t)a * 0x10);', 'int a, short r'), 'r = (short int)((uint32_t)a * 0x10);');
    // A 64-bit factor, or a result kept 64 bits wide.
    assert.strictEqual(run('r = (int)(q * 3);', 'uint64_t q, int r'), 'r = (int)(q * 3);');
    assert.strictEqual(run('q = (uint64_t)s * 0xe6c2b449;', 'uint32_t s, uint64_t q'), 'q = (uint64_t)s * 0xe6c2b449;');
  });

  // cRainStep = -((char)(nRainGradient / 0xc) + (char)(nRainGradient >> 0x1f) - (char)((int64_t)nRainGradient * 0x2aaaaaab >> 0x3f)), 00472890.
  it('drops the two sign terms of a recovered quotient', () => {
    assert.strictEqual(run('r = -((char)(x / 0xc) + (char)(x >> 0x1f) - (char)((int64_t)x * 0x2aaaaaab >> 0x3f));', 'int x, char r'),
      'r = -(char)(x / 0xc);');
    assert.strictEqual(run("*p = (char)(x / 10) + (char)(x >> 0x1f) - (char)((int64_t)x * 0x66666667 >> 0x3f) + '0';", 'int x, char* p'),
      "*p = (char)(x / 10) + '0';");
    assert.strictEqual(run('p[1] = (short int)(x / 0x14) + (short int)(x >> 0x1f) - (short int)((int64_t)x * 0x66666667 >> 0x3f);', 'int x, short* p'),
      'p[1] = (short int)(x / 0x14);');
    assert.strictEqual(run('r = (char)(x / 0xff) + (char)(x >> 0x1f) - (char)((int64_t)x * 0x80808081 >> 0x3f);', 'int x, char r'),
      'r = (char)(x / 0xff);');
  });

  it('keeps sign terms that do not cancel', () => {
    for (const [body, decls] of [
      ['r = (char)(x / 0xc) + (char)(x >> 0x1f) - (char)((int64_t)y * 0x2aaaaaab >> 0x3f);', 'int x, int y, char r'],
      ['r = (char)(x / 0xc) + (char)(x >> 0x1f) - (short int)((int64_t)x * 0x2aaaaaab >> 0x3f);', 'int x, char r'],
      // A negative multiplier flips the product's sign.
      ['r = (char)(x / 0xc) + (char)(x >> 0x1f) - (char)((int64_t)x * -0x2aaaaaab >> 0x3f);', 'int x, char r'],
      // An unsigned x has no sign to cancel.
      ['r = (char)(u / 0xc) + (char)(u >> 0x1f) - (char)((int64_t)u * 0x2aaaaaab >> 0x3f);', 'uint32_t u, char r'],
    ]) {
      assert.strictEqual(run(body, decls), body, body);
    }
  });

  const use = (lines: string[], decls: string) => runLines(lines.map(l => `  ${l}`), decls);

  // nDiv = (int)((uint64_t)((int64_t)nY * -0x66666667) >> 0x20); nY += (nDiv >> 4) - (nDiv >> 0x1f);, 0045aff0.
  it('writes a reciprocal used in a larger expression back as the division', () => {
    assert.strictEqual(use(['int t;', 't = (int)((uint64_t)((int64_t)y * -0x66666667) >> 0x20);', 'y += (t >> 4) - (t >> 0x1f);', 'g(y);'], 'int y'),
      'int t; y += y / -40; g(y);');
    // 005eb970: the high product is stored back over its own dividend.
    assert.strictEqual(use(['r = (int)((uint64_t)((int64_t)r * -0x66666667) >> 0x20);', 'a = b + a + ((r >> 2) - (r >> 0x1f));', 'g(a);'], 'int r, int a, int b'),
      'a = b + a + r / -10; g(a);');
    // 006735f0: x subtracted back, the quotient scaled.
    assert.strictEqual(use(['int t;', 't = (int)((uint64_t)((int64_t)p * 0x77777777) >> 0x20) - p;', 'p += ((t >> 3) - (t >> 0x1f)) * 0xf;', 'g(p);'], 'int p'),
      'int t; p += p / -15 * 0xf; g(p);');
    // 004da350: stored into a member.
    assert.strictEqual(use(['int t;', 't = (int)((uint64_t)((int64_t)(a * b) * -0x51eb851f) >> 0x20);', 's->z = (t >> 5) - (t >> 0x1f);'], 'int a, int b, S* s'),
      'int t; s->z = a * b / -100;');
    // 00582da0: a call's argument, and the dividend naming t itself.
    assert.strictEqual(use(['n = (int)((uint64_t)((int64_t)(int)(a * (n >> 8)) * -0x51eb851f) >> 0x20);', 'h(p, ((n >> 5) - (n >> 0x1f)) * 0x100, 0);'], 'int n, int a, int p'),
      'h(p, (int)(a * (n >> 8)) / -100 * 0x100, 0);');
    // 006735f0: at the end of a loop body whose next iteration sets t before reading it.
    assert.strictEqual(use(['int t;', 'for (; y; y--) {', 'g(y);', 'p++;', 't = (int)((uint64_t)((int64_t)p * 0x77777777) >> 0x20) - p;', 'p += ((t >> 3) - (t >> 0x1f)) * 0xf;', '}'], 'int y, int p'),
      'int t; for (; y; y--) { g(y); p++; p += p / -15 * 0xf; }');
    // 00605b70: the byte spelling, into a byte.
    assert.strictEqual(use(['int t;', 'if (c > 0) {', 't = (int)((uint64_t)((int64_t)(int)(uint32_t)c * 0x55555555) >> 0x20) - (uint32_t)c;', 'c += (char)(t >> 1) - (char)(t >> 0x1f);', '}', 'g(c);'], 'uint8_t c'),
      'int t; if (c > 0) { c += (char)((int)(uint32_t)c / -3); } g(c);');
  });

  it('keeps a reciprocal whose temporary lives on, or whose context is not modular', () => {
    const hp = 't = (int)((uint64_t)((int64_t)y * -0x66666667) >> 0x20);';
    for (const [lines, decls] of [
      [['int t;', hp, 'y += (t >> 4) - (t >> 0x1f);', 'g(t);'], 'int y'],
      [['int t;', hp, 'y += (t >> 4) - (t >> 0x1f) + t;'], 'int y'],
      [['int t;', hp, 'y += (t >> 4) - (t >> 0x1f) + h();'], 'int y'],
      [['int t;', hp, 'g(h(), (t >> 4) - (t >> 0x1f));'], 'int y'],
      // A loop that comes round reads t before it is set again, and a jump is followed nowhere.
      [['int t;', 'do {', 'g(t);', hp, 'y += (t >> 4) - (t >> 0x1f);', '} while (y);'], 'int y'],
      [['int t;', 'while (t) {', hp, 'y += (t >> 4) - (t >> 0x1f);', '}'], 'int y'],
      [['int t;', 'for (; y; y--) {', hp, 'y += (t >> 4) - (t >> 0x1f);', 'if (y) break;', '}', 'g(t);'], 'int y'],
      [['int t;', 'l:', hp, 'y += (t >> 4) - (t >> 0x1f);', 'if (y) goto l;'], 'int y'],
      // The sign of another value.
      [['int t;', hp, 'y += (t >> 4) - (y >> 0x1f);'], 'int y'],
      // A byte difference stored into an int, or under a division, is not the byte quotient.
      [['int t;', hp, 'n += (char)(t >> 4) - (char)(t >> 0x1f);'], 'int y, int n'],
      [['int t;', hp, 'c = ((char)(t >> 4) - (char)(t >> 0x1f)) / 2;'], 'int y, char c'],
    ] as Array<[string[], string]>) {
      assert.ok(use(lines, decls).includes('>> 0x20'), lines.join(' '));
    }
    // A global temporary: a call elsewhere may read it.
    assert.ok(runLines(['  gnWidth = (int)((uint64_t)((int64_t)y * -0x66666667) >> 0x20);', '  y += (gnWidth >> 4) - (gnWidth >> 0x1f);'], 'int y').includes('>> 0x20'));
  });

  it('the narrowed operations have the values of what they replace', { skip: !hasNativeGpp() }, () => {
    // Each case: argument declarations, the statement, the value set of each argument.
    const cases: Array<{ decls: string; body: string; values: string[]; skip?: string }> = [
      { decls: 'int n, int r', body: 'r = (int)(0xa00 / (int64_t)n);', values: ['S'], skip: 'n == 0' },
      { decls: 'int x, int n, int r', body: 'r = (int)((int64_t)x / (int64_t)n);', values: ['S', 'S'], skip: 'n == 0 || (x == (int)0x80000000 && n == -1)' },
      { decls: 'int x, int n, int r', body: 'r = (int)((int64_t)x % (int64_t)n);', values: ['S', 'S'], skip: 'n == 0 || (x == (int)0x80000000 && n == -1)' },
      { decls: 'uint8_t c, int n, int r', body: 'r = (int32_t)((int64_t)((uint64_t)(uint8_t)c << 8) / (int64_t)n);', values: ['B', 'S'], skip: 'n == 0' },
      { decls: 'uint8_t b, int n, int r', body: 'r = 7 - (int)((int64_t)(uint64_t)b / (int64_t)n);', values: ['B', 'S'], skip: 'n == 0' },
      { decls: 'uint64_t E, int r', body: 'r = (int)E + (int)((E & 0xffffffff) / 5) * -5 - 2;', values: ['Q'] },
      { decls: 'uint64_t E, int r', body: 'r = (int)E + (int)((E & 0xffffffff) / 0x7fffffff) * -0x7fffffff;', values: ['Q'] },
      { decls: 'uint64_t E, uint32_t k, uint32_t r', body: 'r = (uint32_t)((E & 0xffffffff) % (uint64_t)k);', values: ['Q', 'U'], skip: 'k == 0' },
      { decls: 'uint64_t E, uint8_t r', body: 'r = (uint8_t)((char)E + (char)((E & 0xffffffff) / 100) * -100);', values: ['Q'] },
      { decls: 'int a, uint32_t g, uint32_t d, int r', body: 'r = (int)(((int64_t)(int)a * (int64_t)g & 0xffffffffU) / (uint64_t)d);', values: ['S', 'U', 'U'], skip: 'd == 0' },
      { decls: 'uint32_t v, int r', body: 'r = (int)(0x10001 / (uint64_t)v);', values: ['U'], skip: 'v == 0' },
      { decls: 'uint32_t v, uint32_t r', body: 'r = (uint32_t)(0x10001 % (uint64_t)v);', values: ['U'], skip: 'v == 0' },
      { decls: 'uint32_t s, int r', body: 'r = (int)((uint64_t)s * 0xe6c2b449);', values: ['U'] },
      { decls: 'int a, int b, int r', body: 'r = (int)((int64_t)a * (int64_t)b);', values: ['S', 'S'] },
      { decls: 'int x, char r', body: 'r = -((char)(x / 0xc) + (char)(x >> 0x1f) - (char)((int64_t)x * 0x2aaaaaab >> 0x3f));', values: ['S'] },
      { decls: 'int x, int r', body: 'r = (char)(x / 0xff) + (char)(x >> 0x1f) - (char)((int64_t)x * 0x80808081 >> 0x3f);', values: ['S'] },
      { decls: 'int x, int r', body: 'r = (short)(x / 0x14) + (short)(x >> 0x1f) - (short)((int64_t)x * 0x66666667 >> 0x3f);', values: ['S'] },
    ];
    const VALUES: Record<string, string> = {
      B: '0, 1, 2, 0x7f, 0x80, 0xfe, 0xff',
      U: '0u, 1u, 2u, 3u, 5u, 7u, 99u, 100u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xfffffffeu, 0xffffffffu, 123456789u',
      S: '0, 1, -1, 2, -2, 3, -3, 10, -10, 255, -255, 256, -256, 0x7fffffff, -0x7fffffff, (int)0x80000000, 123456789, -123456789',
      Q: '0, 1, 4, 5, 6, 0x7fffffffULL, 0x80000000ULL, 0xffffffffULL, 0x100000000ULL, 0x1000000005ULL, 0xfffffffffffffffbULL, 0xffffffffffffffffULL, 0x123456789abcdefULL',
    };
    let src = '#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\nstatic int failures = 0;\n';
    let main = 'int main(void) {\n';
    cases.forEach((c, i) => {
      const folded = run(c.body, c.decls);
      assert.notStrictEqual(folded, c.body, `case ${i} did not fold: ${c.body}`);
      const params = c.decls.split(',').map(s => s.trim());
      const res = params.pop()!;
      const [resT] = res.split(' ');
      const args = params.map(p => p.split(' '));
      const sig = args.map(([t, n]) => `${t} ${n}`).join(', ');
      src += `static ${resT} a${i}(${sig}) { ${resT} r; ${c.body} return r; }\n`;
      src += `static ${resT} b${i}(${sig}) { ${resT} r; ${folded} return r; }\n`;
      let loop = '';
      let close = '';
      args.forEach(([t, n], k) => {
        loop += `{ ${t} v${k}[] = { ${VALUES[c.values[k]]} }; for (unsigned i${k} = 0; i${k} < sizeof v${k} / sizeof v${k}[0]; i${k}++) { ${t} ${n} = v${k}[i${k}]; `;
        close += '} } ';
      });
      const names = args.map(([, n]) => n).join(', ');
      main += `  ${loop}${c.skip ? `if (${c.skip}) continue; ` : ''}{ ${resT} ra = a${i}(${names}), rb = b${i}(${names}); if (memcmp(&ra, &rb, sizeof ra)) { printf("case ${i}\\n"); failures++; } } ${close}\n`;
    });
    // The reciprocals over the 32-bit range, as the signed-reciprocal check does.
    const recips: Array<{ decls: string; lines: string[] }> = [
      { decls: 'int y', lines: ['int t;', 't = (int)((uint64_t)((int64_t)y * -0x66666667) >> 0x20);', 'y += (t >> 4) - (t >> 0x1f);'] },
      { decls: 'int y', lines: ['int t;', 't = (int)((uint64_t)((int64_t)y * -0x66666667) >> 0x20);', 'y += (t >> 2) - (t >> 0x1f);'] },
      { decls: 'int y', lines: ['int t;', 't = (int)((uint64_t)((int64_t)y * -0x51eb851f) >> 0x20);', 'y = (t >> 5) - (t >> 0x1f);'] },
      { decls: 'int y', lines: ['int t;', 't = (int)((uint64_t)((int64_t)y * 0x77777777) >> 0x20) - y;', 'y += ((t >> 3) - (t >> 0x1f)) * 0xf;'] },
      { decls: 'int y', lines: ['int t;', 't = (int)((uint64_t)((int64_t)y * 0x55555555) >> 0x20) - y;', 'y += (t >> 1) - (t >> 0x1f);'] },
      { decls: 'uint8_t c', lines: ['int t;', 't = (int)((uint64_t)((int64_t)(int)(uint32_t)c * 0x55555555) >> 0x20) - (uint32_t)c;', 'c += (char)(t >> 1) - (char)(t >> 0x1f);'] },
    ];
    recips.forEach((c, i) => {
      const folded = use(c.lines, c.decls);
      assert.ok(!folded.includes('>> 0x20'), folded);
      const [t, n] = c.decls.split(' ');
      src += `static ${t} ra${i}(${t} ${n}) { ${c.lines.join(' ')} return ${n}; }\n`;
      src += `static ${t} rb${i}(${t} ${n}) { ${folded} return ${n}; }\n`;
      main += `  for (int64_t v = -0x80000000LL; v <= 0x7fffffffLL; v += (v > -0x80000000LL + 300 && v < 0x7fffffffLL - 300 && (v < -300 || v > 300)) ? 4093 : 1)`
        + ` { ${t} x = (${t})v; if (ra${i}(x) != rb${i}(x)) { printf("reciprocal ${i} value %lld\\n", (long long)v); failures++; break; } }\n`;
    });
    main += '  return failures ? 1 : 0;\n}\n';
    const dir = mkdtempSync(join(tmpdir(), 'arith-widened-'));
    writeFileSync(join(dir, 'check.c'), src + main);
    try {
      const exe = exePath(join(dir, 'check'));
      const cc = compileTo(join(dir, 'check.c'), exe, ['-O1', '-w', '-fwrapv']);
      assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
      const res = runExe(exe);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('arith-idioms non-negative division printed unsigned', () => {
  // UIMENU 0043ddd0, Units 00620e80, OBJMODE 00581510: `cdq; idiv` of zero-extended bytes and
  // masked fields, which the decompiler printed as a UDIV once it saw both were non-negative.
  it('writes it back as int division', () => {
    assert.strictEqual(
      run('n = (int)((uint64_t)(s >> 8 & 0x1f) / (uint64_t)(int64_t)(int)((s & 0x20 | 0x80) >> 5));', 'uint32_t s, int n'),
      'n = (int)((int)(s >> 8 & 0x1f) / (int)((s & 0x20 | 0x80) >> 5));');
    assert.strictEqual(
      run('n = (int)((uint64_t)((uint32_t)(uint8_t)a * 100) / (uint64_t)(int64_t)(int)(uint32_t)b) - 100;', 'uint8_t a, uint8_t b, int n'),
      'n = (int)((int)((uint32_t)(uint8_t)a * 100) / (int)(uint32_t)b) - 100;');
    assert.strictEqual(
      run('if (!(int)((uint64_t)(uint32_t)c % (uint64_t)(int64_t)(int)((uint64_t)(uint8_t)e / (uint64_t)(int64_t)(int)(uint32_t)b))) { n = 1; }',
        'uint8_t c, uint8_t e, uint8_t b, int n'),
      'if (!(int)((int)(uint32_t)c % (int)((uint8_t)e / (int)(uint32_t)b))) { n = 1; }');
    // The signed division of a zero-extended byte the int32 narrowing did not see (00581510).
    assert.strictEqual(run('n = (uint32_t)b - (int)((int64_t)(uint64_t)(uint32_t)c / (int64_t)k);', 'uint8_t b, uint8_t c, int k, int n'),
      'n = (uint32_t)b - (int)((int)(uint32_t)c / k);');
  });

  it('keeps a division without the sign extension, or with an operand that may pass INT_MAX', () => {
    for (const [body, decls, expected] of [
      // No `cdq`: the original's `div`; narrow-div keeps it unsigned.
      ['n = (int)((uint64_t)e / (uint64_t)b);', 'uint8_t e, uint8_t b, int n', 'n = (int)(e / b);'],
      // A dword can pass INT_MAX.
      ['n = (int)((uint64_t)u / (uint64_t)(int64_t)(int)b);', 'uint32_t u, uint8_t b, int n', null],
      // A signed divisor may be negative: the unsigned division of its extension is not it.
      ['n = (int)((uint64_t)e / (uint64_t)(int64_t)k);', 'uint8_t e, int k, int n', null],
      // A product past INT_MAX.
      ['n = (int)((uint64_t)((uint32_t)a * 0x1000000) / (uint64_t)(int64_t)(int)(uint32_t)b);', 'uint8_t a, uint8_t b, int n', null],
      // The quotient used as 64 bits.
      ['q = (uint64_t)e / (uint64_t)(int64_t)(int)(uint32_t)b;', 'uint8_t e, uint8_t b, uint64_t q', null],
    ] as Array<[string, string, string | null]>) {
      assert.strictEqual(run(body, decls), expected ?? body, body);
    }
  });

  it('has the value of what it replaces', { skip: !hasNativeGpp() }, () => {
    const cases: Array<{ decls: string; body: string; values: string[]; skip?: string }> = [
      { decls: 'uint32_t s, int r', body: 'r = (int)((uint64_t)(s >> 8 & 0x1f) / (uint64_t)(int64_t)(int)((s & 0x20 | 0x80) >> 5));', values: ['U'] },
      { decls: 'int s, int r', body: 'r = (int)((uint64_t)(s >> 8 & 0x1f) % (uint64_t)(int64_t)(int)((s & 0x20 | 0x80) >> 5));', values: ['S'] },
      { decls: 'uint8_t a, uint8_t b, int r', body: 'r = (int)((uint64_t)((uint32_t)(uint8_t)a * 100) / (uint64_t)(int64_t)(int)(uint32_t)b) - 100;', values: ['B', 'B'], skip: 'b == 0' },
      { decls: 'uint8_t c, uint8_t e, uint8_t b, int r', body: 'r = (int)((uint64_t)(uint32_t)c % (uint64_t)(int64_t)(int)((uint64_t)(uint8_t)e / (uint64_t)(int64_t)(int)(uint32_t)b));', values: ['B', 'B', 'B'], skip: 'b == 0 || e / b == 0' },
      { decls: 'uint8_t b, uint8_t c, int k, int r', body: 'r = (uint32_t)b - (int)((int64_t)(uint64_t)(uint32_t)c / (int64_t)k);', values: ['B', 'B', 'S'], skip: 'k == 0' },
      { decls: 'uint16_t w, uint8_t b, uint8_t r', body: 'r = (uint8_t)((uint64_t)((uint32_t)w | 0x8000) / (uint64_t)(int64_t)(int)((uint32_t)b >> 1 | 1));', values: ['W', 'B'] },
    ];
    nativeCheck(cases);
  });
});

describe('arith-idioms zero-extended 64-bit locals', () => {
  const fn = (text: string): string => {
    const out = arithIdiomsPlugin.createTransformer(OPTIONS)(parse(text));
    return emit(out as AnyNode).replace(/\s+/g, ' ').trim();
  };

  // VIEW_Init 00475b40, NET_SID_CLIENT_IDEAMultInverse 005242f0, BigBuffer_Square 00424b00.
  it('declares the local as the dword it holds', () => {
    assert.strictEqual(
      fn('void f(uint32_t i) { uint64_t d; d = (uint64_t)i; g[i] = (uint32_t)(0x10000 / d); }'),
      'void f(uint32_t i) { uint32_t d; d = i; g[i] = (uint32_t)(0x10000 / d); }');
    assert.strictEqual(
      fn('uint32_t f(uint32_t v, uint32_t r) { uint64_t m; uint64_t t; m = (uint64_t)(v % r); v = (uint32_t)m; t = (uint64_t)r; r = (uint32_t)(t % m); return (int)(t / m) * v + r; }'),
      'uint32_t f(uint32_t v, uint32_t r) { uint32_t m; uint32_t t; m = v % r; v = (uint32_t)m; t = r; r = (uint32_t)(t % m); return (int)(t / m) * v + r; }');
    // The product keeps its 64 bits: the read is the zero-extension, VC8's one-operand `mul`.
    assert.strictEqual(
      fn('uint64_t f(uint32_t b, uint32_t a, uint64_t c) { uint64_t p; p = (uint64_t)b; c = a * p + c; return c; }'),
      'uint64_t f(uint32_t b, uint32_t a, uint64_t c) { uint32_t p; p = b; c = a * (uint64_t)p + c; return c; }');
    assert.strictEqual(fn('int f(uint8_t b) { uint64_t p = (uint64_t)b; return (int)(100 / p); }'),
      'int f(uint8_t b) { uint32_t p = b; return (int)(100 / p); }');
  });

  it('keeps a local that holds more than a dword or is read as 64 bits', () => {
    for (const text of [
      // A sign extension.
      'uint64_t f(int s, uint32_t a) { uint64_t q; q = (uint64_t)s; return a * q; }',
      // Read whole.
      'uint64_t f(uint32_t a) { uint64_t p; p = (uint64_t)a; g(p); return p / 3; }',
      'uint64_t f(uint32_t a) { uint64_t p; p = (uint64_t)a; return p + 1; }',
      // A 64-bit definition, a compound assignment, the address taken.
      'uint32_t f(uint32_t a, uint64_t w) { uint64_t p; p = (uint64_t)a; p = w; return (uint32_t)(p / 3); }',
      'uint32_t f(uint32_t a) { uint64_t p; p = (uint64_t)a; p += 1; return (uint32_t)(p / 3); }',
      'uint32_t f(uint32_t a) { uint64_t p; p = (uint64_t)a; h(&p); return (uint32_t)(p / 3); }',
      // Declared twice.
      'uint32_t f(uint32_t a) { { uint64_t p; p = (uint64_t)a; } uint64_t p; p = (uint64_t)a; return (uint32_t)(p / 3); }',
      // A parameter.
      'uint32_t f(uint64_t p, uint32_t a) { p = (uint64_t)a; return (uint32_t)(p / 3); }',
    ]) {
      assert.ok(!/uint32_t p\b/.test(fn(text).replace(/^[^{]*/, '')), fn(text));
    }
  });

  it('has the value of what it replaces', { skip: !hasNativeGpp() }, () => {
    const fns = [
      'uint32_t z0(uint32_t i) { uint64_t d; d = (uint64_t)i; return (uint32_t)(0x10000 / d); }',
      'uint32_t z1(uint32_t v, uint32_t r) { uint64_t m; uint64_t t; m = (uint64_t)(v % r); v = (uint32_t)m; t = (uint64_t)r; if (!(uint32_t)m) return v; r = (uint32_t)(t % m); return (int)(t / m) * v + r; }',
      'uint64_t z2(uint32_t b, uint32_t a) { uint64_t p; uint64_t c = 0x123456789ULL; p = (uint64_t)b; c = a * p + c; return a * p + (uint64_t)(uint32_t)c; }',
      'uint32_t z3(uint32_t b, uint32_t a) { uint64_t p = (uint64_t)(uint8_t)b; if (!(uint8_t)p) return 0; return (uint32_t)(a % p) + (uint32_t)p; }',
    ];
    const folded = fns.map(fn);
    folded.forEach((f, i) => assert.ok(/uint32_t (d|m|p);|uint32_t p =/.test(f), f));
    const U = '0u, 1u, 2u, 3u, 7u, 100u, 0xffffu, 0x10000u, 0x10001u, 0x7fffffffu, 0x80000000u, 0xfffffffeu, 0xffffffffu, 123456789u';
    let src = '#include <stdint.h>\n#include <stdio.h>\nstatic int failures = 0;\n';
    fns.forEach((f, i) => { src += `static ${f.replace(` z${i}(`, ` a${i}(`)}\nstatic ${folded[i].replace(` z${i}(`, ` b${i}(`)}\n`; });
    src += `int main(void) { uint32_t v[] = { ${U} }; unsigned n = sizeof v / sizeof v[0];\n`
      + '  for (unsigned i = 0; i < n; i++) { if (v[i] && a0(v[i]) != b0(v[i])) { printf("z0\\n"); failures++; }\n'
      + '    for (unsigned j = 0; j < n; j++) {\n'
      + '      if (v[j] && a1(v[i], v[j]) != b1(v[i], v[j])) { printf("z1\\n"); failures++; }\n'
      + '      if (a2(v[i], v[j]) != b2(v[i], v[j])) { printf("z2\\n"); failures++; }\n'
      + '      if (a3(v[i], v[j]) != b3(v[i], v[j])) { printf("z3\\n"); failures++; } } }\n'
      + '  return failures ? 1 : 0; }\n';
    compileAndRun(src);
  });
});

function compileAndRun(src: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'arith-nonneg-'));
  writeFileSync(join(dir, 'check.c'), src);
  try {
    const exe = exePath(join(dir, 'check'));
    const cc = compileTo(join(dir, 'check.c'), exe, ['-O1', '-w', '-fwrapv']);
    assert.strictEqual(cc.status, 0, String(cc.error ?? cc.stderr));
    const res = runExe(exe);
    assert.strictEqual(res.stdout, '');
    assert.strictEqual(res.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each case's statement and its fold compiled side by side and compared over the value sets. */
function nativeCheck(cases: Array<{ decls: string; body: string; values: string[]; skip?: string }>): void {
  const VALUES: Record<string, string> = {
    B: '0, 1, 2, 3, 5, 0x7f, 0x80, 0xfe, 0xff',
    W: '0, 1, 2, 0x7fff, 0x8000, 0xfffe, 0xffff',
    U: '0u, 1u, 2u, 0x1f00u, 0x2000u, 0x20u, 0xffu, 0x7fffffffu, 0x80000000u, 0xffffffffu, 123456789u',
    S: '0, 1, -1, 2, -2, 3, -3, 0x1f00, 0x20, -0x20, 0x7fffffff, (int)0x80000000, -123456789',
  };
  let src = '#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\nstatic int failures = 0;\n';
  let main = 'int main(void) {\n';
  cases.forEach((c, i) => {
    const folded = run(c.body, c.decls);
    assert.notStrictEqual(folded, c.body, `case ${i} did not fold: ${c.body}`);
    const params = c.decls.split(',').map(s => s.trim());
    const [resT] = params.pop()!.split(' ');
    const args = params.map(p => p.split(' '));
    const sig = args.map(([t, n]) => `${t} ${n}`).join(', ');
    src += `static ${resT} a${i}(${sig}) { ${resT} r; ${c.body} return r; }\n`;
    src += `static ${resT} b${i}(${sig}) { ${resT} r; ${folded} return r; }\n`;
    let loop = '';
    let close = '';
    args.forEach(([t, n], k) => {
      loop += `{ ${t} v${k}[] = { ${VALUES[c.values[k]]} }; for (unsigned i${k} = 0; i${k} < sizeof v${k} / sizeof v${k}[0]; i${k}++) { ${t} ${n} = v${k}[i${k}]; `;
      close += '} } ';
    });
    const names = args.map(([, n]) => n).join(', ');
    main += `  ${loop}${c.skip ? `if (${c.skip}) continue; ` : ''}{ ${resT} ra = a${i}(${names}), rb = b${i}(${names}); if (memcmp(&ra, &rb, sizeof ra)) { printf("case ${i}\\n"); failures++; } } ${close}\n`;
  });
  compileAndRun(src + main + '  return failures ? 1 : 0;\n}\n');
}

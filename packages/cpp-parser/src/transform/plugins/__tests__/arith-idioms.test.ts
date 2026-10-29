/**
 * Tests for the arithmetic-idiom folds.
 *
 * Two layers: the rewrites the pass makes (and the ones it must refuse), and a
 * value check that compiles each original/folded pair with the host C compiler
 * and compares them over edge values - INT_MIN, -1, 0, wrap-around, 2^32-1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
describe('arith-idioms values', () => {
  // The first toolchain that can build and link a program here.
  const cc = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'arith-idioms-cc-'));
    writeFileSync(join(dir, 't.c'), 'int main(void) { return 0; }\n');
    for (const argv of [['cc'], ['zig', 'cc'], ['clang'], ['gcc']]) {
      try {
        execFileSync(argv[0], [...argv.slice(1), '-o', join(dir, 't'), join(dir, 't.c')], { stdio: 'ignore' });
        execFileSync(join(dir, 't'), { stdio: 'ignore' });
        return argv;
      } catch { /* the next one */ }
    }
    return null;
  })();

  it('every fold has the value of what it replaces', { skip: !cc ? 'no C compiler' : false }, () => {
    const cases: Array<{ decls: string; body: string; values: string }> = [
      { decls: 'uint32_t u, uint32_t r', body: 'r = u + (int)(u / 0x23) * -0x23;', values: 'U' },
      { decls: 'uint32_t u, uint32_t r', body: 'r = u - u / 7 * 7;', values: 'U' },
      { decls: 'int n, int r', body: 'r = n - n / 3 * 3;', values: 'S' },
      { decls: 'int n, int r', body: 'r = n + n / 10 * -10;', values: 'S' },
      { decls: 'uint32_t u, int r', body: 'r = u != (int)(u / 10) * 10;', values: 'U' },
      { decls: 'int n, int r', body: 'r = n == n / 4 * 4;', values: 'S' },
      { decls: 'int n, int r', body: 'r = (int)(n + (n >> 0x1f & 3U)) >> 2;', values: 'S' },
      { decls: 'int n, int r', body: 'r = n + (n >> 0x1f & 1) >> 1;', values: 'S' },
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
    ];
    const VALUES: Record<string, string> = {
      U: '0u, 1u, 2u, 3u, 6u, 7u, 9u, 10u, 34u, 35u, 36u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xfffffffeu, 0xffffffffu, 123456789u',
      S: '0, 1, -1, 2, -2, 3, -3, 4, -4, 7, -7, 255, -255, 256, -256, 65535, -65535, 65536, -65536, 0x7fffffff, (int)0x80000000, (int)0x80000001, -123456789',
      Q: '0, 1, -1, 99, -99, 100, -100, 101, -101, 0x7fffffffLL, -0x80000000LL, 0xffffffffLL, 0x100000000LL, -0x100000001LL, 0x7fffffffffffffffLL, (int64_t)0x8000000000000000ULL, 1234567890123LL',
    };
    let src = '#include <stdint.h>\n#include <stdio.h>\n#include <string.h>\n'
      + 'static inline int64_t __alldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) / (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }\n'
      + 'static inline int64_t __allmul(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (int64_t)((lo1 | ((uint64_t)hi1 << 32)) * (lo2 | ((uint64_t)hi2 << 32))); }\n'
      + 'static inline int64_t __allrem(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) % (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }\n'
      + 'static inline uint64_t __aulldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) / (lo2 | ((uint64_t)hi2 << 32)); }\n'
      + 'static inline uint64_t __aullrem(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) % (lo2 | ((uint64_t)hi2 << 32)); }\n'
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
    execFileSync(cc![0], [...cc!.slice(1), '-O0', '-w', '-fwrapv', '-o', join(dir, 'check'), join(dir, 'check.c')]);
    const out = execFileSync(join(dir, 'check'), { encoding: 'utf8' });
    assert.strictEqual(out, '');
  });
});

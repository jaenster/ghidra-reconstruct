import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, TranslationUnit } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(source: string, tag: string, tables?: object): { out: string; site: Vc8FormSite } {
  const form = parseVc8Form(tag);
  assert.ok(form, `parses ${tag}`);
  const sites: Vc8FormSite[] = [];
  const tu = applyVc8Forms(parse(source) as TranslationUnit, [{ form, tag }], s => sites.push(s), tables as never);
  return { out: flat(emit(tu as AnyNode)), site: sites[0]! };
}

function refuses(source: string, tag: string, tables?: object): void {
  const { out, site } = run(source, tag, tables);
  assert.strictEqual(site.applied, false, `${tag} applied: ${out}`);
  assert.strictEqual(out, flat(emit(parse(source) as AnyNode)));
}

const u32 = (v: bigint) => BigInt.asUintN(32, v);
const s32 = (v: bigint) => BigInt.asIntN(32, v);

describe('vc8-form range: Rule 4 of Redivivus #241', () => {
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('range(2<iVar1-1U)'), { op: 'range', cond: '2<iVar1-1U', index: 0 });
    assert.deepStrictEqual(parseVc8Form('range(2<iVar1-1U,2)'), { op: 'range', cond: '2<iVar1-1U', index: 2 });
    assert.strictEqual(parseVc8Form('range()'), undefined);
    assert.strictEqual(parseVc8Form('range(a,@b)'), undefined);
  });

  // Unreferenced_004e41e0: the original's `add eax, -1` is the range test's.
  it('writes the lowered unsigned compare as the range test it is', () => {
    const { out, site } = run('int f() { int32_t iVar1 = g(); return (uint32_t)(2 < iVar1 - 1U); }', 'range(2 < iVar1 - 1U)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f() { int32_t iVar1 = g(); return (uint32_t)(iVar1 < 1 || iVar1 > 3); }');
  });

  it('writes the inside for <= and <, and reads a cast difference as unsigned', () => {
    let r = run('int f(int x) { if (x - 5U <= 10) return 1; return 0; }', 'range(x - 5U <= 10)');
    assert.ok(r.site.applied, r.site.why);
    assert.strictEqual(r.out, 'int f(int x) { if (x >= 5 && x <= 15) return 1; return 0; }');
    r = run('int f(int x) { if ((uint32_t)(x - 5) < 10) return 1; return 0; }', 'range((uint32_t)(x - 5) < 10)');
    assert.ok(r.site.applied, r.site.why);
    assert.strictEqual(r.out, 'int f(int x) { if (x >= 5 && x <= 14) return 1; return 0; }');
    r = run('int f(uint32_t x) { if (x - 5 >= 10) return 1; return 0; }', 'range(x - 5 >= 10)');
    assert.ok(r.site.applied, r.site.why);
    assert.strictEqual(r.out, 'int f(uint32_t x) { if (x < 5 || x > 14) return 1; return 0; }');
  });

  it('is value-preserving at the edges of the 32-bit range', () => {
    // (unsigned)(x - L) > K  <=>  x < L || x > L + K, for signed and unsigned x.
    const L = 5n, K = 10n;
    for (const x of [-0x80000000n, -1n, 0n, 4n, 5n, 6n, 14n, 15n, 16n, 0x7fffffffn, 0x80000000n, 0xffffffffn]) {
      const lowered = u32(x - L) > K;
      const sx = s32(x), ux = u32(x);
      assert.strictEqual(lowered, sx < L || sx > L + K, `signed ${x}`);
      assert.strictEqual(lowered, ux < L || ux > L + K, `unsigned ${x}`);
    }
  });

  it('refuses a signed compare, a wrapping range, a constant compare or no local', () => {
    refuses('int f(int x) { if (x - 5 > 10) return 1; return 0; }', 'range(x - 5 > 10)');
    refuses('int f(int x) { if (x - 5U > 0x7ffffffe) return 1; return 0; }', 'range(x - 5U > 0x7ffffffe)');
    refuses('int f(int x) { if (x - 5U < 0) return 1; return 0; }', 'range(x - 5U < 0)');
    refuses('int f(S *p) { if (p->n - 5U > 2) return 1; return 0; }', 'range(p->n - 5U > 2)');
    refuses('int f(short x) { if (x - 5U > 2) return 1; return 0; }', 'range(x - 5U > 2)');
  });
});

describe('vc8-form castout: GetActNoFromLevelNumber of Redivivus #241', () => {
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('castout((char)i - ACT_II)'), { op: 'castout', expr: '(char)i - ACT_II', index: 0 });
  });

  // GetActNoFromLevelNumber 006427f0: `add eax, -1` in the int, narrowed on return.
  it('moves the narrowing to the returned value', () => {
    const src = 'eAct f(int eLevel) { int i = 1; do { if (eLevel < t[i]) { return (char)i - ACT_II; } i++; } while (i <= 5); return ACT_I; }';
    const { out, site } = run(src, 'castout((char)i - ACT_II)', { typedefTargets: { eAct: 'uint8_t' } });
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'eAct f(int eLevel) { int i = 1; do { if (eLevel < t[i]) { return (eAct)(i - ACT_II); } i++; } while (i <= 5); return ACT_I; }');
  });

  it('writes a store into a narrow local and a sum with the cast on the right', () => {
    const { out, site } = run('void f(int i) { uint8_t b; b = 3 + (uint8_t)i; use(b); }', 'castout(3 + (uint8_t)i)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'void f(int i) { uint8_t b; b = (uint8_t)(3 + i); use(b); }');
  });

  it('is value-preserving: the low byte of a difference depends on the low bytes only', () => {
    for (const i of [-129n, -128n, -1n, 0n, 1n, 127n, 128n, 255n, 256n, 0x12345n]) {
      const before = BigInt.asUintN(8, BigInt.asIntN(8, i) - 1n);
      const after = BigInt.asUintN(8, i - 1n);
      assert.strictEqual(before, after, `${i}`);
    }
  });

  it('refuses a wider target, a pointer operand, a call operand or a value used otherwise', () => {
    refuses('int f(int i) { return (char)i - 1; }', 'castout((char)i - 1)');
    refuses('uint8_t f(char *p) { return (char)p - 1; }', 'castout((char)p - 1)');
    refuses('uint8_t f(int i) { return (char)i - g(); }', 'castout((char)i - g())');
    refuses('uint8_t f(int i) { return h((char)i - 1); }', 'castout((char)i - 1)');
    refuses('uint16_t f(int i) { return (char)i - 1; }', 'castout((char)i - 1)');
  });
});

describe('vc8-form signbit: Rule 1 dword case of Redivivus #241', () => {
  it('parses', () => {
    assert.deepStrictEqual(parseVc8Form('signbit((int)nCellFlags < 0)'), { op: 'signbit', cond: '(int)nCellFlags < 0', index: 0 });
  });

  // DRLGLOGIC_PopulateGridCoordIndices 0066c580: `test edx, edx; jns`.
  it('writes a dword sign test of a flags word as bit 31', () => {
    const src = 'void f(D *p) { uint32_t nCellFlags = g(); if ((nCellFlags & 0x1e0ff00) == 0x1e00000 || (int)nCellFlags < 0) { p->x |= 1; } }';
    const { out, site } = run(src, 'signbit((int)nCellFlags < 0)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'void f(D* p) { uint32_t nCellFlags = g(); if ((nCellFlags & 0x1e0ff00) == 0x1e00000 || nCellFlags & 0x80000000) { p->x |= 1; } }');
  });

  it('writes the negation for >= 0 of an int', () => {
    const { out, site } = run('int f(int n) { while (n >= 0) { n = g(n); } return n; }', 'signbit(n >= 0)');
    assert.ok(site.applied, site.why);
    assert.strictEqual(out, 'int f(int n) { while (!(n & 0x80000000)) { n = g(n); } return n; }');
  });

  it('is value-preserving: bit 31 set is a negative int32', () => {
    for (const x of [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 0x9e00000]) {
      assert.strictEqual((x | 0) < 0, ((x >>> 0) & 0x80000000) !== 0);
    }
  });

  it('refuses a value use, a narrow or wide operand, an unsigned compare or a non-local', () => {
    refuses('int f(int n) { return n < 0; }', 'signbit(n < 0)');
    refuses('int f(int n) { int b = n < 0; return b; }', 'signbit(n < 0)');
    refuses('void f(short n) { if (n < 0) g(); }', 'signbit(n < 0)');
    refuses('void f(long long n) { if (n < 0) g(); }', 'signbit(n < 0)');
    refuses('void f(S *p) { if (p->n < 0) g(); }', 'signbit(p->n < 0)');
    refuses('void f(uint32_t n) { if ((uint32_t)n < 0) g(); }', 'signbit((uint32_t)n < 0)');
    refuses('void f(int a, int b) { if (a - b < 0) g(); }', 'signbit(a - b < 0)');
  });
});

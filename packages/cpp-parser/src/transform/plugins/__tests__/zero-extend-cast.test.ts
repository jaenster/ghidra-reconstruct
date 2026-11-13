/**
 * zero-extend-site / zero-extend-cast: a byte/word mask the original computed with a MOVZX
 * becomes the cast, where value and type are kept. Each case is checked by EXECUTION over
 * an input grid: the masked original against the rewrite, with every result widened to
 * 64 bits so a changed type (int against unsigned int) shows as a changed value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, ASTNode, BinaryExpr } from '../../../ast/nodes.js';
import {
  createZeroExtendCastTransformer, createZeroExtendSiteTransformer, type ZeroExtendMaskSite,
} from '../builtins/zero-extend-cast.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

/** Every binary `&` of the source, in text order, as the facts script would list them. */
function factsFor(code: string, mnemonic: (ord: number) => string = () => 'MOVZX') {
  const ands: BinaryExpr[] = [];
  const visit = (n: ASTNode) => {
    if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '&') ands.push(n as BinaryExpr);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(x => x && typeof x === 'object' && typeof x.kind === 'string' && visit(x));
      else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') visit(v as ASTNode);
    }
  };
  visit(parse(code) as ASTNode);
  ands.sort((a, b) => a.right.location!.start!.offset! - b.right.location!.start!.offset!);
  const sites: ZeroExtendMaskSite[] = [];
  ands.forEach((a, ord) => {
    const r = a.right as unknown as { kind: string; value?: bigint };
    if (r.kind === NodeKind.IntegerLiteral && (r.value === 0xffn || r.value === 0xffffn)) {
      const mn = mnemonic(ord);
      sites.push({ ord, k: Number(r.value), mnemonic: mn, width: mn === 'MOVZX' ? (r.value === 0xffn ? 1 : 2) : 0 });
    }
  });
  return { count: ands.length, sites };
}

function rewrite(code: string, mnemonic?: (ord: number) => string, count?: number) {
  const f = factsFor(code, mnemonic);
  const reasons: string[] = [];
  const tagged = createZeroExtendSiteTransformer({ count: count ?? f.count, sites: f.sites })(parse(code)) as AnyNode;
  const out = createZeroExtendCastTransformer({
    onSite: s => reasons.push(s.rewritten ? s.reason : `kept:${s.reason}`),
  })(tagged) as AnyNode;
  return { code: emit(out).trim(), reasons };
}

const GRID = '{0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xfffe, 0xffff, 0x10000, 0x12345, 0x7fffffff, (int)0x80000000, -1, -2, -0x100, -0x8000, -0x10000, 1000, -1000}';

/** Run ref::f (masked) and low::f (rewritten) over the (a, b) grid; mismatches. */
function run(src: string, low: string): string {
  const prelude = [`namespace ref {\n${src}\n}`, `namespace low {\n${low}\n}`].join('\n');
  const body = [
    `const int V[] = ${GRID}; long diff = 0;`,
    'for (int a : V) for (int b : V) {',
    '  if (ref::f(a, b) != low::f(a, b)) diff++;',
    '}',
    'printf("%ld\\n", diff);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

const CASES: { name: string; src: string; casts: number; expect?: RegExp }[] = [
  {
    name: 'packed coordinates indexing a table (DRLGPATH_GetDirectionLookupFromPacked)',
    src: `
    int64_t f(int a, int b) {
      static const int t[0x80000] = {0};
      uint32_t nSrcPacked = (uint32_t)a, nDstPacked = (uint32_t)b;
      uint32_t i = ((nDstPacked >> 0x10) - (nSrcPacked >> 0x10)) * 3 - (nSrcPacked & 0xffff) + (nDstPacked & 0xffff);
      return (int64_t)i + t[i & 0x7ffff];
    }`,
    casts: 2,
    expect: /- \(uint16_t\)nSrcPacked \+ \(uint16_t\)nDstPacked/,
  },
  {
    name: 'an int operand: the cast has the mask\'s type everywhere',
    src: `
    int64_t f(int a, int b) {
      int n = (a & 0xff) - b;
      return (int64_t)((a & 0xffff) < b) + n + ((a & 0xff) - 300) / 7 + (int64_t)((b & 0xffff) >> 3);
    }`,
    casts: 4,
  },
  {
    name: 'an unsigned operand compared signed-sensitively keeps its unsigned type',
    src: `
    int64_t f(int a, int b) {
      uint32_t u = (uint32_t)a;
      int64_t r = 0;
      if ((u & 0xffff) < b) r += 1;
      r += (int64_t)((u & 0xff) - 1);
      r += (int64_t)(-(u & 0xff));
      return r;
    }`,
    casts: 2,
    expect: /if \(\(u & 0xffff\) < b\)\s+r \+= 1;\s+r \+= \(int64_t\)\(\(uint32_t\)\(uint8_t\)u - 1\);/,
  },
  {
    name: 'an unsigned operand in value-only positions',
    src: `
    int64_t f(int a, int b) {
      uint32_t u = (uint32_t)a, v = (uint32_t)b;
      int64_t r = 0;
      int64_t w = u & 0xffff;
      r = w;
      if (u & 0xff) r += 3;
      if ((u & 0xffff) == (uint32_t)b) r += 5;
      if ((u & 0xff) != -1) r += 7;
      r += (int64_t)(v + (u & 0xffff));
      r += (int64_t)(v - (u & 0xff)) * 2;
      r += (int64_t)((u & 0xffff) / (v | 1) + 1 > 0);
      r += 1 << (u & 0xff & 7);
      return r + (int64_t)(uint8_t)(u & 0xff);
    }`,
    casts: 9,
  },
  {
    name: 'a 64-bit operand only where the value alone is read',
    src: `
    int64_t f(int a, int b) {
      int64_t q = (int64_t)a * 0x10001;
      int64_t r = q & 0xffff;
      r += (q & 0xff) << 40;
      return r;
    }`,
    casts: 1,
  },
  {
    name: 'a U-suffixed mask of an int is unsigned, in a typed position too',
    src: `
    int64_t f(int a, int b) {
      int64_t r = (int64_t)((a & 0xffU) - 1);
      int s = a & 0xffU;
      return r + s;
    }`,
    casts: 2,
    expect: /\(int64_t\)\(\(uint32_t\)\(uint8_t\)a - 1\)/,
  },
  {
    name: 'a compound assignment into an unsigned int',
    src: `
    int64_t f(int a, int b) {
      uint32_t acc = (uint32_t)b;
      acc -= (uint32_t)a & 0xff;
      acc /= ((uint32_t)a & 0xff) | 1;
      int s = b;
      s -= (uint32_t)a & 0xffff;
      return (int64_t)acc + s;
    }`,
    casts: 3,
  },
];

describe('zero-extend-cast', () => {
  for (const c of CASES) {
    it(`${c.name}: rewrites ${c.casts}`, native, () => {
      const { code, reasons } = rewrite(c.src);
      assert.strictEqual(reasons.filter(r => !r.startsWith('kept')).length, c.casts, `${reasons.join(',')}\n${code}`);
      if (c.expect) assert.match(code, c.expect);
      assert.strictEqual(run(c.src, code), '0', code);
    });
  }

  it('an AND in the original keeps the mask', () => {
    const src = `uint32_t f(uint32_t a, uint32_t b) { return (a & 0xffff) + (b & 0xffff); }`;
    const { code } = rewrite(src, ord => (ord === 0 ? 'AND' : 'MOVZX'));
    assert.match(code, /\(a & 0xffff\) \+ \(uint16_t\)b/);
  });

  it('a MOVZX from memory (width 0) is the cast only as an index', () => {
    const src = `uint32_t f(uint32_t nBodyLocFlags, uint32_t *p) { uint32_t nBestBodyLoc = nBodyLocFlags & 0xff; G(*p & 0xffff); return nBestBodyLoc + p[*p & 0xff]; }`;
    const f = factsFor(src);
    const sites = f.sites.map(s => ({ ...s, width: 0 }));
    const reasons: string[] = [];
    const tagged = createZeroExtendSiteTransformer({ count: f.count, sites })(parse(src)) as AnyNode;
    const code = emit(createZeroExtendCastTransformer({ onSite: s => reasons.push(s.reason) })(tagged) as AnyNode);
    assert.match(code, /nBestBodyLoc = nBodyLocFlags & 0xff;/);
    assert.match(code, /G\(\*p & 0xffff\)/);
    assert.match(code, /p\[\(uint8_t\)\*p\]/);
    assert.strictEqual(reasons.filter(r => r.startsWith('a load outside an index')).length, 2, reasons.join(','));
  });

  it('an unsigned mask in a relational compare stays (HirelingFarWander: cmp al against movzx; cmp)', () => {
    const src = `int f(uint32_t nSeedLow, uint32_t n) { return ((nSeedLow & 0xff) < 0x4d) + ((nSeedLow & 0xff) * n < 3); }`;
    const { code, reasons } = rewrite(src);
    assert.match(code, /\(nSeedLow & 0xff\) < 0x4d/);
    assert.match(code, /\(uint8_t\)nSeedLow \* n < 3/);
    assert.ok(reasons.includes('kept:unsigned in a relational compare'), reasons.join(','));
  });

  it('positions that do not zip tie only a constant every fact agrees on', () => {
    const src = `uint32_t f(uint32_t a, uint32_t b) { return (a & 0xffff) + (b & 0xff) + (a & b); }`;
    // One `&` more in the body than the facts saw: 0xffff and 0xff each tie by constant.
    const mixed = rewrite(src, ord => (ord === 1 ? 'AND' : 'MOVZX'), 2);
    assert.match(mixed.code, /\(uint16_t\)a \+ \(b & 0xff\)/);
  });

  it('a postfix operand keeps its parentheses', () => {
    const src = `int f(int a, int *p) { return (a & 0xff)[p]; }`;
    assert.match(rewrite(src).code, /\(\(uint8_t\)a\)\[p\]/);
  });

  it('a compound operand is parenthesised', () => {
    const src = `int f(int a, int b) { return a + b & 0xffff; }`;
    assert.match(rewrite(src).code, /\(uint16_t\)\(a \+ b\)/);
  });

  it('a shift whose mask compiles to the same MOVZX keeps the mask (DRLGOUTDOOR_ValidateSecondaryBorderCell)', () => {
    const src = `int f(uint32_t nGridFlags, int a) { return G(nGridFlags >> 0x14 & 0x3f, nGridFlags >> 8 & 0xff, nGridFlags >> 0x18 & 0xff, nGridFlags >> 0x10 & 0xffff, nGridFlags >> 0x10 & 0xff); }`;
    const { code, reasons } = rewrite(src);
    assert.match(code, /nGridFlags >> 8 & 0xff, nGridFlags >> 0x18 & 0xff, nGridFlags >> 0x10 & 0xffff, \(uint8_t\)\(nGridFlags >> 0x10\)/);
    assert.strictEqual(reasons.filter(r => r === 'value' || r === 'int').length, 1, reasons.join(','));
  });

  it('a store into a register the code merges a low part into keeps the mask (RollPrefixes)', () => {
    const src = `uint32_t f(uint32_t pRolledAffixIdx, uint32_t b) {
      uint32_t nRolledAffixMasked;
      uint32_t uVar1;
      nRolledAffixMasked = pRolledAffixIdx & 0xffff;
      uVar1 = nRolledAffixMasked;
      nRolledAffixMasked = (uint32_t)((uint32_t)nRolledAffixMasked & 0xffff0000u | (uint32_t)(uint16_t)b);
      uint32_t w = b & 0xffff;
      return nRolledAffixMasked + uVar1 + w;
    }`;
    const { code } = rewrite(src);
    assert.match(code, /nRolledAffixMasked = pRolledAffixIdx & 0xffff;/);
    assert.match(code, /uint32_t w = \(uint16_t\)b;/);
  });

  it('golden: ZLIB_Adler32Combine @0042b8e0 (three MOVZX word masks, v2056 facts)', native, () => {
    // The body as the generator emits it before this pass, `_allrem` written as the operator.
    const src = `uint32_t f(uint32_t nAdler1, uint32_t nLen2Lo, uint32_t nLen2Hi, uint32_t nAdler2) {
      if ((int)nLen2Hi <= 0 && ((int)nLen2Hi < 0 || false)) {
        return -1;
      }
      int64_t nLen2Mod = (int64_t)(((uint64_t)nLen2Hi << 32 | nLen2Lo) % 0xfff1);
      uint32_t nSum2 = (nAdler1 & 0xffff) * (int)nLen2Mod;
      uint32_t nSum1 = (nAdler1 & 0xffff) + 0xfff0 + (nAdler2 & 0xffff);
      nSum2 = nSum2 + 0xfff1 + ((nAdler1 >> 0x10) + nSum2 / 0xfff1 * -0xfff1 + (nAdler2 >> 0x10) - (int)nLen2Mod);
      uint32_t nSum1Mod = nSum1;
      if (nSum1 >= 0xfff1) {
        nSum1Mod = nSum1 - 0xfff1;
        if (nSum1Mod >= 0xfff1) nSum1Mod = nSum1 - 0x1ffe2;
      }
      if (nSum2 >= 0x1ffe2) nSum2 -= 0x1ffe2;
      if (nSum2 >= 0xfff1) nSum2 -= 0xfff1;
      return nSum2 << 0x10 | nSum1Mod;
    }`;
    const sites: ZeroExtendMaskSite[] = [0, 1, 2].map(ord => ({ ord, k: 0xffff, mnemonic: 'MOVZX', width: 2 }));
    const tagged = createZeroExtendSiteTransformer({ count: 3, sites })(parse(src)) as AnyNode;
    const code = emit(createZeroExtendCastTransformer({})(tagged) as AnyNode).trim();
    assert.match(code, /uint32_t nSum2 = \(uint32_t\)\(uint16_t\)nAdler1 \* \(int\)nLen2Mod;/);
    assert.match(code, /uint32_t nSum1 = \(uint32_t\)\(uint16_t\)nAdler1 \+ 0xfff0 \+ \(uint16_t\)nAdler2;/);
    const prelude = `namespace ref {\n${src}\n}\nnamespace low {\n${code}\n}`;
    const body = [
      'const uint32_t V[] = {0, 1, 0xfff0, 0xfff1, 0xffff, 0x10000, 0x12345678, 0x7fffffff, 0x80000000, 0xfffeffff, 0xffffffff};',
      'long diff = 0;',
      'for (uint32_t a : V) for (uint32_t b : V) for (uint32_t c : V) for (uint32_t d : V)',
      '  if (ref::f(a, b, c & 1, d) != low::f(a, b, c & 1, d)) diff++;',
      'printf("%ld\\n", diff);',
    ].join('\n');
    assert.strictEqual(compileAndRun(prelude, body).trim(), '0', code);
  });

  it('no facts, no change', () => {
    const src = `uint32_t f(uint32_t a) { return a & 0xffff; }`;
    const out = createZeroExtendCastTransformer({})(createZeroExtendSiteTransformer({})(parse(src)) as AnyNode) as AnyNode;
    assert.match(emit(out), /a & 0xffff/);
  });
});

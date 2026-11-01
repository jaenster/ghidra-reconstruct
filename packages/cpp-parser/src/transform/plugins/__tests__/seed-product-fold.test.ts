/**
 * seed-product-fold: a seed step printed as a named product plus the high half becomes
 * D2_SEED_NEXT(seed), only where the product's value is the step's and the halves are one
 * seed. The positive shapes are compiled as printed and as rewritten and run over the
 * same seeds; the seeds and the results must agree.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { seedProductFoldPlugin } from '../builtins/seed-product-fold.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

function rewrite(code: string): string {
  return emit(seedProductFoldPlugin.createTransformer({})(parse(code)) as AnyNode).trim();
}

const PRELUDE = [
  // The tree's seed: a 64-bit value with its low dword first.
  'struct D2SeedStrc { D2SeedStrc() = default; D2SeedStrc(uint64_t v) { memcpy(this, &v, 8); } uint32_t nSeedLow; uint32_t nSeedHigh; };',
  'struct Unit { int nPad[8]; D2SeedStrc sSeed; int nMode; };',
  '#define D2_SEED_NEXT(seed) ((D2SeedStrc)((uint64_t)(uint32_t)(seed).nSeedLow * 0x6ac690c5u + (uint64_t)(uint32_t)(seed).nSeedHigh))',
].join('\n');

/** AITHINK_Fn1_ZakarumPriest 005f02c0: low through the pointer, high through the unit, a dead high-half store. */
const PRIEST = `int f(Unit *pUnit, int bFlag) {
  uint64_t lSeedMul;
  D2SeedStrc sSeedRoll;
  D2SeedStrc *pSeed;
  pSeed = &pUnit->sSeed;
  if (bFlag) {
    lSeedMul = (uint64_t)pSeed->nSeedLow * 0x6ac690c5;
    bFlag = (int)((uint64_t)lSeedMul >> 0x20);
    sSeedRoll = (D2SeedStrc)(lSeedMul + (uint64_t)pUnit->sSeed.nSeedHigh);
    *pSeed = sSeedRoll;
    return (int)(sSeedRoll.nSeedLow % 100);
  }
  return -1;
}`;

/** The same step through the unit on both halves. */
const SAME = `int f(Unit *pUnit) {
  uint64_t lVar1;
  D2SeedStrc DVar2;
  lVar1 = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5;
  DVar2 = (D2SeedStrc)(lVar1 + (uint64_t)pUnit->sSeed.nSeedHigh);
  pUnit->sSeed = DVar2;
  return (int)DVar2.nSeedLow;
}`;

describe('seed-product-fold: the rewrites', () => {
  it('the low half\'s seed pointer, high read through the unit, dead high store dropped', () => {
    const out = rewrite(PRIEST);
    assert.match(out, /sSeedRoll = D2_SEED_NEXT\(\*pSeed\);/, out);
    assert.doesNotMatch(out, /lSeedMul/, out);
    assert.doesNotMatch(out, /bFlag = /, out);
  });
  it('one lvalue on both halves', () => {
    const out = rewrite(SAME);
    assert.match(out, /DVar2 = D2_SEED_NEXT\(pUnit->sSeed\);/, out);
    assert.doesNotMatch(out, /lVar1/, out);
  });
});

describe('seed-product-fold: compiled, the same seeds and results', () => {
  const run = (code: string, call: string) => {
    const lowered = rewrite(code);
    const prelude = [PRELUDE, `namespace ref { ${code} }`, `namespace low { ${lowered} }`].join('\n');
    const body = [
      'int bad = 0;',
      'for (uint32_t s = 1; s < 200; s++) {',
      '  Unit a; Unit b; memset(&a, 0, sizeof a); memset(&b, 0, sizeof b);',
      '  a.sSeed.nSeedLow = b.sSeed.nSeedLow = s * 2654435761u; a.sSeed.nSeedHigh = b.sSeed.nSeedHigh = 0x29a + s;',
      '  int ra = ref::' + call.replace('U', '&a') + '; int rb = low::' + call.replace('U', '&b') + ';',
      '  if (ra != rb || memcmp(&a, &b, sizeof a) != 0) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n');
    return { out: compileAndRun(prelude, body).trim(), lowered };
  };
  it('PRIEST', native, () => {
    const { out, lowered } = run(PRIEST, 'f(U, (int)(s & 1))');
    assert.strictEqual(out, '0', lowered);
  });
  it('SAME', native, () => {
    const { out, lowered } = run(SAME, 'f(U)');
    assert.strictEqual(out, '0', lowered);
  });
});

describe('seed-product-fold: what is left alone', () => {
  it('a high-half store that is read later stays, and so does the product', () => {
    const code = PRIEST.replace('return (int)(sSeedRoll.nSeedLow % 100);', 'return (int)(sSeedRoll.nSeedLow % 100) + bFlag;');
    assert.match(rewrite(code), /lSeedMul = /);
  });
  it('a call between the product and the step may change the seed', () => {
    const code = SAME.replace('  DVar2 = (D2SeedStrc)', '  touch(pUnit);\n  DVar2 = (D2SeedStrc)');
    assert.match(rewrite(code), /lVar1 = /);
  });
  it('a pointer that is not the unit\'s seed is another seed', () => {
    const code = PRIEST.replace('pSeed = &pUnit->sSeed;', 'pSeed = pOther;');
    assert.match(rewrite(code), /lSeedMul = /);
  });
  it('a step in a loop the product is outside of', () => {
    const code = `int f(Unit *pUnit, int n) {
  uint64_t lVar1;
  D2SeedStrc DVar2;
  lVar1 = (uint64_t)pUnit->sSeed.nSeedLow * 0x6ac690c5;
  do {
    DVar2 = (D2SeedStrc)(lVar1 + (uint64_t)pUnit->sSeed.nSeedHigh);
    n--;
  } while (n);
  return (int)DVar2.nSeedLow;
}`;
    assert.match(rewrite(code), /lVar1 = /);
  });
  it('a product also read elsewhere stays', () => {
    const code = SAME.replace('return (int)DVar2.nSeedLow;', 'return (int)DVar2.nSeedLow + (int)lVar1;');
    assert.match(rewrite(code), /lVar1 = /);
  });
});

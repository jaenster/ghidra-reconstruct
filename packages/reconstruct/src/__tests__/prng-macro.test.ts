/**
 * Tests for replacePrngWithMacro — D2 PRNG LCG expression → D2_SEED_NEXT macro
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { replacePrngWithMacro } from '../codegen/impl.js';

describe('replacePrngWithMacro', () => {
  it('replaces member access via -> (pRoomEx->sSeed)', () => {
    const input =
      'sSeed = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pRoomEx->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pRoomEx->sSeed.nSeedHigh);';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(result, 'sSeed = D2_SEED_NEXT(pRoomEx->sSeed);');
  });

  it('replaces member access via -> (pUnit->sSeed)', () => {
    const input =
      'D2SeedStrc DVar1 = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pUnit->sSeed.nSeedHigh);';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(
      result,
      'D2SeedStrc DVar1 = D2_SEED_NEXT(pUnit->sSeed);',
    );
  });

  it('replaces this-> access with D2_SEED_NEXT(*this)', () => {
    const input =
      'D2SeedStrc DVar1 = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)this->nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)this->nSeedHigh);';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(
      result,
      'D2SeedStrc DVar1 = D2_SEED_NEXT(*this);',
    );
  });

  it('replaces value form with D2_SEED_NEXT_VAL', () => {
    const input =
      'DVar1 = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ ((uint64_t)DVar1 & -1) * 0x6ac690c5 + ((uint64_t)DVar1 >> 0x20));';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(result, 'DVar1 = D2_SEED_NEXT_VAL(DVar1);');
  });

  it('handles mixed form (local low, member high) via nSeedHigh fallback', () => {
    const input =
      'sSeed = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)nRandom * 0x6ac690c5 + (uint64_t)(uint32_t)pRoomEx->sSeed.nSeedHigh);';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(result, 'sSeed = D2_SEED_NEXT(pRoomEx->sSeed);');
  });

  it('handles pSeed-> direct pointer access', () => {
    const input =
      'DVar1 = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pSeed->nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pSeed->nSeedHigh);';
    const result = replacePrngWithMacro(input);
    // Text fallback extracts "pSeed" — the AST transformer handles *pSeed correctly
    assert.strictEqual(result, 'DVar1 = D2_SEED_NEXT(pSeed);');
  });

  it('does not touch non-PRNG D2SeedStrc casts', () => {
    const input = 'x = (D2SeedStrc)(someOtherExpression + 42);';
    const result = replacePrngWithMacro(input);
    assert.strictEqual(result, input);
  });

  it('handles multiple PRNG expressions on separate lines', () => {
    const input = [
      'a = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pA->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pA->sSeed.nSeedHigh);',
      'b = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pB->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pB->sSeed.nSeedHigh);',
    ].join('\n');
    const result = replacePrngWithMacro(input);
    assert.ok(result.includes('D2_SEED_NEXT(pA->sSeed)'));
    assert.ok(result.includes('D2_SEED_NEXT(pB->sSeed)'));
  });

  it('preserves surrounding code', () => {
    const input =
      'if (x) { DVar1 = (D2SeedStrc)(/* PRNG: Diablo 2 PRNG (LCG multiplier) */ (uint64_t)(uint32_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pUnit->sSeed.nSeedHigh); foo(); }';
    const result = replacePrngWithMacro(input);
    assert.ok(result.startsWith('if (x) { DVar1 = D2_SEED_NEXT(pUnit->sSeed);'));
    assert.ok(result.endsWith('foo(); }'));
  });
});

/**
 * Tests for PRNG Pattern Transform Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { prngTransformPlugin } from '../builtins/prng-transform.js';

describe('prngTransformPlugin', () => {
  function transformCode(code: string, replaceMacro = true): string {
    const ast = parse(code);
    const transformer = prngTransformPlugin.createTransformer({ replaceMacro });
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  describe('legacy comment mode (replaceMacro=false)', () => {
    it('should add PRNG comment', () => {
      const input = `void foo() { D2SeedStrc x = (D2SeedStrc)(seed * 0x6ac690c5 + high); }`;
      const output = transformCode(input, false);
      assert.ok(output.includes('PRNG'), `Expected PRNG comment in: ${output}`);
    });

    it('should not add comment for non-D2SeedStrc cast', () => {
      const input = `void foo() { uint64_t x = (uint64_t)(seed * 0x6ac690c5 + high); }`;
      const output = transformCode(input, false);
      assert.ok(!output.includes('PRNG'), `Should not annotate non-D2SeedStrc: ${output}`);
    });
  });

  describe('D2_SEED_NEXT macro replacement', () => {
    it('replaces pUnit->sSeed member access', () => {
      const input = `void f() {
        D2SeedStrc x = (D2SeedStrc)((uint64_t)(uint32_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pUnit->sSeed.nSeedHigh);
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT(pUnit->sSeed)'),
        `Expected D2_SEED_NEXT(pUnit->sSeed) in: ${output}`);
      assert.ok(!output.includes('0x6ac690c5'), `Should not contain raw multiplier: ${output}`);
    });

    it('replaces this->nSeedLow with D2_SEED_NEXT(*this)', () => {
      const input = `void f() {
        D2SeedStrc x = (D2SeedStrc)((uint64_t)(uint32_t)this->nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)this->nSeedHigh);
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT(*this)'),
        `Expected D2_SEED_NEXT(*this) in: ${output}`);
    });

    it('replaces pSeed->nSeedLow with D2_SEED_NEXT(*pSeed)', () => {
      const input = `void f() {
        D2SeedStrc x = (D2SeedStrc)((uint64_t)(uint32_t)pSeed->nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pSeed->nSeedHigh);
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT(*pSeed)'),
        `Expected D2_SEED_NEXT(*pSeed) in: ${output}`);
    });

    it('replaces value form with D2_SEED_NEXT_VAL', () => {
      const input = `void f() {
        D2SeedStrc x = (D2SeedStrc)(((uint64_t)DVar1 & -1) * 0x6ac690c5 + ((uint64_t)DVar1 >> 0x20));
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT_VAL(DVar1)'),
        `Expected D2_SEED_NEXT_VAL(DVar1) in: ${output}`);
    });

    it('handles mixed form (local low, member high)', () => {
      const input = `void f() {
        D2SeedStrc x = (D2SeedStrc)((uint64_t)nRandom * 0x6ac690c5 + (uint64_t)(uint32_t)pRoomEx->sSeed.nSeedHigh);
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT(pRoomEx->sSeed)'),
        `Expected D2_SEED_NEXT(pRoomEx->sSeed) in: ${output}`);
    });

    it('does not replace non-D2SeedStrc casts with 0x6ac690c5', () => {
      const input = `void f() { uint64_t x = (uint64_t)(a * 0x6ac690c5 + b); }`;
      const output = transformCode(input);
      assert.ok(!output.includes('D2_SEED_NEXT'), `Should not replace: ${output}`);
    });

    it('preserves surrounding code', () => {
      const input = `void f() {
        int before = 1;
        D2SeedStrc x = (D2SeedStrc)((uint64_t)(uint32_t)pUnit->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pUnit->sSeed.nSeedHigh);
        int after = 2;
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('before = 1'), `Missing before: ${output}`);
      assert.ok(output.includes('after = 2'), `Missing after: ${output}`);
      assert.ok(output.includes('D2_SEED_NEXT'), `Missing macro: ${output}`);
    });

    it('handles pDVar1->sSeed with different variable names', () => {
      const input = `void f() {
        D2SeedStrc DVar3 = (D2SeedStrc)((uint64_t)(uint32_t)pDVar1->sSeed.nSeedLow * 0x6ac690c5 + (uint64_t)(uint32_t)pDVar1->sSeed.nSeedHigh);
      }`;
      const output = transformCode(input);
      assert.ok(output.includes('D2_SEED_NEXT(pDVar1->sSeed)'),
        `Expected D2_SEED_NEXT(pDVar1->sSeed) in: ${output}`);
    });
  });

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      assert.strictEqual(prngTransformPlugin.id, 'prng-transform');
      assert.strictEqual(prngTransformPlugin.defaultEnabled, true);
      assert.strictEqual(prngTransformPlugin.priority, 80);
      assert.ok(prngTransformPlugin.tags?.includes('game'));
      assert.ok(prngTransformPlugin.tags?.includes('diablo'));
    });
  });
});

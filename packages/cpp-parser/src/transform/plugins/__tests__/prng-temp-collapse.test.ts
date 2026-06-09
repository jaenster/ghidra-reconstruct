/**
 * Tests for PRNG Temp Variable Collapse Plugin
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { prngTempCollapsePlugin } from '../builtins/prng-temp-collapse.js';

describe('prngTempCollapsePlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = prngTempCollapsePlugin.createTransformer();
    const result = transformer(ast);
    return emit(result as AnyNode).trim();
  }

  it('collapses DeclStmt + writeback', () => {
    const input = `void f() {
      D2SeedStrc DVar1 = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = DVar1;
    }`;
    const output = transformCode(input);
    assert.ok(output.includes('pUnit->sSeed = D2_SEED_NEXT(pUnit->sSeed)'),
      `Expected collapsed form in: ${output}`);
    assert.ok(!output.includes('DVar1'), `Should not contain temp variable in: ${output}`);
  });

  it('collapses ExprStmt(assign) + writeback', () => {
    const input = `void f() {
      DVar1 = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = DVar1;
    }`;
    const output = transformCode(input);
    assert.ok(output.includes('pUnit->sSeed = D2_SEED_NEXT(pUnit->sSeed)'),
      `Expected collapsed form in: ${output}`);
    assert.ok(!output.includes('DVar1'), `Should not contain temp variable in: ${output}`);
  });

  it('preserves temp when used after writeback', () => {
    const input = `void f() {
      D2SeedStrc DVar1 = D2_SEED_NEXT(pUnit->sSeed);
      pUnit->sSeed = DVar1;
      nRandom = DVar1.nSeedLow;
    }`;
    const output = transformCode(input);
    assert.ok(output.includes('DVar1'), `Should preserve temp when used elsewhere: ${output}`);
  });

  it('no-op when no D2_SEED_NEXT call', () => {
    const input = `void f() {
      int x = someFunc();
      y = x;
    }`;
    const output = transformCode(input);
    assert.ok(output.includes('int x = someFunc()'), `Should not modify: ${output}`);
    assert.ok(output.includes('y = x'), `Should not modify: ${output}`);
  });

  it('handles D2_SEED_NEXT_VAL variant', () => {
    const input = `void f() {
      D2SeedStrc DVar2 = D2_SEED_NEXT_VAL(nSeed);
      pGame->sSeed = DVar2;
    }`;
    const output = transformCode(input);
    assert.ok(output.includes('pGame->sSeed = D2_SEED_NEXT_VAL(nSeed)'),
      `Expected collapsed form in: ${output}`);
    assert.ok(!output.includes('DVar2'), `Should not contain temp in: ${output}`);
  });

  it('has correct metadata', () => {
    assert.strictEqual(prngTempCollapsePlugin.id, 'prng-temp-collapse');
    assert.strictEqual(prngTempCollapsePlugin.priority, 85);
    assert.ok(prngTempCollapsePlugin.tags?.includes('game'));
    assert.ok(prngTempCollapsePlugin.tags?.includes('diablo'));
  });
});

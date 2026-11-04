/**
 * CLIENT_AdjustMemoryBudget (00457300) multiplies by the double at 006cccb0, 2^-20,
 * which the decompiler prints as 9.536743e-07; SOUND_UpdateAllChannels (004ba020) adds
 * the double at 006da6b0, 0.05f widened, printed 0.05. Both respelled exactly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createExactFloatConstantTransformer, significantDigits } from '../builtins/exact-float-constant.js';

const MB = { name: 'gdBytesToMegabytes', value: 2 ** -20 };
const STEP = { name: 'DOUBLE_006da6b0', value: Math.fround(0.05) };
const HALF = { name: 'FLOAT_006da690', value: 0.5 };

function run(code: string, constants: { name: string; value: number }[]) {
  const refusals: string[] = [];
  const out = emit(createExactFloatConstantTransformer({ constants, onRefusal: (r: string) => refusals.push(r) })(parse(code)) as AnyNode).trim();
  return { out, refusals };
}

describe('exact-float-constant', () => {
  it('respells 2^-20 printed with seven digits', () => {
    const { out } = run(`void f(double m) { g(m * 9.536743e-07); }`, [MB]);
    assert.ok(out.includes('m * 9.5367431640625e-7'), out);
    assert.strictEqual(Number.parseFloat('9.5367431640625e-7'), 2 ** -20);
  });

  it('respells a widened float printed with one digit, under a minus, sign kept', () => {
    const { out } = run(`void f(float x) { if (x + 0.05 < y) { y = x - 0.05; } z = -0.05; }`, [STEP, HALF]);
    assert.ok(out.includes('x + 0.05000000074505806'), out);
    assert.ok(out.includes('x - 0.05000000074505806'), out);
    assert.ok(out.includes('-0.05000000074505806'), out);
    assert.ok(!/\b0\.05\b(?!0)/.test(out), out);
  });

  it('leaves a literal that is exactly a referenced constant', () => {
    const { out } = run(`void f(float x) { g(x * 0.5); }`, [HALF, { name: 'D', value: 0.49999999 }]);
    assert.ok(out.includes('x * 0.5'), out);
  });

  it('leaves a literal no referenced constant rounds to', () => {
    const { out } = run(`void f(float x) { g(x * 640.0 + 9.536743e-07); }`, []);
    assert.ok(out.includes('640.0') && out.includes('9.536743e-07'), out);
    const r2 = run(`void f(float x) { g(x * 640.0); }`, [MB]);
    assert.ok(r2.out.includes('640.0'), r2.out);
  });

  it('refuses when two constants round to the same literal', () => {
    const { out, refusals } = run(`void f(double x) { g(x * 0.05); }`, [STEP, { name: 'E', value: 0.0500000001 }]);
    assert.ok(out.includes('x * 0.05'), out);
    assert.strictEqual(refusals.length, 1);
  });

  it('counts significant digits as printed', () => {
    assert.strictEqual(significantDigits('9.536743e-07'), 7);
    assert.strictEqual(significantDigits('0.05'), 1);
    assert.strictEqual(significantDigits('640.0'), 2);
  });
});

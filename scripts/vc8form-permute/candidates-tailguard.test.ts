import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function tailguardForms(text: string): string[] {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.map(c => c.form).filter(f => f.startsWith('tailguard('));
}

describe('tailguard collector candidates', () => {
  it('finds a top-level negated guard before a shared two-call tail', () => {
    assert.deepEqual(tailguardForms('void f(int c) { if (!c) { work(); } tail(a,b); tail(b,a); }'), ['tailguard(!c)']);
  });

  it('indexes repeated conditions so the second viable guard is tried', () => {
    const source = 'void f(int c) { if (!c) { pre(); } if (!c) { work(); } tail(a,b); tail(b,a); }';
    assert.deepEqual(tailguardForms(source), ['tailguard(!c,2)']);
  });

  it('does not offer nested or non-negated guards', () => {
    assert.deepEqual(tailguardForms('void f(int c) { { if (!c) { work(); } tail(a,b); tail(b,a); } }'), []);
    assert.deepEqual(tailguardForms('void f(int c) { if (c) { work(); } tail(a,b); tail(b,a); }'), []);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function forms(text: string, op: string): string[] {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.map(c => c.form).filter(f => f.startsWith(op + '('));
}

describe('tailcopy and elems candidates', () => {
  it('offers tailcopy for an if whose arm falls into the end of a void function', () => {
    assert.deepEqual(forms('void f(int c) { if (c != 1) { work(); if (c) return; } a = 3; b = 1; }', 'tailcopy'), ['tailcopy(c != 1)']);
    assert.deepEqual(forms('void f(int c) { if (c) { work(); return; } a = 3; }', 'tailcopy'), []);
  });

  it('offers elems for a small memset of an array', () => {
    assert.deepEqual(forms('void f() { g = 0; memset(gaState, 0, 7 * sizeof(gaState[0])); }', 'elems'), ['elems(gaState)']);
  });
});

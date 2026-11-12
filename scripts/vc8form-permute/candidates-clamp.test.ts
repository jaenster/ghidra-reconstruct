import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function forms(text: string) {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.map(c => c.form).filter(f => f.startsWith('clamp('));
}

describe('clamp collector candidates', () => {
  it('discovers a local from an adjacent lower or upper bound guard', () => {
    assert.deepEqual(forms('int f(int a) { int v = a; if (v < 0) v = 0; return v; }'), ['clamp(v)']);
    assert.deepEqual(forms('int f(short a) { int v = a; if (10 <= v) v = 10; return v; }'), ['clamp(v)']);
  });

  it('enumerates both indexed sites for a local with repeated clamps', () => {
    const text = 'int f(int a, int b) { int v = a; if (v > 10) v = 10; v = b; if (v < 2) v = 2; return v; }';
    assert.deepEqual(forms(text), ['clamp(v,1)', 'clamp(v,2)']);
  });

  it('offers no candidate when conversion or effects make the rewrite unsafe', () => {
    assert.deepEqual(forms('int f(unsigned a) { int v = a; if (v < 0) v = 0; return v; }'), []);
    assert.deepEqual(forms('int f(long long a) { int v = a; if (v < 0) v = 0; return v; }'), []);
    assert.deepEqual(forms('int f() { int v = source(); if (v < 0) v = 0; return v; }'), []);
  });
});

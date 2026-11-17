import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function clampForms(text: string): string[] {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.map(c => c.form).filter(f => f.startsWith('clamp('));
}

describe('clamp collector candidates', () => {
  it('offers one clamp per clamped local', () => {
    assert.deepEqual(clampForms('int f(int a, int b) { int v = a + b; if (b <= v) { v = b; } return v; }'), ['clamp(v)']);
  });

  it('indexes a local clamped twice so each site is tried', () => {
    const source = 'int f(int a, int b) { int v = a; if (v > 10) { v = 10; } use(v); v = b; if (v < 2) { v = 2; } return v; }';
    assert.deepEqual(clampForms(source), ['clamp(v,1)', 'clamp(v,2)']);
  });

  it('offers nothing the pass refuses', () => {
    assert.deepEqual(clampForms('int f(unsigned int u) { int v = u; if (v < 0) { v = 0; } return v; }'), []);
    assert.deepEqual(clampForms('int f(int a) { int v = a; use(v); if (v < 0) { v = 0; } return v; }'), []);
  });

  it('discovers a bound-first clamp whose condition does not name the destination', () => {
    assert.deepEqual(clampForms('int f(int a) { int v = 1; if (a >= 1) v = a; return v; }'), ['clamp(v)']);
  });

  it('retains the old unindexed site and discovers the additional bound-first site', () => {
    assert.deepEqual(clampForms('int f(int a) { int v = 1; if (a > 1) v = a; v = a; if (v > 10) v = 10; return v; }'),
      ['clamp(v)', 'clamp(v,2)']);
  });
});

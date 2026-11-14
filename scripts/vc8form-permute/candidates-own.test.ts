import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function own(text: string): string[] {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.filter(c => c.form.startsWith('own(')).map(c => c.form);
}

describe('own candidates', () => {
  it('offers the plain form where the initializer is a dead copy, and no live twin', () => {
    assert.deepEqual(own('void f(int* p) { int v = (int)p; v = 0; g((unsigned)v); }'), ['own(v,unsigned int)']);
  });

  it('offers only the live form where the initializer is read', () => {
    assert.deepEqual(own('int f(int* p) { int v = (int)p; if (*p) return (unsigned)v; v = 0; return v; }'), ['own(v,unsigned int,live)']);
  });
});

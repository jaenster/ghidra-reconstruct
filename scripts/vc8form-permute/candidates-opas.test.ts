import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function opasForms(text: string): string[] {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.map(c => c.form).filter(f => f.startsWith('opas(')).sort();
}

describe('opas candidates', () => {
  it('offers one shift per parameter, in the literal as printed', () => {
    const source = 'void f(Path* p, int32_t nX, int32_t nY) { W(&nX, &nY); p->x = (short int)(nX >> 0xb); p->y = (short int)(nY >> 0xb); }';
    assert.deepEqual(opasForms(source), ['opas(nX,>>,0xb)', 'opas(nY,>>,0xb)']);
  });

  it('offers a guarded int32 increment', () => {
    const source = 'void f(A* a) { int32_t v = Get(); if (v != -1) { char* s; Set(a, v + 1); s = Realm(a, v + 1); Save(s); } }';
    assert.deepEqual(opasForms(source), ['opas(v,+,1)']);
  });

  it('offers nothing for other constants, shift counts or a global', () => {
    assert.deepEqual(opasForms('void f(Path* p, int32_t v) { p->x = v >> 32; p->y = v + 2; }'), []);
    assert.deepEqual(opasForms('void f(Path* p) { p->x = g_v >> 3; }'), []);
  });
});

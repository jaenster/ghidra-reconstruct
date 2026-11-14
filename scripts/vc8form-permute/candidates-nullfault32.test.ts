import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function candidates(text: string) {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.filter(c => c.form === 'nullfault32()');
}

describe('nullfault32 collector candidates', () => {
  it('discovers the fault by its body without a function-name dependency', () => {
    const forms = candidates('void AnyName() { *(volatile uint8_t*)0 = 0; }');
    assert.equal(forms.length, 1);
    assert.match(forms[0].text, /\(uint32_t\)\(uintptr_t\)pNull/);
  });

  it('discovers a decompiler-style trailing bare return', () => {
    assert.equal(candidates('void f() { *(volatile uint8_t*)0x0 = 0; return; }').length, 1);
  });

  it('filters invalid faults and signatures through the form guards', () => {
    for (const source of [
      'void f() { *(uint8_t*)0 = 0; }',
      'void f() { *(volatile uint8_t*)4 = 0; }',
      'void f() { *(volatile uint8_t*)0 = 1; }',
      'void f() { before(); *(volatile uint8_t*)0 = 0; }',
      'void f(int x) { *(volatile uint8_t*)0 = 0; }',
      'int f() { *(volatile uint8_t*)0 = 0; }',
    ]) assert.deepEqual(candidates(source), [], source);
  });
});

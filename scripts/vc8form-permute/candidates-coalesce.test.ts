import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singles } from './candidates.js';

function coalesce(text: string): Array<[string, string]> {
  const [result] = singles([{ id: 'f', text }], 4);
  assert.equal(result.error, undefined);
  return result.candidates.filter(c => c.form.startsWith('coalesce(')).map(c => [c.form, c.text.replace(/\s+/g, ' ')]);
}

describe('coalesce candidates', () => {
  it('offers a local that only holds a copy of a parameter, with the folded body', () => {
    assert.deepEqual(coalesce('int f(int n) { int m = n; g(m); return m + 1; }'), [['coalesce(m)', 'int f(int n) { g(n); return n + 1; }']]);
  });

  it('offers nothing for a local the function writes on its own', () => {
    assert.deepEqual(coalesce('int f(int n) { int m = n; while (m) { g(m); m = m - 1; } return n; }'), []);
  });
});

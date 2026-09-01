/**
 * Goto Crosses-Initialization Fixup Plugin Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCrossesInitPlugin } from '../builtins/goto-crosses-init.js';

describe('gotoCrossesInitPlugin', () => {
  const transformer = gotoCrossesInitPlugin.createTransformer();
  const transform = (code: string): string =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('splits an initialized local that a forward goto jumps over', () => {
    const out = transform(`void f(int* p) { if (g()) goto L; int n = p[0]; L: use(n); }`);
    assert.ok(out.includes('int n;'), `expected bare decl in: ${out}`);
    assert.ok(out.includes('n = p[0]'), `expected assignment in: ${out}`);
    assert.ok(!/int n = p\[0\]/.test(out), `should not keep the initialized decl: ${out}`);
  });

  it('splits multiple crossed decls, preserving order', () => {
    const out = transform(`void f(int* p) { goto L; int a = p[0]; int b = a + 1; L: use(a, b); }`);
    assert.ok(out.includes('int a;') && out.includes('a = p[0]'), out);
    assert.ok(out.includes('int b;') && out.includes('b = a + 1'), out);
  });

  it('leaves functions without gotos untouched', () => {
    const out = transform(`void f(int* p) { int n = p[0]; use(n); }`);
    assert.ok(out.includes('int n = p[0]'), `no goto -> keep merged: ${out}`);
  });

  it('does not split an array-with-initializer (no array assignment)', () => {
    const out = transform(`void f() { goto L; int a[3] = {1, 2, 3}; L: use(a); }`);
    assert.ok(/int a\[3\]\s*\{/.test(out), `array decl must stay intact: ${out}`);
  });

  it('splits a decl crossed by a goto whose label sits in a nested scope', () => {
    // The label is inside an else branch, one scope deeper than the crossed decl —
    // the jump crosses it just the same.
    const out = transform(
      `void f(int* p, int c) { if (!c) goto L; int a = p[0]; if (c) { use(a); } else { L: use(p); } }`);
    assert.ok(out.includes('int a;') && out.includes('a = p[0]'),
      `decl crossed by a jump into a nested scope should split: ${out}`);
  });

  it('does not split a decl after the label (not crossed)', () => {
    const out = transform(`void f(int* p) { goto L; int a = p[0]; L: use(a); int b = p[1]; use(b); }`);
    // a (before label) is split; b (after label) is not crossed -> stays merged
    assert.ok(out.includes('int a;') && out.includes('a = p[0]'), `a should split: ${out}`);
    assert.ok(out.includes('int b = p[1]'), `decl after label should stay: ${out}`);
  });
});

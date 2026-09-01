/**
 * A C declarator's array brackets read outermost-first, but the type chain
 * nests the other way: the RIGHTMOST bracket names the innermost element.
 *
 * `byte a[7][520]` is 7 rows of 520 bytes. Building the chain left-to-right
 * produced `Array(520, Array(7, byte))`, which the emitter printed as
 * `[520][7]` — a declaration that will not compile where a `byte (*)[520]` is
 * wanted, and, worse, one whose every `a[i]` indexes the wrong stride.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import type { AnyNode } from '../../ast/nodes.js';

describe('array declarator nesting', () => {
  const roundTrip = (code: string) => emit(parse(code) as AnyNode).trim();

  it('keeps a two-dimensional local in source order', () => {
    const out = roundTrip('void f() { byte local_1060[7][520]; }');
    assert.ok(out.includes('local_1060[7][520]'), `dimensions transposed:\n${out}`);
    assert.ok(!out.includes('[520][7]'), `dimensions transposed:\n${out}`);
  });

  it('keeps a three-dimensional local in source order', () => {
    const out = roundTrip('void f() { int a[2][3][4]; }');
    assert.ok(out.includes('a[2][3][4]'), `dimensions reordered:\n${out}`);
  });

  it('keeps a two-dimensional parameter in source order', () => {
    const out = roundTrip('void f(int rows[16][3]) { }');
    assert.ok(out.includes('rows[16][3]'), `dimensions transposed:\n${out}`);
  });

  it('leaves a one-dimensional declarator bit-identical', () => {
    assert.ok(roundTrip('void f() { char szName[260]; }').includes('szName[260]'));
    assert.ok(roundTrip('void f(int v[10]) { }').includes('v[10]'));
  });

  it('leaves an unsized outer dimension where it was written', () => {
    const out = roundTrip('void f(int rows[][4]) { }');
    assert.ok(out.includes('rows[][4]'), `dimensions transposed:\n${out}`);
  });
});

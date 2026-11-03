/**
 * An elaborated type specifier with a nested-name-specifier - `struct ::T` - is a
 * USE of the type. It is how the generator names a struct that a same-named
 * function hides (`struct ::D2WinImageEx *D2WinImageEx(...)`), and the parser read
 * `struct` as the start of a class definition and failed on the `::`, which sent
 * every such body to the raw-text fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import type { AnyNode } from '../../ast/nodes.js';

const roundTrip = (src: string) => emit(parse(src) as AnyNode).replace(/\s+/g, ' ').trim();

describe('struct ::T', () => {
  it('parses as a return type', () => {
    assert.match(roundTrip('struct ::D2WinImageEx * f(int x) { return 0; }'), /^struct ::D2WinImageEx\* f\(int x\)/);
  });

  it('parses as a local, a cast and a sizeof operand', () => {
    const out = roundTrip('int f(void) { struct ::T *p; p = (struct ::T *)0; return sizeof(struct ::T); }');
    assert.match(out, /struct ::T\* p;/);
    assert.match(out, /\(struct ::T\*\)0/);
    assert.match(out, /sizeof\(struct ::T\)/);
  });

  it('parses a qualified union and enum', () => {
    const out = roundTrip('int f(union ::U *pu, enum ::E e) { return 0; }');
    assert.match(out, /union ::U\* pu/);
    assert.match(out, /enum ::E e/);
  });

  it('still parses a definition and a forward declaration', () => {
    assert.match(roundTrip('struct T { int a; };'), /struct T \{ int a; \};/);
    assert.match(roundTrip('struct T;'), /struct T;/);
  });
});

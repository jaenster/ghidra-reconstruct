/**
 * A parenthesised product whose right operand is itself a cast of a parenthesised value
 * is an expression, not a cast type.
 *
 * WEATHER_UpdateParticles (004732c0) has
 *   `((int)(fVar2 * (float)(int)((float)iVar1 * fDepthFactor)) - gnCameraWorldDeltaY)`.
 * The cast scan took `(fVar2 * (float)(int)(...))` for the type `fVar2 *(float)(int)(...)`
 * - every nested parenthesis was skipped as if it were a declarator - and, since `-` can
 * start an expression, read the whole thing as a cast of `-gnCameraWorldDeltaY`. The
 * function failed to parse and was emitted as the decompiler's raw text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import type { AnyNode } from '../../ast/nodes.js';

const roundTrip = (src: string) => emit(parse(src) as AnyNode).replace(/\s+/g, ' ').trim();

describe('cast or parenthesised product', () => {
  it('parses the WEATHER_UpdateParticles expression', () => {
    const out = roundTrip('void f() { y = y + ((int)(fVar2 * (float)(int)((float)iVar1 * fDepthFactor)) - gnDelta); }');
    assert.match(out, /- gnDelta/);
  });
  it('a product of a cast followed by a binary operator', () => {
    for (const src of [
      'void f() { y = ((int)(v * (float)(w)) - g); }',
      'void f() { y = ((int)(v * (float)(w)) + g); }',
    ]) assert.doesNotThrow(() => parse(src), src);
  });
  it('still reads declarator groups and parameter lists as cast types', () => {
    const out = roundTrip([
      'void f() {',
      '  a = (char (*) [4])p;',
      '  b = (int (*)(int, char))q;',
      '  c = (void (__stdcall *)(int))r;',
      '  d = (int *(*)[4])s;',
      '  e = (void (**)(void))t;',
      '}',
    ].join('\n'));
    for (const [v, name] of [['a', 'p'], ['b', 'q'], ['c', 'r'], ['d', 's'], ['e', 't']]) {
      assert.match(out, new RegExp(`${v} = \\(.*\\)\\s*${name};`), out);
    }
  });
});

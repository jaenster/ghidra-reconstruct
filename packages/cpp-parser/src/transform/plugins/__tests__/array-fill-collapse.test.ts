/**
 * Tests for Array-Fill Collapse Plugin (full-source snapshot assertions).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { arrayFillCollapsePlugin } from '../builtins/array-fill-collapse.js';

describe('arrayFillCollapsePlugin', () => {
  function tx(code: string): string {
    return emit(arrayFillCollapsePlugin.createTransformer({})(parse(code) as AnyNode) as AnyNode).trim();
  }
  const expectSource = (input: string, expected: string) =>
    assert.strictEqual(tx(input), expected.trim());

  it('collapses an int zero-fill run into memset (the gObjModeTokens case)', () => {
    expectSource(
      `void f() { gObjModeTokens[0]=0; gObjModeTokens[1]=0; gObjModeTokens[2]=0; gObjModeTokens[3]=0; gObjModeTokens[4]=0; gObjModeTokens[5]=0; gObjModeTokens[6]=0; gObjModeTokens[7]=0; }`,
      `void f() {
  memset(gObjModeTokens, 0, 8 * sizeof(gObjModeTokens[0]));
}`,
    );
  });

  it("collapses a char '\\0' run", () => {
    expectSource(
      `void f() { name[0]='\\0'; name[1]='\\0'; name[2]='\\0'; name[3]='\\0'; name[4]='\\0'; }`,
      `void f() {
  memset(name, 0, 5 * sizeof(name[0]));
}`,
    );
  });

  it('handles a partial run not starting at 0', () => {
    expectSource(
      `void f() { a[3]=0; a[4]=0; a[5]=0; a[6]=0; }`,
      `void f() {
  memset(a + 3, 0, 4 * sizeof(a[0]));
}`,
    );
  });

  it('collapses a member-access base', () => {
    expectSource(
      `void f() { p->arr[0]=0; p->arr[1]=0; p->arr[2]=0; p->arr[3]=0; }`,
      `void f() {
  memset(p->arr, 0, 4 * sizeof(p->arr[0]));
}`,
    );
  });

  it('leaves a below-threshold run (3) untouched', () => {
    expectSource(
      `void f() { b[0]=0; b[1]=0; b[2]=0; }`,
      `void f() {
  b[0] = 0;
  b[1] = 0;
  b[2] = 0;
}`,
    );
  });

  it('does not collapse non-zero fills', () => {
    expectSource(
      `void f() { c[0]=5; c[1]=5; c[2]=5; c[3]=5; }`,
      `void f() {
  c[0] = 5;
  c[1] = 5;
  c[2] = 5;
  c[3] = 5;
}`,
    );
  });

  it('does not collapse non-consecutive indices', () => {
    expectSource(
      `void f() { d[0]=0; d[1]=0; d[3]=0; d[4]=0; }`,
      `void f() {
  d[0] = 0;
  d[1] = 0;
  d[3] = 0;
  d[4] = 0;
}`,
    );
  });
});

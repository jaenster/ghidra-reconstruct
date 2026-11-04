/**
 * Tests for Array-Fill Collapse Plugin (full-source snapshot assertions).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { arrayFillCollapsePlugin } from '../builtins/array-fill-collapse.js';
import type { AccessOrderEvidence, StoreFact } from '../builtins/access-order-evidence.js';

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

  it("writes four '\\0' stores as one 32-bit store (PLAYERSAVE_ParseItemFromBuffer)", () => {
    expectSource(
      `void f() { p->szCode[0]='\\0'; p->szCode[1]='\\0'; p->szCode[2]='\\0'; p->szCode[3]='\\0'; p->n = -1; }`,
      `void f() {
  *(uint32_t*)p->szCode = 0;
  p->n = -1;
}`,
    );
    expectSource(
      `void f() { s.a[2]='\\0'; s.a[3]='\\0'; s.a[4]='\\0'; s.a[5]='\\0'; }`,
      `void f() {
  *(uint32_t*)(s.a + 2) = 0;
}`,
    );
  });

  it('keeps four integer zero stores a memset: their element size is not known', () => {
    assert.ok(tx(`void f() { p->w[0]=0; p->w[1]=0; p->w[2]=0; p->w[3]=0; }`).includes('memset(p->w, 0, 4 * sizeof(p->w[0]));'));
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

describe('arrayFillCollapsePlugin with store widths', () => {
  /** One statement per line; `[n]` tags the line's `=` with an n-byte store. */
  function run(lines: string[]): string {
    const stores = new Map<number, StoreFact[]>();
    const text = lines.map((l, i) => {
      const m = l.match(/^\s*\[(\d+)(?:@(\d+))?\]\s?(.*)$/);
      if (!m) return l;
      stores.set(i + 1, [{ ord: 0, at: m[2] ? Number(m[2]) : 4 * i, size: Number(m[1]), half: null }]);
      return m[3];
    });
    const ev: AccessOrderEvidence = { args: new Map(), stores };
    return emit(arrayFillCollapsePlugin.createTransformer({ accessOrder: ev })(parse(text.join('\n')) as AnyNode) as AnyNode).replace(/\s+/g, ' ');
  }

  // INV_FormatQuantityText 00484db0: ten `mov word ptr [ebp-x], di`.
  it('keeps element stores the original makes one word at a time', () => {
    const out = run(['void f() {', 'wchar_t w[5];', '[2] w[0] = 0;', '[2] w[1] = 0;', '[2] w[2] = 0;', '[2] w[3] = 0;', '[2] w[4] = 0;', 'g(w);', '}']);
    assert.doesNotMatch(out, /memset/);
    assert.match(out, /w\[4\] = 0;/);
  });

  it('collapses a run whose stores include a dword', () => {
    const out = run(['void f() {', 'char c[8];', '[4] c[0] = 0;', '[1] c[1] = 0;', '[1] c[2] = 0;', '[1] c[3] = 0;', 'g(c);', '}']);
    assert.match(out, /memset\(c, 0, 4 \* sizeof\(c\[0\]\)\)|\*\(uint32_t\*\)c = 0/);
  });

  // HELP_DrawHelpButtonTooltip 00495030: one `mov dword ptr` printed as two word stores.
  it('collapses element stores that share their instruction', () => {
    const out = run(['void f() {', 'wchar_t w[4];', '[2@30] w[0] = 0;', '[2@30] w[1] = 0;', '[2@33] w[2] = 0;', '[2@33] w[3] = 0;', 'g(w);', '}']);
    assert.match(out, /memset\(w, 0, 4 \* sizeof\(w\[0\]\)\)/);
  });

  it('collapses a run with a store the facts do not cover', () => {
    const out = run(['void f() {', 'short a[5];', '[2] a[0] = 0;', '[2] a[1] = 0;', 'a[2] = 0;', '[2] a[3] = 0;', '[2] a[4] = 0;', 'g(a);', '}']);
    assert.match(out, /memset\(a, 0, 5 \* sizeof\(a\[0\]\)\)/);
  });
});

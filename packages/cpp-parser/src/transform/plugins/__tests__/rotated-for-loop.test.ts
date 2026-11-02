/**
 * Tests for the Rotated For Loop plugin: every rewrite and every case that must stay.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { rotatedForLoopPlugin } from '../builtins/rotated-for-loop.js';

function tx(code: string, options: Record<string, unknown> = {}): string {
  return emit(rotatedForLoopPlugin.createTransformer(options)(parse(code)) as AnyNode).trim();
}

function same(code: string, options: Record<string, unknown> = {}): void {
  const before = emit(parse(code) as AnyNode).trim();
  assert.strictEqual(tx(code, options), before);
}

describe('rotatedForLoopPlugin', () => {
  it('rewrites the counted loop with its initialisation inside the test (InitPal)', () => {
    const out = tx(`void f(int n, int* p) {
  int i;
  if (0 < n) {
    i = 0;
    do {
      p[i] = i;
      i++;
    } while (i < n);
  }
}`);
    assert.strictEqual(out, `void f(int n, int* p) {
  int i;
  for (i = 0; i < n; i++) {
    p[i] = i;
  }
}`);
  });

  it('accepts the guard with its operands swapped', () => {
    const out = tx(`void f(int n) { int i; if (n > 0) { i = 0; do { g(i); i += 2; } while (i < n); } }`);
    assert.ok(out.includes('for (i = 0; i < n; i += 2) {'), out);
    assert.ok(!out.includes('if ('), out);
  });

  it('moves a declaring initialisation into the for', () => {
    const out = tx(`void f(int n) { if (0 < n) { int i = 0; do { g(i); ++i; } while (i < n); } }`);
    assert.ok(out.includes('for (int i = 0; i < n; ++i) {'), out);
  });

  it('rewrites a pointer walk', () => {
    const out = tx(`void f(Node* list) {
  Node* p;
  if (list != nullptr) {
    p = list;
    do {
      use(p);
      p = p->next;
    } while (p != nullptr);
  }
}`);
    assert.ok(out.includes('for (p = list; p != nullptr; p = p->next) {'), out);
  });

  it('rewrites a pointer walk to an end', () => {
    const out = tx(`void f(int* b, int* e) { int* p; if (b != e) { p = b; do { use(*p); p++; } while (p != e); } }`);
    assert.ok(out.includes('for (p = b; p != e; p++) {'), out);
  });

  it('rewrites an unsigned counter against an unsigned bound', () => {
    const out = tx(`void f(unsigned int n) { unsigned int i; if (0 < n) { i = 0; do { g(i); i++; } while (i < n); } }`);
    assert.ok(out.includes('for (i = 0; i < n; i++) {'), out);
  });

  it('rewrites a down-counter', () => {
    const out = tx(`void f(int last) { int i; if (last >= 0) { i = last; do { g(i); i--; } while (i >= 0); } }`);
    assert.ok(out.includes('for (i = last; i >= 0; i--) {'), out);
    // an initial value whose type is not known stays
    same(`void f(int n) { int i; if (n - 1 >= 0) { i = n - 1; do { g(i); i--; } while (i >= 0); } }`);
  });

  it('rewrites nested rotated loops', () => {
    const out = tx(`void f(int n, int m) {
  int i;
  int j;
  if (0 < n) {
    i = 0;
    do {
      if (0 < m) {
        j = 0;
        do {
          g(i, j);
          j++;
        } while (j < m);
      }
      i++;
    } while (i < n);
  }
}`);
    assert.ok(out.includes('for (i = 0; i < n; i++) {'), out);
    assert.ok(out.includes('for (j = 0; j < m; j++) {'), out);
    assert.ok(!out.includes('do {'), out);
  });

  it('rewrites only the loop with its own condition, a constant bound', () => {
    const out = tx(`void f(short* a) { int i; if (0 < 0x100) { i = 0; do { a[i] = 0; i++; } while (i < 0x100); } }`);
    assert.ok(out.includes('for (i = 0; i < 0x100; i++) {'), out);
  });

  // ---- what must stay ----

  it('leaves a guard that is not the first test', () => {
    same(`void f(int c, int n) { int i; if (c) { i = 0; do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves the loop when the counter is read after it', () => {
    same(`int f(int n) { int i; if (0 < n) { i = 0; do { g(i); i++; } while (i < n); } return i; }`);
  });

  it('leaves the loop when the counter is read before it (an enclosing loop)', () => {
    same(`void f(int n, int k) { int i; while (k) { h(i); if (0 < n) { i = 0; do { g(i); i++; } while (i < n); } k--; } }`);
  });

  it('leaves a body with a continue of its own', () => {
    same(`void f(int n) { int i; if (0 < n) { i = 0; do { if (g(i)) { i++; continue; } i++; } while (i < n); } }`);
  });

  it('rewrites a body whose continue belongs to an inner loop', () => {
    const out = tx(`void f(int n, int k) { int i; if (0 < n) { i = 0; do { while (k) { if (h()) continue; k--; } i++; } while (i < n); } }`);
    assert.ok(out.includes('for (i = 0; i < n; i++) {'), out);
  });

  it('leaves a body that does not end in the step', () => {
    same(`void f(int n) { int i; if (0 < n) { i = 0; do { i++; g(i); } while (i < n); } }`);
  });

  it('leaves an if with an else', () => {
    same(`void f(int n) { int i; if (0 < n) { i = 0; do { g(i); i++; } while (i < n); } else { h(); } }`);
  });

  it('leaves an if block with more than the initialisation and the loop', () => {
    same(`void f(int n) { int i; if (0 < n) { h(); i = 0; do { g(i); i++; } while (i < n); } }`);
    same(`void f(int n) { int i; if (0 < n) { i = 0; do { g(i); i++; } while (i < n); h(); } }`);
  });

  it('leaves an unsigned counter against a signed bound', () => {
    same(`void f(int n) { unsigned int i; if (0 < n) { i = 0; do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves a narrow counter initialised from a wider value', () => {
    same(`void f(int n, int s) { short i; if (s < n) { i = s; do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves a constant the counter cannot hold', () => {
    same(`void f(int n) { unsigned char i; if (300 < n) { i = 300; do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves an initialisation with a side effect', () => {
    same(`void f(int n) { int i; if (start() < n) { i = start(); do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves a condition with a short circuit', () => {
    same(`void f(int n, int* p) { int i; if (0 < n && p[0]) { i = 0; do { g(i); i++; } while (i < n && p[i]); } }`);
  });

  // MONSTER_PreloadSequenceAnimations, 004afb60: the original holds n >> 8 in a variable.
  it('leaves a loop whose bound is computed from other values', () => {
    same(`void f(int n) { int i; i = 0; if (0 < n >> 8) { do { g(i); i++; } while (i < n >> 8); } }`);
    same(`void f(int n) { if (0 < n + 1) { int i = 0; do { g(i); i++; } while (i < n + 1); } }`);
  });

  it('rewrites a computed bound where the original computes it again for the test', () => {
    const code = [
      'void f(S* p) {',
      '  int i;',
      '  i = 1;',
      '  if (1 < p->n + -1) {',
      '    do {',
      '      g(i);',
      '      i++;',
      '    } while (i < p->n + -1);',
      '  }',
      '}',
    ].join('\n');
    const layout = (guard: number[], test: number[]) => ({
      branchLayout: { lines: new Map([[4, guard], [6, [0x30]], [7, [0x40]], [8, test]]), ifs: new Map([[4, guard[guard.length - 1]]]) },
    });
    // DRLGOUTROOM_FindWarpExitInColumn, 0067fb90: the test loads and decrements again.
    const out = tx(code, layout([0x7, 0x10, 0x18], [0x64, 0x6a, 0x6f]));
    assert.ok(out.includes('for (i = 1; i < p->n + -1; i++) {'), out);
    // MONSTER_PreloadSequenceAnimations, 004afb60: one `sar` printed on both lines.
    same(code, layout([0x19, 0x20], [0x19, 0x56]));
  });

  it('rewrites a loop whose bound is read through a cast, a member or an element', () => {
    for (const bound of ['(int)p->n', 'p->n', 'a[2]', '*q']) {
      const out = tx(`void f(S* p, int* a, int* q) { int i; i = 0; if (0 < ${bound}) { do { g(i); i++; } while (i < ${bound}); } }`);
      assert.ok(out.includes(`for (i = 0; i < ${bound}; i++) {`), out);
    }
  });

  // syncsearch, 0042b300: `while (next < len && got < 4)`.
  it('leaves a body that opens with a break test ahead of more statements', () => {
    same(`unsigned f(unsigned n, unsigned k) { unsigned i; i = 0; if (0 < n) { do { if (k >= 4) break; k = h(k); i++; } while (i < n); } return i; }`);
    same(`void f(unsigned n, unsigned k) { unsigned i; if (0 < n) { i = 0; do { if (k >= 4) { break; } g(i); i++; } while (i < n); } }`);
  });

  it('rewrites a body that is only a break test', () => {
    const out = tx(`void f(unsigned n, char* p) { unsigned i; i = 0; if (0 < n) { do { if (p[i] != 0) break; i++; } while (i < n); } g(i); }`);
    assert.ok(out.includes('for (i = 0; i < n; i++) {'), out);
  });

  it('leaves a global counter', () => {
    same(`void f(int n) { if (0 < n) { g_i = 0; do { g(g_i); g_i++; } while (g_i < n); } }`);
  });

  it('leaves a body a goto from outside jumps into', () => {
    same(`void f(int n, int c) { int i; if (c) goto L; if (0 < n) { i = 0; do { L: g(i); i++; } while (i < n); } }`);
  });

  it('leaves a loop whose initialisation carries a comment', () => {
    same(`void f(int n) { int i; if (0 < n) {
  // first slot
  i = 0; do { g(i); i++; } while (i < n); } }`);
  });

  it('does not mistake a member named like the counter for the counter', () => {
    same(`void f(S* s, int n) { int i; if (s->i < n) { i = 0; do { g(i); i++; } while (i < n); } }`);
  });

  it('uses the tables for a counter compared with a global bound', () => {
    const code = `void f() { unsigned int i; if (0 < g_count) { i = 0; do { g(i); i++; } while (i < g_count); } }`;
    same(code);
    same(code, { globalTypes: { g_count: 'int' } });
    const out = tx(code, { globalTypes: { g_count: 'DWORD' } });
    assert.ok(out.includes('for (i = 0; i < g_count; i++) {'), out);
  });

  it('reads the guard through the same member access spelled another way', () => {
    const out = tx(`void f(Block ctx) { Block* p; if (ctx.pNext) { p = &ctx; do { use(p); p = p->pNext; } while (p->pNext); } }`);
    assert.ok(out.includes('for (p = &ctx; p->pNext; p = p->pNext) {'), out);
    const arr = tx(`void f(Desc* d) { Desc* p; if (d[0].eType != 0) { p = d; do { use(p); p++; } while (p->eType != 0); } }`);
    assert.ok(arr.includes('for (p = d; p->eType != 0; p++) {'), arr);
  });

  it('leaves a guard on another member', () => {
    same(`void f(Block ctx) { Block* p; if (ctx.pPrev) { p = &ctx; do { use(p); p = p->pNext; } while (p->pNext); } }`);
  });

  // ---- the initialisation ahead of the test ----

  it('rewrites the counted loop with its initialisation ahead of the test (InitPal as Ghidra prints it)', () => {
    const out = tx(`void f(int n, int* p) {
  int i;
  i = 0;
  if (0 < n) {
    do {
      p[i] = i;
      i++;
    } while (i < n);
  }
  h();
}`);
    assert.strictEqual(out, `void f(int n, int* p) {
  int i;
  for (i = 0; i < n; i++) {
    p[i] = i;
  }
  h();
}`);
  });

  it('rewrites an initialisation ahead of the test whose counter is read after the loop', () => {
    // The assignment runs whether the guard holds or not, before and after.
    const out = tx(`int f(int n) { int i; i = 0; if (n > 0) { do { g(i); i++; } while (i < n); } return i; }`);
    assert.ok(out.includes('for (i = 0; i < n; i++) {'), out);
    assert.ok(out.includes('return i;'), out);
  });

  it('moves a declaring initialisation ahead of the test into the for', () => {
    const out = tx(`void f(int n) { int i = 0; if (0 < n) { do { g(i); ++i; } while (i < n); } }`);
    assert.ok(out.includes('for (int i = 0; i < n; ++i) {'), out);
  });

  it('rewrites a pointer walk with its initialisation ahead of the test', () => {
    const out = tx(`void f(Node* list) { Node* p; p = list; if (list != nullptr) { do { use(p); p = p->next; } while (p != nullptr); } }`);
    assert.ok(out.includes('for (p = list; p != nullptr; p = p->next) {'), out);
  });

  it('leaves a declaration ahead of the test whose counter is read after the loop', () => {
    same(`int f(int n) { int i = 0; if (0 < n) { do { g(i); i++; } while (i < n); } return i; }`);
  });

  it('leaves an initialisation that is not the statement just ahead of the if', () => {
    same(`void f(int n) { int i; i = 0; h(); if (0 < n) { do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves an if block ahead of which the initialisation stands, holding more than the loop', () => {
    same(`void f(int n) { int i; i = 0; if (0 < n) { h(); do { g(i); i++; } while (i < n); } }`);
  });

  it('leaves the ahead form with a continue of its own, a narrow counter or a global counter', () => {
    same(`void f(int n) { int i; i = 0; if (0 < n) { do { if (g(i)) { i++; continue; } i++; } while (i < n); } }`);
    same(`void f(int n, int s) { short i; i = s; if (s < n) { do { g(i); i++; } while (i < n); } }`);
    same(`void f(int n) { g_i = 0; if (0 < n) { do { g(g_i); g_i++; } while (g_i < n); } }`);
  });

  it('leaves the ahead form when the initialisation or the if carries a comment', () => {
    same(`void f(int n) { int i;
  // first slot
  i = 0; if (0 < n) { do { g(i); i++; } while (i < n); } }`);
    same(`void f(int n) { int i; i = 0;
  // the slots
  if (0 < n) { do { g(i); i++; } while (i < n); } }`);
  });
});

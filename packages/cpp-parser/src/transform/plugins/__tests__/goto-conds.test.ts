/**
 * Condition DAG folding (goto-cleanup/conds.ts, design step 8): a goto that only finishes
 * evaluating a condition becomes part of that condition.
 *
 * Each shape is compiled as written and as rewritten and run over every input, each atom
 * recording itself through W, so an atom evaluated twice, skipped, or out of Ghidra's order
 * is a mismatch. Decline cases pin what is not folded.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function run(src: string) {
  resetGotoCleanupStats();
  const out = emit(gotoCleanupPlugin.createTransformer()(parse(src)) as AnyNode);
  const st = getGotoCleanupStats();
  assert.equal(st.vetoedUnsafe, 0, 'the reachability net stopped a candidate');
  assert.equal(st.orphanGoto, 0);
  return { out, st };
}

const gotos = (s: string) => (s.match(/\bgoto\b/g) ?? []).length;

/** Run ref::f and low::f on a, b, c in 0..3; compare result and the trace of W calls. */
function same(ref: string, low: string): string {
  const prelude = [
    'static int trace[512]; static int nt;',
    'static int W(int k) { if (nt < 512) trace[nt++] = k; return k; }',
    `namespace ref {\n${ref}\n}`,
    `namespace low {\n${low}\n}`,
  ].join('\n');
  const body = [
    'long bad = 0;',
    'for (int m = 0; m < 64; m++) {',
    '  int a = m & 3, b = (m >> 2) & 3, c = (m >> 4) & 3;',
    '  static int t1[512], t2[512]; int n1, n2, r1, r2;',
    '  nt = 0; r1 = ref::f(a, b, c); n1 = nt; memcpy(t1, trace, sizeof t1);',
    '  nt = 0; r2 = low::f(a, b, c); n2 = nt; memcpy(t2, trace, sizeof t2);',
    '  if (r1 != r2 || n1 != n2 || memcmp(t1, t2, n1 * sizeof(int))) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

describe('conds: the second test of an || reached by a goto', () => {
  // GetModuleInfoForAddress 00401df0: the handle test, then a load whose result is the
  // second operand; the shared true edge is the label in the else arm.
  const MOD = `int f(int a, int b, int c) {
  int h;
  h = W(a);
  if (h == 0) {
    h = W(b + 10) - 10;
    if (h != 0) goto LAB_1;
  }
  else {
LAB_1:
    W(20 + c);
    return h;
  }
  W(30);
  return -1;
}`;

  it('label in the else arm: if (h != 0 || (h = Load(), h != 0)) { X }', () => {
    const r = run(MOD);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.dagFold, 1, r.out);
    assert.match(r.out, /if \(h != 0 \|\| \(h = W\(b \+ 10\) - 10 ?, h != 0\)\)/, r.out);
  });
  it('label in the else arm: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(MOD, run(MOD).out), '0');
  });

  // Label in the then arm, the goto under two nested tests, a rest after the chain.
  const NEST = `int f(int a, int b, int c) {
  int r = 0;
  if (W(a) == 1) {
LAB_1:
    r = W(40);
  }
  else {
    if (W(b) != 0) {
      if (W(c) == 2) goto LAB_1;
    }
    r = W(50);
  }
  W(60);
  return r;
}`;

  it('label in the then arm, nested tests: if (A || (B && C)) { X } else { R }', () => {
    const r = run(NEST);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.dagFold, 1, r.out);
    assert.match(r.out, /if \(W\(a\) == 1 \|\| \(?W\(b\) != 0 && W\(c\) == 2\)?\)/, r.out);
    assert.match(r.out, /else \{\s*r = W\(50\);/, r.out);
  });
  it('label in the then arm, nested tests: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(NEST, run(NEST).out), '0');
  });

  // A second goto from outside the if: the fold takes the one inside, the label stays.
  const KEEP = `int f(int a, int b, int c) {
  int r = 0;
  if (W(c) == 3) goto LAB_1;
  if (W(a) == 1) {
LAB_1:
    r = W(40);
  }
  else {
    if (W(b) == 2) goto LAB_1;
    r = W(50);
  }
  return r;
}`;

  it('keeps the label for a goto from outside the if', () => {
    const r = run(KEEP);
    assert.equal(r.st.dagFold, 1, r.out);
    assert.match(r.out, /W\(a\) == 1 \|\| W\(b\) == 2/, r.out);
  });
  it('keeps the label: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(KEEP, run(KEEP).out), '0');
  });
});

describe('conds: the label in the else arm, work after the test', () => {
  // The binary lays the then arm (R) out before the label's block: the fold keeps that.
  const ELSE = `int f(int a, int b, int c) {
  int r = 0;
  W(1);
  if (W(a) != 0) {
    if (W(b) == 2) goto LAB_1;
    r = W(50);
  }
  else {
LAB_1:
    r = W(40 + c);
  }
  return r;
}`;
  it('if (A && !C) { R } else { X }', () => {
    const r = run(ELSE);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.dagFold, 1, r.out);
    assert.match(r.out, /if \(W\(a\) != 0 && W\(b\) != 2\) \{\s*r = W\(50\);\s*\} else \{\s*r = W\(40 \+ c\);/, r.out);
  });
  it('if (A && !C) { R } else { X }: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(ELSE, run(ELSE).out), '0');
  });
  it('the harness catches the arms swapped', { skip: !hasNativeGpp() }, () => {
    const out = run(ELSE).out.replace('r = W(50);', 'r = W(41);');
    assert.notEqual(same(ELSE, out), '0');
  });
});

describe('conds: what is not a condition', () => {
  it('declines work before the test that the test does not read', () => {
    const src = `int f(int a, int b, int c) {
  int r = 0;
  if (W(a) == 1) {
LAB_1:
    r = W(40);
  }
  else {
    W(7);
    if (W(b) == 2) goto LAB_1;
    r = W(50);
  }
  return r;
}`;
    assert.equal(run(src).st.dagFold, 0);
  });
  it('declines a test with an else (the goto is not the only way out of it)', () => {
    const src = `int f(int a, int b, int c) {
  int r = 0;
  if (W(a) == 1) {
LAB_1:
    r = W(40);
  }
  else {
    if (W(b) == 2) goto LAB_1; else W(9);
    r = W(50);
  }
  return r;
}`;
    assert.equal(run(src).st.dagFold, 0);
  });
  it('declines two gotos to the label in the other arm', () => {
    const src = `int f(int a, int b, int c) {
  int r = 0;
  if (W(a) == 1) {
LAB_1:
    r = W(40);
  }
  else {
    if (W(b) == 2) goto LAB_1;
    r = W(50);
    if (W(c) == 2) goto LAB_1;
  }
  return r;
}`;
    assert.equal(run(src).st.dagFold, 0);
  });
});

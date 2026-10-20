/**
 * comma-expand and a goto exit: `if (A || (X, B)) goto L;`.
 *
 * Splitting that into one guard per operand (`if (A) goto L; X; if (B) goto L;`) is
 * value-preserving, but it writes two jumps where the binary had one, so the tree had more
 * gotos than the raw decompile (DRLGENV_UpdateEnvironmentCycle 0061bee0 and 34 others at
 * v1131). The early run now leaves a goto guard alone; goto-cleanup structures it into the
 * negated no-else form, and the late run lowers that by nesting:
 *
 *   if (A || (X, B)) goto L; R; L: S;   ->   if (!A) { X; if (!B) { R } } S
 *
 * Every shape is compiled and run as written and as lowered, over every input, with X
 * recording each time it runs - so a comma operand evaluated on a path where `||` does
 * not evaluate it, or evaluated twice, is a mismatch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, ASTNode } from '../../../ast/nodes.js';
import { commaExpandPlugin, commaExpandLatePlugin } from '../builtins/comma-expand.js';
import { gotoCleanupPlugin } from '../builtins/goto-cleanup/index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function pipeline(src: string): string {
  let ast = parse(src) as ASTNode;
  ast = commaExpandPlugin.createTransformer({})(ast);
  ast = gotoCleanupPlugin.createTransformer()(ast);
  ast = commaExpandLatePlugin.createTransformer({})(ast);
  return emit(ast as AnyNode);
}

function early(src: string): string {
  return emit(commaExpandPlugin.createTransformer({})(parse(src)) as AnyNode);
}

const gotos = (s: string) => (s.match(/\bgoto\b/g) ?? []).length;

/** Run `ref::f` and `low::f` over every (a, b, c) in 0..3 and compare result + trace. */
function sameBehaviour(ref: string, low: string, call: string): string {
  const prelude = [
    'static int trace[64]; static int nt;',
    'static int X(int v) { trace[nt++] = v; return v; }',
    `namespace ref {\n${ref}\n}`,
    `namespace low {\n${low}\n}`,
  ].join('\n');
  const body = [
    'long bad = 0;',
    'for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) for (int c = 0; c < 4; c++) {',
    '  int t1[64], n1, t2[64], n2, r1, r2, p1 = c, p2 = c;',
    `  nt = 0; r1 = ref::${call.replace(/\$p/g, '&p1')}; n1 = nt; memcpy(t1, trace, sizeof t1);`,
    `  nt = 0; r2 = low::${call.replace(/\$p/g, '&p2')}; n2 = nt; memcpy(t2, trace, sizeof t2);`,
    '  if (r1 != r2 || p1 != p2 || n1 != n2 || memcmp(t1, t2, n1 * sizeof(int))) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

describe('comma-expand: an OR guard whose exit is a goto', () => {
  it('the early run keeps one guard, with its comma, for a goto exit', () => {
    const src = `void f(int a, int b) { if (a || (x = g(), b)) goto L; h(); L: k(); }`;
    const out = early(src);
    assert.strictEqual(gotos(out), 1);
    assert.match(out, /if \(a \|\| \(x = g\(\)\s*,\s*b\)\)\s*\{?\s*goto L;/);
  });

  it('still splits a return exit, with X after the first guard', () => {
    const out = early(`int f(int a, int b) { if (a || (x = g(), b)) return 1; return 0; }`);
    assert.match(out, /if \(a\)\s*\{?\s*return 1;\s*\}?\s*x = g\(\);\s*if \(b\)\s*\{?\s*return 1;/);
  });

  const TOP = `int f(int a, int b, int *p) {
  int n = *p;
  if (a == 1 || (*p = X(n + 1), b != 2)) goto LAB_1;
  n = n + 9;
  *p = n;
LAB_1:
  return *p * 7 + n;
}`;

  it('top level: structured, then nested by the late run - one jump, no goto, no comma', () => {
    const out = pipeline(TOP);
    assert.strictEqual(gotos(out), 0, out);
    assert.doesNotMatch(out, /X\(n \+ 1\)\s*,/, out);
    // X runs under !A, and the rest under !A && !B.
    assert.match(out, /if \(a != 1\) \{\s*\*p = X\(n \+ 1\);\s*if \(b == 2\) \{\s*n = n \+ 9;/, out);
  });

  it('top level: compiled, same result, same stores, X run on the same paths', { skip: !hasNativeGpp() }, () => {
    assert.strictEqual(sameBehaviour(TOP, pipeline(TOP), 'f(a, b, $p)'), '0');
  });

  // DRLGENV_UpdateEnvironmentCycle 0061bee0: the guard sits in a nested else and jumps past
  // the enclosing if.
  const NESTED = `int f(int a, int b, int *p) {
  int nTicks;
  *p = *p + 1;
  nTicks = *p;
  if (a != 3) {
    if (b == 3) {
      nTicks = nTicks + 0xf;
    }
    else {
      if ((X(a) != 2) || (*p = X(nTicks + 1), b != 2)) goto LAB_0061bf1a;
      nTicks = nTicks + 9;
    }
    *p = nTicks;
  }
LAB_0061bf1a:
  nTicks = X(*p);
  if (nTicks > 3) {
    *p = 0;
  }
  return nTicks;
}`;

  // The join `*p = nTicks;` would have to be sunk into both arms (E6). The binary has the
  // label entered by a fall-through and a conditional jump only, so the copy policy keeps
  // the goto (audit fixture 0061bee0 LAB_0061bf1a, design section 11); the guard still
  // reads as one test.
  it('0061bee0 shape: the join is not copied, the guard keeps its one goto', () => {
    const out = pipeline(NESTED);
    assert.equal(gotos(out), 1, out);
    assert.match(out, /if \(X\(a\) != 2 \|\| \(\*p = X\(nTicks \+ 1\) , b != 2\)\)\s*goto LAB_0061bf1a;/, out);
  });

  it('0061bee0 shape: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.strictEqual(sameBehaviour(NESTED, pipeline(NESTED), 'f(a, b, $p)'), '0');
  });

  it('the harness catches a comma operand evaluated where || would not evaluate it', { skip: !hasNativeGpp() }, () => {
    const broken = TOP.replace('if (a == 1 || (*p = X(n + 1), b != 2)) goto LAB_1;',
      '*p = X(n + 1); if (a == 1 || b != 2) goto LAB_1;');
    assert.notStrictEqual(sameBehaviour(TOP, broken, 'f(a, b, $p)'), '0');
  });
});

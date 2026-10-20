/**
 * The structurer (goto-cleanup/structure.ts): a goto into another block becomes that block.
 *
 * Every accepted shape is compiled as written and as structured, and run over every input
 * with each work statement recording itself, so a block put where control does not reach
 * it, a lost jump, or a statement run twice is a mismatch. The decline cases pin what is
 * NOT done: a tail with no evidence that the source wrote it twice keeps its goto.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

function run(src: string, labelFlow?: Record<string, { back: number; first: string; pushedArgs: boolean }>): { out: string; arm: number; copies: number; moves: number } {
  resetGotoCleanupStats();
  const out = emit(gotoCleanupPlugin.createTransformer(labelFlow ? { labelFlow } : undefined)(parse(src)) as AnyNode);
  const st = getGotoCleanupStats();
  assert.equal(st.vetoedUnsafe, 0);
  assert.equal(st.orphanGoto, 0);
  return { out, arm: st.structureArm, copies: st.copyE3 + st.copyE4 + st.copyE6, moves: st.movedBlocks };
}

const gotos = (s: string) => (s.match(/\bgoto\b/g) ?? []).length;

/** Run ref::f and low::f on every (a, b, c) in {0,1}^3; compare result and trace. */
function same(ref: string, low: string): string {
  const prelude = [
    'static int trace[64]; static int nt;',
    'static int W(int k) { trace[nt++] = k; return k; }',
    `namespace ref {\n${ref}\n}`,
    `namespace low {\n${low}\n}`,
  ].join('\n');
  const body = [
    'long bad = 0;',
    'for (int m = 0; m < 8; m++) {',
    '  int a = m & 1, b = (m >> 1) & 1, c = (m >> 2) & 1;',
    '  int t1[64], n1, t2[64], n2, r1, r2;',
    '  nt = 0; r1 = ref::f(a, b, c); n1 = nt; memcpy(t1, trace, sizeof t1);',
    '  nt = 0; r2 = low::f(a, b, c); n2 = nt; memcpy(t2, trace, sizeof t2);',
    '  if (r1 != r2 || n1 != n2 || memcmp(t1, t2, n1 * sizeof(int))) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  return compileAndRun(prelude, body).trim();
}

describe('structurer: arm crossings', () => {
  // MakeMissile 004cd540: LAB_004cd678 `nVelocityRaw <<= 8` reached from the else arm.
  const E6 = `int f(int a, int b, int c) {
  int v;
  if (a == 0) {
    v = W(1);
LAB_1:
    v = v << 8;
  }
  else {
    v = W(2);
    if (b == 0) goto LAB_1;
  }
  W(v);
  return v;
}`;

  it('E6: a one-statement tail is put in the arm that jumped to it', () => {
    const r = run(E6);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.arm, 1);
    assert.equal(r.copies, 1);
    assert.match(r.out, /v = W\(2\);\s*if \(b == 0\) \{?\s*v = v << 8;/);
  });

  it('E6: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(E6, run(E6).out), '0');
  });

  // One goto, and the label is reached by nothing else: the block moves, whatever its size.
  const MOVE = `int f(int a, int b, int c) {
  if (a) {
    W(1);
    if (b) goto LAB_1;
    W(2);
  }
  else {
    W(3);
    return 0;
LAB_1:
    W(4);
    W(5);
    W(6);
    W(7);
    W(8);
  }
  W(9);
  return 1;
}`;

  it('move: the only goto takes the block, the rest of its arm becomes the else', () => {
    const r = run(MOVE);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.moves, 1);
    assert.equal(r.copies, 0);
    assert.match(r.out, /if \(b\) \{\s*W\(4\);[^]*W\(8\);\s*\} else \{\s*W\(2\);\s*\}/);
    assert.equal((r.out.match(/W\(4\)/g) ?? []).length, 1);
  });

  it('move: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(MOVE, run(MOVE).out), '0');
  });

  // The tail continues at the end of a void function; the site would continue elsewhere.
  const RET = `void g(int a, int b, int c) {
  if (a) {
    W(1);
LAB_1:
    W(2);
  }
  else {
    if (b) {
      W(3);
      goto LAB_1;
    }
    W(4);
  }
}
int f(int a, int b, int c) { g(a, b, c); return 0; }`;

  // W(2) does not end in a jump the source wrote, so E6 needs instruction evidence for it
  // (copy-policy rule 1): here a jump into LAB_1 from a higher address (A1).
  const RET_FLOW = { LAB_1: { back: 1, first: 'PUSH', pushedArgs: false } };

  it('a jump reaches the place the tail continued to: return; at the end of a void function', () => {
    const r = run(RET, RET_FLOW);
    assert.equal(gotos(r.out), 0, r.out);
    assert.match(r.out, /W\(3\);\s*W\(2\);\s*return;/);
  });

  it('return; jump: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(RET, run(RET, RET_FLOW).out), '0');
  });

  it('the same tail with no instruction evidence keeps its goto (E6 rule 1)', () => {
    const r = run(RET);
    assert.equal(gotos(r.out), 1, r.out);
    assert.equal(r.copies, 0);
  });

  // A tail of five calls reached by a goto and by falling in: nothing says the source wrote
  // it twice, so it is not copied.
  const NOEVIDENCE = `int f(int a, int b, int c) {
  if (a) {
    W(1);
LAB_1:
    W(2);
    W(3);
    W(4);
    W(5);
    W(6);
  }
  else {
    W(7);
    if (b) goto LAB_1;
  }
  return 0;
}`;

  it('declines a copy with no evidence: the goto stays', () => {
    const r = run(NOEVIDENCE);
    assert.equal(gotos(r.out), 1);
    assert.equal(r.arm, 0);
  });

  // Two sites whose prefixes are the same statement: E6 needs every site to differ.
  const SAMEPREFIX = `int f(int a, int b, int c) {
  if (a) {
    W(1);
LAB_1:
    W(2);
  }
  else {
    if (b) {
      W(1);
      goto LAB_1;
    }
    W(3);
  }
  return 0;
}`;

  it('declines E6 when two sites have the same prefix (the statement before each entry)', () => {
    const r = run(SAMEPREFIX);
    assert.equal(gotos(r.out), 1, r.out);
  });

  // The tail would need a `continue` from a site whose innermost loop is another one.
  const WRONGLOOP = `int f(int a, int b, int c) {
  int n = 2;
  while (n-- > 0) {
    if (a) {
LAB_1:
      W(1);
    }
    else {
      int k = 2;
      while (k-- > 0) {
        if (b) goto LAB_1;
        W(2);
      }
      W(3);
    }
  }
  return 0;
}`;

  it('declines when the block cannot continue where it did', () => {
    const r = run(WRONGLOOP);
    assert.equal(gotos(r.out), 1, r.out);
  });

  // A shared arm tail in a switch: the goto comes from another arm of the same switch body.
  const SWITCH = `int f(int a, int b, int c) {
  int r = 0;
  switch (a + b) {
    case 0:
      W(1);
      if (c) goto LAB_1;
      W(2);
      break;
    case 1:
      W(3);
LAB_1:
      r = 5;
      break;
    case 2:
      W(4);
      break;
  }
  return r;
}`;

  it('switch: a terminator tail of another arm is copied into the arm that jumped to it (E4)', () => {
    const r = run(SWITCH);
    assert.equal(gotos(r.out), 0, r.out);
    assert.match(r.out, /if \(c\) \{\s*r = 5;\s*break;\s*\}/);
    assert.equal((r.out.match(/case /g) ?? []).length, 3);
  });

  it('switch: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(SWITCH, run(SWITCH).out), '0');
  });

  // A goto three blocks deep that only skips the rest of its block: if (!c) { rest }.
  const SKIP = `int f(int a, int b, int c) {
  W(0);
  if (a) {
    W(1);
    if (b) {
      W(2);
      if (c) goto LAB_1;
      W(3);
    }
  }
LAB_1:
  W(4);
  W(5);
  W(6);
  W(7);
  return 0;
}`;

  it('skip: a deep goto to the statement after its blocks becomes if (!c) { rest }', () => {
    const r = run(SKIP);
    assert.equal(gotos(r.out), 0, r.out);
    assert.match(r.out, /W\(2\);\s*if \(!c\) \{\s*W\(3\);\s*\}/);
    assert.equal((r.out.match(/W\(4\)/g) ?? []).length, 1);
  });

  it('skip: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(SKIP, run(SKIP).out), '0');
  });

  // A goto that skips the rest of its arm AND the statement after the if (the join): the
  // join is sunk into the arms, then the goto only skips. One arm falls through, so the
  // join moves; no copy.
  const SINKMOVE = `int f(int a, int b, int c) {
  if (a) {
    W(1);
    if (b) goto LAB_1;
    W(2);
  }
  else {
    W(3);
    return 3;
  }
  W(4);
LAB_1:
  W(5);
  W(6);
  W(7);
  W(8);
  return 0;
}`;

  it('sink: a join after an if moves into the one arm that reaches it, then the goto skips', () => {
    const r = run(SINKMOVE);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.copies, 0);
    assert.match(r.out, /if \(!b\) \{\s*W\(2\);\s*W\(4\);\s*\}/);
    assert.equal((r.out.match(/W\(4\)/g) ?? []).length, 1);
  });

  it('sink (move): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(SINKMOVE, run(SINKMOVE).out), '0');
  });

  // The join is reached from both arms. It would be copied into each only with evidence, and
  // a one-statement join the skip jumps past is the class the 2026-10-20 audit refuted (the
  // source wrote `if (!b) { v += W(3); } W(v);` once): nothing else enters its end, so no
  // A2, and a sunk join has no instruction facts of its own - the goto stays.
  const SINKCOPY = `int f(int a, int b, int c) {
  int v = 0;
  if (a) {
    v = W(1);
  }
  else {
    v = W(2);
    if (b) goto LAB_1;
    v = v + W(3);
  }
  W(v);
LAB_1:
  W(9);
  W(10);
  W(11);
  W(12);
  return v;
}`;

  it('sink: a one-statement join with no evidence is not copied (E6 rule 1)', () => {
    const r = run(SINKCOPY);
    assert.equal(gotos(r.out), 1, r.out);
    assert.equal(r.copies, 0);
    assert.equal((r.out.match(/W\(v\);/g) ?? []).length, 1);
  });

  it('sink: even with instruction facts for the label (they describe the skip, not the join)', () => {
    const r = run(SINKCOPY, { LAB_1: { back: 1, first: 'JZ', pushedArgs: false } });
    assert.equal(r.copies, 0);
  });

  it('sink: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(SINKCOPY, run(SINKCOPY).out), '0');
  });

  // A join of five statements reached from two arms: no evidence, nothing is sunk.
  const SINKNO = SINKCOPY.replace('  W(v);\n', '  W(v);\n  W(v + 1);\n  W(v + 2);\n  W(v + 3);\n  W(v + 4);\n');

  it('sink: declines a long join reached from two arms', () => {
    const r = run(SINKNO);
    assert.equal(gotos(r.out), 1, r.out);
  });

  it('the harness catches a block put on the wrong path', { skip: !hasNativeGpp() }, () => {
    const wrong = run(E6).out.replace('if (b == 0)', 'if (b != 0)');
    assert.notEqual(same(E6, wrong), '0');
  });
});

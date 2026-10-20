/**
 * Exact rewrites (goto-cleanup/exact.ts): RETARGET and MOVE, no code copied. Each fires on
 * its shape and declines one fact away from it; every accepted output is also executed as a
 * control skeleton against its input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, CompoundStmt, FunctionDecl } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { hasNativeGpp } from '../../../testing/native-cpp.js';
import { runSkeletons } from '../../../testing/skeleton.js';

function body(src: string) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  return (tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!.body as CompoundStmt).statements;
}

function run(src: string) {
  resetGotoCleanupStats();
  const out = emit(gotoCleanupPlugin.createTransformer()(parse(src)) as AnyNode).trim();
  const stats = getGotoCleanupStats();
  if (hasNativeGpp()) {
    const [r] = runSkeletons([{ name: 'x', before: body(src), after: body(out) }]);
    assert.ok(r.ok, `skeleton disagrees: ${r.detail}\n${out}`);
  }
  return { out, stats };
}

describe('exact: goto to the empty latch -> continue', () => {
  it('do-while: the continue runs the condition, as falling off the body did', () => {
    const { out, stats } = run(`void f(int a, int b) {
  do {
    switch (b) {
    case 1:
      y();
      goto LAB_1;
    case 2:
      z();
      break;
    }
    x();
    LAB_1: ;
  } while (a);
}`);
    assert.match(out, /case 1:\s*y\(\);\s*continue;/);
    assert.match(out, /x\(\);\s*\} while \(a\);/);
    assert.equal(stats.latchContinue, 1);
  });
  it('declines when the goto sits in an inner loop (continue would bind there)', () => {
    const { out, stats } = run(`void f(int a, int b) {
  do {
    while (b) { if (c()) goto LAB_1; y(); }
    x();
    LAB_1: ;
  } while (a);
}`);
    assert.equal(stats.latchContinue, 0);
    assert.match(out, /goto LAB_1;/);
  });
});

describe('exact: switch arms', () => {
  it('a goto into the start of the next arm becomes fallthrough', () => {
    const { out, stats } = run(`void f(int a) {
  switch (a) {
  case 1:
    x();
    goto LAB_2;
  case 2:
  LAB_2:
    y();
    break;
  }
}`);
    assert.doesNotMatch(out, /goto|LAB_2/);
    assert.match(out, /case 1:\s*x\(\);\s*case 2:\s*y\(\);/);
    assert.equal(stats.nextCase, 1);
  });
  it('an arm that is only a goto stacks its case label on the target arm', () => {
    const { out, stats } = run(`void f(int a) {
  switch (a) {
  case 2:
  LAB_2:
    y();
    break;
  case 5:
    z();
    break;
  case 7:
    goto LAB_2;
  }
}`);
    assert.doesNotMatch(out, /goto/);
    assert.match(out, /case 7:\s*case 2:\s*y\(\);/);
    assert.equal(stats.stackCase, 1);
  });
  it('declines stacking when the previous arm falls into the goto arm', () => {
    const { out, stats } = run(`void f(int a) {
  switch (a) {
  case 2:
  LAB_2:
    y();
    break;
  case 5:
    z();
  case 7:
    goto LAB_2;
  }
}`);
    assert.equal(stats.stackCase, 0);
    assert.match(out, /z\(\);\s*case 7:/);
  });
});

describe('exact: a rotated loop entered at its middle', () => {
  it('goto L; do { A; L: B } while (C) -> while (true) { B; if (!C) break; A; }', () => {
    const { out, stats } = run(`void f(int a) {
  goto LAB_1;
  do {
    x();
  LAB_1:
    y();
  } while (a);
  z();
}`);
    assert.doesNotMatch(out, /goto/);
    assert.match(out, /while \(true\) \{\s*y\(\);\s*if \(!a\)\s*break;\s*x\(\);\s*\}\s*z\(\);/);
    assert.equal(stats.rotatedEntry, 1);
  });
  it('goto L; do { A; L: } while (C) -> while (C) { A }', () => {
    const { out } = run(`void f(int a) {
  goto LAB_1;
  do {
    x();
  LAB_1: ;
  } while (a);
}`);
    assert.match(out, /while \(a\) \{\s*x\(\);\s*\}/);
  });
  it('declines when the body continues (it would go to the top, not the test)', () => {
    const { stats } = run(`void f(int a, int b) {
  goto LAB_1;
  do {
    if (b) continue;
    x();
  LAB_1:
    y();
  } while (a);
}`);
    assert.equal(stats.rotatedEntry, 0);
  });
});

describe("exact: Ghidra's if (false) arm moved into its switch", () => {
  it('the default that is only a goto becomes the block', () => {
    const { out, stats } = run(`void f(int a) {
  if (false) {
  LAB_9:
    handle(a);
  } else {
    switch (a) {
    case 1:
      x();
      break;
    case 2:
      y();
      goto LAB_9;
    default:
      goto LAB_9;
    }
  }
  z();
}`);
    assert.doesNotMatch(out, /if \(false\)/);
    assert.match(out, /default:\s*(LAB_9:\s*)?handle\(a\);\s*break;/);
    assert.equal(stats.ifFalseArm, 1);
  });
  it('declines when the block is entered from outside the switch', () => {
    const { stats } = run(`void f(int a) {
  if (a > 9) goto LAB_9;
  if (false) {
  LAB_9:
    handle(a);
  } else {
    switch (a) {
    case 1:
      goto LAB_9;
    }
  }
}`);
    assert.equal(stats.ifFalseArm, 0);
  });
});

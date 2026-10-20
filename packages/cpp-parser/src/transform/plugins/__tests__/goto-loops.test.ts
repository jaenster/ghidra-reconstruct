/**
 * Loop rewrites (goto-cleanup/loops.ts, design step 7): a goto that is a loop's own control
 * becomes `continue`, a `for` header or `break`.
 *
 * Every shape is compiled as written and as rewritten and run over every input, each work
 * statement recording itself, so a `continue` that skips or repeats the increment, an exit
 * moved to the wrong path, or an extra evaluation of a condition with an effect is a
 * mismatch. Decline cases pin what is not done. The entry lemma has its own exhaustive test,
 * shown to catch a broken variant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { Expr } from '../../../ast/factory.js';
import type { AnyNode, Expression } from '../../../ast/nodes.js';
import { gotoCleanupPlugin, getGotoCleanupStats, resetGotoCleanupStats } from '../builtins/goto-cleanup/index.js';
import { entryHolds, type Facts } from '../builtins/goto-cleanup/loops.js';
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

describe('loops: a goto to the loop head becomes continue', () => {
  // `L: while (C)` - a goto L inside re-tests C, exactly as `continue` does.
  const HEAD = `int f(int a, int b, int c) {
  int i = 0;
LAB_1:
  while (i < 3 + a) {
    i = i + 1;
    W(i);
    switch (W(i & 3)) {
      case 1: goto LAB_1;
      case 2: W(20); break;
    }
    W(30);
  }
  return i;
}`;

  it('headContinue: `L: while (C)`, the goto from inside a switch is continue', () => {
    const r = run(HEAD);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.headContinue, 1);
    assert.match(r.out, /case 1:\s*continue;/);
  });
  it('headContinue: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(HEAD, run(HEAD).out), '0');
  });

  // A goto to the top of a bottom-tested loop skips its test: the loop is `while (true)`
  // with the test as the last statement, the goto `continue`.
  const TOP = `int f(int a, int b, int c) {
  int i = 0;
LAB_1:
  do {
    i = i + 1;
    W(i);
    if ((i & 1) == b) {
      W(50);
      goto LAB_1;
    }
    W(60);
  } while (i < 4 + c);
  return i;
}`;

  it('topContinue: a second back edge to the top of a do-while', () => {
    const r = run(TOP);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.topContinue, 1);
    assert.match(r.out, /while \(true\) \{[^]*continue;[^]*if \(!\(i < 4 \+ c\)\)\s*break;\s*\}/);
  });
  it('topContinue: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(TOP, run(TOP).out), '0');
  });

  it('declines a do-while whose body already continues (that continue meant the test)', () => {
    const src = TOP.replace('    W(60);', '    if (W(a) == 3) continue;\n    W(60);');
    const r = run(src);
    assert.equal(r.st.topContinue, 0);
    assert.equal(gotos(r.out), 1, r.out);
  });

  it('declines a for with an increment: re-entering at its label re-runs the init', () => {
    const src = `int f(int a, int b, int c) {
  int i;
LAB_1:
  for (i = 0; i < 3; i++) {
    switch (W(i)) { case 1: goto LAB_1; }
  }
  return i;
}`;
    const r = run(src);
    assert.equal(r.st.headContinue + r.st.topContinue, 0);
  });
});

describe('loops: a goto to the increment makes the loop a for', () => {
  // Form A: `while (C) { ..goto L..; L: I; }`.
  const WHILE = `int f(int a, int b, int c) {
  int i;
  i = 0;
  while (i < 3 + a) {
    switch (W(i & 3)) {
      case 1: goto LAB_1;
      case 2: W(20); break;
    }
    W(30);
LAB_1:
    i = i + 1;
  }
  return i;
}`;

  it('latchFor (while): for (i = 0; C; i = i + 1) with continue, the init absorbed', () => {
    const r = run(WHILE);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchFor, 1);
    assert.equal(r.st.latchForLemma, 0);
    assert.match(r.out, /for \(i = 0; i < 3 \+ a; i = i \+ 1\)/);
    assert.match(r.out, /case 1:\s*continue;/);
  });
  it('latchFor (while): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(WHILE, run(WHILE).out), '0');
  });

  // Form B: `while (true) { if (X) E; ..; L: I; }` - the exit moves after the for.
  const TOPTEST = `int f(int a, int b, int c) {
  int p;
  p = a;
  do {
    if (p > 5) {
      return W(p);
    }
    switch (W(p & 3)) {
      case 1: goto LAB_1;
      case 3: W(40); break;
    }
    W(41);
LAB_1:
    p = p + 1 + b;
  } while (true);
}`;

  it('latchFor (top test): for (p = a; p <= 5; p = p + 1 + b), the exit after the loop', () => {
    const r = run(TOPTEST);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchFor, 1);
    assert.match(r.out, /for \(p = a; p <= 5; p = p \+ 1 \+ b\)/);
    assert.match(r.out, /\}\s*return W\(p\);\s*\}/);
  });
  it('latchFor (top test): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(TOPTEST, run(TOPTEST).out), '0');
  });

  // Form C: a do-while whose condition holds on entry (constant init): the entry lemma.
  const DOCONST = `int f(int a, int b, int c) {
  int i;
  i = 0;
  do {
    switch (W(i + a)) {
      case 2: goto LAB_1;
      case 3: W(70); break;
    }
    W(71);
LAB_1:
    i++;
  } while (i < 3);
  return i;
}`;

  it('latchFor (do-while, constant init): for (i = 0; i < 3; i++) by the entry lemma', () => {
    const r = run(DOCONST);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchForLemma, 1);
    assert.match(r.out, /for \(i = 0; i < 3; i\+\+\)/);
  });
  it('latchFor (do-while, constant init): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(DOCONST, run(DOCONST).out), '0');
  });

  it('declines a do-while whose condition can be false on entry', () => {
    const r = run(DOCONST.replace('i = 0;', 'i = a;'));
    assert.equal(r.st.latchFor, 0);
    assert.equal(gotos(r.out), 1);
  });

  it('declines when the init is followed by a write to the counter', () => {
    const r = run(DOCONST.replace('  i = 0;\n', '  i = 0;\n  i = i + W(a);\n'));
    assert.equal(r.st.latchFor, 0);
  });

  // Form D: the exit test at the bottom, a guard before the loop (MSVC's rotated for):
  //   n = cnt; i = 0; if (0 >= cnt) return 0; while (true) { ..; L: i++; if (n <= i) return 0; }
  const GUARD = `int f(int a, int b, int c) {
  int n;
  int i;
  n = a;
  i = 0;
  if (0 >= a) {
    return 0;
  }
  while (true) {
    switch (W(i + b)) {
      case 1: goto LAB_1;
      case 2: W(80); break;
    }
    W(81);
LAB_1:
    i++;
    if (n <= i) {
      return W(i);
    }
  }
}`;

  it('latchFor (bottom test, guard): the guard through a copy proves the first test', () => {
    const r = run(GUARD);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchForLemma, 1);
    assert.match(r.out, /for \(; !\(n <= i\); i\+\+\)/);
    assert.match(r.out, /\}\s*return W\(i\);\s*\}/);
  });
  it('latchFor (bottom test, guard): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(GUARD, run(GUARD).out), '0');
  });

  // CUBE_MatchAndExecuteRecipe 005665f0: the same shape in a void function whose loop also
  // breaks - its exit `return;` is the fall-off of the function, so the breaks agree.
  const VOIDBRK = `void g(int a, int b, int c) {
  int n;
  int i;
  n = a;
  i = 0;
  if (0 >= a) {
    return;
  }
  while (true) {
    if (W(i + c) == 3) break;
    switch (W(i + b)) {
      case 1: goto LAB_1;
      case 2: W(80); break;
    }
    W(81);
LAB_1:
    i++;
    if (n <= i) {
      return;
    }
  }
}
int f(int a, int b, int c) { g(a, b, c); return 0; }`;
  it('latchFor (void, breaks): the exit is the function end, the breaks reach it too', () => {
    const r = run(VOIDBRK);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchForLemma, 1);
  });
  it('latchFor (void, breaks): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(VOIDBRK, run(VOIDBRK).out), '0');
  });

  // The same loop as Ghidra prints it before comma-expand: the body's first test folded
  // into the while condition.
  const WHILECOMMA = VOIDBRK.replace('  while (true) {\n    if (W(i + c) == 3) break;\n', '  while (W(i + c) != 3) {\n');
  it('latchFor (while with a bottom exit): the while test becomes the body\'s first break', () => {
    const r = run(WHILECOMMA);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchForLemma, 1);
    assert.match(r.out, /for \(; !\(n <= i\); i\+\+\) \{\s*if \(W\(i \+ c\) == 3\)\s*break;/);
  });
  it('latchFor (while with a bottom exit): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(WHILECOMMA, run(WHILECOMMA).out), '0');
  });

  // CUBE_MatchAndExecuteRecipe 005665f0: the guard is an enclosing if, the loop ends its
  // then-arm, and the function's closing `return;` is where both exits arrive.
  const NESTED = `void g(int a, int b, int c) {
  int n;
  int i;
  int r;
  if (b != 3) {
    n = a;
    W(70);
    i = 0;
    if (0 < a) {
      while (r = W(i + c), r != 3) {
        switch (W(i + b)) {
          case 1: goto LAB_1;
          case 2: W(80); break;
        }
        W(81);
LAB_1:
        i = i + 1;
        if (n <= i) {
          return;
        }
      }
    }
  }
  return;
}
int f(int a, int b, int c) { g(a, b, c); return 0; }`;
  it('latchFor (nested guard, closing return): the for ends the arm, the comma test inverts inside', () => {
    const r = run(NESTED);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.latchForLemma, 1);
    assert.match(r.out, /for \(; !\(n <= i\); i = i \+ 1\) \{\s*if \(\(?r = W\(i \+ c\) , r == 3\)?\)\s*break;/, r.out);
  });
  it('latchFor (nested guard, closing return): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(NESTED, run(NESTED).out), '0');
  });
  it('declines when the code after the loop is not the function end', () => {
    const r = run(NESTED.replace('  }\n  return;\n}\nint f', '  }\n  W(90);\n  return;\n}\nint f'));
    assert.equal(r.st.latchForLemma, 0);
  });

  it('declines when a call between the guard and the loop could change what the guard read', () => {
    const r = run(GUARD.replace('  while (true) {', '  W(a);\n  while (true) {').replace('n = a;', 'n = g;').replace('0 >= a', '0 >= g'));
    assert.equal(r.st.latchForLemma, 0);
  });

  it('declines a latch the body already continues to (it meant the test)', () => {
    const r = run(WHILE.replace('    W(30);', '    if (W(c) == 2) continue;\n    W(30);'));
    assert.equal(r.st.latchFor, 0);
  });

  it('declines a goto to the latch from inside a nested loop (continue would bind there)', () => {
    const src = `int f(int a, int b, int c) {
  int i = 0;
  while (i < 3 + a) {
    while (W(i) < b) {
      if (W(40) == c) goto LAB_1;
      i = i + 1;
    }
LAB_1:
    i = i + 1;
  }
  return i;
}`;
    const r = run(src);
    assert.equal(r.st.latchFor, 0);
  });
});

describe('loops: two exits, the one laid out after the loop goes back to its breaks', () => {
  // Two jumps to a five-statement block (no evidence to copy it, so no move either) and
  // one break to the block after the loop: that block goes back to the break, the jumps
  // become breaks.
  const SWAP = `int f(int a, int b, int c) {
  int i = 0;
  while (true) {
    i = i + 1;
    if (i > 2 + a) break;
    if (W(i + b) == 2) goto LAB_1;
    W(90);
    if (W(i + c) == 3) goto LAB_1;
  }
  W(100);
  return 1;
LAB_1:
  W(200);
  W(201);
  W(202);
  W(203);
  return 2;
}`;

  it('exitSwap: the break gets the block after the loop, the goto becomes break', () => {
    const r = run(SWAP);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.exitSwap, 2);
    assert.match(r.out, /if \(i > 2 \+ a\) \{\s*W\(100\);\s*return 1;\s*\}/);
    assert.match(r.out, /if \(W\(i \+ b\) == 2\)\s*break;/);
    assert.equal((r.out.match(/W\(200\)/g) ?? []).length, 1);
  });

  it('declines when the block after the loop falls into the label', () => {
    const r = run(SWAP.replace('  W(100);\n  return 1;\n', '  W(100);\n'));
    assert.equal(r.st.exitSwap, 0);
  });

  it('exitSwap: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(SWAP, run(SWAP).out), '0');
  });
});

describe('loops: the block after an infinite loop that jumps back into it', () => {
  // COMPRESS_EncodeBuffer 0041f850: the break's block was laid out after the loop and ends
  // by jumping back into the body - it goes back to the break (one break: a move).
  const MOVE = `int f(int a, int b, int c) {
  int i = 0;
  while (true) {
    if (i > 3 + a) {
      return W(i);
    }
    i = i + 1;
    if (W(i + b) == 2) break;
    W(50);
LAB_1:
    W(55);
    if (W(i + c) & 1) {
      W(60);
    }
  }
  W(70);
  goto LAB_1;
}`;

  it('exitMove: the block goes to the break, its jump stays inside the loop', () => {
    const r = run(MOVE);
    assert.equal(r.st.exitMove, 1);
    assert.match(r.out, /if \(W\(i \+ b\) == 2\) \{\s*W\(70\);/);
    assert.equal((r.out.match(/W\(70\)/g) ?? []).length, 1);
  });
  it('exitMove: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(MOVE, run(MOVE).out), '0');
  });
  it('declines a loop with two breaks (the block would be copied, and it ends in a goto)', () => {
    const r = run(MOVE.replace('    W(50);\n', '    if (W(a) == 3) break;\n    W(50);\n'));
    assert.equal(r.st.exitMove, 0);
  });
});

describe('loops: the exit block a search loop keeps inside its body', () => {
  // ROSTER_IsUnitHostileToPlayer 004791b0: both exits of the search reach one block that
  // Ghidra printed inside the not-found arm; it is the code after the loop.
  const HOIST = `int f(int a, int b, int c) {
  int g = a;
  int p = 3 + b;
  do {
    if (!p) {
      g = -1;
LAB_1:
      W(g);
      if (W(c) == 2) {
        return 1;
      }
      return W(g + 5);
    }
    if (W(p) == a) {
      g = W(p + 10);
      goto LAB_1;
    }
    p = p - 1;
  } while (true);
}`;

  it('exitHoist: the block goes after the loop, both ways into it become break', () => {
    const r = run(HOIST);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.exitHoist, 1);
    assert.match(r.out, /g = -1;\s*break;/);
    assert.match(r.out, /\} while \(true\);\s*W\(g\);/);
  });
  it('exitHoist: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(HOIST, run(HOIST).out), '0');
  });
  it('declines a loop that already breaks (the code after it is another exit)', () => {
    const r = run(HOIST.replace('    p = p - 1;', '    if (W(c) == 3) break;\n    p = p - 1;').replace('  } while (true);\n}', '  } while (true);\n  return 7;\n}'));
    assert.equal(r.st.exitHoist, 0);
  });
});

describe('loops: a loop entered only in its middle', () => {
  // D2WINFONT_WordWrapString 00502970: nothing falls into the loop (a goto skips it), and
  // the only way in is a jump to the test MSVC rotated into the middle of the body.
  const ROT = `int f(int a, int b, int c) {
  int n = 4 + a;
  int k = 0;
  if (W(b) == 1) {
    k = W(2);
    goto LAB_1;
  }
  goto LAB_2;
  while (true) {
    n = n - 1;
    k = k + 1;
    if (n <= c) break;
LAB_1:
    if (W(n + k) == 3) break;
  }
LAB_2:
  return W(n);
}`;

  it('rotateEntry: the loop starts at the label, the jump into it is gone', () => {
    const r = run(ROT);
    assert.equal(gotos(r.out), 0, r.out);
    assert.equal(r.st.rotateEntry, 1);
    assert.match(r.out, /while \(true\) \{\s*if \(W\(n \+ k\) == 3\)\s*break;\s*n = n - 1;/);
  });
  it('rotateEntry: compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(ROT, run(ROT).out), '0');
  });
  // A do-while entered in the middle: its test runs after the part below the label.
  const ROTDO = ROT.replace('  while (true) {', '  do {').replace('    if (W(n + k) == 3) break;\n  }', '    if (W(n + k) == 3) break;\n  } while (W(k) != 2);');
  it('rotateEntry (do-while): the test goes between the two halves', () => {
    const r = run(ROTDO);
    assert.equal(r.st.rotateEntry, 1);
    assert.match(r.out, /if \(W\(k\) == 2\)\s*break;/);
  });
  it('rotateEntry (do-while): compiled, same behaviour', { skip: !hasNativeGpp() }, () => {
    assert.equal(same(ROTDO, run(ROTDO).out), '0');
  });
  it('declines a loop that is also entered from its top', () => {
    const r = run(ROT.replace('  goto LAB_2;\n', ''));
    assert.equal(r.st.rotateEntry, 0);
  });
});

describe('the entry lemma', () => {
  // Every (guard, init, condition) over a small domain: entryHolds may say true only when
  // the condition holds for every x the guard allows, false only when it holds for none.
  const OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
  const K = [0, 1, 2, 5];
  const id = (n: string) => Expr.identifier(n) as Expression;
  const lit = (k: number) => Expr.intLiteral(k) as Expression;
  const cmp = (l: Expression, op: string, r: Expression) => Expr.binary(l, op as never, r) as Expression;
  const evalOp = (x: number, op: string, k: number) => ({ '<': x < k, '<=': x <= k, '>': x > k, '>=': x >= k, '==': x === k, '!=': x !== k } as Record<string, boolean>)[op];

  function mismatches(impl: (c: Expression, f: Facts) => boolean | null): number {
    let bad = 0;
    for (const gop of OPS) for (const gk of K) for (const neg of [false, true]) {
      for (const cop of OPS) for (const ck of K) for (const litLeft of [false, true]) {
        // The guard is on `n`; C on `m`, a copy of `n`.
        const facts: Facts = {
          consts: new Map(), copies: [['m', 'n']],
          guards: [{ e: cmp(id('n'), gop, lit(gk)), neg }],
        };
        const c = litLeft ? cmp(lit(ck), ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' } as Record<string, string>)[cop], id('m')) : cmp(id('m'), cop, lit(ck));
        const got = impl(c, facts);
        const xs = Array.from({ length: 40 }, (_, i) => i - 10).filter(x => evalOp(x, gop, gk) !== neg);
        if (!xs.length) continue;
        const all = xs.every(x => evalOp(x, cop, ck)), none = xs.every(x => !evalOp(x, cop, ck));
        if (got === true && !all) bad++;
        if (got === false && !none) bad++;
      }
    }
    // Constant init: `i = K` then C over i.
    for (const k of [0, 1, 3]) for (const cop of OPS) for (const ck of K) {
      const facts: Facts = { consts: new Map([['i', BigInt(k)]]), copies: [], guards: [] };
      const got = impl(cmp(id('i'), cop, lit(ck)), facts);
      if (got !== null && got !== evalOp(k, cop, ck)) bad++;
    }
    return bad;
  }

  it('is sound over every guard, copy and constant init of the domain', () => {
    assert.equal(mismatches(entryHolds), 0);
  });

  it('decides the cases the loops need (not just "unknown" everywhere)', () => {
    let decided = 0;
    for (const gop of OPS) for (const cop of OPS) {
      const facts: Facts = { consts: new Map(), copies: [], guards: [{ e: cmp(id('n'), gop, lit(0)), neg: false }] };
      if (entryHolds(cmp(id('n'), cop, lit(0)), facts) !== null) decided++;
    }
    assert.ok(decided >= 12, `decided ${decided}`);
  });

  it('the check catches a broken lemma (one that answers "holds" when it cannot know)', () => {
    assert.ok(mismatches((c, f) => entryHolds(c, f) ?? true) > 0);
  });
  it('the check catches a lemma that drops the guard\'s negation', () => {
    assert.ok(mismatches((c, f) => entryHolds(c, { ...f, guards: f.guards.map(g => ({ ...g, neg: !g.neg })) })) > 0);
  });
});

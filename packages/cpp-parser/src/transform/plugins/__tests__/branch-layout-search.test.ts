import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, CompoundStmt, FunctionDecl, IfStmt, ASTNode } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { NodeKind } from '../../../ast/kinds.js';
import { branchLayoutPlugin } from '../builtins/branch-layout/index.js';
import { earlyReturnPlugin } from '../builtins/early-return.js';
import { LayoutReader, type BranchLayoutEvidence, type BranchEdge, type ReturnCopy } from '../builtins/branch-layout/evidence.js';
import { scoreBody, predictFall, predictContext } from '../builtins/branch-layout/predict.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** One edge: the if on `line`, its jump, target and fall-through, and the lines each leads to. */
function edge(line: number, jcc: number, target: number, fall: number, fallLines: number[], takenLines: number[]): BranchEdge {
  return { line, ord: 0, keyword: 'if', jcc, target, fall, fallLines, takenLines };
}

/**
 * Evidence where every line with code prints one offset (its line number), except the
 * `silent` ones (a return the original merged into another copy prints nothing), plus the edges.
 */
function evidence(code: string, edges: BranchEdge[], silent: number[] = []): BranchLayoutEvidence {
  const lines = new Map<number, number[]>();
  code.split('\n').forEach((t, i) => { if (/\w/.test(t) && !silent.includes(i + 1)) lines.set(i + 1, [i + 1]); });
  return { lines, ifs: new Map(edges.map(e => [e.line, e.jcc])), edges };
}

function run(code: string, edges: BranchEdge[], silent: number[] = []): { out: string; sites: string[] } {
  const sites: string[] = [];
  const t = branchLayoutPlugin.createTransformer({
    branchLayout: evidence(code, edges, silent), onSite: e => sites.push(e.rule),
  });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

function body(code: string): CompoundStmt {
  for (const n of traverseAST(parse(code) as ASTNode)) if (n.kind === NodeKind.FunctionDecl) return (n as FunctionDecl).body!;
  throw new Error('no function');
}

// The same function before and after, in two namespaces, called over `inputs`: they must agree.
function sameValues(before: string, after: string, calls: string[]): void {
  const prelude = [
    'static int gCalls = 0;',
    'static int* G(int* p) { gCalls++; return p[0] ? p + 1 : nullptr; }',
    'static int H(int* p) { gCalls += 10; return p[0]; }',
    `namespace ref { ${before} }`, `namespace low { ${after} }`,
  ].join('\n');
  const main = calls.map(c => [
    `{ gCalls = 0; int r = ref::${c}; int rc = gCalls; gCalls = 0; int l = low::${c}; int lc = gCalls;`,
    `  printf("%d %d %d %d\\n", r, l, rc, lc); }`,
  ].join('\n')).join('\n');
  const out = compileAndRun(prelude, main);
  for (const line of out.trim().split('\n')) {
    const [r, l, rc, lc] = line.split(' ');
    assert.strictEqual(l, r, `value differs: ${out}`);
    assert.strictEqual(lc, rc, `side effects differ: ${out}`);
  }
}

const INPUTS = [
  'f(nullptr)',
  'f(([]{ static int a[] = {0, 0}; return a; })())',
  'f(([]{ static int a[] = {1, 0, 0}; return a; })())',
  'f(([]{ static int a[] = {1, 7, 0}; return a; })())',
];

describe('branch-layout search - propagate', () => {
  const chain = [
    'int f(int* pUnit) {',          // 1
    '  if (!pUnit) {',              // 2
    '    return 0;',                // 3
    '  }',                          // 4
    '  int* pRoom = G(pUnit);',     // 5
    '  if (!pRoom) {',              // 6
    '    return 0;',                // 7
    '  }',                          // 8
    '  int nLevel = H(pRoom);',     // 9
    '  if (!nLevel) {',             // 10
    '    return 0;',                // 11
    '  }',                          // 12
    '  return nLevel + 1;',         // 13
    '}',
  ].join('\n');
  // Both early guards jump forward into the last guard's inline copy at 0x27.
  const threaded = [
    edge(2, 0x05, 0x27, 0x07, [5], [11]),
    edge(6, 0x15, 0x27, 0x17, [9], [11]),
    edge(10, 0x25, 0x30, 0x27, [11], [13]),
  ];

  it('writes the tested values as ternaries and keeps the last guard', () => {
    const { out, sites } = run(chain, threaded, [3, 7]);
    assert.deepStrictEqual(sites, ['propagate']);
    assert.ok(out.includes('int* pRoom = pUnit ? G(pUnit) : nullptr; int nLevel = pRoom ? H(pRoom) : 0; if (!nLevel) { return 0; } return nLevel + 1;'), out);
  });

  it('keeps the values and side effects', native, () => {
    const { out } = run(chain, threaded, [3, 7]);
    sameValues(chain, out, INPUTS);
  });

  it('leaves a chain whose guards each keep their own copy', () => {
    const local = [
      edge(2, 0x05, 0x07, 0x09, [3], [5]),
      edge(6, 0x15, 0x07, 0x17, [9], [3]),
      edge(10, 0x25, 0x07, 0x27, [13], [3]),
    ];
    assert.deepStrictEqual(run(chain, local).sites, []);
  });

  it('leaves a chain when a test outside it threads into the same copy', () => {
    const withOuter = [
      'int f(int* pUnit, int n) {',
      '  if (n > 3) {',
      '    return 0;',
      '  }',
      ...chain.split('\n').slice(1),
    ].join('\n');
    const shifted = threaded.map(e => ({ ...e, line: e.line + 3, fallLines: e.fallLines.map(l => l + 3), takenLines: e.takenLines.map(l => l + 3) }));
    const outer = edge(2, 0x01, 0x27, 0x03, [5], [14]);
    assert.deepStrictEqual(run(withOuter, [outer, ...shifted], [3, 6, 10]).sites, []);
  });

  it('leaves a chain whose return reads a value the chain sets', () => {
    const reads = chain.replace(/return 0;/g, 'return pRoom ? 1 : 0;');
    assert.deepStrictEqual(run(reads, threaded, [3, 7]).sites, []);
  });

  it('moves a definition before the value into the arm as a comma operand', native, () => {
    const two = [
      'int f(int* p) {',              // 1
      '  if (!p) {',                  // 2
      '    return 5;',                // 3
      '  }',                          // 4
      '  int i = p[0];',              // 5
      '  int* q = i > 0 ? p + i : nullptr;', // 6
      '  if (!q) {',                  // 7
      '    return 5;',                // 8
      '  }',                          // 9
      '  return *q + i;',             // 10
      '}',
    ].join('\n');
    const { out, sites } = run(two, [edge(2, 0x05, 0x27, 0x07, [5], [8]), edge(7, 0x25, 0x30, 0x27, [8], [10])], [3]);
    assert.deepStrictEqual(sites, ['propagate']);
    assert.ok(out.includes('int i; int* q = p ? (i = p[0], i > 0 ? p + i : nullptr) : nullptr;'), out);
    sameValues(two, out, INPUTS);
  });
});

describe('branch-layout search - return-merge', () => {
  const guard = [
    'int f(int n, int* p) {',      // 1
    '  if (n != 5) {',             // 2
    '    return 0;',               // 3
    '  }',                         // 4
    '  if (!p) {',                 // 5
    '    return 0;',               // 6
    '  }',                         // 7
    '  p[0] = 3;',                 // 8
    '  return 0;',                 // 9
    '}',
  ].join('\n');
  // The first guard falls into the second test and jumps to the final copy; the second
  // guard keeps an inline copy of its own.
  const nested = [edge(2, 0x05, 0x30, 0x07, [5], [9]), edge(5, 0x10, 0x18, 0x12, [6], [8])];

  it('nests the rest under the inverted guard', () => {
    const { out, sites } = run(guard, nested, [3]);
    assert.deepStrictEqual(sites, ['return-merge']);
    assert.ok(out.includes('if (n == 5) { if (!p) { return 0; } p[0] = 3; } return 0;'), out);
  });

  it('keeps the values and side effects', native, () => {
    const { out } = run(guard, nested, [3]);
    const f = (n: number, arr: string) => `f(${n}, ${arr})`;
    sameValues(guard.replace('p[0] = 3;', 'p[0] = 3; gCalls++;'), out.replace('p[0] = 3;', 'p[0] = 3; gCalls++;'),
      [f(5, 'nullptr'), f(4, 'nullptr'), f(5, '([]{ static int a[] = {1}; return a; })()')]);
  });

  it('leaves the guard when its jump lands elsewhere than the final copy', () => {
    const other = [edge(2, 0x05, 0x12, 0x07, [5], [6]), nested[1]];
    assert.deepStrictEqual(run(guard, other, [3]).sites, []);
  });

  it('leaves a guard whose rest holds a label something jumps to', () => {
    const labelled = guard.replace('  p[0] = 3;', '  L: p[0] = 3;').replace('int f(int n, int* p) {', 'int f(int n, int* p) { if (n == 9) goto L;');
    assert.deepStrictEqual(run(labelled, nested, [3]).sites.filter(s => s === 'return-merge'), []);
  });
});

describe('branch-layout predict', () => {
  const at = (code: string, edges: BranchEdge[]) => {
    const b = body(code);
    return scoreBody(b, new LayoutReader(evidence(code, edges), b), new Set(['exit']));
  };

  it('a guard whose block ends with the same return jumps to that copy', () => {
    const code = 'int f(int* p) {\n  if (!p) {\n    return 0;\n  }\n  p[0] = 1;\n  return 0;\n}';
    assert.strictEqual(at(code, [edge(2, 5, 0x20, 7, [5], [6])]).objective, 0);
    assert.strictEqual(at(code, [edge(2, 5, 0x20, 7, [3], [5])]).objective, 1);
  });

  it('a bare return and a bare goto are taken', () => {
    const b = body('void f(int a) {\n  if (a) {\n    return;\n  }\n  if (a > 2) goto L;\n  g();\n  L: h();\n}');
    const ctx = predictContext(b, new Set<string>());
    const ifs = b.statements.filter(s => s.kind === NodeKind.IfStmt) as IfStmt[];
    assert.strictEqual(predictFall(ifs[0], { list: b.statements, index: 0, inLoop: false }, ctx)?.fall, 'other');
    assert.strictEqual(predictFall(ifs[1], { list: b.statements, index: 1, inLoop: false }, ctx)?.fall, 'other');
  });

  it('an || if/else falls into the else-arm', () => {
    const code = 'int f(int a, int b) {\n  if (a || b) {\n    g();\n  } else {\n    h();\n  }\n  return 0;\n}';
    assert.strictEqual(at(code, [edge(2, 5, 0x10, 7, [5], [3])]).objective, 0);
    assert.strictEqual(at(code, [edge(2, 5, 0x10, 7, [3], [5])]).objective, 1);
  });

  it('a leaving arm inside a loop is sunk unless it ends the loop body', () => {
    const sunk = 'int f(int* p) {\n  while (*p) {\n    if (p[1]) {\n      return 1;\n    }\n    p++;\n  }\n  return 0;\n}';
    assert.strictEqual(at(sunk, [edge(3, 5, 0x30, 7, [6], [4])]).objective, 0);
    const last = 'int f(int* p) {\n  while (*p) {\n    p++;\n    if (p[1]) {\n      return 1;\n    }\n  }\n  return 0;\n}';
    assert.strictEqual(at(last, [edge(4, 5, 0x30, 7, [5], [3])]).sites, 0);
  });

  it('the last test of an endless loop is its bottom test: it falls into the arm (0040f470)', () => {
    const code = 'void f(int* p) {\n  int i = 0;\n  do {\n    p[i] = 0;\n    i++;\n    if (7 < i) {\n      return;\n    }\n  } while (true);\n}';
    const s = at(code, [edge(6, 6, 0x10, 7, [7], [4, 5, 6])]);
    assert.deepStrictEqual([s.sites, s.objective], [1, 0]);
    assert.strictEqual(at(code, [edge(6, 6, 0x10, 7, [4], [7])]).objective, 1);
  });

  it('an arm holding a label something jumps to is not predicted (004e9870)', () => {
    const code = 'void f(int a) {\n  if (a > 9) goto L;\n  if (a < 6) {\n  L:\n    g(1);\n  } else {\n    g(2);\n  }\n  h();\n}';
    const s = at(code, [edge(3, 3, 0x20, 4, [7], [5])]);
    assert.strictEqual(s.objective, 0);
    assert.ok(s.abstained.some(x => x.line === 3 && x.rule === 'jumped label'));
  });

  it('two arms with the same code and the same successor are one tail: not predicted (0054a510)', () => {
    const code = 'void f(int a, int b) {\n  if (a) {\n    g(1);\n    return;\n  }\n  if (b) {\n    g(1);\n    return;\n  }\n  h();\n}';
    const s = at(code, [edge(2, 2, 0x20, 3, [3, 4], [6]), edge(6, 6, 0x3, 7, [10], [7, 8])]);
    assert.deepStrictEqual([s.sites, s.objective, s.abstained.length], [0, 0, 2]);
    // The same code going to different places is two tails: predicted.
    const apart = 'void f(int a, int b) {\n  if (a) {\n    g(1);\n  }\n  h();\n  if (b) {\n    g(1);\n  }\n  k();\n}';
    assert.strictEqual(at(apart, [edge(2, 2, 0x20, 3, [3], [5]), edge(6, 6, 0x30, 7, [7], [9])]).sites, 2);
  });

  it('an if a pass split off a short-circuit condition does not own its line\'s jump (00416160)', () => {
    const code = 'int f(int a, int* p) {\n  if (!a) {\n    g(0);\n    return 0;\n  }\n  g(1);\n  return p[0];\n}';
    const ev = { ...evidence(code, [edge(2, 2, 0x20, 3, [6, 7], [3, 4])]), operands: new Map([[2, [[2], [2]]]]) };
    const b = body(code);
    assert.strictEqual(new LayoutReader(ev, b).edge(b.statements[0] as IfStmt), null);
    const one = { ...ev, operands: new Map([[2, [[2]]]]) };
    assert.notStrictEqual(new LayoutReader(one, b).edge(b.statements[0] as IfStmt), null);
  });
});

describe('branch-layout search - swap and nest', () => {
  const ifElse = [
    'int f(int* p) {',              // 1
    '  if (!p) {',                  // 2
    '    return 0;',                // 3
    '  }',                          // 4
    '  if (p[0] == 0) {',           // 5
    '    p[1] = H(p);',             // 6
    '  } else {',                   // 7
    '    p[1] = 5;',                // 8
    '  }',                          // 9
    '  return p[1];',               // 10
    '}',
  ].join('\n');
  // The second if falls into the else-arm: the source tested the other way round.
  const elseFirst = [edge(2, 0x02, 0x40, 0x04, [3], [5]), edge(5, 0x06, 0x20, 0x08, [8], [6])];

  it('swaps an if/else whose jump falls into the else-arm', () => {
    const { out, sites } = run(ifElse, elseFirst);
    assert.deepStrictEqual(sites, ['swap']);
    assert.ok(out.includes('if (p[0] != 0) { p[1] = 5; } else { p[1] = H(p); }'), out);
  });

  it('keeps the values and side effects of the swap', native, () => {
    sameValues(ifElse, run(ifElse, elseFirst).out, INPUTS);
  });

  it('leaves an if/else whose jump falls into the then-arm', () => {
    assert.deepStrictEqual(run(ifElse, [edge(2, 0x02, 0x40, 0x04, [3], [5]), edge(5, 0x06, 0x20, 0x08, [6], [8])]).sites, []);
  });

  it('leaves an if/else whose arm holds a label something jumps to: the predictor abstains there', () => {
    const labelled = ifElse.replace('    p[1] = 5;', '  L:\n    p[1] = 5;').replace('  if (!p) {', '  if (!p) {\n    goto L;').replace('    return 0;\n', '');
    // Lines: 2 if(!p), 3 goto, 4 }, 5 if, 6 then, 7 else, 8 label, 9 p[1]=5.
    const e = [edge(5, 0x06, 0x20, 0x08, [9], [6])];
    assert.ok(!run(labelled, e).sites.includes('swap'));
  });

  const guard = [
    'int f(int* p) {',              // 1
    '  if (!p) {',                  // 2
    '    return 0;',                // 3
    '  }',                          // 4
    '  if (p[0] == 0) {',           // 5
    '    return 7;',                // 6
    '  }',                          // 7
    '  p[1] = H(p);',               // 8
    '  return p[1] + 1;',           // 9
    '}',
  ].join('\n');
  // The guard's jump goes to its own arm, after the rest: the source nested the rest.
  const nested = [edge(2, 0x02, 0x40, 0x04, [3], [5]), edge(5, 0x06, 0x20, 0x08, [8], [6])];

  it('nests the rest under a guard whose own arm the original laid out after it', () => {
    const { out, sites } = run(guard, nested);
    assert.deepStrictEqual(sites, ['nest']);
    assert.ok(out.includes('if (p[0] != 0) { p[1] = H(p); return p[1] + 1; } return 7;'), out);
  });

  it('keeps the values and side effects of the nest', native, () => {
    sameValues(guard, run(guard, nested).out, INPUTS);
  });

  it('leaves a guard whose arm the original laid out inline', () => {
    assert.deepStrictEqual(run(guard, [edge(2, 0x02, 0x40, 0x04, [3], [5]), edge(5, 0x06, 0x20, 0x08, [6], [8])]).sites, []);
  });
});

describe('early-return - a guard that jumps back into an earlier copy stays a guard', () => {
  const code = [
    'int f(int* p) {',              // 1
    '  int c = p ? p[0] : 0;',      // 2
    '  switch (c) {',               // 3
    '  case 1:',                    // 4
    '    return 0;',                // 5
    '  }',                          // 6
    '  if (c <= 32) {',             // 7
    '    return 0;',                // 8
    '  }',                          // 9
    '  return c < 127;',            // 10
    '}',
  ].join('\n');
  const flip = (target: number) => {
    const ev = { ...evidence(code, [edge(7, 0x29, target, 0x2b, [10], [8])]), returns: [{ start: 0x21, ret: 0x24, insns: ['XOR/EAX', 'POP/EBP', 'RET'] }] };
    return flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: ev })(parse(code)) as AnyNode));
  };

  it('keeps the decompile\'s guard when its jump lands back on the switch\'s copy (0042fe70)', () => {
    assert.ok(flip(0x21).includes('if (c <= 32) { return 0; } return c < 127;'), flip(0x21));
  });

  it('turns it around as before when the jump goes forward', () => {
    assert.ok(flip(0x40).includes('if (c > 32) return c < 127; return 0;'), flip(0x40));
  });

  it('the turned-around form keeps the values', native, () => {
    sameValues(code, flip(0x40), [...INPUTS, 'f(([]{ static int a[] = {40}; return a; })())', 'f(([]{ static int a[] = {1}; return a; })())', 'f(([]{ static int a[] = {200}; return a; })())']);
  });
});

describe('a return copy that loads its own value: the source had no guard', () => {
  const nestedForm = [
    'int f(int* p) {',              // 1
    '  if (!p) {',                  // 2
    '    return 0;',                // 3
    '  }',                          // 4
    '  if (p[0] != 0) {',           // 5
    '    p[1] = 3;',                // 6
    '  }',                          // 7
    '  return 1;',                  // 8
    '}',
  ].join('\n');
  const ev = (insns: string[]) => ({
    ...evidence(nestedForm, [edge(2, 0x02, 0x08, 0x04, [3], [5]), edge(5, 0x12, 0x1e, 0x14, [6], [8])]),
    returns: [{ start: 0x1e, ret: 0x24, insns }],
  });
  const flatten = (insns: string[]) => flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: ev(insns) })(parse(nestedForm)) as AnyNode));

  it('early-return keeps `if (C) { S } return K;` when the jump lands on the load of K (004e1740)', () => {
    assert.ok(flatten(['MOV/EAX', 'POP/ESI', 'RET']).includes('if (p[0] != 0) { p[1] = 3; } return 1;'), flatten(['MOV/EAX', 'POP/ESI', 'RET']));
  });

  // The body cannot leave and the test falls into it: Ghidra's single exit, kept whatever
  // the copy holds (early-return's gate for a body that cannot leave).
  it('and keeps the single exit when the copy holds no load', () => {
    assert.ok(flatten(['POP/ESI', 'RET']).includes('if (p[0] != 0) { p[1] = 3; } return 1;'), flatten(['POP/ESI', 'RET']));
  });

  it('the kept form keeps the values', native, () => {
    sameValues(nestedForm, flatten(['POP/ESI', 'RET']), INPUTS);
  });

  it('the predictor counts a guard whose jump lands on its value\'s load', () => {
    const guardForm = [
      'int f(int* p) {',            // 1
      '  if (!p) {',                // 2
      '    return 0;',              // 3
      '  }',                        // 4
      '  if (p[0] == 0) {',         // 5
      '    return 1;',              // 6
      '  }',                        // 7
      '  p[1] = 3;',                // 8
      '  return 1;',                // 9
      '}',
    ].join('\n');
    const score = (insns: string[]) => {
      const b = body(guardForm);
      const e = { ...evidence(guardForm, [edge(2, 0x02, 0x08, 0x04, [3], [5]), edge(5, 0x12, 0x1e, 0x14, [8], [6, 9])]), returns: [{ start: 0x1e, ret: 0x24, insns }] };
      return scoreBody(b, new LayoutReader(e, b), new Set()).objective;
    };
    assert.strictEqual(score(['MOV/EAX', 'POP/ESI', 'RET']), 1);
    assert.strictEqual(score(['POP/ESI', 'RET']), 0);
  });
});

/**
 * Identical constant returns share one copy (predict.ts): inline at the first guard when every
 * one is a simple or `&&` guard, at the end when one is an `||` guard or ends the body.
 */
describe('branch-layout predict - merged return copy', () => {
  const groupsOf = (code: string) => {
    const b = body(code);
    const ctx = predictContext(b, new Set());
    return { b, ctx, groups: [...new Set(ctx.returnGroups.values())] };
  };
  const guards = (b: CompoundStmt) => [...traverseAST(b as ASTNode)].filter(n => n.kind === NodeKind.IfStmt) as IfStmt[];

  it('puts the copy inline at the first of three simple guards (GetStateFlags)', () => {
    const { b, ctx, groups } = groupsOf([
      'int* f(U* pUnit) {',
      '  if (!pUnit) { return nullptr; }',
      '  SX* p = pUnit->pStatsEx;',
      '  if (!p) { return nullptr; }',
      '  if (!(p->nFlags & 0x80000000U)) { return nullptr; }',
      '  return p->pStateFlags;',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(groups.map(g => [g.key, g.copy, g.members.length]), [['nullptr', 'inline', 3]]);
    const falls = guards(b).map(g => predictFall(g, { list: b.statements, index: b.statements.indexOf(g), inLoop: false }, ctx).fall);
    assert.deepStrictEqual(falls, ['then', 'other', 'other']);
  });

  it('puts the copy at the end when one guard is `!(a && b)` (ours of GetStateFlags)', () => {
    const { b, ctx, groups } = groupsOf([
      'int* f(U* pUnit) {',
      '  if (!pUnit) { return 0; }',
      '  SX* p = pUnit->pStatsEx;',
      '  if (!(p && p->nFlags & 0x80000000U)) { return 0; }',
      '  return p->pStateFlags;',
      '}',
    ].join('\n'));
    assert.deepStrictEqual(groups.map(g => g.copy), ['end']);
    const falls = guards(b).map(g => predictFall(g, { list: b.statements, index: b.statements.indexOf(g), inLoop: false }, ctx).fall);
    assert.deepStrictEqual(falls, ['other', 'other']);
  });

  it('puts the copy at the end when the body ends in the same return', () => {
    const { groups } = groupsOf('int f(int a, int* p) { if (!a) { return 0; } G(a); if (p && *p) { return *p; } return 0; }');
    assert.deepStrictEqual(groups.map(g => g.copy), ['end']);
  });

  it('does not predict a group with a member in an arm with code, a nested block or a loop', () => {
    for (const code of [
      'int f(int a, int b) { if (!a) { return 0; } if (b == 3) { G(b); return 0; } return 1; }',
      'int f(int a, int b) { if (a) { if (!b) { return 0; } } else if (b) { return 0; } return 1; }',
      'int f(int a, int b) { if (!a) { return 0; } while (b) { if (b == 2) { return 0; } b--; } return 1; }',
      'int f(int a, int b) { if (!a) { return 0; } G(a); if (a || b) { return 1; } return 0; }',
    ]) assert.deepStrictEqual(groupsOf(code).groups.map(g => g.copy), [null], code);
  });
});

describe('branch-layout search - merged return copy (join and split)', () => {
  /** Evidence with explicit per-line offsets and return copies. */
  function runAt(code: string, lines: Record<number, number[]>, returns: ReturnCopy[], edges: BranchEdge[] = []): { out: string; sites: string[] } {
    const sites: string[] = [];
    const ev: BranchLayoutEvidence = {
      lines: new Map(Object.entries(lines).map(([l, o]) => [Number(l), o])),
      ifs: new Map(edges.map(e => [e.line, e.jcc])), edges, returns,
    };
    const t = branchLayoutPlugin.createTransformer({ branchLayout: ev, onSite: e => sites.push(e.rule) });
    return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
  }

  // GetStateFlags 00625bb0, as the passes leave it: the decompile's one && chain split, the
  // second guard `!(p && flags)`, both its ifs on the chain's line (no branch facts of their own).
  // The original's one `return 0` copy sits right after the first test, the later tests jump
  // back to it: three simple guards.
  const stateFlags = [
    'int* f(U* pUnit) {',                                   // 1
    '  if (!pUnit) {',                                      // 2
    '    return 0;',                                        // 3
    '  }',                                                  // 4
    '  SX* p = pUnit->pStatsEx;',                           // 5
    '  if (!(p && p->sStatList.nFlags & 0x80000000U)) {',   // 6
    '    return 0;',                                        // 7
    '  }',                                                  // 8
    '  return p->pStateFlags;',                             // 9
    '}',
  ].join('\n');
  const stateLines = { 2: [6, 8], 3: [10, 13], 5: [16], 6: [19, 23, 30], 7: [10, 13], 9: [32, 36] };
  const stateReturns: ReturnCopy[] = [
    { start: 10, ret: 13, insns: ['XOR/EAX', 'POP/EBP', 'RET'], fallsIn: true, jumpsIn: [21, 30] },
    { start: 32, ret: 36, insns: ['MOV/EAX', 'POP/EBP', 'RET'], fallsIn: true, jumpsIn: [] },
  ];

  it('splits the `!(a && b)` guard into one guard per test (GetStateFlags)', () => {
    const { out, sites } = runAt(stateFlags, stateLines, stateReturns);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!pUnit) { return 0; } SX* p = pUnit->pStatsEx; if (!p) { return 0; } if (!(p->sStatList.nFlags & 0x80000000U)) { return 0; } return p->pStateFlags;'), out);
  });

  it('keeps the values of the split', native, () => {
    const { out } = runAt(stateFlags, stateLines, stateReturns);
    const decl = 'struct SL { unsigned pad[4]; unsigned nFlags; }; struct SX { SL sStatList; int* pStateFlags; }; struct U { SX* pStatsEx; };';
    const prelude = [decl, 'static int gFlags[1];', `namespace ref { ${stateFlags} }`, `namespace low { ${out} }`].join('\n');
    const main = [
      'SX a = {}; a.pStateFlags = gFlags; U u = { &a }; U n = { nullptr };',
      'static const unsigned kFlags[] = {0u, 0x80000000u, 0x80000001u};', 'for (unsigned fl : kFlags) { a.sStatList.nFlags = fl;',
      '  printf("%d %d %d %d\\n", ref::f(&u) == low::f(&u), ref::f(&n) == low::f(&n), ref::f(nullptr) == low::f(nullptr), ref::f(&u) == gFlags); }',
    ].join('\n');
    const lines = compileAndRun(prelude, main).trim().split('\n');
    assert.deepStrictEqual(lines.map(l => l.split(' ').slice(0, 3).join(' ')), ['1 1 1', '1 1 1', '1 1 1']);
    assert.deepStrictEqual(lines.map(l => l.split(' ')[3]), ['0', '1', '1']);
  });

  it('leaves the split guard when its copy already lies at the end', () => {
    const atEnd: ReturnCopy[] = [stateReturns[1], { start: 40, ret: 43, insns: ['XOR/EAX', 'POP/EBP', 'RET'], fallsIn: false, jumpsIn: [8, 21, 30] }];
    const { sites } = runAt(stateFlags, { ...stateLines, 3: [40, 43], 7: [40, 43] }, atEnd);
    assert.deepStrictEqual(sites, []);
  });

  // SFILE_GetInstallPath 00406ba0: two simple guards `if (!d) return 0; if (d == n) return 0;`
  // where the original's one copy of `return 0` lies after everything, every test jumping
  // forward to it: the source had one `||` guard.
  const installPath = [
    'int f(int a, int n) {',     // 1
    '  int d = G(a);',           // 2
    '  if (!d) {',               // 3
    '    return 0;',             // 4
    '  }',                       // 5
    '  if (d == n) {',           // 6
    '    return 0;',             // 7
    '  }',                       // 8
    '  H(d);',                   // 9
    '  if (!n) {',               // 10
    '    return 0;',             // 11
    '  }',                       // 12
    '  return 1;',               // 13
    '}',
  ].join('\n');
  const installLines = { 2: [0], 3: [3, 5], 4: [0x40, 0x44], 6: [8, 0xb], 7: [0x40, 0x44], 9: [0x10], 10: [0x1e, 0x20], 11: [0x40, 0x44], 13: [0x30, 0x35] };
  const installReturns: ReturnCopy[] = [
    { start: 0x30, ret: 0x35, insns: ['MOV/EAX', 'POP/ESI', 'RET'], fallsIn: true, jumpsIn: [] },
    { start: 0x40, ret: 0x44, insns: ['XOR/EAX', 'POP/ESI', 'RET'], fallsIn: false, jumpsIn: [5, 0xb, 0x20] },
  ];
  const installEdges = [
    edge(3, 5, 0x40, 7, [6], [4]),
    edge(6, 0xb, 0x40, 0xd, [9], [7]),
    edge(10, 0x20, 0x40, 0x22, [13], [11]),
  ];

  it('joins two neighbouring guards into one `||` guard (SFILE_GetInstallPath)', () => {
    const { out, sites } = runAt(installPath, installLines, installReturns, installEdges);
    assert.deepStrictEqual(sites, ['join']);
    assert.ok(out.includes('int d = G(a); if (!d || d == n) { return 0; } H(d); if (!n) { return 0; } return 1;'), out);
  });

  it('keeps the values of the join', native, () => {
    const { out } = runAt(installPath, installLines, installReturns, installEdges);
    const calls = ['f(0, 0)', 'f(0, 5)', 'f(5, 5)', 'f(3, 5)', 'f(3, 0)', 'f(-1, 7)'].map(c => c);
    const prelude = ['static int gCalls = 0;', 'static int G(int a) { gCalls++; return a > 0 ? a : 0; }', 'static void H(int d) { gCalls += d; }',
      `namespace ref { ${installPath} }`, `namespace low { ${out} }`].join('\n');
    const main = calls.map(c => `{ gCalls = 0; int r = ref::${c}; int rc = gCalls; gCalls = 0; int l = low::${c}; printf("%d %d\\n", r == l, rc == gCalls); }`).join('\n');
    for (const line of compileAndRun(prelude, main).trim().split('\n')) assert.strictEqual(line, '1 1');
  });

  it('leaves the guards when the copy is inline at the first one', () => {
    const inline: ReturnCopy[] = [installReturns[0], { start: 7, ret: 0xa, insns: ['XOR/EAX', 'POP/ESI', 'RET'], fallsIn: true, jumpsIn: [0xd, 0x20] }];
    const lines = { ...installLines, 4: [7, 0xa], 7: [7, 0xa], 11: [7, 0xa], 6: [0xb, 0xd] };
    const edges = [edge(3, 5, 0xb, 7, [4], [6]), edge(6, 0xd, 7, 0xf, [9], [7]), edge(10, 0x20, 7, 0x22, [13], [11])];
    assert.deepStrictEqual(runAt(installPath, lines, inline, edges).sites, []);
  });
});

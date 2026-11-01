import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, CompoundStmt, FunctionDecl, IfStmt, ASTNode } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { NodeKind } from '../../../ast/kinds.js';
import { branchLayoutPlugin } from '../builtins/branch-layout/index.js';
import { earlyReturnPlugin } from '../builtins/early-return.js';
import { LayoutReader, type BranchLayoutEvidence, type BranchEdge } from '../builtins/branch-layout/evidence.js';
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

  it('and makes the guard as before when the copy holds no load', () => {
    assert.ok(flatten(['POP/ESI', 'RET']).includes('if (p[0] == 0) return 1; p[1] = 3; return 1;'), flatten(['POP/ESI', 'RET']));
  });

  it('the guard keeps the values', native, () => {
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

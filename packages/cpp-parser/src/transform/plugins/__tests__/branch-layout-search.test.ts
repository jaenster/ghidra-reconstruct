import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, CompoundStmt, FunctionDecl, IfStmt, ASTNode } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { NodeKind } from '../../../ast/kinds.js';
import { branchLayoutPlugin } from '../builtins/branch-layout/index.js';
import { LayoutReader, type BranchLayoutEvidence, type BranchEdge } from '../builtins/branch-layout/evidence.js';
import { scoreBody, predictFall, returnOrder } from '../builtins/branch-layout/predict.js';
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
    const ctx = { noreturn: new Set<string>(), returns: returnOrder(b) };
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
});

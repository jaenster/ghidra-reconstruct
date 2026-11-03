import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { branchLayoutPlugin, conditionShape, negate, LayoutReader, type BranchLayoutOptions } from '../builtins/branch-layout/index.js';
import { earlyReturnPlugin } from '../builtins/early-return.js';
import { haltSiteFoldPlugin } from '../builtins/halt-site-fold.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';
import type { ExprStmt, IfStmt, FunctionDecl, ASTNode, CompoundStmt } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

const HALT = 'ERROR_UnrecoverableInternalError_Halt';

/**
 * A function written one statement per line, each line tagged with the code offsets the
 * original prints there: `[offsets] text`, `[if cb offsets] text` for an if line.
 */
function fixture(lines: string[]): { code: string; ev: BranchLayoutEvidence } {
  const text: string[] = [];
  const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>() };
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\[(if\s+)?([0-9a-fx, ]*)\]\s?(.*)$/);
    if (!m) { text.push(l); return; }
    const nums = m[2].split(/[ ,]+/).filter(Boolean).map(n => Number(n));
    if (m[1]) { ev.ifs.set(i + 1, nums[0]); ev.lines.set(i + 1, nums); } else if (nums.length) ev.lines.set(i + 1, nums);
    text.push(m[3]);
  });
  return { code: text.join('\n'), ev };
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function run(lines: string[], opts: Partial<BranchLayoutOptions> = {}): { out: string; sites: string[] } {
  const { code, ev } = fixture(lines);
  const sites: string[] = [];
  const t = branchLayoutPlugin.createTransformer({ branchLayout: ev, onSite: e => sites.push(e.rule), ...opts });
  return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
}

function twice(lines: string[]): { first: string; second: string } {
  const { code, ev } = fixture(lines);
  const t = branchLayoutPlugin.createTransformer({ branchLayout: ev });
  const once = t(parse(code));
  return { first: flat(emit(once as AnyNode)), second: flat(emit(t(once) as AnyNode)) };
}

describe('branchLayoutPlugin - if/else arm order', () => {
  const swapped = [
    'void f(int a) {',
    '[if 0x8 0x3,0x8] if (a == 1) {',
    '[0x20] A();',
    '}',
    'else {',
    '[0x10] B();',
    '}',
    '[0x30] C();',
    '}',
  ];

  it('puts the lower-addressed arm first, negating the condition exactly', () => {
    const { out, sites } = run(swapped);
    assert.deepStrictEqual(sites, ['swap']);
    assert.ok(out.includes('if (a != 1) { B(); } else { A(); } C();'), out);
  });

  it('is idempotent', () => {
    const { first, second } = twice(swapped);
    assert.strictEqual(second, first);
  });

  it('leaves arms already in address order', () => {
    const { out, sites } = run(swapped.map(l => l.replace('[0x20] A', '[0x0c] A')));
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('if (a == 1) { A(); } else { B(); }'), out);
  });

  it('leaves an && condition: De Morgan does not change the control flow', () => {
    const { out, sites } = run(swapped.map(l => l.replace('a == 1', 'a == 1 && g')));
    assert.deepStrictEqual(sites, ['left']);
    assert.ok(out.includes('if (a == 1 && g) { A(); }'), out);
  });

  it('reads an || condition as else-first and leaves its arms', () => {
    const { out, sites } = run(swapped.map(l => l.replace('a == 1', 'a == 1 || g')));
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('if (a == 1 || g) { A(); }'), out);
  });

  it('gives no evidence for an arm whose offsets another statement prints too', () => {
    const { sites } = run(swapped.map(l => l.replace('[0x30] C', '[0x10] C')));
    assert.deepStrictEqual(sites, []);
  });

  it('turns a halt-first if/else into a sequential assertion', () => {
    const { out, sites } = run([
      'int f(int n, int i) {',
      '[if 0x7 0x0,0x7] if (n == 7) {',
      '[0x2b] g(i);',
      '[0x3d] return i;',
      '}',
      'else {',
      `[0x9] ${HALT}("", ip(), 0x8f);`,
      '[0x19] exit(-1);',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['swap']);
    assert.ok(out.includes(`if (n != 7) { ${HALT}("", ip(), 0x8f); exit(-1); } g(i); return i; }`), out);
  });

  it('keeps the else of a halt-first if/else inside a loop', () => {
    const { out } = run([
      'int f(int n, int i) {',
      'while (i) {',
      '[if 0x7 0x0,0x7] if (n == 7) {',
      '[0x2b] g(i);',
      '}',
      'else {',
      `[0x9] ${HALT}("", ip(), 0x8f);`,
      '[0x19] exit(-1);',
      '}',
      '}',
      '}',
    ]);
    assert.ok(out.includes('} else { g(i); }'), out);
  });

  it('swaps an else-if link in place, bracing a moved else-if', () => {
    const { out, sites } = run([
      'void f(int a) {',
      '[if 0x8 0x3,0x8] if (a == 1) {',
      '[0x10] A();',
      '}',
      '[if 0x18 0x14,0x18] else if (a == 2) {',
      '[0x30] B();',
      '}',
      'else {',
      '[0x20] C();',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['swap']);
    assert.ok(out.includes('if (a == 1) { A(); } else if (a != 2) { C(); } else { B(); }'), out);
  });
});

describe('branchLayoutPlugin - guard and nest', () => {
  const guard = [
    'int f(int h) {',
    '[if 0x4b 0x48,0x4b] if (h == -1) {',
    '[0x5d,0x62] return 0;',
    '}',
    '[0x4e] G(h);',
    '[0x54,0x5c] return 1;',
    '}',
  ];

  it('nests the rest when the leaving arm lies after it', () => {
    const { out, sites } = run(guard);
    assert.deepStrictEqual(sites, ['nest']);
    assert.ok(out.includes('if (h != -1) { G(h); return 1; } return 0; }'), out);
  });

  it('is idempotent', () => {
    const { first, second } = twice(guard);
    assert.strictEqual(second, first);
  });

  it('judges the ifs of a rest it nests, in one run', () => {
    const lines = [
      'int f(int h, int g) {',
      '[if 0x4b 0x48,0x4b] if (h == -1) {',
      '[0x90] return 0;',
      '}',
      '[if 0x52 0x50,0x52] if (g == 2) {',
      '[0x80] return 2;',
      '}',
      '[0x54] G(h);',
      '[0x5a,0x60] return 1;',
      '}',
    ];
    const { first, second } = twice(lines);
    assert.strictEqual(second, first);
    assert.ok(first.includes('if (h != -1) { if (g != 2) { G(h); return 1; } return 2; } return 0; }'), first);
  });

  it('flattens a nest whose rest lies first (the guard direction)', () => {
    const { out, sites } = run([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h != -1) {',
      '[0x5d] G(h);',
      '[0x62] return 1;',
      '}',
      '[0x4e,0x54] return 0;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['nest']);
    assert.ok(out.includes('if (h == -1) { return 0; } G(h); return 1; }'), out);
  });

  it('leaves a guard inside a loop', () => {
    const { sites } = run([
      'int f(int h) {',
      'for (;;) {',
      '[if 0x4b 0x48,0x4b] if (h == -1) {',
      '[0x5d,0x62] return 0;',
      '}',
      '[0x4e] G(h);',
      '[0x54,0x5c] return 1;',
      '}',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a guard whose rest falls through', () => {
    const { out, sites } = run([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h == -1) {',
      '[0x5d,0x62] return 0;',
      '}',
      '[0x4e] G(h);',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left']);
    assert.ok(out.includes('if (h == -1) { return 0; } G(h);'), out);
  });

  it('gives no evidence for an arm that is only `return;`', () => {
    const { sites } = run([
      'void f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h == -1) {',
      '[0x5d,0x62] return;',
      '}',
      '[0x4e] G(h);',
      '[0x54] return;',
      '}',
    ]);
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a guard when a goto targets a label in the moved code', () => {
    const { sites } = run([
      'int f(int h) {',
      '[0x10] if (h) goto L;',
      '[if 0x4b 0x48,0x4b] if (h == -1) {',
      '[0x5d,0x62] return 0;',
      '}',
      '[0x4e] L: G(h);',
      '[0x54,0x5c] return 1;',
      '}',
    ]);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('keeps a moved block braced when its names would clash', () => {
    const { out } = run([
      'int f(int h) {',
      '[0x1] int x = 1;',
      '[if 0x4b 0x48,0x4b] if (h != -1) {',
      '[0x5d] int x = h;',
      '[0x62] return x;',
      '}',
      '[0x4e,0x54] return 0;',
      '}',
    ]);
    assert.ok(out.includes('if (h == -1) { return 0; } { int x = h; return x; } }'), out);
  });
});

describe('branchLayoutPlugin - && guard with a tail written per test', () => {
  const split = [
    'int f(int ok, S* p) {',
    '[if 0x38 0x19,0x31,0x38] if (ok != 0 && p->t == -1) {',
    '[0x3a,0x41] n = p->v;',
    '[0x49] Leave(&cs);',
    '[0x4f,0x53] return n;',
    '}',
    '[0x22] Leave(&cs);',
    '[0x28,0x2b] return 0;',
    '}',
  ];

  it('splits the && into one guard per test, success path last', () => {
    const { out, sites } = run(split);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (ok == 0) { Leave(&cs); return 0; } if (p->t != -1) { Leave(&cs); return 0; } n = p->v; Leave(&cs); return n; }'), out);
  });

  it('is idempotent', () => {
    const { first, second } = twice(split);
    assert.strictEqual(second, first);
  });

  it('leaves a tail that lies after the last test', () => {
    const { sites } = run(split.map(l => l.replace('[0x22] Leave', '[0x60] Leave').replace('[0x28,0x2b] return 0', '[0x66] return 0')));
    assert.deepStrictEqual(sites, []);
  });

  it('leaves a tail with a call on a computed argument', () => {
    const { sites } = run(split.map(l => l.replace('[0x22] Leave(&cs);', '[0x22] Leave(g());')));
    assert.deepStrictEqual(sites, ['left']);
  });
});

describe('branchLayoutPlugin - || guard whose arm the original placed elsewhere', () => {
  const amid = [
    'void* f(S* p) {',
    '[if 0xc 0x0,0x2,0x9,0xc] if (!(p && p->m == 0x1020304)) {',
    '[0x4,0x6] return 0;',
    '}',
    '[0xe] return p->v;',
    '}',
  ];

  it('writes one guard per test where the arm lies between the tests', () => {
    const { out, sites } = run(amid);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!p) { return 0; } if (p->m != 0x1020304) { return 0; } return p->v; }'), out);
  });

  it('does the same for a written ||', () => {
    const { out, sites } = run(amid.map(l => l.replace('!(p && p->m == 0x1020304)', 'a == b || c > d')));
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (a == b) { return 0; } if (c > d) { return 0; }'), out);
  });

  it('is idempotent', () => {
    const { first, second } = twice(amid);
    assert.strictEqual(second, first);
  });

  it('leaves three tests: which one the arm follows is unknown', () => {
    const { sites } = run(amid.map(l => l.replace('!(p && p->m == 0x1020304)', '!(p && p->t == 1 && p->d)')));
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves an arm that lies after the rest, as VC8 places it', () => {
    const { sites } = run(amid.map(l => l.replace('[0x4,0x6] return 0', '[0x14,0x16] return 0')));
    assert.deepStrictEqual(sites, []);
  });

  const getter = [
    'void* f(S* p) {',
    '[if 0xe 0x0,0x2,0x4,0x7,0x9,0xc,0xe] if (!(p && p->t == 1 && p->d)) {',
    '[0x10] return 0;',
    '}',
    '[0x13] return p->d->v;',
    '}',
  ];

  it('tests the value of an inlined getter where the arm follows the last test', () => {
    const { out, sites } = run(getter);
    assert.deepStrictEqual(sites, ['getter']);
    assert.ok(out.includes('if (!(p && p->t == 1 ? p->d : 0)) { return 0; } return p->d->v;'), out);
  });

  it('is idempotent on the getter form', () => {
    const { first, second } = twice(getter);
    assert.strictEqual(second, first);
  });

  // The null defaults the original's own getters give (null-getter.ts).
  const nullGetters = { 'S|t': { value: -1 }, 'S|eType': { value: 6, name: 'UNIT_COUNT' }, 'S|u': { value: 3 } };
  const enumValues = { UNIT_PLAYER: 0, UNIT_MONSTER: 1, UNIT_COUNT: 6 };
  const known = { nullGetters, enumValues };

  it('compares an inlined getter once with its null default where the last test is a comparison against a constant', () => {
    const { out, sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t == 1')), known);
    assert.deepStrictEqual(sites, ['getter']);
    assert.ok(out.includes('if ((p ? p->t : -1) != 1) { return 0; } return p->d->v;'), out);
  });

  it('spells an enumerator default by its name and values the constant through the enum', () => {
    const { out } = run(getter.map(l => l.replace('!(p && p->t == 1 && p->d)', '!p || p->eType != UNIT_MONSTER')), known);
    assert.ok(out.includes('if ((p ? p->eType : UNIT_COUNT) != UNIT_MONSTER) { return 0; }'), out);
  });

  it('writes a getter tested for inequality where its null default is the constant', () => {
    const { out, sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->u != 3')), known);
    assert.deepStrictEqual(sites, ['getter']);
    assert.ok(out.includes('if ((p ? p->u : 3) == 3) { return 0; }'), out);
  });

  it('leaves a getter tested for inequality where its null default is another value', () => {
    const { out, sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t != 3')), known);
    assert.deepStrictEqual(sites, ['left']);
    assert.ok(out.includes('if (!(p && p->t != 3))'), out);
  });

  it('leaves a field without a known null default as printed', () => {
    const { out, sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->w == 1')), known);
    assert.deepStrictEqual(sites, ['left']);
    assert.ok(out.includes('if (!(p && p->w == 1))') && !out.includes('?'), out);
  });

  it('writes no getter without the table', () => {
    const { sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t == 1')));
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a getter whose null default equals the constant compared for equality', () => {
    const { sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t == -1')), known);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('reads the default under 32 bits: 0xffffffff is the default -1', () => {
    const { sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t == 0xffffffff')), known);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a field whose default was read for another type', () => {
    const { sites } = run(getter.map(l => l.replace('S* p', 'T* p').replace('p->t == 1 && p->d', 'p->t == 1')), known);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves an enumerator constant without a value', () => {
    const { sites } = run(getter.map(l => l.replace('!(p && p->t == 1 && p->d)', '!p || p->eType != UNIT_OBJECT')), known);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a comparison against a variable', () => {
    const { sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'p->t == nType')));
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a comparison that does not read through the tested pointer', () => {
    const { sites } = run(getter.map(l => l.replace('p->t == 1 && p->d', 'q->t == 1')));
    assert.deepStrictEqual(sites, ['left']);
  });
});

describe('branchLayoutPlugin - || guard of three or more tests, by per-operand branches', () => {
  const three = [
    'int f(S* p) {',
    '[if 0x14 0x0,0x2,0x9,0x10,0x14] if (!(p && p->t == 1 && p->d)) {',
    '[0x4,0x6] return 0;',
    '}',
    '[0x16] return p->d->v;',
    '}',
  ];
  function runOps(lines: string[], ops: number[][], opts: Partial<BranchLayoutOptions> = {}): { out: string; sites: string[] } {
    const { code, ev } = fixture(lines);
    const sites: string[] = [];
    const operands = new Map([[2, ops]]);
    const t = branchLayoutPlugin.createTransformer({ branchLayout: { ...ev, operands }, onSite: e => sites.push(e.rule), ...opts });
    return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
  }

  it('writes one guard per test where the arm follows the first', () => {
    const { out, sites } = runOps(three, [[0x2], [0xb], [0x14]]);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!p) { return 0; } if (p->t != 1) { return 0; } if (!p->d) { return 0; } return p->d->v;'), out);
  });

  it('does the same for a written || of four tests', () => {
    const { out, sites } = runOps(three.map(l => l.replace('!(p && p->t == 1 && p->d)', 'a || b < 0 || c || d')), [[0x2], [0x9], [0x10], [0x14]]);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (a) { return 0; } if (b < 0) { return 0; } if (c) { return 0; } if (d) { return 0; }'), out);
  });

  it('compares the getter once and guards the rest where the arm follows the second', () => {
    const lines = three.map(l => l.replace('[0x4,0x6] return 0', '[0xb,0xd] return 0'));
    const { out, sites } = runOps(lines, [[0x2], [0x9], [0x14]], { nullGetters: { 'S|t': { value: 0 } } });
    assert.deepStrictEqual(sites, ['getter']);
    assert.ok(out.includes('if ((p ? p->t : 0) != 1) { return 0; } if (!p->d) { return 0; } return p->d->v;'), out);
  });

  it('leaves the arm after the second where the getter has no known null default', () => {
    const lines = three.map(l => l.replace('[0x4,0x6] return 0', '[0xb,0xd] return 0'));
    const { out, sites } = runOps(lines, [[0x2], [0x9], [0x14]]);
    assert.deepStrictEqual(sites, ['left']);
    assert.ok(!out.includes('?'), out);
  });

  it('is idempotent', () => {
    const { code, ev } = fixture(three);
    const t = branchLayoutPlugin.createTransformer({ branchLayout: { ...ev, operands: new Map([[2, [[0x2], [0xb], [0x14]]]]) } });
    const once = t(parse(code));
    assert.strictEqual(flat(emit(t(once) as AnyNode)), flat(emit(once as AnyNode)));
  });

  it('leaves the arm after the second where the first two are no getter', () => {
    const lines = three.map(l => l.replace('[0x4,0x6] return 0', '[0xb,0xd] return 0').replace('p->t == 1', 'q'));
    const { sites } = runOps(lines, [[0x2], [0x9], [0x14]]);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('places the arm by top-level operand: one with a nested || counts its tests', () => {
    const lines = three.map(l => l.replace('!(p && p->t == 1 && p->d)', '!(p && (p->t == 1 || p->t == 2) && p->d)'));
    const { out, sites } = runOps(lines, [[0x2], [0x9], [0xe], [0x14]]);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!p) { return 0; } if (!(p->t == 1 || p->t == 2)) { return 0; } if (!p->d) { return 0; }'), out);
  });

  it('leaves an arm among the tests of one operand', () => {
    const lines = three.map(l => l.replace('!(p && p->t == 1 && p->d)', '!(p && (p->t == 1 || p->t == 2) && p->d)').replace('[0x4,0x6] return 0', '[0xb,0xd] return 0'));
    const { sites } = runOps(lines, [[0x2], [0x9], [0xe], [0x14]]);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves the facts when their operand count disagrees with the condition', () => {
    const { sites } = runOps(three, [[0x2], [0xb]]);
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a two-test guard whose arm the facts put after its second test', () => {
    const lines = three.map(l => l.replace('!(p && p->t == 1 && p->d)', '!(p && q)'));
    const { sites } = runOps(lines, [[0x2], [0x3]]);
    assert.deepStrictEqual(sites, ['left']);
  });
});

describe('branchLayoutPlugin - guards whose returns the original merged into one copy', () => {
  function runRet(lines: string[], returns: { start: number; ret: number; insns: string[] }[] | undefined): { out: string; sites: string[] } {
    const { code, ev } = fixture(lines);
    const sites: string[] = [];
    const t = branchLayoutPlugin.createTransformer({ branchLayout: { ...ev, returns }, onSite: e => sites.push(e.rule) });
    return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
  }
  const atEnd = [
    'int f(S* p) {',
    '[if 0x2 0x0,0x2] if (!p) {',
    '[0x30] return 0;',
    '}',
    '[0x4] g(p);',
    '[if 0x10 0x9,0x10] if (p->v) {',
    '[0x12] return 1;',
    '}',
    '[0x30] return 0;',
    '}',
  ];
  const copies = [
    { start: 0x12, ret: 0x17, insns: ['MOV/EAX', 'RET'] },
    { start: 0x30, ret: 0x32, insns: ['XOR/EAX', 'RET'] },
  ];

  it('leaves a guard whose merged return lies after the rest: VC8 keeps the first copy or the last by its own choice', () => {
    const { out, sites } = runRet(atEnd, copies);
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('if (!p) { return 0; } g(p);'), out);
  });

  const before = [
    'int f(S* p, S* q) {',
    '[if 0x2 0x0,0x2] if (!p) {',
    '[0x4] return 0;',
    '}',
    '[if 0x10 0x8,0xa,0x10] if (!(q && q->t)) {',
    '[0x4] return 0;',
    '}',
    '[0x12] return q->v;',
    '}',
  ];

  it('writes one guard per test where the merged return lies before the tests', () => {
    const { out, sites } = runRet(before, [{ start: 0x4, ret: 0x6, insns: ['XOR/EAX', 'RET'] }, copies[0]]);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!p) { return 0; } if (!q) { return 0; } if (!q->t) { return 0; } return q->v; }'), out);
  });

  it('leaves the guards whose rest is a constant return, which VC8 would fold into a SETcc', () => {
    const lit = before.map(l => l.replace('[0x12] return q->v;', '[0x12] return 1;'));
    assert.deepStrictEqual(runRet(lit, [{ start: 0x4, ret: 0x6, insns: ['XOR/EAX', 'RET'] }, copies[0]]).sites, ['left']);
  });

  it('reads nothing from a return printed twice without return facts', () => {
    const { sites } = runRet(before, undefined);
    assert.deepStrictEqual(sites, []);
  });

  it('reads nothing from a line whose offsets fall in no return copy', () => {
    const { sites } = runRet(before, [copies[0]]);
    assert.deepStrictEqual(sites, []);
  });
});

describe('LayoutReader - operands of a condition a pass split into several ifs on one line', () => {
  const code = 'int f(S* p) {\nif (!(p && p->t == 1)) { return 0; } int x = g(p); if (!x) { return 0; }\nreturn x;\n}';
  const root = parse(code);
  const ifs = [...traverseAST(root as ASTNode)].filter(n => n.kind === 'IfStmt') as IfStmt[];
  const body = ([...traverseAST(root as ASTNode)].find(n => n.kind === 'FunctionDecl') as FunctionDecl).body!;
  const ev: BranchLayoutEvidence = {
    lines: new Map([[2, [0x0, 0x2, 0x8, 0x10, 0x18]]]),
    ifs: new Map([[2, 0x18]]),
    operands: new Map([[2, [[0x2], [0x8], [0x18]]]]),
  };
  const reader = new LayoutReader(ev, body);

  it('gives the first if its leading operands and its own last branch', () => {
    assert.strictEqual(reader.cbranch(ifs[0]), null);
    assert.deepStrictEqual(reader.operandBranches(ifs[0], 2), [[0x2], [0x8]]);
    assert.strictEqual(reader.prefixBranch(ifs[0], 2), 0x8);
  });

  it('gives nothing to a later piece, or for as many operands as the line has', () => {
    assert.strictEqual(reader.operandBranches(ifs[1], 1), null);
    assert.strictEqual(reader.operandBranches(ifs[0], 3), null);
  });
});

describe('branchLayoutPlugin - without evidence', () => {
  it('changes nothing', () => {
    const { code } = fixture(['int f(int h) {', 'if (h == -1) { return 0; }', 'G(h);', 'return 1;', '}']);
    const out = flat(emit(branchLayoutPlugin.createTransformer({})(parse(code)) as AnyNode));
    assert.strictEqual(out, flat(code));
  });
});

describe('conditionShape and negate', () => {
  const cond = (s: string) => ((parse(`void f() { ${s}; }`) as any).declarations[0].body.statements[0] as ExprStmt).expression;
  const show = (s: string) => flat(emit(negate(cond(s)) as unknown as AnyNode));

  it('classifies conditions by how they branch', () => {
    assert.strictEqual(conditionShape(cond('a == 1')).kind, 'simple');
    assert.strictEqual(conditionShape(cond('a && b')).kind, 'and');
    assert.strictEqual(conditionShape(cond('!(a || b)')).kind, 'and');
    assert.strictEqual(conditionShape(cond('a || b')).kind, 'or');
    assert.strictEqual(conditionShape(cond('!(a && b)')).kind, 'or');
    assert.strictEqual(conditionShape(cond('x == (a ? b : c)')).kind, 'other');
  });

  it('flips a relational only against an integer literal', () => {
    assert.strictEqual(show('x < 0xe'), 'x >= 0xe');
    assert.strictEqual(show('4 < y - z'), '4 >= y - z');
    assert.strictEqual(show('f < 0.5'), '!(f < 0.5)');
    assert.strictEqual(show('a < b'), '!(a < b)');
    assert.strictEqual(show('a == b'), 'a != b');
    assert.strictEqual(show('!p'), 'p');
  });
});

describe('earlyReturnPlugin - gated by the layout', () => {
  function er(lines: string[]): string {
    const { code, ev } = fixture(lines);
    return flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: ev })(parse(code)) as AnyNode));
  }

  it('keeps the nest when the leaving body lies before the return', () => {
    const out = er([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h != -1) {',
      '[0x4e] G(h);',
      '[0x54] return 1;',
      '}',
      '[0x5d,0x62] return 0;',
      '}',
    ]);
    assert.ok(out.includes('if (h != -1) { G(h); return 1; } return 0;'), out);
  });

  it('makes the guard when the return lies first', () => {
    const out = er([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h != -1) {',
      '[0x5d] G(h);',
      '[0x62] return 1;',
      '}',
      '[0x4e,0x54] return 0;',
      '}',
    ]);
    assert.ok(/if \(h == -1\)\s*return 0;/.test(out), out);
  });

  it('keeps the nest for an && condition whose body lies before the return (GetAnimOrSeqMode)', () => {
    const out = er([
      'int f(int h, int g) {',
      '[if 0x4b 0x40,0x48,0x4b] if (h != -1 && g) {',
      '[0x4e] G(h);',
      '[0x54] return 1;',
      '}',
      '[0x5d,0x62] return 0;',
      '}',
    ]);
    assert.ok(out.includes('if (h != -1 && g) { G(h); return 1; } return 0;'), out);
  });

  it('makes the guard for an && condition whose return lies first', () => {
    const out = er([
      'int f(int h, int g) {',
      '[if 0x4b 0x40,0x48,0x4b] if (h != -1 && g) {',
      '[0x5d] G(h);',
      '[0x62] return 1;',
      '}',
      '[0x4e,0x54] return 0;',
      '}',
    ]);
    assert.ok(out.includes('return 0; G(h); return 1;'), out);
  });

  it('makes the guard for an || condition, whose body VC8 moves out of line', () => {
    const out = er([
      'int f(int h, int g) {',
      '[if 0x4b 0x40,0x48,0x4b] if (h != -1 || g) {',
      '[0x4e] G(h);',
      '[0x54] return 1;',
      '}',
      '[0x5d,0x62] return 0;',
      '}',
    ]);
    assert.ok(out.includes('return 0; G(h); return 1;'), out);
  });

  // TSGrowableArray_Ui_RoundToChunk 004210e0: `if (n % m != 0) { n += m - n % m; } return n;`
  // is the original's single exit; the guard would only clone the return.
  function erWith(lines: string[], extra: Partial<BranchLayoutEvidence>): string {
    const { code, ev } = fixture(lines);
    return flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: { ...ev, ...extra } })(parse(code)) as AnyNode));
  }
  const singleExit = [
    'int f(int h) {',
    '[if 0x4b 0x48,0x4b] if (h == 2) {',
    '[0x4e] G(h);',
    '}',
    '[0x5d,0x62] return 1;',
    '}',
  ];
  const fallsIntoBody = [{ line: 2, ord: 0, keyword: 'if' as const, jcc: 0x4b, target: 0x5d, fall: 0x4e, fallLines: [3], takenLines: [5] }];

  it('keeps the nest when the body cannot leave', () => {
    const out = erWith(singleExit, { edges: fallsIntoBody });
    assert.ok(out.includes('if (h == 2) { G(h); } return 1;'), out);
  });

  // Missiles_SrvHitFunc_DispatchSrvDoFunc 005acfc0, Q22_PlayerCheckKhalimsWillItems 005bb7b0:
  // an if whose jump the facts cannot place says nothing about the nest.
  it('makes the guard for a body that cannot leave where the facts have no edge for the if', () => {
    const out = er(singleExit);
    assert.ok(/if \(h != 2\)\s*return 1;/.test(out), out);
  });

  // GAMEDATA_GetLadderOrGameType 0044dca0: `mov eax, [ladder]; ...; jbe ret; mov eax, 1; ret`.
  const select = [
    'int f(int h) {',
    '[0x2] int r = h;',
    '[if 0x10 0x8,0x10] if (h > 7) {',
    '[0x12] r = 1;',
    '}',
    '[0x17] return r;',
    '}',
  ];
  const selectEdge = [{ line: 3, ord: 0, keyword: 'if' as const, jcc: 0x10, target: 0x17, fall: 0x12, fallLines: [4], takenLines: [6] }];

  it('makes the guard where the body only loads the other value of a variable already in EAX', () => {
    const out = erWith(select, { edges: selectEdge, returns: [{ start: 0x17, ret: 0x17, insns: ['RET'], jumpsIn: [0x10], fallsIn: true }] });
    assert.ok(/if \(h <= 7\)\s*return r; r = 1; return r;/.test(out), out);
  });

  // SKILLS_CalculateSynergyValue_Recursive 00645a90 keeps its nest: the join moves the variable into EAX.
  it('keeps the nest of a select whose return copy loads EAX', () => {
    const out = erWith(select, { edges: selectEdge, returns: [{ start: 0x17, ret: 0x1b, insns: ['POP/EDI', 'MOV/EAX', 'RET'], jumpsIn: [0x10], fallsIn: true }] });
    assert.ok(out.includes('if (h > 7) { r = 1; } return r;'), out);
  });

  // SPELLSEL_FindChargedSkill1 004a9a90: the loop's exits and the guard share one tail.
  const loopBody = (halt: boolean) => [
    'int f(int h) {',
    '[if 0x5 0x0,0x5] if (h != 0) {',
    '[0x7] int p = G(h);',
    '[0x10] while (p != 0) {',
    halt ? '[0x20] if (p == 3) { exit(-1); }' : '[0x20] H(p);',
    '[0x30] p = N(p);',
    '}',
    '}',
    '[0x41,0x44] return 0;',
    '}',
  ];
  const loopEdge = [{ line: 2, ord: 0, keyword: 'if' as const, jcc: 0x5, target: 0x41, fall: 0x7, fallLines: [3], takenLines: [9] }];

  it('makes the guard of a constant return after a loop', () => {
    const out = erWith(loopBody(false), { edges: loopEdge });
    assert.ok(/if \(h == 0\)\s*return 0;/.test(out), out);
  });

  // DRLGROOM_ValidateClientList 0061a550: a loop that can halt keeps the nest.
  it('keeps the nest of a constant return after a loop that can halt', () => {
    const out = erWith(loopBody(true), { edges: loopEdge });
    assert.ok(out.includes('if (h != 0) {'), out);
  });

  // SPELLSEL_FindChargedSkill1: VC8 emitted one return copy per path, the guard's layout.
  it('makes the guard for a body that cannot leave where the original falls into the return', () => {
    const { code, ev } = fixture([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h == 2) {',
      '[0x5d] G(h);',
      '}',
      '[0x4e,0x54] return 1;',
      '}',
    ]);
    const edges = [{ line: 2, ord: 0, keyword: 'if' as const, jcc: 0x4b, target: 0x5d, fall: 0x4e, fallLines: [5], takenLines: [3] }];
    const out = flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: { ...ev, edges } })(parse(code)) as AnyNode));
    assert.ok(/if \(h != 2\)\s*return 1;/.test(out), out);
  });

  // SKILL_ExecuteSelectProc 004642b0: the tail test jumps to the return the failing outer
  // condition shares; flattened, `if (r) return 1; return 0;` folds to NEG/SBB/NEG.
  it('keeps the nest whose body ends in a constant return test before a constant return', () => {
    const out = er([
      'int f(int h, int g) {',
      '[if 0x10 0x8,0x10] if (h != 0 && g < 7) {',
      '[0x20] int r = G(h);',
      '[if 0x28 0x26,0x28] if (r != 0) {',
      '[0x2a,0x2f] return 1;',
      '}',
      '}',
      '[0x30,0x32] return 0;',
      '}',
    ]);
    assert.ok(out.includes('if (r != 0) { return 1; } } return 0;'), out);
    assert.ok(!/return 1; return 0;/.test(out), out);
  });

  // SOUND_Is3DMixerActive 004df980: an `||` tail has no flag to fold; the guard is made.
  it('makes the guard of a body ending in an `||` test before a constant return', () => {
    const out = er([
      'int f(int h, int g) {',
      '[if 0x10 0x8,0x10] if (h != 0) {',
      '[0x20] int r = G(h);',
      '[if 0x2c 0x26,0x2c] if (r == 1 || r == 2) {',
      '[0x2e,0x33] return 1;',
      '}',
      '}',
      '[0x34,0x36] return 0;',
      '}',
    ]);
    assert.ok(/if \(h == 0\)\s*return 0;/.test(out), out);
  });

  it('reads a tail call printed on the call and on the return as the body\'s (TEXT_GetOverheadSpeakerUnit)', () => {
    const out = er([
      'int f(int h) {',
      '[if 0x20 0x19,0x20] if (h) {',
      '[0x2d] int r = G(h);',
      '[0x2d] return r;',
      '}',
      '[0x32,0x34] return 0;',
      '}',
    ]);
    assert.ok(out.includes('if (h) { int r = G(h); return r; } return 0;'), out);
  });

  it('still drops an address two returns in different arms print (cross-jumped tails)', () => {
    const out = er([
      'int f(int h, int k) {',
      '[if 0x8 0x6,0x8] if (h) {',
      '[0x10] if (k) {',
      '[0x30] return 0;',
      '}',
      '[0x12] G(h);',
      '[0x18] return 1;',
      '}',
      '[0x30] return 0;',
      '}',
    ]);
    // The outer if's body entry is 0x10; the trailing return's only address is shared.
    assert.ok(/if \(!h\)\s*return 0;/.test(out), out);
  });

  it('reads the branch of an && a pass split into nested ifs on one line (deflateTune)', () => {
    // comma-expand turns `if (s && (t = s->p, t)) {..}` into nested ifs on the if's line.
    const { code, ev } = fixture([
      'int f(S* s) {',
      '[if 0xc 0x3,0x7,0xa,0xc] if (s) { t = s->p; if (t) {',
      '[0x11] t->a = 1;',
      '[0x2c,0x2f] return 0;',
      '} }',
      '[0x32,0x38] return -2;',
      '}',
    ]);
    const out = flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: ev })(parse(code)) as AnyNode));
    assert.ok(out.includes('if (s) { t = s->p; if (t) { t->a = 1; return 0; } } return -2;'), out);
    // Without the line's branch (another if on it) the guard is made as before.
    const other = fixture([
      'int f(S* s) {',
      'if (s) { t = s->p; if (t) {',
      '[0x11] t->a = 1;',
      '[0x2c,0x2f] return 0;',
      '} }',
      '[0x32,0x38] return -2;',
      '}',
    ]);
    const out2 = flat(emit(earlyReturnPlugin.createTransformer({ branchLayout: other.ev })(parse(other.code)) as AnyNode));
    assert.ok(/if \(!s\)\s*return -2;/.test(out2), out2);
  });
});

describe('halt-site-fold keeps the jump site as the copy position', () => {
  it('lets a joined halt copy carry its own line (UI_GetCursorFrameOffset)', () => {
    const { code, ev } = fixture([
      'int f(int n, int i) {',
      '[if 0x7 0x0,0x7] if (n == 7) {',
      '[if 0x2b 0x2b] if (i < 7) {',
      '[0x3d,0x44] return t[i];',
      '}',
      '[0x2d] nLine = 0x90;',
      '}',
      'else {',
      '[0x9] nLine = 0x8f;',
      '}',
      '[0xe] nAddress = GetInstructionPointer();',
      `[0x19] ${HALT}("", nAddress, nLine);`,
      '[0x23] exit(-1);',
      '}',
    ]);
    const folded = haltSiteFoldPlugin.createTransformer({})(parse(code));
    const out = flat(emit(branchLayoutPlugin.createTransformer({ branchLayout: ev })(folded) as AnyNode));
    assert.ok(out.includes(`if (n != 7) { ${HALT}("", GetInstructionPointer(), 0x8f); exit(-1); } `
      + `if (i >= 7) { ${HALT}("", GetInstructionPointer(), 0x90); exit(-1); } return t[i]; }`), out);
  });
});

describe('branchLayoutPlugin - a halt laid out first whose branch a pass copied', () => {
  // EquipItem 00560cd0: `if (pInventory) { ... } else { Halt; exit; }`, the halt the decompile
  // merged for two tests, so the if's line is claimed twice; the jump falls into the halt.
  function runEdge(lines: string[], fallLines: number[], takenLines: number[]): string {
    const { code, ev } = fixture(lines);
    const edges = [...ev.ifs].map(([line, jcc]) => ({ line, ord: 0, keyword: 'if' as const, jcc, target: jcc + 9, fall: jcc + 2, fallLines, takenLines }));
    const t = branchLayoutPlugin.createTransformer({ branchLayout: { ...ev, edges } });
    const ast = parse(code);
    // The halt's lines claimed twice, as a pass that copied it leaves them.
    const fn = [...traverseAST(ast)].find(n => n.kind === 'FunctionDecl') as FunctionDecl;
    const ifs = [...traverseAST(fn)].find(n => n.kind === 'IfStmt') as IfStmt;
    (fn.body!.statements as unknown as ASTNode[]).push({ ...(ifs.elseBranch as ASTNode) });
    return flat(emit(t(ast) as AnyNode));
  }
  const lines = [
    'int f(Inv* pInventory) {',
    '[if 0x49 0x47,0x49] if (pInventory) {',
    '[0x53] A(pInventory);',
    '[0x5d] return 1;',
    '}',
    'else {',
    `[0x4b] ${HALT}("", 0, 0xc4a);`,
    '[0x16] exit(-1);',
    '}',
    '}',
  ];

  it('makes the halt a leading guard', () => {
    const out = runEdge(lines, [7, 8], [3, 4]);
    assert.ok(out.includes(`if (!pInventory) { ${HALT}("", 0, 0xc4a); exit(-1); } A(pInventory); return 1;`), out);
  });

  it('keeps the if/else when the jump falls into the other arm', () => {
    const out = runEdge(lines, [3, 4], [7, 8]);
    assert.ok(out.includes('if (pInventory) { A(pInventory); return 1; } else {'), out);
  });
});

/** `before` and `after` (void functions `f`) called over `calls` leave the same trace. */
function sameTrace(before: string, after: string, calls: string[], glue = ''): void {
  const prelude = [
    'static char gTrace[256]; static int gLen = 0;',
    'static void T(char c) { if (gLen < 255) gTrace[gLen++] = c; gTrace[gLen] = 0; }',
    'static void A(int n) { T(\'A\'); T((char)(\'0\' + n)); } static void B(int n) { T(\'B\'); T((char)(\'0\' + n)); }',
    'struct S { void (*fn)(int); };', glue,
    `namespace ref { ${before} }`, `namespace low { ${after} }`,
  ].join('\n');
  const main = calls.map(c => [
    `{ gLen = 0; gTrace[0] = 0; ref::${c}; char r[256]; strcpy(r, gTrace);`,
    `  gLen = 0; gTrace[0] = 0; low::${c}; printf("%s|%s\\n", r, gTrace); }`,
  ].join('\n')).join('\n');
  for (const line of compileAndRun(prelude, main).trim().split('\n')) {
    const [r, l] = line.split('|');
    assert.strictEqual(l, r, `trace differs: ${line}`);
  }
}

describe('branchLayoutPlugin - a void function whose rest runs off the end', () => {
  // TEXT_DrawQuestScrollUI 0049ff10: `if (t != K) { ...; return; } Anim(0);` where Anim(0)
  // lies first: the source wrote `if (t == K) { Anim(0); return; } ...`.
  const nest = [
    'void f(int t) {',
    '[if 0x14 0x0f,0x14] if (t != 7) {',
    '[0x1e] B(1);',
    '[0x23] return;',
    '}',
    '[0x18] A(0);',
    '}',
  ];

  it('nests the rest with the return its end stands for', () => {
    const { out, sites } = run(nest);
    assert.deepStrictEqual(sites, ['nest']);
    assert.ok(out.includes('if (t == 7) { A(0); return; } B(1); return; }'), out);
  });

  it('keeps the control flow of the nest', native, () => {
    const { out } = run(nest);
    sameTrace(fixture(nest).code, out, ['f(7)', 'f(3)']);
  });

  it('is idempotent', () => {
    const { first, second } = twice(nest);
    assert.strictEqual(second, first);
  });

  it('leaves a rest that falls through in a function that returns a value', () => {
    const { sites } = run(nest.map(l => l.replace('void f(int t)', 'int f(int t)').replace('return;', 'return 1;')));
    assert.deepStrictEqual(sites, ['left']);
  });

  it('leaves a rest that falls through in a nested block', () => {
    const { sites } = run([
      'void f(int t, int u) {',
      '[if 0x4 0x2,0x4] if (u) {',
      '[if 0x14 0x0f,0x14] if (t != 7) {',
      '[0x1e] B(1);',
      '[0x23] return;',
      '}',
      '[0x18] A(0);',
      '}',
      '[0x30] A(2);',
      '}',
    ]);
    assert.ok(!sites.includes('nest'), sites.join(','));
  });

  // MONMODE_DispatchDeathDrop 005a7ba0: `if (h && h->fn) { h->fn(m); return; } D(m);` with
  // D(m) between the two tests: the source wrote the default once per test.
  const split = [
    'void f(S* h, int m) {',
    '[if 0x30 0x1b,0x2b,0x30] if (h && h->fn) {',
    '[0x32] h->fn(m);',
    '[0x3b] return;',
    '}',
    '[0x20] A(m);',
    '}',
  ];

  it('splits the && with the default and its return per test', () => {
    const { out, sites } = run(split);
    assert.deepStrictEqual(sites, ['split']);
    assert.ok(out.includes('if (!h) { A(m); return; } if (!h->fn) { A(m); return; } h->fn(m); return; }'), out);
  });

  it('keeps the control flow of the split', native, () => {
    const { out } = run(split);
    const calls = ['f(nullptr, 1)', 'f(&s0, 2)', 'f(&s1, 3)'];
    sameTrace(fixture(split).code, out, calls, 'static S s0 = { nullptr }; static S s1 = { B };');
  });
});

describe('branchLayoutPlugin - halt arms', () => {
  // ITEMMODE_ProcessItemDropLogic 0055fcc0: in a loop, the stubs of halts VC8 merged sink
  // below the loop in the order their arms were written, whatever the spelling.
  const lines = [
    'void f(int* p, int n) {',
    '[0x8c]',
    'while (n) {',
    '[if 0x10 0x0e,0x10] if (!p) {',
    `[0x80] ${HALT}("", 0, 0x1a0f);`,
    '[0x88] exit(-1);',
    '}',
    'else {',
    '[0x12] A(n);',
    '}',
    '[0x20] n--;',
    '}',
    '}',
  ];
  function runCopied(copy: boolean): string[] {
    const { code, ev } = fixture(lines);
    const ast = parse(code);
    if (copy) {
      // The halt's lines claimed twice, as a pass that copied a merged halt leaves them; the
      // copy owns the store of its line (line 2), which printed the stub's PUSH.
      const fn = [...traverseAST(ast)].find(n => n.kind === 'FunctionDecl') as FunctionDecl;
      const ifs = [...traverseAST(fn)].find(n => n.kind === 'IfStmt') as IfStmt;
      const arm = ifs.thenBranch as CompoundStmt;
      (fn.body!.statements as unknown as ASTNode[]).push({ ...arm, statements: [...arm.statements] } as ASTNode);
      const st = arm.statements as unknown as ASTNode[];
      st[0] = { ...st[0], ghidraInfo: { ...st[0].ghidraInfo, foldedLines: [2] } };
    }
    const sites: string[] = [];
    branchLayoutPlugin.createTransformer({ branchLayout: ev, onSite: e => sites.push(e.rule) })(ast);
    return sites;
  }

  it('leaves an if/else in a loop whose halt arm is a copy of a merged halt', () => {
    assert.deepStrictEqual(runCopied(true), ['left']);
  });

  it('still swaps one whose halt is its own', () => {
    assert.deepStrictEqual(runCopied(false), ['swap']);
  });
});

describe('halt-site-fold places its copies where their code is', () => {
  // VIEW_ConvertViewCoordsToIsometric 004760e0: three asserts the compiler merged into one
  // halt; the first test falls into it. The copy for that test keeps the halt's lines, so the
  // if's own line keeps its branch, and the halt is laid out first: `if (!v) halt;`.
  const lines = [
    'void f(V* v, int* ox, int* oy) {',
    '[if 0x5 0x3,0x5] if (v != 0) {',
    '[if 0x2c 0x2a,0x2c] if (ox == 0) {',
    '[0x2e] nErrLine = 0x1ce;',
    '}',
    'else {',
    '[if 0x3a 0x38,0x3a] if (oy != 0) {',
    '[0x44,0x52] Iso(v, ox, oy);',
    '[0x59] return;',
    '}',
    '[0x3c] nErrLine = 0x1cf;',
    '}',
    '}',
    '[0xc] nErrAddress = GetInstructionPointer();',
    `[0x17] ${HALT}("", nErrAddress, nErrLine);`,
    '[0x21] exit(-1);',
    '}',
  ];
  const haltLines = [{ at: 0x17, ip: 0xc, paths: [{ line: 0x1cd, guard: 5 }, { line: 0x1ce, guard: 0x2c }, { line: 0x1cf, guard: 0x3a }] }];

  it('makes the first assert a leading guard', () => {
    const { code, ev } = fixture(lines);
    const folded = haltSiteFoldPlugin.createTransformer({ haltLines, branchLayout: ev })(parse(code));
    const sites: string[] = [];
    const out = flat(emit(branchLayoutPlugin.createTransformer({ branchLayout: ev, onSite: e => sites.push(e.rule) })(folded) as AnyNode));
    assert.ok(sites.includes('swap'), sites.join(','));
    assert.ok(out.includes(`if (v == 0) { ${HALT}("", GetInstructionPointer(), 0x1cd); exit(-1); } if (ox == 0) { ${HALT}("", GetInstructionPointer(), 0x1ce); exit(-1); }`), out);
  });

  it('gives a folded halt its definitions\' lines, not the range up to them', () => {
    const { code } = fixture([
      'void f(int a) {',
      '[0x2] A(a);',
      '[0x4] nLine = 0x40;',
      '[0x8] y = a;',
      '[0x10] nErrAddress = GetInstructionPointer();',
      `[0x17] ${HALT}("", nErrAddress, nLine);`,
      '[0x21] exit(-1);',
      '}',
    ]);
    const folded = haltSiteFoldPlugin.createTransformer({})(parse(code));
    const halt = [...traverseAST(folded as ASTNode)].find(n => n.kind === 'ExprStmt' && emit(n as AnyNode).includes(HALT)) as ExprStmt;
    assert.ok(emit(halt as AnyNode).includes('0x40'), emit(halt as AnyNode));
    assert.strictEqual(halt.location.start.line, 6);
    assert.deepStrictEqual([...(halt.ghidraInfo?.foldedLines ?? [])].sort(), [3, 5]);
  });
});

describe('branchLayoutPlugin - a halt the test falls into, the if with a branch of its own', () => {
  // HandleItemOnGround 004c2810: `test eax,eax / jne body / push 0x405 / jmp <shared halt>`.
  // The halt arm is a stub into a call another test shares: it prints no address of its own,
  // the if's branch does.
  function runEdge(lines: string[], fallLines: number[], takenLines: number[]): { out: string; sites: string[] } {
    const { code, ev } = fixture(lines);
    const edges = [...ev.ifs].map(([line, jcc]) => ({ line, ord: 0, keyword: 'if' as const, jcc, target: jcc + 9, fall: jcc + 2, fallLines, takenLines }));
    const sites: string[] = [];
    const t = branchLayoutPlugin.createTransformer({ branchLayout: { ...ev, edges }, onSite: e => sites.push(e.rule) });
    return { out: flat(emit(t(parse(code)) as AnyNode)), sites };
  }
  const lines = (loop: boolean) => [
    'void f(int* p, int n) {',
    loop ? 'while (n) {' : '{',
    '[if 0x10 0x0e,0x10] if (p) {',
    '[0x20] H(p);',
    '[0x25] return;',
    '}',
    'else {',
    `[] ${HALT}("", 0, 0x405);`,
    '[] exit(-1);',
    '}',
    loop ? '[0x30] n--;' : '',
    '}',
    '}',
  ];

  it('prints the halt as the guard', () => {
    const { out, sites } = runEdge(lines(false), [8, 9], [4, 5]);
    assert.deepStrictEqual(sites, ['swap']);
    assert.ok(out.includes(`if (!p) { ${HALT}("", 0, 0x405); exit(-1); } H(p); return;`), out);
  });

  // OBJECT_PopulateFromObjGroup 005528e0: in a loop the halt is the fall-through as well; one
  // VC8 sank below the loop exit would not be.
  it('in a loop too', () => {
    const { out } = runEdge(lines(true), [8, 9], [4, 5]);
    assert.ok(out.includes(`while (n) { if (!p) { ${HALT}("", 0, 0x405); exit(-1); } H(p); return; n--; }`), out);
  });

  it('keeps the if/else where the test falls into the body', () => {
    const { out, sites } = runEdge(lines(false), [4, 5], [8, 9]);
    assert.deepStrictEqual(sites, []);
    assert.ok(out.includes('if (p) { H(p); return; } else {'), out);
  });
});


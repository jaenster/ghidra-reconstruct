import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { branchLayoutPlugin, conditionShape, negate, type BranchLayoutOptions } from '../builtins/branch-layout/index.js';
import { earlyReturnPlugin } from '../builtins/early-return.js';
import { haltSiteFoldPlugin } from '../builtins/halt-site-fold.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';
import type { ExprStmt } from '../../../ast/nodes.js';

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

  it('makes the guard when the body falls through into a copy of the return', () => {
    // Which copy of the return keeps the code is not the layout's to say: VC8 emits one per
    // path for some sources (SPELLSEL_FindChargedSkill1) and one for both for others.
    const out = er([
      'int f(int h) {',
      '[if 0x4b 0x48,0x4b] if (h == 2) {',
      '[0x4e] G(h);',
      '}',
      '[0x5d,0x62] return 1;',
      '}',
    ]);
    assert.ok(/if \(h != 2\)\s*return 1;/.test(out), out);
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

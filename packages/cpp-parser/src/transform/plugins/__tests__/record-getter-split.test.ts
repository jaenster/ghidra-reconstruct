import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { recordGetterSplitPlugin, type RecordGetterSplitOptions } from '../builtins/record-getter-split.js';
import type { BranchLayoutEvidence, ReturnCopy } from '../builtins/branch-layout/evidence.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

const PRELUDE = [
  'struct Rec { int a; int b; };',
  'struct Table { Rec *pTxt; int nSize; };',
  'Table *gT;',
].join('\n');

/**
 * Evidence for `lines` (1-based): every line prints one offset, ten apart; `ifs` are the
 * lines that held an `if` keyword in the decompile.
 */
function layout(lines: string[], ifs: number[], returns: ReturnCopy[] = []): BranchLayoutEvidence {
  const m = new Map<number, number[]>();
  lines.forEach((_, i) => m.set(i + 1, [(i + 1) * 0x10]));
  return { lines: m, ifs: new Map(ifs.map(l => [l, l * 0x10])), returns };
}

function run(lines: string[], ev: BranchLayoutEvidence | null, opts: Partial<RecordGetterSplitOptions> = {}) {
  const sites: string[] = [];
  const t = recordGetterSplitPlugin.createTransformer({
    branchLayout: ev, onSite: e => sites.push(`${e.name}:${e.form}:${e.tests}`), ...opts,
  } as RecordGetterSplitOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites };
}

const GUARDS = [
  'int f(int i) {',
  '  if (i < 0) {',
  '    return 0;',
  '  }',
  '  if (i >= gT->nSize) {',
  '    return 0;',
  '  }',
  '  Rec* p = gT->pTxt + i;',
  '  if (!p) {',
  '    return 0;',
  '  }',
  '  return p->a;',
  '}',
];

describe('record-getter-split', () => {
  // Skills_SrvDoFunc_103_ChargeAndMeleeStrike, 005cd380: one decompiled `if` (line 2).
  it('joins split range guards and the null test into the conditional pointer', () => {
    const r = run(GUARDS, layout(GUARDS, [2]));
    assert.deepStrictEqual(r.sites, ['p:guards:2']);
    assert.ok(r.out.includes('Rec* p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!p) { return 0; } return p->a;'), r.out);
  });

  it('changes nothing without the facts', () => {
    const r = run(GUARDS, null);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves tests from separate ifs with no shared exit', () => {
    const r = run(GUARDS, layout(GUARDS, [2, 5, 9]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('takes separate ifs that all leave through the one return copy after the tests', () => {
    // Every return prints 0xa8, inside a copy at 0xa4..0xb0 entered by two jumps and a fall.
    const ev = layout(GUARDS, [2, 5, 9], [{ start: 0xa4, ret: 0xb0, insns: [], jumpsIn: [0x20, 0x50], fallsIn: true }]);
    for (const l of [3, 6, 10]) (ev.lines as Map<number, number[]>).set(l, [0xa8]);
    const r = run(GUARDS, ev);
    assert.deepStrictEqual(r.sites, ['p:guards:2']);
  });

  it('leaves a copy that sits between the tests', () => {
    const ev = layout(GUARDS, [2, 5, 9], [{ start: 0x30, ret: 0x38, insns: [], jumpsIn: [0x50, 0x90], fallsIn: true }]);
    for (const l of [3, 6, 10]) (ev.lines as Map<number, number[]>).set(l, [0x34]);
    const r = run(GUARDS, ev);
    assert.deepStrictEqual(r.sites, []);
  });

  // GetPetUidByIndex, 005747b0: one decompiled condition, but its return copy sits after the
  // first test, before the range tests; the guards as printed already match.
  it('leaves one condition whose return copy precedes the last test', () => {
    const ev = layout(GUARDS, [2], [{ start: 0x30, ret: 0x38, insns: [], jumpsIn: [0x50, 0x90], fallsIn: true }]);
    for (const l of [3, 6, 10]) (ev.lines as Map<number, number[]>).set(l, [0x34]);
    const r = run(GUARDS, ev);
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves guards that return different values', () => {
    const src = GUARDS.map((l, i) => (i === 5 ? '    return 1;' : l));
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('negates a `!(a && b)` guard into its conjuncts', () => {
    const src = [
      'int f(int i) {',
      '  if (!(i >= 0 && i < gT->nSize)) {',
      '    return 2;',
      '  }',
      '  Rec* p = gT->pTxt + i;',
      '  if (!(p && p->b > 0)) {',
      '    return 2;',
      '  }',
      '  return p->a;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, ['p:guards:1']);
    assert.ok(r.out.includes('Rec* p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!(p && p->b > 0)) { return 2; }'), r.out);
  });

  it('takes a positive null test followed by the same return', () => {
    const src = [
      'int f(int i) {',
      '  if (!(i >= 0 && i < gT->nSize)) {',
      '    return 0;',
      '  }',
      '  Rec* p = gT->pTxt + i;',
      '  if (p) {',
      '    gT->nSize = p->a;',
      '  }',
      '  return 0;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, ['p:guards-then:1']);
    assert.ok(r.out.includes('Rec* p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (p) { gT->nSize = p->a; } return 0;'), r.out);
  });

  // MISSILE_CltDoFn51_RecyclerDelay, 004d5dd0.
  it('lifts the nested form out of its range block', () => {
    const src = [
      'void f(int i) {',
      '  Rec* p;',
      '  if (i >= 0 && i < gT->nSize) {',
      '    p = gT->pTxt + i;',
      '    if (p) {',
      '      gT->nSize = p->a;',
      '      return;',
      '    }',
      '  }',
      '  gT->nSize = 0;',
      '}',
    ];
    const r = run(src, layout(src, [3]));
    assert.deepStrictEqual(r.sites, ['p:nested:1']);
    assert.ok(r.out.includes('p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (p) { gT->nSize = p->a; return; } gT->nSize = 0;'), r.out);
  });

  it('leaves the nested form when the pointer is read after it', () => {
    const src = [
      'int f(int i) {',
      '  Rec* p = 0;',
      '  if (i >= 0 && i < gT->nSize) {',
      '    p = gT->pTxt + i;',
      '    if (p) {',
      '      gT->nSize = p->a;',
      '    }',
      '  }',
      '  return p != 0;',
      '}',
    ];
    const r = run(src, layout(src, [3]));
    assert.deepStrictEqual(r.sites, []);
  });

  // Skills_SrvDoFunc_135_SpawnMinionFromParams, 005d2490: the base held, the record read as p[i].
  it('turns a held base into the record pointer', () => {
    const src = [
      'int f(int i) {',
      '  if (i < 0) {',
      '    return 0;',
      '  }',
      '  if (i >= gT->nSize) {',
      '    return 0;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 0;',
      '  }',
      '  return p[i].a + (&p[i])->b;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, ['p:held:2']);
    assert.ok(r.out.includes('Rec* p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!p) { return 0; } return p->a + p->b;'), r.out);
  });

  it('leaves a held base read at another index', () => {
    const src = [
      'int f(int i) {',
      '  if (i < 0) {',
      '    return 0;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 0;',
      '  }',
      '  return p[i].a + p[0].a;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a held base whose index is written after it', () => {
    const src = [
      'int f(int i) {',
      '  if (i < 0) {',
      '    return 0;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 0;',
      '  }',
      '  i = p[i].b;',
      '  return p[i].a;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, []);
  });

  // MISSMODE_SrvDoFn07_GuidedMissile, 005ae780: the index is reused for the field it reads.
  it('takes a held base whose index is rewritten by its last read', () => {
    const src = [
      'int f(int i) {',
      '  if (!(i >= 0 && i < gT->nSize)) {',
      '    return 2;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 2;',
      '  }',
      '  Use(i);',
      '  i = p[i].b;',
      '  if (i <= 0) {',
      '    i = 5;',
      '  }',
      '  return i;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, ['p:held:1']);
    assert.ok(r.out.includes('Rec* p = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!p) { return 2; } Use(i); i = p->b;'), r.out);
  });

  it('leaves a held base read in a loop that rewrites the index', () => {
    const src = [
      'int f(int i) {',
      '  if (!(i >= 0 && i < gT->nSize)) {',
      '    return 2;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 2;',
      '  }',
      '  int s = 0;',
      '  while (s < 9) {',
      '    s = s + p[i].b;',
      '    i = 0;',
      '  }',
      '  return s;',
      '}',
    ];
    const r = run(src, layout(src, [2]));
    assert.deepStrictEqual(r.sites, []);
  });

  const TYPES: Partial<RecordGetterSplitOptions> = {
    globalTypes: { gT: 'Table *' },
    structFields: { Table: { pTxt: 'Rec *', nSize: 'int' }, Rec: { a: 'int', b: 'int' } },
    functionReturnTypes: { Use: 'int' },
  };

  // SOUND_GetIdFromUnit, 004c1d60: the null test is on the table member itself, no local.
  const BARE = [
    'int f(int i) {',
    '  short d;',
    '  if (i < 0) {',
    '    return 7;',
    '  }',
    '  if (i >= gT->nSize) {',
    '    return 7;',
    '  }',
    '  if (!(gT->pTxt + i)) {',
    '    return 7;',
    '  }',
    '  d = gT->pTxt[i].b;',
    '  return d + gT->pTxt[i].a;',
    '}',
  ];

  it('gives a bare null test its record pointer and routes the reads after it', () => {
    const r = run(BARE, layout(BARE, [3]), TYPES);
    assert.deepStrictEqual(r.sites, ['pTxtRecord:bare:2']);
    assert.ok(r.out.includes('short int d; Rec* pTxtRecord = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!pTxtRecord) { return 7; } d = pTxtRecord->b; return d + pTxtRecord->a;'), r.out);
  });

  it('leaves a bare null test without the declarations', () => {
    const r = run(BARE, layout(BARE, [3]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a bare null test whose tests leave through separate copies', () => {
    const r = run(BARE, layout(BARE, [3, 6, 9]), TYPES);
    assert.deepStrictEqual(r.sites, []);
  });

  // Skills_CltDoFunc_Ass_AuraLevel_CastAttackTarget 004f2720: the record is only null-tested.
  it('takes a bare null test whose record nothing reads', () => {
    const src = [...BARE.slice(0, 11), '  return Use(i);', '}'];
    const r = run(src, layout(src, [3]), TYPES);
    assert.deepStrictEqual(r.sites, ['pTxtRecord:bare:2']);
    assert.ok(r.out.includes('Rec* pTxtRecord = i >= 0 && i < gT->nSize ? gT->pTxt + i : nullptr; if (!pTxtRecord) { return 7; } return Use(i);'), r.out);
  });

  it('leaves a bare null test whose reads sit past a call', () => {
    const src = [...BARE.slice(0, 11), '  Use(i);', '  return gT->pTxt[i].a;', '}'];
    const r = run(src, layout(src, [3]), TYPES);
    assert.deepStrictEqual(r.sites, []);
  });

  it('keeps a guard that returns something else out of the record', () => {
    const src = BARE.map((l, k) => (k === 3 ? '    return 8;' : l));
    const r = run(src, layout(src, [3]), TYPES);
    assert.deepStrictEqual(r.sites, ['pTxtRecord:bare:1']);
    assert.ok(r.out.includes('if (i < 0) { return 8; } Rec* pTxtRecord = i < gT->nSize ? gT->pTxt + i : nullptr; if (!pTxtRecord) { return 7; }'), r.out);
  });

  it('leaves a bare null test with a label after it', () => {
    const src = [...BARE.slice(0, 11), '  L:', ...BARE.slice(11)];
    const r = run(src, layout(src, [3]), TYPES);
    assert.deepStrictEqual(r.sites, []);
  });

  it('stops routing a bare record at a call', () => {
    const src = [...BARE.slice(0, 12), '  Use(d);', ...BARE.slice(12)];
    const r = run(src, layout(src, [3]), TYPES);
    assert.deepStrictEqual(r.sites, ['pTxtRecord:bare:2']);
    assert.ok(r.out.includes('d = pTxtRecord->b; Use(d); return d + gT->pTxt[i].a;'), r.out);
  });

  it('computes what the bare and rewritten-index forms computed', { skip: !hasNativeGpp() }, () => {
    const g = [
      'int g(int i) {',
      '  if (!(i >= 0 && i < gT->nSize)) {',
      '    return 2;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return 2;',
      '  }',
      '  i = p[i].b;',
      '  if (i <= 3) {',
      '    i = 5;',
      '  }',
      '  return i;',
      '}',
    ];
    const a = run(BARE, layout(BARE, [3]), TYPES);
    const b = run(g, layout(g, [2]));
    assert.strictEqual(a.sites.length + b.sites.length, 2);
    const src = (x: string, y: string) => [PRELUDE, 'int Use(int v) { return v; }', x, y].join('\n');
    const main = [
      'static Rec rows[3] = {{1,2},{3,4},{5,6}};',
      'static Table t = {rows, 3};',
      'gT = &t;',
      'for (int i = -2; i <= 4; i++) printf("%d %d ", f(i), g(i));',
    ].join('\n');
    const before = compileAndRun(src(BARE.join('\n'), g.join('\n')), main);
    const after = compileAndRun(src(a.out, b.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });

  it('computes what the split guards computed', { skip: !hasNativeGpp() }, () => {
    const held = [
      'int g(int i) {',
      '  if (i < 0) {',
      '    return -1;',
      '  }',
      '  if (i >= gT->nSize) {',
      '    return -1;',
      '  }',
      '  Rec* p = gT->pTxt;',
      '  if (!(p + i)) {',
      '    return -1;',
      '  }',
      '  return p[i].a * 10 + p[i].b;',
      '}',
    ];
    const nested = [
      'int h(int i) {',
      '  Rec* p;',
      '  if (i >= 0 && i < gT->nSize) {',
      '    p = gT->pTxt + i;',
      '    if (p) {',
      '      return p->b;',
      '    }',
      '  }',
      '  return -7;',
      '}',
    ];
    const a = run(GUARDS, layout(GUARDS, [2]));
    const b = run(held, layout(held, [2]));
    const c = run(nested, layout(nested, [3]));
    assert.strictEqual(a.sites.length + b.sites.length + c.sites.length, 3);
    const src = (x: string, y: string, z: string) => [PRELUDE, x, y, z].join('\n');
    const main = [
      'static Rec rows[3] = {{1,2},{3,4},{5,6}};',
      'static Table t = {rows, 3};',
      'gT = &t;',
      'for (int i = -2; i <= 4; i++) printf("%d %d %d ", f(i), g(i), h(i));',
    ].join('\n');
    const before = compileAndRun(src(GUARDS.join('\n'), held.join('\n'), nested.join('\n')), main);
    const after = compileAndRun(src(a.out, b.out, c.out), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });
});

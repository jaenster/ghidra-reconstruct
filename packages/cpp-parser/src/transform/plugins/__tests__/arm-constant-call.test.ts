import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { hasNativeGpp, compileAndRun } from '../../../testing/native-cpp.js';
import { armConstantCallPlugin, type ArmConstantCallOptions } from '../builtins/arm-constant-call.js';
import { nestCallPlugin, type NestCallOptions } from '../builtins/nest-call.js';
import { branchLayoutPlugin, type BranchLayoutOptions } from '../builtins/branch-layout/index.js';
import type { BranchLayoutEvidence, PushImmediate } from '../builtins/branch-layout/evidence.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

// OOGUTIL_UpdateLevelRestrictionControls, 004451c0, cut down.
const SRC = [
  'void f(int c, int *out) {',       // 1
  '  int nAlign;',                    // 2
  '  if (c) {',                       // 3
  '    out[0] = 1;',                  // 4
  '    nAlign = 4;',                  // 5
  '  } else {',                       // 6
  '    out[0] = 2;',                  // 7
  '    nAlign = 5;',                  // 8
  '  }',                              // 9
  '  int v = Get(7);',                // 10
  '  Set(out, v, nAlign);',           // 11
  '  Done();',                        // 12
  '}',
];

/** Line 5 pushes 4 and jumps to 0x120, line 8 pushes 5 and falls into it, line 10 prints 0x120. */
function layout(pushes: PushImmediate[] = [
  { at: 0x9e, value: 4, reach: 0x120, jumps: true, run: 1 },
  { at: 0x11e, value: 5, reach: 0x120, jumps: false, run: 1 },
]): BranchLayoutEvidence {
  return {
    lines: new Map([[4, [0x90]], [5, [0x9e]], [7, [0x110]], [8, [0x11e]], [10, [0x120, 0x125]], [11, [0x132]], [12, [0x137]]]),
    ifs: new Map([[3, 0x13]]),
    pushes,
  };
}

function run(lines: string[], ev: BranchLayoutEvidence | null, opts: Partial<ArmConstantCallOptions> = {}) {
  const sites: string[] = [];
  const t = armConstantCallPlugin.createTransformer({
    branchLayout: ev, onSite: e => sites.push(`${e.locals.join(',')}:${e.arms}:${e.statements}`), ...opts,
  } as ArmConstantCallOptions);
  return { out: flat(emit(t(parse(lines.join('\n'))) as AnyNode)), sites, tree: t };
}

describe('arm-constant-call', () => {
  it('writes the call into each arm with its constant', () => {
    const r = run(SRC, layout());
    assert.deepStrictEqual(r.sites, ['nAlign:2:2']);
    assert.ok(r.out.includes('if (c) { out[0] = 1; int v = Get(7); Set(out, v, 4); } else { out[0] = 2; int v = Get(7); Set(out, v, 5); } Done();'), r.out);
    assert.ok(!r.out.includes('int nAlign;'), r.out);
  });

  it('changes nothing without the push facts', () => {
    assert.deepStrictEqual(run(SRC, { ...layout(), pushes: undefined }).sites, []);
    assert.deepStrictEqual(run(SRC, null).sites, []);
  });

  it('leaves arms whose pushes go to different places', () => {
    const r = run(SRC, layout([
      { at: 0x9e, value: 4, reach: 0x120, jumps: true, run: 1 },
      { at: 0x11e, value: 5, reach: 0x130, jumps: true, run: 1 },
    ]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves a push of another value', () => {
    const r = run(SRC, layout([
      { at: 0x9e, value: 4, reach: 0x120, jumps: true, run: 1 },
      { at: 0x11e, value: 6, reach: 0x120, jumps: false, run: 1 },
    ]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('leaves two arms that both fall into the join', () => {
    const r = run(SRC, layout([
      { at: 0x9e, value: 4, reach: 0x120, jumps: false, run: 1 },
      { at: 0x11e, value: 5, reach: 0x120, jumps: false, run: 1 },
    ]));
    assert.deepStrictEqual(r.sites, []);
  });

  it('keeps the stores of a local read after the call', () => {
    const src = SRC.map((l, i) => (i === 11 ? '  Done(nAlign);' : l));
    const r = run(src, layout());
    assert.deepStrictEqual(r.sites, ['nAlign:2:2']);
    assert.ok(r.out.includes('nAlign = 4; int v = Get(7); Set(out, v, 4);'), r.out);
    assert.ok(r.out.includes('Done(nAlign);'), r.out);
  });

  it('leaves a join whose declaration is named after it', () => {
    const src = SRC.map((l, i) => (i === 11 ? '  Done(v);' : l));
    assert.deepStrictEqual(run(src, layout()).sites, []);
  });

  it('leaves a shared assertion halt to halt-site-fold', () => {
    const src = [
      'void f(int c) {',
      '  int nLine;',
      '  if (c) {',
      '    Use(1);',
      '    nLine = 4;',
      '  } else {',
      '    Use(2);',
      '    nLine = 5;',
      '  }',
      '  int v = Get(7);',
      '  ERROR_UnrecoverableInternalError_Halt("", v, nLine);',
      '  exit(-1);',
      '}',
    ];
    assert.deepStrictEqual(run(src, layout()).sites, []);
  });

  it('gives the copies of the first call the pushes the arm made', () => {
    const callOrder = { lines: new Map([[10, [{ name: 'Get', at: 0x125, prev: null, pushes: 0, slots: [1] }]], [11, [{ name: 'Set', at: 0x132, prev: 0x125, pushes: 2, slots: [1, 1, 1] }]]]) };
    const t = armConstantCallPlugin.createTransformer({ branchLayout: layout(), callOrder } as ArmConstantCallOptions);
    const tree = t(parse(SRC.join('\n'))) as AnyNode;
    const sites: { name: string; pushes: number }[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown> & { ghidraInfo?: { callSite?: { name: string; pushes: number } } };
      if (o.kind === 'CallExpr' && o.ghidraInfo?.callSite) sites.push({ name: o.ghidraInfo.callSite.name, pushes: o.ghidraInfo.callSite.pushes });
      for (const [k, v] of Object.entries(o)) if (k !== 'location' && k !== 'ghidraInfo') Array.isArray(v) ? v.forEach(walk) : walk(v);
    };
    walk(tree);
    assert.deepStrictEqual(sites, [{ name: 'Get', pushes: 1 }, { name: 'Set', pushes: 2 }, { name: 'Get', pushes: 1 }, { name: 'Set', pushes: 2 }]);
  });

  // The copies claim the call's line twice; nest-call reads their own facts instead.
  it('lets nest-call fold the temporary of each copy', () => {
    // `push 4` in the arm, `push 7; call Get; push eax; push out; call Set` after the join.
    const callOrder = { lines: new Map([[10, [{ name: 'Get', at: 0x125, prev: null, pushes: 1, slots: [1] }]], [11, [{ name: 'Set', at: 0x132, prev: 0x125, pushes: 2, slots: [1, 1, 1] }]]]) };
    const a = armConstantCallPlugin.createTransformer({ branchLayout: layout(), callOrder } as ArmConstantCallOptions);
    const n = nestCallPlugin.createTransformer({ callOrder, functionReturnTypes: { Get: 'int' } } as NestCallOptions);
    const src = SRC.map((l, i) => (i === 1 ? '  int nAlign; int v;' : i === 9 ? '  v = Get(7);' : l));
    const out = flat(emit(n(a(parse(src.join('\n')))) as AnyNode));
    assert.ok(out.includes('if (c) { out[0] = 1; Set(out, Get(7), 4); } else { out[0] = 2; Set(out, Get(7), 5); }'), out);
  });

  it('computes what the join computed', { skip: !hasNativeGpp() }, () => {
    const r = run(SRC, layout());
    assert.strictEqual(r.sites.length, 1);
    const prelude = 'int g; int Get(int k) { return k + g++; } void Set(int *o, int v, int a) { o[1] = v * 10 + a; } void Done() {}';
    const main = 'int o[2]; for (int c = 0; c < 2; c++) { f(c, o); printf("%d %d ", o[0], o[1]); }';
    const before = compileAndRun([prelude, SRC.join('\n')].join('\n'), main);
    const after = compileAndRun([prelude, r.out].join('\n'), main);
    assert.ok(before.length > 0);
    assert.strictEqual(after, before);
  });

  // MISSILE_CltDoFn61_OverseerControl, 004d7690, cut down: the arms are only the stores, so
  // their copies of the call are all that is left of them. The original tests, pushes the
  // else arm's constant and jumps to the call, then pushes the then arm's and falls into it:
  // the source wrote the else arm first.
  it('keeps the dropped stores as the evidence of where each arm lies', () => {
    const src = [
      'void f(unsigned int s, int *p) {', // 1
      '  int nChoice;',                    // 2
      '  if ((s & 1) == 0) {',             // 3
      '    nChoice = 422;',                // 4
      '  } else {',                        // 5
      '    nChoice = 416;',                // 6
      '  }',                               // 7
      '  Create(p, nChoice);',             // 8
      '}',
    ];
    const ev: BranchLayoutEvidence = {
      lines: new Map([[3, [0x39, 0x43]], [4, [0x4c]], [6, [0x45]], [8, [0x51]]]),
      ifs: new Map([[3, 0x43]]),
      edges: [{ line: 3, ord: 0, keyword: 'if', jcc: 0x43, target: 0x4c, fall: 0x45, fallLines: [6], takenLines: [4] }],
      pushes: [
        { at: 0x45, value: 416, reach: 0x51, jumps: true, run: 1 },
        { at: 0x4c, value: 422, reach: 0x51, jumps: false, run: 1 },
      ],
    };
    const ast = armConstantCallPlugin.createTransformer({ branchLayout: ev } as ArmConstantCallOptions)(parse(src.join('\n')));
    const out = flat(emit(branchLayoutPlugin.createTransformer({ branchLayout: ev } as BranchLayoutOptions)(ast) as AnyNode));
    assert.ok(out.includes('if ((s & 1) != 0) { Create(p, 416); } else { Create(p, 422); }'), out);
  });
});

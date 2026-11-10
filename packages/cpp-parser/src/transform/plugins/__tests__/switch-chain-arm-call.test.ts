import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { switchChainPlugin } from '../builtins/switch-chain.js';
import { armConstantCallPlugin } from '../builtins/arm-constant-call.js';
import type { BranchLayoutEvidence } from '../builtins/branch-layout/evidence.js';

// AITHINK_Fn1_ClawViper 005f1b60, reduced to its first color-state decision.
// SUB EAX,0 / SUB EAX,2 are one countdown run. The original pushes each color
// inside its arm and calls SetState at their shared target.
const src = [
  'void f(Unit *pUnit, short nStateType) {',
  '  int eStateColor;',
  '  if (nStateType != 0) {',
  '    if (nStateType == 2) {',
  '      eStateColor = STATE_red;',
  '    } else {',
  '      eStateColor = STATE_blue;',
  '    }',
  '    SetState(pUnit, eStateColor, 0);',
  '  }',
  '}',
].join('\n');

function layout(outer = 0x10): BranchLayoutEvidence {
  const inner = outer + 5;
  const blue = outer + 0xc;
  const red = outer + 0x10;
  const join = outer + 0x12;
  return {
    lines: new Map([[3, [outer]], [4, [inner]], [5, [red]], [7, [blue]], [9, [join, join + 1]]]),
    ifs: new Map(),
    tests: new Map([
      [3, [{ op: '!=', mnemonic: 'SUB', reg: 'EAX', delta: 0, k: 0, size: 4, at: outer }]],
      [4, [{ op: '==', mnemonic: 'SUB', reg: 'EAX', delta: 2, k: 2, size: 4, at: inner }]],
    ]),
    pushes: [
      { at: blue, value: 0x5a, reach: join, jumps: true, run: 1 },
      { at: red, value: 0x5b, reach: join, jumps: false, run: 1 },
    ],
  };
}

function run(ev: BranchLayoutEvidence, withArmCall = true, code = src,
  onSite?: (e: { rule: 'switch' | 'left'; line: number; cases: number; why?: string }) => void): string {
  const tree = switchChainPlugin.createTransformer({
    branchLayout: ev,
    ...(withArmCall ? { armCall: { branchLayout: ev, enumValues: { STATE_blue: 0x5a, STATE_red: 0x5b } } } : {}),
    onSite,
  })(parse(code)) as AnyNode;
  return emit(tree).replace(/\s+/g, ' ');
}

describe('switch-chain arm call handoff', () => {
  it('moves the shared call into the two cases when original pushes were in their arms', () => {
    const out = run(layout(0x36)); // 005f1b96 SUB EAX,0; 005f1b9b SUB EAX,2.
    assert.match(out, /switch \(nStateType\)/);
    assert.match(out, /case 2: \{ SetState\(pUnit, STATE_red, 0\); break; \}/);
    assert.match(out, /default: \{ SetState\(pUnit, STATE_blue, 0\); break; \}/);
    assert.match(out, /case 0: \{ break; \}/);
    assert.equal(out.match(/SetState\(/g)?.length, 2);
    assert.doesNotMatch(out, /eStateColor/);
    assert.doesNotMatch(run(layout(0x36), false), /switch \(nStateType\)/);
  });

  it('handles the second Claw Viper Ex site with its state-one call', () => {
    const second = src.replace('eStateColor, 0', 'eStateColor, 1');
    const out = run(layout(0x224), true, second); // 005f2004 / 005f2009; PUSHes 005f2010/14.
    assert.match(out, /switch \(nStateType\)/);
    assert.match(out, /case 2: \{ SetState\(pUnit, STATE_red, 1\); break; \}/);
    assert.match(out, /default: \{ SetState\(pUnit, STATE_blue, 1\); break; \}/);
    assert.match(out, /case 0: \{ break; \}/);
    assert.equal(out.match(/SetState\(/g)?.length, 2);
  });

  it('covers the other two native call layouts', () => {
    for (const [outer, flag] of [[0x1dc, 1], [0x36, 0]] as const) {
      const out = run(layout(outer), true, src.replace('eStateColor, 0', `eStateColor, ${flag}`));
      assert.match(out, /switch \(nStateType\)/);
      assert.match(out, new RegExp(`SetState\\(pUnit, STATE_red, ${flag}\\)`));
      assert.match(out, new RegExp(`SetState\\(pUnit, STATE_blue, ${flag}\\)`));
      assert.equal(out.match(/SetState\(/g)?.length, 2);
    }
  });

  it('falls back when two inner calls rewrite but only one parent forms a switch', () => {
    const code = [
      'void g(Unit *pUnit, short nStateType, int c) {',
      '  int colorA;',
      '  if (nStateType != 0) {',
      '    if (nStateType == 2) {',
      '      colorA = STATE_red;',
      '    } else {',
      '      colorA = STATE_blue;',
      '    }',
      '    SetState(pUnit, colorA, 0);',
      '  }',
      '  int colorB;',
      '  if (c) {',
      '    if (nStateType == 2) {',
      '      colorB = STATE_red;',
      '    } else {',
      '      colorB = STATE_blue;',
      '    }',
      '    SetState(pUnit, colorB, 1);',
      '  }',
      '}',
    ].join('\n');
    const ev = layout(0x36);
    ev.lines = new Map([...ev.lines, [13, [0x105]], [14, [0x110]], [16, [0x10c]], [18, [0x112, 0x113]]]);
    // The second SUB remains eligible for arm-call, but its delta is not a valid
    // countdown for case 2, so switch-chain must reject that parent.
    ev.tests = new Map([...ev.tests!, [13, [{ op: '==', mnemonic: 'SUB', reg: 'EBX', delta: 1, k: 2, size: 4, at: 0x105 }]]]);
    ev.pushes = [...ev.pushes!,
      { at: 0x10c, value: 0x5a, reach: 0x112, jumps: true, run: 1 },
      { at: 0x110, value: 0x5b, reach: 0x112, jumps: false, run: 1 },
    ];
    const rewrittenLines: number[] = [];
    const split = armConstantCallPlugin.createTransformer({
      branchLayout: ev, testedArmsOnly: true,
      enumValues: { STATE_blue: 0x5a, STATE_red: 0x5b },
      onSite: e => rewrittenLines.push(e.line),
    })(parse(code)) as AnyNode;
    assert.deepEqual(rewrittenLines, [4, 13]);
    const partial = emit(switchChainPlugin.createTransformer({ branchLayout: ev })(split) as AnyNode);
    assert.match(partial, /switch \(nStateType\)/);
    assert.match(partial, /if \(c\)/);
    assert.match(partial, /SetState\(pUnit, STATE_red, 1\)/);
    assert.equal(partial.match(/switch \(nStateType\)/g)?.length, 1);
    const early = run(ev, true, code);
    const baseline = run(ev, false, code);
    assert.equal(early, baseline);
    assert.match(early, /SetState\(pUnit, colorA, 0\)/);
    assert.match(early, /SetState\(pUnit, colorB, 1\)/);
  });

  it('tracks a switch head inside another parent if', () => {
    const code = src.replace('short nStateType)', 'short nStateType, bool flag)')
      .replace('  if (nStateType != 0) {', '  if (flag) {\n    if (nStateType != 0) {')
      .replace('    SetState(pUnit, eStateColor, 0);\n  }', '    SetState(pUnit, eStateColor, 0);\n    }\n  }');
    const ev = layout(0x36);
    ev.lines = new Map([...ev.lines].map(([line, offsets]) => [line >= 3 ? line + 1 : line, offsets]));
    ev.tests = new Map([...ev.tests!].map(([line, tests]) => [line >= 3 ? line + 1 : line, tests]));
    const out = run(ev, true, code);
    assert.match(out, /if \(flag\).*switch \(nStateType\)/);
    assert.match(out, /SetState\(pUnit, STATE_red, 0\)/);
    assert.match(out, /SetState\(pUnit, STATE_blue, 0\)/);
  });

  it('keeps a genuinely shared call when no arm push facts support copying it', () => {
    const ev = { ...layout(), pushes: [] };
    const out = run(ev);
    assert.doesNotMatch(out, /switch \(nStateType\)/);
    assert.match(out, /SetState\(pUnit, eStateColor, 0\)/);
  });

  it('keeps a shared call when unrelated PUSH facts exist in the function', () => {
    const ev = { ...layout(), pushes: [
      { at: 0x2a, value: 0, reach: 0x30, jumps: true, run: 1 },
      { at: 0x2c, value: 1, reach: 0x30, jumps: false, run: 1 },
    ] };
    const out = run(ev);
    assert.doesNotMatch(out, /switch \(nStateType\)/);
    assert.match(out, /SetState\(pUnit, eStateColor, 0\)/);
  });

  it('does not run the early call rewrite for a non-subtraction test', () => {
    const base = layout();
    const ev = { ...base, tests: new Map(base.tests) };
    ev.tests.set(4, [{ op: '==', mnemonic: 'CMP', reg: 'EAX', k: 2, size: 4, at: 0x15 }]);
    const out = run(ev);
    assert.doesNotMatch(out, /switch \(nStateType\)/);
    assert.match(out, /SetState\(pUnit, eStateColor, 0\)/);
  });

  it('does not retain an early rewrite just because another switch formed', () => {
    const other = [
      'void g(Unit *pUnit, int c, short nStateType, int v) {',
      '  int eStateColor;',
      '  if (c) {',
      '    if (nStateType == 2) {',
      '      eStateColor = STATE_red;',
      '    } else {',
      '      eStateColor = STATE_blue;',
      '    }',
      '    SetState(pUnit, eStateColor, 0);',
      '  }',
      '  if (v == 0) {',
      '    A();',
      '  } else {',
      '    B();',
      '  }',
      '}',
    ].join('\n');
    const ev = layout();
    ev.tests = new Map([
      [4, [{ op: '==', mnemonic: 'SUB', reg: 'EAX', delta: 2, k: 2, size: 4, at: 0x15 }]],
      [11, [{ op: '==', mnemonic: 'SUB', reg: 'ECX', delta: 0, k: 0, size: 4, at: 0x40 }]],
    ]);
    ev.lines = new Map([...ev.lines, [11, [0x40]], [12, [0x50]], [14, [0x60]]]);
    const out = run(ev, true, other);
    assert.match(out, /switch \(v\)/);
    assert.match(out, /SetState\(pUnit, eStateColor, 0\)/);
    const earlyReports: string[] = [], baselineReports: string[] = [];
    run(ev, true, other, e => earlyReports.push(`${e.rule}:${e.line}:${e.why ?? ''}`));
    run(ev, false, other, e => baselineReports.push(`${e.rule}:${e.line}:${e.why ?? ''}`));
    assert.deepEqual(earlyReports, baselineReports);
  });

  it('recomputes diagnostics when an early arm rewrite forms no switch', () => {
    const base = layout();
    const tests = new Map(base.tests);
    tests.set(4, [{ op: '==', mnemonic: 'SUB', reg: 'EAX', delta: 1, k: 2, size: 4, at: 0x15 }]);
    const ev = { ...base, tests };
    const earlyReports: string[] = [], baselineReports: string[] = [];
    const early = run(ev, true, src, e => earlyReports.push(`${e.rule}:${e.line}:${e.why ?? ''}`));
    const baseline = run(ev, false, src, e => baselineReports.push(`${e.rule}:${e.line}:${e.why ?? ''}`));
    assert.equal(early, baseline);
    assert.deepEqual(earlyReports, baselineReports);
    assert.doesNotMatch(early, /switch \(nStateType\)/);
  });

  it('leaves truth-value PUSH splitting to the later arm-call pass', () => {
    const truth = 'void h(Unit *a, Unit *b, short n) { SetRel(a, b, (uint32_t)(n != 0xffff)); }';
    const ev: BranchLayoutEvidence = {
      lines: new Map([[1, [0x10, 0x1a]]]),
      ifs: new Map(),
      pushes: [
        { at: 0x14, value: 0, reach: 0x1a, jumps: true, run: 1 },
        { at: 0x18, value: 1, reach: 0x1a, jumps: false, run: 1 },
      ],
    };
    const transform = (testedArmsOnly: boolean) => emit(armConstantCallPlugin.createTransformer({
      branchLayout: ev, testedArmsOnly,
    })(parse(truth)) as AnyNode).replace(/\s+/g, ' ');
    assert.match(transform(false), /if \(n == 0xffff\)/);
    assert.doesNotMatch(transform(true), /if \(n == 0xffff\)/);
    assert.match(transform(true), /SetRel\(a, b, \(uint32_t\)\(n != 0xffff\)\)/);
  });
});

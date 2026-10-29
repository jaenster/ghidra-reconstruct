import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { haltSiteFoldPlugin, type HaltLineSite, type HaltLineRepairEvent } from '../builtins/halt-site-fold.js';

const HALT = 'ERROR_UnrecoverableInternalError_Halt';
const IP = 'GetInstructionPointer';

function run(code: string, paths: HaltLineSite['paths'], ifs?: Map<number, number>): { out: string; events: HaltLineRepairEvent[] } {
  const events: HaltLineRepairEvent[] = [];
  const t = haltSiteFoldPlugin.createTransformer({
    haltLines: [{ at: 0x100, ip: 0xf0, paths }],
    branchLayout: ifs ? { ifs } : undefined,
    onRepair: (e: HaltLineRepairEvent) => events.push(e),
  } as never);
  return { out: emit(t(parse(code)) as AnyNode).trim(), events };
}

const halt = (line: string) => `${HALT}("", ${IP}(), ${line});`;

describe('halt-site-fold - each way into a shared halt gets its own pushed line', () => {
  it('replaces a return address read at the wrong depth (the Q09 shape)', () => {
    const { out, events } = run(`int f(int a, int b) {
  int32_t nErrorLine;
  void *nIp;
  nErrorLine = 0x598e36;
  if (a == 0) {
LAB_00598e57:
    nIp = ${IP}();
    ${HALT}("", nIp, nErrorLine);
    exit(-1);
  }
  if (b == 0) {
    nErrorLine = 0x195;
    goto LAB_00598e57;
  }
  return 0;
}`, [{ line: 0x186, guard: 0x30 }, { line: 0x195, guard: 0x6c }]);
    assert.deepStrictEqual(events, [{ entries: 1, lines: [0x186] }]);
    assert.ok(out.includes(halt('0x186')), out);
    assert.ok(out.includes(halt('0x195')), out);
    assert.ok(!out.includes('0x598e36'), out);
    assert.ok(!out.includes('nErrorLine'), out);
    assert.ok(!out.includes('goto'), out);
  });

  it('gives the fall-through of an if without else its line (the Alloc shape)', () => {
    const { out } = run(`void *f(int a, int b) {
  int32_t nLine = 0x40a10d;
  if (a < 4) {
    if (!b) {
      g();
      nLine = 0x4f8;
    } else {
      if (b > 2) {
        return 0;
      }
      nLine = 0x4ff;
    }
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`, [{ line: 0x4f3, guard: 0x90 }, { line: 0x4f8, guard: null }, { line: 0x4ff, guard: 0xe6 }]);
    assert.ok(out.includes(halt('0x4f3')), out);
    assert.ok(out.includes(halt('0x4f8')), out);
    assert.ok(out.includes(halt('0x4ff')), out);
    assert.ok(!out.includes('0x40a10d'), out);
  });

  it('splits a failing && into one assertion per operand, in branch order', () => {
    const { out } = run(`void f(int *p, int n, int m) {
  int32_t nErrorLine;
  if (p && p[0] == 7 && n <= m) {
    use(p);
    return;
  }
  ${HALT}("", ${IP}(), nErrorLine);
  exit(-1);
}`, [{ line: 0x21e, guard: 0x26 }, { line: 0x21d, guard: 0x2 }, { line: 0x21f, guard: 0x32 }]);
    assert.strictEqual(out, `void f(int* p, int n, int m) {
  if (!p) {
    ${halt('0x21d')}
    exit(-1);
  }
  if (p[0] != 7) {
    ${halt('0x21e')}
    exit(-1);
  }
  if (!(n <= m)) {
    ${halt('0x21f')}
    exit(-1);
  }
  use(p);
  return;
}`);
  });

  it('splits an || that guards the shared tail', () => {
    const { out } = run(`void f(int a, int b) {
  uint32_t nErrorLine;
  if (!a || !b) {
    ${HALT}("", ${IP}(), nErrorLine);
    exit(-1);
  }
  go(a, b);
}`, [{ line: 0x45c, guard: 0xb }, { line: 0x45d, guard: 0x2e }]);
    assert.ok(/if \(!a\) \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x45c\);/.test(out), out);
    assert.ok(/if \(!b\) \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x45d\);/.test(out), out);
  });

  it('pairs several wrong ways by the branch that selects each line', () => {
    const code = `void f(int a, int b, int c) {
  int32_t nLine;
  if (a) {
    if (b) {
      if (c) {
        return;
      }
      nLine = 0x109;
    }
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`;
    const paths = [{ line: 0x102, guard: 0x28 }, { line: 0x106, guard: 0x59 }, { line: 0x109, guard: 0x74 }];
    // Without the branches the two bare ways cannot be told apart.
    const blind = run(code, paths);
    assert.ok(blind.events[0].refused, JSON.stringify(blind.events));
    assert.ok(!blind.out.includes('0x102'), blind.out);
    // `if (a)` is on line 3, `if (b)` on line 4 of the parsed text.
    const { out, events } = run(code, paths, new Map([[3, 0x28], [4, 0x59], [5, 0x60]]));
    assert.deepStrictEqual(events.map(e => ({ ...e, lines: [...e.lines].sort((a, b) => a - b) })), [{ entries: 2, lines: [0x102, 0x106] }]);
    assert.ok(/if \(a\) \{[\s\S]*\} else \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x102\);/.test(out), out);
    assert.ok(/if \(b\) \{[\s\S]*\} else \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x106\);/.test(out), out);
  });

  it('changes nothing when every way already prints a pushed line', () => {
    const code = `void f(int a) {
  int32_t nLine;
  if (a) {
    nLine = 0x2e8;
  } else {
    nLine = 0x2e6;
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`;
    const withFacts = run(code, [{ line: 0x2e6, guard: 4 }, { line: 0x2e8, guard: null }]);
    const without = emit(haltSiteFoldPlugin.createTransformer({})(parse(code)) as AnyNode).trim();
    assert.strictEqual(withFacts.out, without);
    assert.deepStrictEqual(withFacts.events, []);
  });

  it('refuses when the printed ways and the pushed lines do not pair up', () => {
    const code = `void f(int a, int b) {
  int32_t nLine;
  if (a > b) {
    nLine = 0x10;
  } else {
    work();
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`;
    // three pushed lines, two printed ways
    const r = run(code, [{ line: 0x10, guard: 1 }, { line: 0x11, guard: 2 }, { line: 0x12, guard: 3 }]);
    assert.ok(r.events[0]?.refused?.includes('2 printed ways for 3 pushed lines'), JSON.stringify(r.events));
    assert.ok(!r.out.includes('0x11'), r.out);
    // a way that pushes no immediate leaves the function alone
    const n = run(code, [{ line: 0x10, guard: 1 }, { line: null, guard: null }]);
    assert.ok(n.events[0]?.refused, JSON.stringify(n.events));
  });

  it('only acts on a function with one halt CALL', () => {
    const code = `void f(int a) {
  int32_t nLine = 0x401234;
  if (a) {
    ${HALT}("", ${IP}(), nLine);
    exit(-1);
  }
}`;
    const events: HaltLineRepairEvent[] = [];
    const t = haltSiteFoldPlugin.createTransformer({
      haltLines: [{ at: 1, ip: 0, paths: [{ line: 5, guard: 1 }, { line: 6, guard: 2 }] }, { at: 9, ip: 8, paths: [{ line: 7, guard: 3 }] }],
      onRepair: (e: HaltLineRepairEvent) => events.push(e),
    } as never);
    const out = emit(t(parse(code)) as AnyNode).trim();
    assert.ok(out.includes('0x401234'), out);
    assert.deepStrictEqual(events, []);
  });

  it('keeps a stale store that something still reads', () => {
    const { out } = run(`int f(int a) {
  int32_t nLine = 0x401234;
  int r = nLine + a;
  if (a) {
    ${HALT}("", ${IP}(), nLine);
    exit(-1);
  }
  if (a > 1) {
    nLine = 9;
    ${HALT}("", ${IP}(), nLine);
    exit(-1);
  }
  return r;
}`, [{ line: 8, guard: 1 }, { line: 9, guard: 2 }]);
    assert.ok(out.includes(halt('8')) || out.includes(halt('0x8')), out);
    assert.ok(out.includes('0x401234'), out);
  });
});

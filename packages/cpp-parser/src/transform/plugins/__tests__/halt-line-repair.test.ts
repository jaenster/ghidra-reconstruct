import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { haltSiteFoldPlugin, type HaltLineSite, type HaltLineRepairEvent } from '../builtins/halt-site-fold.js';

const HALT = 'ERROR_UnrecoverableInternalError_Halt';
const IP = 'GetInstructionPointer';

function run(code: string, paths: HaltLineSite['paths'], ifs?: Map<number, number>, operands?: Map<number, number[][]>): { out: string; events: HaltLineRepairEvent[] } {
  const events: HaltLineRepairEvent[] = [];
  const t = haltSiteFoldPlugin.createTransformer({
    haltLines: [{ at: 0x100, ip: 0xf0, paths }],
    branchLayout: ifs ? { ifs, operands } : undefined,
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

  it('passes the instruction pointer uncast when its temporary was cast', () => {
    const { out } = run(`void f(int a, int b) {
  int32_t nLine;
  int32_t nIp;
  if (a) {
    if (b) {
      return;
    }
    nLine = 0x3e3;
  }
  nIp = (int32_t)${IP}();
  ${HALT}("", nIp, nLine);
  exit(-1);
}`, [{ line: 0x3e2, guard: 1 }, { line: 0x3e3, guard: 2 }]);
    // The copy for the repaired way takes the bare call, whatever its parameter's type.
    assert.ok(out.includes(halt('0x3e2')), out);
    assert.ok(!out.includes(`(int32_t)${IP}(), 0x3e2`), out);
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

  // STRTABLE_GetStringByIndex 00524930: `if ((int)i < n && (p = .., p < end))` printed on
  // one line, split by comma-expand into two nested ifs that keep that line. The line's
  // operand branches (0x28, 0x59) tell the two false sides apart.
  const splitChain = `int f(int i, int n, char *p, char *end, int *t) {
  int32_t nLine;
  if (i < n) { p = p + i; if (p < end) {
      if (*p != 1) {
        nLine = 0x107;
      } else {
        if (t[i]) {
          return t[i];
        }
        nLine = 0x109;
      }
    }
  }
  ${HALT}("", ${IP}(), nLine);
  exit(-1);
}`;
  const splitPaths = [{ line: 0x102, guard: 0x28 }, { line: 0x106, guard: 0x59 }, { line: 0x107, guard: 0x67 }, { line: 0x109, guard: 0x74 }];

  it('tells the split operands of one short-circuit line apart by their branches', () => {
    const { out, events } = run(splitChain, splitPaths, new Map([[3, 0x59], [4, 0x67], [7, 0x74]]), new Map([[3, [[0x28], [0x59]]]]));
    assert.deepStrictEqual(events.map(e => ({ ...e, lines: [...e.lines].sort((a, b) => a - b) })), [{ entries: 2, lines: [0x102, 0x106] }]);
    assert.ok(/if \(i < n\) \{[\s\S]*\} else \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x102\);/.test(out), out);
    assert.ok(/if \(p < end\) \{[\s\S]*\} else \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x106\);/.test(out), out);
    assert.ok(!out.includes('nLine'), out);
  });

  it('leaves a shared line alone when its ifs and operands do not pair up', () => {
    // Three operands for two ifs: no operand is forced onto either.
    const r = run(splitChain, splitPaths, new Map([[3, 0x59]]), new Map([[3, [[0x28], [0x40], [0x59]]]]));
    assert.ok(r.events[0]?.refused?.includes('no branch that tells them apart'), JSON.stringify(r.events));
    assert.ok(!r.out.includes('0x102'), r.out);
    // Without the operand facts the shared line says nothing.
    const blind = run(splitChain, splitPaths, new Map([[3, 0x59]]));
    assert.ok(blind.events[0]?.refused, JSON.stringify(blind.events));
  });

  // A register line (unaff_EDI) assigned on the one way that arrives at the depth the
  // decompiler read; the other ways print it unassigned. One PUSH (0x384) is reached twice:
  // by a Jcc that jumps to it and by the Jcc it falls out of, so the decompile prints four
  // ways for three PUSHes and only the branches can pair them.
  const registerLine = `int f(int *pNpc, int *out) {
  int32_t unaff_EDI;
  char bHasStore;
  if (pNpc) {
    if (pNpc != (int *)-32 && (bHasStore = *(char *)pNpc, bHasStore != 0)) {
      if (pNpc[1]) {
        return 1;
      }
      if (bHasStore) {
        *out = 0;
        return 0;
      }
    }
  } else {
    unaff_EDI = 0x389;
  }
  ${HALT}("", ${IP}(), unaff_EDI);
  exit(-1);
}`;
  const registerIfs = new Map([[4, 0x19], [5, 0x30], [6, 0x45], [9, 0xd6]]);
  const registerOperands = new Map([[5, [[0x25], [0x30]]]]);

  it('pairs a register line set on one way by the branches, a PUSH reached twice included (SUNITNPC_RollTradeListItemCode)', () => {
    const paths = [{ line: 0x383, guard: 0x25, guards: [0x25] }, { line: 0x384, guard: 0x30, guards: [0x30, 0xd6] }, { line: 0x389, guard: 0x19, guards: [0x19] }];
    const { out, events } = run(registerLine, paths, registerIfs, registerOperands);
    assert.deepStrictEqual(events.map(e => ({ ...e, lines: [...e.lines].sort((a, b) => a - b) })), [{ entries: 4, lines: [0x383, 0x384, 0x384, 0x389] }]);
    assert.ok(/if \(pNpc == \(int\*\)-32\) \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x383\);/.test(out), out);
    assert.strictEqual(out.split(halt('0x384')).length - 1, 2, out);
    assert.ok(/\} else \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x389\);/.test(out), out);
    assert.ok(!out.includes('unaff_EDI'), out);
    // Each way halts where its own condition fails, in the order the tests run.
    assert.ok(out.indexOf(halt('0x383')) < out.indexOf(halt('0x384')), out);
    assert.ok(out.indexOf('pNpc[1]') < out.lastIndexOf(halt('0x384')), out);
  });

  it('leaves a register line alone without the second branch into a PUSH', () => {
    // Older facts know only the one Jcc per PUSH: the fourth way has no line to take.
    const paths = [{ line: 0x383, guard: 0x25 }, { line: 0x384, guard: 0x30 }, { line: 0x389, guard: 0x19 }];
    const { out, events } = run(registerLine, paths, registerIfs, registerOperands);
    assert.ok(events[0]?.refused?.includes('by branches'), JSON.stringify(events));
    assert.ok(out.includes(halt('unaff_EDI')), out);
  });

  it('pairs a parameter line over nested ifs of one line and a halt copy (ARENA_ApplyScoreModifier)', () => {
    // The 0x73 and 0x94 ways push at the depth the decompiler read; the other four push
    // two slots deeper and print the caller's dwParam. Line 6 is one decompile line that
    // was split into two ifs: its three operands' branches are 0x35, 0x46, 0x59.
    const code = `void f(int *u, int *a, int *c, int k, int dw) {
  int t;
  if (!u || *u != 0) {
    dw = 0x73;
  } else {
    if (a && c) { t = g(c); if (k < 7) {
        if (k == 2) {
          if (!h(k)) {
            goto LAB_tail;
          }
        }
        *a = t;
        if (*c) {
          return;
        }
        dw = 0x94;
      }
    }
  }
LAB_tail:
  ${HALT}("", ${IP}(), dw);
  exit(-1);
}`;
    const paths = [
      { line: 0x73, guard: 0x5, guards: [0x5, 0xa] }, { line: 0x77, guard: 0x35, guards: [0x35] },
      { line: 0x6c, guard: 0x46, guards: [0x46] }, { line: 0x7d, guard: null, guards: [0x59] },
      { line: 0x8c, guard: 0x87, guards: [0x87] }, { line: 0x94, guard: 0xc0, guards: [0xc0] },
    ];
    const { out, events } = run(code, paths, new Map([[3, 0xa], [6, 0x59], [8, 0x87], [13, 0xc0]]), new Map([[3, [[0x5], [0xa]]], [6, [[0x35], [0x46], [0x59]]]]));
    assert.deepStrictEqual(events.map(e => ({ ...e, lines: [...e.lines].sort((a, b) => a - b) })), [{ entries: 6, lines: [0x6c, 0x73, 0x77, 0x7d, 0x8c, 0x94] }]);
    for (const l of ['0x73', '0x77', '0x6c', '0x7d', '0x8c', '0x94']) assert.ok(out.includes(halt(l)), `${l}\n${out}`);
    assert.ok(!out.includes(halt('dw')), out);
    assert.ok(!out.includes('goto'), out);
    assert.ok(/if \(!h\(k\)\) \{\s*ERROR_UnrecoverableInternalError_Halt\("", GetInstructionPointer\(\), 0x8c\);/.test(out), out);
    // a before c before k: the operand halts keep the order of the tests.
    assert.ok(out.indexOf(halt('0x77')) < out.indexOf(halt('0x6c')) && out.indexOf(halt('0x6c')) < out.indexOf(halt('0x7d')), out);
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

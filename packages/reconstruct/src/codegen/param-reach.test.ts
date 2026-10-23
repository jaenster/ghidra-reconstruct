import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse, emit, frameGroupLocalsPlugin } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { createParamReachOracle } from './param-reach.js';

/** A callee as the snapshot carries it: prototype, and the decompile with its signature. */
function fn(name: string, params: [string, string][], body: string, extra: Partial<ExtractedFunction> = {}): ExtractedFunction {
  const sig = params.map(([t, n]) => `${t} ${n}`).join(',');
  return {
    name,
    address: '00401000',
    signature: `void ${name}(${sig})`,
    returnType: 'void',
    parameters: params.map(([t, n], i) => ({ name: n, dataType: t, size: 4, ordinal: i })),
    localVariables: [],
    decompiled: `\nvoid __cdecl ${name}(${sig})\n\n{\n${body}\n}\n`,
    callingConvention: '__cdecl',
    size: 16,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
    ...extra,
  };
}

function oracleOf(fns: ExtractedFunction[]) {
  return createParamReachOracle(new Map(fns.map(f => [f.name, f])), []);
}

/** The caller from the classification: two adjacent ints, both addresses passed out. */
const slots = [
  { name: 'nX', offset: -12, size: 4 },
  { name: 'nY', offset: -8, size: 4 },
];
const caller = (call: string) => `void caller() {
  int nX;
  int nY;
  ${call}
  use(nX, nY);
}`;

function grouped(call: string, fns: ExtractedFunction[]): boolean {
  const oracle = oracleOf(fns);
  const t = frameGroupLocalsPlugin.createTransformer({
    slots,
    argReach: (c: string, i: number, n: number) => oracle.argReach(c, i, n),
  } as never);
  const out = emit(t(parse(caller(call))) as never);
  return /struct\s+__frame0_t/.test(out);
}

describe('frame-group-locals with callee reach', () => {
  it('two out-parameters, one word each: no group', () => {
    const get = fn('GetPair', [['int *', 'pnX'], ['int *', 'pnY']], '  *pnX = 1;\n  *pnY = 2;');
    assert.strictEqual(grouped('GetPair(&nX, &nY);', [get]), false);
  });

  it('a callee that indexes [1] through an int *: group', () => {
    const line = fn('DrawLine', [['int *', 'pnStart']], '  gx = *pnStart;\n  gy = pnStart[1];');
    assert.strictEqual(grouped('DrawLine(&nX);', [line]), true);
  });

  it('a callee that memsets past the local: group', () => {
    const clear = fn('Clear', [['int *', 'p']], '  memset(p, 0, 8);');
    assert.strictEqual(grouped('Clear(&nX);', [clear]), true);
  });

  it('a callee that memsets exactly the local: no group', () => {
    const clear = fn('Clear', [['int *', 'p']], '  memset(p, 0, 4);');
    const other = fn('Other', [['int *', 'p']], '  *p = 0;');
    assert.strictEqual(grouped('Clear(&nX); Other(&nY);', [clear, other]), false);
  });

  it('a pass-through to a callee that reaches past: group', () => {
    const inner = fn('Inner', [['int *', 'p']], '  p[1] = 0;');
    const outer = fn('Outer', [['int *', 'p']], '  Inner(p);');
    assert.strictEqual(grouped('Outer(&nX);', [inner, outer]), true);
  });

  it('a pass-through to a callee that stays inside: no group', () => {
    const inner = fn('Inner', [['int *', 'p']], '  *p = 0;');
    const outer = fn('Outer', [['int *', 'p']], '  if (p != 0) Inner(p);');
    assert.strictEqual(grouped('Outer(&nX); Outer(&nY);', [inner, outer]), false);
  });

  it('an indirect call: group', () => {
    assert.strictEqual(grouped('(*gpfnHandler)(&nX);', []), true);
  });

  it('a callee the model does not know: group', () => {
    assert.strictEqual(grouped('GetCursorPos(&nX);', []), true);
  });

  it('a callee passing the pointer to an indirect call: group', () => {
    const disp = fn('Dispatch', [['int *', 'p']], '  (*gpfnHandler)(p);');
    assert.strictEqual(grouped('Dispatch(&nX);', [disp]), true);
  });

  it('a recursive callee: group', () => {
    const rec = fn('Walk', [['int *', 'p'], ['int', 'n']], '  *p = n;\n  if (n != 0) Walk(p, n - 1);');
    assert.strictEqual(grouped('Walk(&nX, 3);', [rec]), true);
  });

  it('mutual recursion: group', () => {
    const a = fn('A', [['int *', 'p']], '  *p = 0;\n  B(p);');
    const b = fn('B', [['int *', 'p']], '  A(p);');
    assert.strictEqual(grouped('A(&nX);', [a, b]), true);
  });

  it('an argument count that disagrees with the prototype: group', () => {
    const get = fn('GetOne', [['int *', 'p']], '  *p = 1;');
    assert.strictEqual(grouped('GetOne(&nX, 1);', [get]), true);
  });

  it('a body reading arguments outside its prototype: group', () => {
    const odd = fn('Odd', [['int *', 'p']], '  *p = 1;\n  *in_stack_00000008 = 2;');
    assert.strictEqual(grouped('Odd(&nX);', [odd]), true);
  });

  it('an address stored, not passed: group', () => {
    assert.strictEqual(grouped('gpSaved = &nX;', []), true);
  });
});

describe('createParamReachOracle', () => {
  it('answers the same whichever function of a cycle is asked first', () => {
    // A and B call each other; C reaches [4, 8) and only A's second parameter flows there.
    const mk = () => [
      fn('A', [['int *', 'p'], ['int *', 'q']], '  *p = 0;\n  B(p, q);\n  C(q);'),
      fn('B', [['int *', 'p'], ['int *', 'q']], '  A(p, q);'),
      fn('C', [['int *', 'p']], '  p[1] = 0;'),
    ];
    const first = oracleOf(mk());
    const aFirst = [first.argReach('A', 0, 2), first.argReach('A', 1, 2), first.argReach('B', 0, 2), first.argReach('B', 1, 2)];
    const second = oracleOf(mk());
    const bFirst = [second.argReach('B', 0, 2), second.argReach('B', 1, 2), second.argReach('A', 0, 2), second.argReach('A', 1, 2)];
    assert.deepStrictEqual([aFirst[0], aFirst[1], aFirst[2], aFirst[3]], [bFirst[2], bFirst[3], bFirst[0], bFirst[1]]);
    // Every parameter that flows round the cycle is unknown.
    assert.strictEqual(aFirst[0], null);
    assert.strictEqual(aFirst[2], null);
  });

  it('settles a function outside any cycle', () => {
    const o = oracleOf([fn('C', [['int *', 'p']], '  p[1] = 0;')]);
    assert.deepStrictEqual(o.argReach('C', 0, 1), { lo: 4, hi: 8 });
    assert.deepStrictEqual(o.argReach('::C', 0, 1), { lo: 4, hi: 8 });
  });
});

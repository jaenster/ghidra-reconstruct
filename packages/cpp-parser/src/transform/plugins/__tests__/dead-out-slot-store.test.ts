/**
 * dead-out-slot-store and cfg/out-param: the PUSH-reg slot store before a call that
 * overwrites the local through its address, proven from the callee's own body.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, CompoundStmt, FunctionDecl, Statement } from '../../../ast/nodes.js';
import { deadOutSlotStorePlugin } from '../builtins/dead-out-slot-store.js';
import { outParamWidths } from '../../cfg/out-param.js';

const SIZES: Record<string, number> = { int: 4, uint: 4, 'BigData *': 4, BigData: 0x168, short: 2, 'short int': 2, byte: 1 };
const typeSize = (s: string) => (s.trim().endsWith('*') ? 4 : SIZES[s.trim()] ?? null);

/** Out-parameter widths of the one function in `src`, its params typed `T *` with T's size given. */
function widths(src: string, pointee: (number | null)[], callees: Record<string, number[]> = {}) {
  const tu = parse(src) as unknown as { declarations: FunctionDecl[] };
  const fn = tu.declarations.find(d => d.kind === NodeKind.FunctionDecl)!;
  const params = fn.parameters.map(p => (p as unknown as { name: { name: string } }).name.name);
  return outParamWidths((fn.body as CompoundStmt).statements as Statement[], params, {
    pointeeWidth: i => pointee[i] ?? null,
    typeSize,
    calleeOut: (c, i) => (callees[c]?.includes(i) ? 4 : null),
    noreturn: new Set(['_exit', 'ERROR_UnrecoverableInternalError_Halt']),
  });
}

describe('cfg/out-param', () => {
  it('SBigNew 00423950: written on both returning paths', () => {
    const w = widths(`void SBigNew(BigData **pp) { BigData *p; p = SMemAlloc(0x168); if (p != 0) { p = ctor(p); *pp = p; return; } *pp = 0; return; }`, [4]);
    assert.equal(w.get(0), 4);
  });
  it('a read before the write is not an out-parameter (Memory::Free reads *pp)', () => {
    assert.equal(widths(`void Free(void *heap, void **pp) { if (*pp) release(*pp); *pp = 0; }`, [null, 4]).get(1), undefined);
  });
  it('a path that returns without writing is not one (SRegLoadValue fails without writing)', () => {
    assert.equal(widths(`int Load(char *k, int *pOut) { if (k == 0) { err(0x57); return 0; } *pOut = read(k); return 1; }`, [1, 4]).get(1), undefined);
  });
  it('a null test is not a read; a halt path does not return (SFileOpenFileEx, GetShiftedFrameMetrics)', () => {
    assert.equal(widths(`int Open(char *n, void **ph) { int r = -1; if (ph == 0) r = 0; else *ph = 0; if (!n) { ERROR_UnrecoverableInternalError_Halt("", 0, 1); _exit(-1); } return r; }`, [1, 4]).get(1), undefined,
      'the ph == 0 path returns without writing');
    assert.equal(widths(`void M(int *u, int *pF) { if (u == 0) { ERROR_UnrecoverableInternalError_Halt("", 0, 1); _exit(-1); } if (*u) { *pF = 1; return; } *pF = 2; }`, [4, 4]).get(1), 4);
  });
  it('passing it on to an out-parameter writes it (SFileLoadFile -> SFileLoadFileEx2)', () => {
    assert.equal(widths(`int L(char *n, void **pp) { return LoadEx(0, n, pp); }`, [1, 4], { LoadEx: [2] }).get(1), 4);
    assert.equal(widths(`int L(char *n, void **pp) { return Other(0, n, pp); }`, [1, 4]).get(1), undefined);
  });
  it('a narrower store through a cast is reported narrow', () => {
    assert.equal(widths(`void S(int *p) { *(short *)p = 1; }`, [4]).get(0), 2);
  });
});

const PUSHED = [{ local: 'pNewBigInt', value: 'pData' }, { local: 'q', value: 'p' }, { local: 'n', value: 'pGame' }];
function run(src: string, out: Record<string, number> = { 'Storm::Source::SBig::SBigNew': 4, GetFrames: 4 }, pushSlotInits = PUSHED) {
  const t = deadOutSlotStorePlugin.createTransformer({ outParamWidth: (c: string, i: number) => (i === 0 || c === 'GetFrames') && c in out ? out[c] : null, typeSize, pushSlotInits });
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

describe('dead-out-slot-store', () => {
  it('SHA1_FromBigIntBytes 0052a270: the PUSH ECX store before SBigNew(&p) goes', () => {
    const out = run(`BigData * f(void *pData, uint n) { BigData *pNewBigInt; pNewBigInt = pData; Storm::Source::SBig::SBigNew(&pNewBigInt); SBigFromBinary(pNewBigInt, pData, n); return pNewBigInt; }`);
    assert.doesNotMatch(out, /pNewBigInt = pData/);
    assert.match(out, /BigData\* pNewBigInt; Storm::Source::SBig::SBigNew\(&pNewBigInt\);/);
  });
  it('keeps the store when the callee is not proven to write first, or writes too little', () => {
    assert.match(run(`void f(void *p) { BigData *q; q = p; Unknown(&q); use(q); }`), /q = p;/);
    assert.match(run(`void f(void *p) { double q; q = 1.0; Storm::Source::SBig::SBigNew((BigData**)&q); use(q); }`), /q = 1\.0;/);
  });
  it('keeps the store when the next statement reads it, or its address was taken elsewhere', () => {
    assert.match(run(`void f(void *p) { BigData *q; q = p; Storm::Source::SBig::SBigNew(q ? &q : 0); use(q); }`), /q = p;/);
    assert.match(run(`void f(void *p) { BigData *q; g(&q); q = p; Storm::Source::SBig::SBigNew(&q); use(q); }`), /q = p;/);
  });
  it('only the PUSH-reg store: not a store the source made, nor a slot the prologue did not push', () => {
    // `n = 0` is a MOV the source wrote; and a local outside a pushed slot is never a candidate.
    assert.match(run(`void f(D2GameStrc *pGame) { int n; n = 0; GetFrames(0, 0, &n); use(n); }`), /n = 0;/);
    assert.match(run(`BigData * f(void *pData) { BigData *pNewBigInt; pNewBigInt = pData; Storm::Source::SBig::SBigNew(&pNewBigInt); return pNewBigInt; }`, undefined, []),
      /pNewBigInt = pData;/);
  });
  it('the call may be the value of an assignment or an initializer', () => {
    const out = run(`void f(D2UnitStrc *pUnit, D2GameStrc *pGame) { int n; int r; n = (int)pGame; r = GetFrames(pUnit, 0, &n); use(n, r); }`);
    assert.doesNotMatch(out, /n = \(int\)pGame/);
  });
});

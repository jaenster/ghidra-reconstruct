/**
 * carry-chains: a 64-bit add/subtract split into halves, reassembled where both halves
 * are one LARGE_INTEGER. Positive cases are checked by EXECUTION against the split form
 * as printed (reference CARRY4 from the definition) over 64-bit edge values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { pseudoOpLowerPlugin } from '../builtins/pseudo-op-lower.js';
import { ARTIFACT_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

/** The winnt.h shapes: LARGE_INTEGER is a union of the halves and the 64-bit value. */
const TABLES = {
  structFields: {
    _LARGE_INTEGER: { u: '_struct_20', QuadPart: 'LONGLONG' },
    _struct_20: { LowPart: 'DWORD', HighPart: 'LONG' },
    WorkerStats: { qpcStart: 'LARGE_INTEGER', qpcEnd: 'LARGE_INTEGER', qpcAccum: 'LARGE_INTEGER' },
  },
  typedefTargets: { LARGE_INTEGER: '_LARGE_INTEGER' },
  unionNames: ['_LARGE_INTEGER'],
};

function lower(code: string): string {
  return emit(pseudoOpLowerPlugin.createTransformer(TABLES)(parse(code)) as AnyNode).trim();
}

const PRELUDE = [
  'typedef unsigned int uint;', 'typedef unsigned int DWORD;', 'typedef int LONG;', 'typedef long long LONGLONG;',
  'typedef long long longlong;',
  'struct _struct_20 { DWORD LowPart; LONG HighPart; };',
  'typedef union _LARGE_INTEGER { _struct_20 u; LONGLONG QuadPart; } LARGE_INTEGER;',
  'struct WorkerStats { LARGE_INTEGER qpcStart; LARGE_INTEGER qpcEnd; LARGE_INTEGER qpcAccum; };',
  ...ARTIFACT_SUPPORT_LINES,
  'static bool CARRY4(uint32_t a, uint32_t b) { return (uint64_t)a + b > 0xffffffffull; }',
  'static inline unsigned long long CONCAT44(uint32_t hi, uint32_t lo) { return (unsigned long long)hi << 32 | lo; }',
].join('\n');

const VALUES = ['0', '1', '0xffffffff', '0x100000000', '0x7fffffffffffffff', '0x8000000000000000', '0xffffffffffffffff', '0x00000001ffffffff', '0x80000000ffffffff', '0x123456789abcdef0'];

/** Run ref::f and low::f (three LARGE_INTEGER inputs, a 64-bit result) over the value grid. */
function disagreements(src: string): { bad: string; lowered: string } {
  const lowered = lower(src);
  const body = [
    `const unsigned long long V[] = {${VALUES.map(v => `${v}ull`).join(', ')}}; long bad = 0;`,
    'for (auto a : V) for (auto b : V) for (auto c : V) {',
    '  WorkerStats s1, s2; s1.qpcAccum.QuadPart = s2.qpcAccum.QuadPart = (LONGLONG)a;',
    '  s1.qpcStart.QuadPart = s2.qpcStart.QuadPart = (LONGLONG)b; s1.qpcEnd.QuadPart = s2.qpcEnd.QuadPart = (LONGLONG)c;',
    '  unsigned long long r1 = ref::f(&s1), r2 = low::f(&s2);',
    '  if (r1 != r2 || s1.qpcAccum.QuadPart != s2.qpcAccum.QuadPart || s1.qpcEnd.QuadPart != s2.qpcEnd.QuadPart) bad++;',
    '}',
    'printf("%ld\\n", bad);',
  ].join('\n');
  const out = compileAndRun(`${PRELUDE}\nnamespace ref {\n${src}\n}\nnamespace low {\n${lowered}\n}`, body, { flags: ['-fwrapv'] });
  return { bad: out.trim(), lowered };
}

describe('carry-chains: one LARGE_INTEGER on each side', native, () => {
  it('AcceptThreadMain 006c2860: accum += end - start, through register copies and a reused pointer', () => {
    const src = `unsigned long long f(WorkerStats *pW) {
      uint dwQpcDelta; LONG *pnAccumHigh; LARGE_INTEGER *pQpcAccum; uint dwAccumBeforAdd; uint dwQpcAccumLow;
      LONG nStopFlag; uint dwQpcPrevLow; LONG nQpcPrevHigh;
      dwQpcAccumLow = pW->qpcEnd.u.LowPart;
      nStopFlag = pW->qpcEnd.u.HighPart;
      pQpcAccum = &pW->qpcStart;
      dwQpcPrevLow = (pQpcAccum->u).LowPart;
      dwAccumBeforAdd = dwQpcAccumLow - (pQpcAccum->u).LowPart;
      nQpcPrevHigh = pW->qpcStart.u.HighPart;
      pQpcAccum = &pW->qpcAccum;
      dwQpcDelta = (pQpcAccum->u).LowPart;
      (pQpcAccum->u).LowPart = (pQpcAccum->u).LowPart + dwAccumBeforAdd;
      pnAccumHigh = &pW->qpcAccum.u.HighPart;
      *pnAccumHigh = *pnAccumHigh + ((nStopFlag - nQpcPrevHigh) - (uint)(dwQpcAccumLow < dwQpcPrevLow)) +
                     (uint)CARRY4(dwQpcDelta,dwAccumBeforAdd);
      return (unsigned long long)pW->qpcAccum.QuadPart; }`;
    const r = disagreements(src);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /pW->qpcAccum\.QuadPart \+= pW->qpcEnd\.QuadPart - pW->qpcStart\.QuadPart;/);
    assert.doesNotMatch(r.lowered, /CARRY4|LowPart|HighPart|dwQpcDelta|pnAccumHigh/);
  });

  it('D2GFX_CalculateGammaRamp 004f6130 shape: subtract with the borrow in a variable, then CONCAT44 of the result', () => {
    const src = `unsigned long long f(WorkerStats *pW) {
      bool bBorrow; longlong lVar1;
      bBorrow = pW->qpcEnd.u.LowPart < pW->qpcStart.u.LowPart;
      pW->qpcEnd.u.LowPart = pW->qpcEnd.u.LowPart - pW->qpcStart.u.LowPart;
      pW->qpcEnd.u.HighPart = (pW->qpcEnd.u.HighPart - pW->qpcStart.u.HighPart) - (uint)bBorrow;
      lVar1 = CONCAT44(pW->qpcEnd.u.HighPart,pW->qpcEnd.u.LowPart);
      return (unsigned long long)lVar1; }`;
    const r = disagreements(src);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /pW->qpcEnd\.QuadPart -= pW->qpcStart\.QuadPart;/);
    assert.match(r.lowered, /lVar1 = \(uint64_t\)pW->qpcEnd\.QuadPart;/);
    assert.doesNotMatch(r.lowered, /bBorrow/);
  });
});

describe('carry-chains: copies and zero tests of one object', native, () => {
  it('AcceptThreadMain: a stamp copied half by half through a register is one 64-bit copy, and its zero test is one', () => {
    const src = `unsigned long long f(WorkerStats *pW) {
      LONG nQpcHighCopy;
      if (pW->qpcEnd.u.LowPart == 0 && pW->qpcEnd.u.HighPart == 0) {
        nQpcHighCopy = pW->qpcStart.u.HighPart;
        pW->qpcEnd.u.LowPart = pW->qpcStart.u.LowPart;
        pW->qpcEnd.u.HighPart = nQpcHighCopy;
      }
      return (unsigned long long)pW->qpcEnd.QuadPart + (pW->qpcAccum.u.LowPart != 0 || pW->qpcAccum.u.HighPart != 0); }`;
    const r = disagreements(src);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /pW->qpcEnd\.QuadPart = pW->qpcStart\.QuadPart;/);
    assert.match(r.lowered, /pW->qpcEnd\.QuadPart == 0/);
    assert.match(r.lowered, /pW->qpcAccum\.QuadPart != 0/);
    assert.doesNotMatch(r.lowered, /nQpcHighCopy/);
  });
});

describe('carry-chains: what is left alone', () => {
  const base = `void f(WorkerStats *pW, uint *pOther) {
      uint dwOld; uint dwAdd;
      dwAdd = pW->qpcEnd.u.LowPart;
      dwOld = pW->qpcAccum.u.LowPart;
      pW->qpcAccum.u.LowPart = pW->qpcAccum.u.LowPart + dwAdd;
      BETWEEN
      pW->qpcAccum.u.HighPart = pW->qpcAccum.u.HighPart + HIGHSRC + (uint)CARRY4(dwOld,dwAdd); }`;
  it('the base shape merges', () => {
    assert.match(lower(base.replace('BETWEEN', '').replace('HIGHSRC', 'pW->qpcEnd.u.HighPart')), /qpcAccum\.QuadPart \+= pW->qpcEnd\.QuadPart/);
  });
  it('a store through another pointer between the halves', () => {
    const out = lower(base.replace('BETWEEN', '*pOther = 1;').replace('HIGHSRC', 'pW->qpcEnd.u.HighPart'));
    assert.doesNotMatch(out, /QuadPart/);
  });
  it('a read of the target between the halves', () => {
    const out = lower(base.replace('BETWEEN', '*pOther = pW->qpcAccum.u.LowPart;').replace('HIGHSRC', 'pW->qpcEnd.u.HighPart'));
    assert.doesNotMatch(out, /QuadPart/);
  });
  it('halves of two different objects are not one operand', () => {
    const out = lower(base.replace('BETWEEN', '').replace('HIGHSRC', 'pW->qpcStart.u.HighPart'));
    assert.doesNotMatch(out, /QuadPart/);
  });
  it('two plain 32-bit variables are never merged (that is a Ghidra retype)', () => {
    const out = lower(`void f(uint a, uint b, uint *pLo, uint *pHi) { uint lo; uint hi; bool bCarry;
      lo = *pLo; hi = *pHi; bCarry = CARRY4(lo, a); lo = lo + a; hi = hi + b + bCarry; *pLo = lo; *pHi = hi; }`);
    assert.doesNotMatch(out, /QuadPart|uint64_t/);
  });
});

/**
 * shift-def moves a constant right shift every read of a call result applies back into the
 * one write. GetCurrentLifePercentage (00621f20) and MONSTER_GetHpPercent (005a5650) are the
 * shapes it is for; the refusals keep a value the source shifted at each read. Where it
 * rewrites, the function is also run natively before and after.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createShiftDefTransformer, type ShiftDefOptions } from '../builtins/shift-def.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const raw = (code: string, o: ShiftDefOptions = {}) => emit(createShiftDefTransformer(o)(parse(code)) as AnyNode);
const run = (code: string, o: ShiftDefOptions = {}) => flat(raw(code, o));
const same = (code: string, o: ShiftDefOptions = {}) => assert.strictEqual(run(code, o), flat(emit(parse(code) as AnyNode)));

/** Run `fn` before and after the pass under one driver; the outputs must agree. */
function agrees(prelude: string, fn: string, driver: string, o: ShiftDefOptions = {}) {
  if (!hasNativeGpp()) return;
  const before = compileAndRun(prelude + '\n' + fn, driver);
  const after = compileAndRun(prelude + '\n' + raw(fn, o), driver);
  assert.strictEqual(after, before);
}

const RET = { functionReturnTypes: { GetStat: 'int', GetMaxHp: 'int32_t', GetFlags: 'uint32_t' } };
const PRELUDE = `static int stat = 0; static int32_t maxhp = 0; static uint32_t flags = 0;
int GetStat(int u) { return stat + u; } int32_t GetMaxHp(int u) { return maxhp - u; } uint32_t GetFlags(int u) { return flags ^ (uint32_t)u; }`;
const DRIVER = (call: string) => `int vals[] = {0, 1, 255, 256, 257, -1, -256, -257, 0x7fffffff, (int)0x80000000, 12345678, -12345678};
  for (int a : vals) for (int b : vals) { stat = a; maxhp = b; flags = (uint32_t)a * 7u;
    for (int u = -2; u <= 2; u++) printf("%d ", (int)${call}); }
  printf("\\n");`;

// 00621f20, reduced.
const LIFE = `int f(int u) {
  int nCurHp = GetStat(u);
  int32_t nMaxHp = GetMaxHp(u);
  if (nMaxHp >> 8) {
    return (nCurHp >> 8) * 100 / (nMaxHp >> 8);
  }
  return 0;
}`;

describe('shiftDefPlugin', () => {
  it('shifts each call result once, where it is stored', () => {
    assert.strictEqual(run(LIFE, RET),
      flat(`int f(int u) { int nCurHp = GetStat(u) >> 8; int32_t nMaxHp = GetMaxHp(u) >> 8; if (nMaxHp) { return nCurHp * 100 / nMaxHp; } return 0; }`));
    agrees(PRELUDE, LIFE, DRIVER('f(u)'), RET);
  });

  // 005a5650, reduced: one local shifted at its reads, the other once into a second local.
  it('leaves a local the source shifted into another local, and moves the one shifted at its reads', () => {
    const code = `int f(int u) {
  int nHp = GetStat(u);
  int32_t nMaxHp = GetMaxHp(u);
  int nMaxHpShifted = nMaxHp >> 8;
  if (nMaxHpShifted > 0 && nHp >> 8 < nMaxHpShifted) {
    return (uint8_t)((nHp >> 8 << 7) / nMaxHpShifted);
  }
  return 100;
}`;
    assert.strictEqual(run(code, RET), flat(`int f(int u) { int nHp = GetStat(u) >> 8; int32_t nMaxHp = GetMaxHp(u) >> 8; int nMaxHpShifted = nMaxHp; if (nMaxHpShifted > 0 && nHp < nMaxHpShifted) { return (uint8_t)((nHp << 7) / nMaxHpShifted); } return 100; }`));
    agrees(PRELUDE, code, DRIVER('f(u)'), RET);
  });

  it('converts to the local\'s type first when the callee returns another signedness', () => {
    const code = `int f(int u) {
  int n = GetFlags(u);
  return (n >> 4) + 1;
}`;
    assert.strictEqual(run(code, RET), flat(`int f(int u) { int n = (int)GetFlags(u) >> 4; return n + 1; }`));
    agrees(PRELUDE, code, DRIVER('f(u)'), RET);
  });

  it('converts when the return type is not known', () => {
    assert.strictEqual(run(`int f(int u) { int n; n = GetStat(u); return n >> 3; }`),
      flat(`int f(int u) { int n; n = (int)GetStat(u) >> 3; return n; }`));
  });

  // 004afb60: the original shifts the count at each test of the loop.
  it('leaves a read inside a loop the write is not in', () => {
    same(`int f(int u) { int n = GetStat(u); int i = 0; if (!(n >> 8 > 0)) { return 0; } do { i++; } while (i < n >> 8); return i; }`, RET);
  });

  it('leaves two shift amounts, a plain read, a second write and an address', () => {
    same(`int f(int u) { int n = GetStat(u); return (n >> 8) + (n >> 4); }`, RET);
    same(`int f(int u) { int n = GetStat(u); return (n >> 8) + n; }`, RET);
    same(`int f(int u) { int n = GetStat(u); n = GetStat(n >> 8); return n >> 8; }`, RET);
    same(`int f(int u) { int n = GetStat(u); int* p = &n; return (n >> 8) + *p; }`, RET);
  });

  it('leaves a value that is no call, a narrow or pointer type, and a parameter', () => {
    same(`int f(int u) { int n = u + 1; return n >> 8; }`, RET);
    same(`int f(int u) { short n = GetStat(u); return n >> 8; }`, RET);
    same(`int f(int u) { int* n = (int*)GetStat(u); return (int)n >> 8; }`, RET);
    same(`int f(int u) { u = GetStat(u); return u >> 8; }`, RET);
  });

  it('leaves a read before the write', () => {
    same(`int f(int u) { int n; int r = 0; if (u) { r = n >> 8; } n = GetStat(u); return r + (n >> 8); }`, RET);
  });
});

/**
 * flag-conditions: conditions over CPU flags lowered to the compare they encode.
 *
 * Every positive case is checked by EXECUTION: the function as the decompiler printed it
 * (with a reference SBORROW4 written from the definition of signed overflow) and the
 * lowered function are compiled side by side and run over a grid of edge values; any
 * disagreement fails. The shapes are trimmed from the real functions named in each test.
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

function lower(code: string): string {
  return emit(pseudoOpLowerPlugin.createTransformer({})(parse(code)) as AnyNode).trim();
}

const EDGES = ['INT32_MIN', 'INT32_MIN + 1', '-0x40000000', '-3', '-2', '-1', '0', '1', '2', '3', '4', '5', '7', '0x3fffffff', '0x40000000', 'INT32_MAX - 1', 'INT32_MAX'];

const REFERENCE = [
  'typedef unsigned int uint;',
  ...ARTIFACT_SUPPORT_LINES,
  '// Signed overflow of a - b, from its definition (64-bit arithmetic).',
  'static bool SBORROW4(int64_t a, int64_t b) { int64_t d = (int64_t)(int32_t)a - (int64_t)(int32_t)b; return d < INT32_MIN || d > INT32_MAX; }',
].join('\n');

/**
 * Compile `src` (function `f`, `arity` int parameters) as written and as lowered, and
 * count the inputs on the edge grid where the two return different values.
 */
function disagreements(src: string, arity: number): { bad: string; lowered: string } {
  const lowered = lower(src);
  assert.ok(!/SBORROW/.test(lowered), `a flag op survived:\n${lowered}`);
  const loops: string[] = [];
  const names = Array.from({ length: arity }, (_, i) => `a${i}`);
  for (const n of names) loops.push(`for (int32_t ${n} : E)`);
  const call = names.join(', ');
  const body = [
    `const int32_t E[] = {${EDGES.join(', ')}};`,
    'long bad = 0;',
    `${loops.join(' ')} if (ref::f(${call}) != low::f(${call})) bad++;`,
    'printf("%ld\\n", bad);',
  ].join('\n');
  // -fwrapv: the decompiler's text means the machine's wrapping arithmetic.
  const out = compileAndRun(`${REFERENCE}\nnamespace ref {\n${src}\n}\nnamespace low {\n${lowered}\n}`, body, { flags: ['-fwrapv'] });
  return { bad: out.trim(), lowered };
}

describe('flag-conditions: one group per path', native, () => {
  it('pqdownheap 0042ba50: OF kept across a loop back edge is the signed < of each definition', () => {
    // Two definitions of bOverflow (before the loop, at its bottom) reach one test at the top.
    const src = `int f(int nIndex, int nHeapLenIn, int nStep) {
      int nChild; int nHeapLen; bool bOverflow; int nSmaller; int nHeapLenTmp; int nOut = 0; int nIter = 0;
      nHeapLen = nHeapLenIn;
      nChild = nIndex;
      bOverflow = SBORROW4(nChild, nHeapLen);
      nSmaller = nChild - nHeapLen;
      if (nHeapLen < nChild) { return -1; }
      while (true) {
        nHeapLen = nChild;
        if (bOverflow != nSmaller < 0) { nOut = nOut * 3 + 1; }
        if (++nIter > 3) break;
        nHeapLenTmp = nHeapLenIn + nIter;
        nChild = nHeapLen + nStep;
        bOverflow = SBORROW4(nChild, nHeapLenTmp);
        nSmaller = nChild - nHeapLenTmp;
        if (nHeapLenTmp < nChild) { return nOut * 7; }
      }
      return nOut; }`;
    const r = disagreements(src, 3);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /bSignedLess = nChild < nHeapLen;/);
    assert.match(r.lowered, /bSignedLess = nChild < nHeapLenTmp;/);
    assert.doesNotMatch(r.lowered, /nSmaller = nChild/, 'the dead companion stores go');
  });

  it('INPUT_MiniPanelMouseDown 0047ef30: the constant kept in a register variable', () => {
    const src = `int f(int nButtonIndex, int bSinglePlayer) {
      bool bBorrow; int nBeltUseBlocked;
      if (bSinglePlayer == 1) { bBorrow = SBORROW4(nButtonIndex, 4); nBeltUseBlocked = -4; }
      else { bBorrow = SBORROW4(nButtonIndex, 5); nBeltUseBlocked = -5; }
      if (bBorrow != nButtonIndex + nBeltUseBlocked < 0) goto LAB_skip;
      return 1;
    LAB_skip:
      return 0; }`;
    const r = disagreements(src, 2);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /bSignedLess = nButtonIndex < 4;/);
    assert.match(r.lowered, /bSignedLess = nButtonIndex < 5;/);
    assert.doesNotMatch(r.lowered, /nBeltUseBlocked/, 'the register constant and its declaration go');
  });

  it('PropertyFunc_Charges 0065dbc0: CMP on one path, TEST on the other, sign spelled through c = s + 1', () => {
    // Path A: CMP ESI,1 (c = s + 1, SF printed on s). Path B: TEST EAX,EAX (OF = false).
    const src = `int f(int nItem, int nKind) {
      int nSkillLevel; int nChargeSkillLevel; bool bBorrow; bool bIsZero;
      if (nKind == 0) {
        nSkillLevel = nItem >> 2;
        nChargeSkillLevel = nSkillLevel + 1;
        if (nItem != 99) {
          bIsZero = SBORROW4(nChargeSkillLevel, 1);
          bBorrow = nChargeSkillLevel == 1;
    LAB_0065dca3:
          if (bBorrow || bIsZero != nSkillLevel < 0) { nChargeSkillLevel = 1; }
        }
        return nChargeSkillLevel;
      }
      nSkillLevel = nItem / 3;
      bIsZero = false;
      bBorrow = nSkillLevel == 0;
      nChargeSkillLevel = nSkillLevel;
      goto LAB_0065dca3; }`;
    const r = disagreements(src, 2);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /bSignedLessOrEqual = nChargeSkillLevel <= 1;/);
    assert.match(r.lowered, /bSignedLessOrEqual = nSkillLevel <= 0;/);
  });

  it('DRLGCOORDS_IsAdjacentOrOverlapping 0066b880: jg after TEST and after CMP', () => {
    const src = `int f(int nDistX, int nDistY, int nMaxDist) {
      bool bBorrow; bool bIsEqual;
      if (nMaxDist == 0) {
        if (0 < nDistX) { return 0; }
        bBorrow = false;
        bIsEqual = nDistY == 0;
      } else {
        if (nDistY != 0) { return 0; }
        bBorrow = SBORROW4(nDistX, nMaxDist);
        nDistY = nDistX - nMaxDist;
        bIsEqual = nDistX == nMaxDist;
      }
      if (!bIsEqual && bBorrow == nDistY < 0) { return 0; }
      return 1; }`;
    const r = disagreements(src, 3);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /bSignedGreater = nDistY > 0;/);
    assert.match(r.lowered, /bSignedGreater = nDistX > nMaxDist;/);
  });

  it('QUESTLOG_OnMouseUp 004a42a0: unsigned operands compare signed, the sign variable keeps its type', () => {
    const src = `int f(int nY, int nScreen, int nMode) {
      int nPanelRelX; uint nRawMouseY; uint nBottom; bool bEq; bool bBelow;
      if (nMode == 2) {
        nRawMouseY = (uint)nY; nBottom = (uint)nScreen - 0x2f;
        bBelow = SBORROW4(nRawMouseY, nBottom); nPanelRelX = nRawMouseY - nBottom; bEq = nRawMouseY == nBottom;
      } else {
        nBottom = (uint)nY; nRawMouseY = (uint)nScreen - 0x31;
        bBelow = SBORROW4(nBottom, nRawMouseY); nPanelRelX = nBottom - nRawMouseY; bEq = nBottom == nRawMouseY;
      }
      if (bEq || bBelow != nPanelRelX < 0) { return 1; }
      return 0; }`;
    const r = disagreements(src, 3);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /\(int32_t\)\(?nRawMouseY\)? <= \(int32_t\)\(?nBottom\)?/);
  });

  it('CallCollisionFunction 00641cb0: OF/SF/ZF triples, one entered by a label', () => {
    const src = `int f(int nKind, int n, int nPosY) {
      bool bZF; bool bSF; bool bOF; int iVar1 = n ^ 5;
      switch (nKind & 3) {
      case 1:
        bOF = SBORROW4(n,1); bSF = n + -1 < 0; bZF = n == 1;
        goto LAB_00641c18;
      case 2:
    LAB_00641c16:
        bOF = SBORROW4(nPosY,iVar1); bSF = nPosY - iVar1 < 0; bZF = nPosY == iVar1;
        goto LAB_00641c18;
      case 3:
        if (n == 7) goto LAB_00641c16;
        bOF = SBORROW4(n,2); bSF = n + -2 < 0; bZF = n == 2;
    LAB_00641c18:
        if (bZF || bOF != bSF) { return 1; }
      }
      return 0; }`;
    const r = disagreements(src, 3);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.doesNotMatch(r.lowered, /\bb[OSZ]F\b/);
  });

  it('COMCALLBACK_UpdateChannelUserList 00447bb0: a flag variable reused for other bools keeps them', () => {
    const src = `int f(int nClassId, int nOther) {
      bool bInserted; int nTitleAdjust; int byTitleLevel = 0;
      bInserted = nOther == 3;
      if (bInserted) return 9;
      if (nClassId < 8) { bInserted = SBORROW4(nClassId,4); nTitleAdjust = -4; goto LAB_x; }
      if (nClassId < 10) {
        bInserted = SBORROW4(nClassId,5); nTitleAdjust = -5;
    LAB_x:
        byTitleLevel = bInserted == (int)(nClassId + nTitleAdjust) < 0;
        bInserted = (bool)byTitleLevel;
      }
      return bInserted * 2 + byTitleLevel; }`;
    const r = disagreements(src, 2);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /bSignedGreaterOrEqual = nClassId >= 4;/);
    assert.match(r.lowered, /bool bInserted;/, 'its other uses keep the variable');
  });
});

describe('flag-conditions: the compare on one line', native, () => {
  it('MISSILES_SpawnAreaPattern 005a9530 (C2-25): Ghidra substituted x = -r into ZF and SF', () => {
    const src = `int f(int nRadius, int nUnused) {
      int iOffsetX; int iOffsetY;
      iOffsetX = -nRadius;
      iOffsetY = iOffsetX;
      if (-nRadius == nRadius || SBORROW4(iOffsetX,nRadius) != nRadius * -2 < 0) { return iOffsetY + 1; }
      return 0; }`;
    const r = disagreements(src, 2);
    assert.strictEqual(r.bad, '0', r.lowered);
    assert.match(r.lowered, /if \(\(?iOffsetX <= nRadius\)?\)/);
  });

  it('does not fold the substituted shape when x = -r is not what reaches', () => {
    // iOffsetX is a parameter here: nothing says it equals -nRadius.
    const out = lower(`int f(int iOffsetX, int nRadius) {
      if (-nRadius == nRadius || SBORROW4(iOffsetX,nRadius) != nRadius * -2 < 0) { return 1; } return 0; }`);
    assert.match(out, /nRadius \* -2 < 0/);
    assert.match(out, /\^/, 'the exact bitwise lowering');
  });

  it('SBORROW4(a, a) is false (NPCMENU_ConfigureMenuOption 004b64b6: CMP ESI,ESI)', () => {
    const r = disagreements(`int f(int n) { n = n + -1; if (!SBORROW4(n,n)) { return 1; } return 0; }`, 1);
    assert.strictEqual(r.bad, '0', r.lowered);
  });
});

describe('flag-conditions: what is left alone', () => {
  const base = `int f(int n, int m) {
      bool bOF; bool bZF; int k;
      if (m == 0) { bOF = SBORROW4(n, 4); bZF = n == 4; k = n - 4; }
      else { bOF = SBORROW4(n, 5); bZF = n == 5; k = n - 5; }
      WRITE
      if (bZF || bOF != k < 0) { return 1; }
      return 0; }`;
  it('the base shape lowers', () => {
    assert.doesNotMatch(lower(base.replace('WRITE', '')), /SBORROW|\^/);
  });
  it('a write to the sign variable between the groups and the test', () => {
    const out = lower(base.replace('WRITE', 'k = k + 1;'));
    assert.match(out, /\^/);
  });
  it('a flag read anywhere else', () => {
    const out = lower(base.replace('return 0; }', 'return bOF; }').replace('WRITE', ''));
    assert.match(out, /\bbOF\b/);
  });
  it('a path that reaches the test without setting the flags', () => {
    const out = lower(base.replace('if (m == 0) {', 'if (m == 7) goto LAB_t; if (m == 0) {')
      .replace('      if (bZF', 'LAB_t:\n      if (bZF').replace('WRITE', ''));
    assert.match(out, /\^/);
  });
  it('an unsigned sign variable: `k < 0` is false in C, not a sign test', () => {
    const out = lower(base.replace('int k;', 'uint k;').replace('WRITE', ''));
    assert.match(out, /\^/);
  });
});

describe('flag-conditions: TEST after NEG', native, () => {
  it('DRLGPATH_RaycastCollisionLine 006795a1: the magnitude test is x <= 0, INT32_MIN included', () => {
    const src = `int f(int nVelX, int nVelY) {
      bool bOverflow; int nFpSrcX;
      bOverflow = false;
      nFpSrcX = nVelX;
      if (nVelX < 0) { nFpSrcX = -nVelX; bOverflow = nFpSrcX < 0; }
      if (nFpSrcX == 0 || bOverflow) {
        bOverflow = false;
        nFpSrcX = nVelY;
        if (nVelY < 0) { nFpSrcX = -nVelY; bOverflow = nFpSrcX < 0; }
        if (nFpSrcX == 0 || bOverflow) { return 0x6e; }
      }
      return nFpSrcX; }`;
    const lowered = lower(src);
    assert.doesNotMatch(lowered, /bOverflow/);
    assert.match(lowered, /if \(\(?nFpSrcX <= 0\)?\)/);
    // -INT32_MIN wraps to itself, as NEG does.
    const out = compileAndRun(`${REFERENCE}\nnamespace ref {\n${src}\n}\nnamespace low {\n${lowered}\n}`,
      `const int32_t E[] = {${EDGES.join(', ')}}; long bad = 0;
       for (int32_t a : E) for (int32_t b : E) if (ref::f(a, b) != low::f(a, b)) bad++;
       printf("%ld\\n", bad);`, { flags: ['-fwrapv'] });
    assert.strictEqual(out.trim(), '0', lowered);
  });
  it('DRLGPATH_CheckRayCollisionToTarget: negating in place', () => {
    const out = lower(`int f(int x) { bool bOverflow; bOverflow = false;
      if (x < 0) { x = -x; bOverflow = x < 0; }
      if (x == 0 || bOverflow) { return 1; } return 0; }`);
    assert.match(out, /if \(\(?x <= 0\)?\)/);
    assert.doesNotMatch(out, /bOverflow/);
  });
  it('a flag read elsewhere stays', () => {
    const out = lower(`int f(int x) { bool bOverflow; bOverflow = false;
      if (x < 0) { x = -x; bOverflow = x < 0; }
      if (x == 0 || bOverflow) { return 1; } return bOverflow; }`);
    assert.match(out, /bOverflow/);
  });
});

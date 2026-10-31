/**
 * shift-count-mask: `x << (n & 0x1f)` loses the mask only where n is proven to lie in
 * [0, 31]. Each rewrite is checked by EXECUTION over an input grid: the masked original,
 * the rewrite, and the rewrite with every unmasked count passed through a check that
 * counts values outside [0, 31] - the property the proof claims, which a plain x86 run
 * cannot see (the CPU masks CL either way).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { NodeKind } from '../../../ast/kinds.js';
import type { AnyNode, ASTNode, BinaryExpr, Expression } from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { createShiftCountMaskTransformer } from '../builtins/shift-count-mask.js';
import { unwrapParens } from '../builtins/call-arg-cast.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const native = { skip: !hasNativeGpp() };

function rewrite(code: string): { out: AnyNode; dropped: Set<ASTNode>; sites: number } {
  const dropped = new Set<ASTNode>();
  let sites = 0;
  const out = createShiftCountMaskTransformer({
    onSite: s => { sites++; if (s.dropped) dropped.add(unwrapParens(s.count)); },
  })(parse(code)) as AnyNode;
  return { out, dropped, sites };
}

const lowered = (code: string) => emit(rewrite(code).out).trim();

/** The rewrite with each count it unmasked wrapped in CHK(...). */
function checked(code: string): string {
  const { out, dropped } = rewrite(code);
  const visit = (n: ASTNode) => {
    if ((n.kind === NodeKind.BinaryExpr || n.kind === NodeKind.AssignExpr) &&
        ['<<', '>>', '<<=', '>>='].includes((n as BinaryExpr).operator) &&
        dropped.has(unwrapParens((n as BinaryExpr).right))) {
      (n as BinaryExpr).right = Expr.call('CHK', [Expr.paren((n as BinaryExpr).right)]) as Expression;
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(x => x && typeof x === 'object' && typeof x.kind === 'string' && visit(x));
      else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') visit(v as ASTNode);
    }
  };
  visit(out as ASTNode);
  return emit(out).trim();
}

const GRID = '{-300, -255, -33, -32, -31, -9, -8, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 23, 24, 25, 30, 31, 32, 33, 63, 64, 100, 127, 128, 200, 254, 255, 256, 257, 300, 1000, 65535, 65536, 0x7fffffff, (int)0x80000000}';

/** Run ref::f (masked), low::f (rewritten) and chk::f over the (a, b) grid; mismatches and range violations. */
function run(src: string): { result: string; low: string } {
  const low = lowered(src);
  const prelude = [
    'static long g_bad = 0;',
    'static inline int CHK(long long v) { if (v < 0 || v > 31) g_bad++; return (int)v; }',
    `namespace ref {\n${src}\n}`, `namespace low {\n${low}\n}`, `namespace chk {\n${checked(src)}\n}`,
  ].join('\n');
  const body = [
    `const int V[] = ${GRID}; long diff = 0;`,
    'for (int a : V) for (int b : V) {',
    '  uint32_t r = ref::f(a, b);',
    '  if (r != low::f(a, b) || r != chk::f(a, b)) diff++;',
    '}',
    'printf("%ld %ld\\n", diff, g_bad);',
  ].join('\n');
  return { result: compileAndRun(prelude, body).trim(), low };
}

const POSITIVE: [string, string][] = [
  ['a search loop and the test that it found something (DRLGOUTDOOR_GetAdjacentLevelVisMask)', `
    uint32_t f(int a, int b) {
      int aVis[8];
      for (int k = 0; k < 8; k++) aVis[k] = (a + k * 3) % 11;
      int nIndex = 0;
      do {
        if (aVis[nIndex] == b) {
          break;
        }
        nIndex++;
      } while (nIndex < 8);
      if (nIndex == 8) {
        return 0;
      }
      return 1 << ((char)nIndex + 4U & 0x1f);
    }`],
  ['a search loop that may run off the end, the variable reused later (SpawnAct12Waypoint)', `
    uint32_t f(int a, int b) {
      int nVisIdx;
      uint32_t dwMask;
      nVisIdx = 0;
      do {
        if ((a >> (nVisIdx & 7) & 1) == b) {
          break;
        }
        nVisIdx++;
      } while (nVisIdx < 8);
      dwMask = 1 << ((char)nVisIdx + 4U & 0x1f);
      nVisIdx = a * 7 + b;
      return dwMask + nVisIdx;
    }`],
  ['a for loop over the bits', `
    uint32_t f(int a, int b) {
      uint32_t r = 0;
      for (int i = 0; i < 0x20; i++) {
        if (a > i) r |= 1u << (i & 0x1f);
      }
      return r;
    }`],
  ['a byte bounded by nested tests (SaveStats)', `
    uint32_t f(int a, int b) {
      uint8_t byWidth = (uint8_t)a;
      int nMask = 0;
      if (byWidth > 0) {
        if (byWidth < 0x20) {
          if (b & 1) {
            nMask = -1 << (byWidth - 1 & 0x1f);
          } else {
            nMask = (1 << (byWidth & 0x1f)) - 1;
          }
        }
      }
      return (uint32_t)nMask;
    }`],
  ['a bit buffer refilled while it holds fewer than 16 bits (inflate)', `
    uint32_t f(int a, int b) {
      uint32_t nBits = (uint32_t)a;
      uint32_t nHold = 0;
      uint8_t bIn = (uint8_t)b;
      for (; nBits < 0x10; nBits += 8) {
        nHold += (uint32_t)bIn << ((uint8_t)nBits & 0x1f);
      }
      return nHold + nBits;
    }`],
  ['an early return for every count out of range', `
    uint32_t f(int a, int b) {
      if (a >= 0x20 || a < 0) {
        return 0;
      }
      uint32_t r = (uint32_t)b << (a & 0x1f);
      r += (uint32_t)b >> (0x1f & a);
      return r;
    }`],
  ['counts reduced by a mask, a remainder and a shift', `
    uint32_t f(int a, int b) {
      uint32_t r = (uint32_t)b << ((a & 7) & 0x1f);
      r ^= (uint32_t)b >> ((uint32_t)a % 0x20 & 0x1f);
      r ^= 1u << ((uint32_t)a >> 0x1b & 0x1f);
      return r;
    }`],
  ['a range test on an unsigned value (PKWARE_explode)', `
    uint32_t f(int a, int b) {
      uint32_t uBits = (uint32_t)a;
      if (uBits >= 4 && uBits <= 6) {
        return 0xffff >> (0x10U - (char)uBits & 0x1f);
      }
      return 0;
    }`],
  ['a test made in unsigned on a signed count', `
    uint32_t f(int a, int b) {
      if ((uint32_t)a < 0x20) {
        return (uint32_t)b << (a & 0x1f);
      }
      return 1;
    }`],
  ['a conditional whose test bounds the count', `
    uint32_t f(int a, int b) {
      return a >= 0 && a < 0x20 ? (uint32_t)b << (a & 0x1f) : 0;
    }`],
  ['a compound shift and a count below 8 (COMPRESS_BuildHuffmanDecodeTable)', `
    uint32_t f(int a, int b) {
      uint8_t byLen = (uint8_t)a;
      uint32_t r = (uint32_t)b;
      if (byLen <= 8) {
        r <<= (8 - byLen & 0x1f);
      }
      return r;
    }`],
];

const NEGATIVE: [string, string][] = [
  ['a parameter', `uint32_t f(int a, int b) { return 1 << (a & 0x1f); }`],
  ['a byte parameter', `uint32_t f(uint8_t a, int b) { return 1u << (a & 0x1f); }`],
  ['a width tested below 32 but not above 0: zero gives -1 (BITBUFFER)', `
    uint32_t f(int nSize, int b) {
      if (nSize < 0x20 && b & 1 << ((uint8_t)nSize - 1 & 0x1f)) return 1;
      return 0;
    }`],
  ['32 minus a byte can be 32', `uint32_t f(int a, int b) { uint8_t byShift = (uint8_t)a; return (uint32_t)b >> (0x20U - byShift & 0x1f); }`],
  ['a signed count tested only from above', `uint32_t f(int a, int b) { if (a < 0x10) return 1 << (a & 0x1f); return 0; }`],
  ['a do-while counter re-entered by an outer loop grows past 32', `
    uint32_t f(int a, int b) {
      int n = 0;
      uint32_t r = 0;
      for (int j = 0; j < a; j++) {
        do {
          n++;
        } while (n < 8);
        r += 1u << (n & 0x1f);
      }
      return r;
    }`],
  ['a write between the test and the shift', `
    uint32_t f(int a, int b) {
      int n = a;
      if (n >= 0 && n < 0x20) {
        n = n + b;
        return 1u << (n & 0x1f);
      }
      return 0;
    }`],
  ['a label lets control reach the shift without the test', `
    uint32_t f(int a, int b) {
      int n = a;
      if (b) goto L_shift;
      if (n < 0 || n > 0x1f) {
        return 0;
      }
    L_shift:
      return 1u << (n & 0x1f);
    }`],
  ['a counter whose address escapes', `
    void g(int *p);
    uint32_t f(int a, int b) {
      int n = 3;
      g(&n);
      return 1u << (n & 0x1f);
    }`],
  ['a name declared twice', `
    uint32_t f(int a, int b) {
      uint32_t r = 0;
      { int n = 3; r += n; }
      { int n = a; r += 1u << (n & 0x1f); }
      return r;
    }`],
  ['an unsigned test from below says nothing of a signed count', `
    uint32_t f(int a, int b) {
      if ((uint32_t)a > 4 && a < 0x20) return 1u << (a & 0x1f);
      return 0;
    }`],
  ['a step that is not the last thing the loop does', `
    uint32_t f(int a, int b) {
      int n = 0;
      uint32_t r = 0;
      while (n < 0x1f) {
        n++;
        r += 1u << (n & 0x1f);
        n++;
      }
      return r;
    }`],
];

describe('shift-count-mask: proven counts lose the mask', () => {
  for (const [name, src] of POSITIVE) {
    it(name, () => {
      const { dropped, sites } = rewrite(src);
      assert.ok(sites > 0, 'no masked shift found');
      assert.strictEqual(dropped.size, sites, lowered(src));
      assert.doesNotMatch(lowered(src), /0x1f\)|& 0x1f|0x1f &/);
    });
  }
});

describe('shift-count-mask: unproven counts keep it', () => {
  for (const [name, src] of NEGATIVE) {
    it(name, () => {
      const { dropped, sites } = rewrite(src);
      assert.ok(sites > 0, 'no masked shift found');
      assert.strictEqual(dropped.size, 0, lowered(src));
    });
  }
});

describe('shift-count-mask: the rewrite computes what the masked shift did', native, () => {
  for (const [name, src] of POSITIVE) {
    it(name, () => {
      const r = run(src);
      assert.strictEqual(r.result, '0 0', r.low);
    });
  }
  it('the do-while counter re-entered by an outer loop does reach 32: the mask matters there', () => {
    const src = NEGATIVE[5][1];
    const prelude = `namespace ref {\n${src}\n}`;
    const out = compileAndRun(prelude, 'printf("%u\\n", ref::f(40, 0));').trim();
    // n runs 8, 9, .., 47: the masked count wraps at 32, so 1 << (n & 31) repeats from 1.
    let r = 0;
    for (let n = 8; n < 48; n++) r = (r + 2 ** (n & 31)) >>> 0;
    assert.strictEqual(out, String(r));
  });
});

describe('shift-count-mask: output', () => {
  it('a count with lower precedence than the shift keeps its parentheses', () => {
    const out = lowered(POSITIVE[0][1]);
    assert.match(out, /return 1 << \(\(char\)nIndex \+ 4U\);|return 1 << \(char\)nIndex \+ 4U;/);
    assert.ok(parse(out));
  });
});

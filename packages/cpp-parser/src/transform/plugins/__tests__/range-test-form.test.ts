/**
 * A one-compare range test on a local, `(unsigned)(x - lo) <= k`, goes back to the two-sided
 * `x >= lo && x <= lo + k` that VC8 folds into `ADD x, -lo; CMP x, k; JA`. Real sites:
 * MAINMENU_DeleteCharacterOnRealm `nConnectResult - 1 <= 1` (uint32_t), CLIENT_CheckWorldstoneShake
 * `(uint32_t)(eLevelId - LEVEL_ThroneOfDestruction) <= 1`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createRangeTestFormTransformer } from '../builtins/range-test-form.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const OPTS = {
  enumTypes: ['eD2LevelId'],
  enumValues: { LEVEL_ThroneOfDestruction: 0x83 },
};
const transform = (code: string) => emit(createRangeTestFormTransformer(OPTS)(parse(code)) as AnyNode).trim();

describe('range-test-form', () => {
  it('an unsigned local', () => {
    assert.match(transform('void f(uint32_t n) { if (n - 1 <= 1) { g(); } }'), /if \(n >= 0x1 && n <= 0x2\)/);
  });
  it('a cast difference on an enum, with the enum constant kept', () => {
    assert.match(transform('void f(eD2LevelId e) { if ((uint32_t)(e - LEVEL_ThroneOfDestruction) <= 1) { g(); } }'),
      /if \(e >= LEVEL_ThroneOfDestruction && e <= LEVEL_ThroneOfDestruction \+ 0x1\)/);
  });
  it('a U constant, a < bound, a negated > and a conjunct of an && chain', () => {
    assert.match(transform('void f(int n) { if (n - 4U < 0x15) { g(); } }'), /if \(n >= 0x4 && n <= 0x18\)/);
    assert.match(transform('void f(int n) { if (!(n - 5U > 4)) { g(); } }'), /if \(n >= 0x5 && n <= 0x9\)/);
    assert.match(transform('void f(int a, int n) { if (a && n - 4U <= 0x14) { g(); } }'), /if \(a && \(?n >= 0x4 && n <= 0x18\)?\)/);
  });
  it('leaves what VC8 compiles otherwise, or what would change the value', () => {
    for (const src of [
      'void f(int n) { if (n - 1 <= 1) { g(); } }',                       // signed compare: not a range test
      'void f(S *p) { if (p->n - 4U <= 0x14) { g(); } }',                 // a field
      'void f(uint32_t n) { if (n - 1 > 1) { g(); } }',                   // the inverted form
      'void f(uint32_t n) { if (a || n - 1 <= 1) { g(); } }',             // under ||
      'void f(uint8_t c) { if ((uint8_t)(c - 0x20) <= 0x5f) { g(); } }',  // an 8-bit difference
      'void f(int64_t n) { if ((uint32_t)(n - 1) <= 1) { g(); } }',        // wider than 32 bits
      'void f(uint32_t n) { if (n - 0x7ffffff0 <= 0x20) { g(); } }',      // crosses INT_MAX
      'void f(uint32_t n) { int r = n - 1 <= 1; }',                        // not a branch condition
      'void f(uint32_t n) { if (n - 1U < 0x100) { g(n); } else { g(n - 1U >> 7); } }', // the difference is a kept value
    ]) assert.ok(!transform(src).includes('&& n <='), src);
  });
  it('the rewritten test agrees with the machine on every boundary', { skip: !hasNativeGpp() }, () => {
    const u = transform('int f(uint32_t n) { if (n - 0x83 <= 1) { return 1; } return 0; }');
    const s = transform('int h(int n) { if (n - 4U < 0x15) { return 1; } return 0; }');
    const out = compileAndRun(`#include <cstdint>\n#include <cstdio>\n${u}\n${s}`,
      'int bad = 0; const int64_t vs[] = {0, 1, 3, 4, 5, 0x18, 0x19, 0x82, 0x83, 0x84, 0x85, 0x7fffffff, 0x80000000LL, 0x80000083LL, 0xffffffffLL, -1, -4};'
      + ' for (int64_t v : vs) { uint32_t n = (uint32_t)v; if (f(n) != (n - 0x83u <= 1u)) bad++; if (h((int)n) != ((uint32_t)(int)n - 4u < 0x15u)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(out.trim(), '0');
  });
});

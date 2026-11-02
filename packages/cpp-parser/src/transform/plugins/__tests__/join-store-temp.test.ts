/**
 * A member every arm of an if/else chain stores into is stored once after the join, through
 * a temporary of the member's type (join-store-temp). SKILLS_ApplyAreaHitAtUnit 0056bbc0 is
 * the reference shape; the refusals are the shapes where the rewrite would change a value or
 * the type is not known.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createJoinStoreTempTransformer } from '../builtins/join-store-temp.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

const structFields = {
  Ctx: { nX: 'int32_t', nY: 'uint16_t', pNext: 'Ctx*', aSlots: 'int32_t[4]', sInner: 'Inner' },
  Inner: { nZ: 'int32_t' },
};
const xf = createJoinStoreTempTransformer({ structFields });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const run = (code: string) => norm(emit(xf(parse(code)) as AnyNode));
const same = (code: string) => assert.strictEqual(run(code), norm(emit(parse(code) as AnyNode)));

const AREA_HIT = `int f(Unit* pUnit, int t) {
  Ctx sCtx;
  if (t == 2) {
    sCtx.nX = pUnit->nPosX;
  } else if (pUnit->pPath) {
    sCtx.nX = GetXPos(pUnit->pPath);
  } else {
    sCtx.nX = 0;
  }
  return g(&sCtx);
}`;

describe('join-store-temp', () => {
  it('SKILLS_ApplyAreaHitAtUnit 0056bbc0: the three arms set a temporary, the member is stored once', () => {
    assert.strictEqual(run(AREA_HIT),
      'int f(Unit* pUnit, int t) { Ctx sCtx; int32_t nXValue; if (t == 2) { nXValue = pUnit->nPosX; } else if (pUnit->pPath) { nXValue = GetXPos(pUnit->pPath); } else { nXValue = 0; } sCtx.nX = nXValue; return g(&sCtx); }');
  });

  it('a member through a local pointer, nested members, two arms', () => {
    assert.match(run('void f(Ctx* p, int c) { if (c) { p->nY = 1; } else { p->nY = h(); } }'),
      /uint16_t nYValue; if \(c\) \{ nYValue = 1; \} else \{ nYValue = h\(\); \} p->nY = nYValue;/);
    assert.match(run('void f(int c) { Ctx s; if (c) s.sInner.nZ = 3; else s.sInner.nZ = q[1]; k(&s); }'),
      /int32_t nZValue; if \(c\) nZValue = 3; else nZValue = q\[1\]; s\.sInner\.nZ = nZValue;/);
  });

  it('refuses what it cannot prove', () => {
    // No final else: one way stores nothing.
    same('void f(int c) { Ctx s; if (c) { s.nX = h(); } else if (c > 2) { s.nX = 2; } k(&s); }');
    // Another target in one arm.
    same('void f(int c) { Ctx s; if (c) { s.nX = h(); } else { s.nY = 2; } k(&s); }');
    // More than the store in an arm.
    same('void f(int c) { Ctx s; if (c) { g(); s.nX = h(); } else { s.nX = 2; } k(&s); }');
    // The root is read in the chain.
    same('void f(Ctx* p, int c) { if (p->nY) { p->nX = h(); } else { p->nX = 2; } }');
    // The pointer root is addressed: a call in an arm could move it.
    same('void f(Ctx* p, int c) { m(&p); if (c) { p->nX = h(); } else { p->nX = 2; } }');
    // A global, a deref, a subscript: not a member path from a local.
    same('void f(int c) { if (c) { gCtx.nX = h(); } else { gCtx.nX = 2; } }');
    same('void f(Ctx** pp, int c) { if (c) { (*pp)->nX = h(); } else { (*pp)->nX = 2; } }');
    // The member's type is not known, is an array or an aggregate.
    same('void f(Other* p, int c) { if (c) { p->nW = h(); } else { p->nW = 2; } }');
    same('void f(int c) { Ctx s; Inner i; if (c) { s.sInner = i; } else { s.sInner = i; } k(&s); }');
    // No arm reads out of an object: constants, parameters and globals only (DrawPopupOk 0045fbc0).
    same('void f(int c, int v) { Ctx s; if (c) { s.nX = 1; } else { s.nX = v; } k(&s); }');
    // Compound assignment.
    same('void f(int c) { Ctx s; if (c) { s.nX += h(); } else { s.nX = 2; } k(&s); }');
    // A label in the chain.
    same('void f(int c) { Ctx s; if (c) { L: s.nX = h(); } else { s.nX = 2; } k(&s); }');
  });

  it('the rewritten chain stores the same value in every way', { skip: !hasNativeGpp() }, () => {
    const before = `int before(int t, int v) { Ctx s; s.nX = 7; s.nY = 9;
  if (t == 2) { s.nX = v; } else if (v) { s.nX = GetX(v); } else { s.nX = 0; }
  if (t) { s.nY = -1; } else { s.nY = 70000 + GetX(v); }
  return s.nX * 100000 + s.nY; }`;
    const after = run(before).replace('int before(', 'int after(');
    assert.match(after, /nXValue/);
    assert.match(after, /nYValue/);
    const out = compileAndRun(`struct Ctx { int32_t nX; uint16_t nY; };
static int calls;
static int GetX(int v) { calls++; return v * 3; }
${before}
${after}`, `int bad = 0;
  for (int t = 0; t < 3; t++) for (int v = -3; v < 4; v++) {
    calls = 0; int a = before(t, v); int ca = calls; calls = 0; int b = after(t, v);
    if (a != b || ca != calls) bad++; }
  printf("%d\\n", bad);`);
    assert.strictEqual(out.trim(), '0');
  });
});

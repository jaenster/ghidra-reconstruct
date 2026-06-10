/**
 * Tests for Comma-Expand Plugin
 *
 * These assert on the ENTIRE emitted source (exact string match) rather than
 * regex fragments, so any unexpected change to the surrounding output is caught.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { commaExpandPlugin } from '../builtins/comma-expand.js';

describe('commaExpandPlugin', () => {
  function tx(code: string): string {
    const ast = parse(code);
    return emit(commaExpandPlugin.createTransformer({})(ast) as AnyNode).trim();
  }
  /** Assert the full transformed source equals `expected` (both trimmed). */
  function expectSource(input: string, expected: string) {
    assert.strictEqual(tx(input), expected.trim());
  }

  it('1a: splits a bare comma statement into separate statements', () => {
    expectSource(
      `void f() { (a(), b(), c()); }`,
      `void f() {
  a();
  b();
  c();
}`,
    );
  });

  it('1a: flattens a longer comma chain', () => {
    expectSource(
      `void f() { (a, b, c, d); }`,
      `void f() {
  a;
  b;
  c;
  d;
}`,
    );
  });

  it('1b: hoists comma side effects out of a return', () => {
    expectSource(
      `int f() { return (x = 1, x + 2); }`,
      `int f() {
  x = 1;
  return x + 2;
}`,
    );
  });

  it('1c: hoists comma side effects out of an assignment RHS', () => {
    expectSource(
      `void f() { y = (x = 1, x + 2); }`,
      `void f() {
  x = 1;
  y = x + 2;
}`,
    );
  });

  it('1d: hoists a whole-condition comma out of an if', () => {
    expectSource(
      `void f() { if ((x = g(), x)) { use(x); } }`,
      `void f() {
  x = g();
  if (x) {
    use(x);
  }
}`,
    );
  });

  it('2: splits an OR-guard early-exit with comma side effects (the pGame case)', () => {
    expectSource(
      `void* f(G* pGame) {
  if (!pGame || pGame->eType != 1 ||
      (pMon = (M*)pGame->pAi, !pMon) ||
      (pCur = pMon->list[4], !pCur)) {
    return nullptr;
  }
  return pCur;
}`,
      `void* f(G* pGame) {
  if (!pGame)
    return nullptr;
  if (pGame->eType != 1)
    return nullptr;
  pMon = (M*)pGame->pAi;
  if (!pMon)
    return nullptr;
  pCur = pMon->list[4];
  if (!pCur)
    return nullptr;
  return pCur;
}`,
    );
  });

  it('2: works with a break early-exit inside a loop', () => {
    expectSource(
      `void f() { for (;;) { if (x || (y = z(), !y)) break; step(); } }`,
      `void f() {
  for (; ;) {
    if (x)
      break;
    y = z();
    if (!y)
      break;
    step();
  }
}`,
    );
  });

  it('2: leaves a plain OR-guard (no comma side effects) untouched', () => {
    expectSource(
      `int f(int a, int b) { if (a || b) return 1; return 0; }`,
      `int f(int a, int b) {
  if (a || b)
    return 1;
  return 0;
}`,
    );
  });

  it('3: restructures a while with a comma side effect in its condition (the packet case)', () => {
    expectSource(
      `void f() { while (pSize && (nRes = GetSize(p, pSize, &n), nRes)) { consume(); } }`,
      `void f() {
  while (true) {
    if (!pSize)
      break;
    nRes = GetSize(p, pSize, &n);
    if (!nRes)
      break;
    consume();
  }
}`,
    );
  });

  it('3: leaves a plain while (no comma) untouched', () => {
    expectSource(
      `void f() { while (a && b) { step(); } }`,
      `void f() {
  while (a && b) {
    step();
  }
}`,
    );
  });
});

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

  it('2b: negated OR-guard with comma → nested comma-free guards (IMAGE_ReturnImageExtension case)', () => {
    expectSource(
      `char* f(int nParam) {
  char* psz;
  if (!(!nParam || (psz = pCompressed, !bUseCompressedData)))
    return psz;
  psz = pUncompressed;
  return psz;
}`,
      `char* f(int nParam) {
  char* psz;
  if (nParam) {
    psz = pCompressed;
    if (bUseCompressedData)
      return psz;
  }
  psz = pUncompressed;
  return psz;
}`,
    );
  });

  it('2c: AND-chain with comma + block body → nested comma-free ifs', () => {
    expectSource(
      `void f(M* pGame) {
  if (pGame->ok && (pMon = pGame->mon, pMon != nullptr)) {
    use(pMon);
  }
}`,
      `void f(M* pGame) {
  if (pGame->ok) {
    pMon = pGame->mon;
    if (pMon != nullptr) {
      use(pMon);
    }
  }
}`,
    );
  });

  it('2c: AND-chain with comma + early-exit then-branch', () => {
    expectSource(
      `void f() { if (a && (v = g(), v)) return; rest(); }`,
      `void f() {
  if (a) {
    v = g();
    if (v)
      return;
  }
  rest();
}`,
    );
  });

  it('fixpoint: two sequential comma-ifs both lowered in one run', () => {
    expectSource(
      `void f() {
  if (a && (x = p(), x)) { u(); }
  if (!b || (y = q(), !y)) return;
  done();
}`,
      `void f() {
  if (a) {
    x = p();
    if (x) {
      u();
    }
  }
  if (!b)
    return;
  y = q();
  if (!y)
    return;
  done();
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

describe('commaExpandPlugin - an || guard laid out after the rest (inflateSyncPoint)', () => {
  /** `[offsets] text` per line, `[if cb offsets] text` for an if line. */
  function run(lines: string[]): string {
    const text: string[] = [];
    const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>() };
    lines.forEach((l, i) => {
      const m = l.match(/^\s*\[(if\s+)?([0-9a-fx, ]*)\]\s?(.*)$/);
      if (!m) { text.push(l); return; }
      const nums = m[2].split(/[ ,]+/).filter(Boolean).map(n => Number(n));
      if (m[1]) ev.ifs.set(i + 1, nums[0]);
      ev.lines.set(i + 1, nums);
      text.push(m[3]);
    });
    const t = commaExpandPlugin.createTransformer({ branchLayout: ev });
    return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ').trim();
  }
  const site = (ret: string, rest: string) => [
    'int f(S* s) {',
    '  int* p;',
    '[if 0x9 0x0,0x4,0x7,0x9] if (s == 0 || (p = s->state, p == 0)) {',
    `[${ret}] return -2;`,
    '  }',
    `[${rest}] if (*p == 13) {`,
    '[0x16] return 1;',
    '  }',
    '[0x1c,0x1e] return 0;',
    '}',
  ];

  it('nests the rest when the return lies after it', () => {
    const out = run(site('0x1f,0x24', '0xb,0x10'));
    assert.ok(out.includes('if (s != 0) { p = s->state; if (p != 0) { if (*p == 13) { return 1; } return 0; } } return -2;'), out);
  });

  it('splits the guards when the return lies first', () => {
    const out = run(site('0xb,0x10', '0x1f,0x24'));
    assert.ok(out.includes('if (s == 0) return -2; p = s->state; if (p == 0) return -2;'), out);
  });

  it('splits the guards inside a loop', () => {
    const lines = site('0x1f,0x24', '0xb,0x10');
    const out = run([lines[0], lines[1], 'while (g) {', ...lines.slice(2, -1), '}', 'return 5;', '}']);
    assert.ok(out.includes('if (s == 0) return -2;'), out);
  });
});

describe('commaExpandPlugin - the tests ahead of the exit stay one guard (ITEMEVENT_LifeTap)', () => {
  /** `[offsets] text` per line, `[if cb offsets] text` for an if line; `ops` per leaf operand of the if. */
  function run(lines: string[], ops: number[][] | null): string {
    const text: string[] = [];
    const ev = { lines: new Map<number, number[]>(), ifs: new Map<number, number>(), operands: new Map<number, number[][]>() };
    lines.forEach((l, i) => {
      const m = l.match(/^\s*\[(if\s+)?([0-9a-fx, ]*)\]\s?(.*)$/);
      if (!m) { text.push(l); return; }
      const nums = m[2].split(/[ ,]+/).filter(Boolean).map(n => Number(n));
      if (m[1]) { ev.ifs.set(i + 1, nums[0]); if (ops) ev.operands.set(i + 1, ops); }
      ev.lines.set(i + 1, nums);
      text.push(m[3]);
    });
    const t = commaExpandPlugin.createTransformer({ branchLayout: ev });
    return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ').trim();
  }
  const site = [
    'int f(U* pUnit, U* pTarget, D* pDamage) {',
    '  int t;',
    '[if 0x23 0x3,0xb,0x12,0x18,0x1a,0x1c,0x20,0x23] if (pUnit == 0 || pTarget == 0 || pDamage == 0 || (t = pTarget->type, t != 0 && t != 1)) {',
    '[0x26,0x2a] return 0;',
    '  }',
    '[0x2d] return t;',
    '}',
  ];
  const ops = [[0xb], [0x12], [0x18], [0x1e], [0x23]];

  it('keeps the tests that jump forward to the one return in one guard', () => {
    const out = run(site, ops);
    assert.ok(out.includes('if (pUnit == 0 || pTarget == 0 || pDamage == 0) return 0; t = pTarget->type; if (t != 0 && t != 1) return 0;'), out);
  });

  it('gives a test after the return a guard of its own', () => {
    const out = run(site, [[0xb], [0x12], [0x30], [0x34], [0x38]]);
    assert.ok(out.includes('if (pUnit == 0 || pTarget == 0) return 0; if (pDamage == 0) return 0;'), out);
  });

  it('splits every test without per-operand facts', () => {
    const out = run(site, null);
    assert.ok(out.includes('if (pUnit == 0) return 0; if (pTarget == 0) return 0; if (pDamage == 0) return 0;'), out);
  });
});

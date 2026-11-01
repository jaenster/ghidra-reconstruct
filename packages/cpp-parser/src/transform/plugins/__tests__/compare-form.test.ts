/**
 * Comparisons take the form their CMP/TEST and Jcc show (compare-form), and stay as
 * signed or unsigned as that form needs (compare-signedness).
 *
 * InitLogFilePathPointers @0040eb90 prints `nCount != 0` for `TEST EDX,EDX; JBE` and
 * `0x144f < nByteOffset` for `CMP EDI,0x1450; JNC`. Each rewrite here must keep the value
 * in C++: the native checks compile the printed and the written comparison side by side
 * and compare them over every value of a narrow operand and the edges of a wide one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, IntegerLiteralExpr } from '../../../ast/nodes.js';
import { NodeKind } from '../../../ast/kinds.js';
import {
  createCompareFormTransformer, steppedConstant, type CompareFormDecision, type CompareFormOptions,
} from '../builtins/compare-form.js';
import { createCompareSignednessTransformer } from '../builtins/compare-signedness.js';
import { booleanCleanupPlugin } from '../builtins/boolean-cleanup.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

type Site = { text: string; fp: [string, string]; size?: number };
const dec = (d: Partial<CompareFormDecision> & { ord: number; text: string; fp: [string, string] }): CompareFormDecision =>
  ({ width: 4, address: '00401000', ...d });

function run(code: string, sites: Site[], decisions: CompareFormDecision[], census?: CompareFormOptions['onCensus']): string {
  const opts: CompareFormOptions = { sites, decisions, onCensus: census };
  return emit(createCompareFormTransformer(opts)(parse(code)) as AnyNode).trim();
}

const lit = (raw: string, value: bigint, base: 10 | 16 = 16, suffix = ''): IntegerLiteralExpr =>
  ({ kind: NodeKind.IntegerLiteral, value, raw, base, suffix } as IntegerLiteralExpr);

describe('compare-form', () => {
  const INIT_LOG = `void f(uint32_t nCount) {
  uint nByteOffset;
  uint nIndex;
  if (nCount != 0) {
    do {
      if (0x144f < nByteOffset) {
        return;
      }
    } while (nIndex < nCount);
  }
}`;
  const SITES: Site[] = [
    { text: '!=', fp: ['v:nCount', 'c:0'] },
    { text: '<', fp: ['c:144f', 'v:nByteOffset'] },
    { text: '<', fp: ['v:nIndex', 'v:nCount'] },
  ];
  const DECISIONS = [
    dec({ ord: 0, ...SITES[0], op: '>', delta: 0, k: 0, unsigned: true }),
    dec({ ord: 1, ...SITES[1], op: '>=', swap: true, delta: 1, k: 0x144f }),
    dec({ ord: 2, ...SITES[2], keep: true }),
  ];

  it('InitLogFilePathPointers: the three comparisons as the instructions have them', () => {
    let census: unknown;
    const out = run(INIT_LOG, SITES, DECISIONS, c => { census = c; });
    assert.match(out, /if \(nCount > 0\)/);
    assert.match(out, /if \(nByteOffset >= 0x1450\)/);
    assert.match(out, /while \(nIndex < nCount\)/);
    assert.deepStrictEqual(census, { tied: 3, rewritten: 2, untied: 0, zipped: true });
  });

  it('casts an operand that is not declared unsigned for the unsigned zero test', () => {
    const out = run('void f(int n, char c) { if (n != 0) {} if (c == 0) {} }',
      [{ text: '!=', fp: ['v:n', 'c:0'] }, { text: '==', fp: ['v:c', 'c:0'] }],
      [dec({ ord: 0, text: '!=', fp: ['v:n', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true }),
       dec({ ord: 1, text: '==', fp: ['v:c', 'c:0'], op: '<=', delta: 0, k: 0, unsigned: true, width: 1 })]);
    assert.match(out, /\(uint32_t\)\(?n\)? > 0/);
    assert.match(out, /\(uint8_t\)\(?c\)? <= 0/);
  });

  it('leaves a pointer operand alone', () => {
    const out = run('void f(int *p) { if (p != 0) {} }', [{ text: '!=', fp: ['v:p', 'c:0'] }],
      [dec({ ord: 0, text: '!=', fp: ['v:p', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true })]);
    assert.match(out, /p != 0/);
  });

  it('keeps the base, digit case and suffix of a stepped literal', () => {
    const out = run('void f(uint x, int y, uint z) { if (x < 0x1A) {} if (y < 10) {} if (z <= 7U) {} }',
      [{ text: '<', fp: ['v:x', 'c:1a'] }, { text: '<', fp: ['v:y', 'c:a'] }, { text: '<=', fp: ['v:z', 'c:7'] }],
      [dec({ ord: 0, text: '<', fp: ['v:x', 'c:1a'], op: '<=', delta: -1, k: 0x1a }),
       dec({ ord: 1, text: '<', fp: ['v:y', 'c:a'], op: '<=', delta: -1, k: 10 }),
       dec({ ord: 2, text: '<=', fp: ['v:z', 'c:7'], op: '<', delta: 1, k: 7 })]);
    assert.match(out, /x <= 0x19/);
    assert.match(out, /y <= 9\b/);
    assert.match(out, /z < 8U/);
  });

  it('crosses zero only on a signed compare of an operand declared signed', () => {
    const d = (fp0: string) => [dec({ ord: 0, text: '<', fp: ['c:ffffffff', fp0], op: '>=', swap: true, delta: 1, k: 0xffffffff, signed: true })];
    const signed = emit(createCompareSignednessTransformer({})(parse(run('void f(int n) { if (-1 < n) {} }', [{ text: '<', fp: ['c:ffffffff', 'v:n'] }], d('v:n')))) as AnyNode);
    assert.match(signed, /n >= 0/);
    assert.match(run('void f(uint n) { if (-1 < n) {} }', [{ text: '<', fp: ['c:ffffffff', 'v:n'] }], d('v:n')), /-1 < n/);
    assert.match(run('void f(T n) { if (-1 < n) {} }', [{ text: '<', fp: ['c:ffffffff', 'v:n'] }], d('v:n')), /-1 < n/);
  });

  it('refuses a literal the instructions do not agree with, and a non-literal constant step', () => {
    assert.match(run('void f(int x) { if (x < 5) {} }', [{ text: '<', fp: ['v:x', 'c:5'] }],
      [dec({ ord: 0, text: '<', fp: ['v:x', 'c:5'], op: '<=', delta: -1, k: 6 })]), /x < 5/);
    // An enum member fits the constant's fingerprint, but only a swap may touch it.
    assert.match(run('void f(int x) { if (x < UNIT_MAX) {} }', [{ text: '<', fp: ['v:x', 'c:5'] }],
      [dec({ ord: 0, text: '<', fp: ['v:x', 'c:5'], op: '<=', delta: -1, k: 5 })]), /x < UNIT_MAX/);
    assert.match(run('void f(int x) { if (UNIT_MAX < x) {} }', [{ text: '<', fp: ['c:5', 'v:x'] }],
      [dec({ ord: 0, text: '<', fp: ['c:5', 'v:x'], op: '>', swap: true, delta: 0, k: 5 })]), /x > UNIT_MAX/);
  });

  it('swaps two variables, mirroring the operator', () => {
    assert.match(run('void f(int p, int q) { if (p <= q) {} }', [{ text: '<=', fp: ['v:p', 'v:q'] }],
      [dec({ ord: 0, text: '<=', fp: ['v:p', 'v:q'], op: '>=', swap: true, delta: 0 })]), /q >= p/);
  });

  it('a fingerprint that does not fit leaves the comparison untied', () => {
    let census: { untied: number } | undefined;
    const out = run('void f(int a, int b) { if (a < 5) {} }', [{ text: '<', fp: ['v:b', 'c:5'] }],
      [dec({ ord: 0, text: '<', fp: ['v:b', 'c:5'], op: '<=', delta: -1, k: 5 })], c => { census = c; });
    assert.match(out, /a < 5/);
    assert.strictEqual(census?.untied, 1);
  });

  it('a member of a global struct fits the struct symbol; `e` fits anything', () => {
    assert.match(run('void f(int x) { if (gCoords.nLeft <= x) {} }', [{ text: '<=', fp: ['v:gCoords', 'e'] }],
      [dec({ ord: 0, text: '<=', fp: ['v:gCoords', 'e'], op: '>=', swap: true, delta: 0 })]), /x >= gCoords\.nLeft/);
  });

  it('when the body has other comparisons than the decompile, ties only unique ones', () => {
    // The body has one comparison more than the sites; `a < 5` is unique on both sides.
    const out = run('void f(int a, int b) { if (b == 1) {} if (a < 5) {} if (b == 1) {} }',
      [{ text: '<', fp: ['v:a', 'c:5'] }, { text: '==', fp: ['v:b', 'c:1'] }],
      [dec({ ord: 0, text: '<', fp: ['v:a', 'c:5'], op: '<=', delta: -1, k: 5 }),
       dec({ ord: 1, text: '==', fp: ['v:b', 'c:1'], keep: true })]);
    assert.match(out, /a <= 4/);
    // Two identical sites: neither is tied.
    let census: { tied: number } | undefined;
    const twice = run('void f(int a) { if (a < 5) {} if (a < 5) {} if (a == 2) {} }',
      [{ text: '<', fp: ['v:a', 'c:5'] }, { text: '<', fp: ['v:a', 'c:5'] }],
      [dec({ ord: 0, text: '<', fp: ['v:a', 'c:5'], op: '<=', delta: -1, k: 5 }),
       dec({ ord: 1, text: '<', fp: ['v:a', 'c:5'], op: '<=', delta: -1, k: 5 })], c => { census = c; });
    assert.doesNotMatch(twice, /<= 4/);
    assert.strictEqual(census?.tied, 0);
  });

  it('ties in text order, nested comparisons included', () => {
    // Text order: `<` (ord 0), `==` (ord 1), `<` (ord 2).
    const out = run('void f(int a, int b, int c) { if ((a < 3) == (b < 7)) {} }',
      [{ text: '<', fp: ['v:a', 'c:3'] }, { text: '==', fp: ['e', 'e'] }, { text: '<', fp: ['v:b', 'c:7'] }],
      [dec({ ord: 0, text: '<', fp: ['v:a', 'c:3'], op: '<=', delta: -1, k: 3 }),
       dec({ ord: 2, text: '<', fp: ['v:b', 'c:7'], op: '<=', delta: -1, k: 7 })]);
    assert.match(out, /a <= 2/);
    assert.match(out, /b <= 6/);
  });
});

describe('compare-form: the constant the instruction compares with', () => {
  it('X != 0 / X == 0 under CMP X,1; JB/JAE: X >= 1 / X < 1 on an unsigned operand only', () => {
    const d = (text: string, fp0: string, op: string, width = 4) =>
      dec({ ord: 0, text, fp: [fp0, 'c:0'], width, op, delta: 1, k: 0, unsigned: true });
    assert.match(run('void f(uint n) { if (n != 0) {} }', [{ text: '!=', fp: ['v:n', 'c:0'] }], [d('!=', 'v:n', '>=')]), /n >= 1/);
    assert.match(run('void f(byte b) { if (b == 0) {} }', [{ text: '==', fp: ['v:b', 'c:0'] }], [d('==', 'v:b', '<', 1)]), /b < 1/);
    // A signed or unknown operand: the type is suspect, not the compare. Nothing is cast.
    assert.match(run('void f(int n) { if (n != 0) {} }', [{ text: '!=', fp: ['v:n', 'c:0'] }], [d('!=', 'v:n', '>=')]), /n != 0/);
    assert.match(run('void f(T n) { if (n != 0) {} }', [{ text: '!=', fp: ['v:n', 'c:0'] }], [d('!=', 'v:n', '>=')]), /n != 0/);
    assert.match(run('void f(uint *p) { if (p != 0) {} }', [{ text: '!=', fp: ['v:p', 'c:0'] }], [d('!=', 'v:p', '>=')]), /p != 0/);
  });

  it('`== \'\\0\'` on an unsigned byte member is `< 1`, the member typed from the struct tables', () => {
    // ITEMS: `cmp byte ptr [eax+0x112], 1; jb` printed `pItemsTxt->bQuest == '\0'`.
    const code = "void f(D2ItemsTxt *pItemsTxt) { if (pItemsTxt->bQuest == '\\0') {} }";
    const sites: Site[] = [{ text: '==', fp: ['e', 'c:0'], size: 1 }];
    const decisions = [dec({ ord: 0, text: '==', fp: ['e', 'c:0'], width: 1, op: '<', delta: 1, k: 0, unsigned: true })];
    assert.match(run(code, sites, decisions), /bQuest == '\\0'/);
    const typed = emit(createCompareFormTransformer({ sites, decisions, structFields: { D2ItemsTxt: { bQuest: 'uchar' } } } as CompareFormOptions)(parse(code)) as AnyNode);
    assert.match(typed, /pItemsTxt->bQuest < 1\)/);
  });

  it('a signed member crosses zero once the struct tables say it is signed', () => {
    const code = 'void f(D2MissilesTxt *pMissileTxt) { if (-1 < pMissileTxt->CltSubMissile1) {} }';
    const sites: Site[] = [{ text: '<', fp: ['c:ffff', 'e'], size: 2 }];
    const decisions = [dec({ ord: 0, text: '<', fp: ['c:ffff', 'e'], width: 2, op: '>=', swap: true, delta: 1, k: 0xffff, signed: true })];
    assert.match(run(code, sites, decisions), /-1 < pMissileTxt->CltSubMissile1/);
    const typed = (t: string) => emit(createCompareFormTransformer({ sites, decisions, structFields: { D2MissilesTxt: { CltSubMissile1: t } } } as CompareFormOptions)(parse(code)) as AnyNode);
    assert.match(typed('short'), /pMissileTxt->CltSubMissile1 >= 0\)/);
    assert.match(typed('ushort'), /-1 < pMissileTxt->CltSubMissile1/);
  });

  it('a character literal steps as a character, or as a decimal where it does not print', () => {
    const code = "void f(char *s) { if (('/' < *s) && (*s < ':')) {} }";
    const sites: Site[] = [{ text: '<', fp: ['c:2f', 'e'], size: 1 }, { text: '<', fp: ['e', 'c:3a'], size: 1 }];
    const out = run(code, sites, [
      dec({ ord: 0, ...sites[0], width: 1, op: '>=', swap: true, delta: 1, k: 0x2f, signed: true }),
      dec({ ord: 1, ...sites[1], width: 1, op: '<=', delta: -1, k: 0x3a, signed: true }),
    ]);
    assert.match(out, /\*s >= '0'\)? && \(?\*s <= '9'/);
    // Quote and backslash are escaped; 0x7f does not print.
    const one = (lit: string, k: number, delta: 1 | -1, op: string) => run(`void f(char c) { if (c < ${lit}) {} }`,
      [{ text: '<', fp: ['v:c', `c:${k.toString(16)}`], size: 1 }],
      [dec({ ord: 0, text: '<', fp: ['v:c', `c:${k.toString(16)}`], width: 1, op, delta, k, signed: true })]);
    assert.match(one("'('", 0x28, -1, '<='), /c <= '\\''/);
    assert.match(one("']'", 0x5d, -1, '<='), /c <= '\\\\'/);
    assert.match(one("'~'", 0x7e, 1, '<'), /c < 127\b/);
    // Never past 0x7f nor below 0, where a plain char's value depends on its signedness.
    assert.match(one("'\\x7f'", 0x7f, 1, '<'), /c < '\\x7f'/);
    assert.match(one("'\\0'", 0, -1, '<='), /c < '\\0'/);
  });
});

describe('compare-form: a byte compared with 1', () => {
  // Q06_SequenceFilter 005968e0: `cmp byte ptr [ecx+0xc], 0` then `cmp byte ptr [ecx+9], 1`.
  const Q06 = `bool f(D2QuestDataStrc *pQuestData) {
  if ((pQuestData->nStateFlag == false) && (pQuestData->bIsNotIntroduction == true)) {
    g();
  }
  return true;
}`;
  const SITES: Site[] = [
    { text: '==', fp: ['e', 'c:0'], size: 1 },
    { text: '==', fp: ['e', 'c:1'], size: 1 },
  ];
  const withCleanup = (code: string) =>
    emit(booleanCleanupPlugin.createTransformer({})(parse(code)) as AnyNode).trim();

  it('Q06_SequenceFilter: the compare with 1 is written `== 1`, the compare with 0 stays a truth test', () => {
    const decisions = [
      dec({ ord: 0, ...SITES[0], width: 1, keep: true, k: 0 }),
      dec({ ord: 1, ...SITES[1], width: 1, keep: true, k: 1 }),
    ];
    const out = run(Q06, SITES, decisions);
    assert.match(out, /bIsNotIntroduction == 1\)/);
    assert.match(out, /nStateFlag == false &&/);
    const cleaned = withCleanup(out);
    assert.match(cleaned, /bIsNotIntroduction == 1/);
    assert.match(cleaned, /!pQuestData->nStateFlag/);
    // Without the instruction the bool test folds to the bare flag.
    assert.doesNotMatch(withCleanup(Q06), /== 1/);
  });

  it('only for a one-byte CMP with 1', () => {
    const wide = [dec({ ord: 1, ...SITES[1], width: 4, keep: true, k: 1 })];
    assert.match(run(Q06, SITES, wide), /bIsNotIntroduction == true/);
    const noK = [dec({ ord: 1, ...SITES[1], width: 1, keep: true })];
    assert.match(run(Q06, SITES, noK), /bIsNotIntroduction == true/);
  });

  it('`!= true` as well', () => {
    const code = 'void f(bool *p) { if (*p != true) { g(); } }';
    const out = run(code, [{ text: '!=', fp: ['e', 'c:1'], size: 1 }], [dec({ ord: 0, text: '!=', fp: ['e', 'c:1'], width: 1, keep: true, k: 1 })]);
    assert.match(out, /\*p != 1/);
  });
});

describe('steppedConstant', () => {
  it('steps inside int and refuses a change of literal type or a cross of zero', () => {
    assert.strictEqual(steppedConstant(lit('0x1450', 0x1450n), 0x1450n, -1), 0x144fn);
    assert.strictEqual(steppedConstant(lit('0x7fffffff', 0x7fffffffn), 0x7fffffffn, 1), null);
    assert.strictEqual(steppedConstant(lit('0x80000000', 0x80000000n), 0x80000000n, -1), null);
    assert.strictEqual(steppedConstant(lit('0', 0n, 10), 0n, -1), null);
    assert.strictEqual(steppedConstant(lit('1', 1n, 10), -1n, 1), null);
    assert.strictEqual(steppedConstant(lit('1', 1n, 10), -1n, 1, true), 0n);
    assert.strictEqual(steppedConstant(lit('5L', 5n, 10, 'L'), 5n, 1), null);
  });
  it('a U literal stays within unsigned', () => {
    assert.strictEqual(steppedConstant(lit('0x80000000U', 0x80000000n, 16, 'U'), 0x80000000n, -1), 0x7fffffffn);
    assert.strictEqual(steppedConstant(lit('0U', 0n, 10, 'U'), 0n, -1), null);
    assert.strictEqual(steppedConstant(lit('0xffffffffU', 0xffffffffn, 16, 'U'), 0xffffffffn, 1), null);
  });
});

describe('compare-form: value forms the flag readers show', () => {
  // CheckModule 00480020: TEST EAX,EAX; SETNE AL.
  it('a bool function returns x where SETNE sets the result', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:bResult', 'c:0'] }];
    const out = run('bool f(int bResult) { return bResult != 0; }', sites,
      [dec({ ord: 0, ...sites[0], keep: true, k: 0, set: true })]);
    assert.strictEqual(out.replace(/\s+/g, ' '), 'bool f(int bResult) { return bResult; }');
  });

  it('keeps x != 0 under a Jcc, in a function not returning bool, and for a float', () => {
    const sites: Site[] = [{ text: '!=', fp: ['v:x', 'c:0'] }];
    const jcc = run('bool f(int x) { return x != 0; }', sites, [dec({ ord: 0, ...sites[0], keep: true, k: 0 })]);
    assert.match(jcc, /return x != 0;/);
    const intRet = run('int f(int x) { return x != 0; }', sites, [dec({ ord: 0, ...sites[0], keep: true, k: 0, set: true })]);
    assert.match(intRet, /return x != 0;/);
    const flt = run('bool f(float x) { return x != 0; }', sites, [dec({ ord: 0, ...sites[0], keep: true, k: 0, set: true })]);
    assert.match(flt, /return x != 0;/);
  });

  // SBMP_ValidateTGAHeader 006c50d0.
  it('a zero-extended uint16 sum under a signed Jcc loses its casts: a + b <= 0x100', () => {
    const sites: Site[] = [{ text: '<', fp: ['e', 'c:101'] }];
    const d = [dec({ ord: 0, ...sites[0], op: '<=', delta: -1, k: 0x101, signed: true, zextSum: true })];
    const opts = { sites, decisions: d, structFields: { H: { a: 'uint16_t', b: 'uint16_t', c: 'uint32_t' } } } as CompareFormOptions;
    const go = (code: string) => emit(createCompareFormTransformer(opts)(parse(code)) as AnyNode).replace(/\s+/g, ' ');
    assert.match(go('int f(H* h) { return (uint)h->a + (uint)h->b < 0x101; }'), /return h->a \+ h->b <= 0x100;/);
    // A 32-bit addend could be negative as an int: left as printed.
    assert.match(go('int f(H* h) { return (uint)h->a + (uint)h->c < 0x101; }'), /< 0x101/);
  });

  it('computes what the printed form computed', { skip: !hasNativeGpp() }, () => {
    const rsites: Site[] = [{ text: '!=', fp: ['v:b', 'c:0'] }];
    const ret = run('bool h(int b) { return b != 0; }', rsites, [dec({ ord: 0, ...rsites[0], keep: true, k: 0, set: true })]);
    assert.ok(!ret.includes('!='), ret);
    const out = compileAndRun(`#include <cstdio>\nbool ph(int b) { return b != 0; }\n${ret}`,
      'int bad = 0; const int v[] = {0, 1, -1, 2, 0x7fffffff, (int)0x80000000}; for (int b : v) { if (ph(b) != h(b)) bad++; } printf("%d\\n", bad);');
    assert.strictEqual(out.trim(), '0');
  });
});

describe('compare-signedness', () => {
  it('casts a tagged unsigned compare whose operand is now signed, and leaves an unsigned one', () => {
    const tagged = run('void f(uint n) { if (n != 0) {} }', [{ text: '!=', fp: ['v:n', 'c:0'] }],
      [dec({ ord: 0, text: '!=', fp: ['v:n', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true })]);
    assert.match(tagged, /n > 0/);
    // The same tagged node after a pass gave n a signed type.
    const ast = createCompareFormTransformer({ sites: [{ text: '!=', fp: ['v:n', 'c:0'] }],
      decisions: [dec({ ord: 0, text: '!=', fp: ['v:n', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true })] } as CompareFormOptions)(parse('void f(uint n) { if (n != 0) {} }'));
    const retyped = JSON.parse(JSON.stringify(ast, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)).replace(/"uint"/g, '"int"'));
    const out = emit(createCompareSignednessTransformer({})(retyped) as AnyNode);
    assert.match(out, /\(uint32_t\)\(?n\)? > 0/);
    assert.match(emit(createCompareSignednessTransformer({})(ast) as AnyNode), /[^)]n > 0/);
  });
});

describe('compare-form keeps the value', { skip: !hasNativeGpp() }, () => {
  /** Printed vs written over `values` of type `type`, for each decision. */
  function check(type: string, values: string, cases: Array<{ printed: string; d: CompareFormDecision }>) {
    for (const { printed, d } of cases) {
      const written = run(`int g(${type} x) { return ${printed}; }`, [{ text: d.text, fp: d.fp, size: d.width }], [d]);
      assert.ok(!written.includes(printed) || d.keep, `not rewritten: ${printed}`);
      const out = compileAndRun(`#include <cstdint>\n#include <cstdio>\ntypedef uint32_t uint;\n` +
        `int p(${type} x) { return ${printed}; }\n${written}`,
        `static const int64_t vals[] = {${values}}; int bad = 0; for (int64_t v : vals) { ${type} x = (${type})v; if (p(x) != g(x)) bad++; } printf("%d\\n", bad);`);
      assert.strictEqual(out.trim(), '0', `${printed} -> ${written}`);
    }
  }
  const all = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)).join(',');
  const edges32 = ['0', '1', '2', '0x7ffffffe', '0x7fffffff', '0x80000000', '0x80000001', '0xfffffffe', '0xffffffff', '0x1450', '0x144f', '0x1451', '-1', '-2']
    .map(v => (v.startsWith('-') ? v : `(int64_t)${v}`)).join(',');

  it('byte operands, every value', () => {
    check('uint8_t', all(0, 255), [
      { printed: 'x < 0xf0', d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:f0'], width: 1, op: '<=', delta: -1, k: 0xf0 }) },
      { printed: '0x10 < x', d: dec({ ord: 0, text: '<', fp: ['c:10', 'v:x'], width: 1, op: '>=', swap: true, delta: 1, k: 0x10 }) },
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], width: 1, op: '>', delta: 0, k: 0, unsigned: true }) },
    ]);
    check('int8_t', all(-128, 127), [
      { printed: 'x < 5', d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:5'], width: 1, op: '<=', delta: -1, k: 5, signed: true }) },
      { printed: '-1 < x', d: dec({ ord: 0, text: '<', fp: ['c:ff', 'v:x'], width: 1, op: '>=', swap: true, delta: 1, k: 0xff, signed: true }) },
      { printed: 'x == 0', d: dec({ ord: 0, text: '==', fp: ['v:x', 'c:0'], width: 1, op: '<=', delta: 0, k: 0, unsigned: true }) },
    ]);
  });

  it('the constant of CMP X,1 and of a character compare, every value', () => {
    check('uint8_t', all(0, 255), [
      { printed: 'x == 0', d: dec({ ord: 0, text: '==', fp: ['v:x', 'c:0'], width: 1, op: '<', delta: 1, k: 0, unsigned: true }) },
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], width: 1, op: '>=', delta: 1, k: 0, unsigned: true }) },
      { printed: "x == '\\0'", d: dec({ ord: 0, text: '==', fp: ['v:x', 'c:0'], width: 1, op: '<', delta: 1, k: 0, unsigned: true }) },
      { printed: "0 != x", d: dec({ ord: 0, text: '!=', fp: ['c:0', 'v:x'], width: 1, op: '>=', swap: true, delta: 1, k: 0, unsigned: true }) },
      { printed: "x < '~'", d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:7e'], width: 1, op: '<=', delta: -1, k: 0x7e }) },
    ]);
    check('uint16_t', all(0, 65535), [
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], width: 2, op: '>=', delta: 1, k: 0, unsigned: true }) },
    ]);
    for (const type of ['char', 'int8_t', 'uint8_t']) {
      check(type, all(-128, 255), [
        { printed: "'/' < x", d: dec({ ord: 0, text: '<', fp: ['c:2f', 'v:x'], width: 1, op: '>=', swap: true, delta: 1, k: 0x2f, signed: true }) },
        { printed: "x < ':'", d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:3a'], width: 1, op: '<=', delta: -1, k: 0x3a, signed: true }) },
        { printed: "x <= '~'", d: dec({ ord: 0, text: '<=', fp: ['v:x', 'c:7e'], width: 1, op: '<', delta: 1, k: 0x7e, signed: true }) },
        { printed: "'\\0' < x", d: dec({ ord: 0, text: '<', fp: ['c:0', 'v:x'], width: 1, op: '>=', swap: true, delta: 1, k: 0, signed: true }) },
      ]);
    }
  });

  it('32-bit operands at the edges', () => {
    check('uint', edges32, [
      { printed: '0x144f < x', d: dec({ ord: 0, text: '<', fp: ['c:144f', 'v:x'], op: '>=', swap: true, delta: 1, k: 0x144f }) },
      { printed: 'x <= 0x7ffffffe', d: dec({ ord: 0, text: '<=', fp: ['v:x', 'c:7ffffffe'], op: '<', delta: 1, k: 0x7ffffffe }) },
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true }) },
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], op: '>=', delta: 1, k: 0, unsigned: true }) },
      { printed: '0 == x', d: dec({ ord: 0, text: '==', fp: ['c:0', 'v:x'], op: '<', swap: true, delta: 1, k: 0, unsigned: true }) },
      { printed: 'x < 0x80000000U', d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:80000000'], op: '<=', delta: -1, k: 0x80000000 }) },
    ]);
    check('int', edges32, [
      { printed: '-1 < x', d: dec({ ord: 0, text: '<', fp: ['c:ffffffff', 'v:x'], op: '>=', swap: true, delta: 1, k: 0xffffffff, signed: true }) },
      { printed: 'x < -5', d: dec({ ord: 0, text: '<', fp: ['v:x', 'c:fffffffb'], op: '<=', delta: -1, k: 0xfffffffb, signed: true }) },
      { printed: 'x != 0', d: dec({ ord: 0, text: '!=', fp: ['v:x', 'c:0'], op: '>', delta: 0, k: 0, unsigned: true }) },
    ]);
  });
});

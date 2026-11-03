/**
 * A Storm parameter check the original compiled as one neg/sbb mask chain is written back as a
 * D2_CHECKS block (param-check-block). The positives are the tree's shapes: SStrCmp 00413550
 * (two checks, a computed return), SFileSetDataChunkSize 00416570 (void), SStrToUnsigned
 * 00413b30 (failure arm then else), SStrHash 00413ce0 (the checks pass into the if, the failure
 * follows it) and SBMP_FlipImage 006c59c0 (a condition wrapped over two lines). The refusals: a
 * genuine if (its test is a TEST), a check that dereferences or calls, a check that feeds its
 * own branch, facts without the tests (an older snapshot), and a function outside Storm (no
 * error setter given).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createParamCheckBlockTransformer, CHECK_BLOCK_SUPPORT_LINES, type ParamCheckBlockOptions } from '../builtins/param-check-block.js';
import type { BranchLayoutEvidence, EqualityTest } from '../builtins/branch-layout/evidence.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';

/** One source line per entry; `<MNEM at>` tokens give that line's equality tests in text order. */
function fixture(lines: string[]): { code: string; ev: BranchLayoutEvidence } {
  const tests = new Map<number, EqualityTest[]>();
  const ifs = new Map<number, number>();
  const text = lines.map((raw, i) => {
    let l = raw;
    for (;;) {
      const m = l.match(/<(\w+) (\d+)>\s?/);
      if (!m) break;
      const list = tests.get(i + 1) ?? [];
      list.push({ op: '==', mnemonic: m[1], reg: 'EAX', k: 0, size: 4, at: Number(m[2]) });
      tests.set(i + 1, list);
      l = l.replace(m[0], '');
    }
    if (/\bif\s*\(/.test(l)) ifs.set(i + 1, 0x20 + i);
    return l;
  });
  return { code: text.join('\n'), ev: { lines: new Map(), ifs, tests } };
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

function run(lines: string[], opts: Partial<ParamCheckBlockOptions> = {}, evEdit?: (ev: BranchLayoutEvidence) => BranchLayoutEvidence) {
  const { code, ev } = fixture(lines);
  const left: string[] = [];
  const t = createParamCheckBlockTransformer({
    branchLayout: evEdit ? evEdit(ev) : ev, errorSetter: 'SErrSetLastError', errorCode: 0x57,
    onLeft: e => left.push(e.why), ...opts,
  });
  return { out: flat(emit(t(parse(code)) as AnyNode)), before: flat(emit(parse(code) as AnyNode)), left };
}

const SSTRCMP = [
  'int SStrCmp(char* str_1, char* str_2, unsigned int n) {',
  '  if (!str_1 || !str_2) { <NEG 13> <NEG 19>',
  '    SErr::SErrSetLastError(0x57);',
  '    return (int)str_1 - (int)str_2;',
  '  }',
  '  return strncmp(str_1, str_2, n);',
  '}',
];

describe('paramCheckBlockPlugin', () => {
  it('writes a two-check guard as a check block (SStrCmp)', () => {
    const { out } = run(SSTRCMP);
    assert.strictEqual(out, flat(`int SStrCmp(char* str_1, char* str_2, unsigned int n) {
      D2_CHECKS_BEGIN; D2_CHECK(str_1); D2_CHECK(str_2);
      D2_CHECKS_END(SErr::SErrSetLastError(0x57), (int)str_1 - (int)str_2);
      return strncmp(str_1, str_2, n); }`));
  });

  it('orders the checks as the NEGs lie in the binary', () => {
    const { out } = run(SSTRCMP.map(l => l.replace('<NEG 13> <NEG 19>', '<NEG 19> <NEG 13>')));
    assert.match(out, /D2_CHECK\(str_2\); D2_CHECK\(str_1\);/);
  });

  it('a void function ends the block without a value (SFileSetDataChunkSize)', () => {
    const { out } = run([
      'void SFileSetDataChunkSize(unsigned int n) {',
      '  if (n - 1 & n) { <NEG 11>',
      '    SErrSetLastError(0x57);',
      '    return;',
      '  }',
      '  g = n;',
      '}',
    ]);
    assert.strictEqual(out, flat(`void SFileSetDataChunkSize(unsigned int n) {
      D2_CHECKS_BEGIN; D2_CHECK(!(n - 1 & n)); D2_CHECKS_END_VOID(SErrSetLastError(0x57)); g = n; }`));
  });

  it('a failure arm with an else takes the last return (SStrToUnsigned)', () => {
    const { out } = run([
      'unsigned int SStrToUnsigned(char* s) {',
      '  if (!s) { <NEG 8>',
      '    SErrSetLastError(0x57);',
      '  } else {',
      '    unsigned int v = *s - 0x30;',
      '    if (v < 10) return v;',
      '  }',
      '  return 0;',
      '}',
    ]);
    assert.strictEqual(out, flat(`unsigned int SStrToUnsigned(char* s) {
      D2_CHECKS_BEGIN; D2_CHECK(s); D2_CHECKS_END(SErrSetLastError(0x57), 0);
      unsigned int v = *s - 0x30; if (v < 10) return v; return 0; }`));
  });

  it('checks that pass into the if, the failure after it (SStrHash)', () => {
    const lines = [
      'unsigned int SStrHash(char* s, unsigned int seed) {',
      '  if (s) { <NEG 9>',
      '    if (!seed) seed = 1;',
      '    return seed + *s;',
      '  }',
      '  SErrSetLastError(0x57);',
      '  return 0;',
      '}',
    ];
    const { out } = run(lines);
    assert.strictEqual(out, flat(`unsigned int SStrHash(char* s, unsigned int seed) {
      D2_CHECKS_BEGIN; D2_CHECK(s); D2_CHECKS_END(SErrSetLastError(0x57), 0);
      if (!seed) seed = 1; return seed + *s; }`));
    // An arm that can fall through reaches the failure after the checks passed: left.
    const fall = run(lines.map(l => l.replace('return seed + *s;', 'g = seed + *s;')));
    assert.strictEqual(fall.out, fall.before);
  });

  it('reads the tests of a condition wrapped over lines (SBMP_FlipImage)', () => {
    const { out } = run([
      'void SBMP_FlipImage(int rows, void* dst, void* src, int size) {',
      '  if (dst == 0 || src == 0 || <NEG 17> <NEG 21>',
      '      size == 0 || rows == 0) { <NEG 27> <NEG 39>',
      '    SErrSetLastError(0x57);',
      '    return;',
      '  }',
      '  g = rows;',
      '}',
    ]);
    assert.match(out, /D2_CHECKS_BEGIN; D2_CHECK\(dst != 0\); D2_CHECK\(src != 0\); D2_CHECK\(size != 0\); D2_CHECK\(rows != 0\); D2_CHECKS_END_VOID/);
  });

  it('leaves a genuine if: its test is a TEST, not a mask', () => {
    const r = run(SSTRCMP.map(l => l.replace('<NEG 13> <NEG 19>', '<TEST 13> <TEST 19>')));
    assert.strictEqual(r.out, r.before);
    assert.deepStrictEqual(r.left, ['a test on TEST, not a mask']);
  });

  it('leaves checks that dereference, call or divide: the block evaluates all of them', () => {
    for (const cond of ['!p || !*p', '!p || !p->n', '!p || !f(p)', '!p || !(8 / n)', '!p || !a[0]']) {
      const r = run([
        'int F(int* p, int n) {',
        `  if (${cond}) { <NEG 1> <NEG 2>`,
        '    SErrSetLastError(0x57);',
        '    return 0;',
        '  }',
        '  return 1;',
        '}',
      ]);
      assert.strictEqual(r.out, r.before, cond);
      assert.deepStrictEqual(r.left, ['a check has a side effect or can fault'], cond);
    }
  });

  it('leaves a chain whose checks feed branches of their own', () => {
    const r = run(SSTRCMP, {}, ev => ({ ...ev, operands: new Map([[2, [[0x10], [0x16]]]]) }));
    assert.strictEqual(r.out, r.before);
    const ok = run(SSTRCMP, {}, ev => ({ ...ev, operands: new Map([[2, [[], []]]]) }));
    assert.match(ok.out, /D2_CHECKS_BEGIN/);
  });

  it('changes nothing without the tests (older facts), the facts, or an error setter (outside Storm)', () => {
    const noTests = run(SSTRCMP, {}, ev => ({ lines: ev.lines, ifs: ev.ifs }));
    assert.strictEqual(noTests.out, noTests.before);
    const noFacts = run(SSTRCMP, { branchLayout: null });
    assert.strictEqual(noFacts.out, noFacts.before);
    const notStorm = run(SSTRCMP, { errorSetter: undefined });
    assert.strictEqual(notStorm.out, notStorm.before);
    const otherCode = run(SSTRCMP.map(l => l.replace('0x57', '0x6')));
    assert.strictEqual(otherCode.out, otherCode.before);
  });

  it('leaves a failure that does not end the function', () => {
    const r = run([
      'int F(int* p) {',
      '  if (!p) { <NEG 1>',
      '    SErrSetLastError(0x57);',
      '  }',
      '  g = 1;',
      '  return 0;',
      '}',
    ]);
    assert.strictEqual(r.out, r.before);
  });

  it('the block computes what the guard did, for every combination (native)', { skip: !hasNativeGpp() }, () => {
    const before = `
      int SStrCmpA(char* a, char* b) { if (!a || !b) { SErrSetLastError(0x57); return (int)(intptr_t)a - (int)(intptr_t)b; } return 7; }
      void ChunkA(unsigned int n) { if (n - 1 & n) { SErrSetLastError(0x57); return; } g = n; }
      unsigned HashA(char* s) { if (s) { return 3; } SErrSetLastError(0x57); return 0; }`;
    const xf = (src: string, tests: number) => {
      const t = createParamCheckBlockTransformer({
        errorSetter: 'SErrSetLastError',
        branchLayout: { lines: new Map(), ifs: new Map([[1, 0x10]]), tests: new Map([[1, Array.from({ length: tests }, (_, k) => ({ op: '==' as const, mnemonic: 'NEG', reg: 'EAX', k: 0, size: 4, at: k }))]]) },
      });
      const out = emit(t(parse(src)) as AnyNode);
      assert.match(out, /D2_CHECKS_BEGIN/);
      return out.replace(/A\(/, 'B(');
    };
    const after = [
      xf('int SStrCmpA(char* a, char* b) { if (!a || !b) { SErrSetLastError(0x57); return (int)(intptr_t)a - (int)(intptr_t)b; } return 7; }', 2),
      xf('void ChunkA(unsigned int n) { if (n - 1 & n) { SErrSetLastError(0x57); return; } g = n; }', 1),
      xf('unsigned HashA(char* s) { if (s) { return 3; } SErrSetLastError(0x57); return 0; }', 1),
    ].join('\n');
    const prelude = `${CHECK_BLOCK_SUPPORT_LINES.join('\n')}
      static unsigned gErr = 0, g = 0;
      static void SErrSetLastError(unsigned e) { gErr = e * 31 + gErr; }
      ${before}\n${after}`;
    const main = `
      char x = 1, y = 2; char* P[3] = {0, &x, &y}; int bad = 0;
      for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) {
        gErr = 0; int r1 = SStrCmpA(P[i], P[j]); unsigned e1 = gErr;
        gErr = 0; int r2 = SStrCmpB(P[i], P[j]); unsigned e2 = gErr;
        if (r1 != r2 || e1 != e2) bad |= 1;
      }
      for (unsigned int n = 0; n < 70; n++) {
        gErr = 0; g = 99; ChunkA(n); unsigned e1 = gErr, g1 = g;
        gErr = 0; g = 99; ChunkB(n); if (e1 != gErr || g1 != g) bad |= 2;
      }
      for (int i = 0; i < 3; i++) {
        gErr = 0; unsigned r1 = HashA(P[i]); unsigned e1 = gErr;
        gErr = 0; unsigned r2 = HashB(P[i]); if (r1 != r2 || e1 != gErr) bad |= 4;
      }
      printf("%d\\n", bad);`;
    assert.strictEqual(compileAndRun(prelude, main).trim(), '0');
  });
});

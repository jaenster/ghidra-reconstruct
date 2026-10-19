/**
 * pseudo-op-lower: every lowering is compiled and run, and checked against the value the
 * p-code operation produces. A spelling check would pass `-0x80` where `0x80` is meant.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  pseudoOpLowerPlugin, splitSizes, UnlowerableArtifactError, type ArtifactRecord, type PseudoOpLowerOptions,
} from '../builtins/pseudo-op-lower.js';
import { ARTIFACT_SUPPORT_LINES } from '../builtins/artifact-support.js';
import { compileAndRun, hasNativeGpp, printHex, readHex } from '../../../testing/native-cpp.js';

/** The platform header's Ghidra typedefs the operands below are declared with. */
const GHIDRA_TYPEDEFS = [
  'typedef unsigned char byte;', 'typedef unsigned int uint;', 'typedef unsigned short ushort;',
  'typedef long long longlong;', 'typedef unsigned long long ulonglong;',
  'typedef int32_t int3;', 'typedef uint32_t uint3;', 'typedef uint8_t undefined3;',
  'typedef uint8_t unkfloat1;',
].join('\n');

const PRELUDE = [GHIDRA_TYPEDEFS, ...ARTIFACT_SUPPORT_LINES].join('\n');

function transform(code: string, options: PseudoOpLowerOptions = {}): string {
  const ast = parse(code);
  return emit(pseudoOpLowerPlugin.createTransformer(options)(ast) as AnyNode).trim();
}

/** The parameter list the expressions below are lowered against. */
const PARAMS = [
  'int32_t i32', 'uint32_t u32', 'int8_t i8', 'uint8_t u8', 'int16_t i16', 'uint16_t u16',
  'longlong ll', 'ulonglong ull', 'int3 i3', 'undefined3 un3', 'char *p', 'float f', 'double d',
  'unkfloat1 uf1',
].join(', ');

/** Lower `expr` as the right-hand side of an assignment and return the emitted expression. */
function lower(expr: string, options: PseudoOpLowerOptions = {}): string {
  const out = transform(`void fn(${PARAMS}) { r = ${expr}; }`, options);
  const at = out.indexOf('r = ');
  return out.slice(at + 4, out.indexOf(';', at));
}

/**
 * Evaluate `cases` (label -> pseudo-op expression) with the parameters bound to `bind`.
 * The lowered text is evaluated inside a lambda that takes the same parameters.
 */
function evaluate(cases: Record<string, string>, bind: Record<string, string> = {}): Record<string, bigint> {
  const decls = PARAMS.split(', ').map(p => {
    const name = p.slice(p.lastIndexOf(' ') + 1).replace('*', '');
    const type = p.slice(0, p.lastIndexOf(' ') + 1) + (p.includes('*') ? '*' : '');
    return `${type.replace(/\*\s*$/, '*')} ${name} = ${bind[name] ?? '0'};`;
  });
  const body = [...decls, ...Object.entries(cases).map(([k, e]) => printHex(k, lower(e)))].join('\n');
  return readHex(compileAndRun(PRELUDE, body));
}

const native = { skip: !hasNativeGpp() };

describe('pseudo-op-lower: size suffix', () => {
  it('splits the concatenated sizes, including the wide ones', () => {
    assert.deepStrictEqual(splitSizes('41'), [4, 1]);
    assert.deepStrictEqual(splitSizes('161'), [16, 1]);
    assert.deepStrictEqual(splitSizes('816'), [8, 16]);
    assert.deepStrictEqual(splitSizes('110'), [1, 10]);
  });
  it('refuses a suffix with no reading', () => {
    assert.throws(() => splitSizes('9'), /0 readings/);
  });
});

describe('pseudo-op-lower: SUBPIECE', native, () => {
  it('extracts bytes counted from the least significant, with a logical shift', () => {
    const v = evaluate({
      s41: 'SUB41(i32, 3)', s42: 'SUB42(i32, 2)', s43: 'SUB43(u32, 0)', s43b: 'SUB43(u32, 1)',
      s84: 'SUB84(ll, 4)', s84lo: 'SUB84(ll, 0)', s21: 'SUB21(i16, 1)', s82: 'SUB82(ull, 6)',
    }, { i32: '(int32_t)0x80000000', u32: '0xAABBCCDDu', ll: '-1LL', i16: '(int16_t)0x8001', ull: '0x1122334455667788ull' });
    assert.deepStrictEqual(v, {
      s41: 0x80n, s42: 0x8000n, s43: 0xBBCCDDn, s43b: 0xAABBCCn,
      s84: 0xFFFFFFFFn, s84lo: 0xFFFFFFFFn, s21: 0x80n, s82: 0x1122n,
    });
  });
  it('SUB42 of a negative value gives the high half unsigned', () => {
    assert.deepStrictEqual(evaluate({ s: 'SUB42(i32, 2)' }, { i32: '-2' }), { s: 0xFFFFn });
  });
  it('a pointer is read as its address', () => {
    const out = lower('SUB41(p, 0)');
    assert.ok(out.includes('(uintptr_t)'), out);
  });
  it('a 3-byte operand cast drops the 1-byte undefined3 typedef', () => {
    const v = evaluate({ c: 'CONCAT13(0xd, (undefined3)u32)' }, { u32: '0x00ABCDEFu' });
    assert.deepStrictEqual(v, { c: 0x0DABCDEFn });
  });
  it('SUB14 (wider output) is the zero extension of the byte', () => {
    assert.deepStrictEqual(evaluate({ s: 'SUB14(u8 != 0, 0)' }, { u8: '7' }), { s: 1n });
  });
});

describe('pseudo-op-lower: floating operands are bit patterns', native, () => {
  it('SUB84 of a double reads its IEEE bits, not its value', () => {
    // UTILS_SqrtFloat and the CRT callers hand a double to CRT_ClearFP as two dwords.
    assert.deepStrictEqual(evaluate({ hi: 'SUB84(d, 4)', lo: 'SUB84(d, 0)' }, { d: '1.0' }),
      { hi: 0x3FF00000n, lo: 0n });
  });
  it('SUB41 of a float holding integer bits reads those bits (the Glide gamma case)', () => {
    // grGet(0x2a, .., &fGammaVal) writes 0x0000000C into the float; its value is a denormal.
    const out = compileAndRun(PRELUDE, [
      'float f; uint32_t bits = 0x0000000Cu; std::memcpy(&f, &bits, 4);',
      ...PARAMS.split(', ').filter(p => !p.endsWith(' f')).map(p => `${p.replace(/\*\s*/, '*')} = 0;`),
      printHex('mask', `(1 << (${lower('SUB41(f, 0)')} & 0x1f)) - 1`),
    ].join('\n'));
    assert.deepStrictEqual(readHex(out), { mask: 0xFFFn });
  });
  it('a (float) of a 1- or 2-byte integer is the integer under either reading', () => {
    assert.deepStrictEqual(evaluate({ s: 'SUB42((float)u16, 0)' }, { u16: '0xC01' }), { s: 0xC01n });
  });
  it('a long double operand is reported, not converted', () => {
    const seen: ArtifactRecord[] = [];
    transform('void fn(long double x) { r = SUB84(x, 0); }', { onArtifact: r => seen.push(r) });
    assert.match(seen[0]?.reason ?? '', /10 bytes/);
  });
});

describe('pseudo-op-lower: PIECE', native, () => {
  it('joins the halves at their own widths', () => {
    const v = evaluate({
      c12: 'CONCAT12(i8, 0x2233)', c11: 'CONCAT11(i32, 0x22)', c14: 'CONCAT14(i8, 0)',
      c44: 'CONCAT44(0x29a, 0)', c31: 'CONCAT31(i3, 0x80)', c22: 'CONCAT22(i16, u16)',
      c44p: 'CONCAT44(u32, p)',
    }, { i8: '-1', i32: '0x1FF', i3: '0x7FFFFFFF', i16: '-1', u16: '0x1234', u32: '0xCAFEu', p: '(char*)0x10' });
    assert.deepStrictEqual(v, {
      c12: 0xFF2233n, c11: 0xFF22n, c14: 0xFF00000000n, c44: 0x29a00000000n,
      c31: 0xFFFFFF80n, c22: 0xFFFF1234n, c44p: 0xCAFE00000010n,
    });
  });
  it('a 3-byte cast of a narrower value is the extension it names', () => {
    // ZLIB_InflateTable: CONCAT31((uint3)byOpBits, 0x60); a widening int3 sign-extends.
    const v = evaluate({ z: 'CONCAT31((uint3)u8, 0x60)', s: 'CONCAT31((int3)i8, 0x60)', p: 'CONCAT31(p, 0x7)' },
      { u8: '0x9A', i8: '-2', p: '(char*)0x11223344' });
    assert.deepStrictEqual(v, { z: 0x9A60n, s: 0xFFFFFE60n, p: 0x22334407n });
  });
  it('a 5-byte total is masked to 40 bits', () => {
    assert.deepStrictEqual(evaluate({ c: 'CONCAT32(i32, u16)' }, { i32: '-1', u16: '0x1234' }), { c: 0xFFFFFF1234n });
  });
});

describe('pseudo-op-lower: ZEXT / SEXT', native, () => {
  it('zero-extends from the source width, sign-extends from it', () => {
    const v = evaluate({
      z14: 'ZEXT14(i8)', z24: 'ZEXT24(i16)', z48: 'ZEXT48(i32)',
      s14: 'SEXT14(u8)', s24: 'SEXT24(u16)', s34: 'SEXT34(u32)', s48: 'SEXT48(u32)',
    }, { i8: '-1', i16: '-1', i32: '-1', u8: '0x80u', u16: '0x8000u', u32: '0x800000u' });
    assert.deepStrictEqual(v, {
      z14: 0xFFn, z24: 0xFFFFn, z48: 0xFFFFFFFFn,
      s14: 0xFFFFFFFFFFFFFF80n, s24: 0xFFFFFFFFFFFF8000n, s34: 0xFFFFFFFFFF800000n, s48: 0x800000n,
    });
  });
  it('ZEXT48 of a pointer is its address', () => {
    assert.deepStrictEqual(evaluate({ z: 'ZEXT48(p)' }, { p: '(char*)0x1234' }), { z: 0x1234n });
  });
});

describe('pseudo-op-lower: flags', native, () => {
  it('CARRY is the carry out of the operand width', () => {
    const v = evaluate({
      c1: 'CARRY1(u8, 1)', c2: 'CARRY2(u16, 1)', c4: 'CARRY4(u32, 1)', c4n: 'CARRY4(u32 - 1, 1)',
    }, { u8: '0xFF', u16: '0xFFFF', u32: '0xFFFFFFFFu' });
    assert.deepStrictEqual(v, { c1: 1n, c2: 1n, c4: 1n, c4n: 0n });
  });
  it('SBORROW4 is signed overflow of a - b', () => {
    const cases = (a: string, b: string) => evaluate({ s: 'SBORROW4(i32, u32)' }, { i32: a, u32: b }).s;
    assert.strictEqual(cases('INT32_MIN', '1'), 1n);
    assert.strictEqual(cases('0', '0x80000000u'), 1n);
    assert.strictEqual(cases('-1', '0x80000000u'), 0n);
    assert.strictEqual(cases('INT32_MAX', '0xFFFFFFFFu'), 1n);
    assert.strictEqual(cases('5', '3'), 0n);
  });
  it('the 8-bit flags agree with their arithmetic definitions for all 65536 pairs', () => {
    const exprs = {
      c: lower('CARRY1(u8, i8)'),
      sb: lower('SBORROW1(u8, i8)'),
      sc: lower('SCARRY1(u8, i8)'),
    };
    const out = compileAndRun(PRELUDE, [
      'int bad = 0;',
      'for (int x = 0; x < 256; x++) for (int y = 0; y < 256; y++) {',
      '  uint8_t u8 = (uint8_t)x; int8_t i8 = (int8_t)y;',
      '  int sa = (int8_t)u8, sb = i8, ua = u8, ub = (uint8_t)i8;',
      `  bool c = ${exprs.c}; bool b = ${exprs.sb}; bool s = ${exprs.sc};`,
      '  if (c != (ua + ub > 255)) bad++;',
      '  if (b != (sa - sb < -128 || sa - sb > 127)) bad++;',
      '  if (s != (sa + sb < -128 || sa + sb > 127)) bad++;',
      '}',
      'printf("%d\\n", bad);',
    ].join('\n'));
    assert.strictEqual(out.trim(), '0');
  });
});

describe('pseudo-op-lower: SBORROW folded to a signed compare', native, () => {
  /**
   * For every 8-bit pair, the folded form equals the exact flag expression it replaced.
   * The exact one is built by lowering the same text with the fold impossible (an
   * impure-looking wrapper is not used; the flag op alone is lowered exactly).
   */
  const sweep = (folded: string, exact: string) => compileAndRun(PRELUDE, [
    'int bad = 0;',
    'for (int x = 0; x < 256; x++) for (int y = 0; y < 256; y++) {',
    '  uint8_t u8 = (uint8_t)x; uint8_t a8 = (uint8_t)y;',
    `  bool f = ${folded}; bool e = ${exact};`,
    '  if (f != e) bad++;',
    '}',
    'printf("%d\\n", bad);',
  ].join('\n')).trim();

  const foldOf = (cond: string) => {
    const out = transform(`void fn(uint8_t u8, uint8_t a8) { if (${cond}) { r = 1; } }`);
    const at = out.indexOf('if (');
    return out.slice(at + 4, out.indexOf(') {\n', at));
  };
  const exactOf = (cond: string) => {
    // The exact lowering of the flag op, with the companion left as written.
    const sb = lower('SBORROW1(u8, i8)').replace(/\bi8\b/g, 'a8');
    return cond.replace('SBORROW1(u8, a8)', `(${sb})`);
  };

  for (const [label, cond, op] of [
    ['jl', 'SBORROW1(u8, a8) != (char)(u8 - a8) < 0', '<'],
    ['jge', 'SBORROW1(u8, a8) == (char)(u8 - a8) < 0', '>='],
    ['jle', 'u8 == a8 || SBORROW1(u8, a8) != (char)(u8 - a8) < 0', '<='],
    ['jg', 'u8 != a8 && SBORROW1(u8, a8) == (char)(u8 - a8) < 0', '>'],
  ] as const) {
    it(`${label}: folds to ${op} and agrees with the flag for all pairs`, () => {
      const folded = foldOf(cond);
      assert.ok(!folded.includes('^'), `expected a fold, got ${folded}`);
      assert.ok(folded.includes(op), folded);
      assert.strictEqual(sweep(folded, exactOf(cond)), '0');
    });
  }

  it('folds the constant form a + -c < 0 at 32 bits', () => {
    const out = transform('void fn(int32_t n) { if (SBORROW4(n, 5) != n + -5 < 0) { r = 1; } }');
    assert.ok(out.includes('if ((int32_t)n < (int32_t)5)') || out.includes('if ((int32_t)n < 5)'), out);
  });

  it('does not fold the shape where Ghidra substituted a value into the companion', () => {
    // MISSILE_SpawnAreaOfEffect: the companion is `nRadius * -2 < 0`, not iOffsetX - nRadius.
    const out = transform('void fn(int32_t iOffsetX, int32_t nRadius) { if (-nRadius == nRadius || SBORROW4(iOffsetX, nRadius) != nRadius * -2 < 0) { r = 1; } }');
    assert.ok(out.includes('nRadius * -2 < 0'), out);
    assert.ok(out.includes('^'), `expected the exact flag lowering, got ${out}`);
    assert.ok(!out.includes('SBORROW4'), out);
  });

  it('does not fold when the operands are a different AST', () => {
    const out = transform('void fn(int32_t a, int32_t b, int32_t c) { if (SBORROW4(a, b) != a - c < 0) { r = 1; } }');
    assert.ok(out.includes('^'), out);
  });
});

describe('pseudo-op-lower: ROUND', native, () => {
  it('rounds half to even, as FRNDINT and FIST do', () => {
    const v = (x: string) => compileAndRun(PRELUDE, [
      ...PARAMS.split(', ').filter(p => !p.endsWith(' d')).map(p => `${p.replace(/\*\s*/, '*')} = 0;`),
      `double d = ${x};`,
      `printf("%d\\n", (int)(${lower('ROUND(d)')}));`,
    ].join('\n')).trim();
    assert.deepStrictEqual(['2.5', '-2.5', '3.5', '0.5', '1.25'].map(v), ['2', '-2', '4', '0', '1']);
  });
});

describe('pseudo-op-lower: ABS', native, () => {
  it('clears the sign bit, of -0.0 too', () => {
    const out = compileAndRun(PRELUDE, [
      ...PARAMS.split(', ').filter(p => !p.endsWith(' d')).map(p => `${p.replace(/\*\s*/, '*')} = 0;`),
      'double d = -0.0;',
      `double z = ${lower('ABS(d)')};`,
      'd = -3.5;',
      `double t = ${lower('ABS(d)')};`,
      'printf("%d %g\\n", (int)std::signbit(z), t);',
    ].join('\n')).trim();
    assert.strictEqual(out, '0 3.5');
  });
});

describe('pseudo-op-lower: what is not lowered', () => {
  it('leaves an operand of unknown type alone and reports it', () => {
    const seen: ArtifactRecord[] = [];
    const out = transform('void fn() { r = SUB41(gUnknown, 0); }', { onArtifact: r => seen.push(r) });
    assert.ok(out.includes('SUB41(gUnknown, 0)'), out);
    assert.deepStrictEqual(seen.map(s => s.op), ['SUB41']);
  });
  it('throws in strict mode', () => {
    assert.throws(() => transform('void fn() { r = SUB41(gUnknown, 0); }', { mode: 'strict' }), UnlowerableArtifactError);
  });
  it('a global known to the tables is lowered', () => {
    const out = transform('void fn() { r = SUB41(gKnown, 1); }', { globalTypes: { gKnown: 'uint' } });
    assert.ok(!out.includes('SUB41'), out);
  });
  it('a flag op with a call operand is reported, not evaluated twice', () => {
    const seen: ArtifactRecord[] = [];
    const out = transform('void fn(int32_t a) { r = SBORROW4(g(a), 1); }', { onArtifact: r => seen.push(r) });
    assert.ok(out.includes('SBORROW4(g(a), 1)'), out);
    assert.match(seen[0].reason, /side effect/);
  });
  it('an operand narrower than the bytes read is reported', () => {
    const seen: ArtifactRecord[] = [];
    transform('void fn(uint8_t b) { r = SUB42(b, 0); }', { onArtifact: r => seen.push(r) });
    assert.match(seen[0]?.reason ?? '', /1 bytes, the operation reads 2/);
  });
  it('renames NAN(x) to D2_IsNaN(x), and leaves the NAN constant alone', () => {
    const out = transform('void fn(double d) { r = NAN(d); q = NAN; }');
    assert.ok(out.includes('D2_IsNaN(d)'), out);
    assert.ok(out.includes('q = NAN'), out);
  });
  it('leaves names that only start like a pseudo-op', () => {
    const out = transform('void fn() { r = SUBTILE_GetSize(1, 2); s = CONCATENATE(a, b); t = SUB41x(1, 0); }');
    assert.ok(out.includes('SUBTILE_GetSize(1, 2)'), out);
    assert.ok(out.includes('CONCATENATE(a, b)'), out);
    assert.ok(out.includes('SUB41x(1, 0)'), out);
  });
  it('lowers nested ops inside out', () => {
    const out = transform('void fn(uint8_t a, uint8_t b, uint16_t c) { r = CONCAT22(CONCAT11(a, b), c); }');
    assert.ok(!out.includes('CONCAT'), out);
  });
});

describe('pseudo-op-lower: plugin metadata', () => {
  it('runs at priority 20, before subpiece-access and the cast passes', () => {
    assert.strictEqual(pseudoOpLowerPlugin.id, 'pseudo-op-lower');
    assert.strictEqual(pseudoOpLowerPlugin.priority, 20);
    assert.strictEqual(pseudoOpLowerPlugin.defaultEnabled, true);
  });
});

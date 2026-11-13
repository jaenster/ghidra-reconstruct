import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { rotateIntrinsicPlugin, type RotateFact } from '../builtins/rotate-intrinsic.js';

/** One statement per line; `[l1e,r2]` tags the line with the rotates its instructions perform. */
function run(lines: string[]): string {
  const rotates = new Map<number, RotateFact[]>();
  const text = lines.map((l, i) => {
    const m = l.match(/^\s*\[([lr0-9a-f,]+)\]\s?(.*)$/);
    if (!m) return l;
    rotates.set(i + 1, m[1].split(',').map(s => ({ left: s[0] === 'l', count: Number.parseInt(s.slice(1), 16) })));
    return m[2];
  });
  const t = rotateIntrinsicPlugin.createTransformer({ rotates });
  return emit(t(parse(text.join('\n'))) as AnyNode).replace(/\s+/g, ' ');
}

describe('rotateIntrinsicPlugin', () => {
  // SHA1_Round1 00425730: `rol ecx, 5` then `rol ecx, 0x1e`.
  it('writes a pair the original rotates left by more than 16 as _rotl', () => {
    const out = run([
      'void f(unsigned int nA, unsigned int *pnB, int *pnE) {',
      '[l5] *pnE = *pnE + (nA << 5 | nA >> 0x1b);',
      '[l1e] *pnB = *pnB << 0x1e | *pnB >> 2;',
      '}',
    ]);
    assert.match(out, /\*pnB = _rotl\(\*pnB, 0x1e\);/);
    // A count of 16 or less compiles to the original's rotate as printed.
    assert.match(out, /nA << 5 \| nA >> 0x1b/);
  });

  it('takes the operands in either order', () => {
    const out = run(['void f(unsigned int x, unsigned int *p) {', '[l1e] *p = x >> 2 | x << 0x1e;', '}']);
    assert.match(out, /\*p = _rotl\(x, 0x1e\);/);
  });

  it('writes a right rotate by more than 16 as _rotr', () => {
    const out = run(['void f(unsigned int x, unsigned int *p) {', '[r1d] *p = x << 3 | x >> 0x1d;', '}']);
    assert.match(out, /\*p = _rotr\(x, 0x1d\);/);
  });

  // The pair also prints a `ror 2`, which VC8 makes of it already.
  it('leaves a pair whose original rotates by the smaller count', () => {
    const out = run(['void f(unsigned int x, unsigned int *p) {', '[r2] *p = x << 0x1e | x >> 2;', '}']);
    assert.match(out, /x << 0x1e \| x >> 2/);
  });

  // XSHA1_Transform 005206b0: a signed shift, not the same operand.
  it('leaves a pair over a cast operand', () => {
    const out = run(['void f(unsigned int x, unsigned int *p) {', '[l1e] *p = x << 0x1e | (int)x >> 2;', '}']);
    assert.match(out, /x << 0x1e \| \(int\)x >> 2/);
  });

  it('leaves a line without the rotate, and every line without facts', () => {
    const out = run(['void f(unsigned int x, unsigned int *p, unsigned int *q) {', '[l5] *p = x << 0x1e | x >> 2;', '*q = x << 0x1e | x >> 2;', '}']);
    assert.doesNotMatch(out, /_rotl/);
    const t = rotateIntrinsicPlugin.createTransformer({});
    assert.match(emit(t(parse('void f(unsigned int x, unsigned int *p) { *p = x << 0x1e | x >> 2; }')) as AnyNode), /x << 0x1e \| x >> 2/);
  });

  it('leaves operands that differ or have effects', () => {
    const out = run([
      'void f(unsigned int x, unsigned int y, unsigned int *p) {',
      '[l1e] *p = x << 0x1e | y >> 2;',
      '[l1e] *p = g() << 0x1e | g() >> 2;',
      '[l1e] *p = x << 0x1d | x >> 2;',
      '}',
    ]);
    assert.doesNotMatch(out, /_rotl/);
  });

  // SHA1_Transform 00528c90: `rol edi, 5` and `rol edx, 0x1e`, printed as multiplies.
  it('writes a multiply pair as the intrinsic whatever the count', () => {
    const out = run([
      'void f(unsigned int x, unsigned int *p, unsigned int *q) {',
      '[l5] *p = *p + (x * 0x20 | x >> 0x1b);',
      '[l1e] *q = x * 0x40000000 | x >> 2;',
      '[r2] *q = x >> 2 | 0x40000000 * x;',
      '}',
    ]);
    assert.match(out, /\*p = \*p \+ _rotl\(x, 5\);/);
    assert.match(out, /\*q = _rotl\(x, 0x1e\);/);
    assert.match(out, /\*q = _rotr\(x, 2\);/);
  });

  it('types the operand through a pointer parameter and a local', () => {
    const out = run([
      'void f(uint32_t *w) {',
      'uint32_t s = w[1];',
      '[l1e] w[0] = w[1] * 0x40000000 | w[1] >> 2;',
      '[l5] w[2] = s * 0x20 | s >> 0x1b;',
      '}',
    ]);
    assert.match(out, /w\[0\] = _rotl\(w\[1\], 0x1e\);/);
    assert.match(out, /w\[2\] = _rotl\(s, 5\);/);
  });

  // A signed `>>` is arithmetic and the product of an int can overflow: no rotate.
  it('leaves a multiply pair over a signed or untyped operand', () => {
    const out = run([
      'void f(int x, unsigned short h, unsigned int *p) {',
      '[l5] *p = x * 0x20 | x >> 0x1b;',
      '[l5] *p = h * 0x20 | h >> 0x1b;',
      '[l5] *p = g * 0x20 | g >> 0x1b;',
      '[l1e] *p = x << 0x1e | x >> 2;',
      '}',
    ]);
    assert.doesNotMatch(out, /_rot/);
  });

  it('leaves a multiply pair whose counts or operands do not make a rotate', () => {
    const out = run([
      'void f(unsigned int x, unsigned int y, unsigned int *p) {',
      '[l5] *p = x * 0x20 | x >> 0x1a;',
      '[l5] *p = x * 0x20 | y >> 0x1b;',
      '[l5] *p = x * 0x21 | x >> 0x1b;',
      '[l6] *p = x * 0x20 | x >> 0x1b;',
      '}',
    ]);
    assert.doesNotMatch(out, /_rot/);
  });

  // SHA1_Transform 00528c90: `rol edx, 0x18; and 0xff00ff00; rol esi, 8; and 0xff00ff; or`.
  it('writes the byte swap the original builds from two rotates', () => {
    const out = run([
      'void f(uint32_t *w, uint32_t *o) {',
      'uint32_t d = *w;',
      '[l18,l8] *o = d << 0x18 | d >> 8 & -16711936 | (d & 0xff00) << 8 | d >> 0x18;',
      '[l8,r8] o[1] = d << 0x18 | d >> 8 & 0xff00ff00 | (d & 0xff00) << 8 | d >> 0x18;',
      '}',
    ]);
    assert.match(out, /\*o = _rotl\(d, 0x18\) & 0xff00ff00 \| _rotl\(d, 8\) & 0xff00ff;/);
    assert.match(out, /o\[1\] = _rotl\(d, 8\) & 0xff00ff \| _rotr\(d, 8\) & 0xff00ff00;/);
  });

  it('leaves a byte swap without both rotates, over a signed operand, or not exactly a swap', () => {
    const out = run([
      'void f(unsigned int d, int s, unsigned int *o) {',
      '[l18] *o = d << 0x18 | d >> 8 & 0xff00ff00 | (d & 0xff00) << 8 | d >> 0x18;',
      '*o = d << 0x18 | d >> 8 & 0xff00ff00 | (d & 0xff00) << 8 | d >> 0x18;',
      '[l18,l8] *o = s << 0x18 | s >> 8 & 0xff00ff00 | (s & 0xff00) << 8 | s >> 0x18;',
      '[l18,l8] *o = d << 0x18 | d >> 8 & 0xff00ff00 | (d & 0xff0000) << 8 | d >> 0x18;',
      '[l18,l8] *o = d << 0x18 | d >> 8 & 0xff00ff00 | (d & 0xff00) << 8;',
      '}',
    ]);
    assert.doesNotMatch(out, /_rot/);
  });

  // SHA1_Transform 00528c90's schedule: `rol edx, 1`, the top bit printed as a sign test.
  it('writes a rotate by 1 printed with the sign test', () => {
    const out = run([
      'void f(uint32_t *w, uint32_t s) {',
      '[l1] w[0] = s << 1 | (uint32_t)((int)s < 0);',
      '[l1] w[1] = (uint32_t)((int)w[2] < 0) | w[2] * 2;',
      '}',
    ]);
    assert.match(out, /w\[0\] = _rotl\(s, 1\);/);
    assert.match(out, /w\[1\] = _rotl\(w\[2\], 1\);/);
  });

  it('leaves a sign test that is not the top bit of the shifted operand', () => {
    const out = run([
      'void f(uint32_t *w, uint32_t s, uint32_t t, int i) {',
      '[l1] w[0] = s << 1 | (uint32_t)((int)t < 0);',
      '[l1] w[0] = s << 1 | (uint32_t)((short)s < 0);',
      '[l1] w[0] = s << 1 | (uint32_t)((int)s < 1);',
      '[l1] w[0] = s << 2 | (uint32_t)((int)s < 0);',
      '[l1] w[0] = i << 1 | (uint32_t)((int)i < 0);',
      '}',
    ]);
    assert.doesNotMatch(out, /_rot/);
  });
});


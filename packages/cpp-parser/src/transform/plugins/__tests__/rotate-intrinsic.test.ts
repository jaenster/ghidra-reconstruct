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
});

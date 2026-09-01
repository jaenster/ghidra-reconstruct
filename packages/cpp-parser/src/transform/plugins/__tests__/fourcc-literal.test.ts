/**
 * Ghidra spells a 32-bit item code as a WIDE character literal — `L'\x20646c67'`
 * for `'gld '`. `wchar_t` is 16 bits on i686-w64-mingw32, so the literal holds
 * one code unit and GCC silently keeps only the bottom half (26673 for
 * `L'\x20736831'`, not 544434225), warning only where `-w` erases it.
 *
 * The truncation is not injective, which is what makes it a correctness defect
 * rather than a wrong constant: `'g33'`/`'g34'`, `'qf1'`/`'qf2'`, `'1hs'`/`'1ht'`
 * and `'bkd'`/`'bks'` all land on the same 16 bits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { fourccLiteralPlugin } from '../builtins/fourcc-literal.js';

describe('fourccLiteralPlugin', () => {
  const transformer = fourccLiteralPlugin.createTransformer({});
  const run = (code: string) =>
    emit(transformer(parse(code)) as AnyNode).replace(/\s+/g, ' ').trim();

  it('spells a four-character code as the integer it is', () => {
    // 'gld ' — gold, 12 sites in the tree.
    assert.ok(run("void f() { g(L'\\x20646c67'); }").includes('g(0x20646c67)'),
      run("void f() { g(L'\\x20646c67'); }"));
  });

  it('spells a three-character code the same way', () => {
    // 'g33' and 'g34' collapse onto one wchar_t; as integers they stay apart.
    const g33 = run("void f() { g(L'\\x333367'); }");
    const g34 = run("void f() { g(L'\\x343367'); }");
    assert.ok(g33.includes('0x333367'), g33);
    assert.ok(g34.includes('0x343367'), g34);
    assert.notStrictEqual(g33, g34);
  });

  it('keeps the codes distinct that the truncation merged', () => {
    const pairs = [
      ["L'\\x20736831'", "L'\\x20746831'"], // '1hs ' / '1ht '
      ["L'\\x20646b62'", "L'\\x20736b62'"], // 'bkd ' / 'bks '
      ["L'\\x316671'", "L'\\x326671'"],     // 'qf1'  / 'qf2'
    ];
    for (const [a, b] of pairs) {
      const ra = run(`void f() { g(${a}); }`);
      const rb = run(`void f() { g(${b}); }`);
      assert.notStrictEqual(ra, rb, `${a} and ${b} still collide: ${ra}`);
      assert.ok(!ra.includes("L'") && !rb.includes("L'"), `${ra} / ${rb}`);
    }
  });

  it('leaves a genuine wide character exactly as it is', () => {
    const out = run("void f() { p[0] = L'\\0'; p[1] = L'A'; p[2] = L'\\xffff'; }");
    assert.ok(out.includes("L'\\0'"), out);
    assert.ok(out.includes("L'A'"), out);
    assert.ok(out.includes("L'\\xffff'"), out);
  });

  it('leaves a genuine wide STRING alone — its L is the whole point', () => {
    const out = run('void f() { wcscpy(dst, L"Diablo II"); }');
    assert.ok(out.includes('L"Diablo II"'), out);
  });

  it('still decodes a char[4] cast into the readable code', () => {
    const out = run("void f() { g((char[4])L'\\x20736831'); }");
    assert.ok(out.includes('"1hs "'), out);
  });
});

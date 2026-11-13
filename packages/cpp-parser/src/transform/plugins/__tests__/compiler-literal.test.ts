/**
 * Tests for the Compiler Literal Plugin: a pooled string literal's label is spelled as
 * the literal, never as a declaration the tree would have to provide.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { compilerLiteralPlugin, type CompilerLiteralOptions } from '../builtins/compiler-literal.js';

describe('compilerLiteralPlugin', () => {
  function run(code: string, opts: CompilerLiteralOptions): { out: string; refused: string[] } {
    const refused: string[] = [];
    const transformer = compilerLiteralPlugin.createTransformer({ ...opts, onRefusal: r => refused.push(r) });
    return { out: emit(transformer(parse(code)) as AnyNode).trim(), refused };
  }
  const FONTS: CompilerLiteralOptions = { literals: { s_Font8_006dc978: '"Font8"' } };

  it('spells a label as its literal, at the type the array decays to', () => {
    const { out } = run('void f() { wsprintfA(buf, "%s", s_Font8_006dc978); }', FONTS);
    assert.match(out, /wsprintfA\(buf, "%s", \(char\*\)"Font8"\)/);
    assert.doesNotMatch(out, /s_Font8/);
  });

  it('spells the address of a label under a cast as the literal', () => {
    const { out } = run('void f() { p = (void *)&s_Font8_006dc978; }', FONTS);
    assert.match(out, /\(void\*\)\(char\*\)"Font8"/);
  });

  it('spells a qualified label as the same literal', () => {
    const { out } = run('void f() { g((char *)D2Win::_FONT::s_Font8_006dc978); }', FONTS);
    assert.match(out, /\(char\*\)\(char\*\)"Font8"/);
    assert.doesNotMatch(out, /_FONT::/);
  });

  it('keeps a label under a dereference, which a literal cannot replace without changing meaning', () => {
    const { out, refused } = run('void f() { c = *s_Font8_006dc978; }', FONTS);
    assert.match(out, /\*s_Font8_006dc978/);
    assert.strictEqual(refused.length, 1);
  });

  it('spells the image header as the linker symbol', () => {
    const { out } = run('void f() { p = &IMAGE_DOS_HEADER__00400000; }', { renames: { IMAGE_DOS_HEADER__00400000: '__ImageBase' } });
    assert.match(out, /&__ImageBase/);
  });

  it('leaves a body with no such label alone', () => {
    const code = 'void f() { g(s_Other_006dc000); }';
    assert.match(run(code, FONTS).out, /g\(s_Other_006dc000\)/);
  });
});

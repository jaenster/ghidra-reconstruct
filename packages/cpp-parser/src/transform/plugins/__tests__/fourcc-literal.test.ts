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
import { NodeKind } from '../../../ast/kinds.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import type { AnyNode, ASTNode, CStyleCastExpr, StringLiteralExpr } from '../../../ast/nodes.js';
import { fourccLiteralPlugin } from '../builtins/fourcc-literal.js';

function findNode<T extends ASTNode>(value: unknown, kind: NodeKind): T | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if ('kind' in value && value.kind === kind) return value as T;
  for (const child of Object.values(value)) {
    const found = findNode<T>(child, kind);
    if (found) return found;
  }
  return undefined;
}

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

  it('escapes trigraphs in a decoded four-character code', () => {
    const out = run("void f() { g((char[4])L'\\x413d3f3f'); }");
    assert.ok(out.includes('"\\?\\?=A"'), out);
  });

  it('escapes printable quote and backslash bytes without changing the decoded value', () => {
    for (const [hex, expected] of [
      ['3f422241', 'A"B?'],
      ['3f425c41', 'A\\B?'],
    ]) {
      const transformed = transformer(parse(`void f() { g((char[4])L'\\x${hex}'); }`)) as AnyNode;
      const literal = findNode<StringLiteralExpr>(transformed, NodeKind.StringLiteral);
      assert.ok(literal, hex);
      assert.strictEqual(literal.value, expected);
      const output = emit(transformed);
      const reparsed = findNode<StringLiteralExpr>(parse(output), NodeKind.StringLiteral);
      assert.strictEqual(reparsed?.value, expected, output);
      assert.ok(literal.raw.includes(hex === '3f422241' ? '\\"' : '\\\\'), literal.raw);
    }
  });

  it('refuses a nonprintable byte with requirePrintable enabled', () => {
    const transformed = transformer(parse("void f() { g((char[4])L'\\x43424101'); }")) as AnyNode;
    assert.ok(findNode<CStyleCastExpr>(transformed, NodeKind.CStyleCastExpr));
    assert.strictEqual(findNode<StringLiteralExpr>(transformed, NodeKind.StringLiteral), undefined);
  });

  it('uses bounded octal escapes for nonprintable bytes when explicitly enabled', () => {
    const allBytes = fourccLiteralPlugin.createTransformer({ requirePrintable: false });
    const transformed = allBytes(parse("void f() { g((char[4])L'\\x43424101'); }")) as AnyNode;
    const literal = findNode<StringLiteralExpr>(transformed, NodeKind.StringLiteral);
    assert.ok(literal);
    assert.strictEqual(literal.value, '\x01ABC');
    assert.strictEqual(literal.raw, String.raw`"\001ABC"`);
    const output = emit(transformed);
    assert.ok(output.includes(String.raw`"\001ABC"`), output);
  });

  it('preserves the cast location and trivia on the decoded literal', () => {
    const input = parse("void f() { g((char[4])L'\\x20736831'); }");
    const cast = findNode<CStyleCastExpr>(input, NodeKind.CStyleCastExpr);
    assert.ok(cast);
    const trivia = { kind: TriviaKind.BlockComment, text: '/*fourcc*/', location: cast.location };
    cast.leadingTrivia = [trivia];
    cast.trailingTrivia = [trivia];
    const transformed = transformer(input) as AnyNode;
    const literal = findNode<StringLiteralExpr>(transformed, NodeKind.StringLiteral);
    assert.ok(literal);
    assert.deepStrictEqual(literal.location, cast.location);
    assert.deepStrictEqual(literal.leadingTrivia, [trivia]);
    assert.deepStrictEqual(literal.trailingTrivia, [trivia]);
  });
});

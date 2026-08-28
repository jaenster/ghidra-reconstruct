import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { charLiteralEscapePlugin } from '../builtins/char-literal-escape.js';

describe('charLiteralEscapePlugin', () => {
  function transformCode(code: string): string {
    const ast = parse(code);
    const transformer = charLiteralEscapePlugin.createTransformer({});
    return emit(transformer(ast) as AnyNode);
  }

  it("re-spells a non-ASCII char literal as its hex escape", () => {
    const out = transformCode("void f() { char c = '\u00b2'; }");
    assert.ok(out.includes("'\\xb2'"), out);
    assert.ok(!out.includes('\u00b2'), out);
  });

  it('leaves an ASCII char literal alone', () => {
    const out = transformCode("void f() { char c = 'A'; }");
    assert.ok(out.includes("'A'"), out);
  });

  it('does not touch a non-ASCII character inside a string literal', () => {
    // `code.replace(/'([^'\\])'/g, ...)` matched any two quotes one character
    // apart, so it fired on the quoted char in the MIDDLE of this string.
    const out = transformCode("void f() { Log(\"level '\u00b2' failed\"); }");
    assert.ok(out.includes("\"level '\u00b2' failed\""), out);
  });
});

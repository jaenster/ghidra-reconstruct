import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../parser/index.js';
import { emit } from '../index.js';
import type { CallExpr, ExprStmt, FunctionDecl, StringLiteralExpr } from '../../ast/nodes.js';

function roundTripLiteral(raw: string): { emitted: string; value: string } {
  const emitted = emit(parse(`void f() { G(${raw}); }`));
  const reparsed = parse(emitted);
  const call = ((reparsed.declarations[0] as FunctionDecl).body!.statements[0] as ExprStmt)
    .expression as CallExpr;
  return { emitted, value: (call.arguments[0] as StringLiteralExpr).value };
}

describe('parsed C++ string trigraphs', () => {
  it('escapes all nine non-raw trigraph spellings without changing their values', () => {
    for (const suffix of ['=', '/', "'", '(', ')', '!', '<', '>', '-']) {
      const value = `??${suffix}`;
      const { emitted, value: reparsedValue } = roundTripLiteral(`"${value}"`);
      assert.ok(emitted.includes(`G("\\?\\?${suffix}")`), emitted);
      assert.strictEqual(reparsedValue, value, emitted);
    }
  });

  it('preserves existing question-mark escapes and backslash parity', () => {
    for (const [raw, value] of [
      [String.raw`"\?"`, '?'],
      [String.raw`"\\?"`, '\\?'],
      [String.raw`"\??="`, '??='],
      [String.raw`L"??="`, '??='],
    ]) {
      const { emitted, value: reparsedValue } = roundTripLiteral(raw);
      assert.strictEqual(reparsedValue, value, emitted);
      assert.ok(!emitted.includes('??='), emitted);
      assert.strictEqual(emit(parse(emitted)), emitted);
    }
  });

  it('leaves raw string literals untouched', () => {
    const raw = String.raw`R"(??=)"`;
    const { emitted, value } = roundTripLiteral(raw);
    assert.ok(emitted.includes(raw), emitted);
    assert.strictEqual(value, '??=');
  });
});

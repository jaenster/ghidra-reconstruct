import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emit } from '../index.js';
import { Expr } from '../../ast/factory.js';
import { NodeKind } from '../../ast/kinds.js';
import { parse } from '../../parser/index.js';
import type { BinaryExpr, BinaryOperator, CommaExpr, Expression, FunctionDecl, ParenExpr, ReturnStmt } from '../../ast/nodes.js';

const a = Expr.identifier('a');
const b = Expr.identifier('b');
const c = Expr.identifier('c');

function comma(...expressions: Expression[]): CommaExpr {
  return { kind: NodeKind.CommaExpr, expressions, location: a.location, leadingTrivia: [], trailingTrivia: [] };
}

function returned(source: string): Expression {
  const fn = parse(`int f() { return ${source}; }`).declarations[0] as FunctionDecl;
  return (fn.body!.statements[0] as ReturnStmt).value!;
}

function expectRightNested(source: string): void {
  const outer = returned(source) as BinaryExpr;
  assert.strictEqual(outer.kind, NodeKind.BinaryExpr, source);
  assert.strictEqual(outer.operator as string, ',', source);
  assert.strictEqual(outer.left.kind, NodeKind.Identifier, source);
  assert.strictEqual(outer.right.kind, NodeKind.ParenExpr, source);
  let inner: Expression = outer.right;
  while (inner.kind === NodeKind.ParenExpr) inner = (inner as ParenExpr).expression;
  assert.strictEqual(inner.kind, NodeKind.BinaryExpr, source);
  assert.strictEqual((inner as BinaryExpr).operator as string, ',', source);
}

describe('nested factory comma expressions', () => {
  it('keeps a right-nested CommaExpr grouped', () => {
    const out = emit(comma(a, comma(b, c)));
    assert.strictEqual(out, 'a, (b, c)');
    expectRightNested(out);
    const compact = emit(comma(a, comma(b, c)), { spaceAfterComma: false, spaceAroundOperators: false });
    assert.strictEqual(compact, 'a,(b,c)');
    expectRightNested(compact);
  });

  it('keeps a right-nested BinaryExpr comma grouped', () => {
    const out = emit(comma(a, Expr.binary(b, ',' as BinaryOperator, c)));
    assert.strictEqual(out, 'a, (b , c)');
    expectRightNested(out);
  });

  it('leaves left-nested comma expressions left-associative', () => {
    const out = emit(comma(comma(a, b), c));
    assert.strictEqual(out, 'a, b, c');
    const parsed = returned(out) as BinaryExpr;
    assert.strictEqual(parsed.kind, NodeKind.BinaryExpr);
    assert.strictEqual(parsed.left.kind, NodeKind.BinaryExpr);
  });

  it('does not double-wrap an explicit right ParenExpr', () => {
    const out = emit(comma(a, Expr.paren(comma(b, c))));
    assert.strictEqual(out, 'a, (b, c)');
    expectRightNested(out);
  });

  it('keeps a right ParenExpr around a parser-shaped comma operator', () => {
    const out = emit(comma(a, Expr.paren(Expr.binary(b, ',' as BinaryOperator, c))));
    expectRightNested(out);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createTransformer,
  createKindTransformer,
  transform,
  transformWithTracking,
  cloneNode,
  updateNode,
  nodesEqual,
  replaceNode,
  identity,
  sequence,
  when,
  firstMatch,
  fixpoint,
} from '../transformer.js';
import { NodeKind } from '../../ast/kinds.js';
import { AST, Type, Expr, Stmt, Decl } from '../../ast/factory.js';
import { TriviaKind } from '../../lexer/trivia.js';
import type { Identifier, BinaryExpr, IntegerLiteralExpr } from '../../ast/nodes.js';

describe('Transformer', () => {
  describe('createTransformer', () => {
    it('creates a transformer from a visitor', () => {
      const upper = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      });

      const id = Expr.identifier('hello');
      const result = upper(id) as Identifier;

      assert.strictEqual(result.name, 'HELLO');
    });

    it('preserves nodes when visitor returns undefined', () => {
      const noop = createTransformer({
        visitIdentifier() {
          return undefined;
        },
      });

      const id = Expr.identifier('hello');
      const result = noop(id);

      assert.strictEqual((result as Identifier).name, 'hello');
    });

    it('transforms nested expressions', () => {
      const double = createTransformer({
        visitNode(node) {
          if (node.kind === NodeKind.IntegerLiteral) {
            const lit = node as IntegerLiteralExpr;
            return { ...lit, value: lit.value * 2n };
          }
          return undefined;
        },
      });

      const expr = Expr.add(Expr.intLiteral(2), Expr.intLiteral(3));
      const result = double(expr) as BinaryExpr;

      assert.strictEqual((result.left as IntegerLiteralExpr).value, 4n);
      assert.strictEqual((result.right as IntegerLiteralExpr).value, 6n);
    });
  });

  describe('createKindTransformer', () => {
    it('only transforms specified node kinds', () => {
      const transformer = createKindTransformer(NodeKind.Identifier, (node) => {
        const id = node as Identifier;
        return { ...id, name: id.name + '_suffix' };
      });

      const expr = Expr.add(Expr.identifier('a'), Expr.intLiteral(1));
      const result = transformer(expr) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'a_suffix');
      assert.strictEqual((result.right as IntegerLiteralExpr).value, 1n);
    });

    it('accepts array of kinds', () => {
      const transformer = createKindTransformer(
        [NodeKind.Identifier, NodeKind.IntegerLiteral],
        (node) => {
          if (node.kind === NodeKind.Identifier) {
            return { ...(node as Identifier), name: 'replaced' };
          }
          return { ...(node as IntegerLiteralExpr), value: 999n };
        }
      );

      const expr = Expr.add(Expr.identifier('a'), Expr.intLiteral(1));
      const result = transformer(expr) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'replaced');
      assert.strictEqual((result.right as IntegerLiteralExpr).value, 999n);
    });
  });

  describe('transformWithTracking', () => {
    it('tracks the number of changes', () => {
      const transformer = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      });

      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      const result = transformWithTracking(expr, transformer);

      assert.ok(result.changesCount >= 2);
      const resultExpr = result.ast as BinaryExpr;
      assert.strictEqual((resultExpr.left as Identifier).name, 'A');
      assert.strictEqual((resultExpr.right as Identifier).name, 'B');
    });

    it('returns zero changes when nothing modified', () => {
      const result = transformWithTracking(
        Expr.intLiteral(42),
        identity
      );

      assert.strictEqual(result.changesCount, 0);
    });
  });

  describe('cloneNode', () => {
    it('deep clones a simple node', () => {
      const original = Expr.identifier('test');
      const cloned = cloneNode(original);

      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned, original);
    });

    it('deep clones nested nodes', () => {
      const original = Expr.add(
        Expr.identifier('a'),
        Expr.mul(Expr.identifier('b'), Expr.intLiteral(2))
      );
      const cloned = cloneNode(original);

      assert.deepStrictEqual(cloned, original);
      assert.notStrictEqual(cloned, original);
      assert.notStrictEqual((cloned as BinaryExpr).left, (original as BinaryExpr).left);
    });

    it('clones arrays', () => {
      const fn = Decl.function_('test', Type.int(), [
        Decl.parameter('a', Type.int()),
        Decl.parameter('b', Type.int()),
      ], null);

      const cloned = cloneNode(fn);

      assert.strictEqual(cloned.parameters.length, 2);
      assert.notStrictEqual(cloned.parameters, fn.parameters);
    });
  });

  describe('updateNode', () => {
    it('updates specified properties', () => {
      const original = Expr.identifier('old');
      const updated = updateNode(original, { name: 'new' });

      assert.strictEqual(updated.name, 'new');
      assert.strictEqual(original.name, 'old'); // Original unchanged
    });

    it('preserves trivia', () => {
      const original = Expr.identifier('test');
      original.leadingTrivia = [{ kind: TriviaKind.Whitespace, text: '  ', location: original.location }];

      const updated = updateNode(original, { name: 'updated' });

      assert.deepStrictEqual(updated.leadingTrivia, original.leadingTrivia);
    });

    it('allows overwriting trivia', () => {
      const original = Expr.identifier('test');
      original.leadingTrivia = [{ kind: TriviaKind.Whitespace, text: '  ', location: original.location }];

      const updated = updateNode(original, {
        name: 'updated',
        leadingTrivia: [],
      });

      assert.deepStrictEqual(updated.leadingTrivia, []);
    });
  });

  describe('nodesEqual', () => {
    it('returns true for identical identifiers', () => {
      const a = Expr.identifier('test');
      const b = Expr.identifier('test');

      assert.ok(nodesEqual(a, b));
    });

    it('returns false for different identifiers', () => {
      const a = Expr.identifier('foo');
      const b = Expr.identifier('bar');

      assert.ok(!nodesEqual(a, b));
    });

    it('compares nested expressions', () => {
      const a = Expr.add(Expr.identifier('x'), Expr.intLiteral(1));
      const b = Expr.add(Expr.identifier('x'), Expr.intLiteral(1));
      const c = Expr.add(Expr.identifier('x'), Expr.intLiteral(2));

      assert.ok(nodesEqual(a, b));
      assert.ok(!nodesEqual(a, c));
    });

    it('returns false for different node kinds', () => {
      const a = Expr.identifier('x');
      const b = Expr.intLiteral(1);

      assert.ok(!nodesEqual(a, b));
    });
  });

  describe('replaceNode', () => {
    it('replaces matching nodes', () => {
      const expr = Expr.add(Expr.identifier('x'), Expr.identifier('x'));
      const result = replaceNode(
        expr,
        Expr.identifier('x'),
        Expr.identifier('y')
      ) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'y');
      assert.strictEqual((result.right as Identifier).name, 'y');
    });

    it('does not affect non-matching nodes', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      const result = replaceNode(
        expr,
        Expr.identifier('x'),
        Expr.identifier('y')
      ) as BinaryExpr;

      assert.strictEqual((result.left as Identifier).name, 'a');
      assert.strictEqual((result.right as Identifier).name, 'b');
    });
  });

  describe('identity', () => {
    it('returns the input unchanged', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.intLiteral(1));
      const result = identity(expr);

      assert.strictEqual(result, expr);
    });
  });

  describe('sequence', () => {
    it('applies transformers in order', () => {
      const addPrefix = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: 'prefix_' + node.name };
        },
      });

      const addSuffix = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name + '_suffix' };
        },
      });

      const combined = sequence(addPrefix, addSuffix);
      const result = combined(Expr.identifier('test')) as Identifier;

      assert.strictEqual(result.name, 'prefix_test_suffix');
    });

    it('handles empty sequence', () => {
      const empty = sequence();
      const expr = Expr.identifier('test');
      const result = empty(expr);

      assert.strictEqual(result, expr);
    });
  });

  describe('when', () => {
    it('applies transformer when condition is true', () => {
      const upper = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      });

      const conditionalUpper = when(
        (node) => node.kind === NodeKind.Identifier,
        upper
      );

      const result = conditionalUpper(Expr.identifier('test')) as Identifier;
      assert.strictEqual(result.name, 'TEST');
    });

    it('skips transformer when condition is false', () => {
      const upper = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      });

      const conditionalUpper = when(
        () => false,
        upper
      );

      const result = conditionalUpper(Expr.identifier('test')) as Identifier;
      assert.strictEqual(result.name, 'test');
    });
  });

  describe('firstMatch', () => {
    it('applies first transformer that changes the node', () => {
      const noop = identity;
      const upper = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      });
      const lower = createTransformer({
        visitIdentifier(node) {
          return { ...node, name: node.name.toLowerCase() };
        },
      });

      const combined = firstMatch(noop, upper, lower);
      const result = combined(Expr.identifier('Test')) as Identifier;

      assert.strictEqual(result.name, 'TEST'); // upper applied, not lower
    });

    it('returns original if no transformer matches', () => {
      const combined = firstMatch(identity, identity);
      const expr = Expr.identifier('test');
      const result = combined(expr);

      assert.strictEqual(result, expr);
    });
  });

  describe('fixpoint', () => {
    it('applies transformer until no changes', () => {
      // Count how many times we recurse
      let iterations = 0;

      const decrement = createKindTransformer(NodeKind.IntegerLiteral, (node) => {
        const lit = node as IntegerLiteralExpr;
        iterations++;
        if (lit.value > 0n) {
          return { ...lit, value: lit.value - 1n };
        }
        return node;
      });

      const fp = fixpoint(decrement);
      const result = fp(Expr.intLiteral(5)) as IntegerLiteralExpr;

      assert.strictEqual(result.value, 0n);
      assert.ok(iterations >= 5);
    });

    it('respects max iterations', () => {
      let iterations = 0;

      const always = createKindTransformer(NodeKind.IntegerLiteral, (node) => {
        iterations++;
        const lit = node as IntegerLiteralExpr;
        return { ...lit, value: lit.value + 1n };
      });

      const fp = fixpoint(always, 5);
      fp(Expr.intLiteral(0));

      assert.ok(iterations <= 6); // Max 5 iterations + potential initial
    });
  });
});

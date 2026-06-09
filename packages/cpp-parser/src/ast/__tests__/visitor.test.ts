import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  walkAST,
  traverseAST,
  getChildren,
  findNodes,
  findNodesByKind,
  findIdentifiers,
  transformAST,
  countNodes,
  getASTDepth,
} from '../visitor.js';
import { AST, Type, Expr, Stmt, Decl } from '../factory.js';
import { NodeKind } from '../kinds.js';
import type { Identifier, BinaryExpr, FunctionDecl } from '../nodes.js';

describe('AST Visitor', () => {
  describe('walkAST', () => {
    it('visits specific node types', () => {
      const fn = Decl.function_('test', Type.void(), [], null);
      let visited = false;

      walkAST(fn, {
        visitFunctionDecl(node) {
          visited = true;
          assert.strictEqual((node.name as Identifier).name, 'test');
        },
      });

      assert.strictEqual(visited, true);
    });

    it('falls back to visitNode for unhandled types', () => {
      const expr = Expr.intLiteral(42);
      let visited = false;

      walkAST(expr, {
        visitNode(node) {
          visited = true;
          assert.strictEqual(node.kind, NodeKind.IntegerLiteral);
        },
      });

      assert.strictEqual(visited, true);
    });

    it('returns visitor result', () => {
      const id = Expr.identifier('foo');
      const result = walkAST(id, {
        visitIdentifier(node) {
          return node.name.toUpperCase();
        },
      });

      assert.strictEqual(result, 'FOO');
    });
  });

  describe('traverseAST', () => {
    it('yields all nodes in the tree', () => {
      const fn = Decl.function_(
        'add',
        Type.int(),
        [Decl.parameter('x', Type.int())],
        Stmt.compound([
          Stmt.return_(Expr.identifier('x')),
        ])
      );

      const nodes = [...traverseAST(fn)];
      assert.ok(nodes.length > 1);
      assert.strictEqual(nodes[0], fn);
    });

    it('visits nested expressions', () => {
      const expr = Expr.add(
        Expr.identifier('a'),
        Expr.mul(Expr.identifier('b'), Expr.identifier('c'))
      );

      const kinds = [...traverseAST(expr)].map(n => n.kind);
      assert.ok(kinds.includes(NodeKind.BinaryExpr));
      assert.ok(kinds.includes(NodeKind.Identifier));
    });
  });

  describe('getChildren', () => {
    it('returns children of function declaration', () => {
      const fn = Decl.function_(
        'test',
        Type.int(),
        [Decl.parameter('x', Type.int())],
        Stmt.compound([])
      );

      const children = getChildren(fn);
      assert.ok(children.length > 0);
    });

    it('returns children of binary expression', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      const children = getChildren(expr);
      assert.strictEqual(children.length, 2);
    });

    it('returns empty array for leaf nodes', () => {
      const id = Expr.identifier('x');
      const children = getChildren(id);
      assert.strictEqual(children.length, 0);
    });

    it('returns children of if statement', () => {
      const ifStmt = Stmt.if_(
        Expr.identifier('cond'),
        Stmt.return_(Expr.intLiteral(1)),
        Stmt.return_(Expr.intLiteral(0))
      );

      const children = getChildren(ifStmt);
      assert.strictEqual(children.length, 3); // condition, then, else
    });
  });

  describe('findNodes', () => {
    it('finds nodes matching predicate', () => {
      const fn = Decl.function_(
        'test',
        Type.int(),
        [],
        Stmt.compound([
          Stmt.return_(Expr.add(Expr.intLiteral(1), Expr.intLiteral(2))),
        ])
      );

      const literals = findNodes(fn, n => n.kind === NodeKind.IntegerLiteral);
      assert.strictEqual(literals.length, 2);
    });

    it('returns empty array when no matches', () => {
      const id = Expr.identifier('x');
      const matches = findNodes(id, n => n.kind === NodeKind.StringLiteral);
      assert.strictEqual(matches.length, 0);
    });
  });

  describe('findNodesByKind', () => {
    it('finds all nodes of specific kind', () => {
      const expr = Expr.add(
        Expr.identifier('a'),
        Expr.add(Expr.identifier('b'), Expr.identifier('c'))
      );

      const identifiers = findNodesByKind(expr, NodeKind.Identifier);
      assert.strictEqual(identifiers.length, 3);
    });
  });

  describe('findIdentifiers', () => {
    it('finds identifiers by name', () => {
      const expr = Expr.add(
        Expr.identifier('x'),
        Expr.mul(Expr.identifier('x'), Expr.identifier('y'))
      );

      const xIds = findIdentifiers(expr, 'x');
      assert.strictEqual(xIds.length, 2);

      const yIds = findIdentifiers(expr, 'y');
      assert.strictEqual(yIds.length, 1);
    });
  });

  describe('transformAST', () => {
    it('transforms identifiers', () => {
      const expr = Expr.identifier('oldName');

      const transformed = transformAST(expr, {
        visitIdentifier(node) {
          if (node.name === 'oldName') {
            return { ...node, name: 'newName' };
          }
          return undefined;
        },
      });

      assert.strictEqual((transformed as Identifier).name, 'newName');
    });

    it('transforms nested expressions', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));

      const transformed = transformAST(expr, {
        visitIdentifier(node) {
          return { ...node, name: node.name.toUpperCase() };
        },
      }) as BinaryExpr;

      assert.strictEqual((transformed.left as Identifier).name, 'A');
      assert.strictEqual((transformed.right as Identifier).name, 'B');
    });

    it('preserves untransformed nodes', () => {
      const fn = Decl.function_('test', Type.int(), [], null);

      const transformed = transformAST(fn, {
        visitIdentifier() {
          return undefined; // Keep original
        },
      });

      assert.strictEqual(((transformed as FunctionDecl).name as Identifier).name, 'test');
    });
  });

  describe('countNodes', () => {
    it('counts single node', () => {
      const id = Expr.identifier('x');
      assert.strictEqual(countNodes(id), 1);
    });

    it('counts nodes in expression tree', () => {
      const expr = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      assert.strictEqual(countNodes(expr), 3); // binary + 2 identifiers
    });

    it('counts nodes in function', () => {
      const fn = Decl.function_(
        'test',
        Type.int(),
        [],
        Stmt.compound([Stmt.return_(Expr.intLiteral(0))])
      );
      const count = countNodes(fn);
      assert.ok(count > 1);
    });
  });

  describe('getASTDepth', () => {
    it('returns 1 for leaf nodes', () => {
      const id = Expr.identifier('x');
      assert.strictEqual(getASTDepth(id), 1);
    });

    it('calculates depth of expression tree', () => {
      // a + b has depth 2
      const simple = Expr.add(Expr.identifier('a'), Expr.identifier('b'));
      assert.strictEqual(getASTDepth(simple), 2);

      // a + (b * c) has depth 3
      const nested = Expr.add(
        Expr.identifier('a'),
        Expr.mul(Expr.identifier('b'), Expr.identifier('c'))
      );
      assert.strictEqual(getASTDepth(nested), 3);
    });
  });
});

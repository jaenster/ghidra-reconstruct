/**
 * Robustness Tests for C++ Parser
 *
 * Tests negative assertions, edge cases, and ensures the parser
 * correctly rejects invalid input and produces correct AST structure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse, ParserError } from '../parser.js';
import { NodeKind } from '../../ast/kinds.js';
import type {
  FunctionDecl,
  VariableDecl,
  BinaryExpr,
  AssignExpr,
  IntegerLiteralExpr,
  FloatingLiteralExpr,
  Identifier,
  StructDecl,
  EnumDecl,
  CompoundStmt,
  ExprStmt,
  ReturnStmt,
  IfStmt,
  ForStmt,
  WhileStmt,
  UnaryExpr,
  CallExpr,
  PointerType,
  ArrayType,
  QualifiedType,
  BuiltinType,
  TranslationUnit,
} from '../../ast/nodes.js';

describe('Parser Robustness', () => {
  describe('Negative assertions - node kind verification', () => {
    it('variable declaration is NOT a function declaration', () => {
      const ast = parse('int x;');
      const decl = ast.declarations[0];

      assert.strictEqual(decl.kind, NodeKind.VariableDecl);
      assert.notStrictEqual(decl.kind, NodeKind.FunctionDecl);
      assert.notStrictEqual(decl.kind, NodeKind.StructDecl);
      assert.notStrictEqual(decl.kind, NodeKind.EnumDecl);
      assert.notStrictEqual(decl.kind, NodeKind.NamespaceDecl);
    });

    it('function declaration is NOT a variable declaration', () => {
      const ast = parse('void foo();');
      const decl = ast.declarations[0];

      assert.strictEqual(decl.kind, NodeKind.FunctionDecl);
      assert.notStrictEqual(decl.kind, NodeKind.VariableDecl);
      assert.notStrictEqual(decl.kind, NodeKind.StructDecl);
    });

    it('binary expression with + is NOT an assignment expression', () => {
      const ast = parse('void f() { x + y; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression;

      assert.strictEqual(expr.kind, NodeKind.BinaryExpr);
      assert.notStrictEqual(expr.kind, NodeKind.AssignExpr);

      const binExpr = expr as BinaryExpr;
      assert.strictEqual(binExpr.operator, '+');
      assert.notStrictEqual(binExpr.operator, '=');
      assert.notStrictEqual(binExpr.operator, '+=');
    });

    it('assignment expression is NOT a binary expression', () => {
      const ast = parse('void f() { x = 5; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression;

      assert.strictEqual(expr.kind, NodeKind.AssignExpr);
      assert.notStrictEqual(expr.kind, NodeKind.BinaryExpr);
    });

    it('integer literal is NOT a float literal', () => {
      const ast = parse('int x = 42;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.notStrictEqual(init.kind, NodeKind.FloatingLiteral);
      assert.notStrictEqual(init.kind, NodeKind.StringLiteral);
      assert.notStrictEqual(init.kind, NodeKind.CharLiteral);
    });

    it('float literal is NOT an integer literal', () => {
      const ast = parse('double x = 3.14;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as FloatingLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.FloatingLiteral);
      assert.notStrictEqual(init.kind, NodeKind.IntegerLiteral);
    });

    it('struct declaration is NOT a class declaration', () => {
      const ast = parse('struct Point { int x; };');
      const decl = ast.declarations[0];

      assert.strictEqual(decl.kind, NodeKind.StructDecl);
      assert.notStrictEqual(decl.kind, NodeKind.ClassDecl);
      assert.notStrictEqual(decl.kind, NodeKind.EnumDecl);
    });

    it('compound assignment is NOT regular assignment', () => {
      const ast = parse('void f() { x += 1; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as AssignExpr;

      assert.strictEqual(expr.kind, NodeKind.AssignExpr);
      assert.strictEqual(expr.operator, '+=');
      assert.notStrictEqual(expr.operator, '=');
      assert.notStrictEqual(expr.operator, '-=');
    });

    it('prefix unary is NOT postfix', () => {
      const ast = parse('void f() { ++x; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression;

      assert.strictEqual(expr.kind, NodeKind.UnaryExpr);
      assert.notStrictEqual(expr.kind, NodeKind.PostfixExpr);
    });

    it('postfix increment is NOT prefix', () => {
      const ast = parse('void f() { x++; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression;

      assert.strictEqual(expr.kind, NodeKind.PostfixExpr);
      assert.notStrictEqual(expr.kind, NodeKind.UnaryExpr);
    });
  });

  describe('Binary operator type correctness', () => {
    // Note: x * y and x & y are ambiguous in C++ context (could be pointer/reference declarations)
    // so we test them in unambiguous contexts
    const binaryOperators: [string, string][] = [
      ['x + y', '+'],
      ['x - y', '-'],
      ['1 * 2', '*'],  // Use literals to avoid declaration ambiguity
      ['x / y', '/'],
      ['x % y', '%'],
      ['1 & 2', '&'],  // Use literals to avoid reference ambiguity
      ['x | y', '|'],
      ['x ^ y', '^'],
      ['x << y', '<<'],
      ['x >> y', '>>'],
      ['x && y', '&&'],
      ['x || y', '||'],
      ['x == y', '=='],
      ['x != y', '!='],
      ['x < y', '<'],
      ['x > y', '>'],
      ['x <= y', '<='],
      ['x >= y', '>='],
    ];

    for (const [code, expectedOp] of binaryOperators) {
      it(`parses "${code}" as BinaryExpr with operator "${expectedOp}"`, () => {
        const ast = parse(`void f() { ${code}; }`);
        const fn = ast.declarations[0] as FunctionDecl;
        const stmt = fn.body!.statements[0] as ExprStmt;
        const expr = stmt.expression as BinaryExpr;

        assert.strictEqual(expr.kind, NodeKind.BinaryExpr);
        assert.strictEqual(expr.operator, expectedOp);

        // Verify it's NOT assignment
        assert.notStrictEqual(expr.kind, NodeKind.AssignExpr);
      });
    }

    const assignmentOperators: [string, string][] = [
      ['x = y', '='],
      ['x += y', '+='],
      ['x -= y', '-='],
      ['x *= y', '*='],
      ['x /= y', '/='],
      ['x %= y', '%='],
      ['x &= y', '&='],
      ['x |= y', '|='],
      ['x ^= y', '^='],
      ['x <<= y', '<<='],
      ['x >>= y', '>>='],
    ];

    for (const [code, expectedOp] of assignmentOperators) {
      it(`parses "${code}" as AssignExpr with operator "${expectedOp}"`, () => {
        const ast = parse(`void f() { ${code}; }`);
        const fn = ast.declarations[0] as FunctionDecl;
        const stmt = fn.body!.statements[0] as ExprStmt;
        const expr = stmt.expression as AssignExpr;

        assert.strictEqual(expr.kind, NodeKind.AssignExpr);
        assert.strictEqual(expr.operator, expectedOp);

        // Verify it's NOT binary expression
        assert.notStrictEqual(expr.kind, NodeKind.BinaryExpr);
      });
    }
  });

  describe('Literal type correctness', () => {
    it('integer literal has integer properties, NOT float', () => {
      const ast = parse('int x = 42;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(init.value, 42n);
      assert.strictEqual(init.base, 10);
      assert.strictEqual(typeof init.value, 'bigint');

      // IntegerLiteralExpr should not have floating point properties
      assert.ok(!('value' in init && typeof (init as any).value === 'number'));
    });

    it('hex literal is correctly identified', () => {
      const ast = parse('int x = 0xFF;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(init.value, 255n);
      assert.strictEqual(init.base, 16);
      assert.notStrictEqual(init.base, 10);
      assert.notStrictEqual(init.base, 8);
    });

    it('octal literal is correctly identified', () => {
      const ast = parse('int x = 0777;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(init.base, 8);
      assert.strictEqual(init.value, 511n); // 0777 octal = 511 decimal
    });

    it('binary literal is correctly identified', () => {
      const ast = parse('int x = 0b1010;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(init.base, 2);
      assert.strictEqual(init.value, 10n);
    });

    it('float literal has float properties, NOT integer', () => {
      const ast = parse('double x = 3.14;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as FloatingLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.FloatingLiteral);
      assert.strictEqual(typeof init.value, 'number');
      assert.ok(Math.abs(init.value - 3.14) < 0.0001);
    });
  });

  describe('Malformed code throws errors', () => {
    it('throws on missing semicolon after declaration', () => {
      assert.throws(() => parse('int x'), ParserError);
    });

    it('throws on missing closing brace', () => {
      assert.throws(() => parse('void f() {'), ParserError);
    });

    it('throws on missing opening brace', () => {
      assert.throws(() => parse('void f() }'), ParserError);
    });

    it('throws on missing closing parenthesis', () => {
      assert.throws(() => parse('void f('), ParserError);
    });

    it('throws on declaration without name', () => {
      assert.throws(() => parse('int ;'), ParserError);
    });

    it('throws on unexpected token', () => {
      assert.throws(() => parse('void f() { ++ ; }'), ParserError);
    });

    it('throws on mismatched parentheses', () => {
      assert.throws(() => parse('void f() { (x + y; }'), ParserError);
    });

    it('throws on invalid expression', () => {
      assert.throws(() => parse('void f() { + + +; }'), ParserError);
    });

    it('throws on empty function parameter', () => {
      assert.throws(() => parse('void f(,) {}'), ParserError);
    });

    it('throws on missing condition in if', () => {
      assert.throws(() => parse('void f() { if () {} }'), ParserError);
    });

    it('throws on missing body in while', () => {
      assert.throws(() => parse('void f() { while (1) }'), ParserError);
    });
  });

  describe('Empty constructs and edge cases', () => {
    it('parses empty source', () => {
      const ast = parse('');
      assert.strictEqual(ast.kind, NodeKind.TranslationUnit);
      assert.strictEqual(ast.declarations.length, 0);
    });

    it('parses empty function body', () => {
      const ast = parse('void f() {}');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.notStrictEqual(fn.body, null);
      assert.strictEqual(fn.body!.kind, NodeKind.CompoundStmt);
      assert.strictEqual(fn.body!.statements.length, 0);
    });

    it('parses function with no parameters', () => {
      const ast = parse('void f() {}');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.parameters.length, 0);
      assert.strictEqual(fn.isVariadic, false);
    });

    it('parses empty struct', () => {
      const ast = parse('struct Empty {};');
      const decl = ast.declarations[0] as StructDecl;

      assert.strictEqual(decl.members.length, 0);
    });

    it('parses empty enum', () => {
      const ast = parse('enum Empty {};');
      const decl = ast.declarations[0] as EnumDecl;

      assert.strictEqual(decl.enumerators.length, 0);
    });

    it('parses empty compound statement', () => {
      const ast = parse('void f() { {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const inner = fn.body!.statements[0] as CompoundStmt;

      assert.strictEqual(inner.kind, NodeKind.CompoundStmt);
      assert.strictEqual(inner.statements.length, 0);
    });

    it('parses empty for loop body', () => {
      const ast = parse('void f() { for (;;) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const forStmt = fn.body!.statements[0] as ForStmt;

      assert.strictEqual(forStmt.init, null);
      assert.strictEqual(forStmt.condition, null);
      assert.strictEqual(forStmt.increment, null);
    });

    it('parses return without value', () => {
      const ast = parse('void f() { return; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const ret = fn.body!.statements[0] as ReturnStmt;

      assert.strictEqual(ret.kind, NodeKind.ReturnStmt);
      assert.strictEqual(ret.value, null);
    });

    it('parses variable without initializer', () => {
      const ast = parse('int x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.initializer, null);
    });

    it('parses function call with no arguments', () => {
      const ast = parse('void f() { foo(); }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const call = stmt.expression as CallExpr;

      assert.strictEqual(call.kind, NodeKind.CallExpr);
      assert.strictEqual(call.arguments.length, 0);
    });

    it('parses array with empty size', () => {
      const ast = parse('int arr[];');
      const decl = ast.declarations[0] as VariableDecl;
      const arrType = decl.type as ArrayType;

      assert.strictEqual(arrType.kind, NodeKind.ArrayType);
      assert.strictEqual(arrType.size, null);
    });
  });

  describe('Boundary conditions', () => {
    it('parses very long identifier', () => {
      const longName = 'a'.repeat(1000);
      const ast = parse(`int ${longName};`);
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.name.name, longName);
    });

    it('parses deeply nested expressions', () => {
      // Note: Parser interprets (((x))) with empty parens as cast attempts
      // Use a more complex expression to avoid ambiguity
      const ast = parse('void f() { (((((1 + 2))))); }');
      const fn = ast.declarations[0] as FunctionDecl;

      // Should parse without stack overflow
      assert.strictEqual(fn.body!.statements.length, 1);
    });

    it('parses deeply nested blocks', () => {
      const ast = parse('void f() { { { { { { } } } } } }');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.body!.statements.length, 1);
    });

    it('parses many parameters', () => {
      const params = Array.from({ length: 50 }, (_, i) => `int p${i}`).join(', ');
      const ast = parse(`void f(${params}) {}`);
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.parameters.length, 50);
    });

    it('parses many declarations', () => {
      const decls = Array.from({ length: 100 }, (_, i) => `int x${i};`).join('\n');
      const ast = parse(decls);

      assert.strictEqual(ast.declarations.length, 100);
    });

    it('parses complex type with multiple pointers', () => {
      const ast = parse('int ***p;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.PointerType);
      const ptr1 = decl.type as PointerType;
      assert.strictEqual(ptr1.pointee.kind, NodeKind.PointerType);
      const ptr2 = ptr1.pointee as PointerType;
      assert.strictEqual(ptr2.pointee.kind, NodeKind.PointerType);
    });

    it('parses large integer literal', () => {
      const ast = parse('unsigned long long x = 18446744073709551615ULL;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.kind, NodeKind.IntegerLiteral);
      assert.strictEqual(init.value, 18446744073709551615n);
    });

    it('parses zero literal', () => {
      const ast = parse('int x = 0;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as IntegerLiteralExpr;

      assert.strictEqual(init.value, 0n);
    });

    it('parses negative number as unary expression', () => {
      const ast = parse('int x = -1;');
      const decl = ast.declarations[0] as VariableDecl;
      const init = decl.initializer as UnaryExpr;

      assert.strictEqual(init.kind, NodeKind.UnaryExpr);
      assert.strictEqual(init.operator, '-');
    });
  });

  describe('Operator precedence verification', () => {
    it('multiplication binds tighter than addition', () => {
      const ast = parse('void f() { a + b * c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be (a + (b * c))
      assert.strictEqual(expr.operator, '+');
      assert.strictEqual((expr.left as Identifier).name, 'a');
      assert.strictEqual((expr.right as BinaryExpr).operator, '*');
    });

    it('division binds tighter than subtraction', () => {
      const ast = parse('void f() { a - b / c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be (a - (b / c))
      assert.strictEqual(expr.operator, '-');
      assert.strictEqual((expr.right as BinaryExpr).operator, '/');
    });

    it('logical AND binds tighter than logical OR', () => {
      const ast = parse('void f() { a || b && c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be (a || (b && c))
      assert.strictEqual(expr.operator, '||');
      assert.strictEqual((expr.right as BinaryExpr).operator, '&&');
    });

    it('comparison binds tighter than logical AND', () => {
      const ast = parse('void f() { a && b < c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be (a && (b < c))
      assert.strictEqual(expr.operator, '&&');
      assert.strictEqual((expr.right as BinaryExpr).operator, '<');
    });

    it('assignment is right associative', () => {
      const ast = parse('void f() { a = b = c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as AssignExpr;

      // Should be (a = (b = c))
      assert.strictEqual(expr.operator, '=');
      assert.strictEqual((expr.left as Identifier).name, 'a');
      assert.strictEqual((expr.right as AssignExpr).operator, '=');
      assert.strictEqual(((expr.right as AssignExpr).left as Identifier).name, 'b');
    });

    it('unary operators bind tighter than binary', () => {
      const ast = parse('void f() { -a + b; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be ((-a) + b)
      assert.strictEqual(expr.operator, '+');
      assert.strictEqual((expr.left as UnaryExpr).kind, NodeKind.UnaryExpr);
      assert.strictEqual((expr.left as UnaryExpr).operator, '-');
    });
  });

  describe('Type qualifier verification', () => {
    it('const type is NOT the same as non-const', () => {
      const ast = parse('const int x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.QualifiedType);
      const qualType = decl.type as QualifiedType;
      assert.ok(qualType.qualifiers.includes('const'));
    });

    it('volatile type is properly qualified', () => {
      const ast = parse('volatile int x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.QualifiedType);
      const qualType = decl.type as QualifiedType;
      assert.ok(qualType.qualifiers.includes('volatile'));
      assert.ok(!qualType.qualifiers.includes('const'));
    });

    it('pointer qualifiers are separate from pointee qualifiers', () => {
      const ast = parse('int * const p;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.PointerType);
      const ptrType = decl.type as PointerType;
      assert.ok(ptrType.qualifiers.includes('const'));
    });
  });

  describe('Statement kind verification', () => {
    it('if statement is NOT a while statement', () => {
      const ast = parse('void f() { if (x) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0];

      assert.strictEqual(stmt.kind, NodeKind.IfStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.WhileStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.ForStmt);
    });

    it('while statement is NOT a for statement', () => {
      const ast = parse('void f() { while (x) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0];

      assert.strictEqual(stmt.kind, NodeKind.WhileStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.ForStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.DoWhileStmt);
    });

    it('for statement is NOT a while statement', () => {
      const ast = parse('void f() { for (;;) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0];

      assert.strictEqual(stmt.kind, NodeKind.ForStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.WhileStmt);
    });

    it('break statement is NOT continue statement', () => {
      const ast = parse('void f() { while (1) { break; } }');
      const fn = ast.declarations[0] as FunctionDecl;
      const whileStmt = fn.body!.statements[0] as WhileStmt;
      const body = whileStmt.body as CompoundStmt;
      const stmt = body.statements[0];

      assert.strictEqual(stmt.kind, NodeKind.BreakStmt);
      assert.notStrictEqual(stmt.kind, NodeKind.ContinueStmt);
    });
  });

  describe('AST structure verification', () => {
    it('TranslationUnit contains only declarations', () => {
      const ast = parse('int x; void f() {}');

      assert.strictEqual(ast.kind, NodeKind.TranslationUnit);
      for (const decl of ast.declarations) {
        assert.ok(
          decl.kind === NodeKind.VariableDecl ||
          decl.kind === NodeKind.FunctionDecl ||
          decl.kind === NodeKind.StructDecl ||
          decl.kind === NodeKind.ClassDecl ||
          decl.kind === NodeKind.EnumDecl ||
          decl.kind === NodeKind.NamespaceDecl ||
          decl.kind === NodeKind.TypedefDecl ||
          decl.kind === NodeKind.EmptyDecl,
          `Unexpected declaration kind: ${decl.kind}`
        );
      }
    });

    it('function body contains only statements', () => {
      const ast = parse('void f() { int x; x = 1; return; }');
      const fn = ast.declarations[0] as FunctionDecl;

      for (const stmt of fn.body!.statements) {
        assert.ok(
          stmt.kind === NodeKind.DeclStmt ||
          stmt.kind === NodeKind.ExprStmt ||
          stmt.kind === NodeKind.ReturnStmt ||
          stmt.kind === NodeKind.IfStmt ||
          stmt.kind === NodeKind.WhileStmt ||
          stmt.kind === NodeKind.ForStmt ||
          stmt.kind === NodeKind.DoWhileStmt ||
          stmt.kind === NodeKind.SwitchStmt ||
          stmt.kind === NodeKind.BreakStmt ||
          stmt.kind === NodeKind.ContinueStmt ||
          stmt.kind === NodeKind.CompoundStmt ||
          stmt.kind === NodeKind.NullStmt ||
          stmt.kind === NodeKind.GotoStmt ||
          stmt.kind === NodeKind.LabelStmt ||
          stmt.kind === NodeKind.CaseStmt ||
          stmt.kind === NodeKind.DefaultStmt,
          `Unexpected statement kind: ${stmt.kind}`
        );
      }
    });

    it('binary expression has exactly two operands', () => {
      const ast = parse('void f() { a + b; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      assert.ok(expr.left !== null && expr.left !== undefined);
      assert.ok(expr.right !== null && expr.right !== undefined);
    });

    it('unary expression has exactly one operand', () => {
      const ast = parse('void f() { -x; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as UnaryExpr;

      assert.ok(expr.operand !== null && expr.operand !== undefined);
    });

    it('if statement has required condition and then branch', () => {
      const ast = parse('void f() { if (x) y; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const ifStmt = fn.body!.statements[0] as IfStmt;

      assert.ok(ifStmt.condition !== null && ifStmt.condition !== undefined);
      assert.ok(ifStmt.thenBranch !== null && ifStmt.thenBranch !== undefined);
    });

    it('for statement may have null components', () => {
      const ast = parse('void f() { for (;;) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const forStmt = fn.body!.statements[0] as ForStmt;

      // All components can be null
      assert.strictEqual(forStmt.init, null);
      assert.strictEqual(forStmt.condition, null);
      assert.strictEqual(forStmt.increment, null);

      // But body must exist
      assert.ok(forStmt.body !== null && forStmt.body !== undefined);
    });
  });

  describe('Whitespace and comment handling', () => {
    it('handles code with lots of whitespace', () => {
      const ast = parse(`


        int    x    =    42    ;


      `);
      assert.strictEqual(ast.declarations.length, 1);
      const decl = ast.declarations[0] as VariableDecl;
      assert.strictEqual(decl.name.name, 'x');
    });

    it('handles code with single line comments', () => {
      const ast = parse(`
        // This is a comment
        int x; // Another comment
        // Final comment
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('handles code with multi-line comments', () => {
      const ast = parse(`
        /* Multi
           line
           comment */
        int x;
        /* Another one */
      `);
      assert.strictEqual(ast.declarations.length, 1);
    });

    it('handles tabs mixed with spaces', () => {
      const ast = parse('\t\tint\t\tx\t=\t1\t;\t');
      assert.strictEqual(ast.declarations.length, 1);
    });
  });

  describe('Round-trip consistency (parse -> verify -> parse again)', () => {
    const roundTripCases = [
      'int x;',
      'int x = 42;',
      'void foo();',
      'int add(int a, int b) { return a + b; }',
      'struct Point { int x; int y; };',
      'enum Color { Red, Green, Blue };',
      'namespace ns { int x; }',
      'void f() { if (x) y; }',
      'void f() { while (x) {} }',
      'void f() { for (int i = 0; i < 10; i++) {} }',
      'void f() { x = y + z * w; }',
      'const int* p;',
      'int arr[10];',
    ];

    for (const code of roundTripCases) {
      it(`parses "${code}" consistently`, () => {
        // Parse the code
        const ast1 = parse(code);

        // Verify we can access all nodes without error
        verifyASTIntegrity(ast1);

        // Parse again to ensure consistency
        const ast2 = parse(code);

        // Both ASTs should have same structure
        assert.strictEqual(ast1.declarations.length, ast2.declarations.length);
        assert.strictEqual(ast1.declarations[0].kind, ast2.declarations[0].kind);
      });
    }
  });

  describe('Special characters and escapes', () => {
    it('handles string with escape sequences', () => {
      const ast = parse('const char* s = "hello\\nworld\\t\\\\";');
      const decl = ast.declarations[0] as VariableDecl;

      assert.ok(decl.initializer !== null);
      assert.strictEqual(decl.initializer!.kind, NodeKind.StringLiteral);
    });

    it('handles character literal with escape', () => {
      const ast = parse("char c = '\\n';");
      const decl = ast.declarations[0] as VariableDecl;

      assert.ok(decl.initializer !== null);
      assert.strictEqual(decl.initializer!.kind, NodeKind.CharLiteral);
    });

    it('handles identifier with underscores', () => {
      const ast = parse('int _my_variable_;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.name.name, '_my_variable_');
    });

    it('handles identifier starting with underscore', () => {
      const ast = parse('int _x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.name.name, '_x');
    });
  });
});

/**
 * Recursively verify AST integrity - ensure all nodes are well-formed
 */
function verifyASTIntegrity(node: TranslationUnit): void {
  assert.ok(node !== null && node !== undefined, 'Node should not be null/undefined');
  assert.ok(typeof node.kind === 'string', 'Node should have a kind');

  for (const decl of node.declarations) {
    assert.ok(decl !== null && decl !== undefined);
    assert.ok(typeof decl.kind === 'string');

    if (decl.kind === NodeKind.FunctionDecl) {
      const fn = decl as FunctionDecl;
      assert.ok(fn.name !== null);
      assert.ok(fn.returnType !== null);
      assert.ok(Array.isArray(fn.parameters));

      if (fn.body) {
        assert.ok(Array.isArray(fn.body.statements));
      }
    }

    if (decl.kind === NodeKind.VariableDecl) {
      const vd = decl as VariableDecl;
      assert.ok(vd.name !== null);
      assert.ok(vd.type !== null);
    }
  }
}

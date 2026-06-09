import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse, Parser, ParserError } from '../parser.js';
import { NodeKind } from '../../ast/kinds.js';
import type {
  FunctionDecl,
  VariableDecl,
  ReturnStmt,
  BinaryExpr,
  IntegerLiteralExpr,
  Identifier,
  IfStmt,
  WhileStmt,
  ForStmt,
  CallExpr,
  PointerType,
  BuiltinType,
  CompoundStmt,
  ExprStmt,
  AssignExpr,
  UnaryExpr,
  StructDecl,
  EnumDecl,
  NamespaceDecl,
  CStyleCastExpr,
  MemberExpr,
  SubscriptExpr,
} from '../../ast/nodes.js';

describe('Parser', () => {
  describe('empty input', () => {
    it('parses empty source', () => {
      const ast = parse('');
      assert.strictEqual(ast.kind, NodeKind.TranslationUnit);
      assert.strictEqual(ast.declarations.length, 0);
    });
  });

  describe('function declarations', () => {
    it('parses simple function declaration', () => {
      const ast = parse('void foo();');
      assert.strictEqual(ast.declarations.length, 1);

      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual(fn.kind, NodeKind.FunctionDecl);
      assert.strictEqual((fn.name as Identifier).name, 'foo');
      assert.strictEqual(fn.body, null);
    });

    it('parses function with body', () => {
      const ast = parse('int main() { return 0; }');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.kind, NodeKind.FunctionDecl);
      assert.strictEqual((fn.name as Identifier).name, 'main');
      assert.notStrictEqual(fn.body, null);

      const body = fn.body!;
      assert.strictEqual(body.statements.length, 1);

      const ret = body.statements[0] as ReturnStmt;
      assert.strictEqual(ret.kind, NodeKind.ReturnStmt);
    });

    it('parses function with parameters', () => {
      const ast = parse('int add(int a, int b) { return a + b; }');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.parameters.length, 2);
      assert.strictEqual(fn.parameters[0].name?.name, 'a');
      assert.strictEqual(fn.parameters[1].name?.name, 'b');
    });

    it('parses function with pointer return type', () => {
      const ast = parse('int* getPtr();');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.returnType.kind, NodeKind.PointerType);
      const ptr = fn.returnType as PointerType;
      assert.strictEqual((ptr.pointee as BuiltinType).name, 'int');
    });

    it('parses function with specifiers', () => {
      const ast = parse('static inline void helper() {}');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.ok(fn.specifiers.includes('static'));
      assert.ok(fn.specifiers.includes('inline'));
    });
  });

  describe('variable declarations', () => {
    it('parses simple variable declaration', () => {
      const ast = parse('int x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.kind, NodeKind.VariableDecl);
      assert.strictEqual(decl.name.name, 'x');
      assert.strictEqual(decl.initializer, null);
    });

    it('parses variable with initializer', () => {
      const ast = parse('int x = 42;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.name.name, 'x');
      assert.notStrictEqual(decl.initializer, null);
      assert.strictEqual((decl.initializer as IntegerLiteralExpr).value, 42n);
    });

    it('parses pointer variable', () => {
      const ast = parse('int *p;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.PointerType);
    });

    it('parses array variable', () => {
      const ast = parse('int arr[10];');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.ArrayType);
    });
  });

  describe('struct declarations', () => {
    it('parses struct forward declaration', () => {
      const ast = parse('struct Point;');
      const decl = ast.declarations[0] as StructDecl;

      assert.strictEqual(decl.kind, NodeKind.StructDecl);
      assert.strictEqual(decl.name?.name, 'Point');
      assert.strictEqual(decl.members.length, 0);
    });

    it('parses struct definition', () => {
      const ast = parse('struct Point { int x; int y; };');
      const decl = ast.declarations[0] as StructDecl;

      assert.strictEqual(decl.kind, NodeKind.StructDecl);
      assert.strictEqual(decl.members.length, 2);
    });
  });

  describe('enum declarations', () => {
    it('parses simple enum', () => {
      const ast = parse('enum Color { Red, Green, Blue };');
      const decl = ast.declarations[0] as EnumDecl;

      assert.strictEqual(decl.kind, NodeKind.EnumDecl);
      assert.strictEqual(decl.name?.name, 'Color');
      assert.strictEqual(decl.isScoped, false);
      assert.strictEqual(decl.enumerators.length, 3);
    });

    it('parses scoped enum', () => {
      const ast = parse('enum class Status { Ok, Error };');
      const decl = ast.declarations[0] as EnumDecl;

      assert.strictEqual(decl.isScoped, true);
    });

    it('parses enum with values', () => {
      const ast = parse('enum Flags { A = 1, B = 2 };');
      const decl = ast.declarations[0] as EnumDecl;

      assert.notStrictEqual(decl.enumerators[0].value, null);
      assert.notStrictEqual(decl.enumerators[1].value, null);
    });
  });

  describe('namespace declarations', () => {
    it('parses namespace', () => {
      const ast = parse('namespace foo { int x; }');
      const ns = ast.declarations[0] as NamespaceDecl;

      assert.strictEqual(ns.kind, NodeKind.NamespaceDecl);
      assert.strictEqual(ns.name?.name, 'foo');
      assert.strictEqual(ns.declarations.length, 1);
    });

    it('parses nested namespaces', () => {
      const ast = parse('namespace outer { namespace inner { int x; } }');
      const outer = ast.declarations[0] as NamespaceDecl;
      const inner = outer.declarations[0] as NamespaceDecl;

      assert.strictEqual(outer.name?.name, 'outer');
      assert.strictEqual(inner.name?.name, 'inner');
    });
  });

  describe('statements', () => {
    it('parses if statement', () => {
      const ast = parse('void f() { if (x) return; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const ifStmt = fn.body!.statements[0] as IfStmt;

      assert.strictEqual(ifStmt.kind, NodeKind.IfStmt);
      assert.notStrictEqual(ifStmt.condition, null);
      assert.strictEqual(ifStmt.elseBranch, null);
    });

    it('parses if-else statement', () => {
      const ast = parse('void f() { if (x) return 1; else return 0; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const ifStmt = fn.body!.statements[0] as IfStmt;

      assert.notStrictEqual(ifStmt.elseBranch, null);
    });

    it('parses while statement', () => {
      const ast = parse('void f() { while (x) x--; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const whileStmt = fn.body!.statements[0] as WhileStmt;

      assert.strictEqual(whileStmt.kind, NodeKind.WhileStmt);
    });

    it('parses for statement', () => {
      const ast = parse('void f() { for (int i = 0; i < 10; i++) {} }');
      const fn = ast.declarations[0] as FunctionDecl;
      const forStmt = fn.body!.statements[0] as ForStmt;

      assert.strictEqual(forStmt.kind, NodeKind.ForStmt);
      assert.notStrictEqual(forStmt.init, null);
      assert.notStrictEqual(forStmt.condition, null);
      assert.notStrictEqual(forStmt.increment, null);
    });

    it('parses switch statement', () => {
      const ast = parse('void f() { switch (x) { case 1: break; default: break; } }');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.body!.statements[0].kind, NodeKind.SwitchStmt);
    });

    it('parses return statement', () => {
      const ast = parse('int f() { return 42; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const ret = fn.body!.statements[0] as ReturnStmt;

      assert.strictEqual(ret.kind, NodeKind.ReturnStmt);
      assert.strictEqual((ret.value as IntegerLiteralExpr).value, 42n);
    });

    it('parses break and continue', () => {
      const ast = parse('void f() { while (1) { break; continue; } }');
      const fn = ast.declarations[0] as FunctionDecl;
      const whileStmt = fn.body!.statements[0] as WhileStmt;
      const body = whileStmt.body as CompoundStmt;

      assert.strictEqual(body.statements[0].kind, NodeKind.BreakStmt);
      assert.strictEqual(body.statements[1].kind, NodeKind.ContinueStmt);
    });
  });

  describe('expressions', () => {
    it('parses binary expressions', () => {
      const ast = parse('void f() { x + y; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      assert.strictEqual(expr.kind, NodeKind.BinaryExpr);
      assert.strictEqual(expr.operator, '+');
    });

    it('parses operator precedence correctly', () => {
      const ast = parse('void f() { a + b * c; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as BinaryExpr;

      // Should be a + (b * c)
      assert.strictEqual(expr.operator, '+');
      assert.strictEqual((expr.right as BinaryExpr).operator, '*');
    });

    it('parses assignment expression', () => {
      const ast = parse('void f() { x = 10; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as AssignExpr;

      assert.strictEqual(expr.kind, NodeKind.AssignExpr);
      assert.strictEqual(expr.operator, '=');
    });

    it('parses compound assignment', () => {
      const ast = parse('void f() { x += 1; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const expr = stmt.expression as AssignExpr;

      assert.strictEqual(expr.operator, '+=');
    });

    it('parses unary expressions', () => {
      const ast = parse('void f() { -x; !y; *p; &a; }');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual((fn.body!.statements[0] as ExprStmt).expression.kind, NodeKind.UnaryExpr);
    });

    it('parses function calls', () => {
      const ast = parse('void f() { foo(1, 2, 3); }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const call = stmt.expression as CallExpr;

      assert.strictEqual(call.kind, NodeKind.CallExpr);
      assert.strictEqual(call.arguments.length, 3);
    });

    it('parses member access', () => {
      const ast = parse('void f() { obj.member; ptr->member; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const dot = (fn.body!.statements[0] as ExprStmt).expression as MemberExpr;
      const arrow = (fn.body!.statements[1] as ExprStmt).expression as MemberExpr;

      assert.strictEqual(dot.kind, NodeKind.MemberExpr);
      assert.strictEqual(dot.isArrow, false);
      assert.strictEqual(arrow.isArrow, true);
    });

    it('parses subscript expression', () => {
      const ast = parse('void f() { arr[0]; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const sub = stmt.expression as SubscriptExpr;

      assert.strictEqual(sub.kind, NodeKind.SubscriptExpr);
    });

    it('parses cast expression', () => {
      const ast = parse('void f() { (int)x; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;
      const cast = stmt.expression as CStyleCastExpr;

      assert.strictEqual(cast.kind, NodeKind.CStyleCastExpr);
    });

    it('parses conditional expression', () => {
      const ast = parse('void f() { x ? 1 : 0; }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;

      assert.strictEqual(stmt.expression.kind, NodeKind.ConditionalExpr);
    });

    it('parses sizeof expression', () => {
      const ast = parse('void f() { sizeof(int); }');
      const fn = ast.declarations[0] as FunctionDecl;
      const stmt = fn.body!.statements[0] as ExprStmt;

      assert.strictEqual(stmt.expression.kind, NodeKind.SizeofExpr);
    });
  });

  describe('types', () => {
    it('parses pointer types', () => {
      const ast = parse('int *p;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.PointerType);
    });

    it('parses reference types', () => {
      const ast = parse('void f(int &x);');
      const fn = ast.declarations[0] as FunctionDecl;

      assert.strictEqual(fn.parameters[0].type.kind, NodeKind.ReferenceType);
    });

    it('parses const types', () => {
      const ast = parse('const int x;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.QualifiedType);
    });

    it('parses pointer to const', () => {
      const ast = parse('const int *p;');
      const decl = ast.declarations[0] as VariableDecl;

      assert.strictEqual(decl.type.kind, NodeKind.PointerType);
    });

    it('parses multiple modifiers', () => {
      const ast = parse('unsigned long long x;');
      const decl = ast.declarations[0] as VariableDecl;
      const type = decl.type as BuiltinType;

      assert.ok(type.modifiers.includes('unsigned'));
      assert.strictEqual(type.modifiers.filter(m => m === 'long').length, 2);
    });
  });

  describe('real-world code', () => {
    it('parses a simple C++ program', () => {
      const source = `
        int factorial(int n) {
          if (n <= 1) return 1;
          return n * factorial(n - 1);
        }

        int main() {
          int result = factorial(5);
          return 0;
        }
      `;
      const ast = parse(source);

      assert.strictEqual(ast.declarations.length, 2);
    });

    it('parses Ghidra-style code', () => {
      const source = `
        void FUN_00401000(int *param_1) {
          *(int *)0x402000 = *param_1;
          return;
        }
      `;
      const ast = parse(source);

      assert.strictEqual(ast.declarations.length, 1);
      const fn = ast.declarations[0] as FunctionDecl;
      assert.strictEqual((fn.name as Identifier).name, 'FUN_00401000');
    });
  });

  describe('error handling', () => {
    it('throws on unexpected token', () => {
      assert.throws(() => parse('int ;'), ParserError);
    });

    it('throws on missing semicolon', () => {
      assert.throws(() => parse('int x'), ParserError);
    });

    it('throws on unbalanced braces', () => {
      assert.throws(() => parse('void f() {'), ParserError);
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  NodeKind,
  isDeclaration,
  isStatement,
  isExpression,
  isType,
  isLiteral,
} from '../kinds.js';

describe('NodeKind', () => {
  describe('isDeclaration', () => {
    it('returns true for declaration kinds', () => {
      assert.strictEqual(isDeclaration(NodeKind.FunctionDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.VariableDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.ClassDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.StructDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.NamespaceDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.TypedefDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.TemplateDecl), true);
      assert.strictEqual(isDeclaration(NodeKind.EmptyDecl), true);
    });

    it('returns false for non-declaration kinds', () => {
      assert.strictEqual(isDeclaration(NodeKind.IfStmt), false);
      assert.strictEqual(isDeclaration(NodeKind.BinaryExpr), false);
      assert.strictEqual(isDeclaration(NodeKind.BuiltinType), false);
    });
  });

  describe('isStatement', () => {
    it('returns true for statement kinds', () => {
      assert.strictEqual(isStatement(NodeKind.CompoundStmt), true);
      assert.strictEqual(isStatement(NodeKind.IfStmt), true);
      assert.strictEqual(isStatement(NodeKind.ForStmt), true);
      assert.strictEqual(isStatement(NodeKind.WhileStmt), true);
      assert.strictEqual(isStatement(NodeKind.ReturnStmt), true);
      assert.strictEqual(isStatement(NodeKind.BreakStmt), true);
      assert.strictEqual(isStatement(NodeKind.TryStmt), true);
    });

    it('returns false for non-statement kinds', () => {
      assert.strictEqual(isStatement(NodeKind.FunctionDecl), false);
      assert.strictEqual(isStatement(NodeKind.BinaryExpr), false);
      assert.strictEqual(isStatement(NodeKind.BuiltinType), false);
    });
  });

  describe('isExpression', () => {
    it('returns true for expression kinds', () => {
      assert.strictEqual(isExpression(NodeKind.IntegerLiteral), true);
      assert.strictEqual(isExpression(NodeKind.StringLiteral), true);
      assert.strictEqual(isExpression(NodeKind.Identifier), true);
      assert.strictEqual(isExpression(NodeKind.BinaryExpr), true);
      assert.strictEqual(isExpression(NodeKind.CallExpr), true);
      assert.strictEqual(isExpression(NodeKind.LambdaExpr), true);
    });

    it('returns false for non-expression kinds', () => {
      assert.strictEqual(isExpression(NodeKind.FunctionDecl), false);
      assert.strictEqual(isExpression(NodeKind.IfStmt), false);
      assert.strictEqual(isExpression(NodeKind.BuiltinType), false);
    });
  });

  describe('isType', () => {
    it('returns true for type kinds', () => {
      assert.strictEqual(isType(NodeKind.BuiltinType), true);
      assert.strictEqual(isType(NodeKind.PointerType), true);
      assert.strictEqual(isType(NodeKind.ReferenceType), true);
      assert.strictEqual(isType(NodeKind.ArrayType), true);
      assert.strictEqual(isType(NodeKind.TemplateType), true);
      assert.strictEqual(isType(NodeKind.AutoType), true);
    });

    it('returns false for non-type kinds', () => {
      assert.strictEqual(isType(NodeKind.FunctionDecl), false);
      assert.strictEqual(isType(NodeKind.IfStmt), false);
      assert.strictEqual(isType(NodeKind.BinaryExpr), false);
    });
  });

  describe('isLiteral', () => {
    it('returns true for literal kinds', () => {
      assert.strictEqual(isLiteral(NodeKind.IntegerLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.FloatingLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.CharLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.StringLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.BoolLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.NullptrLiteral), true);
      assert.strictEqual(isLiteral(NodeKind.UserDefinedLiteral), true);
    });

    it('returns false for non-literal expressions', () => {
      assert.strictEqual(isLiteral(NodeKind.Identifier), false);
      assert.strictEqual(isLiteral(NodeKind.BinaryExpr), false);
      assert.strictEqual(isLiteral(NodeKind.CallExpr), false);
    });
  });

  describe('NodeKind enum values', () => {
    it('has unique values', () => {
      const values = Object.values(NodeKind);
      const uniqueValues = new Set(values);
      assert.strictEqual(values.length, uniqueValues.size);
    });

    it('contains all major C++ constructs', () => {
      // Declarations
      assert.ok(NodeKind.FunctionDecl);
      assert.ok(NodeKind.ClassDecl);
      assert.ok(NodeKind.TemplateDecl);
      assert.ok(NodeKind.ConceptDecl);

      // Statements
      assert.ok(NodeKind.IfStmt);
      assert.ok(NodeKind.ForStmt);
      assert.ok(NodeKind.TryStmt);
      assert.ok(NodeKind.CoReturnStmt);

      // Expressions
      assert.ok(NodeKind.LambdaExpr);
      assert.ok(NodeKind.FoldExpr);
      assert.ok(NodeKind.RequiresExpr);
      assert.ok(NodeKind.CoAwaitExpr);

      // Types
      assert.ok(NodeKind.AutoType);
      assert.ok(NodeKind.DecltypeType);
      assert.ok(NodeKind.MemberPointerType);
    });
  });
});

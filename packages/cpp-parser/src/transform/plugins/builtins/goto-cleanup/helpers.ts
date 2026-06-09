/**
 * Shared AST helpers for goto cleanup transforms.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BoolLiteralExpr,
  CompoundStmt,
  DeclStmt,
  DoWhileStmt,
  Expression,
  ExprStmt,
  ForStmt,
  GotoStmt,
  Identifier,
  IfStmt,
  Statement,
  UnaryExpr,
  VariableDecl,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { traverseAST } from '../../../../ast/visitor.js';

export function isSimpleLabelName(name: string): boolean {
  return name.startsWith('LAB_') || name.startsWith('label_')
    || name.startsWith('switchD_') || name.startsWith('joined_r')
    || name.startsWith('code_r') || name === 'returnFunctionAgain';
}

/**
 * Get the goto label from a statement (bare goto or compound with single goto).
 */
export function getGotoLabel(stmt: Statement): string | null {
  if (stmt.kind === NodeKind.GotoStmt) {
    return (stmt as GotoStmt).label.name;
  }
  if (stmt.kind === NodeKind.CompoundStmt) {
    const compound = stmt as CompoundStmt;
    if (compound.statements.length === 1 && compound.statements[0].kind === NodeKind.GotoStmt) {
      return (compound.statements[0] as GotoStmt).label.name;
    }
  }
  return null;
}

export function negateCondition(expr: Expression): Expression {
  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator === '!') return unary.operand;
  }

  return {
    kind: NodeKind.UnaryExpr,
    operator: '!',
    operand: expr,
    location: expr.location,
    leadingTrivia: expr.leadingTrivia,
    trailingTrivia: expr.trailingTrivia,
  } as UnaryExpr;
}

export function collectIdentifierNames(statements: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const stmt of statements) {
    for (const node of traverseAST(stmt as ASTNode)) {
      if (node.kind === NodeKind.Identifier) {
        names.add((node as Identifier).name);
      }
    }
  }
  return names;
}

export function generateUniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 1;
  let name = `${base}_${i}`;
  while (used.has(name)) {
    i++;
    name = `${base}_${i}`;
  }
  used.add(name);
  return name;
}

export function buildThenBranch(statements: Statement[], anchor: Statement): Statement {
  if (statements.length === 1) return statements[0];

  return {
    kind: NodeKind.CompoundStmt,
    statements,
    location: anchor.location,
    leadingTrivia: anchor.leadingTrivia,
    trailingTrivia: anchor.trailingTrivia,
  } as CompoundStmt;
}

export function createBoolLiteral(value: boolean, anchor: ASTNode): BoolLiteralExpr {
  return {
    kind: NodeKind.BoolLiteral,
    value,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as BoolLiteralExpr;
}

export function createBreakStmt(anchor: Statement): Statement {
  return {
    kind: NodeKind.BreakStmt,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Statement;
}

export function createNullStmt(anchor: ASTNode): Statement {
  return {
    kind: NodeKind.NullStmt,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Statement;
}

export function createFlagDecl(name: string, anchor: Statement): DeclStmt {
  const nameId: Identifier = {
    kind: NodeKind.Identifier,
    name,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Identifier;

  const boolType = {
    kind: NodeKind.BuiltinType,
    name: 'bool',
    modifiers: [],
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  const varDecl: VariableDecl = {
    kind: NodeKind.VariableDecl,
    name: nameId,
    type: boolType,
    initializer: createBoolLiteral(false, anchor),
    specifiers: [],
    attributes: [],
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as VariableDecl;

  return {
    kind: NodeKind.DeclStmt,
    declarations: [varDecl],
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as DeclStmt;
}

export function createFlagAssignStmt(name: string, anchor: Statement): ExprStmt {
  const nameId: Identifier = {
    kind: NodeKind.Identifier,
    name,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Identifier;

  const assignExpr: AssignExpr = {
    kind: NodeKind.AssignExpr,
    operator: '=',
    left: nameId,
    right: createBoolLiteral(true, anchor),
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as AssignExpr;

  return {
    kind: NodeKind.ExprStmt,
    expression: assignExpr,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as ExprStmt;
}

export function createIfNotFlag(flagName: string, statements: Statement[], anchor: Statement): IfStmt {
  const flagId: Identifier = {
    kind: NodeKind.Identifier,
    name: flagName,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Identifier;

  const condition: UnaryExpr = {
    kind: NodeKind.UnaryExpr,
    operator: '!',
    operand: flagId,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as UnaryExpr;

  const thenBranch = buildThenBranch(statements, anchor);

  return {
    kind: NodeKind.IfStmt,
    condition,
    thenBranch,
    elseBranch: null,
    isConstexpr: false,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as IfStmt;
}

export function hasTopLevelDeclOrLabel(statements: Statement[]): boolean {
  for (const stmt of statements) {
    if (stmt.kind === NodeKind.DeclStmt || stmt.kind === NodeKind.LabelStmt) return true;
  }
  return false;
}

export function isLoopStmt(stmt: Statement): boolean {
  return stmt.kind === NodeKind.ForStmt ||
    stmt.kind === NodeKind.WhileStmt ||
    stmt.kind === NodeKind.DoWhileStmt;
}

export function getLoopBody(stmt: Statement): Statement | null {
  if (stmt.kind === NodeKind.ForStmt) return (stmt as ForStmt).body;
  if (stmt.kind === NodeKind.WhileStmt) return (stmt as WhileStmt).body;
  if (stmt.kind === NodeKind.DoWhileStmt) return (stmt as DoWhileStmt).body;
  return null;
}

export function deepCloneStatements(stmts: Statement[]): Statement[] {
  return structuredClone(stmts);
}

export function deepCloneStatement(stmt: Statement): Statement {
  return structuredClone(stmt);
}

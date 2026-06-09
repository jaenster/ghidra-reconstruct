/**
 * PRNG Temp Variable Collapse Plugin
 *
 * Collapses the 3-line temp variable pattern that Ghidra produces for PRNG calls:
 *
 *   D2SeedStrc DVar1 = D2_SEED_NEXT(pUnit->sSeed);   →  pUnit->sSeed = D2_SEED_NEXT(pUnit->sSeed);
 *   pUnit->sSeed = DVar1;
 *
 * Also handles the assign+writeback variant:
 *   DVar1 = D2_SEED_NEXT(pUnit->sSeed);               →  pUnit->sSeed = D2_SEED_NEXT(pUnit->sSeed);
 *   pUnit->sSeed = DVar1;
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  CallExpr,
  CompoundStmt,
  DeclStmt,
  Expression,
  ExpressionStmt,
  Identifier,
  VariableDecl,
} from '../../../ast/nodes.js';
import { findIdentifiers } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const PRNG_MACROS = new Set(['D2_SEED_NEXT', 'D2_SEED_NEXT_VAL']);

function isSeedNextCall(expr: Expression): expr is CallExpr {
  if (expr.kind !== NodeKind.CallExpr) return false;
  const call = expr as CallExpr;
  if (call.callee.kind !== NodeKind.Identifier) return false;
  return PRNG_MACROS.has((call.callee as Identifier).name);
}

interface TempPattern {
  tempName: string;
  callExpr: CallExpr;
}

function matchDeclStmt(stmt: ASTNode): TempPattern | null {
  if (stmt.kind !== NodeKind.DeclStmt) return null;
  const declStmt = stmt as DeclStmt;
  if (declStmt.declarations.length !== 1) return null;
  const decl = declStmt.declarations[0];
  if (decl.kind !== NodeKind.VariableDecl) return null;
  const varDecl = decl as VariableDecl;
  if (!varDecl.initializer || !isSeedNextCall(varDecl.initializer)) return null;
  return { tempName: varDecl.name.name, callExpr: varDecl.initializer };
}

function matchAssignStmt(stmt: ASTNode): TempPattern | null {
  if (stmt.kind !== NodeKind.ExprStmt) return null;
  const exprStmt = stmt as ExpressionStmt;
  if (exprStmt.expression.kind !== NodeKind.AssignExpr) return null;
  const assign = exprStmt.expression as AssignExpr;
  if (assign.operator !== '=') return null;
  if (!isSeedNextCall(assign.right)) return null;
  if (assign.left.kind !== NodeKind.Identifier) return null;
  return { tempName: (assign.left as Identifier).name, callExpr: assign.right as CallExpr };
}

function matchWriteback(stmt: ASTNode, tempName: string): AssignExpr | null {
  if (stmt.kind !== NodeKind.ExprStmt) return null;
  const exprStmt = stmt as ExpressionStmt;
  if (exprStmt.expression.kind !== NodeKind.AssignExpr) return null;
  const assign = exprStmt.expression as AssignExpr;
  if (assign.operator !== '=') return null;
  if (assign.right.kind !== NodeKind.Identifier) return null;
  if ((assign.right as Identifier).name !== tempName) return null;
  return assign;
}

function createPrngTempCollapseTransformer(_options: PluginOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;

      for (let i = 0; i < stmts.length - 1; i++) {
        const pattern = matchDeclStmt(stmts[i]) || matchAssignStmt(stmts[i]);
        if (!pattern) continue;

        const writeback = matchWriteback(stmts[i + 1], pattern.tempName);
        if (!writeback) continue;

        // Safety: temp must appear exactly twice in the block (the decl/assign + writeback)
        const refs = findIdentifiers(node, pattern.tempName);
        if (refs.length !== 2) continue;

        // Build merged statement: target = D2_SEED_NEXT(seed)
        const mergedAssign: AssignExpr = {
          kind: NodeKind.AssignExpr,
          operator: '=',
          left: writeback.left,
          right: pattern.callExpr,
          location: writeback.location,
          leadingTrivia: stmts[i].leadingTrivia || [],
          trailingTrivia: [],
        };

        const mergedStmt: ExpressionStmt = {
          kind: NodeKind.ExprStmt,
          expression: mergedAssign,
          location: stmts[i].location,
          leadingTrivia: stmts[i].leadingTrivia || [],
          trailingTrivia: stmts[i + 1].trailingTrivia || [],
        };

        const newStmts = [...stmts];
        newStmts.splice(i, 2, mergedStmt);
        return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
      }

      return undefined;
    },
  });
}

export const prngTempCollapsePlugin: TransformPlugin = {
  id: 'prng-temp-collapse',
  name: 'PRNG Temp Variable Collapse',
  description: 'Collapses temp variable patterns around D2_SEED_NEXT calls',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 85,
  tags: ['game', 'diablo', 'cleanup'],
  createTransformer: createPrngTempCollapseTransformer,
};

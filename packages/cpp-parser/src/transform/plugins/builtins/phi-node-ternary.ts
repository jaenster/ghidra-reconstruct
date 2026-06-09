/**
 * Phi-Node Ternary Plugin
 *
 * Converts phi-node patterns produced by Ghidra into ternary expressions:
 *   int x; if (c) { x = a; } else { x = b; }  →  int x = c ? a : b;
 *
 * This pattern appears when Ghidra's decompiler encounters SSA phi nodes
 * at control flow merge points and lowers them to C89-style code.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, VariableDecl,
  IfStmt, ExprStmt, AssignExpr, Identifier,
  ConditionalExpr,
} from '../../../ast/nodes.js';
import { findIdentifiers } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface PhiNodeTernaryOptions extends PluginOptions {}

function getAssignToVar(stmt: ASTNode, varName: string): ASTNode | null {
  if (stmt.kind !== NodeKind.ExprStmt) return null;
  const exprStmt = stmt as ExprStmt;
  if (exprStmt.expression.kind !== NodeKind.AssignExpr) return null;
  const assign = exprStmt.expression as AssignExpr;
  if (assign.operator !== '=') return null;
  if (assign.left.kind !== NodeKind.Identifier) return null;
  if ((assign.left as Identifier).name !== varName) return null;
  return assign.right;
}

function createPhiNodeTernaryTransformer(_options: PhiNodeTernaryOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;
      let changed = false;
      const newStmts: ASTNode[] = [];

      for (let i = 0; i < stmts.length; i++) {
        // Look for [DeclStmt, IfStmt] pairs
        if (i + 1 < stmts.length
          && stmts[i].kind === NodeKind.DeclStmt
          && stmts[i + 1].kind === NodeKind.IfStmt) {

          const declStmt = stmts[i] as DeclStmt;
          const ifStmt = stmts[i + 1] as IfStmt;

          // Single variable, no initializer, no static/extern
          if (declStmt.declarations.length === 1
            && declStmt.declarations[0].kind === NodeKind.VariableDecl) {

            const varDecl = declStmt.declarations[0] as VariableDecl;
            if (varDecl.initializer === null
              && !varDecl.specifiers.some(s => s === 'static' || s === 'extern')
              && ifStmt.elseBranch !== null) {

              const varName = varDecl.name.name;

              // Variable must NOT appear in the condition
              if (findIdentifiers(ifStmt.condition, varName).length === 0) {
                const thenBody = ifStmt.thenBranch;
                const elseBody = ifStmt.elseBranch;

                // Both branches must be compounds with exactly one statement
                if (thenBody.kind === NodeKind.CompoundStmt
                  && elseBody.kind === NodeKind.CompoundStmt) {

                  const thenStmts = (thenBody as CompoundStmt).statements;
                  const elseStmts = (elseBody as CompoundStmt).statements;

                  if (thenStmts.length === 1 && elseStmts.length === 1) {
                    const thenVal = getAssignToVar(thenStmts[0], varName);
                    const elseVal = getAssignToVar(elseStmts[0], varName);

                    if (thenVal !== null && elseVal !== null) {
                      // Build: int x = c ? a : b;
                      const ternary: ConditionalExpr = {
                        kind: NodeKind.ConditionalExpr,
                        condition: ifStmt.condition,
                        thenExpr: thenVal,
                        elseExpr: elseVal,
                      } as ConditionalExpr;

                      const newVarDecl = updateNode(varDecl, {
                        initializer: ternary,
                      } as Partial<VariableDecl>);
                      const newDeclStmt = updateNode(declStmt, {
                        declarations: [newVarDecl],
                      } as Partial<DeclStmt>);

                      newStmts.push(newDeclStmt);
                      i++; // skip the IfStmt
                      changed = true;
                      continue;
                    }
                  }
                }
              }
            }
          }
        }

        newStmts.push(stmts[i]);
      }

      if (!changed) return undefined;
      return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
    },
  });
}

export const phiNodeTernaryPlugin: TransformPlugin = {
  id: 'phi-node-ternary',
  name: 'Phi-Node Ternary',
  description: 'Converts phi-node patterns to ternary expressions',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 63,
  tags: ['cleanup', 'declaration'],
  createTransformer: createPhiNodeTernaryTransformer,
};

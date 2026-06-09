/**
 * Declaration-Initialization Merge Plugin
 *
 * Merges `int x; ... x = expr;` into `int x = expr;` when no reads of `x`
 * occur between the declaration and first assignment.
 *
 * Ghidra's decompiler outputs C89-style code with all declarations at
 * function top, separated from first assignment. This plugin merges them.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DeclStmt, VariableDecl,
  ExprStmt, AssignExpr, Identifier,
} from '../../../ast/nodes.js';
import { findIdentifiers } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DeclInitMergeOptions extends PluginOptions {}

/**
 * Try to find a merge candidate for a single bare declaration.
 * Returns the index of the assignment statement to merge, or -1 if none found.
 */
function findMergeTarget(
  stmts: readonly ASTNode[],
  declIndex: number,
  varName: string,
): number {
  for (let j = declIndex + 1; j < stmts.length; j++) {
    const candidate = stmts[j];

    if (candidate.kind === NodeKind.ExprStmt) {
      const exprStmt = candidate as ExprStmt;
      if (exprStmt.expression.kind === NodeKind.AssignExpr) {
        const assign = exprStmt.expression as AssignExpr;

        if (assign.operator !== '=') return -1;

        if (assign.left.kind === NodeKind.Identifier
          && (assign.left as Identifier).name === varName) {
          // No self-reference in RHS
          if (findIdentifiers(assign.right, varName).length > 0) return -1;
          return j;
        }
      }
    }

    // If intermediate statement references the variable, abort
    if (findIdentifiers(candidate, varName).length > 0) return -1;
  }
  return -1;
}

function createDeclInitMergeTransformer(_options: DeclInitMergeOptions = {}): Transformer {
  return createTransformer({
    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;

      // Collect all merges: [declIndex, assignIndex]
      const merges: Array<[number, number]> = [];
      const usedAssignIndices = new Set<number>();

      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];
        if (stmt.kind !== NodeKind.DeclStmt) continue;

        const declStmt = stmt as DeclStmt;
        if (declStmt.declarations.length !== 1) continue;

        const decl = declStmt.declarations[0];
        if (decl.kind !== NodeKind.VariableDecl) continue;

        const varDecl = decl as VariableDecl;
        if (varDecl.initializer !== null) continue;
        if (varDecl.specifiers.some(s => s === 'static' || s === 'extern')) continue;

        const target = findMergeTarget(stmts, i, varDecl.name.name);
        if (target !== -1 && !usedAssignIndices.has(target)) {
          merges.push([i, target]);
          usedAssignIndices.add(target);
        }
      }

      if (merges.length === 0) return undefined;

      // Build new statement list
      const removeIndices = new Set(merges.map(([, j]) => j));
      const mergeMap = new Map(merges); // declIndex -> assignIndex

      const newStmts: ASTNode[] = [];
      for (let i = 0; i < stmts.length; i++) {
        if (removeIndices.has(i)) continue; // skip merged assignment

        if (mergeMap.has(i)) {
          const assignIdx = mergeMap.get(i)!;
          const declStmt = stmts[i] as DeclStmt;
          const varDecl = declStmt.declarations[0] as VariableDecl;
          const assign = (stmts[assignIdx] as ExprStmt).expression as AssignExpr;

          const newVarDecl = updateNode(varDecl, {
            initializer: assign.right,
          } as Partial<VariableDecl>);
          const newDeclStmt = updateNode(declStmt, {
            declarations: [newVarDecl],
          } as Partial<DeclStmt>);
          newStmts.push(newDeclStmt);
        } else {
          newStmts.push(stmts[i]);
        }
      }

      return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
    },
  });
}

export const declInitMergePlugin: TransformPlugin = {
  id: 'decl-init-merge',
  name: 'Declaration-Initialization Merge',
  description: 'Merges bare declarations with their first assignment',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 60,
  tags: ['cleanup', 'declaration'],
  createTransformer: createDeclInitMergeTransformer,
};

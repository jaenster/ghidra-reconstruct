/**
 * Dead Branch Cleanup Plugin
 *
 * Eliminates `if (true)` and `if (false)` branches produced by Ghidra's
 * constant propagation. These are pure dead code that obscures the real
 * control flow.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, BoolLiteralExpr,
  CaseStmt, DefaultStmt, LabelStmt, BinaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface DeadBranchCleanupOptions extends PluginOptions {}

function unwrapCompound(node: ASTNode): ASTNode[] {
  if (node.kind === NodeKind.CompoundStmt) {
    return (node as CompoundStmt).statements;
  }
  return [node];
}

function createDeadBranchCleanupTransformer(_options: DeadBranchCleanupOptions = {}): Transformer {
  return createTransformer({
    // Handle `else if (true/false)` nested in an if's else branch
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      if (!node.elseBranch || node.elseBranch.kind !== NodeKind.IfStmt) return undefined;
      const elseIf = node.elseBranch as IfStmt;
      if (elseIf.condition.kind !== NodeKind.BoolLiteral) return undefined;

      const boolVal = (elseIf.condition as BoolLiteralExpr).value;

      if (boolVal) {
        // else if (true) { B } [else { C }] → else { B }
        return updateNode(node, {
          elseBranch: elseIf.thenBranch,
        } as Partial<IfStmt>);
      } else {
        // else if (false) { B } → drop else, or else if (false) { B } else { C } → else { C }
        return updateNode(node, {
          elseBranch: elseIf.elseBranch,
        } as Partial<IfStmt>);
      }
    },

    // Handle `case X: if(true) { body }` → `case X: body` (unwrap single-stmt or use compound)
    visitCaseStmt(node: CaseStmt): ASTNode | undefined {
      if (node.statement.kind !== NodeKind.IfStmt) return undefined;
      const ifStmt = node.statement as IfStmt;
      if (ifStmt.condition.kind !== NodeKind.BoolLiteral) return undefined;
      const boolVal = (ifStmt.condition as BoolLiteralExpr).value;

      if (boolVal) {
        return updateNode(node, { statement: ifStmt.thenBranch } as Partial<CaseStmt>);
      } else {
        if (ifStmt.elseBranch) {
          return updateNode(node, { statement: ifStmt.elseBranch } as Partial<CaseStmt>);
        }
        // if(false) with no else in a case — replace with NullStmt
        return updateNode(node, {
          statement: { kind: NodeKind.NullStmt } as ASTNode,
        } as Partial<CaseStmt>);
      }
    },

    // Handle `default: if(true) { body }` → `default: body`
    visitDefaultStmt(node: DefaultStmt): ASTNode | undefined {
      if (node.statement.kind !== NodeKind.IfStmt) return undefined;
      const ifStmt = node.statement as IfStmt;
      if (ifStmt.condition.kind !== NodeKind.BoolLiteral) return undefined;
      const boolVal = (ifStmt.condition as BoolLiteralExpr).value;

      if (boolVal) {
        return updateNode(node, { statement: ifStmt.thenBranch } as Partial<DefaultStmt>);
      } else {
        if (ifStmt.elseBranch) {
          return updateNode(node, { statement: ifStmt.elseBranch } as Partial<DefaultStmt>);
        }
        return updateNode(node, {
          statement: { kind: NodeKind.NullStmt } as ASTNode,
        } as Partial<DefaultStmt>);
      }
    },

    // Handle `label: if(true) { body }` → `label: body`
    visitLabelStmt(node: LabelStmt): ASTNode | undefined {
      if (node.statement.kind !== NodeKind.IfStmt) return undefined;
      const ifStmt = node.statement as IfStmt;
      if (ifStmt.condition.kind !== NodeKind.BoolLiteral) return undefined;
      const boolVal = (ifStmt.condition as BoolLiteralExpr).value;

      if (boolVal) {
        return updateNode(node, { statement: ifStmt.thenBranch } as Partial<LabelStmt>);
      } else {
        if (ifStmt.elseBranch) {
          return updateNode(node, { statement: ifStmt.elseBranch } as Partial<LabelStmt>);
        }
        return updateNode(node, {
          statement: { kind: NodeKind.NullStmt } as ASTNode,
        } as Partial<LabelStmt>);
      }
    },

    // Handle `expr && true` → `expr`, `expr || false` → `expr`,
    //        `true && expr` → `expr`, `false || expr` → `expr`,
    //        `expr && false` → `false`, `expr || true` → `true`,
    //        `false && expr` → `false`, `true || expr` → `true`
    visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
      if (node.operator !== '&&' && node.operator !== '||') return undefined;

      const leftBool = node.left.kind === NodeKind.BoolLiteral
        ? (node.left as BoolLiteralExpr).value : null;
      const rightBool = node.right.kind === NodeKind.BoolLiteral
        ? (node.right as BoolLiteralExpr).value : null;

      if (leftBool === null && rightBool === null) return undefined;

      if (node.operator === '&&') {
        // X && true → X; true && X → X
        if (rightBool === true) return node.left;
        if (leftBool === true) return node.right;
        // X && false → false; false && X → false
        if (rightBool === false) return node.right;
        if (leftBool === false) return node.left;
      } else {
        // X || false → X; false || X → X
        if (rightBool === false) return node.left;
        if (leftBool === false) return node.right;
        // X || true → true; true || X → true
        if (rightBool === true) return node.right;
        if (leftBool === true) return node.left;
      }

      return undefined;
    },

    visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
      const stmts = node.statements;
      let changed = false;
      const newStmts: ASTNode[] = [];

      for (let i = 0; i < stmts.length; i++) {
        const stmt = stmts[i];

        if (stmt.kind !== NodeKind.IfStmt) {
          newStmts.push(stmt);
          continue;
        }

        const ifStmt = stmt as IfStmt;
        if (ifStmt.condition.kind !== NodeKind.BoolLiteral) {
          newStmts.push(stmt);
          continue;
        }

        const boolVal = (ifStmt.condition as BoolLiteralExpr).value;
        changed = true;

        if (boolVal) {
          // if (true) { body } [else { ... }] → splice body
          newStmts.push(...unwrapCompound(ifStmt.thenBranch));
        } else {
          // if (false) { ... } → remove, or splice else branch
          if (ifStmt.elseBranch) {
            // else if (...) is represented as an IfStmt elseBranch
            if (ifStmt.elseBranch.kind === NodeKind.IfStmt) {
              // Promote else-if to plain if
              newStmts.push(ifStmt.elseBranch);
            } else {
              newStmts.push(...unwrapCompound(ifStmt.elseBranch));
            }
          }
          // No else → removed entirely
        }
      }

      if (!changed) return undefined;
      return updateNode(node, { statements: newStmts } as Partial<CompoundStmt>);
    },
  });
}

export const deadBranchCleanupPlugin: TransformPlugin = {
  id: 'dead-branch-cleanup',
  name: 'Dead Branch Cleanup',
  description: 'Eliminates if(true)/if(false) dead branches from Ghidra output',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 58,
  tags: ['cleanup', 'dead-code'],
  createTransformer: createDeadBranchCleanupTransformer,
};

/**
 * Short-Circuit Fold Plugin
 *
 * Folds nested guard conditions into short-circuit && expressions.
 *
 * Transforms:
 * - if(a) { if(b) { ... } }  ->  if(a && b) { ... }
 * - if(a) { if(b) { if(c) { ... } } }  ->  if(a && b && c) { ... }
 *
 * This undoes the pattern created by goto-cleanup's forward cascade,
 * which converts `if(a==0) goto L; if(b==0) goto L;` into nested ifs.
 * The bottom-up visitor naturally chains 3+ levels.
 *
 * Bail conditions (semantics would change):
 * - Outer or inner if has an else branch
 * - Outer if is constexpr
 * - Outer compound has extra statements before or after the inner if
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  CompoundStmt,
  IfStmt,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Extract a sole IfStmt from a then-branch.
 * Returns the inner IfStmt if the branch is:
 *   - A direct IfStmt, OR
 *   - A CompoundStmt with exactly 1 IfStmt child
 * Returns null otherwise.
 */
function extractSoleInnerIf(branch: ASTNode): IfStmt | null {
  if (branch.kind === NodeKind.IfStmt) {
    return branch as IfStmt;
  }
  if (branch.kind === NodeKind.CompoundStmt) {
    const compound = branch as CompoundStmt;
    if (compound.statements.length === 1 && compound.statements[0].kind === NodeKind.IfStmt) {
      return compound.statements[0] as IfStmt;
    }
  }
  return null;
}

// ============================================
// TRANSFORMER
// ============================================

export interface ShortCircuitFoldOptions extends PluginOptions {}

function createShortCircuitFoldTransformer(_options: ShortCircuitFoldOptions = {}): Transformer {
  return createTransformer({
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      // Bail if outer has else, is constexpr, or has init
      if (node.elseBranch !== null || node.isConstexpr || node.init) {
        return undefined;
      }

      // Extract sole inner IfStmt from thenBranch
      const inner = extractSoleInnerIf(node.thenBranch);
      if (!inner) {
        return undefined;
      }

      // Bail if inner has else, is constexpr, or has init
      if (inner.elseBranch !== null || inner.isConstexpr || inner.init) {
        return undefined;
      }

      // Build combined condition: outer.condition && inner.condition
      const combined: BinaryExpr = {
        kind: NodeKind.BinaryExpr,
        operator: '&&',
        left: node.condition,
        right: inner.condition,
        location: node.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      // Return new IfStmt with combined condition and inner's thenBranch
      const result: IfStmt = {
        kind: NodeKind.IfStmt,
        condition: combined,
        thenBranch: inner.thenBranch,
        elseBranch: null,
        isConstexpr: false,
        location: node.location,
        leadingTrivia: node.leadingTrivia || [],
        trailingTrivia: node.trailingTrivia || [],
      };

      return result;
    },
  });
}

// ============================================
// PLUGIN EXPORT
// ============================================

/**
 * Short-Circuit Fold Plugin
 *
 * Folds nested guard conditions into `&&` chains for better readability.
 * Runs after goto-cleanup (priority 55) to clean up its output.
 */
export const shortCircuitFoldPlugin: TransformPlugin = {
  id: 'short-circuit-fold',
  name: 'Short-Circuit Fold',
  description: 'Folds if(a){if(b){...}} into if(a&&b){...}',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 57,
  tags: ['cleanup', 'control-flow'],

  createTransformer: createShortCircuitFoldTransformer,
};

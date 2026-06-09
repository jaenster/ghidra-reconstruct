/**
 * Loop Rotation Undo Plugin
 *
 * Reverses MSVC's loop rotation optimization.
 *
 * Transforms:
 * - if(C) { do { body } while(C); }  ->  while(C) { body }
 *
 * MSVC transforms `while(C) { body }` into `if(C) { do { body } while(C); }`
 * for branch prediction. This undoes that transformation when the guard
 * condition and loop condition are structurally identical.
 *
 * Uses `nodesEqual()` for condition comparison, which handles identifiers,
 * member access, complex expressions, and ignores trivia/location.
 *
 * In practice on D2 code, most if-guarded do-while patterns have differing
 * conditions (guard checks one variable, loop tests another) and are correctly
 * left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  CompoundStmt,
  DoWhileStmt,
  IfStmt,
  WhileStmt,
} from '../../../ast/nodes.js';
import { createTransformer, nodesEqual, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Extract a sole DoWhileStmt from a then-branch.
 * Returns the inner DoWhileStmt if the branch is:
 *   - A direct DoWhileStmt, OR
 *   - A CompoundStmt with exactly 1 DoWhileStmt child
 * Returns null otherwise.
 */
function extractSoleDoWhile(branch: ASTNode): DoWhileStmt | null {
  if (branch.kind === NodeKind.DoWhileStmt) {
    return branch as DoWhileStmt;
  }
  if (branch.kind === NodeKind.CompoundStmt) {
    const compound = branch as CompoundStmt;
    if (compound.statements.length === 1 && compound.statements[0].kind === NodeKind.DoWhileStmt) {
      return compound.statements[0] as DoWhileStmt;
    }
  }
  return null;
}

// ============================================
// TRANSFORMER
// ============================================

export interface LoopRotationUndoOptions extends PluginOptions {}

function createLoopRotationUndoTransformer(_options: LoopRotationUndoOptions = {}): Transformer {
  return createTransformer({
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      // Bail if has else or is constexpr
      if (node.elseBranch !== null || node.isConstexpr) {
        return undefined;
      }

      // Extract sole DoWhileStmt from thenBranch
      const doWhile = extractSoleDoWhile(node.thenBranch);
      if (!doWhile) {
        return undefined;
      }

      // Compare if condition with do-while condition
      if (!nodesEqual(node.condition, doWhile.condition)) {
        return undefined;
      }

      // Conditions match -- convert to while loop
      const result: WhileStmt = {
        kind: NodeKind.WhileStmt,
        condition: node.condition,
        body: doWhile.body,
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
 * Loop Rotation Undo Plugin
 *
 * Converts `if(C) { do { body } while(C); }` back to `while(C) { body }`.
 * Runs after goto-cleanup (priority 55) to clean up compiler artifacts.
 */
export const loopRotationUndoPlugin: TransformPlugin = {
  id: 'loop-rotation-undo',
  name: 'Loop Rotation Undo',
  description: 'Converts if(C){do{...}while(C)} to while(C){...}',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 56,
  tags: ['cleanup', 'control-flow', 'loops'],

  createTransformer: createLoopRotationUndoTransformer,
};

/**
 * Redundant Negation Simplification Plugin
 *
 * Simplifies patterns with redundant negation.
 *
 * Transforms:
 * - x + -y  →  x - y
 * - x + -1  →  x - 1
 * - x - -y  →  x + y
 * - x - -1  →  x + 1
 *
 * This makes code more readable when Ghidra outputs patterns like:
 * aOBJECTCLASSID[iVar2 + -0x6ba]
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  BinaryOperator,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Map of operator pairs for negation simplification
 */
const OPPOSITE_OPERATORS: Record<string, BinaryOperator> = {
  '+': '-',
  '-': '+',
};

// ============================================
// TRANSFORMER
// ============================================

export interface RedundantNegationOptions extends PluginOptions {
  /**
   * Also simplify --x to x in binary context (default: false)
   * This is more aggressive and might change semantics in some edge cases
   */
  simplifyDoubleNegation?: boolean;
}

/**
 * Create the redundant negation transformer
 */
function createRedundantNegationTransformer(options: RedundantNegationOptions = {}): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Only process binary expressions
      if (node.kind !== NodeKind.BinaryExpr) {
        return undefined;
      }

      const binary = node as BinaryExpr;

      // Only handle + and - operators
      if (binary.operator !== '+' && binary.operator !== '-') {
        return undefined;
      }

      // Check if right side is a unary negation
      if (binary.right.kind !== NodeKind.UnaryExpr) {
        return undefined;
      }

      const unary = binary.right as UnaryExpr;

      // Only handle unary minus
      if (unary.operator !== '-') {
        return undefined;
      }

      // Get the opposite operator
      const newOperator = OPPOSITE_OPERATORS[binary.operator];
      if (!newOperator) {
        return undefined;
      }

      // Transform: x + -y → x - y, or x - -y → x + y
      const result: BinaryExpr = {
        kind: NodeKind.BinaryExpr,
        operator: newOperator,
        left: binary.left,
        right: unary.operand,
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
 * Redundant Negation Simplification Plugin
 *
 * Simplifies expressions like `x + -y` to `x - y` for better readability.
 */
export const redundantNegationPlugin: TransformPlugin = {
  id: 'redundant-negation',
  name: 'Redundant Negation Simplification',
  description: 'Simplifies X + -Y to X - Y',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 40, // After initial cleanup, before final output
  tags: ['cleanup', 'arithmetic', 'readability'],

  createTransformer: createRedundantNegationTransformer,
};

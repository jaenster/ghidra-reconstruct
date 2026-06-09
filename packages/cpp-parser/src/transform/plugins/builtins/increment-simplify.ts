/**
 * Increment/Decrement Simplification Plugin
 *
 * Transforms verbose self-assignment patterns to compact operators.
 *
 * Transforms:
 * - x = x + 1   →  x++
 * - x = x - 1   →  x--
 * - x = x + n   →  x += n  (when n != 1)
 * - x = x - n   →  x -= n  (when n != 1)
 * - x = x * n   →  x *= n
 * - x = x / n   →  x /= n
 * - x = x % n   →  x %= n
 * - x = x & n   →  x &= n
 * - x = x | n   →  x |= n
 * - x = x ^ n   →  x ^= n
 * - x = x << n  →  x <<= n
 * - x = x >> n  →  x >>= n
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  AssignExpr,
  AssignOperator,
  BinaryExpr,
  BinaryOperator,
  PostfixExpr,
  UnaryExpr,
  IntegerLiteralExpr,
  Identifier,
  MemberExpr,
  SubscriptExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { emit } from '../../../emit/index.js';

// ============================================
// HELPERS
// ============================================

/**
 * Binary operators that can be converted to compound assignment
 */
const COMPOUND_OPERATORS: Partial<Record<BinaryOperator, AssignOperator>> = {
  '+': '+=',
  '-': '-=',
  '*': '*=',
  '/': '/=',
  '%': '%=',
  '&': '&=',
  '|': '|=',
  '^': '^=',
  '<<': '<<=',
  '>>': '>>=',
};

/**
 * Check if two expressions are structurally equivalent
 */
function areExpressionsEqual(a: Expression, b: Expression): boolean {
  // Quick check: same kind
  if (a.kind !== b.kind) return false;

  // Use emit to compare - this handles complex cases
  try {
    const aStr = emit(a).trim();
    const bStr = emit(b).trim();
    return aStr === bStr;
  } catch {
    return false;
  }
}

/**
 * Check if expression is an integer literal with value 1
 */
function isOne(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return (expr as IntegerLiteralExpr).value === 1n;
  }
  return false;
}

/**
 * Check if expression is an integer literal with value -1
 * This handles both literal -1 and unary minus of 1
 */
function isMinusOne(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    const lit = expr as IntegerLiteralExpr;
    // Check for -1 or 0xffffffff etc (which emit as -1)
    return lit.value === -1n ||
           lit.value === BigInt('0xffffffff') ||
           lit.value === BigInt('0xffffffffffffffff');
  }
  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    if (unary.operator === '-') {
      return isOne(unary.operand);
    }
  }
  return false;
}

/**
 * Check if this is a valid lvalue for increment/compound assign
 */
function isValidLValue(expr: Expression): boolean {
  switch (expr.kind) {
    case NodeKind.Identifier:
    case NodeKind.MemberExpr:
    case NodeKind.SubscriptExpr:
    case NodeKind.QualifiedId:
      return true;
    case NodeKind.ParenExpr:
      // Check the inner expression
      return isValidLValue((expr as { expression: Expression }).expression);
    case NodeKind.UnaryExpr:
      // *ptr is a valid lvalue
      return (expr as UnaryExpr).operator === '*';
    default:
      return false;
  }
}

/**
 * Create a postfix increment/decrement expression
 */
function createPostfixExpr(
  operand: Expression,
  operator: '++' | '--',
  original: ASTNode
): PostfixExpr {
  return {
    kind: NodeKind.PostfixExpr,
    operator,
    operand,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

/**
 * Create a compound assignment expression
 */
function createCompoundAssignExpr(
  left: Expression,
  operator: AssignOperator,
  right: Expression,
  original: ASTNode
): AssignExpr {
  return {
    kind: NodeKind.AssignExpr,
    operator,
    left,
    right,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

export interface IncrementSimplifyOptions extends PluginOptions {
  /** Only transform simple identifiers, not complex expressions like a->b */
  simpleOnly?: boolean;
  /** Convert x = x + 1 to x++ even in expression context (default: true) */
  usePostfix?: boolean;
}

/**
 * Create the transformer
 */
function createIncrementSimplifyTransformer(options: IncrementSimplifyOptions = {}): Transformer {
  const { simpleOnly = false, usePostfix = true } = options;

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Only process assignment expressions
      if (node.kind !== NodeKind.AssignExpr) {
        return undefined; // Continue traversal
      }

      const assign = node as AssignExpr;

      // Must be simple assignment (=), not already compound
      if (assign.operator !== '=') {
        return undefined;
      }

      // Right side must be a binary expression
      if (assign.right.kind !== NodeKind.BinaryExpr) {
        return undefined;
      }

      const binary = assign.right as BinaryExpr;
      const left = assign.left;
      const binLeft = binary.left;
      const binRight = binary.right;
      const op = binary.operator;

      // Check if this operator has a compound version
      const compoundOp = COMPOUND_OPERATORS[op];
      if (!compoundOp) {
        return undefined;
      }

      // Left side must be a valid lvalue
      if (!isValidLValue(left)) {
        return undefined;
      }

      // Simple only mode: only transform identifiers
      if (simpleOnly && left.kind !== NodeKind.Identifier) {
        return undefined;
      }

      // Check if: x = x + y (left of assignment equals left of binary)
      if (!areExpressionsEqual(left, binLeft)) {
        return undefined;
      }

      // Special case: x = x + 1 or x = x - 1 → x++ or x--
      if (usePostfix) {
        if (op === '+' && isOne(binRight)) {
          return createPostfixExpr(left, '++', node);
        }
        if (op === '-' && isOne(binRight)) {
          return createPostfixExpr(left, '--', node);
        }
        // x = x + -1 → x--
        if (op === '+' && isMinusOne(binRight)) {
          return createPostfixExpr(left, '--', node);
        }
        // x = x - -1 → x++
        if (op === '-' && isMinusOne(binRight)) {
          return createPostfixExpr(left, '++', node);
        }
      }

      // General case: x = x op y → x op= y
      return createCompoundAssignExpr(left, compoundOp, binRight, node);
    },
  });
}

// ============================================
// PLUGIN EXPORT
// ============================================

export const incrementSimplifyPlugin: TransformPlugin = {
  id: 'increment-simplify',
  name: 'Increment/Decrement Simplification',
  description: 'Transforms x = x + 1 to x++ and x = x op y to x op= y',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 35, // After signed-literal (30), before boolean-cleanup (50)
  tags: ['cleanup', 'readability', 'operators'],

  createTransformer: createIncrementSimplifyTransformer,
};

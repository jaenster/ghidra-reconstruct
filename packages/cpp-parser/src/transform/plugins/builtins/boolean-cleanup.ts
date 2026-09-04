/**
 * Boolean Expression Cleanup Plugin
 *
 * Simplifies redundant boolean expressions from decompiler output.
 *
 * Transforms:
 * - expr != false       →  expr
 * - expr == false       →  !expr
 * - expr != true        →  !expr
 * - expr == true        →  expr
 * - (expr & mask) != 0  →  (expr & mask)  [in boolean context]
 * - (expr) != 0         →  expr           [when expr is boolean-like]
 * - ptr != nullptr      →  ptr
 * - ptr == nullptr      →  !ptr
 * - !!expr              →  (bool)expr or just expr
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  UnaryExpr,
  IntegerLiteralExpr,
  BoolLiteralExpr,
  Identifier,
} from '../../../ast/nodes.js';
import { createTransformer, sequence, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if expression is the literal `false`.
 *
 * The integer `0` is deliberately NOT one of the spellings, though it compares
 * equal to `false`. `x != false` is `x` because a `bool` is already 0 or 1;
 * `x != 0` is `x` only where the result is read for truth, and `x` otherwise is
 * whatever `x` is. Admitting `0` here made this rule fire everywhere and cost a
 * crash — `nSlot = (uint)(*szFileName != 0)` became the first CHARACTER of the
 * log file's name. The integer form belongs to `createZeroComparisonSimplifier`
 * below, which is guarded.
 */
function isFalse(expr: Expression): boolean {
  if (expr.kind === NodeKind.BoolLiteral) {
    return (expr as BoolLiteralExpr).value === false;
  }
  if (expr.kind === NodeKind.Identifier) {
    return (expr as Identifier).name === 'false';
  }
  return false;
}

/**
 * Check if expression is the literal `true`.
 *
 * The integer `1` is excluded for a stronger reason than `isFalse`'s: `x == 1`
 * is not `x` and `x != 1` is not `!x` for ANY context when `x` can be 2. Those
 * equivalences hold for a `bool` and for nothing else.
 */
function isTrue(expr: Expression): boolean {
  if (expr.kind === NodeKind.BoolLiteral) {
    return (expr as BoolLiteralExpr).value === true;
  }
  if (expr.kind === NodeKind.Identifier) {
    return (expr as Identifier).name === 'true';
  }
  return false;
}

/**
 * Check if expression is zero (0 or 0x0)
 */
function isZero(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return (expr as IntegerLiteralExpr).value === 0n;
  }
  return false;
}

/**
 * Unwrap parentheses from expression
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as any).expression;
  }
  return expr;
}

/**
 * Check if expression is a bitwise AND (likely a flag check)
 */
function isBitwiseAnd(expr: Expression): boolean {
  const unwrapped = unwrapParens(expr);
  if (unwrapped.kind === NodeKind.BinaryExpr) {
    return (unwrapped as BinaryExpr).operator === '&';
  }
  return false;
}

/**
 * Check if expression looks like a boolean expression
 */
function isBooleanLike(expr: Expression): boolean {
  const unwrapped = unwrapParens(expr);

  // Comparisons are boolean
  if (unwrapped.kind === NodeKind.BinaryExpr) {
    const op = (unwrapped as BinaryExpr).operator;
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) {
      return true;
    }
  }

  // Negation is boolean
  if (unwrapped.kind === NodeKind.UnaryExpr) {
    if ((unwrapped as UnaryExpr).operator === '!') {
      return true;
    }
  }

  // Function calls ending in Is*, Has*, Can*, etc. are likely boolean
  if (unwrapped.kind === NodeKind.CallExpr) {
    const call = unwrapped as any;
    if (call.callee?.kind === NodeKind.Identifier) {
      const name = (call.callee as Identifier).name;
      if (/^(Is|Has|Can|Should|Will|Did|Was|Are|Have)/.test(name)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create a negation expression
 */
function createNegation(expr: Expression, original: ASTNode): UnaryExpr {
  return {
    kind: NodeKind.UnaryExpr,
    operator: '!',
    operand: expr,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMERS
// ============================================

/**
 * Simplify comparisons with false
 * - expr != false  →  expr
 * - expr == false  →  !expr
 */
function createFalseComparisonSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      // expr != false  →  expr
      if (binary.operator === '!=') {
        if (isFalse(binary.right)) {
          return {
            ...binary.left,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        }
        if (isFalse(binary.left)) {
          return {
            ...binary.right,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        }
      }

      // expr == false  →  !expr
      if (binary.operator === '==') {
        if (isFalse(binary.right)) {
          return createNegation(binary.left, binary);
        }
        if (isFalse(binary.left)) {
          return createNegation(binary.right, binary);
        }
      }

      return undefined;
    },
  });
}

/**
 * Simplify comparisons with true
 * - expr == true  →  expr
 * - expr != true  →  !expr
 */
function createTrueComparisonSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      // expr == true  →  expr
      if (binary.operator === '==') {
        if (isTrue(binary.right)) {
          return {
            ...binary.left,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        }
        if (isTrue(binary.left)) {
          return {
            ...binary.right,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        }
      }

      // expr != true  →  !expr
      if (binary.operator === '!=') {
        if (isTrue(binary.right)) {
          return createNegation(binary.left, binary);
        }
        if (isTrue(binary.left)) {
          return createNegation(binary.right, binary);
        }
      }

      return undefined;
    },
  });
}

/**
 * Simplify zero comparisons in boolean contexts
 * - (flags & MASK) != 0  →  (flags & MASK)
 * - boolExpr != 0        →  boolExpr
 */
function createZeroComparisonSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      // Only handle != 0 and == 0
      if (binary.operator !== '!=' && binary.operator !== '==') {
        return undefined;
      }

      let expr: Expression;
      let isNotEqual: boolean;

      if (isZero(binary.right)) {
        expr = binary.left;
        isNotEqual = binary.operator === '!=';
      } else if (isZero(binary.left)) {
        expr = binary.right;
        isNotEqual = binary.operator === '!=';
      } else {
        return undefined;
      }

      // For bitwise AND, simplify (x & mask) != 0 to (x & mask)
      if (isBitwiseAnd(expr)) {
        if (isNotEqual) {
          return {
            ...expr,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        } else {
          // (x & mask) == 0  →  !(x & mask)
          return createNegation(expr, binary);
        }
      }

      // For boolean-like expressions, simplify
      if (isBooleanLike(expr)) {
        if (isNotEqual) {
          return {
            ...expr,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          };
        } else {
          return createNegation(expr, binary);
        }
      }

      return undefined;
    },
  });
}

/**
 * Check if expression is nullptr
 */
function isNullptr(expr: Expression): boolean {
  if (expr.kind === NodeKind.NullptrLiteral) return true;
  if (expr.kind === NodeKind.Identifier) {
    return (expr as Identifier).name === 'nullptr';
  }
  return false;
}

/**
 * Simplify nullptr comparisons
 * - ptr != nullptr  →  ptr
 * - ptr == nullptr  →  !ptr
 * - nullptr != ptr  →  ptr
 * - nullptr == ptr  →  !ptr
 */
function createNullptrComparisonSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      if (binary.operator !== '!=' && binary.operator !== '==') {
        return undefined;
      }

      let expr: Expression;
      let isNotEqual: boolean;

      if (isNullptr(binary.right)) {
        expr = binary.left;
        isNotEqual = binary.operator === '!=';
      } else if (isNullptr(binary.left)) {
        expr = binary.right;
        isNotEqual = binary.operator === '!=';
      } else {
        return undefined;
      }

      if (isNotEqual) {
        // ptr != nullptr → ptr
        return {
          ...expr,
          leadingTrivia: binary.leadingTrivia,
          trailingTrivia: binary.trailingTrivia,
        };
      } else {
        // ptr == nullptr → !ptr
        return createNegation(expr, binary);
      }
    },
  });
}

/**
 * Simplify double negation
 * - !!expr  →  expr (when already boolean-like)
 */
function createDoubleNegationSimplifier(): Transformer {
  return createTransformer({
    visitUnaryExpr(unary) {
      if (unary.operator !== '!') {
        return undefined;
      }

      const inner = unwrapParens(unary.operand);

      if (inner.kind === NodeKind.UnaryExpr) {
        const innerUnary = inner as UnaryExpr;
        if (innerUnary.operator === '!') {
          // !!expr - check if innermost is boolean-like
          const innermost = unwrapParens(innerUnary.operand);
          if (isBooleanLike(innermost)) {
            return {
              ...innerUnary.operand,
              leadingTrivia: unary.leadingTrivia,
              trailingTrivia: unary.trailingTrivia,
            };
          }
        }
      }

      return undefined;
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface BooleanCleanupOptions extends PluginOptions {
  /** Simplify comparisons with false (default: true) */
  simplifyFalseComparison?: boolean;

  /** Simplify comparisons with true (default: true) */
  simplifyTrueComparison?: boolean;

  /** Simplify zero comparisons in boolean context (default: true) */
  simplifyZeroComparison?: boolean;

  /** Simplify double negation (default: true) */
  simplifyDoubleNegation?: boolean;

  /** Simplify nullptr comparisons: ptr != nullptr → ptr (default: true) */
  simplifyNullptrComparison?: boolean;
}

/**
 * Boolean Expression Cleanup Plugin
 *
 * Simplifies redundant boolean expressions like `!= false`,
 * `== true`, `!= 0` in boolean contexts, etc.
 */
export const booleanCleanupPlugin: TransformPlugin = {
  id: 'boolean-cleanup',
  name: 'Boolean Expression Cleanup',
  description:
    'Simplify redundant boolean expressions (expr != false → expr)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 50, // Mid pipeline
  tags: ['core', 'cleanup', 'boolean'],

  createTransformer(options?: BooleanCleanupOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    if (opts.simplifyFalseComparison !== false) {
      transforms.push(createFalseComparisonSimplifier());
    }

    if (opts.simplifyTrueComparison !== false) {
      transforms.push(createTrueComparisonSimplifier());
    }

    if (opts.simplifyZeroComparison !== false) {
      transforms.push(createZeroComparisonSimplifier());
    }

    if (opts.simplifyDoubleNegation !== false) {
      transforms.push(createDoubleNegationSimplifier());
    }

    if (opts.simplifyNullptrComparison !== false) {
      transforms.push(createNullptrComparisonSimplifier());
    }

    return sequence(...transforms);
  },
};

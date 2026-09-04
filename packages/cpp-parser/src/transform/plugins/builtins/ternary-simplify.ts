/**
 * Ternary/Boolean Simplification Plugin
 *
 * Simplifies redundant boolean and ternary expressions.
 *
 * Transforms:
 * - (x != 0) ? 1 : 0       →  x != 0  (or just x for booleans)
 * - (x == 0) ? 0 : 1       →  x != 0
 * - (x) ? true : false     →  !!x (or x if already boolean)
 * - (x) ? false : true     →  !x
 * - (bool)(x ^ 1)          →  !x
 * - !(x == y)              →  x != y
 * - !(x != y)              →  x == y
 * - !(x < y)               →  x >= y
 * - x == true              →  x
 * - x == false             →  !x
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  BinaryOperator,
  UnaryExpr,
  ConditionalExpr,
  IntegerLiteralExpr,
  BoolLiteralExpr,
  Identifier,
  ParenExpr,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if expression is a boolean literal (0 or 1, or true/false)
 */
function isBooleanLiteral(expr: Expression): { value: boolean } | null {
  if (expr.kind === NodeKind.IntegerLiteral) {
    const val = (expr as IntegerLiteralExpr).value;
    if (val === 0n) return { value: false };
    if (val === 1n) return { value: true };
  }

  if (expr.kind === NodeKind.Identifier) {
    const name = (expr as Identifier).name;
    if (name === 'true') return { value: true };
    if (name === 'false') return { value: false };
  }

  return null;
}

/**
 * Check if expression is a REAL boolean literal — `true`/`false`, never `1`/`0`.
 *
 * `isBooleanLiteral` above accepts the integers because `cond ? 1 : 0` really is
 * `cond`: the ternary's own branches say the result is 0 or 1. A COMPARISON
 * against a literal says no such thing. `x == 1` is `x` and `x != 1` is `!x`
 * only when `x` is a `bool`; for an `int` that can be 2 both are simply wrong,
 * and `x != 0` is `x` only where the value is read for truth — Ghidra writes
 * `nSlot = (uint)(*szFileName != 0)` for a `SETNZ`, and dropping the comparison
 * there made the log manager's slot index the first CHARACTER of the file name.
 */
function isBoolKeywordLiteral(expr: Expression): { value: boolean } | null {
  if (expr.kind === NodeKind.BoolLiteral) {
    return { value: (expr as BoolLiteralExpr).value === true };
  }
  if (expr.kind === NodeKind.Identifier) {
    const name = (expr as Identifier).name;
    if (name === 'true') return { value: true };
    if (name === 'false') return { value: false };
  }
  return null;
}

/**
 * Check if expression is zero
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
 * Check if expression is a comparison operation
 */
function isComparison(expr: Expression): expr is BinaryExpr {
  expr = unwrapParens(expr);
  if (expr.kind !== NodeKind.BinaryExpr) return false;
  const op = (expr as BinaryExpr).operator;
  return ['==', '!=', '<', '>', '<=', '>='].includes(op);
}

/**
 * Get comparison if expression is one (unwrapping parens)
 */
function getComparison(expr: Expression): BinaryExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind !== NodeKind.BinaryExpr) return null;
  const op = (expr as BinaryExpr).operator;
  if (['==', '!=', '<', '>', '<=', '>='].includes(op)) {
    return expr as BinaryExpr;
  }
  return null;
}

/**
 * Get the opposite comparison operator
 */
function negateComparisonOp(op: BinaryOperator): BinaryOperator | null {
  switch (op) {
    case '==': return '!=';
    case '!=': return '==';
    case '<': return '>=';
    case '>': return '<=';
    case '<=': return '>';
    case '>=': return '<';
    default: return null;
  }
}

// ============================================
// TERNARY SIMPLIFICATION
// ============================================

/**
 * Simplify ternary expressions with boolean results
 */
function createTernarySimplifier(): Transformer {
  return createTransformer({
    visitNode(node) {
      if (node.kind !== NodeKind.ConditionalExpr) return undefined;

      const ternary = node as ConditionalExpr;
      const trueBool = isBooleanLiteral(ternary.thenExpr);
      const falseBool = isBooleanLiteral(ternary.elseExpr);

      // (cond) ? 1 : 0  or  (cond) ? true : false
      if (trueBool?.value === true && falseBool?.value === false) {
        // If condition is already a comparison, just return it
        if (isComparison(ternary.condition)) {
          return ternary.condition;
        }

        // Otherwise, keep the condition (it's effectively a bool cast)
        return ternary.condition;
      }

      // (cond) ? 0 : 1  or  (cond) ? false : true  →  !cond
      if (trueBool?.value === false && falseBool?.value === true) {
        // If condition is a comparison, negate it
        const cmp = getComparison(ternary.condition);
        if (cmp) {
          const negatedOp = negateComparisonOp(cmp.operator);
          if (negatedOp) {
            return updateNode(cmp, { operator: negatedOp });
          }
        }

        // Otherwise, add ! prefix
        return {
          kind: NodeKind.UnaryExpr,
          operator: '!',
          operand: ternary.condition,
          prefix: true,
          location: ternary.location,
          leadingTrivia: ternary.leadingTrivia,
          trailingTrivia: ternary.trailingTrivia,
        } as UnaryExpr;
      }

      return undefined;
    },
  });
}

// ============================================
// BOOLEAN COMPARISON SIMPLIFICATION
// ============================================

/**
 * Simplify comparisons with boolean literals
 */
function createBoolComparisonSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      // x == true  →  x
      if (binary.operator === '==') {
        const rightBool = isBoolKeywordLiteral(binary.right);
        if (rightBool?.value === true) {
          return binary.left;
        }
        const leftBool = isBoolKeywordLiteral(binary.left);
        if (leftBool?.value === true) {
          return binary.right;
        }
      }

      // x == false  →  !x
      if (binary.operator === '==') {
        const rightBool = isBoolKeywordLiteral(binary.right);
        if (rightBool?.value === false) {
          return {
            kind: NodeKind.UnaryExpr,
            operator: '!',
            operand: binary.left,
            prefix: true,
            location: binary.location,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          } as UnaryExpr;
        }
      }

      // x != true  →  !x
      if (binary.operator === '!=') {
        const rightBool = isBoolKeywordLiteral(binary.right);
        if (rightBool?.value === true) {
          return {
            kind: NodeKind.UnaryExpr,
            operator: '!',
            operand: binary.left,
            prefix: true,
            location: binary.location,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          } as UnaryExpr;
        }
      }

      // x != false  →  x
      if (binary.operator === '!=') {
        const rightBool = isBoolKeywordLiteral(binary.right);
        if (rightBool?.value === false) {
          return binary.left;
        }
      }

      return undefined;
    },
  });
}

// ============================================
// NEGATION SIMPLIFICATION
// ============================================

/**
 * Simplify negation of comparisons
 */
function createNegationSimplifier(): Transformer {
  return createTransformer({
    visitUnaryExpr(unary) {
      if (unary.operator !== '!') return undefined;

      // !(x == y)  →  x != y
      // !(x != y)  →  x == y
      // !(x < y)   →  x >= y
      // etc.
      const cmp = getComparison(unary.operand);
      if (cmp) {
        const negatedOp = negateComparisonOp(cmp.operator);
        if (negatedOp) {
          return updateNode(cmp, {
            operator: negatedOp,
            leadingTrivia: unary.leadingTrivia,
            trailingTrivia: unary.trailingTrivia,
          });
        }
      }

      // !!x  →  x (when context expects boolean)
      // Be conservative here - only simplify if inner is already boolean
      const innerUnwrapped = unwrapParens(unary.operand);
      if (innerUnwrapped.kind === NodeKind.UnaryExpr) {
        const inner = innerUnwrapped as UnaryExpr;
        if (inner.operator === '!') {
          const innerCmp = getComparison(inner.operand);
          if (innerCmp) {
            // !!comparison → comparison
            return updateNode(innerCmp, {
              leadingTrivia: unary.leadingTrivia,
              trailingTrivia: unary.trailingTrivia,
            });
          }
        }
      }

      return undefined;
    },
  });
}

// ============================================
// XOR BOOLEAN PATTERN
// ============================================

/**
 * Simplify x ^ 1 to !x when used as boolean
 */
function createXorBooleanSimplifier(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      if (binary.operator !== '^') return undefined;

      // x ^ 1  →  !x (boolean flip)
      if (binary.right.kind === NodeKind.IntegerLiteral) {
        const val = (binary.right as IntegerLiteralExpr).value;
        if (val === 1n) {
          return {
            kind: NodeKind.UnaryExpr,
            operator: '!',
            operand: binary.left,
            prefix: true,
            location: binary.location,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          } as UnaryExpr;
        }
      }

      // 1 ^ x  →  !x
      if (binary.left.kind === NodeKind.IntegerLiteral) {
        const val = (binary.left as IntegerLiteralExpr).value;
        if (val === 1n) {
          return {
            kind: NodeKind.UnaryExpr,
            operator: '!',
            operand: binary.right,
            prefix: true,
            location: binary.location,
            leadingTrivia: binary.leadingTrivia,
            trailingTrivia: binary.trailingTrivia,
          } as UnaryExpr;
        }
      }

      return undefined;
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface TernarySimplifyOptions extends PluginOptions {
  /** Simplify ternary with boolean results (default: true) */
  simplifyTernary?: boolean;

  /** Simplify comparisons with true/false (default: true) */
  simplifyBoolComparison?: boolean;

  /** Simplify negation of comparisons (default: true) */
  simplifyNegation?: boolean;

  /** Simplify x ^ 1 to !x (default: true) */
  simplifyXorBoolean?: boolean;
}

/**
 * Ternary/Boolean Simplification Plugin
 *
 * Simplifies redundant boolean and ternary expressions
 * for more readable code.
 */
export const ternarySimplifyPlugin: TransformPlugin = {
  id: 'ternary-simplify',
  name: 'Ternary & Boolean Simplification',
  description:
    'Simplify ternary and boolean expressions (e.g., x ? 1 : 0 → x, !(a == b) → a != b)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 55, // After struct field, before general cleanup
  tags: ['core', 'cleanup', 'boolean'],

  createTransformer(options?: TernarySimplifyOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    if (opts.simplifyTernary !== false) {
      transforms.push(createTernarySimplifier());
    }

    if (opts.simplifyBoolComparison !== false) {
      transforms.push(createBoolComparisonSimplifier());
    }

    if (opts.simplifyNegation !== false) {
      transforms.push(createNegationSimplifier());
    }

    if (opts.simplifyXorBoolean !== false) {
      transforms.push(createXorBooleanSimplifier());
    }

    return sequence(...transforms);
  },
};

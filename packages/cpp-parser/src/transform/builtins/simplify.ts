/**
 * Simplify Transformer
 *
 * Simplifies AST expressions through constant folding, identity
 * elimination, and other algebraic optimizations.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  UnaryExpr,
  IntegerLiteralExpr,
  FloatingLiteralExpr,
  BoolLiteralExpr,
  ConditionalExpr,
  ParenExpr,
  BinaryOperator,
  UnaryOperator,
} from '../../ast/nodes.js';
import { Expr } from '../../ast/factory.js';
import {
  type Transformer,
  createTransformer,
  updateNode,
  sequence,
  fixpoint,
} from '../transformer.js';

// ============================================
// TYPES
// ============================================

/**
 * Options for the simplify transformer
 */
export interface SimplifyOptions {
  /** Fold constant expressions. Default: true */
  constantFolding?: boolean;

  /** Simplify algebraic identities (x + 0, x * 1, etc.). Default: true */
  algebraicSimplification?: boolean;

  /** Simplify boolean expressions. Default: true */
  booleanSimplification?: boolean;

  /** Remove unnecessary parentheses. Default: true */
  removeParens?: boolean;

  /** Simplify conditional expressions with constant conditions. Default: true */
  constantConditions?: boolean;

  /** Apply simplifications repeatedly until no more changes. Default: false */
  fixpoint?: boolean;

  /** Maximum iterations for fixpoint. Default: 10 */
  maxIterations?: number;
}

// ============================================
// CONSTANT FOLDING
// ============================================

/**
 * Fold constant integer expressions
 */
function foldIntegerBinary(
  left: bigint,
  op: BinaryOperator,
  right: bigint
): bigint | null {
  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right !== 0n ? left / right : null;
    case '%': return right !== 0n ? left % right : null;
    case '&': return left & right;
    case '|': return left | right;
    case '^': return left ^ right;
    case '<<': return left << right;
    case '>>': return left >> right;
    default: return null;
  }
}

/**
 * Fold constant integer comparisons
 */
function foldIntegerComparison(
  left: bigint,
  op: BinaryOperator,
  right: bigint
): boolean | null {
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    default: return null;
  }
}

/**
 * Fold constant float expressions
 */
function foldFloatBinary(
  left: number,
  op: BinaryOperator,
  right: number
): number | null {
  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right !== 0 ? left / right : null;
    default: return null;
  }
}

/**
 * Fold constant float comparisons
 */
function foldFloatComparison(
  left: number,
  op: BinaryOperator,
  right: number
): boolean | null {
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    default: return null;
  }
}

/**
 * Fold constant boolean expressions
 */
function foldBooleanBinary(
  left: boolean,
  op: BinaryOperator,
  right: boolean
): boolean | null {
  switch (op) {
    case '&&': return left && right;
    case '||': return left || right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: return null;
  }
}

/**
 * Fold unary operations on constants
 */
function foldUnary(
  op: UnaryOperator,
  value: bigint | number | boolean
): bigint | number | boolean | null {
  if (typeof value === 'bigint') {
    switch (op) {
      case '-': return -value;
      case '+': return value;
      case '~': return ~value;
      default: return null;
    }
  }

  if (typeof value === 'number') {
    switch (op) {
      case '-': return -value;
      case '+': return value;
      default: return null;
    }
  }

  if (typeof value === 'boolean') {
    switch (op) {
      case '!': return !value;
      default: return null;
    }
  }

  return null;
}

// ============================================
// CONSTANT FOLDING TRANSFORMER
// ============================================

/**
 * Create a transformer that folds constant expressions
 */
export function createConstantFoldingTransformer(): Transformer {
  return createTransformer({
    visitBinaryExpr(node) {
      const { left, right, operator } = node;

      // Integer constant folding
      if (
        left.kind === NodeKind.IntegerLiteral &&
        right.kind === NodeKind.IntegerLiteral
      ) {
        const l = (left as IntegerLiteralExpr).value;
        const r = (right as IntegerLiteralExpr).value;

        // Try arithmetic
        const result = foldIntegerBinary(l, operator, r);
        if (result !== null) {
          return updateNode(Expr.intLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }

        // Try comparison
        const boolResult = foldIntegerComparison(l, operator, r);
        if (boolResult !== null) {
          return updateNode(Expr.boolLiteral(boolResult), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      // Float constant folding
      if (
        left.kind === NodeKind.FloatingLiteral &&
        right.kind === NodeKind.FloatingLiteral
      ) {
        const l = (left as FloatingLiteralExpr).value;
        const r = (right as FloatingLiteralExpr).value;

        const result = foldFloatBinary(l, operator, r);
        if (result !== null) {
          return updateNode(Expr.floatLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }

        const boolResult = foldFloatComparison(l, operator, r);
        if (boolResult !== null) {
          return updateNode(Expr.boolLiteral(boolResult), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      // Boolean constant folding
      if (
        left.kind === NodeKind.BoolLiteral &&
        right.kind === NodeKind.BoolLiteral
      ) {
        const l = (left as BoolLiteralExpr).value;
        const r = (right as BoolLiteralExpr).value;

        const result = foldBooleanBinary(l, operator, r);
        if (result !== null) {
          return updateNode(Expr.boolLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      return undefined;
    },

    visitUnaryExpr(node) {
      const { operand, operator } = node;

      if (operand.kind === NodeKind.IntegerLiteral) {
        const value = (operand as IntegerLiteralExpr).value;
        const result = foldUnary(operator, value);
        if (result !== null && typeof result === 'bigint') {
          return updateNode(Expr.intLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      if (operand.kind === NodeKind.FloatingLiteral) {
        const value = (operand as FloatingLiteralExpr).value;
        const result = foldUnary(operator, value);
        if (result !== null && typeof result === 'number') {
          return updateNode(Expr.floatLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      if (operand.kind === NodeKind.BoolLiteral) {
        const value = (operand as BoolLiteralExpr).value;
        const result = foldUnary(operator, value);
        if (result !== null && typeof result === 'boolean') {
          return updateNode(Expr.boolLiteral(result), {
            location: node.location,
            leadingTrivia: node.leadingTrivia,
            trailingTrivia: node.trailingTrivia,
          });
        }
      }

      return undefined;
    },

    visitNode(node) {
      // Handle ConditionalExpr
      if (node.kind === NodeKind.ConditionalExpr) {
        const condExpr = node as ConditionalExpr;
        if (condExpr.condition.kind === NodeKind.BoolLiteral) {
          const cond = (condExpr.condition as BoolLiteralExpr).value;
          return cond ? condExpr.thenExpr : condExpr.elseExpr;
        }
      }
      return undefined;
    },
  });
}

// ============================================
// ALGEBRAIC SIMPLIFICATION
// ============================================

/**
 * Check if an expression is the integer literal 0
 */
function isZero(expr: Expression): boolean {
  return expr.kind === NodeKind.IntegerLiteral &&
    (expr as IntegerLiteralExpr).value === 0n;
}

/**
 * Check if an expression is the integer literal 1
 */
function isOne(expr: Expression): boolean {
  return expr.kind === NodeKind.IntegerLiteral &&
    (expr as IntegerLiteralExpr).value === 1n;
}

/**
 * Check if an expression is a boolean true
 */
function isTrue(expr: Expression): boolean {
  return expr.kind === NodeKind.BoolLiteral &&
    (expr as BoolLiteralExpr).value === true;
}

/**
 * Check if an expression is a boolean false
 */
function isFalse(expr: Expression): boolean {
  return expr.kind === NodeKind.BoolLiteral &&
    (expr as BoolLiteralExpr).value === false;
}

/**
 * Create a transformer that simplifies algebraic identities
 */
export function createAlgebraicSimplificationTransformer(): Transformer {
  return createTransformer({
    visitBinaryExpr(node) {
      const { left, right, operator } = node;

      // x + 0 = x, 0 + x = x
      if (operator === '+') {
        if (isZero(right)) return left;
        if (isZero(left)) return right;
      }

      // x - 0 = x
      if (operator === '-') {
        if (isZero(right)) return left;
        // 0 - x = -x (we could simplify to unary, but leave for now)
      }

      // x * 1 = x, 1 * x = x
      if (operator === '*') {
        if (isOne(right)) return left;
        if (isOne(left)) return right;
        // x * 0 = 0, 0 * x = 0
        if (isZero(right)) return right;
        if (isZero(left)) return left;
      }

      // x / 1 = x
      if (operator === '/') {
        if (isOne(right)) return left;
      }

      // x | 0 = x, 0 | x = x
      if (operator === '|') {
        if (isZero(right)) return left;
        if (isZero(left)) return right;
      }

      // x & 0 = 0, 0 & x = 0
      if (operator === '&') {
        if (isZero(right)) return right;
        if (isZero(left)) return left;
      }

      // x ^ 0 = x, 0 ^ x = x
      if (operator === '^') {
        if (isZero(right)) return left;
        if (isZero(left)) return right;
      }

      // x << 0 = x, x >> 0 = x
      if (operator === '<<' || operator === '>>') {
        if (isZero(right)) return left;
      }

      return undefined;
    },

    visitUnaryExpr(node) {
      // --x simplifies to x (for literals)
      if (node.operator === '-' && node.operand.kind === NodeKind.UnaryExpr) {
        const inner = node.operand as UnaryExpr;
        if (inner.operator === '-') {
          return inner.operand;
        }
      }

      // !!x simplifies to x (for booleans)
      if (node.operator === '!' && node.operand.kind === NodeKind.UnaryExpr) {
        const inner = node.operand as UnaryExpr;
        if (inner.operator === '!') {
          return inner.operand;
        }
      }

      return undefined;
    },
  });
}

// ============================================
// BOOLEAN SIMPLIFICATION
// ============================================

/**
 * Create a transformer that simplifies boolean expressions
 */
export function createBooleanSimplificationTransformer(): Transformer {
  return createTransformer({
    visitBinaryExpr(node) {
      const { left, right, operator } = node;

      // true && x = x, x && true = x
      if (operator === '&&') {
        if (isTrue(left)) return right;
        if (isTrue(right)) return left;
        // false && x = false, x && false = false
        if (isFalse(left)) return left;
        if (isFalse(right)) return right;
      }

      // false || x = x, x || false = x
      if (operator === '||') {
        if (isFalse(left)) return right;
        if (isFalse(right)) return left;
        // true || x = true, x || true = true
        if (isTrue(left)) return left;
        if (isTrue(right)) return right;
      }

      return undefined;
    },

    visitUnaryExpr(node) {
      // !true = false, !false = true
      if (node.operator === '!' && node.operand.kind === NodeKind.BoolLiteral) {
        const value = (node.operand as BoolLiteralExpr).value;
        return updateNode(Expr.boolLiteral(!value), {
          location: node.location,
          leadingTrivia: node.leadingTrivia,
          trailingTrivia: node.trailingTrivia,
        });
      }

      return undefined;
    },
  });
}

// ============================================
// PARENTHESES REMOVAL
// ============================================

/**
 * Create a transformer that removes unnecessary parentheses
 */
export function createRemoveParensTransformer(): Transformer {
  return createTransformer({
    visitNode(node) {
      // Only handle ParenExpr
      if (node.kind !== NodeKind.ParenExpr) {
        return undefined;
      }

      const paren = node as ParenExpr;
      const inner = paren.expression;

      // Remove parens around literals and identifiers
      if (
        inner.kind === NodeKind.IntegerLiteral ||
        inner.kind === NodeKind.FloatingLiteral ||
        inner.kind === NodeKind.StringLiteral ||
        inner.kind === NodeKind.CharLiteral ||
        inner.kind === NodeKind.BoolLiteral ||
        inner.kind === NodeKind.NullptrLiteral ||
        inner.kind === NodeKind.Identifier
      ) {
        return updateNode(inner, {
          leadingTrivia: paren.leadingTrivia,
          trailingTrivia: paren.trailingTrivia,
        });
      }

      // Remove double parentheses ((expr))
      if (inner.kind === NodeKind.ParenExpr) {
        return inner;
      }

      return undefined;
    },
  });
}

// ============================================
// COMBINED SIMPLIFY TRANSFORMER
// ============================================

/**
 * Create a transformer that applies all simplifications
 */
export function createSimplifyTransformer(options: SimplifyOptions = {}): Transformer {
  const {
    constantFolding = true,
    algebraicSimplification = true,
    booleanSimplification = true,
    removeParens = true,
    constantConditions = true,
    fixpoint: useFixpoint = false,
    maxIterations = 10,
  } = options;

  const transformers: Transformer[] = [];

  if (constantFolding || constantConditions) {
    transformers.push(createConstantFoldingTransformer());
  }

  if (algebraicSimplification) {
    transformers.push(createAlgebraicSimplificationTransformer());
  }

  if (booleanSimplification) {
    transformers.push(createBooleanSimplificationTransformer());
  }

  if (removeParens) {
    transformers.push(createRemoveParensTransformer());
  }

  if (transformers.length === 0) {
    return (node) => node;
  }

  const combined = sequence(...transformers);

  if (useFixpoint) {
    return fixpoint(combined, maxIterations);
  }

  return combined;
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Simplify an AST with default options
 */
export function simplify(options?: SimplifyOptions): Transformer {
  return createSimplifyTransformer(options);
}

/**
 * Apply constant folding only
 */
export const constantFold = createConstantFoldingTransformer;

/**
 * Apply algebraic simplification only
 */
export const algebraicSimplify = createAlgebraicSimplificationTransformer;

/**
 * Apply boolean simplification only
 */
export const booleanSimplify = createBooleanSimplificationTransformer;

/**
 * Remove unnecessary parentheses only
 */
export const removeParens = createRemoveParensTransformer;

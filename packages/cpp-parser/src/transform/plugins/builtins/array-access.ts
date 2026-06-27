/**
 * Array Access Plugin
 *
 * Transforms pointer arithmetic patterns into array notation.
 *
 * Transforms:
 * - *(ptr + i)        →  ptr[i]
 * - *(i + ptr)        →  ptr[i]
 * - *(ptr + offset)   →  ptr[offset]
 * - ptr[0]            →  *ptr (optional)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Identifier,
  UnaryExpr,
  BinaryExpr,
  SubscriptExpr,
  ParenExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  createKindTransformer,
  updateNode,
  sequence,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if an expression is a pointer type (heuristic based on naming)
 * In full implementation, this would use type information
 */
function looksLikePointer(expr: Expression): boolean {
  if (expr.kind === NodeKind.Identifier) {
    const name = (expr as Identifier).name;
    // Common pointer naming patterns in Ghidra output
    return (
      name.startsWith('p') || // pVar, param
      name.includes('ptr') ||
      name.includes('Ptr') ||
      name.startsWith('local_') || // Could be pointer
      name.startsWith('param_') // Could be pointer
    );
  }

  // Cast expressions often indicate pointers
  if (expr.kind === NodeKind.CStyleCastExpr) {
    return true;
  }

  return false;
}

/**
 * Check if expression is an index-like value (integer or integer variable)
 */
function looksLikeIndex(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    return true;
  }

  if (expr.kind === NodeKind.Identifier) {
    const name = (expr as Identifier).name;
    // Common index naming patterns
    return (
      name === 'i' ||
      name === 'j' ||
      name === 'k' ||
      name === 'n' ||
      name === 'idx' ||
      name === 'index' ||
      name.startsWith('local_') ||
      /^[ijk]\d*$/.test(name)
    );
  }

  return false;
}

/**
 * Unwrap parentheses from an expression
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

// ============================================
// POINTER ARITHMETIC TO SUBSCRIPT
// ============================================

/**
 * Transform *(ptr + i) to ptr[i]
 */
function createPointerToSubscriptTransformer(): Transformer {
  return createKindTransformer(NodeKind.UnaryExpr, (node) => {
    const unary = node as UnaryExpr;

    // Only handle dereference
    if (unary.operator !== '*') return undefined;

    // Unwrap any parentheses
    const operand = unwrapParens(unary.operand);

    // Check for addition
    if (operand.kind !== NodeKind.BinaryExpr) return undefined;

    const binary = operand as BinaryExpr;
    if (binary.operator !== '+') return undefined;

    // Determine which is the base and which is the index
    let base: Expression;
    let index: Expression;

    // Try left as base first
    if (looksLikePointer(binary.left)) {
      base = binary.left;
      index = binary.right;
    } else if (looksLikePointer(binary.right)) {
      // Commutative: i + ptr
      base = binary.right;
      index = binary.left;
    } else {
      // Can't determine which is the pointer, use left as default
      base = binary.left;
      index = binary.right;
    }

    // Create subscript expression
    return {
      kind: NodeKind.SubscriptExpr,
      array: base,
      index: index,
      location: unary.location,
      leadingTrivia: unary.leadingTrivia,
      trailingTrivia: unary.trailingTrivia,
    } as SubscriptExpr;
  });
}

/**
 * Transform *(cast)(ptr + i) to ((cast)ptr)[i]
 * Handles patterns like: *(int *)(param_1 + i)
 *
 * UNSOUND — kept only behind an explicit opt-in. In Ghidra output the form
 * `*(T*)(base + N)` is a BYTE offset (N is in bytes, computed before the cast),
 * so rewriting it to `((T*)base)[N]` re-scales N by sizeof(T) and reads the
 * WRONG address. The faithful emission is to leave it as a deref, so this is
 * OFF by default (see castPointerArithmetic).
 */
function createCastPointerToSubscriptTransformer(): Transformer {
  return createKindTransformer(NodeKind.UnaryExpr, (node) => {
    const unary = node as UnaryExpr;

    if (unary.operator !== '*') return undefined;

    // Check if operand is a cast
    if (unary.operand.kind !== NodeKind.CStyleCastExpr) return undefined;

    const cast = unary.operand as CStyleCastExpr;

    // Check if the cast expression is an addition
    const inner = unwrapParens(cast.expression);
    if (inner.kind !== NodeKind.BinaryExpr) return undefined;

    const binary = inner as BinaryExpr;
    if (binary.operator !== '+') return undefined;

    // Determine base and index
    let base: Expression = binary.left;
    let index: Expression = binary.right;

    // If right looks more like a pointer, swap
    if (looksLikePointer(binary.right) && !looksLikePointer(binary.left)) {
      base = binary.right;
      index = binary.left;
    }

    // Create: ((cast_type)base)[index]
    const castBase: CStyleCastExpr = {
      kind: NodeKind.CStyleCastExpr,
      type: cast.type,
      expression: base,
      location: cast.location,
      leadingTrivia: [],
      trailingTrivia: [],
    };

    return {
      kind: NodeKind.SubscriptExpr,
      array: castBase,
      index: index,
      location: unary.location,
      leadingTrivia: unary.leadingTrivia,
      trailingTrivia: unary.trailingTrivia,
    } as SubscriptExpr;
  });
}

// ============================================
// SUBSCRIPT TO DEREFERENCE (OPTIONAL)
// ============================================

/**
 * Transform ptr[0] to *ptr (optional cleanup)
 */
function createSubscriptZeroToDerefTransformer(): Transformer {
  return createKindTransformer(NodeKind.SubscriptExpr, (node) => {
    const subscript = node as SubscriptExpr;

    // Check if index is 0
    if (subscript.index.kind !== NodeKind.IntegerLiteral) return undefined;

    const literal = subscript.index as IntegerLiteralExpr;
    if (literal.value !== 0n) return undefined;

    // Transform to *ptr
    return {
      kind: NodeKind.UnaryExpr,
      operator: '*',
      operand: subscript.array,
      location: subscript.location,
      leadingTrivia: subscript.leadingTrivia,
      trailingTrivia: subscript.trailingTrivia,
    } as UnaryExpr;
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface ArrayAccessOptions extends PluginOptions {
  /** Transform *(ptr + i) to ptr[i] (default: true) */
  pointerArithmetic?: boolean;

  /** Transform *(cast)(ptr + i) to ((cast)ptr)[i] (default: false — UNSOUND,
   * re-scales byte offsets; only enable when the offset is element-scaled) */
  castPointerArithmetic?: boolean;

  /** Transform ptr[0] to *ptr (default: false) */
  subscriptZeroToDeref?: boolean;
}

/**
 * Array Access Plugin
 *
 * Transforms pointer arithmetic patterns into more readable
 * array subscript notation.
 */
export const arrayAccessPlugin: TransformPlugin = {
  id: 'array-access',
  name: 'Array Access Transformation',
  description:
    'Transform pointer arithmetic like *(ptr + i) to array notation ptr[i]',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 45, // After loop canonicalization, before struct field
  tags: ['core', 'cleanup', 'pointers'],

  createTransformer(options?: ArrayAccessOptions) {
    const opts = options ?? {};
    const transforms: Transformer[] = [];

    // Pointer arithmetic is on by default
    if (opts.pointerArithmetic !== false) {
      transforms.push(createPointerToSubscriptTransformer());
    }

    // Cast pointer arithmetic is OFF by default — it re-scales byte offsets
    // (`*(T*)(base+N)` -> `((T*)base)[N]`) and corrupts the address. Opt in only
    // when the offset is known to be element-scaled.
    if (opts.castPointerArithmetic === true) {
      transforms.push(createCastPointerToSubscriptTransformer());
    }

    // Subscript zero to deref is off by default
    if (opts.subscriptZeroToDeref) {
      transforms.push(createSubscriptZeroToDerefTransformer());
    }

    return sequence(...transforms);
  },
};

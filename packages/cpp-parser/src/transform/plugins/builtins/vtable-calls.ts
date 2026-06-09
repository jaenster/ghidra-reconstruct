/**
 * VTable Call Pattern Plugin
 *
 * Transforms C++ virtual function call patterns into readable method calls.
 *
 * Ghidra produces extremely ugly patterns for vtable calls:
 *   (**(code **)(*this + 0x10))(this, param_1)
 *
 * This plugin transforms them to:
 *   this->vmethod_10(param_1)
 *
 * Also handles:
 * - (**(code **)(*(long *)this + offset))(this, ...)
 * - (*(void (**)(void *))(*obj + offset))(obj)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  UnaryExpr,
  CallExpr,
  MemberExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  Identifier,
  ParenExpr,
  SubscriptExpr,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// TYPES
// ============================================

export interface VTableInfo {
  /** The object pointer (this) */
  object: Expression;

  /** Offset into vtable */
  vtableOffset: number;

  /** Arguments to the virtual call (excluding this) */
  args: Expression[];

  /** Whether 'this' was passed as first arg */
  hasThisArg: boolean;
}

// ============================================
// HELPERS
// ============================================

/**
 * Unwrap parentheses from an expression
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

/**
 * Unwrap casts from an expression
 */
function unwrapCasts(expr: Expression): Expression {
  while (expr.kind === NodeKind.CStyleCastExpr) {
    expr = (expr as CStyleCastExpr).expression;
  }
  return unwrapParens(expr);
}

/**
 * Get integer value from literal
 */
function getIntValue(expr: Expression): number | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.IntegerLiteral) {
    const val = (expr as IntegerLiteralExpr).value;
    if (val >= 0n && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(val);
    }
  }
  return null;
}

/**
 * Check if two expressions refer to the same identifier
 */
function sameIdentifier(a: Expression, b: Expression): boolean {
  a = unwrapParens(unwrapCasts(a));
  b = unwrapParens(unwrapCasts(b));

  if (a.kind === NodeKind.Identifier && b.kind === NodeKind.Identifier) {
    return (a as Identifier).name === (b as Identifier).name;
  }
  return false;
}

/**
 * Check if expression is a dereference (*expr)
 */
function isDeref(expr: Expression): UnaryExpr | null {
  expr = unwrapParens(expr);
  if (expr.kind === NodeKind.UnaryExpr) {
    const unary = expr as UnaryExpr;
    // UnaryExpr is always prefix (PostfixExpr handles postfix operators)
    if (unary.operator === '*') {
      return unary;
    }
  }
  return null;
}

/**
 * Check if expression is a pointer addition (ptr + offset)
 */
function isPtrAdd(expr: Expression): { base: Expression; offset: number } | null {
  expr = unwrapParens(unwrapCasts(expr));

  if (expr.kind !== NodeKind.BinaryExpr) return null;

  const binary = expr as BinaryExpr;
  if (binary.operator !== '+') return null;

  // Try right as offset
  const rightOffset = getIntValue(binary.right);
  if (rightOffset !== null) {
    return { base: binary.left, offset: rightOffset };
  }

  // Try left as offset
  const leftOffset = getIntValue(binary.left);
  if (leftOffset !== null) {
    return { base: binary.right, offset: leftOffset };
  }

  return null;
}

// ============================================
// VTABLE PATTERN DETECTION
// ============================================

/**
 * Detect vtable call pattern:
 *
 * Pattern 1: (**(code **)(*this + offset))(this, args...)
 * Pattern 2: (*(void (**)(...)(*this + offset))(this, args...)
 * Pattern 3: (**(code **)(*(type *)this + offset))(this, args...)
 *
 * The key structure is:
 * - Call expression
 * - Callee is double-dereference of (base + offset)
 * - First argument is same as base
 */
function detectVTableCall(call: CallExpr): VTableInfo | null {
  const callee = unwrapParens(call.callee);

  // Must start with a dereference
  const outerDeref = isDeref(callee);
  if (!outerDeref) return null;

  // What's being dereferenced?
  let innerExpr = unwrapParens(unwrapCasts(outerDeref.operand));

  // Could be another dereference: **(ptr + offset)
  const innerDeref = isDeref(innerExpr);
  if (innerDeref) {
    innerExpr = unwrapParens(unwrapCasts(innerDeref.operand));
  }

  // Now look for (base + offset) or *(base) + offset or subscript ((int**)base)[index]
  let baseExpr: Expression | null = null;
  let vtableOffset = 0;

  // Direct addition: (*this + offset)
  const addInfo = isPtrAdd(innerExpr);
  if (addInfo) {
    // Base might be *this or just this
    const baseDeref = isDeref(addInfo.base);
    if (baseDeref) {
      baseExpr = baseDeref.operand;
    } else {
      baseExpr = addInfo.base;
    }
    vtableOffset = addInfo.offset;
  } else if (innerExpr.kind === NodeKind.SubscriptExpr) {
    // Array subscript pattern: ((int**)param_1)[8]
    const subscript = innerExpr as SubscriptExpr;
    const idx = getIntValue(subscript.index);
    if (idx !== null) {
      // The array base may be cast, unwrap it
      const arrayBase = unwrapParens(unwrapCasts(subscript.array));
      // Base might be *this or just this
      const baseDeref = isDeref(arrayBase);
      if (baseDeref) {
        baseExpr = baseDeref.operand;
      } else {
        baseExpr = arrayBase;
      }
      // For subscript, the offset is index * pointer_size (handled later in generateMethodName)
      // We store the raw byte offset so it's consistent with pointer arithmetic
      vtableOffset = idx * 4; // 32-bit pointer size
    }
  } else {
    // Might be just *this (offset 0)
    const baseDeref = isDeref(innerExpr);
    if (baseDeref) {
      baseExpr = baseDeref.operand;
      vtableOffset = 0;
    }
  }

  if (!baseExpr) return null;

  baseExpr = unwrapParens(unwrapCasts(baseExpr));

  // Check if first argument matches the base object
  const args = call.arguments;

  let hasThisArg = false;
  if (args.length > 0) {
    const firstArg = unwrapParens(unwrapCasts(args[0]));
    hasThisArg = sameIdentifier(baseExpr, firstArg);
  }

  return {
    object: baseExpr,
    vtableOffset,
    args: hasThisArg ? args.slice(1) : args,
    hasThisArg,
  };
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Generate method name from vtable offset
 */
function generateMethodName(offset: number, pointerSize: number): string {
  if (offset === 0) {
    return 'vmethod_0'; // Could be destructor
  }
  const slot = Math.floor(offset / pointerSize);
  return `vmethod_${slot}`;
}

function createVTableCallTransformer(pointerSize = 4): Transformer {
  return createTransformer({
    visitCallExpr(call) {
      const vtableInfo = detectVTableCall(call);

      if (!vtableInfo) return undefined;

      // Generate method name
      const methodName = generateMethodName(vtableInfo.vtableOffset, pointerSize);

      // Create member identifier
      const methodId: Identifier = {
        kind: NodeKind.Identifier,
        name: methodName,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      // Create member expression: object->method
      const memberExpr: MemberExpr = {
        kind: NodeKind.MemberExpr,
        object: vtableInfo.object,
        member: methodId,
        isArrow: true,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      // Create new call expression
      return updateNode(call, {
        callee: memberExpr,
        arguments: vtableInfo.args,
      });
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface VTableCallOptions extends PluginOptions {
  /** Generate method names from offset (default: true) */
  generateMethodNames?: boolean;

  /** Pointer size in bytes for slot calculation (default: 4 for 32-bit) */
  pointerSize?: number;

  /** Known vtable layouts for better naming */
  vtableLayouts?: Map<string, string[]>;
}

/**
 * VTable Call Pattern Plugin
 *
 * Transforms C++ vtable call patterns into readable method calls.
 */
export const vtableCallPlugin: TransformPlugin = {
  id: 'vtable-calls',
  name: 'VTable Call Cleanup',
  description:
    'Transform C++ vtable call patterns to method calls (e.g., (**(code **)(*this + 0x10))(this, x) → this->vmethod_2(x))',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 30, // Early in pipeline, before other transforms
  tags: ['core', 'cleanup', 'cpp'],

  createTransformer(options?: VTableCallOptions) {
    return createVTableCallTransformer(options?.pointerSize ?? 4);
  },
};

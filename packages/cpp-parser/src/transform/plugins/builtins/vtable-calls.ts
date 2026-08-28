/**
 * VTable Call Pattern Plugin
 *
 * Ghidra produces extremely ugly patterns for vtable calls:
 *   (**(code **)(*this + 0x10))(this, param_1)
 *
 * The readable rendering is `this->vmethod_4(param_1)`, but that only compiles
 * when the object's type is a class/struct that actually DECLARES `vmethod_4`.
 * Reconstructed C has no such classes: the object is a `void*`, a `vtable*`, an
 * `int`, or a struct whose members are byte-offset fields — so the readable form
 * is a member that does not exist ("'void*' is not a pointer-to-object type",
 * "request for member 'vmethod_25' in '*p', which is of non-class type 'int'").
 *
 * So the readable form is emitted only where it can be checked — an actual `this`
 * inside a converted method — and every other site gets the faithful indirect
 * call, the same shape the function-pointer-table branch already used:
 *
 *   (**(code**)((char*)*(void**)(uintptr_t)obj + 0x10))(obj, param_1)
 *
 * `(uintptr_t)` first so an object Ghidra typed as a scalar converts, `(char*)`
 * so the offset stays byte-wise, and the ORIGINAL argument list so the `this`
 * the pattern passed by hand is preserved exactly.
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
import { Expr, Type } from '../../../ast/factory.js';
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

  /** True when the base was a dereference (`*this + off` — a real object vtable);
   *  false when the base is the table itself (`arr + off` — a function-pointer table). */
  baseWasDeref: boolean;
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
 * The object of a real C++ method call — `this`, or the identifier a converted
 * method uses for it. Only here does a class exist to declare `vmethod_N`.
 */
function isThisExpr(expr: Expression): boolean {
  const e = unwrapParens(unwrapCasts(expr));
  if (e.kind === NodeKind.ThisExpr) return true;
  return e.kind === NodeKind.Identifier && (e as Identifier).name === 'this';
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
  let baseWasDeref = false;

  // Direct addition: (*this + offset)
  const addInfo = isPtrAdd(innerExpr);
  if (addInfo) {
    // Base might be *this or just this
    const baseDeref = isDeref(addInfo.base);
    if (baseDeref) {
      baseExpr = baseDeref.operand;
      baseWasDeref = true;
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
        baseWasDeref = true;
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
      baseWasDeref = true;
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
    baseWasDeref,
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

      // Function-POINTER TABLE (`arr + off`, base not dereferenced): there is no
      // object whose class carries `vmethod_N`, so `base->vmethod_N` is ill-formed.
      // Emit the faithful byte-offset indirect call instead — `(char*)` keeps the
      // arithmetic byte-wise (not scaled by the element size) and `code**`
      // double-deref reproduces the table read exactly. Keep the ORIGINAL args.
      if (!vtableInfo.baseWasDeref) {
        const codePtrPtr = Type.pointer(Type.pointer(Type.builtin('code')));
        const charCast = Expr.cast(Type.pointer(Type.builtin('char')), vtableInfo.object);
        const slotAddr = vtableInfo.vtableOffset === 0
          ? charCast
          : Expr.paren(Expr.add(charCast, Expr.intLiteral(vtableInfo.vtableOffset)));
        const fn = Expr.unary('*', Expr.unary('*', Expr.cast(codePtrPtr, slotAddr)));
        return updateNode(call, { callee: Expr.paren(fn), arguments: call.arguments });
      }

      // Real object vtable (`*this + off`). `obj->vmethod_N` names a member that
      // only exists when obj is a class instance — true for a converted method's
      // `this`, false for every reconstructed C object. Everywhere else, emit the
      // indirect call through the object's vtable pointer, which is what the
      // machine does and what Ghidra decompiled.
      if (!isThisExpr(vtableInfo.object)) {
        const codePtrPtr = Type.pointer(Type.pointer(Type.builtin('code')));
        const objWord = Expr.cast(Type.builtin('uintptr_t'), vtableInfo.object);
        const vtable = Expr.unary('*', Expr.cast(Type.pointer(Type.pointer(Type.void())), objWord));
        const charCast = Expr.cast(Type.pointer(Type.builtin('char')), vtable);
        const slotAddr = vtableInfo.vtableOffset === 0
          ? charCast
          : Expr.paren(Expr.add(charCast, Expr.intLiteral(vtableInfo.vtableOffset)));
        const fn = Expr.unary('*', Expr.unary('*', Expr.cast(codePtrPtr, slotAddr)));
        return updateNode(call, { callee: Expr.paren(fn), arguments: call.arguments });
      }

      const methodName = generateMethodName(vtableInfo.vtableOffset, pointerSize);
      const methodId: Identifier = {
        kind: NodeKind.Identifier,
        name: methodName,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };
      const memberExpr: MemberExpr = {
        kind: NodeKind.MemberExpr,
        object: vtableInfo.object,
        member: methodId,
        isArrow: true,
        location: call.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };
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

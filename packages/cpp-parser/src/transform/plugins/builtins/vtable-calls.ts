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
 * inside a converted method. Where the receiver's DECLARED type is a class whose
 * first word is a typed vtable pointer, the call goes through that table with the
 * slot's own signature (`dispatch` option):
 *
 *   obj->pVtable->OnMouseUp(obj, param_1)
 *
 * which also puts back the object the machine passes in ECX and an untyped call
 * drops. Every other site gets the indirect call, the same shape the
 * function-pointer-table branch already used:
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
function isThisExpr(expr: Expression, thisIsClassInstance: boolean): boolean {
  if (!thisIsClassInstance) return false;
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
    // `(*a[2])(args)` through a TYPED array of function pointers is already a typed
    // call: the element is the function. Only an untyped base - a cast `((int**)p)[8]`
    // or a second dereference - is a raw table this pass has to spell. Treating the
    // typed form as one turned `(*gapObjectOperateCallbacks[2])(pGame, pUnit)` into
    // `(**(code**)((char*)gapObjectOperateCallbacks + 8))(pGame, pUnit)`, discarding the
    // funcdef Ghidra gave the array (quest state handlers, object operate callbacks,
    // room deactivation handlers, DRLG flag operations).
    const typedElement = !innerDeref && unwrapParens(subscript.array).kind !== NodeKind.CStyleCastExpr;
    const idx = typedElement ? null : getIntValue(subscript.index);
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

/** A slot of a typed vtable, as the header declares it. */
export interface VTableDispatchSlot {
  member: string;
  /** Parameters the slot's pointer type lists, `this` included when it takes one. */
  arity: number;
  /** The slot is `__thiscall`: its emitted pointer type takes the object first. */
  takesThis: boolean;
}

/** Where an object's typed vtable pointer is, and what its slots take. */
export interface VTableDispatch {
  /** Class name → member path to its vtable pointer, and that vtable's type name. */
  classes: Record<string, { vfptrPath: string[]; vtable: string }>;
  /** Vtable type name → byte offset → slot. */
  vtables: Record<string, Record<number, VTableDispatchSlot>>;
  /** Parameter/local name → declared type spelling, for the body being transformed. */
  receiverTypes?: Record<string, string>;
  /** Global name → declared type spelling. */
  globalTypes?: Record<string, string>;
}

/** `T *`, `struct T *`, `::T *` → `T`; anything but one pointer to a name → undefined. */
function pointeeName(spelling: string | undefined): string | undefined {
  if (!spelling) return undefined;
  const s = spelling.replace(/\b(struct|class|const|volatile)\b/g, ' ').replace(/\s+/g, '');
  const m = s.match(/^(?:::)?([A-Za-z_][\w:]*)\*$/);
  return m ? m[1] : undefined;
}

function ident(name: string, location: CallExpr['location']): Identifier {
  return { kind: NodeKind.Identifier, name, location, leadingTrivia: [], trailingTrivia: [] };
}

function member(object: Expression, name: string, isArrow: boolean, location: CallExpr['location']): MemberExpr {
  return {
    kind: NodeKind.MemberExpr, object, member: ident(name, location), isArrow,
    location, leadingTrivia: [], trailingTrivia: [],
  };
}

/**
 * The call through the receiver's own typed vtable, or undefined when the receiver's
 * declared type does not say which table it holds or the slot's arity disagrees with
 * the arguments the machine passes.
 *
 * The machine passes the object in ECX; Ghidra drops it from an untyped call. A
 * `__thiscall` slot is emitted with the object as its first parameter, so it is put
 * back there. A slot that does not take one keeps the argument list Ghidra printed.
 */
function typedDispatch(call: CallExpr, info: VTableInfo, dispatch: VTableDispatch): CallExpr | undefined {
  const obj = info.object;
  // `this` is still Ghidra's ThisExpr here; `this-param-rewrite` renames it later.
  let name: string;
  if (obj.kind === NodeKind.Identifier) name = (obj as Identifier).name;
  else if (obj.kind === NodeKind.ThisExpr) name = 'this';
  else return undefined;
  const spelled = dispatch.receiverTypes?.[name] ?? dispatch.globalTypes?.[name];
  const pointee = pointeeName(spelled);
  if (!pointee) return undefined;
  const cls = dispatch.classes[pointee] ?? dispatch.classes[pointee.replace(/^.*::/, '')];
  if (!cls) return undefined;
  const slot = dispatch.vtables[cls.vtable]?.[info.vtableOffset];
  if (!slot) return undefined;

  const given = call.arguments;
  const args = slot.takesThis && !info.hasThisArg ? [obj, ...given] : [...given];
  if (args.length !== slot.arity) return undefined;

  let table: Expression = obj;
  cls.vfptrPath.forEach((m, i) => { table = member(table, m, i === 0, call.location); });
  return updateNode(call, {
    callee: member(table, slot.member, true, call.location),
    arguments: args,
  });
}

function createVTableCallTransformer(
  pointerSize = 4,
  thisIsClassInstance = true,
  dispatch?: VTableDispatch,
): Transformer {
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
      if (!isThisExpr(vtableInfo.object, thisIsClassInstance)) {
        const typed = dispatch ? typedDispatch(call, vtableInfo, dispatch) : undefined;
        if (typed) return typed;
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

  /**
   * Whether a `this` in the body is the `this` of a real C++ method, whose class can
   * declare `vmethod_N` (default: true). The generator emits every `__thiscall`
   * function as a FREE function: Ghidra's `this` is its `void *` ECX argument, which
   * `this-param-rewrite` (priority 46) renames only after this pass (30) has run. Read
   * as a class `this`, it became `pThis->vmethod_0(...)` on a `void *` - "'void*' is
   * not a pointer-to-object type", seven strict errors. The generator passes false
   * for every function that is not a converted method.
   */
  thisIsClassInstance?: boolean;

  /**
   * Typed vtables, and the declared types of the names a body can use as a receiver.
   * A virtual call whose receiver is declared as a class with a typed vtable pointer
   * is spelled through that table (`obj->pVtable->Slot(obj, x)`), with the slot's own
   * signature, instead of as an untyped indirect call that drops the object.
   */
  dispatch?: VTableDispatch;
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
    return createVTableCallTransformer(
      options?.pointerSize ?? 4,
      options?.thisIsClassInstance ?? true,
      options?.dispatch,
    );
  },
};

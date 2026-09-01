/**
 * Nullptr Cleanup Plugin
 *
 * Converts explicit null pointer casts to nullptr.
 *
 * Transforms:
 * - (Type*)0x0        →  nullptr
 * - (Type*)0          →  nullptr
 * - (void*)0x0        →  nullptr
 * - &DAT_00000000     →  nullptr
 * - _DAT_000000NN     →  *(int32_t*)0xNN   (small-address null+offset deref)
 * - &_DAT_000000NN    →  (void*)0xNN       (the small address itself)
 *
 * And, when the generator asks for it, the reverse for the places Ghidra hands
 * out `nullptr` for an integer zero: `x = nullptr` → `x = 0`, and
 * `return nullptr;` → `return 0;` in a function that does not return a pointer.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  Expression,
  CStyleCastExpr,
  IntegerLiteralExpr,
  Identifier,
  ReturnStmt,
  UnaryExpr,
  BuiltinType,
  PointerType,
  VariableDecl,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if an expression is a zero literal (0, 0x0, 0x00, etc.)
 */
function isZeroLiteral(expr: Expression): boolean {
  if (expr.kind === NodeKind.IntegerLiteral) {
    const lit = expr as IntegerLiteralExpr;
    return lit.value === 0n;
  }
  return false;
}

/**
 * Create a nullptr identifier
 */
function createNullptr(original: ASTNode): Identifier {
  return {
    kind: NodeKind.Identifier,
    name: 'nullptr',
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Create the nullptr cleanup transformer
 */
/**
 * Check if an expression is &DAT_00000000 (address-of null)
 */
function isAddressOfNull(node: ASTNode): boolean {
  if (node.kind !== NodeKind.UnaryExpr) return false;
  const unary = node as UnaryExpr;
  if (unary.operator !== '&') return false;
  if (unary.operand.kind !== NodeKind.Identifier) return false;
  return (unary.operand as Identifier).name === 'DAT_00000000';
}

const SMALL_ADDR_DAT_RE = /^_?DAT_([0-9a-fA-F]{8})$/;

function matchSmallAddressDat(node: ASTNode): number | null {
  if (node.kind !== NodeKind.Identifier) return null;
  const name = (node as Identifier).name;
  const m = SMALL_ADDR_DAT_RE.exec(name);
  if (!m) return null;
  const addr = parseInt(m[1], 16);
  if (addr === 0 || addr >= 0x1000) return null;
  return addr;
}

/**
 * `&DAT_0000000a` — the ADDRESS of a small-address placeholder, which is how the
 * decompiler spells the constant 10 where the surrounding expression is
 * pointer-typed. `&DAT_00000000 → nullptr` is the same rule at zero.
 *
 * Composing the two rules above renders it `&*(int32_t*)0xa`, which invents an
 * element type the address never had — and that invention decides comparisons:
 * `pKeyLen == &*(int32_t*)0x10` is "distinct pointer types char* and int32_t*",
 * while `pKeyLen == (void*)0x10` is the composite-pointer comparison C++ allows
 * against any object pointer. So match the address-of form directly and emit the
 * address with no element type at all.
 */
function matchAddressOfSmallDat(node: ASTNode): number | null {
  if (node.kind !== NodeKind.UnaryExpr) return null;
  const unary = node as UnaryExpr;
  if (unary.operator !== '&') return null;
  const operand = unwrapParens(unary.operand);
  const asIdentifier = matchSmallAddressDat(operand);
  if (asIdentifier !== null) return asIdentifier;
  // The walk rewrites children first, so by the time this `&` is visited its
  // operand is usually the deref `createCastDeref` already produced. Match that
  // shape too — `&*(int32_t*)0xNN` is the same expression, one pass later.
  if (operand.kind !== NodeKind.UnaryExpr) return null;
  const deref = operand as UnaryExpr;
  if (deref.operator !== '*') return null;
  const cast = unwrapParens(deref.operand);
  if (cast.kind !== NodeKind.CStyleCastExpr) return null;
  const castExpr = cast as CStyleCastExpr;
  if (castExpr.type.kind !== NodeKind.PointerType) return null;
  const pointee = (castExpr.type as PointerType).pointee;
  if (pointee.kind !== NodeKind.BuiltinType || (pointee as BuiltinType).name !== 'int32_t') return null;
  const lit = unwrapParens(castExpr.expression);
  if (lit.kind !== NodeKind.IntegerLiteral) return null;
  const addr = Number((lit as IntegerLiteralExpr).value);
  if (addr <= 0 || addr >= 0x1000) return null;
  return addr;
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as any).expression;
  return e;
}

/** `(void*)0xNN` — the address, carrying no element type it does not have. */
function createVoidAddress(address: number, original: ASTNode): CStyleCastExpr {
  const voidType: BuiltinType = {
    kind: NodeKind.BuiltinType,
    name: 'void',
    modifiers: [],
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const ptrType: PointerType = {
    kind: NodeKind.PointerType,
    pointee: voidType,
    qualifiers: [],
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const addrLiteral: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(address),
    suffix: '',
    base: 16,
    raw: '0x' + address.toString(16),
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  return {
    kind: NodeKind.CStyleCastExpr,
    type: ptrType,
    expression: addrLiteral,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

function createCastDeref(address: number, original: ASTNode): UnaryExpr {
  const int32Type: BuiltinType = {
    kind: NodeKind.BuiltinType,
    name: 'int32_t',
    modifiers: [],
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const ptrType: PointerType = {
    kind: NodeKind.PointerType,
    pointee: int32Type,
    qualifiers: [],
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const addrLiteral: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(address),
    suffix: '',
    base: 16,
    raw: '0x' + address.toString(16),
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  const cast: CStyleCastExpr = {
    kind: NodeKind.CStyleCastExpr,
    type: ptrType,
    expression: addrLiteral,
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
  return {
    kind: NodeKind.UnaryExpr,
    operator: '*',
    operand: cast,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  } as UnaryExpr;
}

/**
 * A small-address constant, after any chain of pointer casts is stripped.
 *
 * Ghidra spells the constant N as `&DAT_0000000N` — and then often wraps it in
 * whatever pointer type it inferred for the surrounding expression, so the real
 * shape in the wild is `(D2ArchiveStrc *)&DAT_00000004`. None of those casts
 * carry information: address 4 is not mapped, so the operand is the integer 4
 * and the pointer types are type-inference noise on a constant.
 *
 * Returns the literal when the expression is (a chain of pointer casts over) the
 * `(void*)0xNN` this pass produces, and null otherwise.
 */
function smallAddressUnderPointerCasts(expr: Expression): IntegerLiteralExpr | null {
  let e = unwrapParens(expr);
  let sawPointerCast = false;
  while (e.kind === NodeKind.CStyleCastExpr && (e as CStyleCastExpr).type.kind === NodeKind.PointerType) {
    sawPointerCast = true;
    e = unwrapParens((e as CStyleCastExpr).expression);
  }
  if (!sawPointerCast) return null;
  if (e.kind !== NodeKind.IntegerLiteral) return null;
  const v = (e as IntegerLiteralExpr).value;
  if (v <= 0n || v >= 0x1000n) return null;
  return e as IntegerLiteralExpr;
}

const COMPARISON_OPERATORS = new Set(['<', '>', '<=', '>=', '==', '!=']);

/**
 * Is this operand something C++ will treat as an integer, on syntax alone?
 *
 * Only two shapes are taken as proof, both of them local and unambiguous: an
 * integer literal, and a cast to a non-pointer type. An identifier is NOT proof —
 * the plugin has no type table, and guessing from a name is how a wrong cast gets
 * inserted in the first place.
 */
function isSyntacticallyInteger(expr: Expression): boolean {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.IntegerLiteral) return true;
  if (e.kind === NodeKind.CStyleCastExpr) {
    const t = (e as CStyleCastExpr).type;
    return t.kind !== NodeKind.PointerType && t.kind !== NodeKind.ArrayType;
  }
  return false;
}

/** Is this the nullptr constant, either as parsed or as this pass produced it? */
function isNullptr(expr: Expression): boolean {
  if (expr.kind === NodeKind.NullptrLiteral) return true;
  return expr.kind === NodeKind.Identifier && (expr as Identifier).name === 'nullptr';
}

function createZero(original: ASTNode): IntegerLiteralExpr {
  return {
    kind: NodeKind.IntegerLiteral,
    value: 0n,
    suffix: '',
    base: 10,
    raw: '0',
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

/**
 * `nullptr` on the right of `=`, `==`, `!=` or in an initializer only type-checks
 * against a pointer, and Ghidra hands out `nullptr` for what the declared type
 * says is an integer ("cannot convert nullptr_t to uint32_t"). `0` is a valid
 * value for BOTH pointers and integers, so rewriting those positions is safe
 * without knowing the type.
 */
function zeroForNullptrOperand(node: ASTNode): ASTNode | undefined {
  if (node.kind === NodeKind.AssignExpr) {
    const assign = node as AssignExpr;
    if (!isNullptr(assign.right)) return undefined;
    return updateNode(assign, { right: createZero(assign.right) } as Partial<AssignExpr>);
  }

  if (node.kind === NodeKind.BinaryExpr) {
    const bin = node as BinaryExpr;
    // ==, !=, <=, >= — the comparison operators that end in '='
    if (!bin.operator.endsWith('=')) return undefined;
    if (!isNullptr(bin.right)) return undefined;
    return updateNode(bin, { right: createZero(bin.right) } as Partial<BinaryExpr>);
  }

  if (node.kind === NodeKind.VariableDecl) {
    const decl = node as VariableDecl;
    if (!decl.initializer || !isNullptr(decl.initializer)) return undefined;
    return updateNode(decl, {
      initializer: createZero(decl.initializer),
    } as Partial<VariableDecl>);
  }

  return undefined;
}

/**
 * `return nullptr;` from a function whose return type is not a pointer is the
 * same mismatch. Whether the return type IS a pointer is not visible in the
 * body AST (the body is parsed on its own), so the generator states it.
 */
function zeroForReturnedNullptr(node: ASTNode): ASTNode | undefined {
  if (node.kind !== NodeKind.ReturnStmt) return undefined;
  const ret = node as ReturnStmt;
  if (!ret.value || !isNullptr(ret.value)) return undefined;
  return updateNode(ret, { value: createZero(ret.value) } as Partial<ReturnStmt>);
}

function createNullptrCleanup(options: NullptrCleanupOptions = {}): Transformer {
  const zeroAssigned = options.zeroForAssignedNullptr ?? false;
  const zeroReturned = options.zeroForReturnedNullptr ?? false;

  return createTransformer({
    visitNode(node) {
      if (zeroReturned) {
        const zeroed = zeroForReturnedNullptr(node);
        if (zeroed) return zeroed;
      }

      if (zeroAssigned) {
        const zeroed = zeroForNullptrOperand(node);
        if (zeroed) return zeroed;
      }

      // &DAT_00000000 → nullptr
      if (isAddressOfNull(node)) {
        return createNullptr(node);
      }

      // &_DAT_000000NN (address of a small address) → (void*)0xNN. Must be
      // tested BEFORE the bare-identifier rule below, which would otherwise turn
      // the operand into a deref and leave `&*` wrapped around it.
      const addrOfSmall = matchAddressOfSmallDat(node);
      if (addrOfSmall !== null) {
        return createVoidAddress(addrOfSmall, node);
      }

      // _DAT_000000NN (small address) → *(int32_t*)0xNN
      const smallAddr = matchSmallAddressDat(node);
      if (smallAddr !== null) {
        return createCastDeref(smallAddr, node);
      }

      // `(T*)(void*)0xNN` → `(T*)0xNN`. Ghidra's own pointer cast already says
      // what type it thinks the constant has; the `(void*)` this pass adds under
      // it is a second, contradictory answer to the same question.
      if (node.kind === NodeKind.CStyleCastExpr) {
        const outer = node as CStyleCastExpr;
        if (outer.type.kind === NodeKind.PointerType) {
          const inner = unwrapParens(outer.expression);
          if (inner.kind === NodeKind.CStyleCastExpr) {
            const innerCast = inner as CStyleCastExpr;
            const it = innerCast.type;
            if (
              it.kind === NodeKind.PointerType &&
              (it as PointerType).pointee.kind === NodeKind.BuiltinType &&
              ((it as PointerType).pointee as BuiltinType).name === 'void' &&
              unwrapParens(innerCast.expression).kind === NodeKind.IntegerLiteral
            ) {
              const lit = unwrapParens(innerCast.expression) as IntegerLiteralExpr;
              if (lit.value > 0n && lit.value < 0x1000n) {
                return updateNode(outer, { expression: lit });
              }
            }
          }
        }
      }

      // A comparison against something that is provably an integer. The small
      // address is a constant, not a pointer, so the pointer spelling is what has
      // to go — casting the INTEGER side to a pointer would be inventing one.
      if (node.kind === NodeKind.BinaryExpr) {
        const bin = node as BinaryExpr;
        if (COMPARISON_OPERATORS.has(bin.operator)) {
          const leftLit = smallAddressUnderPointerCasts(bin.left);
          const rightLit = smallAddressUnderPointerCasts(bin.right);
          if (leftLit && !rightLit && isSyntacticallyInteger(bin.right)) {
            return updateNode(bin, { left: leftLit });
          }
          if (rightLit && !leftLit && isSyntacticallyInteger(bin.left)) {
            return updateNode(bin, { right: rightLit });
          }
        }
      }

      // Only handle C-style cast expressions
      if (node.kind !== NodeKind.CStyleCastExpr) {
        return undefined;
      }

      const cast = node as CStyleCastExpr;
      const targetType = cast.type;

      // Check if it's a pointer type
      let isPointer = false;
      if (targetType.kind === NodeKind.PointerType) {
        isPointer = true;
      }

      if (!isPointer) {
        return undefined;
      }

      // Check if the expression is zero
      let expr = cast.expression;

      // Unwrap parentheses
      while (expr.kind === NodeKind.ParenExpr) {
        expr = (expr as any).expression;
      }

      if (isZeroLiteral(expr)) {
        return createNullptr(cast);
      }

      return undefined;
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface NullptrCleanupOptions extends PluginOptions {
  /** Also convert NULL macro if detected (default: true) */
  convertNullMacro?: boolean;

  /** Rewrite `nullptr` to `0` where it is assigned, initialized or compared (default: false) */
  zeroForAssignedNullptr?: boolean;

  /** Rewrite `return nullptr;` to `return 0;` — set when the return type is not a pointer (default: false) */
  zeroForReturnedNullptr?: boolean;
}

/**
 * Nullptr Cleanup Plugin
 *
 * Converts explicit null pointer casts like (Type*)0x0 to nullptr
 * for cleaner, more modern C++ code.
 */
export const nullptrCleanupPlugin: TransformPlugin = {
  id: 'nullptr-cleanup',
  name: 'Nullptr Cleanup',
  description:
    'Convert explicit null pointer casts (Type*)0x0 to nullptr',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 25, // Early in pipeline
  tags: ['core', 'cleanup', 'modernize'],

  createTransformer(options?: NullptrCleanupOptions) {
    return createNullptrCleanup(options ?? {});
  },
};

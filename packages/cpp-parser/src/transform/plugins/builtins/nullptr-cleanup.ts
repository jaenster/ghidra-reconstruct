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
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  CStyleCastExpr,
  IntegerLiteralExpr,
  Identifier,
  UnaryExpr,
  BuiltinType,
  PointerType,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
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

function createNullptrCleanup(): Transformer {
  return createTransformer({
    visitNode(node) {
      // &DAT_00000000 → nullptr
      if (isAddressOfNull(node)) {
        return createNullptr(node);
      }

      // _DAT_000000NN (small address) → *(int32_t*)0xNN
      const smallAddr = matchSmallAddressDat(node);
      if (smallAddr !== null) {
        return createCastDeref(smallAddr, node);
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

  createTransformer(_options?: NullptrCleanupOptions) {
    return createNullptrCleanup();
  },
};

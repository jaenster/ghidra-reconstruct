/**
 * Pointer Cast Normalize Plugin
 *
 * Transforms `(int)&expr` → `(uintptr_t)&expr` for x86-32 pointer arithmetic.
 *
 * Ghidra's decompiler emits `(int)ptr` for 32-bit address math because int
 * and pointer are both 32 bits on x86-32. This is technically correct for
 * the target platform but breaks portable C++ compilation. The standard
 * `uintptr_t` type conveys the same semantics without narrowing warnings.
 *
 * Also handles `(uint32_t)&expr` and `(int32_t)&expr` variants.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  CStyleCastExpr,
  UnaryExpr,
  BuiltinType,
  TypedefType,
  Identifier,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// Builtin type names that represent 32-bit integers (parsed as BuiltinType)
const BUILTIN_INT_NAMES = new Set(['int']);

// Typedef type names that represent 32-bit integers (parsed as TypedefType)
const TYPEDEF_INT_NAMES = new Set(['int32_t', 'uint32_t']);

function isAddressOfExpr(node: ASTNode): node is UnaryExpr {
  return node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&';
}

function getTypeName(cast: CStyleCastExpr): string | null {
  const type = cast.type;
  if (type.kind === NodeKind.BuiltinType) {
    const bt = type as BuiltinType;
    if (bt.modifiers.length > 0) return null;
    return BUILTIN_INT_NAMES.has(bt.name) ? bt.name : null;
  }
  if (type.kind === NodeKind.TypedefType) {
    const td = type as TypedefType;
    const name = (td.name as Identifier).name;
    return TYPEDEF_INT_NAMES.has(name) ? name : null;
  }
  return null;
}

function createPointerCastNormalize(): Transformer {
  return createTransformer({
    visitNode(node) {
      if (node.kind !== NodeKind.CStyleCastExpr) return undefined;
      const cast = node as CStyleCastExpr;

      if (!getTypeName(cast)) return undefined;
      if (!isAddressOfExpr(cast.expression)) return undefined;

      // Replace the type with uintptr_t (as a TypedefType, since uintptr_t is a typedef)
      const newType: TypedefType = {
        kind: NodeKind.TypedefType,
        name: {
          kind: NodeKind.Identifier,
          name: 'uintptr_t',
          location: cast.type.location,
          leadingTrivia: [],
          trailingTrivia: [],
        } as Identifier,
        location: cast.type.location,
        leadingTrivia: cast.type.leadingTrivia || [],
        trailingTrivia: cast.type.trailingTrivia || [],
      };

      return {
        ...cast,
        type: newType,
      } as CStyleCastExpr;
    },
  });
}

export const pointerCastNormalizePlugin: TransformPlugin = {
  id: 'pointer-cast-normalize',
  name: 'Pointer Cast Normalize',
  description:
    'Convert (int)&expr → (uintptr_t)&expr for portable pointer arithmetic',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 16, // After type-normalize (15), before other cleanups
  tags: ['core', 'cleanup', 'portability'],

  createTransformer(_options?: PluginOptions) {
    return createPointerCastNormalize();
  },
};

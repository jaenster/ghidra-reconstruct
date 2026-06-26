/**
 * Funcdef-Pointer Cast Collapse Plugin
 *
 * A Ghidra FunctionDefinition `AI_Main` is reconstructed as a function-POINTER
 * typedef: `typedef void (*AI_Main)(...)`. Ghidra, however, treats `AI_Main` as a
 * function TYPE, so it emits `(AI_Main*)x` for what is really a function pointer —
 * but against the pointer-typedef that renders as `void(**)(...)`, one indirection
 * too many. Assigning it to a `void(*)(...)` field then fails ("cannot convert
 * void(**) to void(*)").
 *
 * Collapse a C-style cast `(T*)expr` → `(T)expr` when `T` is a known
 * function-pointer typedef — the typedef already IS the pointer, so the extra `*`
 * is the spurious indirection. Names of the funcdef typedefs are supplied via
 * options (they live in the reconstruct layer).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CStyleCastExpr, PointerType, TypedefType, Identifier } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface FuncdefCastCollapseOptions extends PluginOptions {
  /** Names of function-pointer typedefs (Ghidra FUNCTION_DEFINITION datatypes). */
  funcdefTypedefs?: string[];
}

function createFuncdefCastCollapseTransformer(options: FuncdefCastCollapseOptions = {}): Transformer {
  const funcdefTypedefs = new Set(options.funcdefTypedefs ?? []);
  if (funcdefTypedefs.size === 0) return (n: ASTNode) => n; // nothing to do
  return createTransformer({
    visitNode(node) {
      if (node.kind !== NodeKind.CStyleCastExpr) return undefined;
      const cast = node as CStyleCastExpr;
      if (cast.type.kind !== NodeKind.PointerType) return undefined;
      const pointee = (cast.type as PointerType).pointee;
      if (pointee.kind !== NodeKind.TypedefType) return undefined;
      const name = ((pointee as TypedefType).name as Identifier).name;
      if (!funcdefTypedefs.has(name)) return undefined;
      // Collapse `(Funcdef*)` → `(Funcdef)`.
      return updateNode(cast, { type: pointee } as Partial<CStyleCastExpr>);
    },
  });
}

export const funcdefCastCollapsePlugin: TransformPlugin = {
  id: 'funcdef-cast-collapse',
  name: 'Funcdef-Pointer Cast Collapse',
  description: 'Collapses (Funcdef*) casts to (Funcdef) where Funcdef is a function-pointer typedef',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 70,
  tags: ['cleanup', 'type'],
  createTransformer: createFuncdefCastCollapseTransformer,
};

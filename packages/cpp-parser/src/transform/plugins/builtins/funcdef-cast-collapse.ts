/**
 * Funcdef-Pointer Indirection Collapse Plugin
 *
 * A Ghidra FunctionDefinition `AI_Main` is reconstructed as a function-POINTER
 * typedef: `typedef void (*AI_Main)(...)`. Ghidra, however, treats `AI_Main` as a
 * function TYPE, so every pointer TO it carries one more `*` than the emitted
 * typedef needs: Ghidra's `AI_Main *` is C++'s `AI_Main`, Ghidra's `AI_Main **`
 * is C++'s `AI_Main *`, and so on. Rendered literally, each becomes one
 * indirection too many ("cannot convert void(**) to void(*)").
 *
 * So the rule is uniform and applies to EVERY type position, at any pointer
 * depth: peel exactly one `*` off a pointer chain that bottoms out in a funcdef
 * typedef. `D2ControlStrc.fpDraw` is `Draw *` in Ghidra and the struct emitter
 * already peels it; the bodies that take its address declare `Draw **` locals,
 * which needs the same peel one level further out.
 *
 * Names of the funcdef typedefs are supplied via options (they live in the
 * reconstruct layer).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, PointerType, TypedefType, Identifier, QualifiedId, ArrayType,
  QualifiedType, TypeNode, VariableDecl, ParameterDecl, FieldDecl,
  CStyleCastExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface FuncdefCastCollapseOptions extends PluginOptions {
  /** Names of function-pointer typedefs (Ghidra FUNCTION_DEFINITION datatypes). */
  funcdefTypedefs?: string[];
}

/**
 * The type positions this runs on. Anything holding a `TypeNode` in a `type`
 * field is a declaration or a cast — never an expression — so peeling there
 * cannot change what an expression evaluates to, only how it is spelled.
 */
const TYPE_BEARING_KINDS: ReadonlySet<NodeKind> = new Set([
  NodeKind.VariableDecl,
  NodeKind.ParameterDecl,
  NodeKind.FieldDecl,
  NodeKind.CStyleCastExpr,
  NodeKind.StaticCastExpr,
  NodeKind.ReinterpretCastExpr,
  NodeKind.FunctionalCastExpr,
]);

/**
 * The funcdef typedef a type name refers to, or undefined. Only an unqualified
 * name or a root-qualified `::Name` counts — `Some::Draw` is a different type
 * that happens to share the last segment.
 */
function funcdefName(type: TypeNode, funcdefTypedefs: ReadonlySet<string>): string | undefined {
  if (type.kind !== NodeKind.TypedefType) return undefined;
  const n = (type as TypedefType).name;
  let ident: ASTNode;
  if (n.kind === NodeKind.QualifiedId) {
    const q = n as QualifiedId;
    if (q.qualifier.length > 0) return undefined;
    ident = q.name;
  } else {
    ident = n;
  }
  if (ident.kind !== NodeKind.Identifier) return undefined;
  const name = (ident as Identifier).name;
  return funcdefTypedefs.has(name) ? name : undefined;
}

/**
 * Remove exactly one pointer level from a type whose pointer chain bottoms out
 * in a funcdef typedef. Returns undefined when the type is not of that shape.
 */
function collapseOnePointer(
  type: TypeNode,
  funcdefTypedefs: ReadonlySet<string>
): TypeNode | undefined {
  if (type.kind === NodeKind.PointerType) {
    const pointee = (type as PointerType).pointee;
    // `Funcdef *` → `Funcdef`: the typedef already IS the pointer.
    if (funcdefName(pointee, funcdefTypedefs)) return pointee;
    // `Funcdef **` → `Funcdef *`, and deeper.
    const inner = collapseOnePointer(pointee, funcdefTypedefs);
    return inner ? (updateNode(type, { pointee: inner } as Partial<PointerType>) as TypeNode) : undefined;
  }
  // `Funcdef *[N]` → `Funcdef[N]`; the array element carries the indirection.
  if (type.kind === NodeKind.ArrayType) {
    const inner = collapseOnePointer((type as ArrayType).elementType, funcdefTypedefs);
    return inner ? (updateNode(type, { elementType: inner } as Partial<ArrayType>) as TypeNode) : undefined;
  }
  if (type.kind === NodeKind.QualifiedType) {
    const inner = collapseOnePointer((type as QualifiedType).type, funcdefTypedefs);
    return inner ? (updateNode(type, { type: inner } as Partial<QualifiedType>) as TypeNode) : undefined;
  }
  return undefined;
}

function createFuncdefCastCollapseTransformer(options: FuncdefCastCollapseOptions = {}): Transformer {
  const funcdefTypedefs = new Set(options.funcdefTypedefs ?? []);
  if (funcdefTypedefs.size === 0) return (n: ASTNode) => n; // nothing to do
  return createTransformer({
    visitNode(node) {
      if (!TYPE_BEARING_KINDS.has(node.kind)) return undefined;
      const typed = node as unknown as { type: TypeNode };
      if (!typed.type) return undefined;
      const collapsed = collapseOnePointer(typed.type, funcdefTypedefs);
      if (!collapsed) return undefined;
      return updateNode(
        node,
        { type: collapsed } as Partial<VariableDecl | ParameterDecl | FieldDecl | CStyleCastExpr>
      );
    },
  });
}

export const funcdefCastCollapsePlugin: TransformPlugin = {
  id: 'funcdef-cast-collapse',
  name: 'Funcdef-Pointer Indirection Collapse',
  description: 'Peels the one redundant pointer level off types that bottom out in a function-pointer typedef',
  version: '2.0.0',
  defaultEnabled: true,
  priority: 70,
  tags: ['cleanup', 'type'],
  createTransformer: createFuncdefCastCollapseTransformer,
};

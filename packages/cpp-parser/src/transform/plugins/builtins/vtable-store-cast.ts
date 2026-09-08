/**
 * Pointer-to-Pointer Store Cast Transform Plugin
 *
 * Ghidra writes an object's vtable slot as a store through a cast:
 *
 *   *(undefined ***)this = D2Client::UIWidget::vftable;
 *
 * which the emitter spells `*(uint8_t***)pThis = ...`. The left side then has type
 * `uint8_t**`, while the vtable global is an array of `pointer` and decays to
 * `void**`. Those are the same thing in Ghidra's C and a hard type error in C++.
 *
 * Fixing it on the data side does not work: a vtable holds FUNCTION pointers, which
 * convert to `void*` under GCC's extension but never to `unsigned char*`, so retyping
 * the arrays breaks every initializer instead. The store is the right place.
 *
 * So where the destination is a cast to a pointer-to-pointer and the source is a
 * plain (possibly qualified) name, the source is cast to the destination's pointee:
 *
 *   *(uint8_t***)pThis = vftable;   →   *(uint8_t***)pThis = (uint8_t**)vftable;
 *
 * Only a bare name is rewritten. An expression that already carries its own cast, or
 * any computed value, is left alone rather than have a second cast stacked onto it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Expression, AssignExpr, UnaryExpr, CStyleCastExpr } from '../../../ast/nodes.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { createPlugin } from '../registry.js';

/** `*(T **)x` — a store through a cast to pointer-to-pointer. Returns the cast node. */
function derefOfPointerToPointerCast(lhs: ASTNode): CStyleCastExpr | null {
  if (lhs.kind !== NodeKind.UnaryExpr) return null;
  const u = lhs as UnaryExpr;
  if (u.operator !== '*') return null;
  let inner = u.operand as ASTNode;
  while (inner && inner.kind === NodeKind.ParenExpr) inner = (inner as unknown as { expression: ASTNode }).expression;
  if (!inner || inner.kind !== NodeKind.CStyleCastExpr) return null;
  const cast = inner as CStyleCastExpr;
  const t = cast.type as unknown as ASTNode;
  if (!t || t.kind !== NodeKind.PointerType) return null;
  const pointee = (t as unknown as { pointee?: ASTNode }).pointee;
  if (!pointee || pointee.kind !== NodeKind.PointerType) return null;
  return cast;
}

/** A bare name: `vftable`, or the qualified form `D2Client::UIWidget::vftable`. */
function isPlainName(e: ASTNode): boolean {
  return e.kind === NodeKind.Identifier || e.kind === NodeKind.QualifiedId;
}

function createTransformer(): Transformer {
  return createKindTransformer(NodeKind.AssignExpr, (node) => {
    const assign = node as AssignExpr;
    if (assign.operator !== '=') return undefined;

    const cast = derefOfPointerToPointerCast(assign.left as ASTNode);
    if (!cast) return undefined;
    if (!isPlainName(assign.right as ASTNode)) return undefined;

    // destination pointee: strip one level off the cast's type
    const pointee = (cast.type as unknown as { pointee: ASTNode }).pointee;

    const rhsCast: CStyleCastExpr = {
      kind: NodeKind.CStyleCastExpr,
      type: pointee,
      expression: assign.right as Expression,
      location: (assign.right as ASTNode).location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as unknown as CStyleCastExpr;

    return { ...assign, right: rhsCast } as AssignExpr;
  });
}

export const vtableStoreCastPlugin: TransformPlugin = createPlugin(
  'vtable-store-cast',
  'Pointer-to-Pointer Store Cast',
  'Casts a bare name stored through a pointer-to-pointer cast to the destination pointee type',
  () => createTransformer(),
  {
    priority: 48,
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra'],
    version: '1.0.0',
  },
);

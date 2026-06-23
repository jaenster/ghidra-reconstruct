/**
 * Member-Init Cast Plugin
 *
 * Ghidra's decompiler reads a union of same-offset pointers (e.g. D2's
 * `pQuestData->pQuestSpecificData` — 32 per-quest struct pointers, all at offset
 * 0) by rendering ONE arbitrary member, while the destination local carries the
 * quest-correct type:
 *
 *   D2QuestDataA1Q4Strc *p = pQuestData->pQuestSpecificData.pA1Q5;  // pA1Q5 is A1Q5*
 *
 * C++ rejects this (unrelated struct-pointer conversion) even under -fpermissive.
 * The two pointers are the same address (offset-0 union members), so a cast to
 * the declared type is semantically correct, not a hack.
 *
 * This wraps the initializer of a `T* x = <chained member access>;` declaration
 * in a cast to T. Scope is deliberately narrow — pointer-to-struct destination
 * AND a *chained* member access (`a->b.c`, i.e. the initializer's object is
 * itself a member access) — so it targets union/nested-struct dereferences and
 * does not blanket-cast every `x = a.b`. The cast is a no-op when the types
 * already match and can never introduce a new error (initializing a pointer from
 * a non-pointer is already an error with or without the cast).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  VariableDecl,
  MemberExpr,
  CStyleCastExpr,
} from '../../../ast/nodes.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { createPlugin } from '../registry.js';

function createMemberInitCastTransformer(): Transformer {
  return createKindTransformer(NodeKind.VariableDecl, (node) => {
    const decl = node as VariableDecl;

    // Destination must be a pointer to a non-builtin (named struct/typedef) type.
    if (decl.type.kind !== NodeKind.PointerType) return undefined;
    const pointee = (decl.type as any).pointee;
    if (!pointee || pointee.kind === NodeKind.BuiltinType) return undefined;

    const init = decl.initializer;
    if (!init || (init as ASTNode).kind !== NodeKind.MemberExpr) return undefined;
    const member = init as MemberExpr;

    // Only a CHAINED member access (object is itself a member access) — the
    // union/nested-struct dereference pattern. Avoids blanket-casting `x = a.b`.
    if (member.object.kind !== NodeKind.MemberExpr) return undefined;

    const cast: CStyleCastExpr = {
      kind: NodeKind.CStyleCastExpr,
      type: decl.type,
      expression: init as Expression,
      location: decl.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as CStyleCastExpr;

    return { ...decl, initializer: cast } as VariableDecl;
  });
}

export const memberInitCastPlugin: TransformPlugin = createPlugin(
  'member-init-cast',
  'Member-Init Cast',
  'Cast a pointer-to-struct var initialized from a chained member access (offset-0 union deref) to its declared type',
  () => createMemberInitCastTransformer(),
  {
    priority: 60, // late cleanup, after struct-field (50) / subpiece (46)
    defaultEnabled: true,
    tags: ['cleanup', 'ghidra'],
    version: '1.0.0',
  },
);

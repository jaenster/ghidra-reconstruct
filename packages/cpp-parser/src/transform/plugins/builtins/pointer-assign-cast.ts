/**
 * Pointer Assignment Cast-Insertion Plugin
 *
 * Ghidra emits `T* x = (U*)expr` / `x = (U*)expr` for what is, in the original
 * binary, a bit-REINTERPRET of one pointer as another. That is valid in the
 * decompiler's model but ill-formed C++ ("cannot convert U* to T* in
 * assignment"). The faithful emission keeps the reinterpret explicit: insert the
 * target-type cast, `x = (T*)expr`.
 *
 * Only fires when BOTH sides are pointers whose pointee types DIFFER and are
 * determinable — so a genuine same-type assignment is untouched. The RHS pointer
 * type is read from a cast (`(U*)e`), an address-of-deref (`&*(U*)e`, which
 * cancels to `(U*)e`), or another pointer local/param. LHS types come from the
 * variable's declaration / parameter list in the same function (no external type
 * map needed — the assert-condition locals etc. are body-declared).
 *
 * AST-based, idempotent: a re-run sees `(T*)(U*)e`, reads the outer `T*`, finds
 * it equal to the target, and inserts nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Identifier, TypeNode,
  PointerType, BuiltinType, TypedefType, ElaboratedType, Expression,
  CStyleCastExpr, UnaryExpr, ParenExpr, AssignExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin } from '../types.js';

/** Stable equality key for a pointer/scalar type; null = can't reason about it. */
function typeKey(t: TypeNode): string | null {
  switch (t.kind) {
    case NodeKind.PointerType: {
      const inner = typeKey((t as PointerType).pointee);
      return inner === null ? null : inner + '*';
    }
    case NodeKind.BuiltinType:
      return (t as BuiltinType).name.toLowerCase();
    case NodeKind.TypedefType: {
      const n = (t as TypedefType).name as { name?: string };
      return typeof n?.name === 'string' ? n.name : null;
    }
    case NodeKind.ElaboratedType: {
      const e = t as ElaboratedType;
      const n = e.name as { name?: string };
      return typeof n?.name === 'string' ? `${e.keyword} ${n.name}` : null;
    }
    default:
      return null; // ArrayType / QualifiedType / funcptr — leave alone
  }
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The pointer TypeNode a RHS expression evaluates to, or null if not a clear pointer. */
function rhsPointerType(expr: Expression, typeByName: Map<string, TypeNode>): TypeNode | null {
  const e = unwrapParens(expr);
  // (U*)x
  if (e.kind === NodeKind.CStyleCastExpr) {
    const ct = (e as CStyleCastExpr).type;
    return ct.kind === NodeKind.PointerType ? ct : null;
  }
  // &*(U*)x  →  (U*)x  (address-of-deref cancels)
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') {
    const inner = unwrapParens((e as UnaryExpr).operand);
    if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '*') {
      return rhsPointerType((inner as UnaryExpr).operand, typeByName);
    }
    return null;
  }
  // another pointer variable
  if (e.kind === NodeKind.Identifier) {
    const t = typeByName.get((e as Identifier).name);
    return t && t.kind === NodeKind.PointerType ? t : null;
  }
  return null;
}

function needsCast(lhsType: TypeNode, rhs: Expression, typeByName: Map<string, TypeNode>): boolean {
  if (lhsType.kind !== NodeKind.PointerType) return false;
  const rt = rhsPointerType(rhs, typeByName);
  if (!rt) return false;
  const lk = typeKey(lhsType), rk = typeKey(rt);
  if (lk === null || rk === null) return false;
  return lk !== rk;
}

function createPointerAssignCastTransformer(): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // name → declared pointer type, from params + body-declared locals.
      const typeByName = new Map<string, TypeNode>();
      for (const p of node.parameters) typeByName.set(p.name.name, (p as ParameterDecl).type);
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!typeByName.has(v.name.name)) typeByName.set(v.name.name, v.type);
      }

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          // x = (U*)e  where x is T* and T != U
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=' || a.left.kind !== NodeKind.Identifier) return undefined;
            const lt = typeByName.get((a.left as Identifier).name);
            if (!lt || !needsCast(lt, a.right, typeByName)) return undefined;
            changed = true;
            return updateNode(a, { right: Expr.cast(lt, a.right) } as Partial<AssignExpr>);
          }
          // T* x = (U*)e
          if (n.kind === NodeKind.VariableDecl) {
            const v = n as VariableDecl;
            const init = v.initializer;
            if (!init || init.kind === NodeKind.InitListExpr) return undefined;
            if (!needsCast(v.type, init as Expression, typeByName)) return undefined;
            changed = true;
            return updateNode(v, { initializer: Expr.cast(v.type, init as Expression) } as Partial<VariableDecl>);
          }
          return undefined;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const pointerAssignCastPlugin: TransformPlugin = {
  id: 'pointer-assign-cast',
  name: 'Pointer Assignment Cast Insertion',
  description:
    'Inserts a reinterpret cast when a pointer variable is assigned a differently-typed pointer (faithful for decompiled bit-reinterprets)',
  version: '1.0.0',
  defaultEnabled: true,
  // Late, after boilerplate-cleanup (500): cast the FINAL assignment form.
  priority: 600,
  tags: ['cleanup', 'type'],
  createTransformer: createPointerAssignCastTransformer,
};

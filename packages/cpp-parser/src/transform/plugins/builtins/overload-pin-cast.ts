/**
 * Overload Pin Cast Plugin
 *
 * Selects ONE member of an overload set, by the type of the member the body's
 * instructions take the address of.
 *
 * Two functions can share their whole qualified name: Ghidra files both
 * `Draw(D2WinImage *)` (004fd1f0) and `Draw(D2WinImageEx *)` (004fd470) under
 * `D2Win::Src::D2WinImage`. The decompile spells each reference to either as
 * `D2Win::Src::D2WinImage::Draw`, so wherever the name is not called - stored,
 * passed, compared, returned - C++ sees an overload set and, short of a target
 * type that matches one member exactly, selects nothing. The instruction does
 * say which: it holds the address. The caller resolves that per body and hands
 * the spellings it settled over, with the member's exact type, as
 * `pinnedFunctions`.
 *
 * Transforms (a body that stores 004fd1f0):
 *   fpDraw = (::Draw)D2Win::Src::D2WinImage::Draw;
 *   -> fpDraw = (::Draw)(BOOL (__fastcall *)(::D2WinImage*))D2Win::Src::D2WinImage::Draw;
 *   if (pControl->fpDraw == D2Win::Src::D2WinImage::Draw)
 *   -> if (pControl->fpDraw == (BOOL (__fastcall *)(::D2WinImage*))D2Win::Src::D2WinImage::Draw)
 *
 * A call is left alone: overload resolution picks the member from the
 * arguments, as the original source did. A reference already cast to exactly
 * that type (a slot pass reduced the set itself) is not cast twice.
 *
 * Runs after every slot-cast pass, so their casts are decided first against
 * the member's signature and this one only completes the reference inside
 * them; before `enclosing-namespace-strip`, which still sees a plain name.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  AnyNode,
  ASTNode,
  CallExpr,
  CStyleCastExpr,
  Expression,
  Identifier,
  MemberExpr,
  QualifiedId,
  TypeNode,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { functionPointerTypeFromSpellings } from './call-arg-cast.js';

export interface PinnedFunction {
  returnType: string;
  paramTypes: string[];
  /** The calling-convention keyword the declaration carries, or '' for none. */
  convention: string;
}

export interface OverloadPinCastOptions extends PluginOptions {
  /** A spelling of a shared qualified name -> the member this body means by it. */
  pinnedFunctions?: Record<string, PinnedFunction>;
}

/** `a::b::c` for a qualified id of plain identifiers, the name for an identifier. */
function spellingOf(node: ASTNode): string | undefined {
  if (node.kind === NodeKind.Identifier) return (node as Identifier).name;
  if (node.kind !== NodeKind.QualifiedId) return undefined;
  const q = node as QualifiedId;
  if (q.name.kind !== NodeKind.Identifier) return undefined;
  const parts: string[] = [];
  for (const p of q.qualifier) {
    if (p.kind !== NodeKind.Identifier) return undefined;
    parts.push((p as Identifier).name);
  }
  parts.push((q.name as Identifier).name);
  return parts.join('::');
}

function createOverloadPinCastTransformer(options: OverloadPinCastOptions = {}): Transformer {
  const pinned = options.pinnedFunctions;
  if (!pinned || Object.keys(pinned).length === 0) return createTransformer({});

  /** The exact pointer type per spelling, built once; null when it cannot be spelled. */
  const exactTypes = new Map<string, TypeNode | null>();
  const exactTypeOf = (key: string): TypeNode | null => {
    let t = exactTypes.get(key);
    if (t === undefined) {
      const p = pinned[key];
      t = functionPointerTypeFromSpellings(p.returnType, p.paramTypes, p.convention || undefined);
      exactTypes.set(key, t);
    }
    return t;
  };

  /**
   * The member a reference denotes. The model's full spelling first: a pass may have
   * shortened the reference to a form several sets share. A bare identifier counts
   * only through the model's spelling, never by its own name.
   */
  const pinnedKeyOf = (node: ASTNode): string | undefined => {
    if (node.kind !== NodeKind.Identifier && node.kind !== NodeKind.QualifiedId) return undefined;
    const model = node.ghidraInfo?.modelQualifiedName;
    if (model !== undefined && pinned[model] !== undefined) return model;
    if (node.kind !== NodeKind.QualifiedId) return undefined;
    const own = spellingOf(node);
    return own !== undefined && pinned[own] !== undefined ? own : undefined;
  };

  /** Each cast this pass wrote -> the expression it wrapped, and the exact type's spelling. */
  const produced = new Map<ASTNode, { inner: Expression; typeText: string }>();

  const wrap = (inner: Expression, type: TypeNode, source: ASTNode): ASTNode => {
    const cast = {
      ...Expr.cast(type, inner),
      location: source.location,
      leadingTrivia: source.leadingTrivia ?? [],
      trailingTrivia: source.trailingTrivia ?? [],
    } as CStyleCastExpr;
    produced.set(cast, { inner, typeText: emit(type as unknown as AnyNode) });
    return cast;
  };

  return createTransformer({
    // Bottom-up: a reference is wrapped first, and its parent then undoes the
    // wrap where the reference is not a value of function-pointer type after all.
    visitNode(node: ASTNode): ASTNode | undefined {
      switch (node.kind) {
        case NodeKind.Identifier:
        case NodeKind.QualifiedId: {
          const key = pinnedKeyOf(node);
          if (key === undefined) return undefined;
          const type = exactTypeOf(key);
          return type ? wrap(node as Expression, type, node) : undefined;
        }
        case NodeKind.CallExpr: {
          // The called name: the arguments select the member.
          const call = node as CallExpr;
          const p = produced.get(call.callee);
          return p ? updateNode(call, { callee: p.inner } as Partial<CallExpr>) : undefined;
        }
        case NodeKind.MemberExpr: {
          const member = node as MemberExpr;
          const p = produced.get(member.member);
          return p ? updateNode(member, { member: p.inner as MemberExpr['member'] } as Partial<MemberExpr>) : undefined;
        }
        case NodeKind.UnaryExpr: {
          // `&f` takes the same address; the cast goes outside, `&(T)f` is no lvalue.
          const unary = node as UnaryExpr;
          if (unary.operator !== '&') return undefined;
          const p = produced.get(unary.operand);
          if (!p) return undefined;
          const castNode = unary.operand as CStyleCastExpr;
          const bare = updateNode(unary, { operand: p.inner } as Partial<UnaryExpr>) as Expression;
          return wrap(bare, castNode.type, unary);
        }
        case NodeKind.CStyleCastExpr:
        case NodeKind.StaticCastExpr: {
          // A slot pass already reduced the set to this very member.
          const cast = node as CStyleCastExpr;
          if (produced.has(cast)) return undefined;
          const p = produced.get(cast.expression);
          if (!p || emit(cast.type as unknown as AnyNode) !== p.typeText) return undefined;
          return updateNode(cast, { expression: p.inner } as Partial<CStyleCastExpr>);
        }
        default:
          return undefined;
      }
    },
  });
}

export const overloadPinCastPlugin: TransformPlugin = {
  id: 'overload-pin-cast',
  name: 'Overload Pin Cast',
  description:
    'Spell the exact type of the member of a shared qualified name whose address the instructions take',
  version: '1.0.0',
  defaultEnabled: true,
  // After every slot-cast pass (assign-cast 615 ... sizeless-pointer-arith 626),
  // before seh-lowering (680) and enclosing-namespace-strip (900).
  priority: 627,
  tags: ['type', 'cpp'],
  createTransformer: (options?: PluginOptions) =>
    createOverloadPinCastTransformer(options as OverloadPinCastOptions),
};

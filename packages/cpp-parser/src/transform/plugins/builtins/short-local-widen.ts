/**
 * Short Local Widen Plugin
 *
 * A 16-bit local read only as an array index is an int in the original: the original
 * sign-extends once, at the load (TXT_AllocTxt_monseq, 00659c60, `movsx eax, word ptr
 * [edx]` for `nSeqId = pDVar1->sequence`, then only `tbl[nSeqId]`). Declared `short`, the
 * local compiles to a zero-extending load and a second extension at the subscript
 * (`movzx eax, word ptr [edx]; movsx eax, ax`).
 *
 *     short nSeqId;                          int nSeqId;
 *     nSeqId = pDVar1->sequence;      =>     nSeqId = (short)pDVar1->sequence;
 *     ... tbl[nSeqId] ...                    ... tbl[nSeqId] ...
 *
 * Value-preserving: every write is a plain `x = v` (or the initialiser) and becomes
 * `x = (short)v`, so the int holds exactly the value the short held, sign-extended, and a
 * short used as an index is converted to that same value. Required: x is a local (not a
 * parameter) declared `short`/`int16_t`, its address is never taken, it is never
 * incremented or compound-assigned, and every read is the index of a subscript. Shorts read
 * any other way (compared, passed, added) are short in the original as often as not:
 * widening them lost six matches in fourteen TUs and gained none, so they stay. The cast is
 * left off a value that is already a cast to the local's type.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, CStyleCastExpr, Expression, FunctionDecl, Identifier, ParenExpr,
  TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, nodesEqual, type Transformer } from '../../transformer.js';
import { Expr, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName } from './call-arg-cast.js';

export interface ShortLocalWidenOptions extends PluginOptions {
  onSite?: (e: { function: string; variable: string }) => void;
}

const SHORTS = new Set(['short', 'short int', 'signed short', 'signed short int', 'int16_t', 'SHORT']);

function spelling(t: TypeNode | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === NodeKind.QualifiedType) return undefined; // a const local stays as declared
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as unknown as { name: string; modifiers?: string[] };
    return [...(b.modifiers ?? []), b.name].join(' ');
  }
  if (t.kind === NodeKind.TypedefType) return typeNodeName((t as unknown as { name: unknown }).name);
  return undefined;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Parent links for every node under root. */
function parents(root: ASTNode): Map<ASTNode, ASTNode> {
  const m = new Map<ASTNode, ASTNode>();
  const walk = (n: ASTNode) => { for (const k of getChildren(n)) { m.set(k, n); walk(k); } };
  walk(root);
  return m;
}

/**
 * How an identifier node is used: 'write' (the target of `x = v`), 'promoted' (read as an
 * int), or 'other' (anything that would see the declared type).
 */
function useOf(id: Identifier, up: Map<ASTNode, ASTNode>): 'write' | 'promoted' | 'other' {
  let child: ASTNode = id;
  let p = up.get(child);
  while (p && p.kind === NodeKind.ParenExpr) { child = p; p = up.get(p); }
  if (!p) return 'other';
  switch (p.kind) {
    case NodeKind.AssignExpr: {
      const a = p as AssignExpr;
      if (a.left === child) return a.operator === '=' ? 'write' : 'other';
      return 'other';
    }
    case NodeKind.SubscriptExpr:
      return (p as unknown as { index: ASTNode }).index === child ? 'promoted' : 'other';
    default:
      return 'other';
  }
}

function castTo(t: TypeNode, v: Expression): Expression {
  const u = unwrap(v);
  if (u.kind === NodeKind.CStyleCastExpr && nodesEqual((u as CStyleCastExpr).type, t)) return v;
  const inner = u.kind === NodeKind.Identifier || u.kind === NodeKind.CallExpr || u.kind === NodeKind.MemberExpr
    || u.kind === NodeKind.SubscriptExpr || u.kind === NodeKind.IntegerLiteral ? v : Expr.paren(v);
  return Expr.cast(cloneNode(t), inner);
}

function rewriteFunction(fn: FunctionDecl, onSite?: ShortLocalWidenOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  const decls = new Map<string, VariableDecl[]>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      decls.set(v.name.name, [...(decls.get(v.name.name) ?? []), v]);
    }
  }
  const params = new Set<string>();
  for (const p of fn.parameters as unknown as { name?: Identifier }[]) if (p.name) params.add(p.name.name);
  const up = parents(body);
  const idents = new Map<string, Identifier[]>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.Identifier) continue;
    const id = n as Identifier;
    const p = up.get(id);
    if (p && p.kind === NodeKind.VariableDecl && (p as VariableDecl).name === id) continue;
    if (p && p.kind === NodeKind.MemberExpr && (p as unknown as { member: ASTNode }).member === id) continue;
    idents.set(id.name, [...(idents.get(id.name) ?? []), id]);
  }
  const widen: { name: string; decl: VariableDecl; writes: AssignExpr[] }[] = [];
  for (const [name, ds] of decls) {
    if (ds.length !== 1 || params.has(name)) continue;
    const d = ds[0];
    const s = spelling(d.type);
    if (!s || !SHORTS.has(s) || d.specifiers.length > 0) continue;
    if (d.initializer && d.initializer.kind === NodeKind.InitListExpr) continue;
    const uses = idents.get(name) ?? [];
    const writes: AssignExpr[] = [];
    let ok = true;
    let reads = 0;
    for (const id of uses) {
      const u = useOf(id, up);
      if (u === 'other') { ok = false; break; }
      if (u === 'write') {
        let p = up.get(id)!;
        while (p.kind === NodeKind.ParenExpr) p = up.get(p)!;
        writes.push(p as AssignExpr);
      } else reads++;
    }
    if (!ok || reads === 0) continue;
    widen.push({ name, decl: d, writes });
  }
  if (widen.length === 0) return undefined;
  for (const w of widen) {
    const shortType = w.decl.type;
    for (const a of w.writes) (a as { right: Expression }).right = castTo(shortType, a.right);
    if (w.decl.initializer) (w.decl as { initializer: Expression | null }).initializer = castTo(shortType, w.decl.initializer as Expression);
    (w.decl as { type: TypeNode }).type = Type.int();
    onSite?.({ function: fname, variable: w.name });
  }
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function createShortLocalWidenTransformer(options: ShortLocalWidenOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options.onSite);
    },
  });
}

export const shortLocalWidenPlugin: TransformPlugin = {
  id: 'short-local-widen',
  name: 'Short Local Widen',
  description: 'A short local only loaded from 16 bits and only read as an int is declared int',
  version: '1.0.0',
  defaultEnabled: true,
  // On the final declarations, before the WARNING strip (990), which runs last.
  priority: 989.96,
  tags: ['matching'],
  createTransformer: createShortLocalWidenTransformer,
};


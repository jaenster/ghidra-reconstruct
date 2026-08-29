/**
 * Underscore Storage-Slot Local Plugin
 *
 * Ghidra's decompiler reuses a parameter/local's STORAGE SLOT and renders the
 * second occupant as `_<base>` (one leading underscore over `<base>`), emitting
 * no declaration for it — the body then uses an undeclared identifier
 * (`'_foo' was not declared; did you mean 'foo'?`).
 *
 * Two different things wear that spelling, and they need different emissions:
 *
 *  1. **Same-width reuse.** The slot holds another value of the base's own type.
 *     A second local of the base's type is a faithful rendering, so synthesize
 *     `<baseType> _<base>;` at the top of the body.
 *
 *  2. **Width alias.** The slot is also accessed at a WIDER type than the one
 *     Ghidra committed to it — `D2GSPacketClt0x89 sPacket0x89` (2 bytes) at
 *     `Stack[-0x34]` that also carries a `D2GameStrc *`. Ghidra keeps ONE
 *     variable (`get_stack_frame` reports one slot) and refers to the wide
 *     access as `_sPacket0x89`; the wide type shows up only in the casts Ghidra
 *     puts at the use sites. Declaring a second variable of the NARROW type
 *     makes every wide use a type error, and declaring it wide would break the
 *     aliasing the code relies on — `_sPacket0x89` is written as a dword and
 *     then `&sPacket0x89` is sent as the packet. The faithful emission is the
 *     reinterpret the machine performs: `*(T *)&<base>`.
 *
 * The alias's type is taken from the USE, not from the base's declaration — the
 * base's declared type is exactly the thing that is too narrow. Evidence, in
 * order: the type of the value assigned INTO the alias, the type of the variable
 * assigned FROM it, and, per site, the cast Ghidra wrapped that particular read
 * in. Where two sites disagree the slot is a genuine union and each site keeps
 * its own cast; a site whose type matches the base's collapses to the bare base
 * identifier, which is the same storage.
 *
 * Only a POINTER selects case 2. Two integers disagreeing is Ghidra widening a
 * read (`iResult = _nSuffixId` over a `uint16_t` slot), and reinterpreting there
 * would write four bytes over a two-byte local — a silent overrun in place of a
 * loud error. So case 1 keeps every alias whose uses are integral, exactly as
 * before.
 *
 * AST-based throughout: `_<base>` and `<base>` are Identifier nodes, casts are
 * CStyleCastExpr nodes, so `return _bResult;` is unambiguously a ReturnStmt and
 * the base's type is read off its TypeNode rather than re-parsed from text.
 * Skips `_DAT_*` / `_LAB_*` (globals/labels).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, VariableDecl, ParameterDecl, Identifier, TypeNode,
  Expression, ParenExpr, UnaryExpr, CStyleCastExpr, AssignExpr, PointerType, BuiltinType,
  TypedefType, ElaboratedType,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, builtinBase } from './call-arg-cast.js';

export interface UnderscoreSlotLocalOptions extends PluginOptions {
  /** name → Ghidra type string for params/locals not visible in the transform AST
   *  (the body is wrapped as a param-less `void dummy(){...}`). */
  varTypes?: Record<string, string>;
}

/** Minimal Ghidra type-string → TypeNode: base name + trailing pointer levels. */
function buildTypeFromString(s: string): TypeNode {
  let str = s.trim();
  let ptr = 0;
  while (str.endsWith('*')) { ptr++; str = str.slice(0, -1).trim(); }
  str = str.replace(/^(struct|union|enum)\s+/, '').replace(/\bconst\b/g, '').trim();
  let t: TypeNode = Type.builtin(str || 'int');
  for (let i = 0; i < ptr; i++) t = Type.pointer(t);
  return t;
}

/**
 * Stable equality key for a type; null when the type is not one we can compare.
 *
 * A multi-word builtin reaches the AST as a head plus modifiers, so the head
 * alone answers `int` for short, long, long long and every unsigned variant.
 * `builtinBase` reassembles the spelling, which is what makes the key an
 * equality and not a width-blind bucket.
 */
function typeKey(t: TypeNode | undefined): string | null {
  if (!t) return null;
  switch (t.kind) {
    case NodeKind.PointerType: {
      const inner = typeKey((t as PointerType).pointee);
      return inner === null ? null : inner + '*';
    }
    case NodeKind.BuiltinType: {
      const b = t as BuiltinType;
      return builtinBase(b.name, b.modifiers).toLowerCase();
    }
    case NodeKind.TypedefType:
      return typeNodeName((t as TypedefType).name) ?? null;
    case NodeKind.ElaboratedType: {
      const e = t as ElaboratedType;
      const n = typeNodeName(e.name);
      return n !== undefined ? `${e.keyword} ${n}` : null;
    }
    default:
      return null;
  }
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** The type an expression evaluates to, when it is spelled plainly enough to tell. */
function exprType(e: Expression, typeByName: Map<string, TypeNode>): TypeNode | undefined {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.CStyleCastExpr) return (x as CStyleCastExpr).type;
  if (x.kind === NodeKind.Identifier) return typeByName.get((x as Identifier).name);
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
    const inner = unwrapParens((x as UnaryExpr).operand);
    if (inner.kind === NodeKind.Identifier) {
      const t = typeByName.get((inner as Identifier).name);
      if (t) return Type.pointer(t);
    }
  }
  return undefined;
}

/** `(*(T *)&base)` — the slot reinterpreted at `T`. */
function slotDeref(base: string, type: TypeNode): Expression {
  return Expr.paren(
    Expr.unary('*', Expr.cast(Type.pointer(type), Expr.unary('&', Expr.identifier(base)))),
  );
}

/** Recognise a `(*(T *)&base)` this plugin built, so a site can retype it. */
function matchSlotDeref(e: Expression): { base: string; type: TypeNode } | null {
  const deref = unwrapParens(e);
  if (deref.kind !== NodeKind.UnaryExpr || (deref as UnaryExpr).operator !== '*') return null;
  const cast = unwrapParens((deref as UnaryExpr).operand);
  if (cast.kind !== NodeKind.CStyleCastExpr) return null;
  const ptr = (cast as CStyleCastExpr).type;
  if (ptr.kind !== NodeKind.PointerType) return null;
  const addr = unwrapParens((cast as CStyleCastExpr).expression);
  if (addr.kind !== NodeKind.UnaryExpr || (addr as UnaryExpr).operator !== '&') return null;
  const id = unwrapParens((addr as UnaryExpr).operand);
  if (id.kind !== NodeKind.Identifier) return null;
  return { base: (id as Identifier).name, type: (ptr as PointerType).pointee };
}

interface AliasRewrite { base: string; type: TypeNode }

function createUnderscoreSlotLocalTransformer(options: UnderscoreSlotLocalOptions = {}): Transformer {
  const varTypes = options.varTypes ?? {};
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // name → declared type, from params and body-declared locals (AST), plus the
      // passed param/local types (the wrapped body has no signature, so param types
      // arrive via options, built lazily from their Ghidra type string).
      const typeByName = new Map<string, TypeNode>();
      // `name` is null for unnamed parameters (`void f(void)`, `int f(int)`) - skip those.
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) typeByName.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!typeByName.has(v.name.name)) typeByName.set(v.name.name, v.type);
      }
      for (const [name, typeStr] of Object.entries(varTypes)) {
        if (!typeByName.has(name)) typeByName.set(name, buildTypeFromString(typeStr));
      }

      // `_<base>` identifiers used in the body where <base> is declared but
      // `_<base>` is not (so every occurrence is a use, never a declaration).
      const aliases = new Map<string, TypeNode>();
      for (const id of findNodesByKind(node.body, NodeKind.Identifier)) {
        const name = (id as Identifier).name;
        if (name.length < 2 || name[0] !== '_') continue;
        if (typeByName.has(name) || aliases.has(name)) continue;
        const base = name.slice(1);
        if (base.startsWith('DAT_') || base.startsWith('LAB_')) continue;
        const baseType = typeByName.get(base);
        if (baseType) aliases.set(name, baseType);
      }
      if (aliases.size === 0) return undefined;

      // Split the aliases: one whose uses prove a type OTHER than the base's is a
      // width alias on one slot and becomes `*(T *)&base`; the rest are same-width
      // slot reuse and keep the synthesized declaration.
      const rewrites = new Map<string, AliasRewrite>();
      const assigns = findNodesByKind(node.body, NodeKind.AssignExpr) as AssignExpr[];
      for (const [name, baseType] of aliases) {
        const baseKey = typeKey(baseType);
        let wide: TypeNode | undefined;
        for (const a of assigns) {
          const left = unwrapParens(a.left);
          const right = unwrapParens(a.right);
          let cand: TypeNode | undefined;
          if (left.kind === NodeKind.Identifier && (left as Identifier).name === name) {
            cand = exprType(a.right, typeByName);
          } else if (right.kind === NodeKind.Identifier && (right as Identifier).name === name
                     && left.kind === NodeKind.Identifier) {
            cand = typeByName.get((left as Identifier).name);
          }
          // Only a POINTER proves a width alias. Two integer types disagreeing is
          // routine — `iResult = _nSuffixId` with an `int` result over a `uint16_t`
          // slot is Ghidra widening a read, and reinterpreting the slot at `int`
          // there would write four bytes over a two-byte local: a silent overrun
          // traded for a loud error. A pointer in a narrow slot cannot be anything
          // but the second, wider occupant.
          if (!cand || cand.kind !== NodeKind.PointerType) continue;
          const key = typeKey(cand);
          if (key !== null && key !== baseKey) { wide = cand; break; }
        }
        if (wide) rewrites.set(name, { base: name.slice(1), type: wide });
      }

      const rewriteBases = new Set([...rewrites.values()].map(r => r.base));
      let body = node.body;

      if (rewrites.size > 0) {
        // Bottom-up: every `_<base>` first becomes the function-wide reading of the
        // slot, then the enclosing site — a cast Ghidra wrote around the read, or an
        // assignment whose source types the write — retypes its own occurrence.
        const rewriteSites = createTransformer({
          visitNode(n: ASTNode): ASTNode | undefined {
            if (n.kind === NodeKind.Identifier) {
              const r = rewrites.get((n as Identifier).name);
              return r ? slotDeref(r.base, r.type) : undefined;
            }
            if (n.kind === NodeKind.CStyleCastExpr) {
              const cast = n as CStyleCastExpr;
              const m = matchSlotDeref(cast.expression);
              if (!m || !rewriteBases.has(m.base)) return undefined;
              const key = typeKey(cast.type);
              if (key === null || key === typeKey(m.type)) return undefined;
              return updateNode(cast, { expression: slotDeref(m.base, cast.type) } as Partial<CStyleCastExpr>);
            }
            if (n.kind === NodeKind.AssignExpr) {
              const assign = n as AssignExpr;
              const m = matchSlotDeref(assign.left);
              if (!m || !rewriteBases.has(m.base)) return undefined;
              const t = exprType(assign.right, typeByName);
              const key = typeKey(t);
              if (!t || key === null || key === typeKey(m.type)) return undefined;
              return updateNode(assign, { left: slotDeref(m.base, t) } as Partial<AssignExpr>);
            }
            return undefined;
          },
        });
        body = rewriteSites(body) as CompoundStmt;
      }

      const synth = [...aliases].filter(([name]) => !rewrites.has(name));
      if (synth.length > 0) {
        const decls = synth.map(([name, type]) => Stmt.declStmt([Decl.variable(name, type)]));
        body = updateNode(body, {
          statements: [...decls, ...body.statements],
        } as Partial<CompoundStmt>);
      }

      if (body === node.body) return undefined;
      return updateNode(node, { body } as Partial<FunctionDecl>);
    },
  });
}

export const underscoreSlotLocalPlugin: TransformPlugin = {
  id: 'underscore-slot-local',
  name: 'Underscore Storage-Slot Local Synthesis',
  description: 'Declares Ghidra `_<base>` storage-slot locals, and renders a width alias as `*(T*)&<base>`',
  version: '2.0.0',
  defaultEnabled: true,
  // Run LAST (after boilerplate-cleanup at 500): synthesizing a declaration early
  // lets later decl-cleanup passes strip it again. The slot-local must persist.
  priority: 600,
  tags: ['cleanup', 'declaration'],
  createTransformer: createUnderscoreSlotLocalTransformer,
};

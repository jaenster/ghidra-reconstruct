/**
 * Member Copy Assign Plugin
 *
 * A struct assignment `a = *p;` is compiled by VC8 /O2 as a copy of the object in its widest
 * pieces: a 6-byte packet as a dword and a word, a 15-byte one as three dwords, a word and a
 * byte. The decompiler prints those as stores at the pieces' offsets, member by member where
 * a member starts there and as a pun where it does not:
 *
 *   aPacket.nPacketId = pPacket->nPacketId;            aPacket = *pPacket;
 *   aPacket.nQuestId = pPacket->nQuestId;        ->
 *   ...                                               (NET_D2GS_SERVER_Send_0x5D_QuestState 0053d710)
 *
 *   G.nPacketId = pPacket->nPacketId; ...             G = *pPacket;
 *   *(uint32_t *)((char *)&G + 4) = *(uint32_t *)&pPacket->field_0x4;
 *   ...                                               (NPCMENU_HandleTradePacket 004b6390)
 *
 * Compiled as printed, each store moves its own member, a byte at a time where the members
 * are bytes. A run of consecutive statements is written as the assignment when
 *
 *   - each statement is `D = S;`, D a piece of one object X (a member `X.f`, or a store
 *     `*(T *)ADDR` at a byte offset into X) and S the same bytes of `*P` (`P->f`, or a read
 *     at the same offset), P a pointer local or parameter;
 *   - X and *P have the same struct type T, the pieces do not overlap, and together they
 *     cover every byte of T;
 *   - X is a local whose address is not taken before the run (so P cannot point into it:
 *     the frame is this call's own), or a global, which a T-typed *P either is (a copy onto
 *     itself, which both forms leave unchanged) or does not overlap: two distinct objects of
 *     one type never share a byte;
 *   - P is not written in the run, and X is not P.
 *
 * Value-preserving: every byte of X receives the byte of *P at the same offset, as before,
 * and the run reads nothing else.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, ExprStmt, FunctionDecl, Identifier, ParameterDecl, PointerType, Statement,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName, bareName } from './call-arg-cast.js';
import { covers, disjoint, lvalueSpan, unwrap, type LayoutField, type RootInfo, type Span } from './byte-spans.js';

export interface MemberCopyAssignOptions extends PluginOptions {
  structLayouts?: Record<string, ReadonlyArray<LayoutField>>;
  aggregateSizes?: Record<string, number>;
  typedefTargets?: Record<string, string>;
  /** Global name -> its emitted declaration type spelling. */
  globalTypes?: Record<string, string>;
  onSite?: (e: { target: string; source: string; type: string; pieces: number }) => void;
}

function resolve(name: string, typedefs: Record<string, string>): string {
  for (let i = 0; i < 8; i++) {
    const t = typedefs[name];
    if (!t || t.includes('*') || t.includes('[')) break;
    name = bareName(t.replace(/^(struct|union|class)\s+/, '').trim());
  }
  return name;
}

function createMemberCopyAssignTransformer(options: MemberCopyAssignOptions = {}): Transformer {
  const layouts = options.structLayouts ?? {};
  const sizes = options.aggregateSizes ?? {};
  const typedefs = options.typedefTargets ?? {};
  const globals = options.globalTypes ?? {};
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      // Name -> declared type, for names declared once in the function.
      const pointee = new Map<string, string>();
      const value = new Map<string, string>();
      const count = new Map<string, number>();
      const note = (name: string, t: ASTNode, local: boolean, specifiers: string[] = []) => {
        count.set(name, (count.get(name) ?? 0) + 1);
        if (t.kind === NodeKind.PointerType) {
          const n = typeNodeName(((t as PointerType).pointee as unknown as { name?: unknown }).name);
          if (n) pointee.set(name, resolve(bareName(n), typedefs));
        } else if (local && t.kind !== NodeKind.ArrayType && !specifiers.includes('static') && !specifiers.includes('extern')) {
          const n = typeNodeName((t as unknown as { name?: unknown }).name);
          if (n) value.set(name, resolve(bareName(n), typedefs));
        }
      };
      for (const p of fn.parameters as ParameterDecl[]) if (p.name) note(p.name.name, p.type, false);
      for (const n of traverseAST(fn.body)) {
        if (n.kind === NodeKind.VariableDecl) note((n as VariableDecl).name.name, (n as VariableDecl).type, true, (n as VariableDecl).specifiers);
      }
      for (const [k, c] of count) if (c !== 1) { pointee.delete(k); value.delete(k); }
      const globalType = (name: string): string | undefined => {
        if (count.has(name)) return undefined;
        const t = globals[name];
        if (!t || t.includes('*') || t.includes('[')) return undefined;
        return resolve(bareName(t.replace(/^(const\s+|struct\s+|volatile\s+)+/, '').trim()), typedefs);
      };
      const typeOf = (name: string, arrow: boolean) => arrow ? pointee.get(name) : value.get(name) ?? globalType(name);
      const lookup = (name: string, arrow: boolean): RootInfo | null => {
        const t = typeOf(name, arrow);
        const fields = t ? layouts[t] : undefined, size = t ? sizes[t] : undefined;
        return fields && size ? { fields, size } : null;
      };
      const piece = (st: Statement): { d: Span; s: Span } | null => {
        if (st.kind !== NodeKind.ExprStmt) return null;
        const e = unwrap((st as ExprStmt).expression);
        if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
        const a = e as AssignExpr;
        const d = lvalueSpan(a.left, lookup), s = lvalueSpan(a.right, lookup);
        if (!d || !s || d.arrow || !s.arrow || d.start !== s.start || d.size !== s.size) return null;
        return { d, s };
      };
      // Locals whose address is taken, by statement: X must not have escaped before the run.
      const addressedIn = (n: ASTNode, name: string): boolean => {
        for (const m of traverseAST(n)) {
          if (m.kind === NodeKind.UnaryExpr && (m as UnaryExpr).operator === '&') {
            let o = unwrap((m as UnaryExpr).operand);
            while (o.kind === NodeKind.MemberExpr && !(o as unknown as { isArrow: boolean }).isArrow) o = unwrap((o as unknown as { object: never }).object);
            if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
          }
        }
        return false;
      };
      let changed = false;
      const all = fn.body;
      const inner = createTransformer({
        visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
          const list = block.statements;
          const out: Statement[] = [];
          let edited = false;
          for (let i = 0; i < list.length;) {
            const first = piece(list[i]);
            if (!first) { out.push(list[i++]); continue; }
            const x = first.d.root, p = first.s.root;
            const tx = typeOf(x, false), tp = typeOf(p, true);
            let j = i;
            const pieces: Array<{ d: Span; s: Span }> = [];
            for (; j < list.length; j++) {
              const q = piece(list[j]);
              if (!q || q.d.root !== x || q.s.root !== p) break;
              pieces.push(q);
            }
            const info = lookup(x, false);
            const ok = !!tx && tx === tp && !!info && x !== p && pieces.length >= 2
              && disjoint(pieces.map(q => q.d))
              && covers(pieces.map(q => q.d), 0, info.size)
              && pieces.every(q => q.d.start + q.d.size <= info.size)
              && (globalType(x) !== undefined || !escapedBefore(all, list[i], x, addressedIn));
            if (!ok) { out.push(list[i++]); continue; }
            const stmt = Stmt.expr(Expr.assign(Expr.identifier(x), Expr.deref(Expr.identifier(p))));
            stmt.location = list[i].location;
            (stmt as unknown as { leadingTrivia: unknown }).leadingTrivia = list[i].leadingTrivia;
            out.push(stmt);
            options.onSite?.({ target: x, source: p, type: tx!, pieces: pieces.length });
            i = j;
            edited = true;
          }
          if (!edited) return undefined;
          changed = true;
          return updateNode(block, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const body = inner(fn.body);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/** X's address is taken anywhere in the text before the statement `at` (conservative: by offset). */
function escapedBefore(body: ASTNode, at: Statement, name: string, addressedIn: (n: ASTNode, name: string) => boolean): boolean {
  const limit = at.location?.start?.offset;
  if (limit === undefined) return true;
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.UnaryExpr || (n as UnaryExpr).operator !== '&') continue;
    const o = n.location?.start?.offset;
    if (o === undefined || n.location.file === '<generated>') { if (addressedIn(n, name)) return true; continue; }
    if (o < limit && addressedIn(n, name)) return true;
  }
  return false;
}

export const memberCopyAssignPlugin: TransformPlugin = {
  id: 'member-copy-assign',
  name: 'Member Copy Assign',
  description: 'Piecewise copies of every byte of *P into a same-typed object are the struct assignment',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 975.5,
  tags: ['matching'],
  createTransformer: (options: MemberCopyAssignOptions = {}) => createMemberCopyAssignTransformer(options),
};

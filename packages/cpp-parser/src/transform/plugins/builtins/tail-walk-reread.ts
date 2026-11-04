/**
 * Tail Walk Reread Plugin
 *
 * The walk to the last node of a list, `while (p->pNext) p = p->pNext;`, comes out of the
 * decompiler with the link held in a local it tests:
 *
 *     T* pNext = p->pNext;                       while (p->pNext) {
 *     while (pNext) {                      ->      p = p->pNext;
 *       p = p->pNext;                            }
 *       pNext = p->pNext;
 *     }
 *
 * The original compares the link in memory at each test (`cmp dword ptr [eax+0x10], 0; jne`,
 * WALL2_InsertUnitDrawBelow 004dcfa0, AllocUiPartyFromRoster 0049a1d0,
 * NET_QServerClientPacket_CreateStructAndCopyBytesThere 006c23b0). Compiled as printed, VC8
 * keeps the local in a register of its own and tests that instead.
 *
 * `N = P->f;` (or `T N = P->f;`) right before `while (N) { P = P->f; N = P->f; }` becomes
 * `while (P->f) { P = P->f; }` when
 *   - P is a plain name (a local, a parameter or a global) and f a member read through it;
 *   - N is a local whose address is never taken and which is named nowhere else in the
 *     function but in a declaration of its own without a value (dropped with it);
 *   - the loop body is exactly those two statements.
 *
 * Value-preserving: each test of the loop read N, which held P->f as read right before it,
 * with no store or call in between; the rewrite reads P->f at the test itself. The body
 * reads P->f as before, and after the loop N is never read.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier,
  MemberExpr, ParameterDecl, ParenExpr, Statement, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, nodesEqual, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface TailWalkRereadOptions extends PluginOptions {
  onSite?: (e: { variable: string; pointer: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `X = E;` or `T X = E;`: X, E and whether it declares. */
function valueOf(s: Statement): { x: string; e: Expression; decl: boolean } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unwrap((e as AssignExpr).left);
    if (l.kind !== NodeKind.Identifier) return null;
    return { x: (l as Identifier).name, e: unwrap((e as AssignExpr).right), decl: false };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
    if (v.specifiers.includes('static') || v.specifiers.includes('extern')) return null;
    return { x: v.name.name, e: unwrap(v.initializer as Expression), decl: true };
  }
  return null;
}

/** `P->f` with P a plain name: P. */
function linkRead(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.MemberExpr || !(u as MemberExpr).isArrow) return null;
  const o = unwrap((u as MemberExpr).object);
  return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
}

/** `T N;` with no value. */
function bareDecl(s: Statement, x: string): boolean {
  if (s.kind !== NodeKind.DeclStmt) return false;
  const ds = (s as DeclStmt).declarations;
  return ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && (ds[0] as VariableDecl).name.name === x &&
    !(ds[0] as VariableDecl).initializer && !(ds[0] as VariableDecl).specifiers.includes('static');
}

/** Names of x in n, not counting member names (`p->x`). */
function countName(n: ASTNode, x: string): number {
  const members = new Set<ASTNode>();
  let c = 0;
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) c++;
  }
  return c;
}

function createTailWalkRereadTransformer(options: TailWalkRereadOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const all = [...traverseAST(fn.body)];
      const params = new Set((fn.parameters as ParameterDecl[]).map(p => p.name?.name).filter(Boolean) as string[]);
      const declCount = new Map<string, number>();
      for (const n of all) if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
      }
      const addressed = new Set<string>();
      for (const n of all) if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = unwrap((n as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
      }
      const body = cloneNode(fn.body) as CompoundStmt;
      const sites: Array<{ list: Statement[]; i: number; x: string; p: string }> = [];
      const visit = (n: ASTNode): void => {
        for (const k of getChildren(n)) visit(k);
        if (n.kind !== NodeKind.CompoundStmt) return;
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i + 1 < list.length; i++) {
          const init = valueOf(list[i]);
          if (!init || list[i + 1].kind !== NodeKind.WhileStmt) continue;
          const w = list[i + 1] as WhileStmt;
          const c = unwrap(w.condition);
          if (c.kind !== NodeKind.Identifier || (c as Identifier).name !== init.x) continue;
          const p = linkRead(init.e);
          if (!p || p === init.x) continue;
          if (w.body.kind !== NodeKind.CompoundStmt) continue;
          const bs = (w.body as CompoundStmt).statements;
          if (bs.length !== 2) continue;
          const step = valueOf(bs[0]); const again = valueOf(bs[1]);
          if (!step || !again || step.decl || again.decl) continue;
          if (step.x !== p || again.x !== init.x) continue;
          if (!nodesEqual(step.e, init.e) || !nodesEqual(again.e, init.e)) continue;
          if (params.has(init.x) || addressed.has(init.x) || (declCount.get(init.x) ?? 0) !== 1) continue;
          sites.push({ list, i, x: init.x, p });
        }
      };
      visit(body);
      if (!sites.length) return undefined;
      let changed = false;
      for (const s of sites) {
        const init = valueOf(s.list[s.i])!;
        // N named only by the init, the test, the body store and (maybe) one bare declaration.
        const named = countName(body, s.x);
        const bare = !init.decl && findBare(body, s.x);
        if (named !== 3 + (bare ? 1 : 0)) continue;
        if (!init.decl && !bare) continue;
        const w = s.list[s.i + 1] as WhileStmt;
        const step = (w.body as CompoundStmt).statements[0];
        const loop: WhileStmt = {
          ...w,
          leadingTrivia: s.list[s.i].leadingTrivia,
          condition: cloneNode(init.e) as Expression,
          body: { ...(w.body as CompoundStmt), statements: [step] } as CompoundStmt,
        };
        s.list.splice(s.i, 2, loop);
        if (bare) removeBare(body, s.x);
        changed = true;
        options.onSite?.({ variable: s.x, pointer: s.p });
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/** Whether some block holds a bare `T N;` declaration of N. */
function findBare(n: ASTNode, x: string): boolean {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.CompoundStmt && (m as CompoundStmt).statements.some(s => bareDecl(s, x))) return true;
  }
  return false;
}

function removeBare(n: ASTNode, x: string): void {
  for (const m of traverseAST(n)) {
    if (m.kind !== NodeKind.CompoundStmt) continue;
    const list = (m as CompoundStmt).statements;
    const j = list.findIndex(s => bareDecl(s, x));
    if (j >= 0) { list.splice(j, 1); return; }
  }
}

export const tailWalkRereadPlugin: TransformPlugin = {
  id: 'tail-walk-reread',
  name: 'Tail Walk Reread',
  description: 'A walk to the last node of a list tests the link in memory, not a copy of it',
  version: '1.0.0',
  defaultEnabled: true,
  // With the other late matching shapes, after search-loop-exit (989.85).
  priority: 989.86,
  tags: ['matching'],
  createTransformer: (options: TailWalkRereadOptions = {}) => createTailWalkRereadTransformer(options),
};

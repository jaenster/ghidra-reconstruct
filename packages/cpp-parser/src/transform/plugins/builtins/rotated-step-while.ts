/**
 * Rotated Step While Plugin
 *
 * A loop over a list that frees or replaces the node it stands on, `while (X) { N = next(X);
 * ...; X = N; }`, comes out of the decompiler rotated, testing the copy at the bottom:
 *
 *     if (gpHead) {                               while (gpHead) {
 *       do {                                        pNext = gpHead->pNext;
 *         pNext = gpHead->pNext;           ->       FREE(gpHead);
 *         FREE(gpHead);                             gpHead = pNext;
 *         gpHead = pNext;                         }
 *       } while (pNext);
 *       gpHead = 0;
 *     }
 *
 * loop-rotation-undo takes `if (C) do B while (C)` only with one condition in both places;
 * here the bottom test reads the copy the body just stored into X. The trailing `X = 0;`
 * is the store VC8 needs no code for: X is null there. Compiled as printed, VC8 stores the
 * zero again after the loop where the original falls straight into the code after it
 * (FreeGamePalShift 00476fb0: `jne` at the loop's bottom into `pop esi`).
 *
 * `if (X) { do { B; X = N; } while (N); [X = 0;] }` becomes `while (X) { B; X = N; }` when
 *   - X is a plain name and N a local declared with a pointer type, so `X = N` keeps N's
 *     truth value in X (a pointer, or a bool, X may be);
 *   - the `if` has no else and holds only the do-while and, optionally, the zero store;
 *   - a declaration `T* N;` Ghidra prints first in the `if` goes into the loop at N's first
 *     store when that store is the first statement of B naming N (`T* N = E;`), N is then
 *     given its value before any read in every turn; otherwise it stays ahead of the loop;
 *   - B holds no `continue` of the loop (in a do-while it runs the bottom test, in the
 *     while loop it would skip `X = N`), no label, and no goto.
 *
 * Value-preserving: the first test of the while loop is the guard; each later one tests X
 * right after `X = N`, which is the do-while's test of N. When the loop ends X is null, so
 * the dropped `X = 0` stored what X already held.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, CStyleCastExpr, DeclStmt, DoWhileStmt, MemberExpr, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, ParenExpr, Statement, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RotatedStepWhileOptions extends PluginOptions {
  onSite?: (e: { variable: string; copy: string; zeroStore: boolean }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function name(e: Expression): string | null {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/** `X = E;`: X and E. */
function assignment(s: Statement): { x: string; e: Expression } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const x = name((e as AssignExpr).left);
  return x ? { x, e: unwrap((e as AssignExpr).right) } : null;
}

function isZero(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value === 0n;
  return u.kind === NodeKind.NullptrLiteral || (u.kind === NodeKind.Identifier && (u as Identifier).name === 'NULL');
}

/** `T N;` with no value: N. */
function bareDecl(s: Statement): string | null {
  if (s.kind !== NodeKind.DeclStmt) return null;
  const ds = (s as DeclStmt).declarations;
  if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
  const v = ds[0] as VariableDecl;
  return v.initializer || v.specifiers.includes('static') ? null : v.name.name;
}

/** Names of x in n, not counting member names (`p->x`). */
function names(n: ASTNode, x: string): number {
  const members = new Set<ASTNode>();
  let c = 0;
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) c++;
  }
  return c;
}

/** A `continue` that belongs to the loop whose body is n (not to a loop nested in it). */
function ownContinue(n: ASTNode): boolean {
  if (n.kind === NodeKind.ContinueStmt) return true;
  if (n.kind === NodeKind.WhileStmt || n.kind === NodeKind.DoWhileStmt || n.kind === NodeKind.ForStmt ||
      n.kind === NodeKind.ForRangeStmt) return false;
  return getChildren(n).some(ownContinue);
}

function createRotatedStepWhileTransformer(options: RotatedStepWhileOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const all = [...traverseAST(fn.body)];
      const pointerLocals = new Map<string, number>();
      for (const n of all) if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        const isPointer = (v.type as { kind?: string } | undefined)?.kind === NodeKind.PointerType;
        pointerLocals.set(v.name.name, (pointerLocals.get(v.name.name) ?? 0) + (isPointer ? 1 : 2));
      }
      const body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      const visit = (n: ASTNode): void => {
        for (const k of getChildren(n)) visit(k);
        if (n.kind !== NodeKind.CompoundStmt) return;
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i < list.length; i++) {
          if (list[i].kind !== NodeKind.IfStmt) continue;
          const g = list[i] as IfStmt;
          if (g.elseBranch || g.init) continue;
          const x = name(g.condition);
          if (!x) continue;
          const inner = g.thenBranch.kind === NodeKind.CompoundStmt ? (g.thenBranch as CompoundStmt).statements : [g.thenBranch];
          // Ghidra declares the copy inside the guard: `if (X) { T* N; do ... }`.
          const decl = inner.length && bareDecl(inner[0]) ? inner[0] as DeclStmt : null;
          const k = decl ? 1 : 0;
          if (inner.length < k + 1 || inner.length > k + 2 || inner[k].kind !== NodeKind.DoWhileStmt) continue;
          let zeroStore = false;
          if (inner.length === k + 2) {
            const z = assignment(inner[k + 1]);
            if (!z || z.x !== x || !isZero(z.e)) continue;
            zeroStore = true;
          }
          const d = inner[k] as DoWhileStmt;
          const copy = name(d.condition);
          if (!copy || copy === x || pointerLocals.get(copy) !== 1) continue;
          if (decl && bareDecl(decl) !== copy) continue;
          if (d.body.kind !== NodeKind.CompoundStmt) continue;
          const bs = [...(d.body as CompoundStmt).statements];
          const last = bs.length ? assignment(bs[bs.length - 1]) : null;
          if (!last || last.x !== x || name(last.e) !== copy) continue;
          if (ownContinue(d.body)) continue;
          if ([...traverseAST(d.body)].some(m => m.kind === NodeKind.LabelStmt || m.kind === NodeKind.GotoStmt)) continue;
          const out: Statement[] = [];
          if (decl) {
            // The copy is given its value before any read in each turn: declare it there.
            const j = bs.findIndex(t => names(t, copy) > 0);
            const first = j >= 0 ? assignment(bs[j]) : null;
            if (first && first.x === copy && names(first.e as ASTNode, copy) === 0 && j < bs.length - 1) {
              const v = decl.declarations[0] as VariableDecl;
              bs[j] = { ...decl, leadingTrivia: bs[j].leadingTrivia, declarations: [{ ...v, initializer: first.e }] } as DeclStmt;
            } else {
              out.push(decl);
            }
          }
          out.push({
            kind: NodeKind.WhileStmt,
            condition: g.condition,
            body: { ...(d.body as CompoundStmt), statements: bs },
            leadingTrivia: g.leadingTrivia,
            trailingTrivia: g.trailingTrivia,
            location: g.location,
          } as WhileStmt);
          list.splice(i, 1, ...out);
          i += out.length - 1;
          changed = true;
          options.onSite?.({ variable: x, copy, zeroStore });
        }
      };
      visit(body);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const rotatedStepWhilePlugin: TransformPlugin = {
  id: 'rotated-step-while',
  name: 'Rotated Step While',
  description: 'A guarded do-while testing the copy it steps its pointer to becomes a while loop on the pointer',
  version: '1.0.0',
  defaultEnabled: true,
  // With the other late matching shapes, after tail-walk-reread (989.86).
  priority: 989.865,
  tags: ['matching'],
  createTransformer: (options: RotatedStepWhileOptions = {}) => createRotatedStepWhileTransformer(options),
};

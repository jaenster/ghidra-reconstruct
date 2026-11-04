/**
 * Guard Copy Sink Plugin
 *
 * A copy of a value into a local, printed ahead of a guard that tests the value itself,
 *
 *     D2TextBoxStrc* pPopup = gpStaticTextPopup;      if (!gpStaticTextPopup) {
 *     if (!gpStaticTextPopup) {                  ->      return;
 *       return;                                        }
 *     }                                                D2TextBoxStrc* pPopup = gpStaticTextPopup;
 *
 * was written after the guard: the guard tests the global, not the local, so the original
 * had not made the copy yet. Ghidra hoists it because the register holding the value is
 * loaded before the test. Compiled where it is printed, VC8 copies the value into its own
 * register ahead of the branch (TEXT_FreeStaticTextBox 0049e300: `mov esi, eax` before the
 * `je`), where the original moves it below the branch.
 *
 * `X = G;` or `T X = G;` right before `if (!G) EXIT` moves below the `if` when
 *   - G is a global's name, so the test neither writes it nor reads anything the copy
 *     writes. A copy of a parameter or of a member read (`pOrig = pUnit;`, `p =
 *     pCell->pList;`) is where the original made it as often as not: Ghidra prints those
 *     copies for values the original kept in two registers, and moved they lose matches
 *     (WALL2_InsertUnitDraw 004dd600, FreeAiOfMinions 0058f160);
 *   - the copy is not inside a loop: there the guard is the loop's exit and the copy its
 *     step (DAMAGE_RemoveObjectAtSameCoords 0057cc30 matches as printed);
 *   - X is a local whose address is never taken, and EXIT neither names X nor falls
 *     through: it ends in a `return`;
 *   - the `if` has no else.
 *
 * Value-preserving: the test reads G before and after the move alike, and on the exit path
 * X is never read again (the function returns); on the other path X holds G before its
 * first read, as before. A declaration moves with its value, so X's scope only shrinks past
 * an `if` that never names it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, ParameterDecl, ParenExpr, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, nodesEqual, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface GuardCopySinkOptions extends PluginOptions {
  onSite?: (e: { variable: string; line: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** A global's name: not a local or parameter of the function. */
function isGlobal(e: Expression, locals: ReadonlyMap<string, number>): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.QualifiedId) return true;
  return u.kind === NodeKind.Identifier && !locals.has((u as Identifier).name);
}

/** The expression a `!E` / `E == 0` test is about. */
function nullTested(e: Expression): Expression | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') return unwrap((u as UnaryExpr).operand);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==') {
    const r = unwrap((u as BinaryExpr).right);
    if ((r.kind === NodeKind.IntegerLiteral && (r as unknown as { value: bigint }).value === 0n) || r.kind === NodeKind.NullptrLiteral) {
      return unwrap((u as BinaryExpr).left);
    }
  }
  return null;
}

/** `X = G;` or `T X = G;`, X and G. */
function copyOf(s: Statement): { x: string; from: Expression } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unwrap((e as AssignExpr).left);
    if (l.kind !== NodeKind.Identifier) return null;
    return { x: (l as Identifier).name, from: unwrap((e as AssignExpr).right) };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
    if (v.specifiers.includes('static') || v.specifiers.includes('extern')) return null;
    return { x: v.name.name, from: unwrap(v.initializer as Expression) };
  }
  return null;
}

function stmts(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function endsInReturn(s: Statement): boolean {
  const list = stmts(s);
  const last = list[list.length - 1];
  return !!last && (last.kind === NodeKind.ReturnStmt || (last.kind === NodeKind.CompoundStmt && endsInReturn(last)));
}

function names(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier) out.add((m as Identifier).name);
  return out;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

function createGuardCopySinkTransformer(options: GuardCopySinkOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const all = [...traverseAST(fn.body)];
      if (all.some(n => n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt)) return undefined;
      const locals = new Map<string, number>();
      for (const p of fn.parameters as ParameterDecl[]) if (p.name) locals.set(p.name.name, (locals.get(p.name.name) ?? 0) + 1);
      for (const n of all) if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        locals.set(v.name.name, (locals.get(v.name.name) ?? 0) + (v.specifiers.includes('static') ? 2 : 1));
      }
      const addressed = new Set<string>();
      for (const n of all) {
        if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
          const o = unwrap((n as UnaryExpr).operand);
          if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
        }
      }
      const body = cloneNode(fn.body) as CompoundStmt;
      let changed = false;
      const visit = (n: ASTNode, inLoop: boolean): void => {
        const loop = inLoop || LOOPS.has(n.kind);
        for (const k of getChildren(n)) visit(k, loop);
        if (n.kind !== NodeKind.CompoundStmt || inLoop) return;
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i + 1 < list.length; i++) {
          const c = copyOf(list[i]);
          const g = list[i + 1];
          if (!c || g.kind !== NodeKind.IfStmt) continue;
          const guard = g as IfStmt;
          if (guard.elseBranch || guard.init) continue;
          const tested = nullTested(guard.condition);
          if (!tested || !isGlobal(tested, locals) || !nodesEqual(tested, c.from)) continue;
          if (locals.get(c.x) !== 1 || addressed.has(c.x)) continue;
          if (names(c.from).has(c.x) || names(guard).has(c.x)) continue;
          if (!endsInReturn(guard.thenBranch)) continue;
          const copy = list[i];
          list.splice(i, 2, { ...guard, leadingTrivia: copy.leadingTrivia } as IfStmt, { ...copy, leadingTrivia: [] } as Statement);
          changed = true;
          options.onSite?.({ variable: c.x, line: copy.location?.start.line ?? 0 });
          i++;
        }
      };
      visit(body, false);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const guardCopySinkPlugin: TransformPlugin = {
  id: 'guard-copy-sink',
  name: 'Guard Copy Sink',
  description: 'A copy of a value printed ahead of a guard that tests the value moves below the guard',
  version: '1.0.0',
  defaultEnabled: true,
  // After search-loop-exit (989.85), which reads `X = G; if (!G)` as the guard of a search.
  priority: 989.9,
  tags: ['matching'],
  createTransformer: (options: GuardCopySinkOptions = {}) => createGuardCopySinkTransformer(options),
};

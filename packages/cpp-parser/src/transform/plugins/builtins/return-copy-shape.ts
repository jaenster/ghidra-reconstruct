/**
 * Return Copy Shape Plugins
 *
 * VC8 /O2 treats a return the source wrote once and a return it wrote twice differently:
 *
 *   one `return K` reached by a join       the return is tail-duplicated: each way into the
 *   (`if (c1) A else if (c2) B; return K`) join gets a copy of its own (`mov al, 1; pop esi;
 *                                          ret` after A, and again after c2's tests)
 *   two `return K` statements              cross-jumped into one copy: a later test jumps
 *   (`if (c1) { A; return K; } ...`)       back to the copy after A
 *
 * Ghidra's structurer prints it the other way round: a single shared return block comes out
 * as the join (the arms fall into one `return K`), and two copies come out as two return
 * statements. So the printed shape is the opposite of the source's, and VC8 compiles the
 * printed shape to the opposite layout. Two rewrites put the source shape back:
 *
 *   split  `if (c1) A else if (c2) B...; return K;` with A falling through:
 *          `if (c1) { A; return K; } if (c2) B...; return K;`
 *          (Q02_SequenceFilter 005910f0: one copy of `return true` after A, c2's false edge
 *          jumps back to it.)
 *   join   `if (c1) { A; return K; } if (c2) return K; return J;` with A code of its own:
 *          `if (c1) { A } else if (!c2) { return J; } return K;`
 *          (D2WINANIMIMAGE_TryAdvanceToPlaying 00500340: two copies of `return 1`.)
 *
 * Both are value-preserving. split: A falls through into `return K` in both forms, and c2 is
 * tested only when c1 failed, as the else did; `return K` is evaluated at the same point.
 * join: c1 true runs A then returns K; c1 false returns K when c2 holds and J otherwise; the
 * negation of c2 is exact (branch-layout `negate`). K and J are constants (a literal, an
 * enumerator or a cast of one), so nothing is evaluated in a new place. Neither rewrite is
 * made across a `case`/`default` label inside the moved statements.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, Expression, FunctionDecl, IfStmt, ReturnStmt, Statement, ParenExpr, CStyleCastExpr,
} from '../../../ast/nodes.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { leaves } from './assert-order.js';
import { negate } from './branch-layout/index.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';

export interface ReturnCopyShapeOptions extends PluginOptions {
  noreturnFunctions?: string[];
  onSite?: (e: { rule: 'split' | 'join'; function: string; line: number }) => void;
}

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

/** A literal, an enumerator-like name or `nullptr`, under casts and parentheses. */
function isConstant(e: Expression | null): boolean {
  if (!e) return false;
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as unknown as { operator: string }).operator === '-') {
    return isConstant((u as unknown as { operand: Expression }).operand);
  }
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.BoolLiteral || u.kind === NodeKind.CharLiteral
    || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.QualifiedId
    || (u.kind === NodeKind.Identifier && /^([A-Z][A-Z0-9_]*|nullptr|true|false)$/.test((u as unknown as { name: string }).name));
}

function constantReturn(s: Statement | undefined): ReturnStmt | null {
  if (!s) return null;
  if (s.kind === NodeKind.CompoundStmt) {
    const l = (s as CompoundStmt).statements;
    return l.length === 1 ? constantReturn(l[0]) : null;
  }
  if (s.kind !== NodeKind.ReturnStmt) return null;
  return isConstant((s as ReturnStmt).value) ? s as ReturnStmt : null;
}

const key = (r: ReturnStmt) => emit(r.value as unknown as AnyNode).replace(/\s+/g, '');

function asList(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

function holdsCase(s: ASTNode): boolean {
  for (const n of traverseAST(s)) if (n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) return true;
  return false;
}

function lineOf(s: ASTNode): number {
  return (s as unknown as { location?: { start: { line: number } } }).location?.start.line ?? 0;
}

/** split: `if (c1) A else if (c2) ...; return K;` -> `if (c1) { A; return K; } if (c2) ...; return K;`. */
function splitBlock(block: CompoundStmt, noreturn: ReadonlySet<string>): number {
  const l = block.statements;
  const n = l.length;
  if (n < 2) return 0;
  const ret = constantReturn(l[n - 1]);
  if (!ret || l[n - 1].kind !== NodeKind.ReturnStmt) return 0;
  const s = l[n - 2];
  if (s.kind !== NodeKind.IfStmt) return 0;
  const top = s as IfStmt;
  if (top.init || top.isConstexpr || !top.elseBranch || top.elseBranch.kind !== NodeKind.IfStmt) return 0;
  const a = asList(top.thenBranch);
  if (a.length === 0 || leaves(a[a.length - 1], noreturn)) return 0;
  // A runs off its end unconditionally: its last statement is plain code, not an if or a
  // loop whose own exits fall into the return (GetDirectionFromCoordinates, Q32_ActiveFilter
  // keep the join).
  if (a[a.length - 1].kind !== NodeKind.ExprStmt) return 0;
  if (a.every(x => x.kind === NodeKind.DeclStmt || x.kind === NodeKind.NullStmt)) return 0;
  if (holdsCase(top)) return 0;
  const then = Stmt.compound([...a, cloneNode(ret)]);
  const first: IfStmt = { ...top, thenBranch: then, elseBranch: null };
  l.splice(n - 2, 1, first, top.elseBranch);
  return 1;
}

/** join: `if (c1) { A; return K; } if (c2) return K; return J;` -> `if (c1) { A } else if (!c2) { return J; } return K;`. */
function joinBlock(block: CompoundStmt, noreturn: ReadonlySet<string>): number {
  const l = block.statements;
  const n = l.length;
  for (let i = 0; i + 2 < n; i++) {
    const f = l[i], g = l[i + 1];
    if (g.kind !== NodeKind.IfStmt || f.kind !== NodeKind.IfStmt) continue;
    const guard = g as IfStmt, top = f as IfStmt;
    if (guard.elseBranch || guard.init || top.elseBranch || top.init || top.isConstexpr || guard.isConstexpr) continue;
    const k = constantReturn(guard.thenBranch);
    if (!k) continue;
    const a = asList(top.thenBranch);
    if (a.length < 2) continue;
    const last = constantReturn(a[a.length - 1]);
    if (!last || a[a.length - 1].kind !== NodeKind.ReturnStmt || key(last) !== key(k)) continue;
    const body = a.slice(0, -1);
    if (body.every(x => x.kind === NodeKind.DeclStmt || x.kind === NodeKind.NullStmt)) continue;
    const rest = l.slice(i + 2);
    // R... is one constant return of another value. A longer rest (Q14_StatusFilter, a run
    // of `return true` guards) is a chain the original wrote as guards: the join loses it.
    const r0 = constantReturn(rest[0]);
    if (rest.length !== 1 || !r0 || rest[0].kind !== NodeKind.ReturnStmt || key(r0) === key(k)) continue;
    if (!leaves(rest[0], noreturn) || holdsCase(top)) continue;
    const inner = Stmt.if_(negate(guard.condition), Stmt.compound(rest.map(x => cloneNode(x))), null);
    const joined: IfStmt = { ...top, thenBranch: Stmt.compound(body), elseBranch: inner };
    l.splice(i, n - i, joined, cloneNode(k));
    return 1;
  }
  return 0;
}

function rewriteFunction(fn: FunctionDecl, rule: 'split' | 'join', opts: ReturnCopyShapeOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]);
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = false;
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const b = n as CompoundStmt;
    const line = lineOf(b.statements[b.statements.length - 2] ?? b);
    const hit = rule === 'split' ? splitBlock(b, noreturn) : joinBlock(b, noreturn);
    if (hit) { changed = true; opts.onSite?.({ rule, function: fname, line }); }
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function factory(rule: 'split' | 'join') {
  return (options: ReturnCopyShapeOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, rule, options);
    },
  });
}

export const returnCopySplitPlugin: TransformPlugin = {
  id: 'return-copy-split',
  name: 'Return Copy Split',
  description: 'An else-if chain whose first arm falls into a constant return gets the return written in that arm',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.975,
  tags: ['matching'],
  createTransformer: factory('split'),
};

export const returnCopyJoinPlugin: TransformPlugin = {
  id: 'return-copy-join',
  name: 'Return Copy Join',
  description: 'An arm and a guard returning the same constant before a different final return become an else-if join',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.98,
  tags: ['matching'],
  createTransformer: factory('join'),
};

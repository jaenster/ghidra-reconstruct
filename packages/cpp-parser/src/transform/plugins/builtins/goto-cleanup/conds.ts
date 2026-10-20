/**
 * Condition DAG folding (design T3, step 8): a goto that only finishes evaluating a
 * condition. Ghidra's structurer cannot print a condition whose true edge is shared by two
 * branches of a test tree, so it prints one test, then jumps from inside the other arm to
 * the shared target:
 *
 *   if (!h) { b = Load(); if (b) goto L; } else { L: X }       // GetModuleInfoForAddress 00401df0
 *     ->  if (h || (b = Load(), b)) { X }
 *
 *   if (A) { W; if (C) goto L; R } else { L: X }   ->  if (A && (W, !C)) { R } else { X }
 *   if (A) { L: X } else { W; if (C) goto L; R }   ->  if (A || (W, C)) { X } else { R }
 *
 * The arms stay in the binary's order (MSVC lays `if (c) T else E` out as tests, T, E).
 *
 * Nested tests on the way to the goto fold with `&&` (`if (c1) { if (c2) goto L; }` is
 * `c1 && c2`). Every atom is evaluated once, in Ghidra's order, on every path - which is
 * what the validator proves; nothing is copied (class E5). W, work on the way, is allowed
 * only as the condition temporaries Ghidra prints (`b = Load()` then a test of b): at most
 * two assignments, each read by the test that follows. Anything else keeps its goto.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, Expression, ExprStmt, GotoStmt, IfStmt, Statement,
} from '../../../../ast/nodes.js';
import { Expr, Stmt } from '../../../../ast/factory.js';
import { traverseAST } from '../../../../ast/visitor.js';
import { updateNode } from '../../../transformer.js';
import { isNoreturnStmt } from '../../../cfg/bcfg.js';
import { countGotosInStatements } from './analysis.js';
import { type Path, dropLabel, findLabel, getAt, gotoPaths, isCaseLike, isPrefix, setAt } from './paths.js';
import { invertCondition } from './loops.js';

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

const paren = (e: Expression) => (strip(e) === e && e.kind !== NodeKind.Identifier ? Expr.paren(e) as Expression : e);

function hasLabel(s: Statement): boolean {
  for (const n of traverseAST(s as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return true;
  return false;
}

function identsOf(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier) out.add((x as unknown as { name: string }).name);
  return out;
}

/** `x = e;` whose target is a plain identifier: a condition temporary candidate. */
function tempAssign(s: Statement, noreturn: ReadonlySet<string>): string | null {
  if (s.kind !== NodeKind.ExprStmt || isNoreturnStmt(s, noreturn)) return null;
  const e = strip((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = strip((e as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? (l as unknown as { name: string }).name : null;
}

function asList(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

function isGotoTo(s: Statement, name: string): boolean {
  const l = asList(s).filter(x => x.kind !== NodeKind.NullStmt);
  return l.length === 1 && l[0].kind === NodeKind.GotoStmt && (l[0] as GotoStmt).label.name === name;
}

/**
 * The condition under which a list reaches `goto name`: [temps...] if (C) <goto | chain>,
 * every other path falling off the list's end. `rest` is what may follow at the top level
 * (only the outermost list may have one).
 */
function chainOf(list: Statement[], name: string, noreturn: ReadonlySet<string>, top: boolean): { cond: Expression; neg: Expression; rest: Statement[] } | null {
  const l = list.filter(x => x.kind !== NodeKind.NullStmt);
  let i = 0;
  const temps: Statement[] = [];
  while (i < l.length && l[i].kind === NodeKind.ExprStmt) { temps.push(l[i]); i++; }
  if (temps.length > 2) return null;
  const s = l[i];
  if (!s || s.kind !== NodeKind.IfStmt) return null;
  const f = s as IfStmt;
  if (f.elseBranch || f.init || f.isConstexpr) return null;
  // Each temporary is assigned and read by the test it feeds.
  const read = identsOf(f.condition as ASTNode);
  for (const t of temps) {
    const v = tempAssign(t, noreturn);
    if (!v || !read.has(v) || hasLabel(t)) return null;
  }
  let cond: Expression, neg: Expression;
  if (isGotoTo(f.thenBranch, name)) {
    cond = f.condition;
    neg = invertCondition(f.condition);
  } else {
    if (hasLabel(f.thenBranch)) return null;
    const inner = chainOf(asList(f.thenBranch), name, noreturn, false);
    if (!inner || inner.rest.length) return null;
    cond = Expr.binary(paren(f.condition), '&&', paren(inner.cond)) as Expression;
    neg = Expr.binary(paren(invertCondition(f.condition)), '||', paren(inner.neg)) as Expression;
  }
  for (let k = temps.length - 1; k >= 0; k--) {
    const t = (temps[k] as ExprStmt).expression;
    cond = Expr.paren(Expr.binary(t, ',' as never, cond) as Expression) as Expression;
    neg = Expr.paren(Expr.binary(t, ',' as never, neg) as Expression) as Expression;
  }
  const rest = l.slice(i + 1);
  if (!top && rest.length) return null;
  if (rest.some(hasLabel)) return null;
  return { cond, neg, rest };
}

export interface FoldContext { noreturn: ReadonlySet<string> }

/** Fold the condition DAG behind `goto name`, or null. */
export function dagFold(body: CompoundStmt, name: string, ctx: FoldContext): { body: CompoundStmt; sites: number } | null {
  const slot = findLabel(body, name);
  if (!slot || slot.k !== 0 || slot.wrappers.length !== 1 || slot.list.length === 0) return null;
  const armStep = slot.list[slot.list.length - 1];
  if (armStep.f !== 'thenBranch' && armStep.f !== 'elseBranch') return null;
  const ifPath: Path = slot.list.slice(0, -1);
  const ifs = getAt(body as ASTNode, ifPath) as IfStmt;
  if (ifs.kind !== NodeKind.IfStmt || ifs.init || ifs.isConstexpr || !ifs.elseBranch) return null;
  const labelInThen = armStep.f === 'thenBranch';
  const other = labelInThen ? ifs.elseBranch : ifs.thenBranch;
  const otherPath: Path = [...ifPath, { f: labelInThen ? 'elseBranch' : 'thenBranch' }];
  // Exactly one goto to the label sits in the other arm; others may come from elsewhere.
  const inOther = gotoPaths(body, name).filter(p => isPrefix(otherPath, p));
  if (inOther.length !== 1) return null;
  const ch = chainOf(asList(other!), name, ctx.noreturn, true);
  if (!ch) return null;
  const A = ifs.condition;
  // X keeps the label only when gotos from elsewhere still reach it.
  const xArm = labelInThen ? ifs.thenBranch : ifs.elseBranch!;
  const total = countGotosInStatements(body.statements).get(name) ?? 0;
  let xStmts = asList(xArm);
  if (total === 1) xStmts = [dropLabel(xStmts[0], name), ...xStmts.slice(1)];
  const X = updateNode(Stmt.compound(xStmts), { location: xArm.location } as never) as Statement;
  const R = ch.rest.length ? updateNode(Stmt.compound(ch.rest), { location: other!.location } as never) as Statement : null;
  // The arms keep the binary's order: MSVC lays `if (c) T else E` out as the tests, T, E.
  // Label in the then arm: X came first, `if (A || (W, C)) X else R`. Label in the else
  // arm: R came first, `if (A && (W, !C)) R else X`; with no R, `if (!A || (W, C)) X`.
  let cond: Expression, then: Statement, els: Statement | null;
  if (labelInThen) {
    cond = Expr.binary(paren(A), '||', paren(ch.cond)) as Expression;
    then = X; els = R;
  } else if (R) {
    cond = Expr.binary(paren(A), '&&', paren(ch.neg)) as Expression;
    then = R; els = X;
  } else {
    cond = Expr.binary(paren(invertCondition(A)), '||', paren(ch.cond)) as Expression;
    then = X; els = null;
  }
  (cond as { location?: unknown }).location = A.location;
  const nif = updateNode(ifs, { condition: cond, thenBranch: then, elseBranch: els });
  return { body: setAt(body as ASTNode, ifPath, nif) as CompoundStmt, sites: 1 };
}

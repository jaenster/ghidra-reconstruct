/**
 * A test MSVC threaded, restored where the library source shows it (design T4, admitted
 * only with E1 evidence: `library-evidence.ts` marks the label `rethreaded`).
 *
 * The source tests a condition twice with nothing between that could change it. The
 * compiler knows the second outcome on the paths through the first test and jumps past it;
 * Ghidra prints one test and a goto into the other arm. Two shapes:
 *
 *   A  if (A) { if (C) goto L; } else if (C) T;  W  L:        // inflateSetDictionary
 *        ->  if (!A && C) T;  if (!C) { W }  L:
 *      (either arm order; T does not fall through)
 *
 *   B  if (S) { if (I) T; L1: if (P) goto M; } else if (!I) goto L1;  W  M:    // deflate
 *        ->  if (S && I) T;  if (I || !P) { W }  M:
 *      (zlib 1.2.8 deflate.c 893/899: `if (s->status == FINISH_STATE && strm->avail_in != 0)
 *      ERR_RETURN(..); if (strm->avail_in != 0 || s->lookahead != 0 || ..)`)
 *
 * The second test re-evaluates C (or I): the validator accepts that only through its
 * threaded-test facts (equivalence.ts, A4) - a pure atom, nothing between the evaluations.
 * This file only proposes; every candidate is proven on the whole body.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type { CompoundStmt, Expression, GotoStmt, IfStmt, Statement } from '../../../../ast/nodes.js';
import { Expr, Stmt } from '../../../../ast/factory.js';
import { updateNode } from '../../../transformer.js';
import { emit } from '../../../../emit/index.js';
import { countGotosInStatements } from './analysis.js';
import { invertCondition } from './loops.js';
import { libraryLabel } from './library-evidence.js';
import { type Path, dropLabel, emitText, fallsThrough, findLabel, getAt, setList } from './paths.js';

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}
const paren = (e: Expression) => (strip(e) === e && e.kind !== NodeKind.Identifier ? Expr.paren(e) as Expression : e);
const condText = (e: Expression) => emit(e as never).trim();

/** The single statement of an arm (a compound of one, or the statement itself). */
function only(s: Statement | null): Statement | null {
  while (s && s.kind === NodeKind.CompoundStmt) {
    const l = (s as CompoundStmt).statements;
    if (l.length !== 1) return null;
    s = l[0];
  }
  return s;
}

/** `if (c) goto name;` with no else: c. */
function gotoGuard(s: Statement | null, name: string): Expression | null {
  if (!s || s.kind !== NodeKind.IfStmt || (s as IfStmt).elseBranch) return null;
  const g = only((s as IfStmt).thenBranch);
  return g && g.kind === NodeKind.GotoStmt && (g as GotoStmt).label.name === name ? (s as IfStmt).condition : null;
}

/** `if (c) T` with no else and T not falling through: [c, T]. */
function terminatingGuard(s: Statement | null, noreturn: ReadonlySet<string>): [Expression, Statement] | null {
  if (!s || s.kind !== NodeKind.IfStmt || (s as IfStmt).elseBranch) return null;
  const t = (s as IfStmt).thenBranch;
  if (fallsThrough(t, noreturn)) return null;
  return [(s as IfStmt).condition, t];
}

const sameCond = (a: Expression, b: Expression) => condText(a) === condText(b);
const negOf = (a: Expression, b: Expression) => condText(notCond(a)) === condText(b) || condText(a) === condText(notCond(b));

/** The negation, pushed through `&&`/`||` (De Morgan) to the atoms, each inverted as written. */
function notCond(e: Expression): Expression {
  const u = strip(e);
  if (u.kind === NodeKind.UnaryExpr && (u as unknown as { operator: string }).operator === '!') return (u as unknown as { operand: Expression }).operand;
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as unknown as { operator: string; left: Expression; right: Expression };
    if (b.operator === '&&' || b.operator === '||') {
      return Expr.binary(paren(notCond(b.left)), b.operator === '&&' ? '||' : '&&', paren(notCond(b.right))) as Expression;
    }
  }
  return invertCondition(e);
}

function withoutLabel(list: Statement[], k: number, name: string, body: Statement[]): Statement[] {
  if ((countGotosInStatements(body).get(name) ?? 0) > 0) return list;
  const out = [...list];
  out[k] = dropLabel(out[k], name);
  return out;
}

/** Shape A, with `name` the label L the goto in one arm jumps to. */
function shapeA(body: CompoundStmt, name: string, noreturn: ReadonlySet<string>): CompoundStmt | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const list = (getAt(body, slot.list) as CompoundStmt).statements;
  for (let j = slot.k - 1; j >= 0; j--) {
    const s0 = list[j];
    if (s0.kind !== NodeKind.IfStmt || !(s0 as IfStmt).elseBranch) continue;
    const ifs = s0 as IfStmt;
    const thenS = only(ifs.thenBranch), elseS = only(ifs.elseBranch);
    let sel: Expression, c: Expression, t: Statement;
    const gThen = gotoGuard(thenS, name), gElse = gotoGuard(elseS, name);
    const tThen = terminatingGuard(thenS, noreturn), tElse = terminatingGuard(elseS, noreturn);
    if (gThen && tElse && sameCond(gThen, tElse[0])) { sel = notCond(ifs.condition); [c, t] = tElse; }
    else if (gElse && tThen && sameCond(gElse, tThen[0])) { sel = ifs.condition; [c, t] = tThen; }
    else continue;
    const W = list.slice(j + 1, slot.k);
    if (!W.length) return null;
    const first = updateNode(ifs, { condition: Expr.binary(paren(sel), '&&', paren(c)) as Expression, thenBranch: t, elseBranch: null });
    const wBlock = Stmt.compound(W);
    wBlock.location = W[0].location;
    const second = Stmt.if_(notCond(c), wBlock, null);
    second.location = W[0].location;
    const nl = [...list.slice(0, j), first, second, ...list.slice(slot.k)];
    let next = setList(body, slot.list, nl) as CompoundStmt;
    const s2 = findLabel(next, name)!;
    next = setList(next, s2.list, withoutLabel((getAt(next, s2.list) as CompoundStmt).statements, s2.k, name, next.statements)) as CompoundStmt;
    return next;
  }
  return null;
}

/** Shape B, with `name` the label L1 inside one arm that the other arm's goto enters. */
function shapeB(body: CompoundStmt, name: string, noreturn: ReadonlySet<string>): CompoundStmt | null {
  const slot = findLabel(body, name);
  if (!slot || slot.k !== 1 || slot.list.length < 2) return null;
  const arm = (getAt(body, slot.list) as CompoundStmt).statements;
  if (arm.length !== 2) return null;
  const tg = terminatingGuard(arm[0], noreturn);
  if (!tg) return null;
  const [I, T] = tg;
  const l1 = slot.inner;
  if (l1.kind !== NodeKind.IfStmt || (l1 as IfStmt).elseBranch) return null;
  const mGoto = only((l1 as IfStmt).thenBranch);
  if (!mGoto || mGoto.kind !== NodeKind.GotoStmt) return null;
  const M = (mGoto as GotoStmt).label.name;
  const P = (l1 as IfStmt).condition;
  // The arm is a branch of S0, which sits in a list.
  const armStep = slot.list[slot.list.length - 1];
  if (armStep.f !== 'thenBranch' && armStep.f !== 'elseBranch') return null;
  const s0Path: Path = slot.list.slice(0, -1);
  const s0Step = s0Path[s0Path.length - 1];
  if (!s0Step || s0Step.f !== 'statements') return null;
  const ifs = getAt(body, s0Path) as IfStmt;
  if (ifs.kind !== NodeKind.IfStmt || !ifs.elseBranch) return null;
  const other = only(armStep.f === 'thenBranch' ? ifs.elseBranch : ifs.thenBranch);
  const og = gotoGuard(other, name);
  if (!og || !negOf(og, I)) return null;
  const S = armStep.f === 'thenBranch' ? ifs.condition : notCond(ifs.condition);
  const listPath = s0Path.slice(0, -1);
  const j = s0Step.i!;
  const list = (getAt(body, listPath) as CompoundStmt).statements;
  const mSlot = findLabel(body, M);
  if (!mSlot || mSlot.list.length !== listPath.length) return null;
  if (mSlot.list.some((s, i) => s.f !== listPath[i].f || s.i !== listPath[i].i) || mSlot.k <= j) return null;
  const W = list.slice(j + 1, mSlot.k);
  if (!W.length) return null;
  const first = updateNode(ifs, { condition: Expr.binary(paren(S), '&&', paren(I)) as Expression, thenBranch: T, elseBranch: null });
  const wBlock = Stmt.compound(W);
  wBlock.location = W[0].location;
  const second = Stmt.if_(Expr.binary(paren(I), '||', paren(notCond(P))) as Expression, wBlock, null);
  second.location = W[0].location;
  let next = setList(body, listPath, [...list.slice(0, j), first, second, ...list.slice(mSlot.k)]) as CompoundStmt;
  for (const lab of [name, M]) {
    const sl = findLabel(next, lab);
    if (!sl) continue;
    next = setList(next, sl.list, withoutLabel((getAt(next, sl.list) as CompoundStmt).statements, sl.k, lab, next.statements)) as CompoundStmt;
  }
  return next;
}

/** A candidate body for the label, or null. Only for labels the library evidence marks. */
export function rethread(body: CompoundStmt, name: string, noreturn: ReadonlySet<string>): CompoundStmt | null {
  if (!libraryLabel(name)?.rethreaded) return null;
  return shapeB(body, name, noreturn) ?? shapeA(body, name, noreturn);
}

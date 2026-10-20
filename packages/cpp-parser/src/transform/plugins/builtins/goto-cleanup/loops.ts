/**
 * Loop rewrites (design step 7): gotos that are a loop's own control - a second back edge
 * to its head, a jump to its increment, an exit to a block after it - become `continue`,
 * a `for` header, or `break`.
 *
 *   headContinue  (RETARGET) `L: while (C) { .. goto L; .. }` - the goto re-enters the loop
 *                 exactly as `continue` does: for a `while`, a `for (; C;)` without an
 *                 increment, and a constant-true `do ... while (true)` (or a label at the
 *                 start of such a loop's body). Gotos inside a nested loop stay.
 *   topContinue   (RETARGET) `do { L: .. goto L; .. } while (C)` - a second back edge to the
 *                 top of a bottom-tested loop. A `continue` there would run C, so the loop
 *                 becomes `while (true) { ..continue..; if (!C) break; }` - which MSVC
 *                 compiles exactly as the do-while Ghidra saw. Refused when the body already
 *                 has a `continue` of its own (it meant C).
 *   latchFor      (RETARGET, or a lemma) a loop whose body ends `L: i++;` with gotos to L is a
 *                 `for` whose `continue`s MSVC emitted as jumps to the increment:
 *                   while (C) { ..goto L..; L: I; }                -> for (; C; I) { ..continue.. }
 *                   while (true) { if (X) E; ..; L: I; }            -> for (; !X; I) { .. } E
 *                   do { ..; L: I; } while (C);                     -> for (init; C; I) { .. }
 *                   while (true) { ..; L: I; if (X) E; }            -> for (init; !X; I) { .. } E
 *                 The last two evaluate C once more than the original, before the first
 *                 iteration: the ENTRY LEMMA (below) must show C true there. E, a block that
 *                 cannot fall through (`return x;`), moves after the loop when the loop has no
 *                 other `break` - the place the for's exit reaches. The statement before the
 *                 loop that assigns a variable I writes becomes the for's init.
 *   exitSwap      (MOVE / UNFOLD) `while (true) { ..break..; ..goto L.. } N; L: T` where N
 *                 cannot fall into L: the loop has two exits, and the one MSVC laid out after
 *                 it (N) goes back to the breaks that reach it, so the gotos become `break`.
 *                 One break moves N; several copy it under the copy policy.
 *   exitMove      (MOVE) the block after an infinite loop, reached by its one break, that
 *                 jumps back into the loop: it goes back to the break.
 *   exitHoist     (MOVE) an infinite loop with no break whose exit block sits inside it at a
 *                 label: the block goes after the loop, the ways into it become `break`.
 *   rotateEntry   (MOVE) a loop nothing falls into, entered only at a label in its body: the
 *                 body rotates so the loop starts at the label.
 *
 * ## The entry lemma (a lemma pass, design 3.1)
 *
 * Lemma: if C holds at the entry of a bottom-tested loop S, then `S` and `if (C) S else E`
 * are the same program, for any E. The validator is run with that applied to the BEFORE
 * side (`if (C) S else E`, E chosen to be what the for's exit reaches), so what it proves is
 * the rewrite; the lemma itself rests on `entryHolds` showing C true at S's entry from
 * facts that hold on every path into S:
 *
 *   - `v = K;` (K an integer literal 0..127) with no write to v after it;
 *   - `a = b;` between two locals neither of which is written after it;
 *   - a guard: S in the then-arm of `if (G)` (G holds), in its else-arm (!G), or after
 *     `if (G) E;` with E unable to fall through (!G), G's variables not written after it.
 *
 * A fact stops at a label (another way in) and at a loop or switch body; a call kills every
 * fact about memory (globals, members, anything whose address is taken), a write kills the
 * facts about what it writes. C is evaluated by substituting the constants and then, for
 * `x OP K` / `x` / `!x`, by checking that the set of values the guards allow for x lies in
 * the set C accepts - unions of real intervals whose endpoints are the literals, so the check
 * is exact (an integer is a real). Literals are integers in [0, 2^31): the comparison means
 * the same for a signed and an unsigned x. Anything else: unknown, and the loop keeps its
 * gotos. The lemma's exhaustive test is in __tests__/goto-loops.test.ts.
 *
 * Every candidate is the whole body before and after, proven by the validator through the
 * same `accept()` as every other handler.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, DoWhileStmt, Expression, ExprStmt, ForStmt,
  GotoStmt, IfStmt, LabelStmt, Statement, UnaryExpr, WhileStmt,
} from '../../../../ast/nodes.js';
import { Expr, Stmt } from '../../../../ast/factory.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { updateNode } from '../../../transformer.js';
import { isNoreturnStmt } from '../../../cfg/bcfg.js';
import { deepCloneStatements, negateCondition } from './helpers.js';
import { countGotosInStatements } from './analysis.js';
import { judgeCopy, type EvidenceClass } from './copy-policy.js';
import {
  type Path, LOOPS, comparePaths, emitText, fallsThrough, findLabel, freeJumps, getAt, gotoPaths, isCaseLike,
  isPrefix, key, setAt, setList, dropLabel, after,
} from './paths.js';

export type LoopKind = 'headContinue' | 'topContinue' | 'latchFor' | 'exitSwap' | 'exitMove' | 'exitHoist' | 'rotateEntry';

export interface LoopRewrite {
  kind: LoopKind;
  body: CompoundStmt;
  /** The before side the validator proves against, when a lemma was applied to it. */
  before: CompoundStmt | null;
  sites: number;
  /** exitSwap: the block put back at the breaks, and how. */
  copy: { cls: EvidenceClass; tail: Statement[]; copies: number } | null;
}

// ---------------------------------------------------------------------------------------
// Small facts
// ---------------------------------------------------------------------------------------

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}

function constTrue(e: Expression | null): boolean {
  if (!e) return true;
  const u = strip(e);
  if (u.kind === NodeKind.BoolLiteral) return (u as unknown as { value: boolean }).value === true;
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value !== 0n;
  return false;
}

/** A loop that only leaves by a jump: while (true), do ... while (true), for (..;;..). */
function infinite(s: Statement): boolean {
  if (s.kind === NodeKind.WhileStmt || s.kind === NodeKind.DoWhileStmt) return constTrue((s as WhileStmt).condition);
  if (s.kind === NodeKind.ForStmt) return (s as ForStmt).condition === null || constTrue((s as ForStmt).condition);
  return false;
}

/** The loop's continue point is its head: `while`, `for (; C;)` with no init or increment, constant-true do-while. */
function continueIsHead(s: Statement): boolean {
  if (s.kind === NodeKind.WhileStmt) return true;
  if (s.kind === NodeKind.DoWhileStmt) return constTrue((s as DoWhileStmt).condition);
  if (s.kind === NodeKind.ForStmt) return !(s as ForStmt).init && !(s as ForStmt).increment;
  return false;
}

/** Walk statements below `n` without entering loops (or, with `switches`, switches either). */
function walkOwn(n: ASTNode, at: (x: ASTNode) => void, switches: boolean): void {
  if (!n || typeof n !== 'object') return;
  at(n);
  if (LOOPS.has(n.kind)) return;
  if (switches && n.kind === NodeKind.SwitchStmt) return;
  for (const c of getChildren(n)) if (String(c.kind).endsWith('Stmt')) walkOwn(c, at, switches);
}

function ownContinue(stmts: Statement[]): boolean {
  let f = false;
  for (const s of stmts) walkOwn(s as ASTNode, x => { if (x.kind === NodeKind.ContinueStmt) f = true; }, false);
  return f;
}

/** Paths of the `break`s in the loop body at `bodyPath` that bind to that loop. */
function ownBreaks(root: ASTNode, bodyPath: Path): Path[] {
  const out: Path[] = [];
  const go = (n: ASTNode, path: Path): void => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === NodeKind.BreakStmt) { out.push(path); return; }
    if (path.length > bodyPath.length && (LOOPS.has(n.kind) || n.kind === NodeKind.SwitchStmt)) return;
    for (const [s, c] of stmtSteps(n)) go(c, [...path, s]);
  };
  go(getAt(root, bodyPath), bodyPath);
  return out;
}

function stmtSteps(n: ASTNode): [Path[number], ASTNode][] {
  switch (n.kind) {
    case NodeKind.CompoundStmt:
      return (n as CompoundStmt).statements.map((s, i) => [{ f: 'statements', i }, s as ASTNode]);
    case NodeKind.IfStmt: {
      const f = n as IfStmt;
      const out: [Path[number], ASTNode][] = [[{ f: 'thenBranch' }, f.thenBranch as ASTNode]];
      if (f.elseBranch) out.push([{ f: 'elseBranch' }, f.elseBranch as ASTNode]);
      return out;
    }
    case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt: case NodeKind.SwitchStmt:
      return [[{ f: 'body' }, (n as unknown as { body: ASTNode }).body]];
    case NodeKind.LabelStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt:
      return [[{ f: 'statement' }, (n as unknown as { statement: ASTNode }).statement]];
    default:
      return [];
  }
}

/** True when no loop body lies between the loop body at `bodyPath` and `site`. */
function noLoopBetween(root: ASTNode, bodyPath: Path, site: Path): boolean {
  for (let d = bodyPath.length + 1; d < site.length; d++) {
    if (site[d].f !== 'body') continue;
    if (LOOPS.has(getAt(root, site.slice(0, d)).kind)) return false;
  }
  return true;
}

/** No loop or switch body between the loop body at `bodyPath` and `site`. */
function noBreakableBetween(root: ASTNode, bodyPath: Path, site: Path): boolean {
  for (let d = bodyPath.length + 1; d < site.length; d++) {
    if (site[d].f !== 'body') continue;
    const k = getAt(root, site.slice(0, d)).kind;
    if (LOOPS.has(k) || k === NodeKind.SwitchStmt) return false;
  }
  return true;
}

/** The labels wrapping list[k], outermost first, and the statement inside them (no case labels). */
function unwrapLabels(s: Statement): { names: string[]; inner: Statement; hasCase: boolean } {
  const names: string[] = [];
  let hasCase = false;
  let cur = s;
  while (cur.kind === NodeKind.LabelStmt || isCaseLike(cur as ASTNode)) {
    if (cur.kind === NodeKind.LabelStmt) names.push((cur as LabelStmt).label.name);
    else hasCase = true;
    cur = (cur as LabelStmt).statement;
  }
  return { names, inner: cur, hasCase };
}

/** Rebuild `s` (a label/case chain) with its innermost statement replaced. */
function rewrapInner(s: Statement, inner: Statement): Statement {
  if (s.kind === NodeKind.LabelStmt || isCaseLike(s as ASTNode)) {
    return updateNode(s as LabelStmt, { statement: rewrapInner((s as LabelStmt).statement, inner) });
  }
  return inner;
}

/** The path of the statement inside the label/case chain at `p`. */
function innerPath(root: ASTNode, p: Path): Path {
  let n = getAt(root, p);
  const out = [...p];
  while (n.kind === NodeKind.LabelStmt || isCaseLike(n)) {
    out.push({ f: 'statement' });
    n = (n as LabelStmt).statement as ASTNode;
  }
  return out;
}

function totalGotos(body: CompoundStmt, name: string): number {
  return countGotosInStatements(body.statements).get(name) ?? 0;
}

function withLoc<T extends ASTNode>(n: T, like: ASTNode, trivia = true): T {
  (n as { location?: unknown }).location = like.location;
  if (trivia) (n as { leadingTrivia?: unknown }).leadingTrivia = like.leadingTrivia ?? [];
  return n;
}

/** Replace every goto at `sites` by `make()`. */
function retargetAt(root: ASTNode, sites: Path[], make: (g: GotoStmt) => Statement): ASTNode {
  let cur = root;
  for (const p of sites) {
    const g = getAt(cur, p) as GotoStmt;
    const r = make(g);
    (r as { location?: unknown }).location = g.location;
    (r as { leadingTrivia?: unknown }).leadingTrivia = g.leadingTrivia ?? [];
    cur = setAt(cur, p, r);
  }
  return cur;
}

/** Drop the label `name` from the chain at its slot, when no goto to it is left. */
function dropIfUnused(body: CompoundStmt, name: string): CompoundStmt {
  if (totalGotos(body, name) > 0) return body;
  const s = findLabel(body, name);
  if (!s) return body;
  const list = [...(getAt(body as ASTNode, s.list) as CompoundStmt).statements];
  list[s.k] = dropLabel(list[s.k], name);
  return setList(body as ASTNode, s.list, list) as CompoundStmt;
}

const REL = new Set(['<', '<=', '>', '>=', '==', '!=']);
const INVERSE: Record<string, string> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' };
const MIRROR: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

function isIntLiteral(e: Expression): boolean {
  const u = strip(e);
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral;
}

/**
 * The negation of a loop-exit test, as the for's condition: a comparison against an integer
 * literal is inverted with the variable on the left (`0x13 < n` -> `n <= 0x13`); anything
 * else is `!(X)`. The validator reads both the same way (bcfg canonicalises comparisons
 * against an integer literal).
 */
export function invertCondition(e: Expression): Expression {
  const u = strip(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    // `(w, c)` is c after w: its inverse is `(w, !c)`.
    if ((b.operator as string) === ',') {
      return withLoc(Expr.paren(Expr.binary(b.left, ',' as never, invertCondition(b.right)) as Expression) as Expression, e, false);
    }
    // `==` / `!=` invert for every type; the order comparisons only against an integer literal.
    if (b.operator === '==' || b.operator === '!=') {
      return withLoc(Expr.binary(b.left, (b.operator === '==' ? '!=' : '==') as never, b.right), e, false);
    }
    if (REL.has(b.operator) && (isIntLiteral(b.left) || isIntLiteral(b.right))) {
      const litLeft = isIntLiteral(b.left) && !isIntLiteral(b.right);
      const op = INVERSE[b.operator];
      return litLeft
        ? withLoc(Expr.binary(b.right, MIRROR[op] as never, b.left), e, false)
        : withLoc(Expr.binary(b.left, op as never, b.right), e, false);
    }
  }
  return negateCondition(e);
}

// ---------------------------------------------------------------------------------------
// headContinue / topContinue
// ---------------------------------------------------------------------------------------

/** Where a label sits relative to a loop: on the loop itself, or first in its body. */
function loopOfLabel(body: CompoundStmt, name: string): { loopPath: Path; loop: Statement; atBodyStart: boolean } | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const list = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const stmtPath: Path = [...slot.list, { f: 'statements', i: slot.k }];
  const ip = innerPath(body as ASTNode, stmtPath);
  const inner = getAt(body as ASTNode, ip) as Statement;
  if (LOOPS.has(inner.kind) && inner.kind !== NodeKind.ForRangeStmt) {
    // The label must be the outermost wrapper's chain around the loop itself.
    return { loopPath: ip, loop: inner, atBodyStart: false };
  }
  if (slot.k === 0 && slot.list.length > 0 && slot.list[slot.list.length - 1].f === 'body') {
    const lp = slot.list.slice(0, -1);
    const loop = getAt(body as ASTNode, lp) as Statement;
    if (LOOPS.has(loop.kind) && loop.kind !== NodeKind.ForRangeStmt && !list.slice(0, slot.k).length) {
      return { loopPath: lp, loop, atBodyStart: true };
    }
  }
  return null;
}

export function headContinue(body: CompoundStmt, name: string): LoopRewrite | null {
  const at = loopOfLabel(body, name);
  if (!at) return null;
  const { loopPath, loop, atBodyStart } = at;
  const bodyPath: Path = [...loopPath, { f: 'body' }];
  const inside = gotoPaths(body, name).filter(p => isPrefix(bodyPath, p) && noLoopBetween(body as ASTNode, bodyPath, p));
  if (!inside.length) return null;
  // `L: while (C)` / constant-true do-while: continue re-enters at L. At the start of the
  // body only an infinite loop's continue lands there.
  const direct = atBodyStart ? (infinite(loop) && continueIsHead(loop)) : continueIsHead(loop);
  if (direct) {
    let cur = retargetAt(body as ASTNode, inside, () => Stmt.continue_()) as CompoundStmt;
    cur = dropIfUnused(cur, name);
    return { kind: 'headContinue', body: cur, before: null, sites: inside.length, copy: null };
  }
  // A bottom-tested do-while: the goto is a second back edge to its top.
  if (loop.kind !== NodeKind.DoWhileStmt) return null;
  const dw = loop as DoWhileStmt;
  if (dw.body.kind !== NodeKind.CompoundStmt) return null;
  if (ownContinue((dw.body as CompoundStmt).statements)) return null;
  let cur = retargetAt(body as ASTNode, inside, () => Stmt.continue_());
  const dw2 = getAt(cur, loopPath) as DoWhileStmt;
  const b2 = dw2.body as CompoundStmt;
  const exit = withLoc(Stmt.if_(invertCondition(dw2.condition), Stmt.break_()), dw2.condition as ASTNode, false);
  const loopNew = withLoc(Stmt.while_(Expr.boolLiteral(true), updateNode(b2, { statements: [...b2.statements, exit] })), dw2 as ASTNode);
  cur = setAt(cur, loopPath, loopNew);
  const out = dropIfUnused(cur as CompoundStmt, name);
  return { kind: 'topContinue', body: out, before: null, sites: inside.length, copy: null };
}

// ---------------------------------------------------------------------------------------
// latchFor
// ---------------------------------------------------------------------------------------

function isWorkExpr(s: Statement, noreturn: ReadonlySet<string>): boolean {
  if (s.kind !== NodeKind.ExprStmt || isNoreturnStmt(s, noreturn)) return false;
  const e = strip((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr || e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.CallExpr
    || (e.kind === NodeKind.UnaryExpr && ((e as UnaryExpr).operator === '++' || (e as UnaryExpr).operator === '--'));
}

/** The lvalue an increment statement writes, as text. */
function writtenBy(e: Expression): string | null {
  const u = strip(e);
  if (u.kind === NodeKind.AssignExpr) return lvText((u as AssignExpr).left);
  if (u.kind === NodeKind.PostfixExpr || u.kind === NodeKind.UnaryExpr) {
    const op = (u as UnaryExpr).operator;
    if (op === '++' || op === '--') return lvText((u as UnaryExpr).operand);
  }
  return null;
}

function lvText(e: Expression): string | null {
  try { return emitText(Stmt.expr(strip(e)) as Statement).replace(/;$/, ''); } catch { return null; }
}

/** `if (X) E` with no else and an E that cannot fall through. */
function exitTest(s: Statement, noreturn: ReadonlySet<string>): { cond: Expression; exit: Statement[] } | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const n = s as IfStmt;
  if (n.elseBranch || fallsThrough(n.thenBranch, noreturn)) return null;
  const exit = n.thenBranch.kind === NodeKind.CompoundStmt ? (n.thenBranch as CompoundStmt).statements : [n.thenBranch];
  return { cond: n.condition, exit };
}

/** What the for's exit must reach for an exit block E: E itself after the loop (its own break dropped). */
function exitAfter(exit: Statement[]): Statement[] | null {
  let e = exit.filter(s => s.kind !== NodeKind.NullStmt);
  if (e.length && e[e.length - 1].kind === NodeKind.BreakStmt) e = e.slice(0, -1);
  // A jump that binds to something outside would bind differently after the loop.
  const fj = freeJumps(e);
  if (fj.brk || fj.cont) return null;
  if (e.some(s => s.kind === NodeKind.LabelStmt || s.kind === NodeKind.DeclStmt)) return null;
  for (const s of e) for (const n of traverseAST(s as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return null;
  return e;
}

const isBareReturn = (s: Statement) => s.kind === NodeKind.ReturnStmt && !(s as unknown as { value: unknown }).value;

/** Falling off the statement at `path` ends the function: off the body's end, or into a bare `return;`. */
function fallsToEnd(root: ASTNode, path: Path): boolean {
  const c = after(root, path);
  if (c.k === 'exit') return true;
  if (c.k !== 'pos') return false;
  const s = (getAt(root, c.list) as CompoundStmt).statements[c.i];
  return isBareReturn(s);
}

export interface LatchContext {
  noreturn: ReadonlySet<string>;
  /** The function returns void: falling off its body is `return;`. */
  voidFn?: boolean;
  /** The function's parameter names (locals, unless their address is taken). */
  params?: ReadonlySet<string>;
}

export function latchFor(body: CompoundStmt, name: string, ctx: LatchContext): LoopRewrite | null {
  const slot = findLabel(body, name);
  if (!slot || slot.list.length === 0) return null;
  const lastStep = slot.list[slot.list.length - 1];
  if (lastStep.f !== 'body') return null;
  const loopPath = slot.list.slice(0, -1);
  const loop = getAt(body as ASTNode, loopPath) as Statement;
  if (!LOOPS.has(loop.kind) || loop.kind === NodeKind.ForRangeStmt) return null;
  if (loop.kind === NodeKind.ForStmt && (loop as ForStmt).increment) return null;
  const Bd = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const k = slot.k;
  const head = unwrapLabels(Bd[k]);
  if (head.hasCase) return null;
  const bodyPath = slot.list;
  // Every label on the latch is entered only from the body before it, never from a nested loop.
  const sites: Path[] = [];
  for (const L of head.names) {
    const ps = gotoPaths(body, L);
    if (ps.some(p => !isPrefix(bodyPath, p) || p[bodyPath.length].i! >= k || !noLoopBetween(body as ASTNode, bodyPath, p))) return null;
    sites.push(...ps);
  }
  if (!sites.length) return null;
  let latch = [head.inner, ...Bd.slice(k + 1)].filter(s => s.kind !== NodeKind.NullStmt);
  let pre = Bd.slice(0, k);
  // The forms.
  let cond: Expression | null;
  let exit: Statement[] | null = null;
  let lemma = false;
  const last = latch[latch.length - 1];
  const bottom = last ? exitTest(last, ctx.noreturn) : null;
  const inf = infinite(loop);
  let topForm = false;
  // `while (C) { ..; L: I; if (X) E; }`: a for whose condition is the bottom test, its
  // top test C a `break` at the start of the body (Ghidra folds the body's first test into
  // the while: `for (..; i < n; i++) { p = get(i); if (!p) break; .. }` prints as
  // `while (p = get(i), p != 0) { ..; i++; if (n <= i) return; }`).
  let topBreak: Statement | null = null;
  if (!inf && loop.kind === NodeKind.WhileStmt && bottom && latch.length > 1) {
    const c = (loop as WhileStmt).condition;
    topBreak = withLoc(Stmt.if_(invertCondition(c), Stmt.break_()), c as ASTNode, false);
  }
  if ((inf || topBreak) && bottom && latch.length > 1) {
    // while (true) { ..; L: I; if (X) E; }
    latch = latch.slice(0, -1);
    cond = invertCondition(bottom.cond);
    exit = exitAfter(bottom.exit);
    lemma = true;
  } else if (inf) {
    const top = pre.length ? exitTest(pre[0], ctx.noreturn) : null;
    if (!top) return null;
    // while (true) { if (X) E; ..; L: I; }
    pre = pre.slice(1);
    topForm = true;
    // The test itself is not part of the body that may jump to the latch.
    if (sites.some(p => p[bodyPath.length].i === 0)) return null;
    cond = invertCondition(top.cond);
    exit = exitAfter(top.exit);
  } else if (loop.kind === NodeKind.DoWhileStmt) {
    cond = (loop as DoWhileStmt).condition;
    lemma = true;
  } else {
    cond = (loop as WhileStmt).condition;
  }
  if (exit === null && (inf || topBreak)) return null;
  if (!latch.length || latch.length > 3 || !latch.every(s => isWorkExpr(s, ctx.noreturn))) return null;
  if (ownContinue(pre)) return null;

  // The list holding the loop, and the loop's place in it (through its own labels).
  let lp = loopPath;
  let wrapped = false;
  while (lp.length && lp[lp.length - 1].f === 'statement') { lp = lp.slice(0, -1); wrapped = true; }
  if (!lp.length || lp[lp.length - 1].f !== 'statements') return null;
  const listPath = lp.slice(0, -1);
  const j = lp[lp.length - 1].i!;
  const outer = (getAt(body as ASTNode, listPath) as CompoundStmt).statements;
  const holder = outer[j];
  // A label on the loop is another way in: the lemma must hold there too, so none for those forms.
  if (wrapped) {
    const names = unwrapLabels(holder).names;
    if (lemma && names.some(n => totalGotos(body, n) > 0)) return null;
    if (unwrapLabels(holder).hasCase && lemma) return null;
  }
  // A bare `return;` exit of a loop whose fall-off ends a void function (directly, or
  // through the ends of the blocks around it and a closing `return;`) is where the for's
  // exit falls anyway: nothing to place, and the loop's breaks reach the same end.
  if (exit && exit.length === 1 && isBareReturn(exit[0]) && ctx.voidFn
    && fallsToEnd(body as ASTNode, [...listPath, { f: 'statements', i: j }])) {
    exit = [];
  }
  // E goes after the loop: the loop must have no other way out there (the top test's
  // break is one).
  if (exit && exit.length && topBreak) return null;
  if (exit && exit.length) {
    const brks = ownBreaks(body as ASTNode, bodyPath);
    const exitIdx = topForm ? 0 : Bd.length - 1;
    const otherBreaks = brks.filter(p => p[bodyPath.length].i !== exitIdx);
    if (otherBreaks.length) return null;
  }

  // The increment: the latch statements, comma-joined.
  const exprs = latch.map(s => (s as ExprStmt).expression);
  const incr = exprs.slice(1).reduce<Expression>((acc, e) => Expr.binary(acc, ',' as never, e), exprs[0]);
  // The init: the statement before the loop when it assigns what the increment writes.
  const writes = new Set(exprs.map(writtenBy).filter((x): x is string => !!x));
  let init: Statement | null = loop.kind === NodeKind.ForStmt ? (loop as ForStmt).init : null;
  let absorb = false;
  if (!init && !wrapped && j > 0) {
    const prev = outer[j - 1];
    if (prev.kind === NodeKind.ExprStmt) {
      const e = strip((prev as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' && writes.has(lvText((e as AssignExpr).left) ?? '\0')) {
        init = prev;
        absorb = true;
      }
    }
  }

  if (lemma) {
    const env = entryFacts(body, listPath, j, ctx.params);
    if (!env || entryHolds(cond!, env) !== true) return null;
  }

  // Build: gotos to the latch labels -> continue; the latch out; the for.
  let cur = retargetAt(body as ASTNode, sites, () => Stmt.continue_());
  const Bd2 = (getAt(cur, bodyPath) as CompoundStmt).statements;
  const pre2 = [...(topBreak ? [topBreak] : []), ...Bd2.slice(topForm ? 1 : 0, k)];
  const newBody = updateNode(getAt(cur, bodyPath) as CompoundStmt, { statements: pre2 });
  const forStmt = withLoc(Stmt.for_(init, cond, incr, newBody), loop as ASTNode);
  const holderNew = wrapped ? rewrapInner(outer[j], forStmt) : forStmt;
  const outer2 = (getAt(cur, listPath) as CompoundStmt).statements;
  const placedExit = exit && exit.length ? deepCloneStatements(exit) : [];
  const start = absorb ? j - 1 : j;
  const newOuter = [...outer2.slice(0, start), holderNew, ...placedExit, ...outer2.slice(j + 1)];
  if (absorb) (holderNew as { leadingTrivia?: unknown }).leadingTrivia = [...(outer2[j - 1].leadingTrivia ?? []), ...(holderNew.leadingTrivia ?? [])];
  cur = setList(cur, listPath, newOuter);
  let out = cur as CompoundStmt;
  for (const L of head.names) out = dropIfUnused(out, L);

  let before: CompoundStmt | null = null;
  if (lemma) {
    // `if (C) S else E`: S as it was, E what the for's exit reaches - the lemma says C holds.
    const S = outer[j];
    const els = placedExit.length ? Stmt.compound(deepCloneStatements(exit!)) : null;
    const guarded = withLoc(Stmt.if_(cond!, Stmt.compound([S]), els), S as ASTNode, false);
    before = setList(body as ASTNode, listPath, [...outer.slice(0, j), guarded, ...outer.slice(j + 1)]) as CompoundStmt;
  }
  return { kind: 'latchFor', body: out, before, sites: sites.length, copy: null };
}

// ---------------------------------------------------------------------------------------
// The entry lemma
// ---------------------------------------------------------------------------------------

export interface Facts {
  /** lvalue text -> constant */
  consts: Map<string, bigint>;
  /** pairs of locals known equal */
  copies: [string, string][];
  /** conditions known true (or false, with `neg`) */
  guards: { e: Expression; neg: boolean }[];
}

/** The root identifier of an lvalue chain (`a`, `a.b`, `a[i]`), or null for anything through memory. */
function rootOf(e: Expression): string | null {
  let u = strip(e);
  for (;;) {
    if (u.kind === NodeKind.Identifier) return (u as unknown as { name: string }).name;
    if (u.kind === NodeKind.MemberExpr && !(u as unknown as { isArrow: boolean }).isArrow) { u = strip((u as unknown as { object: Expression }).object); continue; }
    return null;
  }
}

/** Is this a plain local (declared in the body, never address-taken)? Anything else is memory. */
function localsOf(body: CompoundStmt): { locals: Set<string>; taken: Set<string> } {
  const locals = new Set<string>(), taken = new Set<string>();
  for (const n of traverseAST(body as ASTNode)) {
    if (n.kind === NodeKind.VariableDecl) locals.add((n as unknown as { name: { name: string } }).name.name);
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const r = rootOf((n as UnaryExpr).operand);
      if (r) taken.add(r);
      else {
        // &x[i], &(x.y)[i]...: take the root through subscripts too.
        let o = strip((n as UnaryExpr).operand);
        while (o.kind === NodeKind.SubscriptExpr || o.kind === NodeKind.MemberExpr) {
          o = strip((o as unknown as { array?: Expression; object?: Expression }).array ?? (o as unknown as { object: Expression }).object);
        }
        if (o.kind === NodeKind.Identifier) taken.add((o as unknown as { name: string }).name);
      }
    }
    // An array decays to a pointer when it is passed or assigned: treat any array-typed local as taken.
  }
  return { locals, taken };
}

/** Identifiers an expression reads or writes (roots of lvalues and plain reads). */
function identsIn(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const x of traverseAST(n)) if (x.kind === NodeKind.Identifier) out.add((x as unknown as { name: string }).name);
  return out;
}

interface Effects { writes: Set<string>; memWrite: boolean; call: boolean }

/** What a statement may change: the roots it writes, whether it writes through memory, whether it calls. */
function effectsOf(s: ASTNode): Effects {
  const r: Effects = { writes: new Set(), memWrite: false, call: false };
  const lv = (e: Expression) => {
    const root = rootOf(e);
    if (root) r.writes.add(root); else r.memWrite = true;
  };
  for (const n of traverseAST(s)) {
    if (n.kind === NodeKind.CallExpr || String(n.kind) === 'NewExpr' || String(n.kind) === 'DeleteExpr') r.call = true;
    if (n.kind === NodeKind.AssignExpr) lv((n as AssignExpr).left);
    if (n.kind === NodeKind.PostfixExpr) lv((n as unknown as { operand: Expression }).operand);
    if (n.kind === NodeKind.UnaryExpr && ((n as UnaryExpr).operator === '++' || (n as UnaryExpr).operator === '--')) lv((n as UnaryExpr).operand);
    if (n.kind === NodeKind.VariableDecl) r.writes.add((n as unknown as { name: { name: string } }).name.name);
  }
  return r;
}

/**
 * The facts that hold at the entry of the statement at `listPath[j]`, on every path into it.
 * Walks back through the list, and up through if-arms and plain blocks; stops at a label, a
 * case, a loop or switch body, or the function's start.
 */
function entryFacts(body: CompoundStmt, listPath: Path, j: number, params?: ReadonlySet<string>): Facts | null {
  const { locals, taken } = localsOf(body);
  for (const p of params ?? []) locals.add(p);
  const isLocal = (root: string) => locals.has(root) && !taken.has(root);
  const facts: Facts = { consts: new Map(), copies: [], guards: [] };
  // Everything written after the fact's site and before the entry.
  const killed = new Set<string>();
  let memKilled = false;
  const valid = (n: ASTNode): boolean => {
    for (const id of identsIn(n)) {
      if (killed.has(id)) return false;
      if (!isLocal(id) && memKilled) return false;
    }
    // A read through memory (`p->x`, `*p`, `a[i]` of a pointer) is killed by any memory write or call.
    for (const x of traverseAST(n)) {
      if ((x.kind === NodeKind.MemberExpr && (x as unknown as { isArrow: boolean }).isArrow)
        || (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*')
        || x.kind === NodeKind.SubscriptExpr) {
        if (memKilled) return false;
      }
      if (x.kind === NodeKind.CallExpr) return false;
    }
    return true;
  };
  const absorbEffects = (s: ASTNode) => {
    const ef = effectsOf(s);
    for (const w of ef.writes) killed.add(w);
    if (ef.memWrite || ef.call) memKilled = true;
  };
  let lp = listPath;
  let i = j;
  for (let guard = 0; guard < 64; guard++) {
    const list = (getAt(body as ASTNode, lp) as CompoundStmt).statements;
    for (let x = i - 1; x >= 0; x--) {
      const raw = list[x];
      const { inner, names, hasCase } = unwrapLabels(raw);
      // Facts from a statement hold whatever its labels; nothing before an entry does.
      collectFact(inner, facts, valid);
      absorbEffects(inner as ASTNode);
      if (hasCase || names.some(n => totalGotos(body, n) > 0)) return facts;
    }
    // Up one level.
    if (lp.length === 0) return facts;
    let up = lp;
    let last = up[up.length - 1];
    // The list may be a compound inside a label chain or an if arm.
    up = up.slice(0, -1);
    while (last && (last.f === 'statement')) {
      const owner = getAt(body as ASTNode, up);
      if (isCaseLike(owner)) return facts;
      if (owner.kind === NodeKind.LabelStmt && totalGotos(body, (owner as LabelStmt).label.name) > 0) return facts;
      last = up[up.length - 1];
      up = up.slice(0, -1);
    }
    if (!last) return facts;
    if (last.f === 'thenBranch' || last.f === 'elseBranch') {
      const ifs = getAt(body as ASTNode, up) as IfStmt;
      if (valid(ifs.condition as ASTNode) && !hasEffect(ifs.condition)) facts.guards.push({ e: ifs.condition, neg: last.f === 'elseBranch' });
      absorbEffects(ifs.condition as ASTNode);
      // The if itself sits in a list (through labels).
      let p = up;
      let st = p[p.length - 1];
      while (st && st.f === 'statement') {
        const owner = getAt(body as ASTNode, p.slice(0, -1));
        if (isCaseLike(owner)) return facts;
        if (owner.kind === NodeKind.LabelStmt && totalGotos(body, (owner as LabelStmt).label.name) > 0) return facts;
        p = p.slice(0, -1);
        st = p[p.length - 1];
      }
      if (!st || st.f !== 'statements') return facts;
      lp = p.slice(0, -1);
      i = st.i!;
      continue;
    }
    if (last.f === 'statements') {
      // A plain block inside a list.
      lp = up;
      i = last.i!;
      continue;
    }
    return facts;
  }
  return facts;
}

function hasEffect(e: Expression): boolean {
  const ef = effectsOf(e as ASTNode);
  return ef.call || ef.memWrite || ef.writes.size > 0;
}

function collectFact(s: Statement, facts: Facts, valid: (n: ASTNode) => boolean): void {
  if (s.kind === NodeKind.ExprStmt) {
    const e = strip((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return;
    const a = e as AssignExpr;
    const left = lvText(a.left);
    if (!left || !rootOf(a.left)) return;
    if (!valid(a.left as ASTNode)) return;
    const k = literalValue(a.right);
    if (k !== null && k >= 0n && k <= 127n) {
      if (!facts.consts.has(left)) facts.consts.set(left, k);
      return;
    }
    const r = strip(a.right);
    if (r.kind === NodeKind.Identifier && strip(a.left).kind === NodeKind.Identifier) {
      const rn = (r as unknown as { name: string }).name, ln = (strip(a.left) as unknown as { name: string }).name;
      // A non-local (a parameter, a global) is only trusted while nothing could have changed
      // it: `valid` drops it after any call or write through memory.
      if (valid(r as ASTNode)) facts.copies.push([ln, rn]);
    }
    return;
  }
  if (s.kind === NodeKind.IfStmt) {
    const n = s as IfStmt;
    if (!n.elseBranch && !fallsThrough(n.thenBranch, new Set()) && valid(n.condition as ASTNode) && !hasEffect(n.condition)) {
      facts.guards.push({ e: n.condition, neg: true });
    }
  }
}

/** An integer literal, through parens, integer casts and unary minus. */
function literalValue(e: Expression): bigint | null {
  let u = strip(e);
  let neg = false;
  for (;;) {
    if (u.kind === NodeKind.CStyleCastExpr) { u = strip((u as unknown as { expression: Expression }).expression); continue; }
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') { neg = !neg; u = strip((u as UnaryExpr).operand); continue; }
    break;
  }
  if (u.kind === NodeKind.IntegerLiteral) { const v = (u as unknown as { value: bigint }).value; return neg ? -v : v; }
  if (u.kind === NodeKind.CharLiteral) { const v = BigInt((u as unknown as { value: number }).value); return neg ? -v : v; }
  return null;
}

// --- interval sets over the reals: a union of intervals, endpoints from the literals ---

interface Iv { lo: number; loIn: boolean; hi: number; hiIn: boolean }
type Set_ = Iv[];
const ALL: Set_ = [{ lo: -Infinity, loIn: false, hi: Infinity, hiIn: false }];

function setOf(op: string, k: number): Set_ {
  switch (op) {
    case '<': return [{ lo: -Infinity, loIn: false, hi: k, hiIn: false }];
    case '<=': return [{ lo: -Infinity, loIn: false, hi: k, hiIn: true }];
    case '>': return [{ lo: k, loIn: false, hi: Infinity, hiIn: false }];
    case '>=': return [{ lo: k, loIn: true, hi: Infinity, hiIn: false }];
    case '==': return [{ lo: k, loIn: true, hi: k, hiIn: true }];
    case '!=': return [{ lo: -Infinity, loIn: false, hi: k, hiIn: false }, { lo: k, loIn: false, hi: Infinity, hiIn: false }];
  }
  return ALL;
}

function inSet(s: Set_, p: number): boolean {
  return s.some(iv => (p > iv.lo || (iv.loIn && p === iv.lo)) && (p < iv.hi || (iv.hiIn && p === iv.hi)));
}

/** Sample points that decide membership for every set whose endpoints are among `ends`. */
function samples(ends: number[]): number[] {
  const e = [...new Set(ends.filter(Number.isFinite))].sort((a, b) => a - b);
  if (!e.length) return [0];
  const out = [e[0] - 1, e[e.length - 1] + 1];
  for (let i = 0; i < e.length; i++) {
    out.push(e[i]);
    if (i + 1 < e.length) out.push((e[i] + e[i + 1]) / 2);
  }
  return out;
}

function endpoints(...sets: Set_[]): number[] {
  return sets.flatMap(s => s.flatMap(iv => [iv.lo, iv.hi]));
}

/** `x OP K` as (x text, op, K); `x` and `!x` as != 0 / == 0. Null when not that shape. */
export function atomOf(e: Expression): { x: string; set: Set_ } | null {
  let u = strip(e);
  let neg = false;
  while (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') { neg = !neg; u = strip((u as UnaryExpr).operand); }
  let x: Expression, op: string, k: bigint;
  if (u.kind === NodeKind.BinaryExpr && REL.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    const kl = literalValue(b.left), kr = literalValue(b.right);
    if (kr !== null && kl === null) { x = b.left; op = b.operator; k = kr; }
    else if (kl !== null && kr === null) { x = b.right; op = MIRROR[b.operator]; k = kl; }
    else return null;
  } else if (u.kind === NodeKind.BinaryExpr || u.kind === NodeKind.CallExpr || u.kind === NodeKind.AssignExpr || u.kind === NodeKind.ConditionalExpr) {
    return null;
  } else {
    x = u; op = '!='; k = 0n;
  }
  if (k < 0n || k >= 0x80000000n) return null;
  if (neg) op = INVERSE[op];
  const t = lvText(x);
  if (!t) return null;
  return { x: t, set: setOf(op, Number(k)) };
}

/**
 * Does `c` hold at the loop entry described by `env`? true / false / null (unknown).
 * Constants are substituted first; then a single comparison of one operand with a literal is
 * decided by the guards on that operand (and on the locals equal to it).
 */
export function entryHolds(c: Expression, env: Facts): boolean | null {
  const sub = substitute(c, env.consts);
  if (sub === null) return null;
  const folded = foldConst(sub);
  if (folded !== null) return folded;
  const atom = atomOf(sub);
  if (!atom) return null;
  const same = equalClass(atom.x, env.copies);
  let allowed: Set_ = ALL;
  const sets: Set_[] = [];
  for (const g of env.guards) {
    const ga = atomOf(g.neg ? negateCondition(g.e) : g.e);
    if (!ga || !same.has(ga.x)) continue;
    sets.push(ga.set);
  }
  // Each guard narrows: x is in every guard's set.
  const pts = samples(endpoints(atom.set, ...sets));
  const inAll = (p: number) => sets.every(s => inSet(s, p));
  const possible = pts.filter(inAll);
  if (!possible.length) return null;
  if (possible.every(p => inSet(atom.set, p))) return true;
  if (possible.every(p => !inSet(atom.set, p))) return false;
  void allowed;
  return null;
}

function equalClass(x: string, copies: [string, string][]): Set<string> {
  const out = new Set([x]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of copies) {
      if (out.has(a) && !out.has(b)) { out.add(b); changed = true; }
      if (out.has(b) && !out.has(a)) { out.add(a); changed = true; }
    }
  }
  return out;
}

/** Replace every lvalue with a known constant by that constant (as a literal). */
function substitute(e: Expression, consts: Map<string, bigint>): Expression | null {
  if (!consts.size) return e;
  const go = (n: Expression): Expression => {
    const t = (n.kind === NodeKind.Identifier || n.kind === NodeKind.MemberExpr) ? lvText(n) : null;
    if (t && consts.has(t)) return Expr.intLiteral(consts.get(t)!);
    const out: Record<string, unknown> = { ...n };
    let changed = false;
    for (const [kk, v] of Object.entries(n)) {
      if (kk === 'location' || kk.endsWith('Trivia')) continue;
      if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string' && !String((v as ASTNode).kind).endsWith('Type')) {
        const r = go(v as Expression);
        if (r !== v) { out[kk] = r; changed = true; }
      }
    }
    return changed ? (out as unknown as Expression) : n;
  };
  return go(e);
}

/** A condition over literals only, evaluated; null when it reads anything. */
function foldConst(e: Expression): boolean | null {
  const v = evalConst(e);
  return v === null ? null : v !== 0n;
}

function evalConst(e: Expression): bigint | null {
  const u = strip(e);
  const lit = literalValue(u);
  if (lit !== null) {
    // Only literals in range survive any integer cast unchanged.
    return lit >= 0n && lit <= 127n ? lit : (u.kind === NodeKind.IntegerLiteral ? lit : null);
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const v = evalConst((u as UnaryExpr).operand);
    return v === null ? null : (v === 0n ? 1n : 0n);
  }
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    if (!REL.has(b.operator) && b.operator !== '&&' && b.operator !== '||') return null;
    const l = evalConst(b.left), r = evalConst(b.right);
    if (l === null || r === null) return null;
    // Non-negative and below 2^31: signed and unsigned comparisons agree.
    if (l < 0n || r < 0n || l >= 0x80000000n || r >= 0x80000000n) return null;
    switch (b.operator) {
      case '<': return l < r ? 1n : 0n;
      case '<=': return l <= r ? 1n : 0n;
      case '>': return l > r ? 1n : 0n;
      case '>=': return l >= r ? 1n : 0n;
      case '==': return l === r ? 1n : 0n;
      case '!=': return l !== r ? 1n : 0n;
      case '&&': return l !== 0n && r !== 0n ? 1n : 0n;
      case '||': return l !== 0n || r !== 0n ? 1n : 0n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// exitSwap
// ---------------------------------------------------------------------------------------

export function exitSwap(body: CompoundStmt, name: string, ctx: LatchContext): LoopRewrite | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const list = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const gotos = gotoPaths(body, name);
  if (!gotos.length) return null;
  // The loop: the statement of the label's list every goto sits in.
  const d = slot.list.length;
  const js = new Set(gotos.map(p => (isPrefix(slot.list, p) && p.length > d ? p[d].i! : -1)));
  if (js.size !== 1) return null;
  const j = [...js][0];
  if (j < 0 || j >= slot.k) return null;
  let loopPath: Path = [...slot.list, { f: 'statements', i: j }];
  loopPath = innerPath(body as ASTNode, loopPath);
  const loop = getAt(body as ASTNode, loopPath) as Statement;
  if (!LOOPS.has(loop.kind) || loop.kind === NodeKind.ForRangeStmt || !infinite(loop)) return null;
  if (loop.kind === NodeKind.ForStmt && (loop as ForStmt).increment) return null;
  const bodyPath: Path = [...loopPath, { f: 'body' }];
  if (!gotos.every(p => isPrefix(bodyPath, p) && noBreakableBetween(body as ASTNode, bodyPath, p))) return null;
  const N = list.slice(j + 1, slot.k).filter(s => s.kind !== NodeKind.NullStmt);
  if (!N.length) return null;
  if (fallsThrough(N[N.length - 1], ctx.noreturn)) return null;
  const fj = freeJumps(N);
  if (fj.brk || fj.cont) return null;
  if (N.some(s => s.kind === NodeKind.DeclStmt)) return null;
  for (const s of N) for (const n of traverseAST(s as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return null;
  const brks = ownBreaks(body as ASTNode, bodyPath);
  if (!brks.length) return null;
  let cls: EvidenceClass;
  if (brks.length === 1) cls = 'move';
  else {
    if (N.some(s => [...traverseAST(s as ASTNode)].some(n => n.kind === NodeKind.GotoStmt))) return null;
    const prefixes = brks.map(p => ({ prefix: sitePrefix(body as ASTNode, p) }));
    const judged = judgeCopy(N, { sites: prefixes, hasFallthrough: false, noreturn: ctx.noreturn, label: name, region: body.statements, tailInRegion: N });
    if (judged === null || judged === 'none' || judged === 'move') return null;
    cls = judged;
  }
  // Gotos -> break, breaks -> N. Paths stay valid: both replace one statement in place.
  let cur = retargetAt(body as ASTNode, gotos, () => Stmt.break_());
  let first = true;
  for (const p of [...brks].sort((a, b) => comparePaths(b, a))) {
    const blk = first || cls === 'move' ? [...N] : deepCloneStatements(N);
    first = false;
    const parentPath = p.slice(0, -1);
    const last = p[p.length - 1];
    if (last.f === 'statements') {
      const l = (getAt(cur, parentPath) as CompoundStmt).statements;
      cur = setList(cur, parentPath, [...l.slice(0, last.i!), ...blk, ...l.slice(last.i! + 1)]);
    } else {
      const b = withLoc(Stmt.compound(blk), getAt(cur, p));
      cur = setAt(cur, p, b);
    }
  }
  // N leaves its place after the loop; the label now follows the loop.
  const l2 = (getAt(cur, slot.list) as CompoundStmt).statements;
  const s2 = findLabel(cur as CompoundStmt, name);
  if (!s2 || key(s2.list) !== key(slot.list)) return null;
  cur = setList(cur, slot.list, [...l2.slice(0, j + 1), ...l2.slice(s2.k)]);
  const out = dropIfUnused(cur as CompoundStmt, name);
  return { kind: 'exitSwap', body: out, before: null, sites: gotos.length, copy: cls === 'move' ? null : { cls, tail: N, copies: brks.length } };
}

/**
 * exitMove (MOVE): the block B MSVC laid out after an infinite loop is reached only by the
 * loop's break, and B ends by jumping back INTO the loop (to `name`). B was the arm the
 * break left; it goes back there, and its jump becomes a forward jump inside the loop body,
 * which the other handlers structure.
 *
 *   while (true) { ..; if (c) break; ..; L: x; }  B; goto L;   ->   while (true) { ..; if (c) { B; goto L; } ..; L: x; }
 *
 * One break: a move. Several: B would be copied, and B ends in a jump that is not a
 * return/break/continue, which the copy policy does not admit without evidence - declined.
 */
export function exitMove(body: CompoundStmt, name: string, ctx: LatchContext): LoopRewrite | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  // The innermost infinite loop around the label.
  let loopPath: Path | null = null;
  for (let d = slot.list.length; d > 0; d--) {
    if (slot.list[d - 1].f !== 'body') continue;
    const n = getAt(body as ASTNode, slot.list.slice(0, d - 1)) as Statement;
    if (!LOOPS.has(n.kind)) continue;
    if (n.kind === NodeKind.ForRangeStmt || !infinite(n) || (n.kind === NodeKind.ForStmt && (n as ForStmt).increment)) continue;
    loopPath = slot.list.slice(0, d - 1);
    break;
  }
  if (!loopPath) return null;
  const bodyPath: Path = [...loopPath, { f: 'body' }];
  let lp = loopPath;
  while (lp.length && lp[lp.length - 1].f === 'statement') lp = lp.slice(0, -1);
  if (!lp.length || lp[lp.length - 1].f !== 'statements') return null;
  const listPath = lp.slice(0, -1);
  const j = lp[lp.length - 1].i!;
  const list = (getAt(body as ASTNode, listPath) as CompoundStmt).statements;
  let m = j + 1;
  while (m < list.length && unwrapLabels(list[m]).names.length === 0 && !unwrapLabels(list[m]).hasCase) m++;
  const B = list.slice(j + 1, m).filter(x => x.kind !== NodeKind.NullStmt);
  if (!B.length || fallsThrough(B[B.length - 1], ctx.noreturn)) return null;
  // B jumps back into the loop, to this label.
  if (!B.some(s => [...traverseAST(s as ASTNode)].some(n => n.kind === NodeKind.GotoStmt && (n as GotoStmt).label.name === name))) return null;
  const fj = freeJumps(B);
  if (fj.brk || fj.cont) return null;
  if (B.some(x => x.kind === NodeKind.DeclStmt)) return null;
  for (const x of B) for (const n of traverseAST(x as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return null;
  const brks = ownBreaks(body as ASTNode, bodyPath);
  if (brks.length !== 1) return null;
  const p = brks[0];
  let cur: ASTNode = body as ASTNode;
  const parentPath = p.slice(0, -1);
  const last = p[p.length - 1];
  if (last.f === 'statements') {
    const l = (getAt(cur, parentPath) as CompoundStmt).statements;
    cur = setList(cur, parentPath, [...l.slice(0, last.i!), ...B, ...l.slice(last.i! + 1)]);
  } else {
    cur = setAt(cur, p, withLoc(Stmt.compound([...B]), getAt(cur, p)));
  }
  const l2 = (getAt(cur, listPath) as CompoundStmt).statements;
  cur = setList(cur, listPath, [...l2.slice(0, j + 1), ...l2.slice(m)]);
  return { kind: 'exitMove', body: cur as CompoundStmt, before: null, sites: 1, copy: null };
}

/**
 * exitHoist (MOVE): an infinite loop with no break, whose exit is a block T inside the body
 * that ends the function (or otherwise cannot fall through) and is entered at its label by
 * gotos from elsewhere in the loop. T is the code after a search loop that both exits reach:
 *
 *   do { if (!p) { g = -1; L: T } if (p->id == g) { g = p->owner; goto L; } p = p->next; } while (true);
 *     ->  do { if (!p) { g = -1; break; } if (p->id == g) { g = p->owner; break; } p = p->next; } while (true);  T
 *
 * T moves after the loop; falling into it and every goto to it become `break`. Nothing is
 * copied; the validator proves it, and its scope check refuses a T that names a declaration
 * of the loop body.
 */
export function exitHoist(body: CompoundStmt, name: string, ctx: LatchContext): LoopRewrite | null {
  const slot = findLabel(body, name);
  if (!slot || slot.wrappers.some(w => isCaseLike(w as ASTNode))) return null;
  if (slot.wrappers.length !== 1) return null;
  // The innermost loop around the label; it must be infinite.
  let loopPath: Path | null = null;
  for (let d = slot.list.length; d > 0; d--) {
    if (slot.list[d - 1].f !== 'body') continue;
    const n = getAt(body as ASTNode, slot.list.slice(0, d - 1)) as Statement;
    if (n.kind === NodeKind.SwitchStmt) return null;
    if (!LOOPS.has(n.kind)) continue;
    if (n.kind === NodeKind.ForRangeStmt || !infinite(n) || (n.kind === NodeKind.ForStmt && (n as ForStmt).increment)) return null;
    loopPath = slot.list.slice(0, d - 1);
    break;
  }
  if (!loopPath) return null;
  const bodyPath: Path = [...loopPath, { f: 'body' }];
  if (ownBreaks(body as ASTNode, bodyPath).length) return null;
  const gotos = gotoPaths(body, name);
  if (!gotos.length || !gotos.every(p => isPrefix(bodyPath, p) && noBreakableBetween(body as ASTNode, bodyPath, p))) return null;
  const list = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const T = [slot.inner, ...list.slice(slot.k + 1)].filter(x => x.kind !== NodeKind.NullStmt);
  if (!T.length || fallsThrough(T[T.length - 1], ctx.noreturn)) return null;
  const fj = freeJumps(T);
  if (fj.brk || fj.cont) return null;
  for (const x of T) for (const n of traverseAST(x as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return null;
  // The loop's place in its list.
  let lp = loopPath;
  while (lp.length && lp[lp.length - 1].f === 'statement') lp = lp.slice(0, -1);
  if (!lp.length || lp[lp.length - 1].f !== 'statements') return null;
  const listPath = lp.slice(0, -1);
  const j = lp[lp.length - 1].i!;
  // Gotos -> break; the label and T -> break.
  let cur = retargetAt(body as ASTNode, gotos, () => Stmt.break_());
  const l1 = (getAt(cur, slot.list) as CompoundStmt).statements;
  const brk = withLoc(Stmt.break_(), l1[slot.k] as ASTNode);
  cur = setList(cur, slot.list, [...l1.slice(0, slot.k), brk]);
  const outer = (getAt(cur, listPath) as CompoundStmt).statements;
  cur = setList(cur, listPath, [...outer.slice(0, j + 1), ...T, ...outer.slice(j + 1)]);
  return { kind: 'exitHoist', body: cur as CompoundStmt, before: null, sites: gotos.length, copy: null };
}

/**
 * rotateEntry (MOVE): a loop that nothing falls into, entered only at a label in its body -
 * the rotated loop MSVC emits for `while (C) { B; A }` with the test moved to the bottom:
 *
 *   goto M;  while (true) { A; L: B }  M:      ->   goto M;  L: while (true) { B; A }  M:
 *   ...      do { A; L: B } while (C);          ->   L: while (true) { B; if (!C) break; A }
 *
 * The label moves from the middle of the body to the loop itself, so every goto to it is a
 * jump to a loop head, which the structurer and the handlers can take further. Exact
 * rewrite's rotatedEntry is the special case with the goto right before the loop.
 */
export function rotateEntry(body: CompoundStmt, name: string, ctx: LatchContext): LoopRewrite | null {
  void ctx;
  const slot = findLabel(body, name);
  if (!slot || slot.k === 0 || slot.wrappers.length !== 1 || slot.list.length === 0) return null;
  if (slot.list[slot.list.length - 1].f !== 'body') return null;
  const loopPath = slot.list.slice(0, -1);
  const loop = getAt(body as ASTNode, loopPath) as Statement;
  if (loop.kind !== NodeKind.WhileStmt && loop.kind !== NodeKind.DoWhileStmt && loop.kind !== NodeKind.ForStmt) return null;
  if (loop.kind === NodeKind.ForStmt && ((loop as ForStmt).init || (loop as ForStmt).increment)) return null;
  // The loop sits unlabelled in a list, after a statement that cannot fall into it.
  const lp = loopPath;
  if (!lp.length || lp[lp.length - 1].f !== 'statements') return null;
  const listPath = lp.slice(0, -1);
  const j = lp[lp.length - 1].i!;
  const outer = (getAt(body as ASTNode, listPath) as CompoundStmt).statements;
  if (j === 0 || fallsThrough(outer[j - 1], ctx.noreturn)) return null;
  const Bd = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const A = Bd.slice(0, slot.k);
  const B = [slot.inner, ...Bd.slice(slot.k + 1)].filter(x => x.kind !== NodeKind.NullStmt);
  for (const x of A) for (const n of traverseAST(x as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return null;
  if (A.some(x => x.kind === NodeKind.DeclStmt) || B.some(x => x.kind === NodeKind.DeclStmt)) return null;
  if (ownContinue([...A, ...B])) return null;
  const cond = loop.kind === NodeKind.ForStmt ? (loop as ForStmt).condition : (loop as WhileStmt).condition;
  const test = constTrue(cond) ? [] : [withLoc(Stmt.if_(invertCondition(cond!), Stmt.break_()), cond as ASTNode, false)];
  const newBody = updateNode(getAt(body as ASTNode, slot.list) as CompoundStmt, { statements: [...B, ...test, ...A] });
  const rotated = withLoc(Stmt.while_(Expr.boolLiteral(true), newBody), loop as ASTNode);
  const labelled = withLoc(Stmt.label(name, rotated), slot.wrappers[0] as ASTNode, false);
  const cur = setList(body as ASTNode, listPath, [...outer.slice(0, j), labelled, ...outer.slice(j + 1)]);
  return { kind: 'rotateEntry', body: cur as CompoundStmt, before: null, sites: gotoPaths(body, name).length, copy: null };
}

/** The statement before a break in its list, or its branch: the copy policy's site prefix. */
function sitePrefix(root: ASTNode, p: Path): string | null {
  const last = p[p.length - 1];
  const parent = getAt(root, p.slice(0, -1));
  try {
    if (last.f === 'statements' && last.i! > 0) return 's:' + emitText((parent as CompoundStmt).statements[last.i! - 1]);
    if (last.f === 'thenBranch' || last.f === 'elseBranch') return (last.f === 'thenBranch' ? 't:' : 'f:') + emitText(Stmt.expr((parent as IfStmt).condition) as Statement);
    if (last.f === 'statements' && p.length >= 2 && p[p.length - 2].f === 'thenBranch') {
      return 't:' + emitText(Stmt.expr((getAt(root, p.slice(0, -2)) as IfStmt).condition) as Statement);
    }
  } catch { return null; }
  return null;
}

/**
 * Which way VC8 lays out each `if` of a function, predicted from the source we print, and
 * scored against the original's conditional jumps (evidence.ts `fallInto`).
 *
 * The rules, benched with the oracle's compiler and calibrated on the functions that already
 * match byte for byte:
 *
 *   then-arm only a goto/break/continue    the jump is the if's own branch: the arm is taken
 *   then-arm only a `return;`              a jump to the one epilogue: the arm is taken
 *   then-arm only a `return v` (v without a call or a write) and the block it sits in ends with
 *   the same return, no other return between
 *                                          VC8 cross-jumps it into that last copy: taken;
 *                                          an identical return anywhere else: not predicted
 *   if/else, condition simple or `&&`      the then-arm falls through
 *   if/else, `||` (or `!(&&)`)             the else-arm falls through
 *   no else, the arm falls through         the then-arm falls through
 *   no else, the arm leaves (return, halt, break) with code of its own:
 *     inside a loop, not its body's last statement
 *                                          sunk below the loop exit: taken
 *     `||` and a statement follows         out of line after the continuation: taken
 *     simple or `&&`                       inline: the then-arm falls through
 *
 * And a chain `if (!x1) return K; x2 = e(x1); if (!x2) return K; ...` written as guards
 * keeps its tests' jumps local: none threads forward past a later test into the last copy.
 *
 * Identical `return K` (K a constant) share one copy of their code, outside a loop (benched
 * with the oracle's compiler on GetStateFlags and SFILE_GetInstallPath):
 *
 *   every one a guard `if (c) return K;` of the body's own list, c simple or `&&`
 *                                          the copy sits inline after the first guard's
 *                                          test: that guard falls into it, every later
 *                                          guard jumps to it
 *   one of them an `||` guard, or the last statement of the body (not after an `||` guard
 *   or an if/else)                         the copy goes to the end: every guard jumps there
 *   one of them anywhere else (an arm with code of its own, a nested block, a loop)
 *                                          not predicted
 *
 * The rule is about one copy: where the original's lines place the members in two copies
 * (their epilogues differ, a register saved between them), or the copy's place is not
 * clear from its jumps (`mergedCopyPlace`), no guard of the group is predicted. Nor where an
 * `||` guard of the group has per-operand branch facts: the local or-guard rule rewrites it
 * by those (a getter, one guard per test), so the form it ends in is not yet printed.
 *
 * The copy's place is a site of its own as well, against the original's return copy: inline
 * (fallen into, with code after it) or at the end (no code after it).
 *
 * Anything else (a ternary in the condition, a leaving `||` arm with nothing after it, an
 * arm ending in `continue` with code) is not predicted and does not count.
 *
 * The objective of a function is the number of ifs whose prediction contradicts the
 * original's fall-through, plus the guard chains whose jumps do thread. A rewrite of the branch-layout pass is kept only when it lowers
 * the objective of the whole function.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, Statement, ReturnStmt, Expression, ParenExpr, CStyleCastExpr, AnyNode, LabelStmt,
  WhileStmt, DoWhileStmt, ForStmt, BoolLiteralExpr,
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { leaves, isHaltStmt, isExitStmt } from '../assert-order.js';
import { isLoop, type LayoutReader, type ReturnCopy } from './evidence.js';
import { conditionShape, gotoCounts, jumpedLabels } from './index.js';
import { guardChain, threadedTo } from './search.js';

export type Fall = 'then' | 'other';

export interface SiteScore {
  line: number;
  predicted: Fall;
  fact: Fall;
  rule: string;
  /** The edge's lines and the then-arm's, for the score log. */
  detail?: string;
}

export interface LayoutScore {
  /** Ifs whose predicted fall-through contradicts the original's. */
  objective: number;
  /** Ifs with both a prediction and a fact. */
  sites: number;
  mismatches: SiteScore[];
  /** Per site the rule and whether it held, for the calibration. */
  rules: string[];
  /** The ifs with a fact that no rule predicts, by position, with the reason. */
  abstained: { line: number; column: number; rule: string }[];
  /** The positions (`line:column`) of the ifs predicted against a fact. */
  scored: Set<string>;
  /** Per group of identical returns with a fact (by key): whether its copy is where predicted. */
  groups: Map<string, boolean>;
}

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

/**
 * What a return's code is, for cross-jumping: identical keys compile to identical copies.
 * Any value without a call or a write; null for the others, which are not merged.
 */
export function returnKey(r: ReturnStmt): string | null {
  if (!r.value) return '';
  for (const n of traverseAST(r.value)) {
    if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.CommaExpr) return null;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as unknown as { operator: string }).operator)) return null;
  }
  return emit(unwrap(r.value) as AnyNode).trim();
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

const JUMPS = new Set<string>([NodeKind.GotoStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt]);

/** A literal, through casts and parentheses: a value VC8 materialises with one load. */
export function constantValue(e: Expression): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.BoolLiteral || u.kind === NodeKind.CharLiteral;
}

/** A return copy whose first instruction loads EAX: the value is set inside the copy. */
export function loadsEax(c: ReturnCopy): boolean {
  return /^(MOV|MOVZX|MOVSX|XOR|OR|SUB|LEA)\/EAX$/.test(c.insns[0] ?? '');
}

export function hasLoop(stmts: readonly Statement[]): boolean {
  return stmts.some(s => [...traverseAST(s)].some(n => isLoop(n)));
}

export function hasCall(stmts: readonly Statement[]): boolean {
  return stmts.some(s => [...traverseAST(s)].some(n => n.kind === NodeKind.CallExpr));
}

function before(a: ASTNode, b: ASTNode): boolean {
  const x = a.location?.start, y = b.location?.start;
  return !!x && !!y && (x.line < y.line || (x.line === y.line && x.column < y.column));
}

/** A return identical to `ret` stands before `at` in source order (`returns`: the function's, in order). */
export function earlierCopy(returns: readonly ReturnStmt[], at: ASTNode, ret: ReturnStmt): boolean {
  const k = returnKey(ret);
  return k !== null && returns.some(r => r !== ret && returnKey(r) === k && before(r, at));
}

/**
 * `if (G) return K;` (K a constant) in a block that ends with `return K` after S: VC8 loads K
 * above the guard's test and jumps past the load when S leaves EAX alone (no call), and
 * merges the guard into an earlier copy of K when there is one (a simple condition; S straight
 * code without a call or a loop for the first). Either way the guard's jump
 * does not land on a copy that starts by loading K; one that does means the source had no
 * guard (`if (!G) { S } return K;`). Null when neither applies: the two forms compile the same.
 */
export function guardLoadsAhead(list: readonly Statement[], i: number, returns: readonly ReturnStmt[]): boolean {
  const ifs = list[i] as IfStmt;
  if (ifs.elseBranch) return false;
  const arm = bodyOf(ifs.thenBranch);
  if (arm.length !== 1 || arm[0].kind !== NodeKind.ReturnStmt) return false;
  const r = arm[0] as ReturnStmt;
  const last = list[list.length - 1];
  if (!r.value || !constantValue(r.value) || i >= list.length - 1 || last.kind !== NodeKind.ReturnStmt) return false;
  const k = returnKey(r);
  if (k === null || returnKey(last as ReturnStmt) !== k) return false;
  if (conditionShape(ifs.condition).kind !== 'simple') return false;
  const s = list.slice(i + 1, -1);
  return (!hasCall(s) && !hasLoop(s)) || earlierCopy(returns, ifs, r);
}

/** The returns of a function in source order. */
export function returnOrder(root: ASTNode): ReturnStmt[] {
  const out: ReturnStmt[] = [];
  const go = (n: ASTNode): void => {
    if (n.kind === NodeKind.ReturnStmt) out.push(n as ReturnStmt);
    for (const k of getChildren(n)) go(k);
  };
  go(root);
  return out;
}

export interface PredictContext {
  noreturn: ReadonlySet<string>;
  /** The function's returns in source order. */
  returns: readonly ReturnStmt[];
  /** How often each label is jumped to. */
  gotos: ReadonlyMap<string, number>;
  /** The last statement of each endless loop's body. */
  loopTails: ReadonlySet<Statement>;
  /** Each if's arm (by identity): its code and where it goes when done. */
  arms: ReadonlyMap<Statement, string>;
  /** How many arms have each of those keys: two with one key are one tail to VC8. */
  armCounts: ReadonlyMap<string, number>;
  /** Each `return K` (K a constant) with another identical one, and the group they share a copy in. */
  returnGroups: ReadonlyMap<ReturnStmt, ReturnGroup>;
}

/**
 * Identical `return K` of a function (K a constant), which VC8 compiles to one copy, and
 * where that copy goes (see the header). `copy` is null when a member has a form the rule
 * does not cover; `guards` lists the guards among the members in source order.
 */
export interface ReturnGroup {
  key: string;
  members: ReturnStmt[];
  guards: IfStmt[];
  copy: 'inline' | 'end' | null;
}

/** `nullptr` or `NULL` as a name (a pass may build it as one): a constant. */
function nullName(e: Expression): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier && ['nullptr', 'NULL'].includes((u as unknown as { name: string }).name);
}

/** `if (c) return K;` with no else: the guard holding `r` as its whole arm. */
function guardOf(ifs: IfStmt): ReturnStmt | null {
  if (ifs.elseBranch || ifs.init || ifs.isConstexpr) return null;
  const l = bodyOf(ifs.thenBranch);
  return l.length === 1 && l[0].kind === NodeKind.ReturnStmt ? l[0] as ReturnStmt : null;
}

/** The groups of identical constant returns of `body`, keyed by member. */
export function returnGroups(body: CompoundStmt): Map<ReturnStmt, ReturnGroup> {
  const guardFor = new Map<ReturnStmt, IfStmt>();
  const inLoop = new Set<ReturnStmt>();
  const go = (n: ASTNode, loop: boolean): void => {
    // A guard of the body's own statement list, labelled or not. One in a nested block (an
    // arm, an else-if) is laid out with the block around it.
    if (n === body) {
      for (let x of (n as CompoundStmt).statements) {
        while (x.kind === NodeKind.LabelStmt) x = (x as LabelStmt).statement;
        const r = x.kind === NodeKind.IfStmt ? guardOf(x as IfStmt) : null;
        if (r) guardFor.set(r, x as IfStmt);
      }
    }
    if (n.kind === NodeKind.ReturnStmt && loop) inLoop.add(n as ReturnStmt);
    const l = loop || isLoop(n);
    for (const k of getChildren(n)) go(k, l);
  };
  go(body, false);
  const last = body.statements[body.statements.length - 1];
  const byKey = new Map<string, ReturnStmt[]>();
  for (const r of returnOrder(body)) {
    if (!r.value || !(constantValue(r.value) || nullName(r.value))) continue;
    const k = returnKey(r);
    if (k === null) continue;
    const l = byKey.get(k);
    if (l) l.push(r); else byKey.set(k, [r]);
  }
  const out = new Map<ReturnStmt, ReturnGroup>();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const guards: IfStmt[] = [];
    let end = false, known = true;
    for (const r of members) {
      const g = guardFor.get(r);
      if (inLoop.has(r)) known = false;
      else if (g) {
        guards.push(g);
        const shape = conditionShape(g.condition).kind;
        if (shape === 'or') end = true;
        else if (shape === 'other') known = false;
      } else if (r === last) {
        // After an `||` guard (its arm goes after the rest) or an if/else, the last return
        // may be a jump into an earlier copy: not settled.
        const prev = body.statements[body.statements.length - 2];
        if (prev?.kind === NodeKind.IfStmt
          && (!!(prev as IfStmt).elseBranch || conditionShape((prev as IfStmt).condition).kind === 'or')) known = false;
        else end = true;
      } else known = false;
    }
    const group: ReturnGroup = { key, members, guards, copy: !known ? null : end ? 'end' : 'inline' };
    for (const r of members) out.set(r, group);
  }
  return out;
}

/** A loop whose test is constant true: `while (true)`, `do ... while (true)`, `for (;;)`. */
function endless(n: ASTNode): Statement | null {
  const yes = (c: Expression | null): boolean => {
    if (!c) return true;
    const u = unwrap(c);
    if (u.kind === NodeKind.BoolLiteral) return (u as BoolLiteralExpr).value;
    return u.kind === NodeKind.IntegerLiteral && BigInt((u as unknown as { value: bigint | number }).value) !== 0n;
  };
  if (n.kind === NodeKind.WhileStmt) return yes((n as WhileStmt).condition) ? (n as WhileStmt).body : null;
  if (n.kind === NodeKind.DoWhileStmt) return yes((n as DoWhileStmt).condition) ? (n as DoWhileStmt).body : null;
  if (n.kind === NodeKind.ForStmt) return yes((n as ForStmt).condition) ? (n as ForStmt).body : null;
  return null;
}

/** An arm's code for tail merging: its statements, a closing jump left out (it is where the tail goes). */
function armText(s: Statement): string {
  const l = bodyOf(s);
  const code = l.length > 1 && JUMPS.has(l[l.length - 1].kind) ? l.slice(0, -1) : l;
  return code.map(x => emit(x as AnyNode).trim()).join('\n');
}

/** `rest` is only a return identical to another of the function's: VC8 merges it, it has no code of its own. */
function mergedReturn(rest: readonly Statement[], ctx: PredictContext): boolean {
  if (rest.length !== 1 || rest[0].kind !== NodeKind.ReturnStmt) return false;
  const k = returnKey(rest[0] as ReturnStmt);
  return k === null || k === '' || ctx.returns.some(o => o !== rest[0] && returnKey(o) === k);
}

/** The context `predictFall` reads, for the function body `body`. */
export function predictContext(body: CompoundStmt, noreturn: ReadonlySet<string>): PredictContext {
  const loopTails = new Set<Statement>();
  const arms = new Map<Statement, string>();
  const armCounts = new Map<string, number>();
  const ids = new Map<ASTNode, number>();
  const id = (n: ASTNode): string => {
    let k = ids.get(n);
    if (k === undefined) ids.set(n, k = ids.size);
    return String(k);
  };
  // `succ`: where control goes after the statement; `brk`/`cont`: a break's and a continue's target.
  const walk = (n: ASTNode, succ: string, brk: string, cont: string): void => {
    if (n.kind === NodeKind.CompoundStmt) {
      const l = (n as CompoundStmt).statements;
      l.forEach((x, i) => walk(x, i + 1 < l.length ? 's' + id(l[i + 1]) : succ, brk, cont));
      return;
    }
    if (n.kind === NodeKind.IfStmt) {
      for (const a of [(n as IfStmt).thenBranch, (n as IfStmt).elseBranch]) {
        if (!a) continue;
        walk(a, succ, brk, cont);
        if (a.kind === NodeKind.IfStmt) continue;
        const l = bodyOf(a);
        const end = l[l.length - 1];
        const to = !end ? succ
          : end.kind === NodeKind.BreakStmt ? brk
          : end.kind === NodeKind.ContinueStmt ? cont
          : end.kind === NodeKind.GotoStmt ? 'L' + (end as unknown as { label: { name: string } }).label.name
          : end.kind === NodeKind.ReturnStmt ? 'ret'
          : isExitCall(end, noreturn) ? 'exit' : succ;
        const key = armText(a) + '\u0001' + to;
        arms.set(a, key);
        armCounts.set(key, (armCounts.get(key) ?? 0) + 1);
      }
      return;
    }
    if (isLoop(n)) {
      const head = 'loop' + id(n);
      for (const k of getChildren(n)) if (String(k.kind).endsWith('Stmt')) walk(k, head, succ, head);
      return;
    }
    const inner = n.kind === NodeKind.SwitchStmt ? succ : brk;
    for (const k of getChildren(n)) if (String(k.kind).endsWith('Stmt')) walk(k, succ, inner, cont);
  };
  walk(body, 'end', 'none', 'none');
  for (const n of traverseAST(body)) {
    const b = endless(n);
    if (b) {
      const l = bodyOf(b);
      if (l.length > 0) loopTails.add(l[l.length - 1]);
    }
  }
  return { noreturn, returns: returnOrder(body), gotos: gotoCounts(body), loopTails, arms, armCounts, returnGroups: returnGroups(body) };
}

/** `exit(...)` or another call that never returns, as a statement. */
function isExitCall(s: Statement, noreturn: ReadonlySet<string>): boolean {
  return isExitStmt(s) || (s.kind === NodeKind.ExprStmt && leaves(s, noreturn));
}

/** A return of a plain name: its value sits in whichever register the allocator chose. */
function returnsName(r: ReturnStmt): boolean {
  return !!r.value && unwrap(r.value).kind === NodeKind.Identifier;
}

/** Where `ifs` sits: the statement list holding it and whether a loop encloses it. */
export interface Place {
  list: readonly Statement[] | null;
  index: number;
  inLoop: boolean;
  /** A label stands on the if itself. */
  labelled?: boolean;
}

/** The predicted fall-through of `ifs`, with the rule that decided it or why none applies. */
/** A prediction, or `fall: null` with the reason no rule applies. */
export type Prediction = { fall: Fall; rule: string } | { fall: null; rule: string };

function abstain(rule: string): Prediction {
  return { fall: null, rule };
}

export function predictFall(ifs: IfStmt, place: Place, ctx: PredictContext): Prediction {
  const arm = bodyOf(ifs.thenBranch);
  if (arm.length === 0) return abstain('empty arm');
  if (arm.length === 1 && JUMPS.has(arm[0].kind)) return { fall: 'other', rule: 'bare jump' };
  // A label something jumps to, on the if or in an arm: the block is laid out after the last
  // jump that reaches it, not where the source shape puts it.
  if (place.labelled || jumpedLabels(ifs.elseBranch ? [ifs.thenBranch, ifs.elseBranch] : [ifs.thenBranch], ctx.gotos)) return abstain('jumped label');
  // The last test of an endless loop's body is the loop's own test at the bottom: it jumps
  // back to the top and falls into the arm that leaves.
  if (!ifs.elseBranch && ctx.loopTails.has(ifs)) return { fall: 'then', rule: 'exit test of an endless loop' };
  // An arm whose code another if prints too: VC8 merges the two tails, which copy stays is not settled.
  const merges = (x: Statement): boolean => {
    const l = bodyOf(x);
    const k = ctx.arms.get(x);
    return k !== undefined && (ctx.armCounts.get(k) ?? 0) > 1 && !(l.length === 1 && (l[0].kind === NodeKind.ReturnStmt || JUMPS.has(l[0].kind)));
  };
  if (merges(ifs.thenBranch) || (ifs.elseBranch && ifs.elseBranch.kind !== NodeKind.IfStmt && merges(ifs.elseBranch))) return abstain('merged tail');
  if (arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && !(arm[0] as ReturnStmt).value) return { fall: 'other', rule: 'bare return' };
  if (arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && !ifs.elseBranch) {
    const r = arm[0] as ReturnStmt;
    const key = returnKey(r);
    // In a loop, a return identical to one elsewhere is merged with it: not settled.
    if (place.inLoop && key !== null && ctx.returns.some(o => o !== r && returnKey(o) === key)) return abstain('merged return in a loop');
  }
  if (arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && !ifs.elseBranch && !place.inLoop) {
    const r = arm[0] as ReturnStmt;
    const key = returnKey(r);
    if (key !== null) {
      const list = place.list, last = list ? list[list.length - 1] : null;
      if (list && place.index < list.length - 1 && last!.kind === NodeKind.ReturnStmt && returnKey(last as ReturnStmt) === key) {
        // With another return between the two, the guard's own copy may stay: not settled.
        if (list.slice(place.index + 1, -1).some(x => returnOrder(x).length > 0)) return abstain('return between');
        return { fall: 'other', rule: 'return merged into the copy ending its block' };
      }
      // Merged with a copy elsewhere: the group's form places the one copy.
      const group = ctx.returnGroups.get(r);
      if (group?.copy === 'end') return { fall: 'other', rule: 'merged return, copy at the end' };
      if (group?.copy === 'inline') {
        return group.guards[0] === ifs
          ? { fall: 'then', rule: 'merged return, copy inline at the first guard' }
          : { fall: 'other', rule: 'merged return, jump to the first guard\'s copy' };
      }
      if (ctx.returns.some(o => o !== r && returnKey(o) === key)) return abstain('merged return');
      // Two returns of different names may hold their value in one register: one copy.
      if (returnsName(r) && ctx.returns.some(o => o !== r && returnsName(o))) return abstain('returns of names');
    }
  }
  const shape = conditionShape(ifs.condition).kind;
  if (shape === 'other') return abstain('condition shape');
  // In a loop an arm that leaves is sunk below the loop exit, if/else or not: not settled for an else.
  if (ifs.elseBranch && place.inLoop && (leaves(ifs.thenBranch, ctx.noreturn) || leaves(ifs.elseBranch, ctx.noreturn))) return abstain('leaving if/else in a loop');
  if (ifs.elseBranch) return shape === 'or' ? { fall: 'other', rule: 'if/else, ||' } : { fall: 'then', rule: 'if/else' };
  const last = arm[arm.length - 1];
  if (!leaves(last, ctx.noreturn)) return { fall: 'then', rule: 'arm falls through' };
  if (place.inLoop) {
    if (last.kind === NodeKind.ContinueStmt || last.kind === NodeKind.GotoStmt) return abstain('loop arm ends in a jump');
    // The last statement of a loop body runs into the loop's test: no sinking to rely on.
    if (!place.list || place.index === place.list.length - 1) return abstain('last in loop body');
    // Sunk only when the arm itself ends leaving; one that leaves through a nested if is not settled.
    if (last.kind !== NodeKind.ReturnStmt && last.kind !== NodeKind.BreakStmt && !isExitCall(last, ctx.noreturn)) return abstain('loop arm leaves through a nested statement');
    // A label after it: the code there is placed by its jumps.
    if (jumpedLabels(place.list.slice(place.index + 1), ctx.gotos)) return abstain('label after a loop arm');
    // Nothing after it but a merged return: no code to sink it below.
    if (mergedReturn(place.list.slice(place.index + 1), ctx)) return abstain('merged return after a loop arm');
    return { fall: 'other', rule: 'leaving arm in a loop' };
  }
  if (shape === 'or') {
    if (place.list && place.index < place.list.length - 1) {
      // What follows is only a return VC8 merges into an earlier copy: no code of its own to go after.
      if (mergedReturn(place.list.slice(place.index + 1), ctx)) return abstain('merged return after an || arm');
      return { fall: 'other', rule: 'leaving || arm, a statement follows' };
    }
    return abstain('|| arm last');
  }
  if (last.kind === NodeKind.GotoStmt || last.kind === NodeKind.ContinueStmt) return abstain('arm ends in a jump');
  return { fall: 'then', rule: isHaltStmt(arm[0]) ? 'halt arm' : 'leaving arm inline' };
}

/** Score every if of `body` that has a fact. */
export function scoreBody(body: CompoundStmt, reader: LayoutReader, noreturn: ReadonlySet<string>): LayoutScore {
  const ctx0 = predictContext(body, noreturn);
  // A group whose one copy the original does not clearly place (two copies, or jumps that
  // do not say) is not predicted, guard by guard either.
  const groups = new Map<ReturnStmt, ReturnGroup>();
  const unshared = new Map<ReturnGroup, ReturnGroup>();
  const place = new Map<ReturnGroup, 'inline' | 'end' | null>();
  // An `||` guard whose operands' branches are known is the local or-guard rule's to judge
  // (index.ts): it may become a getter or one guard per test, so its group is not settled.
  const judged = (g: ReturnGroup) => g.guards.some(x => conditionShape(x.condition).kind === 'or' && reader.operandBranches(x) !== null);
  for (const g of new Set(ctx0.returnGroups.values())) place.set(g, g.copy && !judged(g) ? reader.mergedCopyPlace(g.members) : null);
  for (const [r, g] of ctx0.returnGroups) {
    if (g.copy && !place.get(g)) {
      let u = unshared.get(g);
      if (!u) unshared.set(g, u = { ...g, copy: null });
      groups.set(r, u);
    } else groups.set(r, g);
  }
  const ctx: PredictContext = { ...ctx0, returnGroups: groups };
  const out: LayoutScore = { objective: 0, sites: 0, mismatches: [], rules: [], abstained: [], scored: new Set(), groups: new Map() };
  // Where each group of identical returns keeps its one copy.
  for (const g of new Set(ctx.returnGroups.values())) {
    if (!g.copy) continue;
    const fact = reader.mergedCopyPlace(g.members);
    if (!fact) continue;
    out.sites++;
    const ok = fact === g.copy;
    out.groups.set(g.key, ok);
    out.rules.push(`merged return copy ${g.copy}=${ok ? 1 : 0}`);
    if (!ok) {
      out.objective++;
      out.mismatches.push({ line: g.members[0].location?.start.line ?? 0, predicted: g.copy === 'inline' ? 'then' : 'other', fact: fact === 'inline' ? 'then' : 'other', rule: `merged return copy ${g.copy}` });
    }
  }
  const visit = (n: ASTNode, place: Place): void => {
    if (n.kind === NodeKind.IfStmt) {
      const ifs = n as IfStmt;
      const fact = reader.fallInto(ifs);
      const p = fact ? predictFall(ifs, place, ctx) : null;
      if (fact && p && p.fall === null) {
        out.abstained.push({ line: ifs.location?.start.line ?? 0, column: ifs.location?.start.column ?? 0, rule: p.rule });
        out.rules.push(`abstain: ${p.rule}`);
      }
      if (fact && p && p.fall !== null) {
        out.sites++;
        out.scored.add(`${ifs.location?.start.line ?? 0}:${ifs.location?.start.column ?? 0}`);
        out.rules.push(`${p.rule}=${p.fall === fact ? 1 : 0}`);
        if (p.fall !== fact) {
          out.objective++;
          const e = reader.edge(ifs)!;
          const own = [...reader.linesOf([ifs.thenBranch])].sort((a, b) => a - b);
          out.mismatches.push({
            line: ifs.location?.start.line ?? 0, predicted: p.fall, fact, rule: p.rule,
            detail: `f${e.fallLines.join(',')} t${e.takenLines.join(',')} own${own.join(',')}`,
          });
        }
      }
    }
    const inLoop = place.inLoop || isLoop(n);
    if (n.kind === NodeKind.CompoundStmt) {
      const list = (n as CompoundStmt).statements;
      // A chain of guards on values derived one from the other: written as guards, VC8 keeps
      // a copy of K per guard; a jump threaded forward past the later tests into the last
      // copy means the source tested values it had set to the failing constant.
      // A guard over a copy that loads its value: see guardLoadsAhead.
      for (let i = 0; i < list.length; i++) {
        if (list[i].kind !== NodeKind.IfStmt || !guardLoadsAhead(list, i, ctx.returns)) continue;
        const g = list[i] as IfStmt;
        const e = reader.edge(g);
        if (!e || reader.fallInto(g) !== 'other') continue;
        const copy = reader.returnCopyStarting(e.target);
        if (!copy) continue;
        out.sites++;
        out.rules.push(`guard does not jump onto its value's load=${loadsEax(copy) ? 0 : 1}`);
        if (loadsEax(copy)) {
          out.objective++;
          out.mismatches.push({ line: g.location?.start.line ?? 0, predicted: 'other', fact: 'other', rule: "guard does not jump onto its value's load" });
        }
      }
      for (let i = 0; i < list.length; i++) {
        const c = list[i].kind === NodeKind.IfStmt ? guardChain(list, i) : null;
        if (!c) continue;
        if (c.guards.every(g => reader.fallInto(g.ifs) !== null)) {
          const threaded = threadedTo(reader, c.guards) >= 1;
          out.sites++;
          out.rules.push(`guard chain not threaded=${threaded ? 0 : 1}`);
          if (threaded) {
            out.objective++;
            out.mismatches.push({ line: list[i].location?.start.line ?? 0, predicted: 'then', fact: 'other', rule: 'guard chain not threaded' });
          }
        }
        i = c.guards[c.guards.length - 1].at;
      }
      list.forEach((s, i) => visit(s, { list, index: i, inLoop }));
      return;
    }
    const labelled = n.kind === NodeKind.LabelStmt;
    for (const k of getChildren(n)) visit(k, { list: null, index: 0, inLoop, labelled });
  };
  visit(body, { list: null, index: 0, inLoop: false });
  return out;
}

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
 * Anything else (a ternary in the condition, a leaving `||` arm with nothing after it, an
 * arm ending in `continue` with code) is not predicted and does not count.
 *
 * The objective of a function is the number of ifs whose prediction contradicts the
 * original's fall-through, plus the guard chains whose jumps do thread. A rewrite of the branch-layout pass is kept only when it lowers
 * the objective of the whole function.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, Statement, ReturnStmt, Expression, ParenExpr, CStyleCastExpr, AnyNode,
  WhileStmt, DoWhileStmt, ForStmt, BoolLiteralExpr,
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { leaves, isHaltStmt, isExitStmt } from '../assert-order.js';
import { isLoop, type LayoutReader } from './evidence.js';
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
  return { noreturn, returns: returnOrder(body), gotos: gotoCounts(body), loopTails, arms, armCounts };
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
      // Merged with a copy elsewhere: which one keeps the code is not settled.
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
  const ctx = predictContext(body, noreturn);
  const out: LayoutScore = { objective: 0, sites: 0, mismatches: [], rules: [], abstained: [] };
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

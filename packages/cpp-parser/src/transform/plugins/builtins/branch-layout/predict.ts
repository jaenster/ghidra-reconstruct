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
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { leaves, isHaltStmt } from '../assert-order.js';
import { isLoop, type LayoutReader } from './evidence.js';
import { conditionShape } from './index.js';
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
}

/** Where `ifs` sits: the statement list holding it and whether a loop encloses it. */
export interface Place {
  list: readonly Statement[] | null;
  index: number;
  inLoop: boolean;
}

/** The predicted fall-through of `ifs`, with the rule that decided it; null when no rule applies. */
export function predictFall(ifs: IfStmt, place: Place, ctx: PredictContext): { fall: Fall; rule: string } | null {
  const arm = bodyOf(ifs.thenBranch);
  if (arm.length === 0) return null;
  if (arm.length === 1 && JUMPS.has(arm[0].kind)) return { fall: 'other', rule: 'bare jump' };
  if (arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && !(arm[0] as ReturnStmt).value) return { fall: 'other', rule: 'bare return' };
  if (arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && !ifs.elseBranch && !place.inLoop) {
    const r = arm[0] as ReturnStmt;
    const key = returnKey(r);
    if (key !== null) {
      const list = place.list, last = list ? list[list.length - 1] : null;
      if (list && place.index < list.length - 1 && last!.kind === NodeKind.ReturnStmt && returnKey(last as ReturnStmt) === key) {
        // With another return between the two, the guard's own copy may stay: not settled.
        if (list.slice(place.index + 1, -1).some(x => returnOrder(x).length > 0)) return null;
        return { fall: 'other', rule: 'return merged into the copy ending its block' };
      }
      // Merged with a copy elsewhere: which one keeps the code is not settled.
      if (ctx.returns.some(o => o !== r && returnKey(o) === key)) return null;
    }
  }
  const shape = conditionShape(ifs.condition).kind;
  if (shape === 'other') return null;
  if (ifs.elseBranch) return shape === 'or' ? { fall: 'other', rule: 'if/else, ||' } : { fall: 'then', rule: 'if/else' };
  const last = arm[arm.length - 1];
  if (!leaves(last, ctx.noreturn)) return { fall: 'then', rule: 'arm falls through' };
  if (place.inLoop) {
    if (last.kind === NodeKind.ContinueStmt || last.kind === NodeKind.GotoStmt) return null;
    // The last statement of a loop body runs into the loop's test: no sinking to rely on.
    if (!place.list || place.index === place.list.length - 1) return null;
    return { fall: 'other', rule: 'leaving arm in a loop' };
  }
  if (shape === 'or') {
    if (place.list && place.index < place.list.length - 1) return { fall: 'other', rule: 'leaving || arm, a statement follows' };
    return null;
  }
  if (last.kind === NodeKind.GotoStmt || last.kind === NodeKind.ContinueStmt) return null;
  return { fall: 'then', rule: isHaltStmt(arm[0]) ? 'halt arm' : 'leaving arm inline' };
}

/** Score every if of `body` that has a fact. */
export function scoreBody(body: CompoundStmt, reader: LayoutReader, noreturn: ReadonlySet<string>): LayoutScore {
  const ctx: PredictContext = { noreturn, returns: returnOrder(body) };
  const out: LayoutScore = { objective: 0, sites: 0, mismatches: [], rules: [] };
  const visit = (n: ASTNode, place: Place): void => {
    if (n.kind === NodeKind.IfStmt) {
      const ifs = n as IfStmt;
      const fact = reader.fallInto(ifs);
      const p = fact ? predictFall(ifs, place, ctx) : null;
      if (fact && p) {
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
    for (const k of getChildren(n)) visit(k, { list: null, index: 0, inLoop });
  };
  visit(body, { list: null, index: 0, inLoop: false });
  return out;
}

/**
 * Search Loop Exit Plugin
 *
 * A search over a list, `while (p) { if (p->id == id) break; p = p->next; } if (!p) return;`,
 * comes out of the decompiler with its not-found exit printed twice, once as a guard in front
 * and once at the bottom of the body (DRLGWARP_UpdateWarpRoomExSelect, 0066ab90):
 *
 *     if (!pTileGrid) {                             while (pTileGrid) {
 *       return;                                       if (pTileGrid->pLvlWarpTxt->Id == eLevel) {
 *     }                                                 break;
 *     while (pTileGrid->pLvlWarpTxt->Id != eLevel) {  }
 *       pTileGrid = pTileGrid->pRoomTileNext;   =>    pTileGrid = pTileGrid->pRoomTileNext;
 *       if (!pTileGrid) {                           }
 *         return;                                   if (!pTileGrid) {
 *       }                                             return;
 *     }                                             }
 *
 * VC8 compiles the printed form with the search condition duplicated at the loop's bottom
 * and every exit through the shared epilogue; the original tests the pointer at the bottom
 * and returns inline after the loop (`mov ecx, [ecx+4]; test ecx, ecx; jne loop; ret`),
 * which is what the loop on the pointer compiles to.
 *
 * Value-preserving. With X the tested local, C the printed loop condition, S the body before
 * the bottom test and R the exit: on entry both forms run R when X is null; otherwise both
 * test C, leave the loop with X non-null when C fails, and after S run R when X became null,
 * else test C again. The rewrite requires:
 *   - the guard right before the loop and the bottom test are the same test of X (`!X`,
 *     `X == 0`, `X == nullptr`) with the same exit R, and R ends in a return;
 *   - X is a local or parameter whose address is never taken;
 *   - C writes nothing and calls nothing, so it cannot change X;
 *   - C is one test, without `&&` or `||`: VC8 copies a single-test loop condition to the
 *     loop's bottom, which is where the printed form differs from the original, but leaves a
 *     short-circuit condition at the top, where the printed form already compiles to the
 *     original (GetSkillByIdAndOwner, 006439b0, matches as printed and loses as rewritten);
 *   - S holds no `break` or `continue` of the loop, no label and no goto, and declares no
 *     name R mentions (R moves out of S's scope).
 * A copy of the exit test straight after the loop is redundant then and is dropped.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CompoundStmt, Expression, FunctionDecl, Identifier, IfStmt,
  ParameterDecl, ParenExpr, Statement, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, nodesEqual, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { negate } from './branch-layout/index.js';

export interface SearchLoopExitOptions extends PluginOptions {
  onSite?: (e: { function: string; variable: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isNullLiteral(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value === 0n;
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.Identifier && ((u as Identifier).name === 'NULL' || (u as Identifier).name === 'nullptr');
}

/** The local a `!X` / `X == 0` test is about. */
function nullTested(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const o = unwrap((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==') {
    const b = u as BinaryExpr;
    const l = unwrap(b.left);
    if (l.kind === NodeKind.Identifier && isNullLiteral(b.right)) return (l as Identifier).name;
  }
  return null;
}

function stmts(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
}

/** The statement always leaves the function: a return, or a block whose last statement does. */
function endsInReturn(s: Statement): boolean {
  const list = stmts(s);
  const last = list[list.length - 1];
  return !!last && (last.kind === NodeKind.ReturnStmt || (last.kind === NodeKind.CompoundStmt && endsInReturn(last)));
}

/** No write, no call, no increment anywhere in the expression. */
function isPure(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.AssignExpr || n.kind === NodeKind.CallExpr || n.kind === NodeKind.PostfixExpr) return false;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) return false;
    if (n.kind === NodeKind.CommaExpr) return false;
  }
  return true;
}

/** A condition with `&&` or `||` in it. */
function isShortCircuit(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((n as BinaryExpr).operator)) return true;
  }
  return false;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

/**
 * A label or goto anywhere, or a `break` / `continue` that binds to the loop the statements
 * sit in: a `break` outside inner loops and switches, a `continue` outside inner loops.
 */
function hasLoopJump(list: Statement[]): boolean {
  const walk = (n: ASTNode, inLoop: boolean, inSwitch: boolean): boolean => {
    if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) return true;
    if (n.kind === NodeKind.BreakStmt && !inLoop && !inSwitch) return true;
    if (n.kind === NodeKind.ContinueStmt && !inLoop) return true;
    const loop = inLoop || LOOPS.has(n.kind);
    const sw = inSwitch || n.kind === NodeKind.SwitchStmt;
    return getChildren(n).some(k => walk(k, loop, sw));
  };
  return list.some(s => walk(s, false, false));
}

function namesIn(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier) out.add((m as Identifier).name);
  return out;
}

function declaredIn(list: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of list) {
    for (const n of traverseAST(s)) {
      if (n.kind === NodeKind.VariableDecl) out.add((n as VariableDecl).name.name);
    }
  }
  return out;
}

interface FnFacts {
  /** Locals and parameters by name, with the ones declared twice removed. */
  locals: Set<string>;
  addressed: Set<string>;
}

function factsOf(fn: FunctionDecl): FnFacts {
  const locals = new Set<string>();
  const dup = new Set<string>();
  const add = (n: string) => { if (locals.has(n)) dup.add(n); locals.add(n); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name);
  const addressed = new Set<string>();
  for (const n of traverseAST(fn.body!)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      add(v.name.name);
      if (v.type?.kind === NodeKind.ArrayType) addressed.add(v.name.name);
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
  }
  for (const d of dup) locals.delete(d);
  return { locals, addressed };
}

function ident(name: string, like: ASTNode): Identifier {
  return { kind: NodeKind.Identifier, name, location: like.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Identifier;
}

function rewriteBlock(block: CompoundStmt, facts: FnFacts, report: (v: string) => void): boolean {
  const list = block.statements;
  let changed = false;
  for (let i = 0; i + 1 < list.length; i++) {
    const g = list[i];
    const l = list[i + 1];
    if (g.kind !== NodeKind.IfStmt || l.kind !== NodeKind.WhileStmt) continue;
    const guard = g as IfStmt;
    const loop = l as WhileStmt;
    if (guard.elseBranch || guard.init) continue;
    const x = nullTested(guard.condition);
    if (!x || !facts.locals.has(x) || facts.addressed.has(x)) continue;
    if (!endsInReturn(guard.thenBranch)) continue;
    if (loop.body.kind !== NodeKind.CompoundStmt) continue;
    const body = (loop.body as CompoundStmt).statements;
    const last = body[body.length - 1];
    if (!last || last.kind !== NodeKind.IfStmt) continue;
    const bottom = last as IfStmt;
    if (bottom.elseBranch || bottom.init || !nodesEqual(bottom.condition, guard.condition)) continue;
    if (!nodesEqual(bottom.thenBranch, guard.thenBranch)) continue;
    if (!isPure(loop.condition) || isShortCircuit(loop.condition)) continue;
    const s = body.slice(0, -1);
    if (hasLoopJump(s)) continue;
    const exitNames = namesIn(guard.thenBranch);
    if ([...declaredIn(s)].some(n => exitNames.has(n))) continue;

    const brk = { kind: NodeKind.BreakStmt, location: loop.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Statement;
    const stop = {
      kind: NodeKind.IfStmt, condition: negate(loop.condition), thenBranch: brk, elseBranch: null,
      isConstexpr: false, location: loop.location, leadingTrivia: [], trailingTrivia: [],
    } as unknown as IfStmt;
    const newBody = { ...(loop.body as CompoundStmt), statements: [stop, ...s] } as CompoundStmt;
    const newLoop = { ...loop, condition: ident(x, loop.condition), body: newBody, leadingTrivia: guard.leadingTrivia } as WhileStmt;
    const exit = { ...guard, leadingTrivia: [] } as IfStmt;
    let take = 2;
    const after = list[i + 2];
    if (after && after.kind === NodeKind.IfStmt && !(after as IfStmt).elseBranch
      && nodesEqual((after as IfStmt).condition, guard.condition) && nodesEqual((after as IfStmt).thenBranch, guard.thenBranch)) take = 3;
    list.splice(i, take, newLoop, exit);
    changed = true;
    report(x);
  }
  return changed;
}

function rewriteFunction(fn: FunctionDecl, onSite?: SearchLoopExitOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const body = cloneNode(fn.body) as CompoundStmt;
  const facts = factsOf({ ...fn, body } as FunctionDecl);
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  let changed = false;
  const visit = (n: ASTNode): void => {
    for (const k of getChildren(n)) visit(k);
    if (n.kind === NodeKind.CompoundStmt && rewriteBlock(n as CompoundStmt, facts, v => onSite?.({ function: fname, variable: v }))) changed = true;
  };
  visit(body);
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createSearchLoopExitTransformer(options: SearchLoopExitOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options.onSite);
    },
  });
}

export const searchLoopExitPlugin: TransformPlugin = {
  id: 'search-loop-exit',
  name: 'Search Loop Exit',
  description: 'A search loop whose not-found exit is printed as a guard and a bottom test loops on the tested pointer',
  version: '1.0.0',
  defaultEnabled: true,
  // On the final control flow: after early-return, loop canonicalisation and branch-layout
  // (988), before the WARNING strip (990), which runs last.
  priority: 989.85,
  tags: ['matching'],
  createTransformer: createSearchLoopExitTransformer,
};

export function searchLoopExit_forTest(fn: FunctionDecl): FunctionDecl {
  return rewriteFunction(fn) ?? fn;
}

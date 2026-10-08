/**
 * Halt Site Fold Plugin
 *
 * Every Blizzard assertion in 1.14d is the same four instructions, and Ghidra renders
 * them as temporaries feeding the halt call:
 *
 *     nLine = 0x1ef;
 *     nAddress = GetInstructionPointer();
 *     ERROR_UnrecoverableInternalError_Halt("", nAddress, nLine);
 *     exit(-1);
 *
 * The temporaries exist because the compiler needed registers, not because the source
 * had variables. Two shapes are folded back to the call the programmer wrote:
 *
 * 1. FOLD. The definitions that sit directly in front of the halt call move into its
 *    arguments:  Halt("", GetInstructionPointer(), 0x1ef);
 *    Only when every definition in that run is either the instruction-pointer call or a
 *    side-effect-free expression, so argument order cannot matter, and only when a
 *    visible terminator (`exit(-1)`) follows, so nothing can observe the temporaries
 *    afterwards.
 *
 * 2. SHARED TAIL. When several branches choose their own line number and jump to one
 *    shared halt, the tail is copied to each jump:
 *        nLine = 0x4ca; goto LAB;  ...  LAB: Halt("", GetInstructionPointer(), nLine); exit(-1);
 *    becomes  Halt("", GetInstructionPointer(), 0x4ca); exit(-1);  at each jump. This is
 *    what the source looked like (the assertion macro expands in place); the shared
 *    block is the compiler's tail merge. A label is only dissolved when EVERY goto to it
 *    can be replaced, and the tail is nothing but the halt and its terminator.
 *
 * Anything with another live effect in the tail, a definition that is not adjacent, or
 * a value that is not a plain temporary is left exactly as it was.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, ExprStmt, DeclStmt, VariableDecl,
  LabelStmt, GotoStmt, IfStmt, Statement, Expression, CallExpr, AssignExpr,
  Identifier, QualifiedId, UnaryExpr, ParenExpr, CStyleCastExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface HaltSiteFoldOptions extends PluginOptions {}

const HALT_CALLEES = new Set(['ERROR_UnrecoverableInternalError_Halt']);
const IP_CALLEES = new Set(['GetInstructionPointer']);
const EXIT_CALLEES = new Set(['exit', '_exit']);

/** Counts of what the pass did, read by the tests and the census. */
export interface HaltSiteFoldStats {
  /** Halt sites whose preceding definitions were folded into the call. */
  folded: number;
  /** Shared tails dissolved after their jumps took a copy. */
  tailsInlined: number;
  /** `goto` statements replaced by a copy of the shared tail. */
  gotosReplaced: number;
  /** Joins whose line is chosen per branch: halt copies written into the branches. */
  joined: number;
  joinLeaves: number;
}

// ---------------------------------------------------------------------------
// Recognisers
// ---------------------------------------------------------------------------

/** The last name segment of a callee: `A::B::f` and `f` both answer `f`. */
function calleeTail(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const n = (e as QualifiedId).name;
    return n.kind === NodeKind.Identifier ? (n as Identifier).name : null;
  }
  return null;
}

function exprOf(s: Statement): Expression | null {
  return s.kind === NodeKind.ExprStmt ? (s as ExprStmt).expression : null;
}

function callTo(e: Expression | null, names: Set<string>, arity: number): CallExpr | null {
  if (!e || e.kind !== NodeKind.CallExpr) return null;
  const c = e as CallExpr;
  const t = calleeTail(c.callee);
  if (t === null || !names.has(t) || c.arguments.length !== arity) return null;
  return c;
}

function haltCall(s: Statement): CallExpr | null {
  const c = callTo(exprOf(s), HALT_CALLEES, 3);
  return c && c.arguments[0].kind === NodeKind.StringLiteral ? c : null;
}

function isExitStmt(s: Statement): boolean {
  return callTo(exprOf(s), EXIT_CALLEES, 1) !== null;
}

function isIpCall(e: Expression): boolean {
  let cur = e;
  while (cur.kind === NodeKind.ParenExpr || cur.kind === NodeKind.CStyleCastExpr) {
    cur = cur.kind === NodeKind.ParenExpr
      ? (cur as ParenExpr).expression
      : (cur as CStyleCastExpr).expression;
  }
  return callTo(cur, IP_CALLEES, 0) !== null;
}

/** The variable an argument is made of, through casts: `(int32_t)v` and `v` both answer `v`. */
function argIdent(a: Expression): string | null {
  let cur = a;
  while (cur.kind === NodeKind.ParenExpr || cur.kind === NodeKind.CStyleCastExpr) {
    cur = cur.kind === NodeKind.ParenExpr
      ? (cur as ParenExpr).expression
      : (cur as CStyleCastExpr).expression;
  }
  return cur.kind === NodeKind.Identifier ? (cur as Identifier).name : null;
}

/** `a` with the variable it is made of replaced, keeping the casts around it. */
function substInArg(a: Expression, byName: ReadonlyMap<string, Expression>): Expression {
  if (a.kind === NodeKind.Identifier) return byName.get((a as Identifier).name) ?? a;
  if (a.kind === NodeKind.ParenExpr) {
    const inner = substInArg((a as ParenExpr).expression, byName);
    return inner === (a as ParenExpr).expression ? a : updateNode(a as ParenExpr, { expression: inner } as Partial<ParenExpr>);
  }
  if (a.kind === NodeKind.CStyleCastExpr) {
    const inner = substInArg((a as CStyleCastExpr).expression, byName);
    return inner === (a as CStyleCastExpr).expression
      ? a
      : updateNode(a as CStyleCastExpr, { expression: inner } as Partial<CStyleCastExpr>);
  }
  return a;
}

/** A literal, or the instruction pointer: a value no statement in between can change. */
function isConstant(e: Expression): boolean {
  if (isIpCall(e)) return true;
  switch (e.kind) {
    case NodeKind.IntegerLiteral:
    case NodeKind.BoolLiteral:
    case NodeKind.CharLiteral:
    case NodeKind.NullptrLiteral:
      return true;
    case NodeKind.ParenExpr:
      return isConstant((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr:
      return isConstant((e as CStyleCastExpr).expression);
    case NodeKind.UnaryExpr: {
      const op = (e as UnaryExpr).operator;
      return (op === '-' || op === '+' || op === '~' || op === '!') && isConstant((e as UnaryExpr).operand);
    }
    default:
      return false;
  }
}

/** Statements after which control cannot continue to the next statement of the list. */
function terminates(s: Statement): boolean {
  const k = s.kind;
  return k === NodeKind.ReturnStmt || k === NodeKind.GotoStmt || isExitStmt(s);
}

/**
 * Could evaluating this expression do anything observable? Only used to decide whether an
 * operand may be moved relative to the instruction-pointer call, so anything not known to
 * be inert answers yes.
 */
function mayHaveSideEffects(expr: ASTNode): boolean {
  for (const n of traverseAST(expr)) {
    switch (n.kind) {
      case NodeKind.CallExpr:
      case NodeKind.AssignExpr:
      case NodeKind.NewExpr:
      case NodeKind.DeleteExpr:
        return true;
      case NodeKind.UnaryExpr: {
        const op = (n as UnaryExpr).operator;
        if (op === '++' || op === '--') return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

function mentions(node: ASTNode, names: ReadonlySet<string>): boolean {
  for (const n of traverseAST(node)) {
    if (n.kind === NodeKind.Identifier && names.has((n as Identifier).name)) return true;
  }
  return false;
}

function countIdent(nodes: readonly ASTNode[], name: string): number {
  let c = 0;
  for (const root of nodes) {
    for (const n of traverseAST(root)) {
      if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) c++;
    }
  }
  return c;
}

/** A comment on a statement would be lost with it; such a statement is never removed. */
function carriesComment(n: ASTNode): boolean {
  const has = (t: ReadonlyArray<{ kind: string; text: string }> | undefined): boolean =>
    !!t && t.some(x => x.kind === 'LineComment' || x.kind === 'BlockComment' || x.kind === 'Directive');
  return has(n.leadingTrivia as any) || has(n.trailingTrivia as any);
}

// ---------------------------------------------------------------------------
// Statement peeling: `LAB: stmt` is a LabelStmt wrapping `stmt`
// ---------------------------------------------------------------------------

interface Peeled {
  labels: LabelStmt[];
  inner: Statement;
}

function peel(s: Statement): Peeled {
  const labels: LabelStmt[] = [];
  let cur = s;
  while (cur.kind === NodeKind.LabelStmt) {
    labels.push(cur as LabelStmt);
    cur = (cur as LabelStmt).statement;
  }
  return { labels, inner: cur };
}

/** Put the labels back on a statement, outermost first. */
function relabel(labels: readonly LabelStmt[], inner: Statement): Statement {
  let out = inner;
  for (let i = labels.length - 1; i >= 0; i--) {
    out = updateNode(labels[i], { statement: out } as Partial<LabelStmt>);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Definitions: `v = rhs;` and `T v = rhs;`
// ---------------------------------------------------------------------------

interface Def {
  name: string;
  rhs: Expression;
  /** `T v = rhs;` consumes the declaration; `v = rhs;` leaves it for the cleanup. */
  isDecl: boolean;
  stmt: Statement;
  labels: LabelStmt[];
}

function asDef(s: Statement): Def | null {
  const { labels, inner } = peel(s);
  if (inner.kind === NodeKind.ExprStmt) {
    const e = (inner as ExprStmt).expression;
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      if (a.operator === '=' && a.left.kind === NodeKind.Identifier) {
        return { name: (a.left as Identifier).name, rhs: a.right, isDecl: false, stmt: inner, labels };
      }
    }
    return null;
  }
  if (inner.kind === NodeKind.DeclStmt) {
    const d = inner as DeclStmt;
    if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = d.declarations[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return null;
    if (v.specifiers.some(sp => (sp as string) === 'static' || (sp as string) === 'extern')) return null;
    return { name: v.name.name, rhs: v.initializer as Expression, isDecl: true, stmt: inner, labels };
  }
  return null;
}

/** A value that may move into a halt argument: the instruction pointer or something inert. */
function foldable(e: Expression): boolean {
  return isIpCall(e) || !mayHaveSideEffects(e);
}

// ---------------------------------------------------------------------------
// Shape 1: fold the definitions in front of a halt into its arguments
// ---------------------------------------------------------------------------

interface FoldResult {
  stmts: Statement[];
  /** Variables whose assignments were folded and whose bare declaration may now be dead. */
  assigned: string[];
  count: number;
}

function foldHaltSites(stmts: readonly Statement[]): FoldResult | null {
  const out: Statement[] = [];
  const assigned: string[] = [];
  let count = 0;

  for (let h = 0; h < stmts.length; h++) {
    const here = peel(stmts[h]);
    const call = haltCall(here.inner);
    const next = stmts[h + 1];
    if (!call || !next || !isExitStmt(next)) { out.push(stmts[h]); continue; }

    const argNames = new Set<string>();
    for (const a of [call.arguments[1], call.arguments[2]]) {
      const n = argIdent(a);
      if (n) argNames.add(n);
    }
    if (argNames.size === 0) { out.push(stmts[h]); continue; }

    // The definitions of those variables before the halt. A plain assignment to some other
    // local may sit between them and the halt (the compiler interleaves register loads);
    // a definition can move past such a statement only if nothing in between can change it.
    const chain: Def[] = [];
    const chainIdx: number[] = [];
    const skipped: number[] = [];
    const seen = new Set<string>();
    let lastSkip = -1;
    for (let j = out.length - 1; j >= 0 && chain.length < 2 && skipped.length <= 4; j--) {
      const d = asDef(out[j]);
      if (d && argNames.has(d.name) && !seen.has(d.name)) {
        if (lastSkip >= 0 && !isConstant(d.rhs)) break;
        seen.add(d.name);
        chain.push(d);
        chainIdx.push(j);
        continue;
      }
      if (d && !d.isDecl && d.labels.length === 0 && !argNames.has(d.name)
          && !mayHaveSideEffects(d.rhs) && !carriesComment(d.stmt)) {
        skipped.push(j);
        lastSkip = j;
        continue;
      }
      break;
    }
    if (chain.length === 0) { out.push(stmts[h]); continue; }
    // Skipped statements before the earliest definition are not between it and the halt.
    const earliest = Math.min(...chainIdx);
    const between = skipped.filter(j => j > earliest);

    // A jump to the halt itself, or into the middle of the run, would skip definitions
    // that the fold moves into the call: those jumpers set the variables themselves.
    const labelInside = (j: number) => peel(out[j]).labels.length > 0;
    if (here.labels.length > 0
        || [...chainIdx, ...between].some(j => j !== earliest && labelInside(j))) {
      out.push(stmts[h]);
      continue;
    }

    const names = new Set(chain.map(d => d.name));
    let ok = true;
    for (const d of chain) {
      if (!foldable(d.rhs) || mentions(d.rhs, names) || carriesComment(d.stmt)) { ok = false; break; }
      // A consumed declaration must have no other life in its block.
      if (d.isDecl && countIdent(stmts, d.name) !== 2) { ok = false; break; }
    }
    // A definition may not move past a statement that reads a variable being folded away.
    for (let m = 0; ok && m < chain.length; m++) {
      for (const j of skipped) if (j > chainIdx[m] && mentions(out[j], names)) ok = false;
    }
    if (!ok) { out.push(stmts[h]); continue; }

    // Labels sitting on the earliest removed definition move to the halt: the jump still lands on it.
    const moved: LabelStmt[] = [];
    for (let i = chain.length - 1; i >= 0; i--) moved.push(...chain[i].labels);
    const byName = new Map(chain.map(d => [d.name, d.rhs] as const));
    const newCall = updateNode(call, {
      arguments: [call.arguments[0], substInArg(call.arguments[1], byName), substInArg(call.arguments[2], byName)],
    } as Partial<CallExpr>);
    const newHalt = updateNode(here.inner as ExprStmt, { expression: newCall } as Partial<ExprStmt>);

    const drop = new Set(chainIdx);
    const kept = out.filter((_, j) => !drop.has(j));
    out.length = 0;
    out.push(...kept);
    out.push(relabel([...moved, ...here.labels], newHalt));
    for (const d of chain) if (!d.isDecl) assigned.push(d.name);
    count++;
  }

  return count === 0 ? null : { stmts: out, assigned, count };
}

// ---------------------------------------------------------------------------
// Shape 2: copy a shared halt tail to every jump that reaches it
// ---------------------------------------------------------------------------

interface Tail {
  /** The halt statement and its terminator, labels removed. */
  halt: ExprStmt;
  call: CallExpr;
  exit: Statement;
  /** Plain identifiers the halt reads, in argument order. */
  vars: string[];
}

/** The shared tail a label heads, if it is nothing but the halt and its terminator. */
function asTail(stmts: readonly Statement[], k: number): { tail: Tail; labels: string[] } | null {
  // The tail may still hold the definitions that feed the halt (`LAB: nAddress = ...;`):
  // fold them first, so the tail is judged by what it does and not by how it is spelled.
  const raw = stmts.slice(k);
  const rest = foldHaltSites(raw)?.stmts ?? raw;
  if (rest.length !== 2) return null;
  const first = peel(rest[0]);
  if (first.labels.length === 0) return null;
  const call = haltCall(first.inner);
  if (!call || !isExitStmt(rest[1])) return null;
  const vars: string[] = [];
  for (const a of [call.arguments[1], call.arguments[2]]) {
    const n = argIdent(a);
    if (n !== null) {
      if (vars.includes(n)) return null;
      vars.push(n);
    } else if (!foldable(a) || mentions(a, new Set(vars))) {
      return null;
    }
  }
  // Nothing else in the tail may read a variable: the halt's own arguments are the interface.
  if (mentions(call.arguments[0], new Set(vars))) return null;
  return {
    tail: { halt: first.inner as ExprStmt, call, exit: rest[1], vars },
    labels: first.labels.map(l => l.label.name),
  };
}

/** Definitions directly before position `end` of `list` that cover exactly the tail's variables. */
function leadingChain(list: readonly Statement[], end: number, vars: readonly string[]): Def[] | null {
  if (vars.length === 0) return [];
  const chain: Def[] = [];
  const want = new Set(vars);
  for (let j = end - 1; j >= 0 && chain.length < vars.length; j--) {
    const d = asDef(list[j]);
    if (!d || d.isDecl || !want.has(d.name) || chain.some(c => c.name === d.name)) return null;
    if (d.labels.length > 0 || carriesComment(d.stmt)) return null;
    chain.push(d);
  }
  if (chain.length !== vars.length) return null;
  const names = new Set(vars);
  for (const d of chain) {
    if (!foldable(d.rhs) || mentions(d.rhs, names)) return null;
  }
  return chain;
}

function copyOfTail(tail: Tail, chain: readonly Def[]): Statement[] {
  const byName = new Map(chain.map(d => [d.name, d.rhs] as const));
  const call = updateNode(tail.call, {
    arguments: [
      tail.call.arguments[0],
      substInArg(tail.call.arguments[1], byName),
      substInArg(tail.call.arguments[2], byName),
    ],
  } as Partial<CallExpr>);
  return [updateNode(tail.halt, { expression: call } as Partial<ExprStmt>), tail.exit];
}

interface TailPlan {
  tail: Tail;
}

/**
 * Replace each jump to a planned label in one statement list. Returns the new list, or
 * null when nothing changed. `replaced` counts the jumps handled (for the dry run).
 */
function inlineJumps(
  list: readonly Statement[],
  plans: ReadonlyMap<string, TailPlan>,
  counter: { n: number },
): Statement[] | null {
  const out: Statement[] = [];
  let changed = false;
  for (const s of list) {
    const p = peel(s);
    if (p.inner.kind === NodeKind.GotoStmt) {
      const plan = plans.get((p.inner as GotoStmt).label.name);
      if (plan) {
        const chain = leadingChain(out, out.length, plan.tail.vars);
        // A label on the goto means "enter after the definitions": the copy would not honour that.
        if (chain && (chain.length === 0 || p.labels.length === 0)) {
          out.length -= chain.length;
          const copy = copyOfTail(plan.tail, chain);
          out.push(relabel(p.labels, copy[0]), copy[1]);
          counter.n++;
          changed = true;
          continue;
        }
      }
    }
    out.push(s);
  }
  return changed ? out : null;
}

/** A goto that is the whole branch of an `if` has no room for a definition before it. */
function inlineBranch(
  branch: Statement | null,
  plans: ReadonlyMap<string, TailPlan>,
  counter: { n: number },
): Statement | null {
  if (!branch || branch.kind !== NodeKind.GotoStmt) return null;
  const plan = plans.get((branch as GotoStmt).label.name);
  if (!plan || plan.tail.vars.length !== 0) return null;
  counter.n++;
  return Stmt.compound(copyOfTail(plan.tail, []));
}

/**
 * Which labels of `body` head a tail that every jump to them can take a copy of.
 * A jump that cannot take a copy keeps its label alive, so the label is not planned.
 */
function planTails(body: CompoundStmt): Map<string, TailPlan> {
  const candidates = new Map<string, TailPlan>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let k = 0; k < list.length; k++) {
      if (list[k].kind !== NodeKind.LabelStmt) continue;
      const t = asTail(list, k);
      if (!t) continue;
      for (const name of t.labels) candidates.set(name, { tail: t.tail });
    }
  }
  if (candidates.size === 0) return candidates;

  // Every goto to a candidate must be one the replacement can reach.
  const total = new Map<string, number>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.GotoStmt) {
      const l = (n as GotoStmt).label.name;
      if (candidates.has(l)) total.set(l, (total.get(l) ?? 0) + 1);
    }
  }
  const reached = new Map<string, number>();
  for (const [label, plan] of candidates) {
    const solo = new Map([[label, plan]]);
    const c = { n: 0 };
    for (const n of traverseAST(body)) {
      if (n.kind === NodeKind.CompoundStmt) inlineJumps((n as CompoundStmt).statements, solo, c);
      if (n.kind === NodeKind.IfStmt) {
        inlineBranch((n as IfStmt).thenBranch, solo, c);
        inlineBranch((n as IfStmt).elseBranch, solo, c);
      }
    }
    reached.set(label, c.n);
  }
  const plans = new Map<string, TailPlan>();
  for (const [label, plan] of candidates) {
    if ((total.get(label) ?? 0) > 0 && total.get(label) === reached.get(label)) plans.set(label, plan);
  }
  return plans;
}

/**
 * With the jumps gone, the labelled tail is dead unless the code above falls into it. Fall
 * through with the definitions in front: the tail takes them. Fall through otherwise: the
 * tail stays, only the label goes. Fall through from a statement that continues elsewhere
 * cannot be reasoned about, and keeps the label.
 */
function dissolveTails(list: readonly Statement[], plans: ReadonlyMap<string, TailPlan>): Statement[] | null {
  for (let k = 0; k < list.length; k++) {
    if (list[k].kind !== NodeKind.LabelStmt) continue;
    const t = asTail(list, k);
    if (!t || !t.labels.every(l => plans.has(l))) continue;
    const prefix = list.slice(0, k);
    const prev = prefix.length > 0 ? peel(prefix[prefix.length - 1]).inner : null;
    if (prev && terminates(prev)) return [...prefix];
    const chain = leadingChain(prefix, prefix.length, t.tail.vars);
    if (chain) {
      const copy = copyOfTail(t.tail, chain);
      return [...prefix.slice(0, prefix.length - chain.length), ...copy];
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape 3: the line is chosen per branch and the join is only the halt
// ---------------------------------------------------------------------------

interface JoinCtx {
  line: string;
  halt: ExprStmt;
  call: CallExpr;
  exit: Statement;
  leaves: number;
}

const MAX_JOIN_LEAVES = 16;

/**
 * Rewrite `s` so that every path leaving it through its end runs the halt with the line that
 * path chose. Null when some path's line is not a plain `line = C;` in last position.
 */
function threadHalt(s: Statement, ctx: JoinCtx): Statement[] | null {
  if (terminates(s)) return [s];
  if (s.kind === NodeKind.ExprStmt) {
    const d = asDef(s);
    if (!d || d.isDecl || d.name !== ctx.line || !foldable(d.rhs) || mentions(d.rhs, new Set([ctx.line]))
        || carriesComment(d.stmt)) return null;
    ctx.leaves++;
    const call = updateNode(ctx.call, {
      arguments: [ctx.call.arguments[0], ctx.call.arguments[1],
        substInArg(ctx.call.arguments[2], new Map([[ctx.line, d.rhs]]))],
    } as Partial<CallExpr>);
    return [updateNode(ctx.halt, { expression: call } as Partial<ExprStmt>), ctx.exit];
  }
  if (s.kind === NodeKind.CompoundStmt) {
    const c = s as CompoundStmt;
    if (c.statements.length === 0) return null;
    const last = c.statements[c.statements.length - 1];
    if (last.kind === NodeKind.LabelStmt) return null;
    const r = threadHalt(last, ctx);
    if (!r) return null;
    return [updateNode(c, { statements: [...c.statements.slice(0, -1), ...r] } as Partial<CompoundStmt>)];
  }
  if (s.kind === NodeKind.IfStmt) {
    const i = s as IfStmt;
    if (!i.elseBranch) return null;
    const t = threadHalt(i.thenBranch, ctx);
    const e = t ? threadHalt(i.elseBranch, ctx) : null;
    if (!t || !e) return null;
    const asStmt = (l: Statement[]): Statement => (l.length === 1 ? l[0] : Stmt.compound(l));
    return [updateNode(i, { thenBranch: asStmt(t), elseBranch: asStmt(e) } as Partial<IfStmt>)];
  }
  return null;
}

/**
 * `if (..) {.. line = A;} else {.. line = B;}  Halt("", ip, line);  exit(-1);` at the end of a
 * block: the halt is copied into the branches, which is how the assertions were written.
 */
function joinHalt(stmts: readonly Statement[]): { stmts: Statement[]; leaves: number; line: string } | null {
  const n = stmts.length;
  if (n < 3 || !isExitStmt(stmts[n - 1])) return null;
  const here = peel(stmts[n - 2]);
  const call = haltCall(here.inner);
  if (!call || here.labels.length > 0) return null;
  const line = argIdent(call.arguments[2]);
  if (line === null || argIdent(call.arguments[1]) === line) return null;
  if (mentions(call.arguments[0], new Set([line])) || mentions(call.arguments[1], new Set([line]))) return null;
  const prev = stmts[n - 3];
  if (prev.kind !== NodeKind.IfStmt) return null;

  const ctx: JoinCtx = { line, halt: here.inner as ExprStmt, call, exit: stmts[n - 1], leaves: 0 };
  const r = threadHalt(prev, ctx);
  if (!r || ctx.leaves === 0 || ctx.leaves > MAX_JOIN_LEAVES) return null;
  return { stmts: [...stmts.slice(0, n - 3), ...r], leaves: ctx.leaves, line };
}

// ---------------------------------------------------------------------------
// Declarations nobody reads any more
// ---------------------------------------------------------------------------

/** Remove the bare declarations of `names` that nothing references any more. */
function dropDeadDecls(body: CompoundStmt, names: ReadonlySet<string>): CompoundStmt {
  const dead = new Set<string>();
  for (const name of names) {
    let decls = 0;
    for (const n of traverseAST(body)) {
      if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === name
          && !(n as VariableDecl).initializer) decls++;
    }
    if (decls > 0 && countIdent([body], name) === decls) dead.add(name);
  }
  if (dead.size === 0) return body;
  const t = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const kept: Statement[] = [];
      let changed = false;
      for (const s of block.statements) {
        if (s.kind === NodeKind.DeclStmt && !carriesComment(s)) {
          const d = s as DeclStmt;
          const rest = d.declarations.filter(x =>
            !(x.kind === NodeKind.VariableDecl && dead.has((x as VariableDecl).name.name)
              && !(x as VariableDecl).initializer));
          if (rest.length !== d.declarations.length) {
            changed = true;
            if (rest.length > 0) kept.push(updateNode(d, { declarations: rest } as Partial<DeclStmt>));
            continue;
          }
        }
        kept.push(s);
      }
      return changed ? updateNode(block, { statements: kept } as Partial<CompoundStmt>) : undefined;
    },
  });
  return t(body) as CompoundStmt;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export function foldHaltSites_forTest(fn: FunctionDecl): { fn: FunctionDecl; stats: HaltSiteFoldStats } {
  const stats: HaltSiteFoldStats = { folded: 0, tailsInlined: 0, gotosReplaced: 0, joined: 0, joinLeaves: 0 };
  const out = rewriteFunction(fn, stats);
  return { fn: out ?? fn, stats };
}

function rewriteFunction(node: FunctionDecl, stats: HaltSiteFoldStats): FunctionDecl | undefined {
  if (!node.body) return undefined;
  let body: CompoundStmt = node.body;
  const touched = new Set<string>();

  // 1. fold the definitions in front of each halt
  const fold = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = foldHaltSites(block.statements);
      if (!r) return undefined;
      stats.folded += r.count;
      for (const n of r.assigned) touched.add(n);
      return updateNode(block, { statements: r.stmts } as Partial<CompoundStmt>);
    },
  });
  body = fold(body) as CompoundStmt;

  // 1b. a halt whose line was chosen per branch: write the halt into the branches
  const join = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = joinHalt(block.statements);
      if (!r) return undefined;
      stats.joined++;
      stats.joinLeaves += r.leaves;
      touched.add(r.line);
      return updateNode(block, { statements: r.stmts } as Partial<CompoundStmt>);
    },
  });
  body = join(body) as CompoundStmt;

  // 2. copy shared tails to their jumps, then dissolve the tails
  const plans = planTails(body);
  if (plans.size > 0) {
    const counter = { n: 0 };
    const inline = createTransformer({
      visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
        const r = inlineJumps(block.statements, plans, counter);
        return r ? updateNode(block, { statements: r } as Partial<CompoundStmt>) : undefined;
      },
      visitIfStmt(node: IfStmt): ASTNode | undefined {
        const t = inlineBranch(node.thenBranch, plans, counter);
        const e = inlineBranch(node.elseBranch, plans, counter);
        if (!t && !e) return undefined;
        return updateNode(node, {
          thenBranch: t ?? node.thenBranch,
          elseBranch: e ?? node.elseBranch,
        } as Partial<IfStmt>);
      },
    });
    body = inline(body) as CompoundStmt;
    stats.gotosReplaced += counter.n;

    const dissolve = createTransformer({
      visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
        const r = dissolveTails(block.statements, plans);
        if (!r) return undefined;
        stats.tailsInlined++;
        return updateNode(block, { statements: r } as Partial<CompoundStmt>);
      },
    });
    body = dissolve(body) as CompoundStmt;

    // the jumps' definitions are gone from their sites; the variables may be dead too
    for (const plan of plans.values()) for (const v of plan.tail.vars) touched.add(v);
  }

  if (touched.size > 0) body = dropDeadDecls(body, touched);
  if (stats.folded === 0 && stats.gotosReplaced === 0 && stats.joined === 0) return undefined;
  return updateNode(node, { body } as Partial<FunctionDecl>);
}

function createHaltSiteFoldTransformer(_options: HaltSiteFoldOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, { folded: 0, tailsInlined: 0, gotosReplaced: 0, joined: 0, joinLeaves: 0 });
    },
  });
}

export const haltSiteFoldPlugin: TransformPlugin = {
  id: 'halt-site-fold',
  name: 'Halt Site Fold',
  description:
    'Folds the line/address temporaries into the assertion halt call and copies a shared halt tail to each jump that reaches it',
  version: '1.0.0',
  defaultEnabled: true,
  // After the cast passes (~600) and decl-scope-sink, so the statements are in their final
  // shape; before the frame-group pass (950), which only looks at frame slots.
  priority: 930,
  tags: ['cleanup', 'assertion'],
  createTransformer: createHaltSiteFoldTransformer,
};

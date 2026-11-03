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
 *
 * Before either shape, with the instructions' facts (`haltLines`), every way into a shared
 * halt whose printed line is not the one its PUSH chose gets its own halt with that line
 * (see "Shape 0" below): the decompiler reads the line at one stack depth for ways that
 * arrive at different depths.
 *
 * A halt that takes the place of code keeps that code's source position: a folded halt
 * stays where it stands and owns its definitions' lines (`foldedLines`), a copy sits where
 * the jump or the definition it replaces was. `branch-layout` reads a statement's position
 * as where its code lies in the binary; the copy's code is the jump site's, not the shared
 * tail's. A copy for a test that falls into the shared halt has no site of its own and
 * keeps the halt's lines (the if's line prints the test, not the halt).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { SourceLocation } from '../../../lexer/index.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, ExprStmt, DeclStmt, VariableDecl,
  LabelStmt, GotoStmt, IfStmt, SwitchStmt, CaseStmt, DefaultStmt, Statement, Expression, CallExpr, AssignExpr,
  Identifier, QualifiedId, UnaryExpr, ParenExpr, CStyleCastExpr, IntegerLiteralExpr, BinaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Stmt, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { gotoReport } from './goto-cleanup/report.js';
import { negateCondition } from './assert-order.js';
import { storeIsDead } from './store-liveness.js';

/** One way into a halt as the instructions show it (reconstruct's extract/halt-lines.ts). */
export interface HaltLinePath {
  /** The line the PUSH right before this way pushes; null when it is not a `push imm`. */
  line: number | null;
  /** Offset of the conditional branch that selects this way; null when there is none. */
  guard: number | null;
}

/** A halt CALL of the function and every way into the `call GetInstructionPointer` before it. */
export interface HaltLineSite {
  at: number;
  ip: number;
  paths: HaltLinePath[];
}

/** What the line repair did for one function, or why it left the function as printed. */
export interface HaltLineRepairEvent {
  entries: number;
  lines: number[];
  refused?: string;
}

export interface HaltSiteFoldOptions extends PluginOptions {
  /**
   * The function's halts as the instructions show them. With them, every way into a shared
   * halt gets the line its own PUSH chose before anything is folded (see `repairHaltLines`).
   */
  haltLines?: readonly HaltLineSite[];
  /**
   * The original's conditional-branch offset per `if` line of the parsed text, and per leaf
   * operand of a short-circuit `if` line the branches that operand feeds.
   */
  branchLayout?: { ifs: ReadonlyMap<number, number>; operands?: ReadonlyMap<number, number[][]> };
  onRepair?: (e: HaltLineRepairEvent) => void;
}

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
  /** Ways into a shared halt given the line the instructions pushed on them. */
  linesRepaired: number;
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
function relabel(labels: readonly (LabelStmt | CaseStmt | DefaultStmt)[], inner: Statement): Statement {
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
  /** Labels on the definition, and with `cases` the `case`s and `default`s too. */
  labels: (LabelStmt | CaseStmt | DefaultStmt)[];
}

function asDef(s: Statement, cases = false): Def | null {
  const p = peel(s);
  const { wrappers: labels, inner } = cases ? peelAll(s) : { wrappers: p.labels, inner: p.inner };
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
      const d = asDef(out[j], true);
      if (d && argNames.has(d.name) && !seen.has(d.name)) {
        if (lastSkip >= 0 && !isConstant(d.rhs)) break;
        seen.add(d.name);
        chain.push(d);
        chainIdx.push(j);
        // A `case` starts the run: what lies above it belongs to the case before.
        if (d.labels.some(l => l.kind !== NodeKind.LabelStmt)) break;
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
    const labelInside = (j: number) => peelAll(out[j]).wrappers.length > 0;
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
    const moved: (LabelStmt | CaseStmt | DefaultStmt)[] = [];
    for (let i = chain.length - 1; i >= 0; i--) moved.push(...chain[i].labels);
    const byName = new Map(chain.map(d => [d.name, d.rhs] as const));
    const newCall = updateNode(call, {
      arguments: [call.arguments[0], substInArg(call.arguments[1], byName), substInArg(call.arguments[2], byName)],
    } as Partial<CallExpr>);
    const newHalt = withFolded(updateNode(here.inner as ExprStmt, { expression: newCall } as Partial<ExprStmt>),
      chain.map(d => d.stmt));

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

/** `s` placed at `site`; without one, where it stands. */
function placedAt<S extends Statement>(s: S, site: Statement | undefined): S {
  if (!site) return s;
  const location: SourceLocation = site.location;
  return { ...s, location };
}

/**
 * `s` where it stands, owning as well the lines of the definitions folded into it: their
 * stores printed its code. A range from the first definition to the halt would claim every
 * line between them too, and when a pass had copied the halt next to a definition far from
 * the shared halt, every line of the function between the two.
 */
function withFolded<S extends Statement>(s: S, folded: readonly Statement[]): S {
  const lines = new Set(s.ghidraInfo?.foldedLines ?? []);
  for (const d of folded) {
    for (const l of d.ghidraInfo?.foldedLines ?? []) lines.add(l);
    if (!d.location || d.location.file === '<generated>' || d.location.start.line <= 0) continue;
    for (let l = d.location.start.line; l <= d.location.end.line; l++) lines.add(l);
  }
  if (lines.size === 0) return s;
  return { ...s, ghidraInfo: { ...s.ghidraInfo, foldedLines: [...lines].sort((a, b) => a - b) } };
}

/** The statement the copy at a jump replaces first: the earliest definition, else the jump. */
function siteOf(chain: readonly Def[], jump: Statement): Statement {
  return chain.length > 0 ? chain[chain.length - 1].stmt : jump;
}

function copyOfTail(tail: Tail, chain: readonly Def[], site?: Statement): Statement[] {
  const byName = new Map(chain.map(d => [d.name, d.rhs] as const));
  const call = updateNode(tail.call, {
    arguments: [
      tail.call.arguments[0],
      substInArg(tail.call.arguments[1], byName),
      substInArg(tail.call.arguments[2], byName),
    ],
  } as Partial<CallExpr>);
  return [placedAt(updateNode(tail.halt, { expression: call } as Partial<ExprStmt>), site), tail.exit];
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
          const copy = copyOfTail(plan.tail, chain, siteOf(chain, p.inner));
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
  return Stmt.compound(copyOfTail(plan.tail, [], branch));
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
      const copy = copyOfTail(t.tail, chain, chain.length > 0 ? siteOf(chain, list[k]) : undefined);
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
  /** The literal each leaf passed; null for a leaf whose value is not a literal. */
  values: (number | null)[];
  /**
   * Set when a path was taken through anything beyond if/else in last position: a label or
   * case on the way, an `if` without `else`, a `switch` and its `break`s. Such a join is only
   * written when the line has no other use and the instructions push every leaf's literal.
   */
  wide: boolean;
}

const MAX_JOIN_LEAVES = 16;

type Wrapper = LabelStmt | CaseStmt | DefaultStmt;

/** `s` without the labels, `case`s and `default`s on it, outermost first. */
function peelAll(s: Statement): { wrappers: Wrapper[]; inner: Statement } {
  const wrappers: Wrapper[] = [];
  let cur = s;
  while (cur.kind === NodeKind.LabelStmt || cur.kind === NodeKind.CaseStmt || cur.kind === NodeKind.DefaultStmt) {
    wrappers.push(cur as Wrapper);
    cur = (cur as Wrapper).statement;
  }
  return { wrappers, inner: cur };
}

function rewrap(wrappers: readonly Wrapper[], inner: Statement): Statement {
  let out = inner;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    out = updateNode(wrappers[i], { statement: out } as Partial<Wrapper>);
  }
  return out;
}

/** A definition of the line as the last thing on a path: the halt with its value, then exit. */
function haltLeaf(s: Statement, ctx: JoinCtx): Statement[] | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const d = asDef(s);
  if (!d || d.isDecl || d.name !== ctx.line || !foldable(d.rhs) || mentions(d.rhs, new Set([ctx.line]))
      || carriesComment(d.stmt)) return null;
  ctx.leaves++;
  ctx.values.push(constValue(d.rhs));
  const call = updateNode(ctx.call, {
    arguments: [ctx.call.arguments[0], ctx.call.arguments[1],
      substInArg(ctx.call.arguments[2], new Map([[ctx.line, d.rhs]]))],
  } as Partial<CallExpr>);
  return [placedAt(updateNode(ctx.halt, { expression: call } as Partial<ExprStmt>), s), ctx.exit];
}

/** The first statement of a rewrite keeps the labels and cases the original carried. */
function withWrappers(wrappers: readonly Wrapper[], r: Statement[]): Statement[] {
  return wrappers.length === 0 ? r : [rewrap(wrappers, r[0]), ...r.slice(1)];
}

const asStmt = (l: Statement[]): Statement => (l.length === 1 ? l[0] : Stmt.compound(l));

/**
 * Rewrite `s` so that every path leaving it through its end runs the halt with the line that
 * path chose. Null when some path's line is not a plain `line = C;` in last position.
 */
function threadHalt(s: Statement, ctx: JoinCtx): Statement[] | null {
  if (terminates(s)) return [s];
  if (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
    // A jump or case that lands here runs the same path, so the halt takes the label along.
    const { wrappers, inner } = peelAll(s);
    if (terminates(inner)) return [s];
    ctx.wide = true;
    const r = threadHalt(inner, ctx);
    return r ? withWrappers(wrappers, r) : null;
  }
  if (s.kind === NodeKind.ExprStmt) return haltLeaf(s, ctx);
  if (s.kind === NodeKind.CompoundStmt) {
    const c = s as CompoundStmt;
    const n = c.statements.length;
    if (n === 0) return null;
    const last = c.statements[n - 1];
    // `line = A; if (c) {.. line = B;}`: the path that skips the `if` carries A.
    if (last.kind === NodeKind.IfStmt && !(last as IfStmt).elseBranch && n >= 2) {
      const before = c.statements[n - 2];
      if (before.kind !== NodeKind.ExprStmt || mentions((last as IfStmt).condition, new Set([ctx.line]))) return null;
      ctx.wide = true;
      const t = threadHalt((last as IfStmt).thenBranch, ctx);
      const skip = t ? haltLeaf(before, ctx) : null;
      if (!t || !skip) return null;
      const threaded = updateNode(last as IfStmt, { thenBranch: asStmt(t) } as Partial<IfStmt>);
      return [updateNode(c, { statements: [...c.statements.slice(0, n - 2), threaded, ...skip] } as Partial<CompoundStmt>)];
    }
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
    return [updateNode(i, { thenBranch: asStmt(t), elseBranch: asStmt(e) } as Partial<IfStmt>)];
  }
  if (s.kind === NodeKind.SwitchStmt) return threadSwitch(s as SwitchStmt, ctx);
  return null;
}

/**
 * A `switch` whose every way out is `line = C; break;` or its end: each such way runs the
 * halt itself. A `switch` without `default` is refused, since a value no case takes leaves
 * with whatever the line held before it.
 */
function threadSwitch(sw: SwitchStmt, ctx: JoinCtx): Statement[] | null {
  if (sw.body.kind !== NodeKind.CompoundStmt) return null;
  const list = (sw.body as CompoundStmt).statements;
  if (list.length === 0 || mentions(sw.condition, new Set([ctx.line]))) return null;
  if (!list.some(x => peelAll(x).wrappers.some(w => w.kind === NodeKind.DefaultStmt))) return null;
  ctx.wide = true;
  const out = breaksInList(list, ctx);
  if (!out || out.length === 0) return null;
  const last = out[out.length - 1];
  const { inner } = peelAll(last);
  if (!terminates(inner)) {
    const r = threadHalt(last, ctx);
    if (!r) return null;
    out.splice(out.length - 1, 1, ...r);
  }
  return [updateNode(sw, { body: updateNode(sw.body as CompoundStmt, { statements: out } as Partial<CompoundStmt>) } as Partial<SwitchStmt>)];
}

/** Each `line = C; break;` of the switch in `list` becomes the halt; any other `break` refuses. */
function breaksInList(list: readonly Statement[], ctx: JoinCtx): Statement[] | null {
  const out: Statement[] = [];
  for (const s of list) {
    const { wrappers, inner } = peelAll(s);
    if (inner.kind === NodeKind.BreakStmt) {
      // A case or label on the break itself enters without the definition.
      if (wrappers.length > 0 || out.length === 0) return null;
      const def = peelAll(out[out.length - 1]);
      const r = haltLeaf(def.inner, ctx);
      if (!r) return null;
      out.splice(out.length - 1, 1, ...withWrappers(def.wrappers, r));
      continue;
    }
    const r = breaksIn(inner, ctx);
    if (!r) return null;
    out.push(r === inner ? s : rewrap(wrappers, r));
  }
  return out;
}

function breaksIn(s: Statement, ctx: JoinCtx): Statement | null {
  switch (s.kind) {
    case NodeKind.BreakStmt:
      return null;
    case NodeKind.CompoundStmt: {
      const r = breaksInList((s as CompoundStmt).statements, ctx);
      return r ? updateNode(s as CompoundStmt, { statements: r } as Partial<CompoundStmt>) : null;
    }
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      const t = breaksIn(i.thenBranch, ctx);
      const e = i.elseBranch ? breaksIn(i.elseBranch, ctx) : undefined;
      if (!t || e === null) return null;
      return t === i.thenBranch && e === i.elseBranch
        ? s
        : updateNode(i, { thenBranch: t, elseBranch: e } as Partial<IfStmt>);
    }
    case NodeKind.LabelStmt:
    case NodeKind.CaseStmt:
    case NodeKind.DefaultStmt: {
      const { wrappers, inner } = peelAll(s);
      const r = breaksIn(inner, ctx);
      return r === null ? null : r === inner ? s : rewrap(wrappers, r);
    }
    default:
      // Loops and nested switches own their breaks; nothing else contains one.
      return s;
  }
}

/** Every literal a PUSH in front of one of the function's halts pushes. */
function pushedLines(facts: readonly HaltLineSite[] | undefined): Set<number> | null {
  if (!facts || facts.length === 0) return null;
  const out = new Set<number>();
  for (const h of facts) for (const p of h.paths) if (p.line !== null) out.add(p.line);
  return out;
}

/**
 * `if (..) {.. line = A;} else {.. line = B;}  Halt("", ip, line);  exit(-1);`: the halt is
 * copied into the branches, which is how the assertions were written. The statement in front
 * of the halt may also be a `switch`, an `if` without `else` after a definition, or carry
 * labels; then the line may have no other use in `body`, every leaf must be a literal, and
 * with the instructions' facts every literal must be one a PUSH in front of a halt pushes.
 * Statements after the terminator are unreachable from the halt and stay where they are.
 */
function joinHalt(
  stmts: readonly Statement[],
  body: CompoundStmt,
  pushed: ReadonlySet<number> | null,
): { stmts: Statement[]; leaves: number; line: string } | null {
  for (let h = 1; h + 1 < stmts.length; h++) {
    if (!isExitStmt(stmts[h + 1])) continue;
    const here = peel(stmts[h]);
    const call = haltCall(here.inner);
    if (!call || here.labels.length > 0) continue;
    const line = argIdent(call.arguments[2]);
    if (line === null || argIdent(call.arguments[1]) === line) continue;
    if (mentions(call.arguments[0], new Set([line])) || mentions(call.arguments[1], new Set([line]))) continue;
    const prev = stmts[h - 1];
    const prevInner = peelAll(prev).inner;
    if (prevInner.kind !== NodeKind.IfStmt && prevInner.kind !== NodeKind.SwitchStmt) continue;

    const ctx: JoinCtx = {
      line, halt: here.inner as ExprStmt, call, exit: stmts[h + 1], leaves: 0, values: [],
      wide: h + 2 !== stmts.length,
    };
    // `line = A; if (c) {..}` right in front of the halt: thread the pair as one block.
    const pair = prevInner === prev && !(prev as IfStmt).elseBranch && prev.kind === NodeKind.IfStmt && h >= 2;
    let from = h - 1;
    let r: Statement[] | null;
    if (pair) {
      from = h - 2;
      const t = threadHalt(Stmt.compound([stmts[h - 2], prev]), ctx);
      r = t && t.length === 1 && t[0].kind === NodeKind.CompoundStmt ? [...(t[0] as CompoundStmt).statements] : null;
    } else {
      r = threadHalt(prev, ctx);
    }
    if (!r || ctx.leaves === 0 || ctx.leaves > MAX_JOIN_LEAVES) continue;
    if (ctx.wide) {
      if (ctx.values.some(v => v === null)) continue;
      if (pushed && ctx.values.some(v => !pushed.has(v as number))) continue;
      // Every mention of the line is a leaf, the halt or a bare declaration.
      let decls = 0;
      for (const n of traverseAST(body)) {
        if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === line) {
          if ((n as VariableDecl).initializer) { decls = -1; break; }
          decls++;
        }
      }
      if (decls < 0 || countIdent([body], line) !== ctx.leaves + 1 + decls) continue;
    }
    return { stmts: [...stmts.slice(0, from), ...r, ...stmts.slice(h + 2)], leaves: ctx.leaves, line };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape 0: give every way into a shared halt the line its own PUSH chose
// ---------------------------------------------------------------------------
//
// MSVC tail-merges a function's assertions: each failing branch pushes its own line and
// jumps to one shared `call GetInstructionPointer`, and the branches may arrive there at
// different stack depths. The decompiler reads the line at one depth for all of them, so a
// way that arrives one slot off prints whatever sits in that slot: a CALL's return address
// (`nErrorLine = 0x598e36;`), a parameter, an unrelated local. The instructions say which
// line each way pushed; this step gives each way the halt it was written as,
// `Halt("", GetInstructionPointer(), LINE); exit(-1);`, where the printed value is wrong,
// and leaves every way that already carries one of the pushed lines alone. The shapes
// below then fold and dissolve the tail as usual.
//
// A way is matched to a pushed line only when that is forced: the ways the decompile
// prints must be exactly as many as the instructions have, the lines already printed
// must all be pushed lines, and what is left must pair up one to one - a single way and a
// single line, or each way under an `if` whose conditional branch is the one that selects
// a pushed line. Anything else leaves the function as printed and says why.

/** `e` without the casts and parentheses around it. */
function bareCall(e: Expression | null): Expression | null {
  let cur = e;
  while (cur && (cur.kind === NodeKind.ParenExpr || cur.kind === NodeKind.CStyleCastExpr)) {
    cur = cur.kind === NodeKind.ParenExpr
      ? (cur as ParenExpr).expression
      : (cur as CStyleCastExpr).expression;
  }
  return cur;
}

/** The integer a literal argument holds, through casts and parentheses. */
function constValue(e: Expression): number | null {
  let cur = e;
  while (cur.kind === NodeKind.ParenExpr || cur.kind === NodeKind.CStyleCastExpr) {
    cur = cur.kind === NodeKind.ParenExpr
      ? (cur as ParenExpr).expression
      : (cur as CStyleCastExpr).expression;
  }
  if (cur.kind === NodeKind.IntegerLiteral) return Number((cur as IntegerLiteralExpr).value);
  return null;
}

const MAX_REPAIR_ENTRIES = 32;

type Way =
  /** a `goto` to the tail; `def` is the definition of the line right before it */
  | { kind: 'goto'; stmt: Statement; def: Statement | null; value: number | null; guard: IfStmt | null; parts?: Expression[] }
  /** control falls into the tail from the start of its block */
  | { kind: 'before'; stmt: Statement; value: number | null; guard: IfStmt | null; parts?: Expression[] }
  /** control leaves `stmt` and reaches the tail; `def` when `stmt` defines the line */
  | { kind: 'after'; stmt: Statement; def: boolean; value: number | null }
  /** the false side of an `if` without an else reaches the tail */
  | { kind: 'else'; stmt: IfStmt; value: number | null; parts?: Expression[] }
  /** another printed copy of the halt; `def` the definition of its line right before it */
  | { kind: 'copy'; stmt: Statement; def: Statement | null; value: number | null };

interface HaltPrint {
  /** The block holding it, and its index there (the halt statement, labels included). */
  list: readonly Statement[];
  owner: CompoundStmt;
  index: number;
  call: CallExpr;
  halt: ExprStmt;
  exit: Statement;
}

/** Statement-valued fields a statement node can hold. */
const STMT_FIELDS = ['statements', 'thenBranch', 'elseBranch', 'body', 'statement', 'init'] as const;

function isStatementNode(v: unknown): v is Statement {
  return !!v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string'
    && ((v as ASTNode).kind as string).endsWith('Stmt');
}

/** Visit every statement under `root`, with the statement it sits in. */
function walkStatements(root: Statement, visit: (s: Statement, parent: Statement | null) => void): void {
  const go = (s: Statement, parent: Statement | null): void => {
    visit(s, parent);
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      if (Array.isArray(v)) { for (const c of v) if (isStatementNode(c)) go(c, s); }
      else if (isStatementNode(v)) go(v, s);
    }
  };
  go(root, null);
}

/**
 * Rebuild `root` with each statement in `replace` swapped for its sequence (spliced into a
 * block, wrapped in one where the statement stands alone) and each `if` in `addElse` given
 * that else branch. Identity-keyed: the maps hold nodes of `root` itself.
 */
function rebuildStatements(
  root: Statement,
  replace: ReadonlyMap<Statement, Statement[]>,
  addElse: ReadonlyMap<IfStmt, Statement[]>,
): Statement {
  // A replacement may hold statements of `root` (the one it replaces, or ones it moves):
  // those are rebuilt too.
  const expand = (s: Statement): Statement[] => {
    const r = replace.get(s);
    return r ? r.flatMap(x => (x === s ? [inner(s)] : expand(x))) : [inner(s)];
  };
  const one = (s: Statement): Statement => {
    const parts = expand(s);
    return parts.length === 1 ? parts[0] : Stmt.compound(parts);
  };
  const inner = (s: Statement): Statement => {
    let changed = false;
    const patch: Record<string, unknown> = {};
    for (const f of STMT_FIELDS) {
      const v = (s as unknown as Record<string, unknown>)[f];
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        let c = false;
        for (const x of v) {
          if (!isStatementNode(x)) { out.push(x); continue; }
          const ys = expand(x);
          if (ys.length !== 1 || ys[0] !== x) c = true;
          out.push(...ys);
        }
        if (c) { patch[f] = out; changed = true; }
      } else if (isStatementNode(v)) {
        const y = one(v);
        if (y !== v) { patch[f] = y; changed = true; }
      }
    }
    if (s.kind === NodeKind.IfStmt && addElse.has(s as IfStmt)) {
      patch.elseBranch = Stmt.compound(addElse.get(s as IfStmt)!);
      changed = true;
    }
    return changed ? updateNode(s, patch as Partial<Statement>) : s;
  };
  return one(root);
}

/** The operands of a chain of `op` at the top of `e`, left to right, through parentheses. */
function operands(e: Expression, op: '&&' | '||'): Expression[] {
  let cur = e;
  while (cur.kind === NodeKind.ParenExpr) cur = (cur as ParenExpr).expression;
  if (cur.kind === NodeKind.BinaryExpr && (cur as BinaryExpr).operator === op) {
    return [...operands((cur as BinaryExpr).left, op), ...operands((cur as BinaryExpr).right, op)];
  }
  return [e];
}

/** A declaration in `s` (not nested deeper) of a name `body` declares more than once. */
function declaresElsewhere(body: CompoundStmt, s: Statement): boolean {
  if (s.kind !== NodeKind.DeclStmt) return false;
  for (const d of (s as DeclStmt).declarations) {
    if (d.kind !== NodeKind.VariableDecl) return true;
    let n = 0;
    for (const x of traverseAST(body)) {
      if (x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === (d as VariableDecl).name.name) n++;
    }
    if (n > 1) return true;
  }
  return false;
}

/**
 * Give each way into the function's shared halt the line the instructions pushed on it.
 * Null when nothing changed; `report` hears what was done or refused.
 */
function repairHaltLines(
  body: CompoundStmt,
  sites: readonly HaltLineSite[],
  ifs: ReadonlyMap<number, number> | undefined,
  report: ((e: HaltLineRepairEvent) => void) | undefined,
  operandBranches?: ReadonlyMap<number, number[][]>,
): { body: CompoundStmt; repaired: string[] } | null {
  // One halt CALL in the function, so every printed halt is a copy of it.
  if (sites.length !== 1 || sites[0].paths.length < 2) return null;
  const site = sites[0];
  const refuse = (why: string): null => { report?.({ entries: 0, lines: [], refused: why }); return null; };
  if (site.paths.some(p => p.line === null)) return refuse('a way into the halt pushes no immediate line');

  // Every printed halt, with the block it sits in.
  const parents = new Map<Statement, Statement | null>();
  const prints: HaltPrint[] = [];
  walkStatements(body, (s, parent) => {
    parents.set(s, parent);
    if (s.kind !== NodeKind.CompoundStmt) return;
    const list = (s as CompoundStmt).statements;
    for (let i = 0; i + 1 < list.length; i++) {
      const p = peel(list[i]);
      const call = haltCall(p.inner);
      if (call && isExitStmt(list[i + 1])) {
        prints.push({ list, owner: s as CompoundStmt, index: i, call, halt: p.inner as ExprStmt, exit: list[i + 1] });
      }
    }
  });
  if (prints.length === 0) return null;

  // Each printed halt with the definitions right before it that feed it: the instruction
  // pointer's and the line's (`nLine = 0x1ef; nAddress = GetInstructionPointer(); Halt(..)`).
  interface Run { print: HaltPrint; start: number; lineDef: Statement | null; value: number | null; open: boolean; ip: Expression | null; ways: Way[] }
  const runOf = (p: HaltPrint): Run | null => {
    const ipName = argIdent(p.call.arguments[1]);
    const lineName = argIdent(p.call.arguments[2]);
    let ip: Expression | null = isIpCall(p.call.arguments[1]) ? p.call.arguments[1] : null;
    let lineDef: Statement | null = null;
    let lineRhs: Expression | null = null;
    let start = p.index;
    // A plain store to another local may sit in between (the compiler interleaves them).
    for (let j = p.index - 1, skipped = 0; j >= 0 && (ip === null || (lineName !== null && lineDef === null)); j--) {
      const d = asDef(p.list[j]);
      if (!d) break;
      if (ip === null && d.name === ipName && isIpCall(d.rhs)) ip = d.rhs;
      else if (lineDef === null && lineName !== null && d.name === lineName && !carriesComment(d.stmt)) { lineDef = p.list[j]; lineRhs = d.rhs; }
      else if (!d.isDecl && d.name !== ipName && d.name !== lineName && !mayHaveSideEffects(d.rhs) && ++skipped <= 4) { /* step over */ }
      else break;
      start = j;
    }
    for (let j = start + 1; j <= p.index; j++) if (peel(p.list[j]).labels.length > 0) return null;
    const value = lineRhs !== null ? constValue(lineRhs) : constValue(p.call.arguments[2]);
    return { print: p, start, lineDef, value, open: lineRhs === null && value === null, ip, ways: [] };
  };
  const runs: Run[] = [];
  for (const p of prints) {
    const r = runOf(p);
    if (!r) return refuse('a label inside a halt');
    runs.push(r);
  }

  // A tail several ways meet in is a copy whose line comes from further up, or one a jump
  // reaches. Every other copy is a way of its own, and its line claims a pushed line.
  const jumpedTo = (r: Run): boolean => peel(r.print.list[r.start]).labels.length > 0;
  const tails = runs.filter(r => r.open || jumpedTo(r));
  const ways: Way[] = runs
    .filter(r => !tails.includes(r))
    .map(r => ({ kind: 'copy', stmt: r.print.list[r.print.index], def: r.lineDef, value: r.value }));
  // The bare call: a cast the decompiler put on a temporary's definition (`nIp = (int32_t)
  // GetInstructionPointer()`) belongs to the temporary, not to the halt's parameter.
  const ipCall: Expression | null = bareCall(runs.find(r => r.ip !== null)?.ip ?? null);
  if (!ipCall) return refuse('no instruction pointer to copy');

  const lineVars: string[] = [];
  for (const tailRun of tails) {
    const tail = tailRun.print;
    const before = ways.length;
    const lineArg = tail.call.arguments[2];
    const lineVar = argIdent(lineArg);
    if (lineVar !== null) lineVars.push(lineVar);
    const fixed = tailRun.value;
    const list = tail.list;
    const k = tailRun.start;
    const labels = new Set(peel(list[k]).labels.map(l => l.label.name));
    const defValue = (s: Statement | undefined): { stmt: Statement; value: number | null } | null => {
      if (!s || lineVar === null) return null;
      const dd = asDef(s);
      if (!dd || dd.isDecl || dd.name !== lineVar || dd.labels.length > 0 || carriesComment(dd.stmt)) return null;
      return { stmt: s, value: constValue(dd.rhs) };
    };
    const ifOf = (s: Statement): IfStmt | null => {
      let p = parents.get(s) ?? null;
      if (p && p.kind === NodeKind.CompoundStmt) {
        const c = p as CompoundStmt;
        if (c.statements[0] !== s && !(c.statements.length >= 2 && defValue(c.statements[0]) && c.statements[1] === s)) return null;
        p = parents.get(p) ?? null;
      }
      return p && p.kind === NodeKind.IfStmt ? p as IfStmt : null;
    };

    // `if (A || B) { <the way> }` with nothing else in the branch: the compiler gave each
    // operand its own jump, so each is a way of its own.
    const orParts = (guard: IfStmt | null, s: Statement): Expression[] | undefined => {
      if (!guard || guard.elseBranch || guard.init) return undefined;
      const t = guard.thenBranch;
      if (t !== s && !(t.kind === NodeKind.CompoundStmt && (t as CompoundStmt).statements[0] === s
          && (s.kind !== NodeKind.GotoStmt || (t as CompoundStmt).statements.length === 1))) return undefined;
      const parts = operands(guard.condition, '||');
      return parts.length > 1 ? parts : undefined;
    };

    // Jumps into the tail.
    let bad: string | null = null;
    walkStatements(body, s => {
      if (s.kind !== NodeKind.CompoundStmt && s.kind !== NodeKind.IfStmt) return;
      const visitList = (stmts: readonly Statement[]) => {
        stmts.forEach((g, i) => {
          const p = peel(g);
          if (p.inner.kind !== NodeKind.GotoStmt || !labels.has((p.inner as GotoStmt).label.name)) return;
          if (p.labels.length > 0) { bad = 'a labelled jump into the halt'; return; }
          const dv = i > 0 ? defValue(stmts[i - 1]) : null;
          const guard = ifOf(g);
          ways.push({ kind: 'goto', stmt: g, def: dv?.stmt ?? null, value: dv ? dv.value : fixed, guard, parts: dv ? undefined : orParts(guard, g) });
        });
      };
      if (s.kind === NodeKind.CompoundStmt) visitList((s as CompoundStmt).statements);
      else for (const b of [(s as IfStmt).thenBranch, (s as IfStmt).elseBranch]) {
        if (b && b.kind === NodeKind.GotoStmt && labels.has((b as GotoStmt).label.name)) {
          ways.push({ kind: 'goto', stmt: b, def: null, value: fixed, guard: s as IfStmt, parts: orParts(s as IfStmt, b) });
        }
      }
    });
    if (bad) return refuse(bad);

    // Falling into the tail: thread through the statement before it.
    const thread = (s: Statement): boolean => {
      if (ways.length > MAX_REPAIR_ENTRIES) return false;
      const inner = peel(s).inner;
      if (terminates(inner) || inner.kind === NodeKind.BreakStmt || inner.kind === NodeKind.ContinueStmt) return true;
      const dv = defValue(inner);
      if (dv) { ways.push({ kind: 'after', stmt: s, def: true, value: dv.value }); return true; }
      if (inner.kind === NodeKind.IfStmt) {
        const i = inner as IfStmt;
        if (i.init) return false;
        if (!thread(i.thenBranch)) return false;
        if (i.elseBranch) return thread(i.elseBranch);
        const parts = operands(i.condition, '&&');
        ways.push({ kind: 'else', stmt: i, value: fixed, parts: parts.length > 1 ? parts : undefined });
        return true;
      }
      if (inner.kind === NodeKind.CompoundStmt) {
        const c = inner as CompoundStmt;
        if (c.statements.length === 0) return false;
        return thread(c.statements[c.statements.length - 1]);
      }
      ways.push({ kind: 'after', stmt: s, def: false, value: fixed });
      return true;
    };
    if (k === 0) {
      const guard = ifOf(list[0]);
      ways.push({ kind: 'before', stmt: list[0], value: fixed, guard, parts: orParts(guard, list[0]) });
    }
    else if (!thread(list[k - 1])) return refuse('cannot follow the way that falls into the halt');
    if (ways.length > MAX_REPAIR_ENTRIES) return refuse('too many ways into the halt');
    tailRun.ways = ways.slice(before);
  }

  // Pair the ways with the pushed lines. A way split over the operands of its condition
  // takes one line per operand.
  const weight = (w: Way): number => ('parts' in w && w.parts ? w.parts.length : 1);
  const total = ways.reduce((n, w) => n + weight(w), 0);
  if (total !== site.paths.length) {
    return refuse(`${total} printed way${total === 1 ? '' : 's'} for ${site.paths.length} pushed lines`);
  }
  const left = [...site.paths];
  const wrong: Way[] = [];
  for (const w of ways) {
    const at = w.value === null ? -1 : left.findIndex(p => p.line === w.value);
    if (at >= 0 && weight(w) === 1) left.splice(at, 1);
    else wrong.push(w);
  }
  if (wrong.length === 0) return null;
  if (wrong.reduce((n, w) => n + weight(w), 0) !== left.length) return refuse('the printed lines are not a subset of the pushed lines');

  const assign = new Map<Way, number[]>();
  // The `if`s of each decompile line, outermost first. One `if` of a short-circuit line
  // that was split into nested ones (`if (A && (s, B))` -> `if (A) { s; if (B) .. }`)
  // stands for one operand of the chain: the k-th of the line, when each nests in the
  // one before and there are as many as the chain has operands.
  const ifsOnLine = new Map<number, IfStmt[]>();
  walkStatements(body, s => {
    if (s.kind === NodeKind.IfStmt && s.location && s.location.start.line > 0) {
      const l = s.location.start.line;
      ifsOnLine.set(l, [...(ifsOnLine.get(l) ?? []), s as IfStmt]);
    }
  });
  const nestsIn = (inner: IfStmt, outer: IfStmt): boolean => {
    for (let p = parents.get(inner) ?? null; p; p = parents.get(p) ?? null) {
      if (p === outer) return p.kind === NodeKind.IfStmt;
    }
    return false;
  };
  /** The conditional branches that leave `i` for its false side. */
  const cbranches = (i: IfStmt | null): number[] | null => {
    if (!i || !ifs || !i.location) return null;
    const line = i.location.start.line;
    const all = ifsOnLine.get(line) ?? [];
    if (all.length === 1) {
      const b = ifs.get(line);
      return b === undefined ? null : [b];
    }
    const segs = operandBranches?.get(line);
    if (!segs || segs.length !== all.length) return null;
    for (let k = 1; k < all.length; k++) if (!nestsIn(all[k], all[k - 1])) return null;
    const k = all.indexOf(i);
    return k < 0 ? null : segs[k];
  };
  const split = wrong.filter(w => weight(w) > 1);
  const single = wrong.filter(w => weight(w) === 1);
  if (split.length > 1) return refuse('several split ways with a wrong line');
  if (split.length === 0 && new Set(left.map(p => p.line)).size === 1) {
    for (const w of wrong) assign.set(w, [left[0].line as number]);
  } else if (split.length === 0 && single.length === 1) {
    assign.set(single[0], [left[0].line as number]);
  } else {
    // Each single way under an `if` whose conditional branch selects exactly one leftover
    // line; a split way takes what is left.
    const pool = [...left];
    for (const w of single) {
      const g = cbranches(w.kind === 'goto' || w.kind === 'before' ? w.guard : w.kind === 'else' ? w.stmt : null);
      const hit = g === null ? [] : pool.filter(p => p.guard !== null && g.includes(p.guard));
      if (hit.length !== 1) return refuse(`${wrong.length} ways with a wrong line and no branch that tells them apart`);
      assign.set(w, [hit[0].line as number]);
      pool.splice(pool.indexOf(hit[0]), 1);
    }
    if (split.length === 1) {
      // The operands take the rest in operand order: each operand's test and jump come
      // before the next one's, so their branches ascend.
      if (pool.length !== weight(split[0])) return refuse('the split way does not take what is left');
      if (pool.some(p => p.guard === null) || new Set(pool.map(p => p.guard)).size !== pool.length) {
        return refuse('the operands of a split way have no branches to order them by');
      }
      assign.set(split[0], [...pool].sort((a, b) => (a.guard as number) - (b.guard as number)).map(p => p.line as number));
    } else if (pool.length !== 0) {
      return refuse('the branches do not pair the ways with the leftover lines');
    }
  }

  // Rewrite.
  const model = prints[0];
  // A definition `v = rhs;` or `T v = rhs;` with another right-hand side, labels kept.
  const withRhs = (stmt: Statement, rhs: Expression): Statement => {
    const p = peel(stmt);
    if (p.inner.kind === NodeKind.ExprStmt) {
      const a = (p.inner as ExprStmt).expression as AssignExpr;
      return relabel(p.labels, updateNode(p.inner as ExprStmt, { expression: updateNode(a, { right: rhs } as Partial<AssignExpr>) } as Partial<ExprStmt>));
    }
    const d = p.inner as DeclStmt;
    const v = d.declarations[0] as VariableDecl;
    return relabel(p.labels, updateNode(d, { declarations: [updateNode(v, { initializer: rhs } as Partial<VariableDecl>)] } as Partial<DeclStmt>));
  };
  const copyWith = (line: number, at: Statement | undefined): Statement[] => {
    const call = updateNode(model.call, {
      arguments: [model.call.arguments[0], ipCall as Expression, Expr.intLiteral(line, 16)],
    } as Partial<CallExpr>);
    // A node of its own: the rewrite below keys statements by identity.
    return [placedAt(updateNode(model.halt, { expression: call } as Partial<ExprStmt>), at), { ...model.exit }];
  };
  const replace = new Map<Statement, Statement[]>();
  const addElse = new Map<IfStmt, Statement[]>();
  const put = (k: Statement, v: Statement[]): boolean => {
    if (replace.has(k)) return false;
    replace.set(k, v);
    return true;
  };
  // `if (p1) {halt l1} .. if (pn) <last>`: the split of `guard`, each operand its own halt.
  const splitIf = (guard: IfStmt, parts: Expression[], lines: number[], last: Statement): Statement[] => {
    const out: Statement[] = [];
    parts.forEach((cond, i) => {
      const then = i === parts.length - 1 ? last : Stmt.compound(copyWith(lines[i], guard));
      const keep = i === 0 ? {} : { leadingTrivia: [], trailingTrivia: [] };
      out.push(updateNode(guard, { condition: cond, thenBranch: then, elseBranch: null, ...keep } as Partial<IfStmt>));
    });
    return out;
  };
  let clash = false;
  for (const [w, lines] of assign) {
    const line = lines[0];
    switch (w.kind) {
      case 'copy': {
        if (w.def) {
          clash ||= !put(w.def, [withRhs(w.def, Expr.intLiteral(line, 16))]);
          break;
        }
        const p = peel(w.stmt);
        const call = haltCall(p.inner)!;
        const fixedCall = updateNode(call, {
          arguments: [call.arguments[0], call.arguments[1], Expr.intLiteral(line, 16)],
        } as Partial<CallExpr>);
        clash ||= !put(w.stmt, [relabel(p.labels, updateNode(p.inner as ExprStmt, { expression: fixedCall } as Partial<ExprStmt>))]);
        break;
      }
      case 'goto':
        if (w.parts && w.guard) {
          const last = Stmt.compound(copyWith(lines[lines.length - 1], w.stmt));
          clash ||= !put(w.guard, splitIf(w.guard, w.parts, lines, last));
          break;
        }
        if (w.def) clash ||= !put(w.def, []);
        clash ||= !put(w.stmt, copyWith(line, w.def ?? w.stmt));
        break;
      case 'before':
        if (w.parts && w.guard) {
          const t = w.guard.thenBranch;
          const rest = t.kind === NodeKind.CompoundStmt ? [...(t as CompoundStmt).statements] : [t];
          const last = updateNode(t.kind === NodeKind.CompoundStmt ? t as CompoundStmt : Stmt.compound([t]),
            { statements: [...copyWith(lines[lines.length - 1], w.stmt), ...rest] } as Partial<CompoundStmt>);
          clash ||= !put(w.guard, splitIf(w.guard, w.parts, lines, last));
          break;
        }
        clash ||= !put(w.stmt, [...copyWith(line, w.stmt), w.stmt]);
        break;
      case 'after': {
        if (!w.def) { clash ||= !put(w.stmt, [w.stmt, ...copyWith(line, w.stmt)]); break; }
        // The definition gives way to the halt; a jump that landed on it lands on the halt.
        const [h, x] = copyWith(line, w.stmt);
        clash ||= !put(w.stmt, [relabel(peel(w.stmt).labels, h), x]);
        break;
      }
      case 'else':
        if (w.parts) {
          // `if (A && B) T` falling into the halt: each operand that fails halts with its
          // own line, then T runs where the condition held.
          const t = w.stmt.thenBranch;
          const rest = t.kind === NodeKind.CompoundStmt ? [...(t as CompoundStmt).statements] : [t];
          if (rest.some(r => declaresElsewhere(body, r))) return refuse('the branch declares a name the function declares again');
          const halts = w.parts.map((cond, i) => updateNode(w.stmt, {
            condition: negateCondition(cond), thenBranch: Stmt.compound(copyWith(lines[i], w.stmt)), elseBranch: null,
            ...(i === 0 ? {} : { leadingTrivia: [], trailingTrivia: [] }),
          } as Partial<IfStmt>));
          clash ||= !put(w.stmt, [...halts, ...rest]);
          break;
        }
        // The test falls into the shared halt: no jump or definition of its own to stand at,
        // and the if's own line holds the test. The copy keeps the halt's lines.
        addElse.set(w.stmt, copyWith(line, undefined));
        break;
    }
  }
  if (clash) return refuse('two ways rewrite the same statement');

  // A tail every way of which now has its own halt is dead: it goes, with the definitions
  // that fed it.
  for (const t of tails) {
    if (!t.ways.every(w => assign.has(w))) continue;
    const p = t.print;
    for (let j = t.start; j <= p.index + 1; j++) {
      const st = p.list[j];
      const r = replace.get(st);
      replace.set(st, r ? r.filter(x => x !== st) : []);
    }
  }
  report?.({ entries: [...assign.values()].reduce((n, l) => n + l.length, 0), lines: [...assign.values()].flat() });
  return {
    body: rebuildStatements(body, replace, addElse) as CompoundStmt,
    repaired: lineVars,
  };
}

/**
 * Remove the stores of literals to `names` that nothing reads any more: after the repair,
 * the value a wrong way carried has no reader. A variable nothing reads at all loses its
 * declaration too.
 */
function dropDeadConstStores(body: CompoundStmt, names: ReadonlySet<string>): CompoundStmt {
  const replace = new Map<Statement, Statement[]>();
  for (const name of names) {
    walkStatements(body, (block) => {
      if (block.kind !== NodeKind.CompoundStmt) return;
      (block as CompoundStmt).statements.forEach((s, i) => {
        if (carriesComment(s)) return;
        if (s.kind === NodeKind.ExprStmt) {
          const e = (s as ExprStmt).expression;
          if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '='
              || (e as AssignExpr).left.kind !== NodeKind.Identifier
              || ((e as AssignExpr).left as Identifier).name !== name
              || constValue((e as AssignExpr).right) === null) return;
          if (storeIsDead(body, block as CompoundStmt, i, name)) replace.set(s, []);
        } else if (s.kind === NodeKind.DeclStmt) {
          const d = s as DeclStmt;
          if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return;
          const v = d.declarations[0] as VariableDecl;
          if (v.name.name !== name || !v.initializer || v.initializer.kind === NodeKind.InitListExpr
              || constValue(v.initializer as Expression) === null) return;
          if (storeIsDead(body, block as CompoundStmt, i, name)) {
            replace.set(s, [updateNode(d, { declarations: [updateNode(v, { initializer: undefined } as Partial<VariableDecl>)] } as Partial<DeclStmt>)]);
          }
        }
      });
    });
  }
  const out = replace.size > 0 ? rebuildStatements(body, replace, new Map()) as CompoundStmt : body;
  return dropDeadDecls(out, names);
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

export function foldHaltSites_forTest(
  fn: FunctionDecl,
  options: HaltSiteFoldOptions = {},
): { fn: FunctionDecl; stats: HaltSiteFoldStats } {
  const stats: HaltSiteFoldStats = { folded: 0, tailsInlined: 0, gotosReplaced: 0, joined: 0, joinLeaves: 0, linesRepaired: 0 };
  const out = rewriteFunction(fn, stats, options);
  return { fn: out ?? fn, stats };
}

function rewriteFunction(node: FunctionDecl, stats: HaltSiteFoldStats, options: HaltSiteFoldOptions = {}): FunctionDecl | undefined {
  if (!node.body) return undefined;
  let body: CompoundStmt = node.body;
  const touched = new Set<string>();

  // 0. every way into a shared halt gets the line its own PUSH chose
  const repairedVars = new Set<string>();
  if (options.haltLines) {
    const r = repairHaltLines(body, options.haltLines, options.branchLayout?.ifs, (e) => {
      if (!e.refused) stats.linesRepaired += e.entries;
      options.onRepair?.(e);
    }, options.branchLayout?.operands);
    if (r) {
      body = r.body;
      for (const v of r.repaired) repairedVars.add(v);
    }
  }

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
  const pushed = pushedLines(options.haltLines);
  const joinFrom = body;
  const join = createTransformer({
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = joinHalt(block.statements, joinFrom, pushed);
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
    // Reported so the census can see how much of the shared-halt unfolding is still left
    // to this late, unvalidated pass rather than done (and proven) in goto-cleanup.
    if (counter.n) gotoReport({ event: 'halt-shared-tail', gotos: counter.n, labels: [...plans.keys()] });

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
  if (repairedVars.size > 0) body = dropDeadConstStores(body, repairedVars);
  if (stats.folded === 0 && stats.gotosReplaced === 0 && stats.joined === 0 && stats.linesRepaired === 0) return undefined;
  return updateNode(node, { body } as Partial<FunctionDecl>);
}

function createHaltSiteFoldTransformer(options: HaltSiteFoldOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, { folded: 0, tailsInlined: 0, gotosReplaced: 0, joined: 0, joinLeaves: 0, linesRepaired: 0 }, options);
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

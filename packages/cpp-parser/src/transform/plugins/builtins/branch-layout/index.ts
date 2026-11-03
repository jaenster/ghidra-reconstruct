/**
 * Branch Layout Plugin
 *
 * VC8 /O2 lays an `if` out by its source shape (benched with the oracle's compiler, and
 * checked against 1640 if-sites of functions that already match byte for byte, 99.2%
 * agreeing):
 *
 *   if (c) T else E          c simple or `&&`     tests, T, E
 *   if (a || b) T else E                          tests, E, T
 *   if (c) T; R              T falls through      T inline
 *   if (c) T; R              T leaves, c simple or `&&`, outside a loop: T inline
 *                            the same inside a loop: T out of line, after the loop body
 *   if (a || b) T; R         T leaves             T out of line, after R
 *
 * So the arm the source wrote first is fixed by the layout, and the decompile (or one of
 * our own passes) can print the other arm first while meaning the same thing. Where the
 * original's addresses (evidence.ts) contradict the model for the form we print, this
 * rewrites the form to the one the layout implies:
 *
 *   swap      `if (c) A else B`, c simple, B first: `if (!c) B else A`. When B is an
 *             assertion halt (`...; Halt(...); exit(-1);`) outside a loop, the else is
 *             dropped: `if (!c) { Halt; exit; } A` is the sequential assertion. An `&&` or
 *             `||` condition is left: De Morgan does not change the control flow, so it
 *             cannot change the layout. An arm that is only `return;` has no code of its
 *             own and gives no evidence.
 *   nest      `if (c) X; Y...`, c simple, outside a loop, X leaves, Y... is the rest of
 *             the block and ends leaving, Y first: `if (!c) { Y... } X`. Both directions
 *             of guard <-> nest are this one rewrite.
 *   split     `if (a && b) X; T...`, outside a loop, X leaves, T... is the rest of the
 *             block, short leaving code, laid out between the two tests (the source
 *             wrote the failure tail once per test and VC8 merged the copies):
 *             `if (!a) T; if (!b) T; X`.
 *
 * The end of a void function's body is its return: a rest there that runs off the end
 * leaves too. Moved into a block ahead of X, it gets the `return;` it ran into, so control
 * still never reaches X after it: `if (c) X; Y;` at the end of a void function becomes
 * `if (!c) { Y; return; } X`.
 *   or-guard  `if (a || b || ...) T; rest...` (or `!(x && y && ...)`), T short leaving
 *             code, laid out elsewhere than after the rest. The per-operand branch facts
 *             say which test T follows: after the first, one guard per test; after the
 *             second of `P && P->f == K && ...`, the getter compared once,
 *             `(P ? P->f : D) != K`, then one guard per further test; after the last, the
 *             getter `!(P ? x : 0)` or `(P ? P->f : D) != K`. D is the field's null
 *             default from the original's own getters; without one that keeps the value,
 *             the condition stays as printed. Where T is a return the original merged
 *             into an earlier guard's copy, one guard per test.
 *
 * Every arm keeps its statements; a negated condition is exact: a `!` is dropped, `==`/`!=`
 * flipped, a relational operator flipped only against an integer literal (a floating-point
 * compare is never printed against one), anything else wrapped in `!(...)`. A block that
 * declares names keeps its braces. A rewrite that moves code around a label something jumps
 * to, or around a case label of an enclosing switch, is not made. An arm without evidence
 * (no code of its own, a copied line, a statement a pass built) leaves the if as it is.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, ExprStmt, IfStmt, LabelStmt, GotoStmt, Statement, Expression,
  CallExpr, UnaryExpr, BinaryExpr, ParenExpr, ReturnStmt, CStyleCastExpr, FunctionDecl, IntegerLiteralExpr,
  DeclStmt, VariableDecl, Identifier, AnyNode, TypeNode,
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { sameExpr } from '../rotated-for-loop.js';
import { traverseAST, getChildren } from '../../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../../transformer.js';
import { Stmt, Expr } from '../../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../../types.js';
import { constantValue, fieldRead, nullTest, pointeeName, type NullGetterTable } from '../null-getter.js';
import { localTypesOf } from '../compare-form.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../goto-cleanup/types.js';
import { holdsFreeCase } from '../goto-cleanup/paths.js';
import { leaves, isHaltStmt, isExitStmt, negateCondition } from '../assert-order.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './evidence.js';
import { scoreBody, type LayoutScore } from './predict.js';
import { layoutSearch, isVoidFunction } from './search.js';
import { appendFileSync } from 'node:fs';

export type { BranchLayoutEvidence } from './evidence.js';
export { LayoutReader } from './evidence.js';

export interface BranchLayoutOptions extends PluginOptions {
  /** The original's addresses, keyed by line of the parsed text; absent: nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
  /** Further callees that never return, by unqualified name. */
  noreturnFunctions?: string[];
  /** Called once per rewrite and per site left for want of a source form. */
  onSite?: (e: { rule: 'swap' | 'nest' | 'split' | 'getter' | 'left' | 'return-merge' | 'propagate' | 'join'; line: number; why?: string }) => void;
  /**
   * The null default of each field read through a null-guarded getter (`null-getter.ts`),
   * keyed `<pointee type>|<member path>`; without it no getter comparison is written.
   */
  nullGetters?: NullGetterTable;
  /** Enumerator name -> value, to value the constant a getter is compared with. */
  enumValues?: Readonly<Record<string, number>>;
  /** The original's halts and their ways in (reconstruct extract/halt-lines.ts). */
  haltLines?: readonly HaltSite[];
  /** The function's entry, for the score log. */
  functionAddress?: string;
  /** Names of the enum types: an enumerator may be stored only into one of them. */
  enumTypes?: readonly string[];
}

/** A halt of the original and its ways in; the fallthrough way first (halt-site-fold.ts). */
export interface HaltSite {
  at: number;
  ip: number;
  paths: { line: number | null; guard: number | null }[];
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function branches(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.ConditionalExpr) return true;
    if (n.kind === NodeKind.BinaryExpr) {
      const op = (n as BinaryExpr).operator;
      if (op === '&&' || op === '||') return true;
    }
  }
  return false;
}

export type ConditionShape =
  | { kind: 'simple' }
  | { kind: 'and'; conjuncts: Expression[] | null }
  | { kind: 'or' }
  | { kind: 'other' };

/**
 * How a condition branches, by its top-level operator. `and` lists its conjuncts when it is
 * a plain `a && b && ...` of simple tests; `!(a || b)` and `a && (b || c)` are an `and`
 * without conjuncts. A ternary at the top, or anywhere in a simple-looking test, is `other`.
 */
export function conditionShape(cond: Expression): ConditionShape {
  let e = unwrapParens(cond);
  let negated = false;
  while (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!'
    && unwrapParens((e as UnaryExpr).operand).kind === NodeKind.BinaryExpr) {
    negated = !negated;
    e = unwrapParens((e as UnaryExpr).operand);
  }
  if (!branches(e)) return { kind: 'simple' };
  if (e.kind !== NodeKind.BinaryExpr) return { kind: 'other' };
  const op = (e as BinaryExpr).operator;
  if (op !== '&&' && op !== '||') return { kind: 'other' };
  const flat: Expression[] = [];
  const collect = (x: Expression): boolean => {
    const u = unwrapParens(x);
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === op) {
      return collect((u as BinaryExpr).left) && collect((u as BinaryExpr).right);
    }
    if (branches(u)) return false;
    flat.push(u);
    return true;
  };
  // The top-level operator decides the layout; a mixed chain has no plain conjuncts.
  const plain = collect(e);
  const isAnd = (op === '&&') !== negated;
  if (!isAnd) return { kind: 'or' };
  return { kind: 'and', conjuncts: negated || !plain ? null : flat };
}

const RELATIONAL_FLIP: Record<string, BinaryExpr['operator']> = { '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

function isIntegerLiteral(e: Expression): boolean {
  let u = unwrapParens(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') u = unwrapParens((u as UnaryExpr).operand);
  return u.kind === NodeKind.IntegerLiteral && typeof (u as IntegerLiteralExpr).value === 'bigint';
}

/** The exact negation of a condition. */
export function negate(e: Expression): Expression {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const flipped = RELATIONAL_FLIP[b.operator];
    if (flipped && (isIntegerLiteral(b.left) || isIntegerLiteral(b.right))) {
      return { ...b, operator: flipped, leadingTrivia: [], trailingTrivia: [] };
    }
  }
  return negateCondition(e);
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

export function declaredNames(stmts: readonly Statement[]): Set<string> {
  const out = new Set<string>();
  for (const s of stmts) {
    if (s.kind !== NodeKind.DeclStmt) continue;
    for (const d of (s as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl) out.add((d as VariableDecl).name.name);
      else out.add('\0');
    }
  }
  return out;
}

export function mentionsAny(roots: readonly ASTNode[], names: ReadonlySet<string>): boolean {
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.Identifier && names.has((n as Identifier).name)) return true;
    }
  }
  return false;
}

/**
 * `stmts`, the body of `original`, spliced into the enclosing block between `before` and
 * `after`. Braced when a name it declares is declared in `before` (a redeclaration) or
 * read in `after` (it would now see the inner one), or is not a plain variable.
 */
export function spliced(original: Statement, stmts: Statement[], before: readonly Statement[], after: readonly Statement[]): Statement[] {
  const names = declaredNames(stmts);
  if (names.size === 0) return stmts;
  const clash = names.has('\0') || mentionsAny(after, names)
    || [...declaredNames(before)].some(n => names.has(n));
  if (!clash) return stmts;
  return [original.kind === NodeKind.CompoundStmt ? original : Stmt.compound(stmts)];
}

export function asBlock(stmts: Statement[]): Statement {
  return stmts.length === 1 && stmts[0].kind === NodeKind.CompoundStmt ? stmts[0] : Stmt.compound(stmts);
}

export function jumpedLabels(roots: readonly ASTNode[], gotos: ReadonlyMap<string, number>): boolean {
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.LabelStmt && (gotos.get((n as LabelStmt).label.name) ?? 0) > 0) return true;
    }
  }
  return false;
}

export function gotoCounts(root: ASTNode): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.GotoStmt) {
      const l = (n as GotoStmt).label.name;
      m.set(l, (m.get(l) ?? 0) + 1);
    }
  }
  return m;
}

/** An operand a copied tail may evaluate twice: a name, a literal, an address of a name. */
function plainOperand(e: Expression): boolean {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId: case NodeKind.IntegerLiteral:
    case NodeKind.StringLiteral: case NodeKind.CharLiteral: case NodeKind.NullptrLiteral:
    case NodeKind.BoolLiteral:
      return true;
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      return (x.operator === '&' || x.operator === '-') && plainOperand(x.operand);
    }
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
      return plainOperand((u as CStyleCastExpr).expression);
    default:
      return false;
  }
}

/**
 * Short leaving code that may be written once per test: calls on plain operands, then a
 * plain return or a halt; with `fallsOff` (the end of a void function) the code may run off
 * the end instead.
 */
function copyableTail(stmts: readonly Statement[], noreturn: ReadonlySet<string>, fallsOff = false): boolean {
  if (stmts.length === 0 || stmts.length > 3) return false;
  for (const s of stmts) {
    if (s.kind === NodeKind.ReturnStmt) {
      const v = (s as ReturnStmt).value;
      if (v && !plainOperand(v)) return false;
      continue;
    }
    if (s.kind !== NodeKind.ExprStmt) return false;
    const e = (s as ExprStmt).expression;
    if (e.kind !== NodeKind.CallExpr || !(e as CallExpr).arguments.every(plainOperand)) return false;
  }
  return fallsOff || leaves(stmts[stmts.length - 1], noreturn);
}

/** `stmts` that run off the end of a void function, with the `return;` that end stands for. */
function withReturn(stmts: readonly Statement[], noreturn: ReadonlySet<string>): Statement[] {
  return stmts.length > 0 && leaves(stmts[stmts.length - 1], noreturn) ? [...stmts] : [...stmts, Stmt.return_()];
}

interface Ctx {
  reader: LayoutReader;
  noreturn: ReadonlySet<string>;
  gotos: ReadonlyMap<string, number>;
  /** Lines of the ifs that sit inside a loop. */
  loopIfs: ReadonlySet<number>;
  onSite?: BranchLayoutOptions['onSite'];
  nullGetters: NullGetterTable;
  enumValues: Readonly<Record<string, number>>;
  /** Declared type of each parameter and local of the function. */
  localTypes: ReadonlyMap<string, TypeNode>;
  /** The ifs (`line:column`) the whole-function search settled: left as they are. */
  fixed: ReadonlySet<string>;
}

function positionOf(s: Statement): string {
  return `${s.location?.start.line ?? 0}:${s.location?.start.column ?? 0}`;
}

function lineOf(s: Statement): number {
  return s.location?.start.line ?? 0;
}

/** Only `return;`: no code of its own, a jump to the shared epilogue. */
function bareReturn(s: Statement): boolean {
  const l = bodyOf(s);
  return l.length === 1 && l[0].kind === NodeKind.ReturnStmt && !(l[0] as ReturnStmt).value;
}

/** The arm's entry, null for an arm without code of its own. */
function armEntry(s: Statement, cb: number, ctx: Ctx): number | null {
  return bareReturn(s) ? null : ctx.reader.entry([s], cb);
}

/**
 * Where the original's one copy of an arm that is only `return v;` (v a constant or a
 * name) lies, when the passes copied that return to several paths or the decompile printed
 * it more than once: the arm's lines then give no evidence of their own (see `entry`), but
 * the return facts place the merged copy. Null for any other arm.
 */
function sharedReturn(s: Statement, ctx: Ctx): number | null {
  const l = bodyOf(s);
  if (l.length !== 1 || l[0].kind !== NodeKind.ReturnStmt) return null;
  const v = (l[0] as ReturnStmt).value;
  if (!v || !plainOperand(v)) return null;
  return ctx.reader.returnCopy(l[0] as ReturnStmt);
}

function endsInHalt(stmts: readonly Statement[]): boolean {
  return stmts.length >= 2 && isHaltStmt(stmts[stmts.length - 2]) && isExitStmt(stmts[stmts.length - 1]);
}

/**
 * `if (c) A else B`: with B first, `if (!c) B else A`. When B is an assertion halt and the
 * if sits in a statement list outside a loop, the else goes: `if (!c) { Halt; exit; } A`
 * is the sequential assertion. An if/else already in address order keeps its else: in
 * functions that match byte for byte both spellings occur.
 */
function swapAt(ifs: IfStmt, cb: number, ctx: Ctx, list: { before: Statement[]; after: Statement[] } | null): Statement[] | null {
  const shape = conditionShape(ifs.condition);
  const then = ifs.thenBranch, other = ifs.elseBranch!;
  const tE = armEntry(then, cb, ctx), eE = armEntry(other, cb, ctx);
  if (tE === null || eE === null || tE === eE) return null;
  const thenFirst = tE < eE;
  if (thenFirst === (shape.kind !== 'or')) return null;
  // In a loop VC8 sinks the stub of a halt it merged with others (`push line; jmp`) below
  // the loop exit, the stubs in the order their arms were written: the address of such an
  // arm (a pass copied the halt back into it) says nothing about which arm came first.
  const mergedHalt = (s: Statement) => { const l = bodyOf(s); return endsInHalt(l) && ctx.reader.copied(l[l.length - 1]); };
  if (ctx.loopIfs.has(lineOf(ifs)) && (mergedHalt(then) || mergedHalt(other))) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'if/else with a halt arm in a loop' });
    return null;
  }
  if (shape.kind !== 'simple') {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: `if/else arms reversed, ${shape.kind} condition` });
    return null;
  }
  ctx.onSite?.({ rule: 'swap', line: lineOf(ifs) });
  const cond = negate(ifs.condition), first = other, second = then;
  if (endsInHalt(bodyOf(first)) && list && !ctx.loopIfs.has(lineOf(ifs))) {
    const guard = updateNode(ifs, { condition: cond, thenBranch: asBlock([first]), elseBranch: null } as Partial<IfStmt>);
    return [guard, ...spliced(second, bodyOf(second), list.before, list.after)];
  }
  // An else-if moved into the then-arm is braced, or the old then-arm would bind to it.
  const thenArm = first.kind === NodeKind.IfStmt ? Stmt.compound([first]) : first;
  return [updateNode(ifs, { condition: cond, thenBranch: thenArm, elseBranch: second } as Partial<IfStmt>)];
}

/**
 * `if (c) X; rest...`: the replacement for stmts[i..], or null. `fallsOff`: the list ends
 * the body of a void function, so a rest that runs off its end leaves.
 */
function nestAt(stmts: readonly Statement[], i: number, cb: number, ctx: Ctx, fallsOff: boolean): Statement[] | null {
  const ifs = stmts[i] as IfStmt;
  const rest = stmts.slice(i + 1);
  if (rest.length === 0) return null;
  const then = ifs.thenBranch;
  if (!leaves(then, ctx.noreturn) || ctx.loopIfs.has(lineOf(ifs))) return null;
  const shape = conditionShape(ifs.condition);
  if (shape.kind === 'or') return orGuardAt(stmts, i, cb, ctx);
  if (shape.kind === 'other') return null;

  if (shape.kind === 'and') {
    const low = ctx.reader.conditionLow(ifs);
    if (low === null || low >= cb) return null;
    const tail = bareReturn(rest[0]) ? null : ctx.reader.entry([rest[0]], low);
    const xE = armEntry(then, cb, ctx);
    if (tail === null || xE === null || tail >= cb) return null;
    // The tail lies among the tests: the source wrote it once per test.
    const conj = shape.conjuncts;
    if (!conj || conj.length !== 2) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'shared tail among the tests, not a two-test `&&`' });
      return null;
    }
    if (!copyableTail(rest, ctx.noreturn, fallsOff)
      || jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'shared tail among the tests, tail not copyable' });
      return null;
    }
    const tailLeaves = leaves(rest[rest.length - 1], ctx.noreturn);
    ctx.onSite?.({ rule: 'split', line: lineOf(ifs), why: tailLeaves ? undefined : 'tail runs off the end of a void function' });
    const failing = withReturn(rest, ctx.noreturn);
    const first = updateNode(ifs, { condition: negate(conj[0]), thenBranch: Stmt.compound(failing), elseBranch: null } as Partial<IfStmt>);
    const copy = failing.map(s => ({ ...cloneNode(s), leadingTrivia: [] }) as Statement);
    ctx.reader.taint(rest);
    const second = Stmt.if_(negate(conj[1]), Stmt.compound(copy));
    return [first, second, ...spliced(then, bodyOf(then), stmts.slice(0, i), [])];
  }

  const xE = armEntry(then, cb, ctx), rE = armEntry(rest[0], cb, ctx);
  if (xE === null || rE === null || xE <= rE) return null;
  const restLeaves = leaves(rest[rest.length - 1], ctx.noreturn);
  if (!restLeaves && !fallsOff) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the rest, rest falls through' });
    return null;
  }
  if (jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the rest, a label in the way' });
    return null;
  }
  ctx.onSite?.({ rule: 'nest', line: lineOf(ifs), why: restLeaves ? undefined : 'rest runs off the end of a void function' });
  // The rest had not been visited yet: its own ifs are judged where they now sit. It now
  // ends in a leave of its own.
  const moved = withReturn(rest, ctx.noreturn);
  const inner = rewriteList(moved, ctx, false) ?? moved;
  const nested = updateNode(ifs, { condition: negate(ifs.condition), thenBranch: Stmt.compound(inner), elseBranch: null } as Partial<IfStmt>);
  return [nested, ...spliced(then, bodyOf(then), stmts.slice(0, i), [])];
}

/**
 * The operands of a guard condition that takes the arm, flattened over its one operator:
 * `a || b || c` gives the tests a, b, c (each takes the arm) and the conjuncts !a, !b, !c;
 * `!(x && y && z)` gives the tests !x, !y, !z and the conjuncts x, y, z. Null for anything
 * else.
 */
export function guardOperands(cond: Expression): { tests: Expression[]; conj: Expression[] } | null {
  let e = unwrapParens(cond);
  let negated = false;
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!') {
    negated = true;
    e = unwrapParens((e as UnaryExpr).operand);
  }
  if (e.kind !== NodeKind.BinaryExpr) return null;
  const op = negated ? '&&' : '||';
  if ((e as BinaryExpr).operator !== op) return null;
  const flat: Expression[] = [];
  const collect = (x: Expression): void => {
    const u = unwrapParens(x);
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === op) {
      collect((u as BinaryExpr).left);
      collect((u as BinaryExpr).right);
    } else flat.push(x);
  };
  collect(e);
  return negated ? { tests: flat.map(negate), conj: flat } : { tests: flat, conj: flat.map(negate) };
}

/**
 * Leaf operands of the `&&`/`||` operators in `e`, as the extraction counts them. A getter
 * `compare-form` wrote back from `p && p->f == K` was two of them.
 */
function leafCount(e: Expression): number {
  let n = 1;
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.BinaryExpr && ((x as BinaryExpr).operator === '&&' || (x as BinaryExpr).operator === '||')) n++;
    else if (x.kind === NodeKind.ConditionalExpr && x.ghidraInfo?.nullGetter) n++;
  }
  return n;
}

/**
 * Which operand of the guard the leaving arm's code follows: k when it lies after every
 * branch of operand k and before the first of operand k+1 (the last index: after them all).
 * Null without per-operand facts, when the facts do not fit the operands, or when the arm
 * lies among one operand's own branches.
 */
function armAfterOperand(ifs: IfStmt, operands: readonly Expression[], armEntry: number, ctx: Ctx): number | null {
  const counts = operands.map(leafCount);
  const facts = ctx.reader.operandBranches(ifs, counts.reduce((a, b) => a + b, 0));
  if (!facts) return null;
  if (counts.reduce((a, b) => a + b, 0) !== facts.length) return null;
  const ranges: [number, number][] = [];
  let at = 0;
  for (const c of counts) {
    const segs = facts.slice(at, at + c);
    at += c;
    if (segs.some(sg => sg.length === 0)) return null;
    const all = segs.flat();
    ranges.push([Math.min(...all), Math.max(...all)]);
  }
  for (let k = 1; k < ranges.length; k++) if (ranges[k][0] <= ranges[k - 1][1]) return null;
  for (let k = 0; k < ranges.length; k++) {
    if (armEntry > ranges[k][1] && (k === ranges.length - 1 || armEntry < ranges[k + 1][0])) return k;
  }
  return null;
}

/** A value tested for nonzero, not a comparison: a name, a field, an element, a dereference. */
function valueOperand(e: Expression): boolean {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId: case NodeKind.MemberExpr: case NodeKind.SubscriptExpr:
      return true;
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '*';
    default:
      return false;
  }
}

/**
 * `if (!(P && x)) T; rest...` where the layout puts T straight after the last test, ahead
 * of the rest: the source tested the value of `P ? x : 0` (an inlined getter), which VC8
 * lays out with every failing test of P falling into T's one copy. `!(P && x)` would put
 * T after the rest. Null when the condition is not that shape.
 */
function getterCondition(cond: Expression): Expression | null {
  const u = unwrapParens(cond);
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '!') return null;
  const inner = unwrapParens((u as UnaryExpr).operand);
  if (inner.kind !== NodeKind.BinaryExpr || (inner as BinaryExpr).operator !== '&&') return null;
  const { left, right } = inner as BinaryExpr;
  if (!valueOperand(right) || branches(right)) return null;
  const zero = Expr.intLiteral(0);
  const pick = Expr.conditional(Expr.paren(left), right, zero);
  return { ...u, operand: Expr.paren(pick), leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

/** A constant a comparison may be folded against: an integer literal or a capitalised name (an enumerator). */
function constantOperand(e: Expression): 'literal' | 'name' | null {
  let u = unwrapParens(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
  if (isIntegerLiteral(u)) return 'literal';
  if (u.kind === NodeKind.Identifier) return /^[A-Z]/.test((u as Identifier).name) ? 'name' : null;
  if (u.kind === NodeKind.QualifiedId) {
    const last = emit(u as AnyNode).trim().split('::').pop() ?? '';
    return /^[A-Z]/.test(last) ? 'name' : null;
  }
  return null;
}

function literalValue(e: Expression): bigint | null {
  let u = unwrapParens(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
  let neg = false;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') { neg = true; u = unwrapParens((u as UnaryExpr).operand); }
  if (u.kind !== NodeKind.IntegerLiteral || typeof (u as IntegerLiteralExpr).value !== 'bigint') return null;
  const v = (u as IntegerLiteralExpr).value as bigint;
  return neg ? -v : v;
}

function hasCallOrWrite(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr) return true;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) return true;
  }
  return false;
}

function mentions(e: Expression, sub: Expression): boolean {
  for (const n of traverseAST(e)) if (sameExpr(n, sub)) return true;
  return false;
}

/**
 * `!(P && f == K)`, P a pointer tested for null and f a field read through it, as the
 * source's inlined getter of f compared once: `(P ? f : D) != K`, so a failing P runs into
 * the arm without a test of its own. VC8 lays that out with the arm after the comparison,
 * where `!P || f != K` puts it after the rest. D is the getter's own null default, read off
 * the original's bodies (`null-getter.ts`); the form keeps the value only when D != K
 * (`!(P && f != K)` is `(P ? f : D) == K` only when D == K), so a field without a known
 * default, or whose default fails that, keeps the condition as printed. `why` says which.
 */
function compareGetter(p: Expression, q: Expression, ctx: Ctx): { cond: Expression } | { why: string } | null {
  if (!valueOperand(p) || branches(p) || hasCallOrWrite(p)) return null;
  const c = unwrapParens(q);
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  if (b.operator !== '==' && b.operator !== '!=') return null;
  if (!constantOperand(b.right) || constantOperand(b.left) || branches(b.left) || hasCallOrWrite(b.left) || !mentions(b.left, unwrapParens(p))) return null;
  const t = nullTest(p);
  const r = fieldRead(b.left);
  if (!t || t.nullWhenTrue || !r || r.p.name !== t.p.name) return { why: 'not a field read through the tested pointer' };
  const struct = pointeeName(ctx.localTypes.get(t.p.name));
  const key = struct ? `${struct}|${r.path.join('.')}` : null;
  const def = key ? ctx.nullGetters[key] : undefined;
  if (!def) return { why: `no null default known for ${key ?? r.path.join('.')}` };
  const k = constantValue(b.right, n => ctx.enumValues[n]);
  if (!k) return { why: 'constant without a value' };
  if (b.operator === '==') {
    // Distinct 32-bit patterns: the two differ in int, unsigned and any wider type alike.
    if (def.value === k.value) return { why: `null default ${def.name ?? def.value} equals the constant` };
  } else {
    // Equal as written, not only after truncation to 32 bits.
    const raw = literalValue(b.right);
    if (def.value !== k.value || (raw !== null && raw !== BigInt(def.value))) {
      return { why: `null default ${def.name ?? def.value} is not the constant` };
    }
  }
  if (!def.name && def.value === -0x80000000) return { why: 'null default without a literal spelling' };
  const dflt = def.name ? Expr.identifier(def.name)
    : def.value < 0 ? Expr.unary('-', Expr.intLiteral(-def.value)) : Expr.intLiteral(def.value);
  const pick = Expr.paren(Expr.conditional(cloneNode(p) as Expression, b.left, dflt));
  return { cond: Expr.binary(pick, b.operator === '==' ? '!=' : '==', b.right) };
}

/**
 * The rest is only `return K;` and T `return K2;`, both literals. Split where T's one copy
 * lies before the tests, VC8 folds the last guard and that return into a SETcc
 * (`return !c2;`, UI_IsMouseOnStatButton) where the original branches to the earlier copy.
 */
function constantTail(then: Statement, rest: readonly Statement[]): boolean {
  const lit = (s: Statement): boolean => {
    if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return false;
    let v = unwrapParens((s as ReturnStmt).value!);
    while (v.kind === NodeKind.CStyleCastExpr) v = unwrapParens((v as CStyleCastExpr).expression);
    return v.kind === NodeKind.IntegerLiteral || v.kind === NodeKind.BoolLiteral || v.kind === NodeKind.NullptrLiteral;
  };
  const t = bodyOf(then);
  return rest.length === 1 && lit(rest[0]) && t.length === 1 && lit(t[0]);
}

/** `if (g1) T; if (g2) T; ... rest`: the first guard keeps the if, the others get copies of T. */
function splitGuards(ifs: IfStmt, guards: Expression[], rest: Statement[], ctx: Ctx): Statement[] {
  const tail = bodyOf(ifs.thenBranch);
  const first = updateNode(ifs, { condition: guards[0], elseBranch: null } as Partial<IfStmt>);
  const copies = guards.slice(1).map(g =>
    Stmt.if_(g, Stmt.compound(tail.map(s => ({ ...cloneNode(s), leadingTrivia: [] }) as Statement))));
  ctx.reader.taint(tail);
  return [first, ...copies, ...rest];
}

/**
 * `if (a || b || ...) T; rest...` (or `!(x && y && ...)`), T short leaving code. VC8 puts T
 * after the rest for that form; where the original has it elsewhere, the source was another
 * form. Which test T follows is read from the per-operand branch offsets (without them, a
 * two-test condition with T among its tests is taken to follow the first):
 *
 *   T after the first test: one guard per test, `if (a) T; if (b) T; ... rest`, the later
 *   copies cross-jumped into the first.
 *   T after the second of three or more, the first two `P && f == K` with f read through
 *   P: the getter compared once, then one guard per further test:
 *   `if ((P ? f : D) != K) T; if (!z) T; ... rest`.
 *   T right after the last test, ahead of the rest: `if (!(P ? x : 0)) T; rest` for
 *   `!(P && x)` with x a value, `if ((P ? f : D) != K) T; rest` for `!(P && f == K)`.
 */
function orGuardAt(stmts: readonly Statement[], i: number, cb: number, ctx: Ctx): Statement[] | null {
  const ifs = stmts[i] as IfStmt;
  const rest = stmts.slice(i + 1);
  const then = ifs.thenBranch;
  if (bareReturn(then)) return null;
  // The first if of a condition a pass split (see rewriteList) has no line of its own: its
  // tests are bounded by its operands' branches.
  const prefix = ctx.reader.cbranch(ifs) === null;
  const pre = prefix ? ctx.reader.operandBranches(ifs, leafCount(ifs.condition)) : null;
  const low = prefix ? (pre ? Math.min(...pre.flat()) - 1 : null) : ctx.reader.conditionLow(ifs);
  if (low === null || low >= cb) return null;
  const own = ctx.reader.entry([then], low);
  const shared = own === null ? sharedReturn(then, ctx) : null;
  const tE = own ?? shared;
  if (tE === null) return null;
  if (jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) return null;
  const ops = guardOperands(ifs.condition);

  if (shared !== null && shared < low) {
    // The arm's one copy is an earlier guard's: VC8 merged this guard's copy into it. This
    // form would put a copy after the rest, and VC8 keeps that one; one guard per test
    // keeps every copy inline, where the earlier one absorbs them.
    if (!ops || !copyableTail(bodyOf(then), ctx.noreturn) || constantTail(then, rest)) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'merged return before the tests, not a flat `||` guard with a copyable arm and a rest that is not a constant return' });
      return null;
    }
    ctx.onSite?.({ rule: 'split', line: lineOf(ifs), why: 'merged return before the tests' });
    return splitGuards(ifs, ops.tests, rest, ctx);
  }

  if (tE < cb) {
    if (!ops) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm among the tests, not a flat `||` guard' });
      return null;
    }
    const leaves = ops.tests.map(leafCount).reduce((a, b) => a + b, 0);
    const k = ctx.reader.operandBranches(ifs, leaves) ? armAfterOperand(ifs, ops.tests, tE, ctx) : (ops.tests.length === 2 ? 0 : null);
    let guards: Expression[] | null = null;
    if (k === 0) guards = ops.tests;
    else if (k === 1 && ops.tests.length >= 3) {
      const g = compareGetter(ops.conj[0], ops.conj[1], ctx);
      if (g && 'cond' in g) guards = [g.cond, ...ops.tests.slice(2)];
      else if (g && 'why' in g) {
        ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: `getter compare: ${g.why}` });
        return null;
      }
    }
    if (!guards) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: `leaving arm among the tests, after operand ${k ?? '?'} of ${ops.tests.length}` });
      return null;
    }
    const tail = bodyOf(then);
    if (!copyableTail(tail, ctx.noreturn)) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm among the tests, arm not copyable' });
      return null;
    }
    ctx.onSite?.({ rule: k === 0 ? 'split' : 'getter', line: lineOf(ifs), why: `${k === 0 ? '' : 'getter compare: '}arm after operand ${k} of ${ops.tests.length}${shared !== null ? ', merged return' : ''}` });
    return splitGuards(ifs, guards, rest, ctx);
  }

  if (prefix) return null;
  const rE = armEntry(rest[0], cb, ctx);
  if (rE === null || rE <= tE) return null;
  let cond = getterCondition(ifs.condition);
  let compared = false;
  if (!cond && ops && ops.conj.length === 2) {
    const g = compareGetter(ops.conj[0], ops.conj[1], ctx);
    if (g && 'why' in g) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: `getter compare: ${g.why}` });
      return null;
    }
    if (g && 'cond' in g) { cond = g.cond; compared = true; }
  }
  if (!cond) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the last test, not `!(P && value)` or `!(P && f == K)`' });
    return null;
  }
  ctx.onSite?.({ rule: 'getter', line: lineOf(ifs), why: `${compared ? 'getter compare: ' : ''}arm after the last test` });
  return [updateNode(ifs, { condition: cond } as Partial<IfStmt>), ...rest];
}

/**
 * `if (c) A else { ...; Halt(...); exit(-1); }` whose branch a pass copied (the halt tail the
 * decompile merged, written once per path), so `cbranch` gives no evidence. The original's
 * jump still says which successor the test falls into: where it falls into the halt, the
 * halt was laid out first, as the sequential assertion `if (!c) { Halt; exit; } A` lays it
 * out. The same control flow: the halt never returns. Outside a loop, in a statement list.
 */
function haltElseAt(ifs: IfStmt, ctx: Ctx, list: { before: Statement[]; after: Statement[] }): Statement[] | null {
  const other = ifs.elseBranch!;
  if (other.kind === NodeKind.IfStmt || ifs.init || ifs.isConstexpr || ctx.loopIfs.has(lineOf(ifs))) return null;
  if (!endsInHalt(bodyOf(other)) || endsInHalt(bodyOf(ifs.thenBranch))) return null;
  if (conditionShape(ifs.condition).kind !== 'simple') return null;
  if (ctx.reader.fallInto(ifs) !== 'other') return null;
  if (holdsFreeCase([ifs.thenBranch, other])) return null;
  ctx.onSite?.({ rule: 'swap', line: lineOf(ifs), why: 'halt laid out first, branch copied' });
  const guard = updateNode(ifs, { condition: negate(ifs.condition), thenBranch: asBlock([other]), elseBranch: null } as Partial<IfStmt>);
  return [guard, ...spliced(ifs.thenBranch, bodyOf(ifs.thenBranch), list.before, list.after)];
}

/** `fallsOff`: the list is the body of a void function, whose end is its return. */
function rewriteList(stmts: readonly Statement[], ctx: Ctx, fallsOff: boolean): Statement[] | null {
  let cur = [...stmts];
  let changed = false;
  for (let i = 0; i < cur.length; i++) {
    const s = cur[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const ifs = s as IfStmt;
    if (ifs.init || ifs.isConstexpr || ctx.fixed.has(positionOf(ifs))) continue;
    // The first if of a condition a pass split takes its own last branch from the operands.
    const cb = ctx.reader.cbranch(ifs)
      ?? (!ifs.elseBranch && conditionShape(ifs.condition).kind === 'or' ? ctx.reader.prefixBranch(ifs, leafCount(ifs.condition)) : null);
    if (cb === null) {
      const r = ifs.elseBranch ? haltElseAt(ifs, ctx, { before: cur.slice(0, i), after: cur.slice(i + 1) }) : null;
      if (r) { cur = [...cur.slice(0, i), ...r, ...cur.slice(i + 1)]; changed = true; }
      continue;
    }
    if (ifs.elseBranch) {
      const r = swapAt(ifs, cb, ctx, { before: cur.slice(0, i), after: cur.slice(i + 1) });
      if (r) { cur = [...cur.slice(0, i), ...r, ...cur.slice(i + 1)]; changed = true; }
      continue;
    }
    const r = nestAt(cur, i, cb, ctx, fallsOff);
    if (r) { cur = [...cur.slice(0, i), ...r]; changed = true; }
  }
  return changed ? cur : null;
}

function loopIfLines(body: ASTNode): Set<number> {
  const out = new Set<number>();
  const go = (n: ASTNode, inLoop: boolean): void => {
    if (n.kind === NodeKind.IfStmt && inLoop) out.add(lineOf(n as Statement));
    const loop = inLoop || isLoop(n);
    for (const k of getChildren(n)) go(k, loop);
  };
  go(body, false);
  return out;
}

function rewriteFunction(fn0: FunctionDecl, ev: BranchLayoutEvidence, opts: BranchLayoutOptions): FunctionDecl | undefined {
  if (!fn0.body) return undefined;
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]);
  // The whole-function rewrites first (search.ts); the local ones below see their result.
  // GHIDRA_BRANCH_LAYOUT_SEARCH=0 leaves them out.
  const fixed = new Set<string>();
  const searched = process.env.GHIDRA_BRANCH_LAYOUT_SEARCH === '0' ? fn0.body : layoutSearch(fn0.body, ev, {
    fixed,
    noreturn,
    localTypes: localTypesOf(fn0),
    voidResult: isVoidFunction(fn0),
    enumTypes: new Set(opts.enumTypes ?? []),
    onSite: opts.onSite ? e => opts.onSite!({ rule: e.rule, line: e.line, why: e.why }) : undefined,
  });
  const fn = searched === fn0.body ? fn0 : updateNode(fn0, { body: searched } as Partial<FunctionDecl>);
  const fnBody = fn.body!;
  const voidFn = isVoidFunction(fn);
  // The transformer hands over rebuilt nodes: the body is known by its position.
  const isBody = (b: CompoundStmt): boolean => b === fnBody
    || (!!b.location && !!fnBody.location && b.location.start.line === fnBody.location.start.line
      && b.location.start.column === fnBody.location.start.column && b.location.file === fnBody.location.file
      && fnBody.location.file !== '<generated>');
  const ctx: Ctx = {
    reader: new LayoutReader(ev, fnBody),
    noreturn,
    gotos: gotoCounts(fnBody),
    loopIfs: loopIfLines(fnBody),
    onSite: opts.onSite,
    nullGetters: opts.nullGetters ?? {},
    enumValues: opts.enumValues ?? {},
    localTypes: localTypesOf(fn),
    fixed,
  };
  let n = 0;
  const t = createTransformer({
    // An else-if is not in a statement list: its parent swaps it, link by link.
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      const inner = node.elseBranch;
      if (!inner || inner.kind !== NodeKind.IfStmt) return undefined;
      const e = inner as IfStmt;
      if (!e.elseBranch || e.init || e.isConstexpr || ctx.fixed.has(positionOf(e))) return undefined;
      const cb = ctx.reader.cbranch(e);
      if (cb === null) return undefined;
      const r = swapAt(e, cb, ctx, null);
      if (!r) return undefined;
      n++;
      return updateNode(node, { elseBranch: r[0] } as Partial<IfStmt>);
    },
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = rewriteList(block.statements, ctx, voidFn && isBody(block));
      if (!r) return undefined;
      n++;
      return updateNode(block, { statements: r } as Partial<CompoundStmt>);
    },
  });
  const body = t(fnBody) as CompoundStmt;
  logScore(opts, ev, body, ctx.noreturn);
  if (n) return updateNode(fn, { body } as Partial<FunctionDecl>);
  return fn === fn0 ? undefined : fn;
}

/**
 * GHIDRA_BRANCH_LAYOUT_SCORE=<file>: one line per function with edges: its entry, the layout
 * objective of the body this pass hands on (predict.ts), the sites scored, each contradicted
 * site and every site's rule with whether it held. The calibration reads it for the
 * functions that already match.
 */
function logScore(opts: BranchLayoutOptions, ev: BranchLayoutEvidence, body: CompoundStmt, noreturn: ReadonlySet<string>): void {
  const file = process.env.GHIDRA_BRANCH_LAYOUT_SCORE;
  if (!file || !ev.edges) return;
  const s: LayoutScore = scoreBody(body, new LayoutReader(ev, body), noreturn);
  const sites = s.mismatches.map(m => `${m.line}:${m.predicted}/${m.fact}:${m.rule}:${m.detail ?? ''}`).join(';');
  appendFileSync(file, `${opts.functionAddress ?? '?'}\t${s.objective}\t${s.sites}\t${sites}\t${s.rules.join(';')}\n`);
}

export function branchLayout_forTest(fn: FunctionDecl, opts: BranchLayoutOptions): FunctionDecl {
  return opts.branchLayout ? rewriteFunction(fn, opts.branchLayout, opts) ?? fn : fn;
}

function createBranchLayoutTransformer(options: BranchLayoutOptions = {}): Transformer {
  const ev = options.branchLayout;
  if (!ev) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const branchLayoutPlugin: TransformPlugin = {
  id: 'branch-layout',
  name: 'Branch Layout',
  description:
    "Orders an if's arms the way the original's code addresses show: swaps if/else arms, nests or flattens a leaving arm, splits an && guard whose tail was written per test",
  version: '1.0.0',
  defaultEnabled: true,
  // After assert-order (987), which gives assertions their shape, so this sees the final
  // control flow; the compare-form spelling of a negated condition comes after.
  priority: 988,
  tags: ['control-flow', 'layout'],
  createTransformer: createBranchLayoutTransformer,
};

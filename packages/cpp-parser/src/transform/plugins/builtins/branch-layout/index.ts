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
  DeclStmt, VariableDecl, Identifier,
} from '../../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../../transformer.js';
import { Stmt, Expr } from '../../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../../types.js';
import { DEFAULT_NORETURN_FUNCTIONS } from '../goto-cleanup/types.js';
import { holdsFreeCase } from '../goto-cleanup/paths.js';
import { leaves, isHaltStmt, isExitStmt, negateCondition } from '../assert-order.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './evidence.js';

export type { BranchLayoutEvidence } from './evidence.js';
export { LayoutReader } from './evidence.js';

export interface BranchLayoutOptions extends PluginOptions {
  /** The original's addresses, keyed by line of the parsed text; absent: nothing changes. */
  branchLayout?: BranchLayoutEvidence | null;
  /** Further callees that never return, by unqualified name. */
  noreturnFunctions?: string[];
  /** Called once per rewrite and per site left for want of a source form. */
  onSite?: (e: { rule: 'swap' | 'nest' | 'split' | 'getter' | 'left'; line: number; why?: string }) => void;
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

function declaredNames(stmts: readonly Statement[]): Set<string> {
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

function mentionsAny(roots: readonly ASTNode[], names: ReadonlySet<string>): boolean {
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
function spliced(original: Statement, stmts: Statement[], before: readonly Statement[], after: readonly Statement[]): Statement[] {
  const names = declaredNames(stmts);
  if (names.size === 0) return stmts;
  const clash = names.has('\0') || mentionsAny(after, names)
    || [...declaredNames(before)].some(n => names.has(n));
  if (!clash) return stmts;
  return [original.kind === NodeKind.CompoundStmt ? original : Stmt.compound(stmts)];
}

function asBlock(stmts: Statement[]): Statement {
  return stmts.length === 1 && stmts[0].kind === NodeKind.CompoundStmt ? stmts[0] : Stmt.compound(stmts);
}

function jumpedLabels(roots: readonly ASTNode[], gotos: ReadonlyMap<string, number>): boolean {
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.LabelStmt && (gotos.get((n as LabelStmt).label.name) ?? 0) > 0) return true;
    }
  }
  return false;
}

function gotoCounts(root: ASTNode): Map<string, number> {
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

/** Short leaving code that may be written once per test: calls on plain operands, then a plain return or a halt. */
function copyableTail(stmts: readonly Statement[], noreturn: ReadonlySet<string>): boolean {
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
  return leaves(stmts[stmts.length - 1], noreturn);
}

interface Ctx {
  reader: LayoutReader;
  noreturn: ReadonlySet<string>;
  gotos: ReadonlyMap<string, number>;
  /** Lines of the ifs that sit inside a loop. */
  loopIfs: ReadonlySet<number>;
  onSite?: BranchLayoutOptions['onSite'];
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

/** `if (c) X; rest...`: the replacement for stmts[i..], or null. */
function nestAt(stmts: readonly Statement[], i: number, cb: number, ctx: Ctx): Statement[] | null {
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
    if (!copyableTail(rest, ctx.noreturn)
      || jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'shared tail among the tests, tail not copyable' });
      return null;
    }
    ctx.onSite?.({ rule: 'split', line: lineOf(ifs) });
    const first = updateNode(ifs, { condition: negate(conj[0]), thenBranch: Stmt.compound(rest), elseBranch: null } as Partial<IfStmt>);
    const copy = rest.map(s => ({ ...cloneNode(s), leadingTrivia: [] }) as Statement);
    ctx.reader.taint(rest);
    const second = Stmt.if_(negate(conj[1]), Stmt.compound(copy));
    return [first, second, ...spliced(then, bodyOf(then), stmts.slice(0, i), [])];
  }

  const xE = armEntry(then, cb, ctx), rE = armEntry(rest[0], cb, ctx);
  if (xE === null || rE === null || xE <= rE) return null;
  if (!leaves(rest[rest.length - 1], ctx.noreturn)) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the rest, rest falls through' });
    return null;
  }
  if (jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the rest, a label in the way' });
    return null;
  }
  ctx.onSite?.({ rule: 'nest', line: lineOf(ifs) });
  // The rest had not been visited yet: its own ifs are judged where they now sit.
  const inner = rewriteList(rest, ctx) ?? rest;
  const nested = updateNode(ifs, { condition: negate(ifs.condition), thenBranch: Stmt.compound(inner), elseBranch: null } as Partial<IfStmt>);
  return [nested, ...spliced(then, bodyOf(then), stmts.slice(0, i), [])];
}

/**
 * The two tests of a two-operand `||` condition, each as the condition that takes the
 * leaving arm: `a || b` gives a and b, `!(a && b)` gives !a and !b. Null for anything else
 * (three or more operands: which test the arm follows is not known from the layout).
 */
function orTests(cond: Expression): [Expression, Expression] | null {
  let e = unwrapParens(cond);
  let negated = false;
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!') {
    negated = true;
    e = unwrapParens((e as UnaryExpr).operand);
  }
  if (e.kind !== NodeKind.BinaryExpr) return null;
  const b = e as BinaryExpr;
  if (b.operator !== (negated ? '&&' : '||')) return null;
  const same = (x: Expression): boolean => {
    const u = unwrapParens(x);
    return u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === b.operator;
  };
  if (same(b.left) || same(b.right)) return null;
  return negated ? [negate(b.left), negate(b.right)] : [b.left, b.right];
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

/**
 * `if (a || b) T; rest...` (or `!(x && y)`), T short leaving code. VC8 puts T after the rest
 * for that form; where the original has it elsewhere, the source was another form:
 *
 *   T between the two tests: one guard per test, `if (a) T; if (b) T; rest`, the later
 *   copy cross-jumped into the first.
 *   T right after the last test, ahead of the rest, and the condition `!(P && x)` with x a
 *   value: `if (!(P ? x : 0)) T; rest`.
 */
function orGuardAt(stmts: readonly Statement[], i: number, cb: number, ctx: Ctx): Statement[] | null {
  const ifs = stmts[i] as IfStmt;
  const rest = stmts.slice(i + 1);
  const then = ifs.thenBranch;
  if (bareReturn(then)) return null;
  const low = ctx.reader.conditionLow(ifs);
  if (low === null || low >= cb) return null;
  const tE = ctx.reader.entry([then], low);
  if (tE === null) return null;
  if (jumpedLabels([then, ...rest], ctx.gotos) || holdsFreeCase([then, ...rest])) return null;

  if (tE < cb) {
    const tests = orTests(ifs.condition);
    if (!tests) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm among the tests, not a two-test `||`' });
      return null;
    }
    const tail = bodyOf(then);
    if (!copyableTail(tail, ctx.noreturn)) {
      ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm among the tests, arm not copyable' });
      return null;
    }
    ctx.onSite?.({ rule: 'split', line: lineOf(ifs) });
    const first = updateNode(ifs, { condition: tests[0], elseBranch: null } as Partial<IfStmt>);
    const copy = tail.map(s => ({ ...cloneNode(s), leadingTrivia: [] }) as Statement);
    ctx.reader.taint(tail);
    const second = Stmt.if_(tests[1], Stmt.compound(copy));
    return [first, second, ...rest];
  }

  const rE = armEntry(rest[0], cb, ctx);
  if (rE === null || rE <= tE) return null;
  const cond = getterCondition(ifs.condition);
  if (!cond) {
    ctx.onSite?.({ rule: 'left', line: lineOf(ifs), why: 'leaving arm after the last test, not `!(P && value)`' });
    return null;
  }
  ctx.onSite?.({ rule: 'getter', line: lineOf(ifs) });
  return [updateNode(ifs, { condition: cond } as Partial<IfStmt>), ...rest];
}

function rewriteList(stmts: readonly Statement[], ctx: Ctx): Statement[] | null {
  let cur = [...stmts];
  let changed = false;
  for (let i = 0; i < cur.length; i++) {
    const s = cur[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const ifs = s as IfStmt;
    if (ifs.init || ifs.isConstexpr) continue;
    const cb = ctx.reader.cbranch(ifs);
    if (cb === null) continue;
    if (ifs.elseBranch) {
      const r = swapAt(ifs, cb, ctx, { before: cur.slice(0, i), after: cur.slice(i + 1) });
      if (r) { cur = [...cur.slice(0, i), ...r, ...cur.slice(i + 1)]; changed = true; }
      continue;
    }
    const r = nestAt(cur, i, cb, ctx);
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

function rewriteFunction(fn: FunctionDecl, ev: BranchLayoutEvidence, opts: BranchLayoutOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const ctx: Ctx = {
    reader: new LayoutReader(ev, fn.body),
    noreturn: new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]),
    gotos: gotoCounts(fn.body),
    loopIfs: loopIfLines(fn.body),
    onSite: opts.onSite,
  };
  let n = 0;
  const t = createTransformer({
    // An else-if is not in a statement list: its parent swaps it, link by link.
    visitIfStmt(node: IfStmt): ASTNode | undefined {
      const inner = node.elseBranch;
      if (!inner || inner.kind !== NodeKind.IfStmt) return undefined;
      const e = inner as IfStmt;
      if (!e.elseBranch || e.init || e.isConstexpr) return undefined;
      const cb = ctx.reader.cbranch(e);
      if (cb === null) return undefined;
      const r = swapAt(e, cb, ctx, null);
      if (!r) return undefined;
      n++;
      return updateNode(node, { elseBranch: r[0] } as Partial<IfStmt>);
    },
    visitCompoundStmt(block: CompoundStmt): ASTNode | undefined {
      const r = rewriteList(block.statements, ctx);
      if (!r) return undefined;
      n++;
      return updateNode(block, { statements: r } as Partial<CompoundStmt>);
    },
  });
  const body = t(fn.body) as CompoundStmt;
  return n ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
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

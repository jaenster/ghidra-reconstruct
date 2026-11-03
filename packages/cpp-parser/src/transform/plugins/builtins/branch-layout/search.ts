/**
 * Function-level rewrites of the branch-layout pass, each made only where the original's
 * conditional jumps show its pattern, and kept only when the layout objective of the whole
 * function (predict.ts) strictly drops. A greedy search: per round every candidate is tried
 * on the function, the best one is kept, at most eight rounds.
 *
 *   return-merge  `if (G) return K; S...; return K;` where G's jump goes to the copy of K
 *                 after S and falls into S: `if (!G) { S... } return K;`, the form whose
 *                 layout the objective says the original has (a guard that is not the last
 *                 one before the final return keeps a copy of its own where VC8 can merge
 *                 it). In a void function the body's end may stand for the `return;`.
 *   propagate     `if (!x1) return K; T x2 = e(x1); if (!x2) return K; ...` where the earlier
 *                 guards' jumps go forward into the inline copy of the last one: the source
 *                 tested a value it had set to the failing constant on the null path
 *                 (`T x2 = x1 ? e(x1) : 0;`), and VC8 threads the jump through the known
 *                 value. One more definition may sit before x2's (`t = e0;`); it moves into
 *                 the ternary's arm as a comma operand.
 *   swap          `if (c) A else B` -> `if (!c) B else A` (with B an assertion halt outside a
 *                 loop, the sequential `if (!c) { B } A`).
 *   nest          `if (c) X; Y...` -> `if (!c) { Y... } X`, X and Y... leaving, outside a loop.
 *                 At the end of a void function's body Y... may run off the end; it gets the
 *                 `return;` that end stands for: `if (!c) { Y...; return; } X`.
 *
 *   join          `if (a) return K; if (b) return K;` -> `if (a || b) return K;`, and
 *   split         every `if (a || b) return K;` (or `!(x && y)`) of K's group of identical
 *                 returns -> `if (a) return K; if (b) return K;`: where VC8 keeps the one
 *                 copy of K (predict.ts) follows from whether any guard of the group is an
 *                 `||`, and the original's copy says which. The same tests and jumps either
 *                 way; each is kept only where the group's copy site goes from contradicted
 *                 to held.
 *
 * swap and nest have no pattern of their own: the edges decide them, so each is kept only
 * where the predictor scores every if it moves, before and after, and the rewritten if
 * itself. The local rewrites of index.ts leave an if one of them settled.
 * GHIDRA_BRANCH_LAYOUT_W1=0 leaves swap and nest out.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, Statement, ReturnStmt, Expression, ExprStmt, DeclStmt, VariableDecl,
  Identifier, UnaryExpr, BinaryExpr, AssignExpr, ParenExpr, TypeNode, AnyNode, FunctionDecl,
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { updateNode } from '../../../transformer.js';
import { Stmt, Expr } from '../../../../ast/factory.js';
import { holdsFreeCase } from '../goto-cleanup/paths.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './evidence.js';
import { scoreBody, returnKey, returnGroups, type LayoutScore, type ReturnGroup } from './predict.js';
import { negate, jumpedLabels, gotoCounts, declaredNames, mentionsAny, spliced, asBlock, guardOperands } from './index.js';
import { leaves, isHaltStmt, isExitStmt } from '../assert-order.js';

export interface SearchOptions {
  noreturn: ReadonlySet<string>;
  /** Declared type of each parameter and local. */
  localTypes: ReadonlyMap<string, TypeNode>;
  /** The function returns void: a body may end without a return. */
  voidResult: boolean;
  /** Names of the enum types, unqualified. */
  enumTypes: ReadonlySet<string>;
  onSite?: (e: { rule: Rule; line: number; why?: string }) => void;
  /** Filled with the positions (`line:column`) of the ifs a swap or nest settled, for the local rewrites to leave. */
  fixed?: Set<string>;
}

type Rule = 'return-merge' | 'propagate' | 'swap' | 'nest' | 'join' | 'split';

interface Candidate {
  rule: Rule;
  line: number;
  list: CompoundStmt;
  replacement: Statement[];
  /**
   * The statements the rewrite moves (swap, nest): it is kept only when the predictor
   * scores every if among them, before and after, and the rewritten if itself.
   */
  region?: { before: Statement[]; main: IfStmt };
  /** The whole body after the rewrite, for one that changes more than one list. */
  body?: CompoundStmt;
  /** The key of the group of identical returns whose copy site the rewrite must settle (join, split). */
  group?: string;
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `if (G) return K;` with no else: the return, else null. */
function guardReturn(s: Statement): ReturnStmt | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const ifs = s as IfStmt;
  if (ifs.elseBranch || ifs.init || ifs.isConstexpr) return null;
  const arm = bodyOf(ifs.thenBranch);
  return arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt ? arm[0] as ReturnStmt : null;
}

function overlaps(a: readonly number[], b: ReadonlySet<number>): boolean {
  return a.some(l => b.has(l));
}

/** `root` with `target` (found by identity) replaced; the spine above it shallow-copied. */
function rebuild(root: ASTNode, target: ASTNode, repl: ASTNode): ASTNode {
  if (root === target) return repl;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(root)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || !v || typeof v !== 'object') continue;
    let nv: unknown = v;
    if (Array.isArray(v)) {
      let changed = false;
      const arr = v.map(x => {
        if (!x || typeof x !== 'object' || typeof (x as ASTNode).kind !== 'string') return x;
        const r = rebuild(x as ASTNode, target, repl);
        if (r !== x) changed = true;
        return r;
      });
      if (changed) nv = arr;
    } else if (typeof (v as ASTNode).kind === 'string') {
      nv = rebuild(v as ASTNode, target, repl);
    }
    if (nv !== v) {
      out ??= { ...root };
      out[k] = nv;
    }
  }
  return (out as unknown as ASTNode) ?? root;
}

/** Every statement list of the body, with whether a loop encloses it and whether it is the body itself. */
function lists(body: CompoundStmt): { list: CompoundStmt; inLoop: boolean; top: boolean }[] {
  const out: { list: CompoundStmt; inLoop: boolean; top: boolean }[] = [];
  const go = (n: ASTNode, inLoop: boolean): void => {
    if (n.kind === NodeKind.CompoundStmt) out.push({ list: n as CompoundStmt, inLoop, top: n === body });
    const loop = inLoop || isLoop(n);
    for (const k of getChildren(n)) go(k, loop);
  };
  go(body, false);
  return out;
}

/** S may be moved into a block: no label anything jumps to, no case label of an enclosing switch. */
function movable(stmts: Statement[], gotos: ReadonlyMap<string, number>): boolean {
  return !jumpedLabels(stmts, gotos) && !holdsFreeCase(stmts);
}

function returnMerge(entry: { list: CompoundStmt; top: boolean }, i: number, reader: LayoutReader, gotos: ReadonlyMap<string, number>, opts: SearchOptions): Candidate | null {
  const stmts = entry.list.statements;
  const ifs = stmts[i] as IfStmt;
  const ret = guardReturn(ifs);
  if (!ret) return null;
  const key = returnKey(ret);
  if (key === null) return null;
  const last = stmts[stmts.length - 1];
  const explicit = last.kind === NodeKind.ReturnStmt && last !== stmts[i] && returnKey(last as ReturnStmt) === key
    && emit((last as ReturnStmt).value as AnyNode ?? Expr.intLiteral(0)) === emit(ret.value as AnyNode ?? Expr.intLiteral(0));
  // A void function's body may end on S: its end is the return.
  const atEnd = !explicit && key === '' && entry.top && opts.voidResult;
  if (!explicit && !atEnd) return null;
  const s = stmts.slice(i + 1, explicit ? stmts.length - 1 : stmts.length);
  if (s.length === 0 || !movable(s, gotos)) return null;
  // K is evaluated where it stands in both forms; it must not name what S declares.
  if (explicit && mentionsAny([last], declaredNames(s))) return null;
  const e = reader.edge(ifs);
  if (!e || reader.fallInto(ifs) !== 'other' || !overlaps(e.fallLines, reader.linesOf(s))) return null;
  if (explicit ? !overlaps(e.takenLines, reader.linesOf([last])) : overlaps(e.takenLines, reader.linesOf(s))) return null;
  const nested = updateNode(ifs, { condition: negate(ifs.condition), thenBranch: Stmt.compound(s), elseBranch: null } as Partial<IfStmt>);
  return {
    rule: 'return-merge', line: ifs.location?.start.line ?? 0, list: entry.list,
    replacement: [...stmts.slice(0, i), nested, ...(explicit ? [last] : [])],
  };
}

/** The name a guard condition tests for its failing value, and that value's form. */
type Test = { name: string; fail: 'zero' } | { name: string; fail: 'constant'; value: Expression };

function nameOf(e: Expression): string | null {
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

function isZero(e: Expression): boolean {
  let u = unwrapParens(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as unknown as { expression: Expression }).expression);
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.IntegerLiteral && BigInt((u as unknown as { value: bigint | number }).value) === 0n;
}

/** An enumerator: a name or a qualified name whose last part is capitalised. */
function enumerator(e: Expression): boolean {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.Identifier) return /^[A-Z]/.test((u as Identifier).name);
  if (u.kind === NodeKind.QualifiedId) return /^[A-Z]/.test(emit(u as AnyNode).trim().split('::').pop() ?? '');
  return false;
}

/** `!x`, `x == 0`, `0 == x`, `x == nullptr`, `x == E` (E an enumerator): the guard returns when x has that value. */
function failTest(cond: Expression): Test | null {
  const u = unwrapParens(cond);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const n = nameOf((u as UnaryExpr).operand);
    return n ? { name: n, fail: 'zero' } : null;
  }
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '==') return null;
  const b = u as BinaryExpr;
  for (const [x, k] of [[b.left, b.right], [b.right, b.left]] as const) {
    const n = nameOf(x);
    if (!n) continue;
    if (isZero(k)) return { name: n, fail: 'zero' };
    if (enumerator(k)) return { name: n, fail: 'constant', value: k };
  }
  return null;
}

/** A statement that sets one plain variable: `T x = e;` or `x = e;`. */
interface Def { name: string; value: Expression; decl: VariableDecl | null; stmt: Statement }

function definition(s: Statement): Def | null {
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit || v.copyListInit || v.specifiers.length > 0) return null;
    const t = v.type.kind;
    if (t === NodeKind.ReferenceType || t === NodeKind.QualifiedType || t === NodeKind.AutoType || t === NodeKind.ArrayType) return null;
    return { name: v.name.name, value: v.initializer as Expression, decl: v, stmt: s };
  }
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = (s as ExprStmt).expression;
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const n = nameOf((e as AssignExpr).left);
  return n ? { name: n, value: (e as AssignExpr).right, decl: null, stmt: s } : null;
}

function mentions(e: ASTNode, name: string): boolean {
  for (const n of traverseAST(e)) if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) return true;
  return false;
}

/**
 * The failing value of `test` for a variable of declared type `type`, spelled so that storing
 * it keeps it exactly: null for a pointer, 0 for an integer, the enumerator itself for a
 * variable of an enum type. Null when the type is none of those (an enum tested against 0
 * would need a cast).
 */
function failValue(test: Test, type: TypeNode | undefined, enumTypes: ReadonlySet<string>): Expression | null {
  if (!type) return null;
  const named = type.kind === NodeKind.TypedefType ? emit(type as unknown as AnyNode).trim().split('::').pop() ?? '' : null;
  const isEnum = named !== null && enumTypes.has(named);
  if (test.fail === 'zero') {
    if (type.kind === NodeKind.PointerType) return Expr.nullptr();
    return type.kind === NodeKind.BuiltinType || (named !== null && !isEnum) ? Expr.intLiteral(0) : null;
  }
  return isEnum ? test.value : null;
}

interface Link { guard: IfStmt; test: Test; pre: Def | null; def: Def }

export interface GuardChain {
  ret: ReturnStmt;
  guards: { ifs: IfStmt; at: number; test: Test }[];
  links: Link[];
}

/**
 * `if (fail(x1)) return K; [t = e0;] x2 = e(x1); if (fail(x2)) return K; ...` from stmts[i]:
 * each guard tests the value the definitions before it set from the previous guard's, and
 * all return the same K. Null for fewer than two guards.
 */
export function guardChain(stmts: readonly Statement[], i: number): GuardChain | null {
  const first = stmts[i] as IfStmt;
  const ret = guardReturn(first);
  if (!ret) return null;
  const key = returnKey(ret);
  const t0 = failTest(first.condition);
  if (key === null || !t0) return null;
  const guards: GuardChain['guards'] = [{ ifs: first, at: i, test: t0 }];
  const links: Link[] = [];
  let at = i + 1;
  for (;;) {
    let j = at;
    const defs: Def[] = [];
    while (j < stmts.length && defs.length < 2) {
      const d = definition(stmts[j]);
      if (!d) break;
      defs.push(d);
      j++;
    }
    if (defs.length === 0 || j >= stmts.length) break;
    const g = stmts[j] as IfStmt;
    const r = guardReturn(g);
    const t = r ? failTest(g.condition) : null;
    if (!r || !t || returnKey(r) !== key) break;
    const def = defs[defs.length - 1], pre = defs.length === 2 ? defs[0] : null;
    const prev = guards[guards.length - 1].test.name;
    if (def.name !== t.name || (pre && (pre.name === def.name || pre.name === prev)) || !(mentions(def.value, prev) || (pre && mentions(pre.value, prev)))) break;
    links.push({ guard: guards[guards.length - 1].ifs, test: guards[guards.length - 1].test, pre, def });
    guards.push({ ifs: g, at: j, test: t });
    at = j + 1;
  }
  return links.length > 0 ? { ret, guards, links } : null;
}

/**
 * The last guard of the chain whose copy of K is inline while every guard before it jumps
 * forward into that copy (VC8 threading a known value); -1 when the jumps show no such guard.
 */
export function threadedTo(reader: LayoutReader, guards: GuardChain['guards']): number {
  for (let k = guards.length - 1; k >= 1; k--) {
    const ek = reader.edge(guards[k].ifs);
    if (!ek || reader.fallInto(guards[k].ifs) !== 'then') continue;
    const ok = guards.slice(0, k).every(g => {
      const e = reader.edge(g.ifs);
      return !!e && reader.fallInto(g.ifs) === 'other' && e.target === ek.fall && e.jcc < ek.jcc;
    });
    // Every jump into that copy is one of the chain's: a test outside it that also threads
    // there is part of the same source expression, which the chain does not cover.
    const into = reader.jumpsTo(ek.fall);
    if (ok && into.length === k && guards.slice(0, k).every(g => into.includes(reader.edge(g.ifs)!))) return k;
  }
  return -1;
}

function propagate(entry: { list: CompoundStmt }, i: number, reader: LayoutReader, opts: SearchOptions): Candidate | null {
  const stmts = entry.list.statements;
  const first = stmts[i] as IfStmt;
  const chain = guardChain(stmts, i);
  if (!chain) return null;
  const { guards, links, ret } = chain;
  const f = threadedTo(reader, guards);
  if (f < 1) return null;
  const used = links.slice(0, f);
  // K must read nothing the chain now sets on the failing path.
  for (const l of used) {
    if (ret.value && (mentions(ret.value, l.def.name) || (l.pre && mentions(ret.value, l.pre.name)))) return null;
  }
  const out: Statement[] = [];
  for (let k = 0; k < used.length; k++) {
    const l = used[k];
    const next = guards[k + 1].test;
    const type = l.def.decl ? l.def.decl.type : opts.localTypes.get(l.def.name);
    const dflt = failValue(next, type, opts.enumTypes);
    if (!dflt) return null;
    let arm: Expression = l.def.value;
    if (l.pre) {
      if (l.pre.decl) out.push(Stmt.declStmt([{ ...l.pre.decl, initializer: null }]));
      const set = Expr.assign(Expr.identifier(l.pre.name), l.pre.value);
      arm = Expr.paren({ kind: NodeKind.CommaExpr, expressions: [set, Expr.paren(arm)], location: l.def.value.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Expression);
    }
    const value = Expr.conditional(negate(l.guard.condition), Expr.paren(arm), dflt);
    const stmt: Statement = l.def.decl
      ? updateNode(l.def.stmt as DeclStmt, { declarations: [{ ...l.def.decl, initializer: value }] } as Partial<DeclStmt>)
      : updateNode(l.def.stmt as ExprStmt, { expression: Expr.assign(Expr.identifier(l.def.name), value) } as Partial<ExprStmt>);
    out.push(stmt);
  }
  const end = guards[f].at;
  return {
    rule: 'propagate', line: first.location?.start.line ?? 0, list: entry.list,
    replacement: [...stmts.slice(0, i), ...out, ...stmts.slice(end)],
  };
}

function endsInHalt(stmts: readonly Statement[]): boolean {
  return stmts.length >= 2 && isHaltStmt(stmts[stmts.length - 2]) && isExitStmt(stmts[stmts.length - 1]);
}

function placedIf(ifs: IfStmt): boolean {
  return !!ifs.location && ifs.location.file !== '<generated>' && ifs.location.start.line > 0;
}

/**
 * `if (c) A else B` -> `if (!c) B else A`; with B an assertion halt outside a loop, the
 * sequential assertion `if (!c) { B } A...`. The negation is exact; the arms keep their
 * statements. Which form the original wrote, the objective decides.
 */
function swapIf(entry: { list: CompoundStmt; inLoop: boolean }, i: number, gotos: ReadonlyMap<string, number>): Candidate | null {
  const stmts = entry.list.statements;
  const ifs = stmts[i] as IfStmt;
  if (!ifs.elseBranch || ifs.init || ifs.isConstexpr || !placedIf(ifs)) return null;
  if (jumpedLabels([ifs], gotos) || holdsFreeCase([ifs])) return null;
  const then = ifs.thenBranch, other = ifs.elseBranch;
  const cond = negate(ifs.condition);
  let repl: Statement[];
  if (endsInHalt(bodyOf(other)) && !entry.inLoop) {
    const guard = updateNode(ifs, { condition: cond, thenBranch: asBlock([other]), elseBranch: null } as Partial<IfStmt>);
    repl = [guard, ...spliced(then, bodyOf(then), stmts.slice(0, i), stmts.slice(i + 1))];
  } else {
    // An else-if moved into the then-arm is braced, or the old then-arm would bind to it.
    const thenArm = other.kind === NodeKind.IfStmt ? Stmt.compound([other]) : other;
    repl = [updateNode(ifs, { condition: cond, thenBranch: thenArm, elseBranch: then } as Partial<IfStmt>)];
  }
  return {
    rule: 'swap', line: ifs.location.start.line, list: entry.list,
    replacement: [...stmts.slice(0, i), ...repl, ...stmts.slice(i + 1)],
    region: { before: [ifs], main: ifs },
  };
}

/**
 * `if (c) X; Y...` where X leaves and Y..., the rest of the block, ends leaving, outside a
 * loop: `if (!c) { Y... } X`. Both directions of guard <-> nest are this one rewrite. In the
 * body of a void function Y... may run off the end, which is its return.
 */
function nestIf(entry: { list: CompoundStmt; inLoop: boolean; top: boolean }, i: number, gotos: ReadonlyMap<string, number>, opts: SearchOptions): Candidate | null {
  const stmts = entry.list.statements;
  const ifs = stmts[i] as IfStmt;
  if (ifs.elseBranch || ifs.init || ifs.isConstexpr || entry.inLoop || !placedIf(ifs)) return null;
  const rest = stmts.slice(i + 1);
  if (rest.length === 0) return null;
  const then = ifs.thenBranch;
  const restLeaves = leaves(rest[rest.length - 1], opts.noreturn);
  if (!leaves(then, opts.noreturn) || (!restLeaves && !(entry.top && opts.voidResult))) return null;
  if (!movable([then, ...rest], gotos)) return null;
  const moved = restLeaves ? rest : [...rest, Stmt.return_()];
  const nested = updateNode(ifs, { condition: negate(ifs.condition), thenBranch: Stmt.compound(moved), elseBranch: null } as Partial<IfStmt>);
  return {
    rule: 'nest', line: ifs.location.start.line, list: entry.list,
    replacement: [...stmts.slice(0, i), nested, ...spliced(then, bodyOf(then), stmts.slice(0, i), [])],
    region: { before: [ifs, ...rest], main: ifs },
  };
}

/** An operand of a new `||`, parenthesised unless it binds tighter than `&&`. */
function orOperand(e: Expression): Expression {
  const u = unwrapParens(e);
  const loose = u.kind === NodeKind.AssignExpr || u.kind === NodeKind.ConditionalExpr || u.kind === NodeKind.CommaExpr
    || (u.kind === NodeKind.BinaryExpr && ((u as BinaryExpr).operator === '&&' || (u as BinaryExpr).operator === '||'));
  return loose && u === e ? Expr.paren(e) : e;
}

/**
 * `if (a) return K; if (b) return K;`, two neighbouring guards of one group of identical
 * returns: `if (a || b) return K;`. The same tests in the same order, each taking the
 * return: the control flow is the same.
 */
function joinGuards(entry: { list: CompoundStmt }, i: number, groups: ReadonlyMap<ReturnStmt, ReturnGroup>): Candidate | null {
  const stmts = entry.list.statements;
  const a = stmts[i], b = stmts[i + 1];
  if (!b || b.kind !== NodeKind.IfStmt) return null;
  const ra = guardReturn(a), rb = guardReturn(b);
  const g = ra ? groups.get(ra) : undefined;
  if (!ra || !rb || !g || groups.get(rb) !== g || !placedIf(a as IfStmt)) return null;
  const cond = Expr.binary(orOperand((a as IfStmt).condition), '||', orOperand((b as IfStmt).condition));
  const joined = updateNode(a as IfStmt, { condition: cond } as Partial<IfStmt>);
  return {
    rule: 'join', line: a.location.start.line, list: entry.list, group: g.key,
    replacement: [...stmts.slice(0, i), joined, ...stmts.slice(i + 2)],
  };
}

/**
 * Every `if (a || b || ...) return K;` (or `!(x && y && ...)`) of the group: one guard per
 * test, `if (a) return K; if (b) return K; ...`, in order. Each test takes the same return.
 * Only where no `||` guard of the group has branch facts of its own: the local or-guard
 * rule (index.ts) reads those per operand, and may write a getter instead.
 */
function splitGroup(body: CompoundStmt, g: ReturnGroup, reader: LayoutReader): Candidate | null {
  const targets = g.guards.filter(x => guardOperands(x.condition) !== null);
  if (targets.length === 0 || targets.some(x => reader.cbranch(x) !== null || reader.operandBranches(x) !== null)) return null;
  let cur = body;
  for (const ifs of targets) {
    const ops = guardOperands(ifs.condition)!;
    const holder = lists(cur).find(e => e.list.statements.includes(ifs));
    if (!holder) return null;
    const ret = guardReturn(ifs)!;
    const split = ops.tests.map((t, k) => k === 0
      ? updateNode(ifs, { condition: t } as Partial<IfStmt>)
      : Stmt.if_(t, Stmt.compound([{ ...ret, leadingTrivia: [], trailingTrivia: [] } as Statement])));
    const st = holder.list.statements;
    const at = st.indexOf(ifs);
    const list = updateNode(holder.list, { statements: [...st.slice(0, at), ...split, ...st.slice(at + 1)] } as Partial<CompoundStmt>);
    cur = rebuild(cur, holder.list, list) as CompoundStmt;
  }
  return {
    rule: 'split', line: targets[0].location?.start.line ?? 0, list: body, group: g.key,
    replacement: cur.statements as Statement[], body: cur,
  };
}

/** The positions of the placed ifs in `roots`. */
function ifPositions(roots: readonly ASTNode[]): Set<string> {
  const out = new Set<string>();
  for (const r of roots) {
    for (const n of traverseAST(r)) {
      if (n.kind === NodeKind.IfStmt && placedIf(n as IfStmt)) out.add(`${n.location.start.line}:${n.location.start.column}`);
    }
  }
  return out;
}

/**
 * The predictor is confident over the region: no if in it abstains, before or after, and the
 * rewritten if is scored after.
 */
function confident(c: Candidate, before: LayoutScore, after: LayoutScore): boolean {
  if (!c.region) return true;
  const where = ifPositions([...c.region.before, ...c.replacement.filter(s => !c.list.statements.includes(s))]);
  const hit = (s: LayoutScore) => s.abstained.some(a => where.has(`${a.line}:${a.column}`));
  if (hit(before) || hit(after)) return false;
  const m = c.region.main.location.start;
  return after.scored.has(`${m.line}:${m.column}`);
}

function candidates(body: CompoundStmt, reader: LayoutReader, opts: SearchOptions): Candidate[] {
  const gotos = gotoCounts(body);
  const out: Candidate[] = [];
  const groups = returnGroups(body);
  for (const g of new Set(groups.values())) {
    const c = g.copy ? splitGroup(body, g, reader) : null;
    if (c) out.push(c);
  }
  for (const entry of lists(body)) {
    const stmts = entry.list.statements;
    for (let i = 0; i < stmts.length; i++) {
      if (stmts[i].kind !== NodeKind.IfStmt) continue;
      const a = returnMerge(entry, i, reader, gotos, opts);
      if (a) out.push(a);
      const b = propagate(entry, i, reader, opts);
      if (b) out.push(b);
      const c = swapIf(entry, i, gotos);
      if (c) out.push(c);
      const d = nestIf(entry, i, gotos, opts);
      if (d) out.push(d);
      const e = joinGuards(entry, i, groups);
      if (e) out.push(e);
    }
  }
  return out;
}

/** The body after the rewrites that lower its layout objective; the input when none does. */
export function layoutSearch(body: CompoundStmt, ev: BranchLayoutEvidence, opts: SearchOptions): CompoundStmt {
  if (!ev.edges) return body;
  let cur = body;
  let full = scoreBody(cur, new LayoutReader(ev, cur), opts.noreturn);
  let score = full.objective;
  const w1 = process.env.GHIDRA_BRANCH_LAYOUT_W1 !== '0';
  for (let round = 0; round < 8 && score > 0; round++) {
    const reader = new LayoutReader(ev, cur);
    let best: { body: CompoundStmt; score: number; full: LayoutScore; c: Candidate } | null = null;
    for (const c of candidates(cur, reader, opts)) {
      if (c.region && !w1) continue;
      const next = c.body ?? rebuild(cur, c.list, updateNode(c.list, { statements: c.replacement } as Partial<CompoundStmt>)) as CompoundStmt;
      const sc = scoreBody(next, new LayoutReader(ev, next), opts.noreturn);
      const s = sc.objective;
      // A join or split must settle its group's copy: not merely drop the guards it touches from the count.
      if (c.group !== undefined && !(full.groups.get(c.group) === false && sc.groups.get(c.group) === true)) continue;
      if (s < (best?.score ?? score) && confident(c, full, sc)) best = { body: next, score: s, full: sc, c };
    }
    if (!best) break;
    opts.onSite?.({ rule: best.c.rule, line: best.c.line, why: `objective ${score} -> ${best.score}` });
    cur = best.body;
    score = best.score;
    full = best.full;
    if (best.c.region) opts.fixed?.add(`${best.c.region.main.location.start.line}:${best.c.region.main.location.start.column}`);
  }
  return cur;
}

export function isVoidFunction(fn: FunctionDecl): boolean {
  const t = fn.returnType;
  return t.kind === NodeKind.BuiltinType && emit(t as unknown as AnyNode).trim() === 'void';
}

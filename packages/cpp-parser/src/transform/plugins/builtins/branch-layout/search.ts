/**
 * Function-level rewrites of the branch-layout pass, each made only where the original's
 * conditional jumps show its pattern, and kept only when the layout objective of the whole
 * function (predict.ts) strictly drops. A greedy search: per round every candidate is tried
 * on the function, the best one is kept, at most eight rounds.
 *
 *   propagate     `if (!x1) return K; T x2 = e(x1); if (!x2) return K; ...` where the earlier
 *                 guards' jumps go forward into the inline copy of the last one: the source
 *                 tested a value it had set to the failing constant on the null path
 *                 (`T x2 = x1 ? e(x1) : 0;`), and VC8 threads the jump through the known
 *                 value. One more definition may sit before x2's (`t = e0;`); it moves into
 *                 the ternary's arm as a comma operand.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, IfStmt, Statement, ReturnStmt, Expression, ExprStmt, DeclStmt, VariableDecl,
  Identifier, UnaryExpr, BinaryExpr, AssignExpr, ParenExpr, TypeNode, AnyNode,
} from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';
import { updateNode } from '../../../transformer.js';
import { Stmt, Expr } from '../../../../ast/factory.js';
import { LayoutReader, isLoop, type BranchLayoutEvidence } from './evidence.js';
import { scoreBody, returnKey } from './predict.js';
import { negate } from './index.js';

export interface SearchOptions {
  noreturn: ReadonlySet<string>;
  /** Declared type of each parameter and local. */
  localTypes: ReadonlyMap<string, TypeNode>;
  /** Names of the enum types, unqualified. */
  enumTypes: ReadonlySet<string>;
  onSite?: (e: { rule: 'propagate'; line: number; why?: string }) => void;
}

interface Candidate {
  rule: 'propagate';
  line: number;
  list: CompoundStmt;
  replacement: Statement[];
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

/** Every statement list of the body, with whether a loop encloses it. */
function lists(body: CompoundStmt): { list: CompoundStmt; inLoop: boolean }[] {
  const out: { list: CompoundStmt; inLoop: boolean }[] = [];
  const go = (n: ASTNode, inLoop: boolean): void => {
    if (n.kind === NodeKind.CompoundStmt) out.push({ list: n as CompoundStmt, inLoop });
    const loop = inLoop || isLoop(n);
    for (const k of getChildren(n)) go(k, loop);
  };
  go(body, false);
  return out;
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

function candidates(body: CompoundStmt, reader: LayoutReader, opts: SearchOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of lists(body)) {
    const stmts = entry.list.statements;
    for (let i = 0; i < stmts.length; i++) {
      if (stmts[i].kind !== NodeKind.IfStmt) continue;
      const b = propagate(entry, i, reader, opts);
      if (b) out.push(b);
    }
  }
  return out;
}

/** The body after the rewrites that lower its layout objective; the input when none does. */
export function layoutSearch(body: CompoundStmt, ev: BranchLayoutEvidence, opts: SearchOptions): CompoundStmt {
  if (!ev.edges) return body;
  let cur = body;
  let score = scoreBody(cur, new LayoutReader(ev, cur), opts.noreturn).objective;
  for (let round = 0; round < 8 && score > 0; round++) {
    const reader = new LayoutReader(ev, cur);
    let best: { body: CompoundStmt; score: number; c: Candidate } | null = null;
    for (const c of candidates(cur, reader, opts)) {
      const list = updateNode(c.list, { statements: c.replacement } as Partial<CompoundStmt>);
      const next = rebuild(cur, c.list, list) as CompoundStmt;
      const s = scoreBody(next, new LayoutReader(ev, next), opts.noreturn).objective;
      if (s < (best?.score ?? score)) best = { body: next, score: s, c };
    }
    if (!best) break;
    opts.onSite?.({ rule: best.c.rule, line: best.c.line, why: `objective ${score} -> ${best.score}` });
    cur = best.body;
    score = best.score;
  }
  return cur;
}

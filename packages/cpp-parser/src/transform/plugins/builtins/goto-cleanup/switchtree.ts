/**
 * Compare tree to switch (design step 8, `switch-tree-recover`). MSVC lowers a sparse
 * switch to a binary search over its case values; Ghidra prints the search as nested ifs
 * on one operand, and every default edge as a goto to the code after the switch:
 *
 *   if (x < 0x188) {                                // QUEST_OnMonsterKilled 00543a30
 *     if (x != 0x187) {
 *       if (x < 0xf2) goto D;
 *       if (0xf3 < x) { Dispatch(); return; }       // the default's tail, duplicated
 *     }
 *   } else if (x != 0x220) goto D;
 *   F;                                              // the cases' arm
 *   D: Dispatch();
 *
 *   ->  switch (x) { case 0xf2: case 0xf3: case 0x187: case 0x220: F; }
 *       D: Dispatch();
 *
 * Accepted only for a tree with a relational test (the binary-search signature; a chain of
 * equalities may as well be an if-chain), on an operand with no effects, whose leaves are:
 * the fall-off into F, `goto D`, or blocks that do not fall through. Each leaf's value set is
 * computed exactly by interval evaluation, under both signed and unsigned readings of every
 * comparison without a cast; the two must agree. Every leaf but D's must have at most
 * MAX_CASES values; a leaf with more is the default's duplicated tail, merged back to
 * `goto D` first under the validator (it proves the tail equal to D's path).
 *
 * The proof: the interval evaluation is the lemma - the tree is `switch (x) { case v:
 * goto leaf(v); ... default: goto D; }` followed by the leaves - and the validator proves
 * that form equal to the switch, whole body.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CompoundStmt, CStyleCastExpr, Expression, GotoStmt, IfStmt, Statement,
} from '../../../../ast/nodes.js';
import { Expr, Stmt } from '../../../../ast/factory.js';
import { emit } from '../../../../emit/index.js';
import { traverseAST } from '../../../../ast/visitor.js';
import { updateNode } from '../../../transformer.js';
import { countGotosInStatements } from './analysis.js';
import { after, dropLabel, fallsThrough, findLabel, freeJumps, getAt, gotoPaths, isCaseLike, setList, type Path } from './paths.js';

const MAX_CASES = 64;
const MAX_PROOF_CASES = 512;
const M32 = 1n << 32n;
const H31 = 1n << 31n;

/** Sorted, disjoint, inclusive intervals of 32-bit patterns. */
type Set32 = [bigint, bigint][];

const FULL: Set32 = [[0n, M32 - 1n]];
function inter(a: Set32, b: Set32): Set32 {
  const out: Set32 = [];
  for (const [l1, h1] of a) for (const [l2, h2] of b) {
    const lo = l1 > l2 ? l1 : l2, hi = h1 < h2 ? h1 : h2;
    if (lo <= hi) out.push([lo, hi]);
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}
function compl(a: Set32): Set32 {
  const out: Set32 = [];
  let at = 0n;
  for (const [lo, hi] of a) { if (lo > at) out.push([at, lo - 1n]); at = hi + 1n; }
  if (at <= M32 - 1n) out.push([at, M32 - 1n]);
  return out;
}
function union(a: Set32, b: Set32): Set32 {
  const all = [...a, ...b].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const out: Set32 = [];
  for (const [lo, hi] of all) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1n) { if (hi > last[1]) last[1] = hi; } else out.push([lo, hi]);
  }
  return out;
}
const size = (a: Set32) => a.reduce((n, [lo, hi]) => n + hi - lo + 1n, 0n);
const same = (a: Set32, b: Set32) => a.length === b.length && a.every(([l, h], i) => l === b[i][0] && h === b[i][1]);

/** The patterns whose reading (signed or not) is in [lo, hi] (mathematical integers). */
function range(lo: bigint, hi: bigint, signed: boolean): Set32 {
  const min = signed ? -H31 : 0n, max = signed ? H31 - 1n : M32 - 1n;
  if (lo < min) lo = min;
  if (hi > max) hi = max;
  if (lo > hi) return [];
  if (!signed || lo >= 0n) return [[lo, hi]];
  // A signed value v < 0 is the pattern v + 2^32.
  const neg: [bigint, bigint] = [lo + M32, (hi < 0n ? hi : -1n) + M32];
  return hi >= 0n ? [[0n, hi], neg] : [neg];
}

type Sign = 'signed' | 'unsigned' | 'any';
interface Test { x: string; op: string; k: bigint; sign: Sign }

const SIGNED = /^(int|int32_t|long|signed|signed int|LONG|INT)$/;
const UNSIGNED = /^(uint|uint32_t|unsigned|unsigned int|ulong|unsigned long|DWORD|UINT|ULONG|size_t)$/;

function strip(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as unknown as { expression: Expression }).expression;
  return e;
}
function literal(e: Expression): bigint | null {
  const x = strip(e);
  if (x.kind === NodeKind.IntegerLiteral) return BigInt((x as unknown as { value: bigint }).value);
  if (x.kind === NodeKind.UnaryExpr && (x as unknown as { operator: string }).operator === '-') {
    const v = literal((x as unknown as { operand: Expression }).operand);
    return v === null ? null : -v;
  }
  return null;
}
/** The operand: a variable, a field path, a constant subscript - nothing with an effect or a call. */
function simpleOperand(e: Expression): boolean {
  for (const n of traverseAST(e as ASTNode)) {
    if (![NodeKind.Identifier, NodeKind.MemberExpr, NodeKind.ParenExpr, NodeKind.SubscriptExpr, NodeKind.IntegerLiteral].includes(n.kind as NodeKind)) return false;
  }
  return true;
}
function operand(e: Expression): { x: string; sign: Sign; expr: Expression } | null {
  let x = strip(e);
  let sign: Sign = 'any';
  if (x.kind === NodeKind.CStyleCastExpr) {
    const t = emit((x as CStyleCastExpr).type as never).replace(/\s+/g, ' ').trim();
    if (SIGNED.test(t)) sign = 'signed';
    else if (UNSIGNED.test(t)) sign = 'unsigned';
    else return null;
    x = strip((x as CStyleCastExpr).expression);
  }
  if (!simpleOperand(x)) return null;
  return { x: emit(x as never).trim(), sign, expr: x };
}
const MIRROR: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
function testOf(cond: Expression): (Test & { expr: Expression }) | null {
  const c = strip(cond);
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  if (!(b.operator in MIRROR)) return null;
  let k = literal(b.right), side = b.left, op = b.operator as string;
  if (k === null) { k = literal(b.left); side = b.right; op = MIRROR[op]; }
  if (k === null) return null;
  const o = operand(side);
  if (!o) return null;
  return { x: o.x, op, k, sign: o.sign, expr: o.expr };
}
/** The patterns satisfying `x op k` under a reading. */
function holds(t: Test, signed: boolean): Set32 {
  const s = t.sign === 'any' ? signed : t.sign === 'signed';
  const min = s ? -H31 : 0n, max = s ? H31 - 1n : M32 - 1n;
  // The literal converts to x's type: reduce it to the reading's range.
  let k = ((t.k % M32) + M32) % M32;
  if (s && k >= H31) k -= M32;
  switch (t.op) {
    case '==': return range(k, k, s);
    case '!=': return compl(range(k, k, s));
    case '<': return range(min, k - 1n, s);
    case '<=': return range(min, k, s);
    case '>': return range(k + 1n, max, s);
    case '>=': return range(k, max, s);
  }
  return [];
}

// ---------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------

type Tree = { kind: 'test'; t: Test; yes: Tree; no: Tree } | { kind: 'leaf'; id: number; stmts: Statement[] };

interface Parse { x: string | null; xExpr: Expression | null; leaves: { stmts: Statement[] }[]; tests: number; relational: boolean }

const asList = (s: Statement | null): Statement[] =>
  !s ? [] : s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements.filter(x => x.kind !== NodeKind.NullStmt) : [s];

function parseSeq(list: Statement[], P: Parse, noreturn: ReadonlySet<string>, depth: number): Tree | null {
  if (depth > 24) return null;
  const leaf = (stmts: Statement[]): Tree => { P.leaves.push({ stmts }); return { kind: 'leaf', id: P.leaves.length - 1, stmts }; };
  const s0 = list[0];
  if (!s0 || s0.kind !== NodeKind.IfStmt) return leaf(list);
  const f = s0 as IfStmt;
  if (f.init || f.isConstexpr) return leaf(list);
  const t = testOf(f.condition);
  if (!t || (P.x !== null && t.x !== P.x)) return leaf(list);
  const rest = list.slice(1);
  const thenList = asList(f.thenBranch);
  let yes: Tree | null, no: Tree | null;
  if (f.elseBranch) {
    // Both arms continue to `rest`: only a tree when nothing follows.
    if (rest.length) return leaf(list);
    yes = parseSeq(thenList, P, noreturn, depth + 1);
    no = parseSeq(asList(f.elseBranch), P, noreturn, depth + 1);
  } else {
    // `if (t) A; rest`: A must not fall through into rest, unless rest is empty.
    if (rest.length && fallsThrough(Stmt.compound(thenList), noreturn)) return leaf(list);
    yes = parseSeq(thenList, P, noreturn, depth + 1);
    no = parseSeq(rest, P, noreturn, depth + 1);
  }
  if (!yes || !no) return null;
  if (P.x === null) { P.x = t.x; P.xExpr = t.expr; }
  P.tests++;
  if (t.op !== '==' && t.op !== '!=') P.relational = true;
  return { kind: 'test', t, yes, no };
}

function evaluate(tree: Tree, set: Set32, signed: boolean, out: Set32[]): void {
  if (tree.kind === 'leaf') { out[tree.id] = union(out[tree.id] ?? [], set); return; }
  const h = holds(tree.t, signed);
  evaluate(tree.yes, inter(set, h), signed, out);
  evaluate(tree.no, inter(set, compl(h)), signed, out);
}

function hasLabelOrCase(stmts: Statement[]): boolean {
  for (const s of stmts) for (const n of traverseAST(s as ASTNode)) if (n.kind === NodeKind.LabelStmt || isCaseLike(n)) return true;
  return false;
}
const isGotoTo = (stmts: Statement[], name: string) =>
  stmts.length === 1 && stmts[0].kind === NodeKind.GotoStmt && (stmts[0] as GotoStmt).label.name === name;

function mkGoto(name: string, at: ASTNode): Statement {
  return { kind: NodeKind.GotoStmt, label: Expr.identifier(name), location: at.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Statement;
}
/** A case value as Ghidra spells constants: decimal below 10, hex from there. */
function caseValue(v: bigint): Expression {
  return Expr.intLiteral(v, v >= 10n ? 16 : 10) as unknown as Expression;
}
/** `case v1: case v2: ... first` over the values, in ascending order, as the parser spells it: siblings. */
function stackCases(values: bigint[], first: Statement): Statement[] {
  return values.map((v, i) => ({
    kind: NodeKind.CaseStmt, value: caseValue(v), statement: i === values.length - 1 ? first : Stmt.null_(),
    location: first.location, leadingTrivia: [], trailingTrivia: [],
  }) as unknown as Statement);
}
function valuesOf(set: Set32): bigint[] {
  const out: bigint[] = [];
  for (const [lo, hi] of set) for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}
function mkSwitch(x: Expression, body: Statement[], at: Statement): Statement {
  return { kind: NodeKind.SwitchStmt, condition: x, body: Stmt.compound(body), location: at.location, leadingTrivia: at.leadingTrivia ?? [], trailingTrivia: [] } as unknown as Statement;
}

export interface SwitchTreeContext {
  noreturn: ReadonlySet<string>;
  /** Proves before -> after, optionally against a lemma-applied before. */
  accept: (before: Statement[], after: Statement[], handler: string, proofBefore?: Statement[], merge?: boolean) => Statement[] | null;
}

/**
 * Rebuild the compare tree whose default edges are the gotos to `name`. Returns the new
 * body (already proven through ctx.accept), or null.
 */
export function switchTree(body: CompoundStmt, name: string, ctx: SwitchTreeContext): { body: CompoundStmt; sites: number } | null {
  const slot = findLabel(body, name);
  if (!slot || slot.wrappers.length !== 1) return null;
  const list0 = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  // The tree sits before D in D's list, or ends a block whose fall-off reaches D (through
  // the ends of the blocks around it): then F is the rest of that block.
  const cands: { listPath: Path; j: number; d: number }[] = [];
  for (let j = slot.k - 1; j >= 0 && j >= slot.k - 12; j--) cands.push({ listPath: slot.list, j, d: slot.k });
  const seen = new Set<string>();
  for (const site of gotoPaths(body, name)) {
    for (let n = site.length - 1; n >= 0; n--) {
      if (site[n].f !== 'statements') continue;
      const lp = site.slice(0, n);
      const key = lp.map(x => `${x.f}${x.i ?? ''}`).join('/') + '#' + site[n].i;
      if (seen.has(key)) continue;
      seen.add(key);
      const l = (getAt(body as ASTNode, lp) as CompoundStmt).statements;
      if (sameList(lp, slot.list)) continue;
      const c = after(body as ASTNode, [...lp, { f: 'statements', i: l.length - 1 }]);
      if (c.k !== 'pos' || !sameList(c.list, slot.list) || c.i !== slot.k) continue;
      cands.push({ listPath: lp, j: site[n].i!, d: l.length });
    }
  }
  for (const c of cands) {
    const list = c.listPath === slot.list ? list0 : (getAt(body as ASTNode, c.listPath) as CompoundStmt).statements;
    const r = tryAt(body, c.listPath, list, c.j, c.d, name, ctx);
    if (r) return r;
  }
  return null;
}

const sameList = (a: Path, b: Path) => a.length === b.length && a.every((s, i) => s.f === b[i].f && s.i === b[i].i);

const TRACE = typeof process !== 'undefined' && process.env?.SWITCHTREE_TRACE === '1';
const no = (why: number): null => { if (TRACE) console.error(`[switchtree] declined at ${why}`); return null; };

function tryAt(body: CompoundStmt, listPath: Path, list: Statement[], j: number, d: number, name: string, ctx: SwitchTreeContext): { body: CompoundStmt; sites: number } | null {
  const S = list[j];
  if (S.kind !== NodeKind.IfStmt) return no(1);
  const F = list.slice(j + 1, d);
  if (hasLabelOrCase(F) || F.some(s => !fallsThrough(s, ctx.noreturn)) || freeJumps(F).brk) return no(2);
  const P: Parse = { x: null, xExpr: null, leaves: [], tests: 0, relational: false };
  const tree = parseSeq([S], P, ctx.noreturn, 0);
  if (!tree || tree.kind !== 'test' || P.tests < 2 || !P.relational || !P.xExpr) return no(3);
  // Leaves: the fall-off into F, `goto D`, or blocks that do not fall through.
  const kinds = P.leaves.map(l => (l.stmts.length === 0 ? 'F' : isGotoTo(l.stmts, name) ? 'D' : 'own'));
  for (let i = 0; i < P.leaves.length; i++) {
    const st = P.leaves[i].stmts;
    if (kinds[i] !== 'own') continue;
    if (hasLabelOrCase(st) || freeJumps(st).brk || fallsThrough(Stmt.compound(st), ctx.noreturn)) return no(4);
  }
  if (!kinds.includes('D')) return no(5);
  // The value sets, under both readings; they must agree.
  const sets: Set32[][] = [true, false].map(signed => { const out: Set32[] = []; evaluate(tree, FULL, signed, out); return out; });
  // Agreement is per class: every `goto D` leaf is one destination, so is every fall-off.
  const classOf = (i: number) => (kinds[i] === 'own' ? `own${i}` : kinds[i]);
  const classSets = (r: number) => {
    const m = new Map<string, Set32>();
    P.leaves.forEach((_, i) => m.set(classOf(i), union(m.get(classOf(i)) ?? [], sets[r][i] ?? [])));
    return m;
  };
  const c0 = classSets(0), c1 = classSets(1);
  for (const [k, v] of c0) if (!same(v, c1.get(k) ?? [])) return no(6);
  const setOf = (i: number) => (kinds[i] === 'own' ? sets[0][i] ?? [] : c0.get(kinds[i]) ?? []);
  // An own leaf that spells D's path is the default's tail, duplicated by the compiler:
  // merge it back to `goto D` (stage 1, proven by the validator). A large own leaf that
  // is not one cannot become cases.
  const dRun = runFrom(body, name, ctx.noreturn);
  const isDTail = (st: Statement[]) => !!dRun && st.length === dRun.length && st.every((x, k) => text(x) === dRun[k]);
  const merge = P.leaves.map((l, i) => kinds[i] === 'own' && isDTail(l.stmts));
  if (P.leaves.some((_, i) => kinds[i] === 'own' && !merge[i] && size(setOf(i)) > BigInt(MAX_CASES))) return no(13);
  let cur = body;
  if (merge.some(Boolean)) {
    const leafStmts = new Set(P.leaves.filter((_, i) => merge[i]).map(l => l.stmts[0]));
    const replaced = replaceLeaves(S, leafStmts, name);
    if (!replaced) return no(7);
    const before1 = cur.statements;
    const after1 = (setList(cur as ASTNode, listPath, [...list.slice(0, j), replaced, ...list.slice(j + 1)]) as CompoundStmt).statements;
    const kept = ctx.accept(before1, after1, 'structure:switchTreeMerge', undefined, true);
    if (!kept) return no(8);
    cur = updateNode(cur, { statements: kept });
    for (let i = 0; i < kinds.length; i++) if (merge[i]) kinds[i] = 'D';
  }
  // Every leaf but D's is a small set; F's and the own leaves' values become cases.
  const caseValues = new Set<bigint>();
  const groups: { values: bigint[]; stmts: Statement[] | null }[] = [];
  let fValues: bigint[] = [];
  let fSeen = false;
  for (let i = 0; i < P.leaves.length; i++) {
    if (kinds[i] === 'D') continue;
    if (kinds[i] === 'F') { if (fSeen) continue; fSeen = true; }
    if (size(setOf(i)) > BigInt(MAX_CASES)) return no(9);
    const vs = valuesOf(setOf(i));
    if (vs.some(v => v >= H31)) return no(10);
    for (const v of vs) caseValues.add(v);
    if (kinds[i] === 'F') fValues = [...fValues, ...vs];
    else if (vs.length) groups.push({ values: vs, stmts: P.leaves[i].stmts });
  }
  if (!F.length && fValues.length) {
    // An empty F: its values reach D like the default does.
    for (const v of fValues) caseValues.delete(v);
    fValues = [];
  }
  if (!groups.length && !fValues.length) return no(11);
  fValues.sort((a, b) => (a < b ? -1 : 1));
  groups.sort((a, b) => (a.values[0] < b.values[0] ? -1 : 1));
  for (const g of groups) g.values.sort((a, b) => (a < b ? -1 : 1));

  // The lemma-applied before: dispatch, then the leaves as labelled blocks, then F, then D.
  const curList = (getAt(cur as ASTNode, listPath) as CompoundStmt).statements;
  const S1 = curList[j];
  const fLabel = `__switchtree_F_${name}`;
  const proofDispatch: Statement[] = [];
  const proofLeaves: Statement[] = [];
  let proofCases = 0;
  groups.forEach((g, gi) => {
    const L = `__switchtree_${gi}_${name}`;
    proofDispatch.push(...stackCases(g.values, mkGoto(L, S1)));
    proofCases += g.values.length;
    proofLeaves.push(Stmt.label(L, Stmt.compound(g.stmts!)));
  });
  if (fValues.length) { proofDispatch.push(...stackCases(fValues, mkGoto(fLabel, S1))); proofCases += fValues.length; }
  if (proofCases > MAX_PROOF_CASES) return no(12);
  proofDispatch.push({ kind: NodeKind.DefaultStmt, statement: mkGoto(name, S1), location: S1.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Statement);
  const xExpr = P.xExpr;
  const proofList = [
    ...curList.slice(0, j),
    mkSwitch(xExpr, proofDispatch, S1),
    ...proofLeaves,
    ...(fValues.length ? [Stmt.label(fLabel, F[0]), ...F.slice(1)] : F),
    ...curList.slice(d),
  ];
  const proofBefore = (setList(cur as ASTNode, listPath, proofList) as CompoundStmt).statements;

  // The switch: the own arms, then F's cases with F; D's values fall out of it to D.
  const arms: Statement[] = [];
  for (const g of groups) {
    const st = g.stmts!;
    arms.push(...stackCases(g.values, st[0]), ...st.slice(1));
  }
  if (fValues.length) arms.push(...stackCases(fValues, F[0]), ...F.slice(1));
  // D keeps its label only for gotos from elsewhere.
  const sw = mkSwitch(xExpr, arms, S1);
  const afterList = [...curList.slice(0, j), sw, ...curList.slice(d)];
  let afterBody = setList(cur as ASTNode, listPath, afterList) as CompoundStmt;
  const left = countGotosInStatements(afterBody.statements).get(name) ?? 0;
  if (left === 0) {
    const ds = findLabel(afterBody, name);
    if (!ds) return no(12);
    const al = (getAt(afterBody as ASTNode, ds.list) as CompoundStmt).statements;
    afterBody = setList(afterBody as ASTNode, ds.list, [...al.slice(0, ds.k), dropLabel(al[ds.k], name), ...al.slice(ds.k + 1)]) as CompoundStmt;
  }
  const kept = ctx.accept(cur.statements, afterBody.statements, 'structure:switchTree', proofBefore);
  if (!kept) return no(13);
  const before = countGotosInStatements(body.statements).get(name) ?? 0;
  return { body: updateNode(cur, { statements: kept }), sites: before - left };
}

const text = (s: Statement) => emit(s as never).replace(/\s+/g, ' ').trim();

/** The statements from label `name` up to and including the first that does not fall through. */
function runFrom(body: CompoundStmt, name: string, noreturn: ReadonlySet<string>): string[] | null {
  const slot = findLabel(body, name);
  if (!slot) return null;
  const list = (getAt(body as ASTNode, slot.list) as CompoundStmt).statements;
  const out: string[] = [];
  const run = [slot.inner, ...list.slice(slot.k + 1)];
  for (const s of run) {
    if (s.kind === NodeKind.LabelStmt || isCaseLike(s as ASTNode)) return null;
    out.push(text(s));
    if (!fallsThrough(s, noreturn)) return out.length <= 4 ? out : null;
  }
  return null;
}

/** S with each leaf whose first statement is in `firsts` replaced by `goto name;`. */
function replaceLeaves(S: Statement, firsts: Set<Statement>, name: string): Statement | null {
  let n = 0;
  const go = (s: Statement): Statement => {
    if (s.kind === NodeKind.IfStmt) {
      const f = s as IfStmt;
      return updateNode(f, { thenBranch: goList(f.thenBranch), elseBranch: f.elseBranch ? goList(f.elseBranch) : null });
    }
    return s;
  };
  const goList = (s: Statement): Statement => {
    const l = s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
    const nonNull = l.filter(x => x.kind !== NodeKind.NullStmt);
    if (nonNull.length && firsts.has(nonNull[0])) { n++; return Stmt.compound([mkGoto(name, nonNull[0])]); }
    const out = l.map((x, i) => (firsts.has(x) ? (n++, mkGoto(name, x)) : x.kind === NodeKind.IfStmt ? go(x) : x));
    // A replaced statement followed by more of the same leaf: drop the rest.
    const cut = out.findIndex((x, i) => firsts.has(l[i]));
    const kept = cut >= 0 ? out.slice(0, cut + 1) : out;
    return s.kind === NodeKind.CompoundStmt ? updateNode(s as CompoundStmt, { statements: kept }) : (kept.length === 1 ? kept[0] : Stmt.compound(kept));
  };
  const r = go(S);
  return n === firsts.size ? r : null;
}


/**
 * Rotated For Loop Plugin
 *
 * VC8 compiles `for (i = X; C; step) { B }` as the initialisation, a test of C, and a
 * loop that tests at its bottom. Ghidra prints that back rotated, with the
 * initialisation inside the test or as the statement ahead of it:
 *
 *   if (G) { i = X; do { B; step; } while (C); }   ->   for (i = X; C; step) { B }
 *   i = X; if (G) { do { B; step; } while (C); }   ->   for (i = X; C; step) { B }
 *
 * Compiled again, the rotated form puts the test first and the initialisation after it,
 * where the original has it before (InitPal, 00476ea0). The for loop is laid out as the
 * original. An initialisation ahead of the `if` would compile as the original does, but
 * it does not stay there: when only the loop reads the counter, decl-scope-sink (62) sinks
 * it into the guarded block, which is the first form again. Ghidra prints InitPal itself
 * that way, so both forms become the for loop here.
 *
 * The two mean the same only when all of this holds, so each is checked:
 *   - the `if` has no else, and its block holds the do-while only, after the
 *     initialisation unless that stands ahead of the `if`;
 *   - G is C with X in place of i (operands of a comparison may be swapped, `(&a)->m` is
 *     `a.m`, `a[0].m` is `a->m`), and X and C
 *     have no side effects, C no `&&`/`||`/`?:` - so X is read by G wherever the for loop
 *     reads it, and the first test of the for loop is G;
 *   - X has i's type, or is an integer constant whose value and conversions i keeps
 *     (an `unsigned int` i only against an unsigned bound);
 *   - i is a local or parameter. An assignment inside the test is read nowhere outside
 *     the `if` - the for loop assigns it even when the loop does not run; ahead of the
 *     test it runs either way. A declaration ahead of the test moves into the for, so i
 *     is then read nowhere outside the `if` either;
 *   - the do-while body ends in the step, an assignment or increment of i, and has no
 *     `continue` of its own (in a for loop that would run the step);
 *   - no goto outside the loop jumps into its body.
 *
 * Two loops mean the same as a for loop but did not compile from one, and stay as
 * they are, which VC8 lays out as the original:
 *   - a bound computed from other values (`i < n >> 8`, MONSTER_PreloadSequenceAnimations,
 *     004afb60) that the guard and the test both print from one instruction: the original
 *     computed it once, into a variable, and the for loop computes it in another order.
 *     Where the original's offsets show the test computing it again (or there are none
 *     to show it) the bound is the for loop's own;
 *   - a body that opens with `if (b) break;` ahead of more statements (zlib's syncsearch,
 *     0042b300: `while (next < len && got < 4)`). That is a second exit test the
 *     original has in its condition; the for loop gives the break its own exit.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  CompoundStmt,
  DeclStmt,
  DoWhileStmt,
  Expression,
  ExprStmt,
  ForStmt,
  FunctionDecl,
  GotoStmt,
  Identifier,
  IfStmt,
  IntegerLiteralExpr,
  LabelStmt,
  MemberExpr,
  MethodDecl,
  ParenExpr,
  PostfixExpr,
  Statement,
  SubscriptExpr,
  UnaryExpr,
  VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import { cloneNode, createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import type { TypeShape, TypedefResolver } from './call-arg-cast.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';

const RELATIONAL_MIRROR: Record<string, string> = {
  '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=',
};

/** Bases a promoted operand stays exact in, with the range a constant must lie in. */
const SMALL_RANGE: Record<string, [bigint, bigint]> = {
  'char': [-128n, 127n],
  'signed char': [-128n, 127n],
  'unsigned char': [0n, 255n],
  'short': [-32768n, 32767n],
  'unsigned short': [0n, 65535n],
};
const INT_SIGNED = new Set(['int', 'long', 'intptr_t', 'ssize_t']);
const INT_UNSIGNED = new Set(['unsigned int', 'unsigned long', 'uintptr_t', 'size_t', 'pointer32']);
const UNSIGNED_BASES = new Set([...INT_UNSIGNED, 'unsigned char', 'unsigned short', 'unsigned long long']);

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

const IGNORED_KEYS = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'ghidraInfo', 'raw']);

/** Structural equality that ignores parentheses, trivia and locations. */
export function sameExpr(a: ASTNode, b: ASTNode): boolean {
  if (a.kind === NodeKind.ParenExpr) return sameExpr((a as ParenExpr).expression, b);
  if (b.kind === NodeKind.ParenExpr) return sameExpr(a, (b as ParenExpr).expression);
  if (a.kind !== b.kind) return false;
  const ra = a as unknown as Record<string, unknown>, rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (IGNORED_KEYS.has(k)) continue;
    const va = ra[k], vb = rb[k];
    const prim = (v: unknown) => v === undefined || v === null || typeof v !== 'object';
    if (prim(va) || prim(vb)) {
      if (va !== vb) return false;
    } else if (Array.isArray(va) && Array.isArray(vb) && va.length !== vb.length) {
      return false;
    }
  }
  const ca = getChildren(a), cb = getChildren(b);
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) if (!sameExpr(ca[i], cb[i])) return false;
  return true;
}

/** One spelling for the same member access: `(&a)->m` is `a.m`, `(*a).m` and `a[0].m` are `a->m`. */
const canonicalMembers: Transformer = createTransformer({
  visitMemberExpr(m: MemberExpr): ASTNode | undefined {
    const obj = unwrapParens(m.object);
    if (m.isArrow && obj.kind === NodeKind.UnaryExpr && (obj as UnaryExpr).operator === '&') {
      return { ...m, object: (obj as UnaryExpr).operand, isArrow: false } as MemberExpr;
    }
    if (!m.isArrow && obj.kind === NodeKind.UnaryExpr && (obj as UnaryExpr).operator === '*') {
      return { ...m, object: (obj as UnaryExpr).operand, isArrow: true } as MemberExpr;
    }
    if (!m.isArrow && obj.kind === NodeKind.SubscriptExpr && intLiteral((obj as SubscriptExpr).index) === 0n) {
      return { ...m, object: (obj as SubscriptExpr).array, isArrow: true } as MemberExpr;
    }
    return undefined;
  },
});

function sameValue(a: Expression, b: Expression): boolean {
  return sameExpr(canonicalMembers(a), canonicalMembers(b));
}

/** No call, assignment, increment, `new`/`delete`, `&&`/`||`/`?:` or comma. */
function isPlainPure(e: ASTNode): boolean {
  switch (e.kind) {
    case NodeKind.CallExpr:
    case NodeKind.AssignExpr:
    case NodeKind.PostfixExpr:
    case NodeKind.ConditionalExpr:
    case NodeKind.CommaExpr:
      return false;
    case NodeKind.UnaryExpr: {
      const op = (e as UnaryExpr).operator;
      if (op === '++' || op === '--') return false;
      break;
    }
    case NodeKind.BinaryExpr: {
      const op = (e as BinaryExpr).operator;
      if (op === '&&' || op === '||') return false;
      break;
    }
    default:
      if (String(e.kind) === 'NewExpr' || String(e.kind) === 'DeleteExpr' || String(e.kind) === 'SizeofExpr') return false;
  }
  for (const c of getChildren(e)) if (!isPlainPure(c)) return false;
  return true;
}

function mentions(e: ASTNode, name: string): boolean {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name === name;
  if (e.kind === NodeKind.MemberExpr) return mentions((e as unknown as { object: ASTNode }).object, name);
  for (const c of getChildren(e)) if (mentions(c, name)) return true;
  return false;
}

/** Count of `name` read or written in `n` (a declaration's own name is not counted). */
function countRefs(n: ASTNode, name: string): number {
  if (n.kind === NodeKind.Identifier) return (n as Identifier).name === name ? 1 : 0;
  if (String(n.kind).endsWith('Type') || n.kind === NodeKind.QualifiedId) return 0;
  if (n.kind === NodeKind.MemberExpr) return countRefs((n as unknown as { object: ASTNode }).object, name);
  if (n.kind === NodeKind.VariableDecl) {
    const init = (n as VariableDecl).initializer;
    return init ? countRefs(init as ASTNode, name) : 0;
  }
  let k = 0;
  for (const c of getChildren(n)) k += countRefs(c, name);
  return k;
}

/** `e` with every identifier `name` replaced by a copy of `by` (member names are not identifiers here). */
function substitute(e: Expression, name: string, by: Expression): Expression {
  const go = (n: ASTNode): ASTNode => {
    if (n.kind === NodeKind.Identifier) return (n as Identifier).name === name ? cloneNode(by) : n;
    if (String(n.kind).endsWith('Type')) return n;
    const out: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>) };
    for (const [k, val] of Object.entries(out)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'ghidraInfo') continue;
      if (n.kind === NodeKind.MemberExpr && k === 'member') continue;
      if (Array.isArray(val)) {
        out[k] = val.map(x => (x && typeof x === 'object' && 'kind' in x ? go(x as ASTNode) : x));
      } else if (val && typeof val === 'object' && 'kind' in (val as object)) {
        out[k] = go(val as ASTNode);
      }
    }
    return out as unknown as ASTNode;
  };
  return go(e) as Expression;
}

function intLiteral(e: Expression): bigint | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.IntegerLiteral) {
    const l = u as IntegerLiteralExpr;
    return l.suffix ? null : l.value;
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
    const v = intLiteral((u as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  return null;
}

function sameShape(a: TypeShape, b: TypeShape): boolean {
  return a.base === b.base && a.stars === b.stars;
}

/** The comparison `C` reduced to (operator, the operand other than `v`), when `v` is one side. */
function boundOf(c: Expression, v: string): Expression | null {
  const u = unwrapParens(c);
  if (u.kind !== NodeKind.BinaryExpr) return null;
  const b = u as BinaryExpr;
  if (!(b.operator in RELATIONAL_MIRROR)) return null;
  const isV = (x: Expression) => {
    const y = unwrapParens(x);
    return y.kind === NodeKind.Identifier && (y as Identifier).name === v;
  };
  if (isV(b.left) && !mentions(b.right, v)) return b.right;
  if (isV(b.right) && !mentions(b.left, v)) return b.left;
  return null;
}

/**
 * Whether `v = x` followed by reading `v` in `c` gives the value `c` has with `x` in place
 * of `v`: the same type, or a constant `v` holds and that converts as `v` does there.
 */
function initKeepsConversions(v: string, x: Expression, c: Expression, shapeOf: ExprShape): boolean {
  const vs = shapeOf({ kind: NodeKind.Identifier, name: v } as unknown as Identifier);
  if (!vs) return false;
  const lit = intLiteral(x);
  if (lit === null) {
    const xs = shapeOf(x);
    return !!xs && sameShape(vs, xs);
  }
  if (vs.stars > 0) return false;
  if (INT_SIGNED.has(vs.base)) return lit >= -(2n ** 31n) && lit < 2n ** 31n;
  const range = SMALL_RANGE[vs.base];
  if (range) return lit >= range[0] && lit <= range[1];
  if (INT_UNSIGNED.has(vs.base)) {
    // `0 < n` and `i < n` agree only when the bound converts unsigned as well.
    if (lit < 0n || lit >= 2n ** 31n) return false;
    const bound = boundOf(c, v);
    if (!bound) return false;
    const bs = shapeOf(bound);
    return !!bs && bs.stars === 0 && UNSIGNED_BASES.has(bs.base);
  }
  return false;
}

/** Whether `g` is `c` with `x` for `v`, a comparison's operands possibly swapped. */
function guardIsFirstTest(g: Expression, c: Expression, v: string, x: Expression): boolean {
  const first = substitute(c, v, x);
  if (sameValue(g, first)) return true;
  const u = unwrapParens(first);
  if (u.kind !== NodeKind.BinaryExpr) return false;
  const b = u as BinaryExpr;
  const mirror = RELATIONAL_MIRROR[b.operator];
  if (!mirror) return false;
  const swapped = { ...b, operator: mirror, left: b.right, right: b.left } as BinaryExpr;
  return sameValue(g, swapped);
}

/** The `v = x` initialisation, as an assignment or a one-variable declaration. */
function initOf(s: Statement): { v: string; x: Expression; declares: boolean } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrapParens((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr) return null;
    const a = e as AssignExpr;
    const l = unwrapParens(a.left);
    if (a.operator !== '=' || l.kind !== NodeKind.Identifier) return null;
    return { v: (l as Identifier).name, x: a.right, declares: false };
  }
  if (s.kind === NodeKind.DeclStmt) {
    const d = s as DeclStmt;
    if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const vd = d.declarations[0] as VariableDecl;
    if (!vd.initializer || vd.directInit || vd.bitWidth || vd.specifiers.length > 0) return null;
    if ((vd.initializer as ASTNode).kind === NodeKind.InitListExpr) return null;
    if (vd.type.kind === NodeKind.ArrayType) return null;
    return { v: vd.name.name, x: vd.initializer as Expression, declares: true };
  }
  return null;
}

/** The step expression of a statement that assigns or increments `v`, else null. */
function stepOf(s: Statement, v: string): Expression | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((s as ExprStmt).expression);
  const isV = (x: Expression) => {
    const y = unwrapParens(x);
    return y.kind === NodeKind.Identifier && (y as Identifier).name === v;
  };
  if (e.kind === NodeKind.PostfixExpr && isV((e as PostfixExpr).operand)) return e;
  if (e.kind === NodeKind.UnaryExpr) {
    const u = e as UnaryExpr;
    if ((u.operator === '++' || u.operator === '--') && isV(u.operand)) return e;
  }
  if (e.kind === NodeKind.AssignExpr && isV((e as AssignExpr).left)) {
    const r = (e as AssignExpr).right;
    if (r.kind === NodeKind.CommaExpr || r.kind === NodeKind.AssignExpr) return null;
    return e;
  }
  return null;
}

const LOOP_KINDS = new Set<NodeKind>([NodeKind.ForStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForRangeStmt]);

/** A value read as it is: names, constants, members, elements and dereferences, through casts. */
function isPlainRead(e: Expression): boolean {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier:
    case NodeKind.IntegerLiteral:
    case NodeKind.CharLiteral:
    case NodeKind.NullptrLiteral:
      return true;
    case NodeKind.MemberExpr:
      return isPlainRead((u as MemberExpr).object);
    case NodeKind.SubscriptExpr:
      return isPlainRead((u as SubscriptExpr).array) && isPlainRead((u as SubscriptExpr).index);
    case NodeKind.UnaryExpr:
      if ((u as UnaryExpr).operator === '-') return intLiteral(u as Expression) !== null;
      return (u as UnaryExpr).operator === '*' && isPlainRead((u as UnaryExpr).operand);
    case NodeKind.CStyleCastExpr:
      return isPlainRead((u as unknown as { expression: Expression }).expression);
    default:
      return false;
  }
}

/**
 * Whether the guard and the test print an instruction in common, from the original's
 * offsets per line; without them, the computed bound is taken to be one value.
 */
function computedOnce(ifs: IfStmt, test: Expression, layout: BranchLayoutEvidence | null | undefined): boolean {
  const line = (n: ASTNode) => (n.location && n.location.file !== '<generated>' && n.location.start.line > 0 ? n.location.start.line : null);
  const g = line(ifs.condition) ?? line(ifs), t = line(test);
  if (!layout || g === null || t === null || g === t) return true;
  const go = layout.lines.get(g), to = layout.lines.get(t);
  if (!go || !to) return true;
  return go.some(o => to.includes(o));
}

/** Whether the body's first statement is `if (b) break;` and more statements follow it. */
function opensWithBreakTest(inner: Statement[]): boolean {
  if (inner.length < 2 || inner[0].kind !== NodeKind.IfStmt) return false;
  const ifs = inner[0] as IfStmt;
  if (ifs.elseBranch !== null) return false;
  let th: Statement = ifs.thenBranch;
  if (th.kind === NodeKind.CompoundStmt) {
    const st = (th as CompoundStmt).statements;
    if (st.length !== 1) return false;
    th = st[0];
  }
  return th.kind === NodeKind.BreakStmt;
}

/** Whether `n` holds a `continue` that belongs to the loop `n` is the body of. */
function hasOwnContinue(n: ASTNode): boolean {
  if (n.kind === NodeKind.ContinueStmt) return true;
  if (LOOP_KINDS.has(n.kind)) return false;
  for (const c of getChildren(n)) if (hasOwnContinue(c)) return true;
  return false;
}

function labelsIn(n: ASTNode, out: Set<string>): Set<string> {
  if (n.kind === NodeKind.LabelStmt) out.add((n as LabelStmt).label.name);
  for (const c of getChildren(n)) labelsIn(c, out);
  return out;
}

function gotoTargets(n: ASTNode, skip: ASTNode, out: Set<string>): Set<string> {
  if (n === skip) return out;
  if (n.kind === NodeKind.GotoStmt) out.add((n as GotoStmt).label.name);
  for (const c of getChildren(n)) gotoTargets(c, skip, out);
  return out;
}

function hasComment(n: ASTNode): boolean {
  return [...(n.leadingTrivia ?? []), ...(n.trailingTrivia ?? [])]
    .some(t => t.kind === TriviaKind.LineComment || t.kind === TriviaKind.BlockComment);
}

function ifKey(n: ASTNode): string | null {
  const s = n.location?.start;
  return s && typeof s.offset === 'number' ? `${s.offset}:${s.line}` : null;
}

/** A rotated loop's counter, and whether its initialisation stands ahead of the `if`. */
interface Site { v: string; ahead: boolean }

/**
 * The initialisation and the do-while of a rotated loop: both in the `if` block, or the
 * initialisation as the statement `ahead` of an `if` whose block holds the do-while only.
 */
function loopParts(ifs: IfStmt, ahead: Statement | null): { init: Statement; loop: DoWhileStmt; ahead: boolean } | null {
  if (ifs.thenBranch.kind !== NodeKind.CompoundStmt) return null;
  const stmts = (ifs.thenBranch as CompoundStmt).statements;
  if (stmts.length === 2 && stmts[1].kind === NodeKind.DoWhileStmt) {
    return { init: stmts[0], loop: stmts[1] as DoWhileStmt, ahead: false };
  }
  if (stmts.length === 1 && stmts[0].kind === NodeKind.DoWhileStmt && ahead) {
    return { init: ahead, loop: stmts[0] as DoWhileStmt, ahead: true };
  }
  return null;
}

/** The rotated loops of one function body, keyed by the `if`'s position. */
function findSites(
  body: CompoundStmt, shapeOf: ExprShape, locals: ReadonlySet<string>, layout: BranchLayoutEvidence | null | undefined,
): Map<string, Site> {
  const sites = new Map<string, Site>();
  const seen = new Map<string, number>();
  // `ahead` is the statement before `n` in its block, where it has one.
  const visit = (n: ASTNode, ahead: Statement | null): void => {
    if (n.kind === NodeKind.IfStmt) {
      const k = ifKey(n);
      if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
      const site = matchSite(n as IfStmt, ahead, body, shapeOf, locals, layout);
      if (site && k) sites.set(k, site);
    }
    if (n.kind === NodeKind.CompoundStmt) {
      const stmts = (n as CompoundStmt).statements;
      stmts.forEach((s, i) => visit(s, i > 0 ? stmts[i - 1] : null));
      return;
    }
    for (const c of getChildren(n)) visit(c, null);
  };
  visit(body, null);
  for (const [k, count] of seen) if (count > 1) sites.delete(k);
  return sites;
}

function matchSite(
  ifs: IfStmt, ahead: Statement | null, body: CompoundStmt, shapeOf: ExprShape, locals: ReadonlySet<string>,
  layout: BranchLayoutEvidence | null | undefined,
): Site | null {
  if (ifs.elseBranch !== null || ifs.isConstexpr || ifs.init) return null;
  const parts = loopParts(ifs, ahead);
  if (!parts) return null;
  const init = initOf(parts.init);
  if (!init || hasComment(parts.init) || hasComment(parts.loop)) return null;
  // Ahead of the `if`, the for loop takes the initialisation's place: a comment on the
  // `if` would have to move with it.
  if (parts.ahead && hasComment(ifs)) return null;
  const { v, x, declares } = init;
  const loop = parts.loop;
  const c = loop.condition;

  if (!declares && !locals.has(v)) return null;
  if (!mentions(c, v) || mentions(x, v)) return null;
  if (!isPlainPure(x) || !isPlainPure(c) || !isPlainPure(ifs.condition)) return null;
  if (!guardIsFirstTest(ifs.condition, c, v, x)) return null;
  if (!declares && !initKeepsConversions(v, x, c, shapeOf)) return null;
  if (declares) {
    const vd = (parts.init as DeclStmt).declarations[0] as VariableDecl;
    const local = createExprShape(new Map([[v, vd.type]]), {});
    if (!initKeepsConversions(v, x, c, (e) => (e.kind === NodeKind.Identifier && (e as Identifier).name === v ? local(e) : shapeOf(e)))) return null;
  }

  // The step closes the body; nothing in the body may skip to the test past it.
  const inner = loop.body.kind === NodeKind.CompoundStmt ? (loop.body as CompoundStmt).statements : [loop.body];
  if (inner.length === 0) return null;
  const last = inner[inner.length - 1];
  if (!stepOf(last, v) || hasComment(last)) return null;
  if (hasOwnContinue(loop.body)) return null;
  if (opensWithBreakTest(inner.slice(0, -1))) return null;
  const bound = boundOf(c, v);
  if (bound && !isPlainRead(bound) && computedOnce(ifs, c, layout)) return null;

  // Read after the loop, an assignment inside the test would leave `v` holding X where
  // the guard was false; ahead of the test it runs either way. A declaration ahead of the
  // test moves into the for, out of reach of the rest of its block.
  if ((parts.ahead ? declares : !declares) && countRefs(body, v) !== countRefs(ifs, v)) return null;

  const labels = labelsIn(loop.body, new Set());
  if (labels.size > 0) {
    const from = gotoTargets(body, loop.body, new Set());
    for (const l of labels) if (from.has(l)) return null;
  }
  return { v, ahead: parts.ahead };
}

/** The for loop of a site; `ahead` is the statement before the `if`, for a site that has its initialisation there. */
function rewrite(ifs: IfStmt, site: Site, ahead: Statement | null = null): ForStmt | null {
  const parts = loopParts(ifs, ahead);
  if (!parts || parts.ahead !== site.ahead) return null;
  const loop = parts.loop;
  const bodyStmt = loop.body;
  const inner = bodyStmt.kind === NodeKind.CompoundStmt ? (bodyStmt as CompoundStmt).statements : [bodyStmt];
  const step = inner.length > 0 ? stepOf(inner[inner.length - 1], site.v) : null;
  if (!step) return null;
  const rest = inner.slice(0, -1);
  const newBody: CompoundStmt = bodyStmt.kind === NodeKind.CompoundStmt
    ? updateNode(bodyStmt as CompoundStmt, { statements: rest })
    : { kind: NodeKind.CompoundStmt, statements: rest, location: bodyStmt.location, leadingTrivia: [], trailingTrivia: [] } as CompoundStmt;
  const init: Statement = { ...parts.init, leadingTrivia: [], trailingTrivia: [] };
  const first = parts.ahead ? parts.init : ifs;
  return {
    kind: NodeKind.ForStmt,
    init,
    condition: loop.condition,
    increment: { ...step, leadingTrivia: [], trailingTrivia: [] } as Expression,
    body: newBody,
    location: first.location,
    leadingTrivia: first.leadingTrivia ?? [],
    trailingTrivia: ifs.trailingTrivia ?? [],
  } as ForStmt;
}

export interface RotatedForLoopOptions extends PluginOptions {
  enumTypes?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** The original's code offsets per line (branch-layout): whether a computed bound is computed once. */
  branchLayout?: BranchLayoutEvidence | null;
}

export function createRotatedForLoopTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as RotatedForLoopOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  const perFunction = (fn: FunctionDecl | MethodDecl): ASTNode | undefined => {
    if (!fn.body) return undefined;
    const localTypes = localTypesOf(fn as FunctionDecl);
    const shapeOf = createExprShape(localTypes, {
      globalTypes: o.globalTypes ?? {},
      enclosingVarTypes: o.enclosingVarTypes ?? {},
      structFields: o.structFields ?? {},
      fieldTypes: o.fieldTypes ?? {},
      returnTypes: o.functionReturnTypes ?? {},
      resolve,
    });
    const sites = findSites(fn.body, shapeOf, new Set(localTypes.keys()), o.branchLayout);
    if (sites.size === 0) return undefined;
    const body = createTransformer({
      visitIfStmt(node: IfStmt): ASTNode | undefined {
        const k = ifKey(node);
        const site = k ? sites.get(k) : undefined;
        return site && !site.ahead ? rewrite(node, site) ?? undefined : undefined;
      },
      // A loop whose initialisation stands ahead of the `if` takes the place of both.
      visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
        const stmts = node.statements;
        let out: Statement[] | null = null;
        for (let i = 0; i < stmts.length; i++) {
          const next = stmts[i + 1];
          const k = next?.kind === NodeKind.IfStmt ? ifKey(next) : null;
          const site = k ? sites.get(k) : undefined;
          const loop = site?.ahead ? rewrite(next as IfStmt, site, stmts[i]) : null;
          if (loop) {
            out ??= stmts.slice(0, i);
            out.push(loop);
            i++;
            continue;
          }
          out?.push(stmts[i]);
        }
        return out ? updateNode(node, { statements: out }) : undefined;
      },
    })(fn.body) as CompoundStmt;
    return updateNode(fn, { body } as Partial<FunctionDecl>);
  };

  return createTransformer({
    visitFunctionDecl: (n: FunctionDecl) => perFunction(n),
    visitMethodDecl: (n: MethodDecl) => perFunction(n),
  });
}

/**
 * Rotated For Loop Plugin
 *
 * `if (G) { i = X; do { B; step; } while (C); }` and `i = X; if (G) { do { B; step; } while (C); }`
 * -> `for (i = X; C; step) { B }` where G is the loop's first test.
 */
export const rotatedForLoopPlugin: TransformPlugin = {
  id: 'rotated-for-loop',
  name: 'Rotated For Loop',
  description: 'if (G) { i = X; do { B; step; } while (C); }, or i = X; ahead of the if -> for (i = X; C; step) { B } where G is C at i = X',
  version: '1.1.0',
  defaultEnabled: true,
  priority: 56, // after goto-cleanup (55), before short-circuit-fold (57) merges the guard away
  tags: ['cleanup', 'control-flow', 'loops'],

  createTransformer: createRotatedForLoopTransformer,
};

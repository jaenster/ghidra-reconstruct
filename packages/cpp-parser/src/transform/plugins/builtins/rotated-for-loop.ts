/**
 * Rotated For Loop Plugin
 *
 * VC8 compiles `for (i = X; C; step) { B }` as the initialisation, a test of C, and a
 * loop that tests at its bottom. Ghidra prints that back rotated, with the
 * initialisation inside the test or as the statement ahead of it:
 *
 *   if (G) { i = X; do { B; step; } while (C); }   ->   for (i = X; C; step) { B }
 *   i = X; if (G) { do { B; step; } while (C); }   ->   for (i = X; C; step) { B }
 *   i = X; S; if (G) { do { B; step; } while (C); }   ->   S; for (i = X; C; step) { B }
 *
 * Compiled again, the rotated form puts the test first and the initialisation after it,
 * where the original has it before (InitPal, 00476ea0). The for loop is laid out as the
 * original. An initialisation ahead of the `if` would compile as the original does, but
 * it does not stay there: when only the loop reads the counter, decl-scope-sink (62) sinks
 * it into the guarded block, which is the first form again. Ghidra prints InitPal itself
 * that way, so both forms become the for loop here.
 *
 * Ghidra may print up to three statements S between that initialisation and the `if`
 * (FreeHireablesList, 00492ec0: `nIconIdx = 0; pMemoryToFree = gpHireablesList; if (...)`).
 * The initialisation moves past them when each is a plain assignment or declaration of a
 * variable other than i, with a side-effect-free value that does not mention i (or an
 * `if` whose condition has no side effect and does not mention i, with arms of such
 * statements only), and X reads only constants and variables none of them writes: then S
 * cannot see i, and X has the same value after S as before it.
 *
 * Where S is more than such stores, and holds a call the original's offsets show made after
 * the initialisation, a constant X whose counter's address nothing takes stays where it is,
 * and the for loop has no initialisation:
 *
 *   i = X; S; if (G) { do { B; step; } while (C); }   ->   i = X; S; for (; C; step) { B }
 *
 * The original set i there: TEXT_DrawTextBoxAtPosition (0049d8e0) zeroes the counter before
 * `SetAndReturnLastFont(0xd)` and forms the call's 0xd from it (`xor esi, esi; lea ecx,
 * [esi + 0xd]`), and a VC8 compile of this form matches it byte for byte. S must not name i
 * and must leave only by falling through: then i still holds X at the test, which is G.
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
 * A body that opens with `if (b) break;` ahead of more statements holds a second exit test
 * the original has in its condition: the for loop tests `C && !b` and the break goes
 * (zlib's syncsearch, 0042b300: `while (next < len && got < 4)`; TEXT_DrawTextBoxAtPosition,
 * 0049d8e0: `nLineIdx < nLineCount && pCurLine`). Kept as a break, the for loop gives it an
 * exit of its own, which the original does not have. Each iteration still tests C, then b,
 * then runs the rest; the first, which the guard entered on C, tests b first as before.
 * Only a test with no side effect and no comment folds, and every leading one does.
 *
 * A loop that means the same as a for loop but did not compile from one stays as it is,
 * which VC8 lays out as the original: a bound computed from other values (`i < n >> 8`,
 * MONSTER_PreloadSequenceAnimations, 004afb60) that the guard and the test both print from
 * one instruction: the original computed it once, into a variable, and the for loop
 * computes it in another order. Where the original's offsets show the test computing it
 * again (or there are none to show it) the bound is the for loop's own.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  BinaryExpr,
  CompoundStmt,
  CStyleCastExpr,
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

/** The `b` of a statement `if (b) break;`, else null. */
function breakTest(s: Statement): Expression | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const ifs = s as IfStmt;
  if (ifs.elseBranch !== null || ifs.isConstexpr || ifs.init) return null;
  let th: Statement = ifs.thenBranch;
  if (th.kind === NodeKind.CompoundStmt) {
    const st = (th as CompoundStmt).statements;
    if (st.length !== 1) return null;
    th = st[0];
  }
  return th.kind === NodeKind.BreakStmt ? ifs.condition : null;
}

/**
 * How many statements `if (b) break;` open the body ahead of more statements, each b free
 * of side effects and the statement of comments; -1 when one of them is not.
 */
function leadingBreakTests(inner: Statement[]): number {
  let k = 0;
  while (k < inner.length - 1 && breakTest(inner[k])) {
    const b = breakTest(inner[k])!;
    if (!isPlainPure(b) || hasComment(inner[k])) return -1;
    k++;
  }
  return k;
}

const FLIPPED: Record<string, string> = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==' };
const FLOATING = new Set(['float', 'double', 'long double']);

/**
 * `!b` as a condition: a `!` dropped, a comparison of two operands of known integer or
 * pointer type flipped (with no NaN, `!(a < b)` is `a >= b`), anything else under `!(...)`.
 */
function negated(b: Expression, shapeOf: ExprShape): Expression {
  const u = unwrapParens(b);
  const bare = { leadingTrivia: [], trailingTrivia: [] };
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const inner = unwrapParens((u as UnaryExpr).operand);
    // `!x` as a truth value is x; anything binary keeps its own parentheses under `&&`.
    return inner.kind === NodeKind.BinaryExpr ? { kind: NodeKind.ParenExpr, expression: inner, location: u.location, ...bare } as ParenExpr : inner;
  }
  if (u.kind === NodeKind.BinaryExpr && FLIPPED[(u as BinaryExpr).operator]) {
    const e = u as BinaryExpr;
    const known = (x: Expression) => {
      if (intLiteral(x) !== null) return true;
      const t = shapeOf(x);
      return !!t && !FLOATING.has(t.base);
    };
    if (known(e.left) && known(e.right)) return { ...e, operator: FLIPPED[e.operator], ...bare } as BinaryExpr;
  }
  const operand: Expression = u.kind === NodeKind.BinaryExpr
    ? { kind: NodeKind.ParenExpr, expression: u, location: u.location, ...bare } as ParenExpr
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: u.location, ...bare } as unknown as UnaryExpr;
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

/**
 * A rotated loop's counter, whether its initialisation stands ahead of the `if`, and how
 * many statements stand between that initialisation and the `if`.
 */
interface Site { v: string; ahead: boolean; gap: number; second?: string; breaks?: number; keep?: boolean }

/** The most statements an initialisation ahead of the `if` moves past. */
const MAX_GAP = 3;

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
  // `before` are the statements before `n` in its block, nearest last.
  const visit = (n: ASTNode, before: Statement[]): void => {
    if (n.kind === NodeKind.IfStmt) {
      const k = ifKey(n);
      if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
      const site = matchSiteBefore(n as IfStmt, before, body, shapeOf, locals, layout);
      if (site && k) sites.set(k, site);
    }
    if (n.kind === NodeKind.CompoundStmt) {
      const stmts = (n as CompoundStmt).statements;
      stmts.forEach((s, i) => visit(s, stmts.slice(Math.max(0, i - 1 - MAX_GAP), i)));
      return;
    }
    for (const c of getChildren(n)) visit(c, []);
  };
  visit(body, []);
  for (const [k, count] of seen) if (count > 1) sites.delete(k);
  return sites;
}

/**
 * The site of an `if` with the statements `before` it: the initialisation in the block,
 * right before the `if`, or before up to MAX_GAP statements it can move past.
 */
function matchSiteBefore(
  ifs: IfStmt, before: Statement[], body: CompoundStmt, shapeOf: ExprShape, locals: ReadonlySet<string>,
  layout: BranchLayoutEvidence | null | undefined,
): Site | null {
  const first = matchSite(ifs, before.length > 0 ? before[before.length - 1] : null, body, shapeOf, locals, layout);
  if (first) return first;
  for (let gap = 1; gap <= MAX_GAP && gap < before.length; gap++) {
    const ahead = before[before.length - 1 - gap];
    const site = matchSite(ifs, ahead, body, shapeOf, locals, layout);
    if (!site || !site.ahead) continue;
    const init = initOf(ahead)!;
    const between = before.slice(before.length - gap);
    if (between.every(s => movesPast(s, init.v, init.x))) return { ...site, gap };
    // Past a call the original made after it, the initialisation stays where it is, and the
    // for loop has none.
    if (isConstant(init.x) && !addressed(body, init.v) && between.every(s => staysBehind(s, init.v))
        && setBeforeCall(ahead, between, layout)) {
      return { ...site, gap, keep: true };
    }
    return null;
  }
  return null;
}

/**
 * Whether the initialisation `v = x` can move past `s`: `s` assigns (`=` or a compound `op=`)
 * or declares a variable other than `v` with a side-effect-free value that does not mention
 * `v`, and `x` reads only constants and variables, none of them the one `s` writes.
 */
function movesPast(s: Statement, v: string, x: Expression): boolean {
  if (hasComment(s)) return false;
  if (s.kind === NodeKind.IfStmt) return ifMovesPast(s as IfStmt, v, x);
  const w = storeOf(s);
  if (!w || w.v === v || !isPlainPure(w.x) || mentions(w.x, v)) return false;
  return readsOnlyNames(x) && !mentions(x, w.v);
}

/**
 * Whether a constant initialisation of `v`, a variable whose address nothing takes, keeps
 * its value across `s`: `s` is an expression statement, a declaration or an `if` of such
 * statements, none of which names `v`. A call cannot reach v, and `s` leaves only by falling
 * through (or not at all).
 */
function staysBehind(s: Statement, v: string): boolean {
  if (mentionsName(s, v)) return false;
  if (s.kind === NodeKind.ExprStmt || s.kind === NodeKind.DeclStmt) return true;
  if (s.kind !== NodeKind.IfStmt) return false;
  const ifs = s as IfStmt;
  if (ifs.isConstexpr || ifs.init) return false;
  const arm = (a: Statement): boolean =>
    a.kind === NodeKind.CompoundStmt ? (a as CompoundStmt).statements.every(t => staysBehind(t, v)) : staysBehind(a, v);
  return arm(ifs.thenBranch) && (ifs.elseBranch === null || arm(ifs.elseBranch));
}

/**
 * Whether the original's offsets show the initialisation made before a call that stands
 * between it and the `if`: every offset its line prints lies below every offset the line of
 * such a call prints. Without the offsets, no.
 */
function setBeforeCall(init: Statement, between: Statement[], layout: BranchLayoutEvidence | null | undefined): boolean {
  if (!layout) return false;
  const offsets = (n: ASTNode) => {
    const line = n.location && n.location.file !== '<generated>' ? n.location.start.line : 0;
    return line > 0 ? layout.lines.get(line) : undefined;
  };
  const own = offsets(init);
  if (!own || own.length === 0) return false;
  const last = Math.max(...own);
  return between.some(s => {
    if (!hasCallIn(s)) return false;
    const o = offsets(s);
    return !!o && o.length > 0 && o.every(x => x > last);
  });
}

function hasCallIn(n: ASTNode): boolean {
  if (n.kind === NodeKind.CallExpr) return true;
  for (const c of getChildren(n)) if (hasCallIn(c)) return true;
  return false;
}

/** The variable a plain or compound assignment (or a declaration) stores, with the value it reads. */
function storeOf(s: Statement): { v: string; x: Expression } | null {
  const init = initOf(s);
  if (init) return init;
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr, l = unwrapParens(a.left);
  // `w op= e` reads w as well: the value it stores is formed from w and e.
  return l.kind === NodeKind.Identifier ? { v: (l as Identifier).name, x: a.right } : null;
}

/** Whether `n` names `name` anywhere, declarations included. */
function mentionsName(n: ASTNode, name: string): boolean {
  if (n.kind === NodeKind.Identifier) return (n as Identifier).name === name;
  if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === name) return true;
  for (const c of getChildren(n)) if (mentionsName(c, name)) return true;
  return false;
}

function declaresName(d: DeclStmt, name: string): boolean {
  return d.declarations.some(x => x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === name);
}

/** Whether `e` is a constant: literals only, no name. */
function isConstant(e: ASTNode): boolean {
  return readsOnlyNames(e) && !mentionsAnyName(e);
}

function mentionsAnyName(e: ASTNode): boolean {
  if (e.kind === NodeKind.Identifier) return true;
  for (const c of getChildren(e)) if (mentionsAnyName(c)) return true;
  return false;
}

/** Whether `n` takes the address of the variable `name`. */
function addressed(n: ASTNode, name: string): boolean {
  if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
    const o = unwrapParens((n as UnaryExpr).operand);
    if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
  }
  for (const c of getChildren(n)) if (addressed(c, name)) return true;
  return false;
}

/**
 * Whether the initialisation `v = x` can move past the `if` `s`: its condition is free of
 * side effects and does not mention `v`, and each arm is a statement or a block of
 * statements the initialisation moves past (DRLGOUTJUNG_BuildKurastDocktownBorders,
 * 0067ead0: `nXIter = 1;` ahead of an if/else that sets nPortalX). Every path through such
 * an `if` stores only into variables other than `v` and leaves it only by falling through.
 */
function ifMovesPast(s: IfStmt, v: string, x: Expression): boolean {
  if (s.isConstexpr || s.init || !isPlainPure(s.condition) || mentionsName(s.condition, v)) return false;
  const arm = (a: Statement): boolean => {
    if (a.kind !== NodeKind.CompoundStmt) return movesPast(a, v, x);
    const st = (a as CompoundStmt).statements;
    return st.length > 0 && st.every(t => movesPast(t, v, x));
  };
  return arm(s.thenBranch) && (s.elseBranch === null || arm(s.elseBranch));
}

/** Whether `e` is built of literals and plain variable names only - no memory read. */
function readsOnlyNames(e: ASTNode): boolean {
  switch (e.kind) {
    case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral: case NodeKind.Identifier:
      return true;
    case NodeKind.ParenExpr: return readsOnlyNames((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr: return readsOnlyNames((e as CStyleCastExpr).expression);
    case NodeKind.BinaryExpr: {
      const b = e as BinaryExpr;
      return readsOnlyNames(b.left) && readsOnlyNames(b.right);
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      return (u.operator === '-' || u.operator === '~' || u.operator === '!' || u.operator === '+') && readsOnlyNames(u.operand);
    }
    default:
      return false;
  }
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
  if (hasComment(last)) return null;
  let second: string | undefined;
  if (!stepOf(last, v)) {
    const u = secondCounter(inner, v, shapeOf);
    if (!u || !layout || !secondInitBeforeGuard(ifs, body, u, v, layout)) return null;
    second = u;
  }
  if (hasOwnContinue(loop.body)) return null;
  const breaks = leadingBreakTests(inner.slice(0, second ? -2 : -1));
  if (breaks < 0) return null;
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
  return { v, ahead: parts.ahead, gap: 0, ...(second ? { second } : {}), ...(breaks > 0 ? { breaks } : {}) };
}

/** The variable a step statement assigns or increments, when it is a plain identifier. */
function stepTarget(s: Statement): string | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((s as ExprStmt).expression);
  let t: Expression | null = null;
  if (e.kind === NodeKind.PostfixExpr) t = (e as PostfixExpr).operand;
  else if (e.kind === NodeKind.UnaryExpr && ((e as UnaryExpr).operator === '++' || (e as UnaryExpr).operator === '--')) t = (e as UnaryExpr).operand;
  else if (e.kind === NodeKind.AssignExpr) t = (e as AssignExpr).left;
  if (!t) return null;
  const u = unwrapParens(t);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/**
 * A body that ends in the tested counter's step and then a second counter's step
 * (`nRow++; nOffset += nWidth;`): the second counter, when neither step mentions the
 * other's counter, so the two steps may change places.
 */
function secondCounter(inner: Statement[], v: string, shapeOf: ExprShape): string | null {
  if (inner.length < 2) return null;
  const last = inner[inner.length - 1], prev = inner[inner.length - 2];
  const u = stepTarget(last);
  if (!u || u === v || !stepOf(last, u) || !stepOf(prev, v) || hasComment(prev)) return null;
  const ue = (last as ExprStmt).expression, ve = (prev as ExprStmt).expression;
  if (!isPlainPure(stepValue(ue)) || !isPlainPure(stepValue(ve))) return null;
  if (mentions(ue, v) || mentions(ve, u)) return null;
  // A counter: its step reads it (`u += k`, `u = u + k`, `u++`), not a copy of another value.
  const ua = unwrapParens(ue);
  if (ua.kind === NodeKind.AssignExpr && (ua as AssignExpr).operator === '=' && !mentions((ua as AssignExpr).right, u)) return null;
  // An integer stepped by a constant beside a counter stepped by one is the counter scaled
  // (a byte offset into a table, TXT_AllocTxt_lowqualityitems 00637500): offset-induction-index
  // folds the rotated loop into the counter's own index, where a for loop would keep it a
  // variable of its own.
  const us = shapeOf({ kind: NodeKind.Identifier, name: u } as unknown as Identifier);
  if (us && us.stars === 0 && constantStride(ue, u) !== null && constantStride(ve, v) === 1n) return null;
  return u;
}

/** The constant a step adds to `name` (`name++`, `name += k`, `name = name + k`), else null. */
function constantStride(e: Expression, name: string): bigint | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.PostfixExpr || x.kind === NodeKind.UnaryExpr) {
    const op = (x as PostfixExpr).operator;
    return op === '++' ? 1n : op === '--' ? -1n : null;
  }
  if (x.kind !== NodeKind.AssignExpr) return null;
  const a = x as AssignExpr;
  if (a.operator === '+=') return intLiteral(a.right);
  if (a.operator === '-=') { const k = intLiteral(a.right); return k === null ? null : -k; }
  if (a.operator !== '=') return null;
  const r = unwrapParens(a.right);
  if (r.kind !== NodeKind.BinaryExpr || (r as BinaryExpr).operator !== '+') return null;
  const b = r as BinaryExpr, l = unwrapParens(b.left);
  if (l.kind !== NodeKind.Identifier || (l as Identifier).name !== name) return null;
  return intLiteral(b.right);
}

/** The value side of a step; an increment has none (its operand is the counter). */
function stepValue(e: Expression): Expression {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.AssignExpr) return (x as AssignExpr).right;
  if (x.kind === NodeKind.PostfixExpr) return (x as PostfixExpr).operand;
  return x.kind === NodeKind.UnaryExpr ? (x as UnaryExpr).operand : x;
}

/** Whether `n` writes `name`: an assignment to it, or an increment of it. */
function writes(n: ASTNode, name: string): boolean {
  const isName = (x: Expression) => {
    const y = unwrapParens(x);
    return y.kind === NodeKind.Identifier && (y as Identifier).name === name;
  };
  if (n.kind === NodeKind.AssignExpr && isName((n as AssignExpr).left)) return true;
  if (n.kind === NodeKind.PostfixExpr && isName((n as PostfixExpr).operand)) return true;
  if (n.kind === NodeKind.UnaryExpr && ((n as UnaryExpr).operator === '++' || (n as UnaryExpr).operator === '--')
      && isName((n as UnaryExpr).operand)) return true;
  if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&' && isName((n as UnaryExpr).operand)) return true;
  for (const c of getChildren(n)) if (writes(c, name)) return true;
  return false;
}

/** The block holding `target` among its statements, and its index there. */
function holder(n: ASTNode, target: Statement): { stmts: Statement[]; at: number } | null {
  if (n.kind === NodeKind.CompoundStmt) {
    const stmts = (n as CompoundStmt).statements;
    const at = stmts.indexOf(target);
    if (at >= 0) return { stmts, at };
  }
  for (const c of getChildren(n)) {
    const h = holder(c, target);
    if (h) return h;
  }
  return null;
}

/**
 * Whether the second counter `u` is set ahead of the loop where the original sets it: its
 * initialisation is a statement of the block holding the `if`, the nearest statement before
 * the `if` that writes `u`, and every code offset its line prints lies before the guard's
 * conditional branch. VC8 compiles that initialisation ahead of the for loop's first test as
 * written; where the original set it after the test (in the guarded block, which is where
 * decl-scope-sink puts a counter the loop alone reads) the rotated loop is the original's.
 * Without the offsets the loop is left as it is.
 */
function secondInitBeforeGuard(ifs: IfStmt, body: CompoundStmt, u: string, v: string, layout: BranchLayoutEvidence): boolean {
  const ifLine = ifs.location && ifs.location.file !== '<generated>' ? ifs.location.start.line : 0;
  const jcc = ifLine > 0 ? layout.ifs.get(ifLine) : undefined;
  if (jcc === undefined) return false;
  const h = holder(body, ifs);
  if (!h) return false;
  for (let i = h.at - 1; i >= 0; i--) {
    const s = h.stmts[i];
    if (!writes(s, u)) continue;
    const init = initOf(s);
    if (!init || init.v !== u || !isPlainPure(init.x) || mentions(init.x, v) || hasComment(s)) return false;
    const line = s.location && s.location.file !== '<generated>' ? s.location.start.line : 0;
    const offs = line > 0 ? layout.lines.get(line) : undefined;
    return !!offs && offs.length > 0 && offs.every(o => o < jcc);
  }
  return false;
}

/** The for loop of a site; `ahead` is the statement before the `if`, for a site that has its initialisation there. */
function rewrite(ifs: IfStmt, site: Site, shapeOf: ExprShape, ahead: Statement | null = null): ForStmt | null {
  const parts = loopParts(ifs, ahead);
  if (!parts || parts.ahead !== site.ahead) return null;
  const loop = parts.loop;
  const bodyStmt = loop.body;
  const inner = bodyStmt.kind === NodeKind.CompoundStmt ? (bodyStmt as CompoundStmt).statements : [bodyStmt];
  // A second counter keeps its step at the end of the body; the tested one's goes into the header.
  const at = site.second ? inner.length - 2 : inner.length - 1;
  const step = at >= 0 ? stepOf(inner[at], site.v) : null;
  if (!step) return null;
  const breaks = site.breaks ?? 0;
  const tests = inner.slice(0, breaks).map(s => breakTest(s));
  if (tests.some(b => !b)) return null;
  const rest = inner.filter((_s, i) => i !== at && i >= breaks);
  const condition = tests.reduce<Expression>((c, b) => ({
    kind: NodeKind.BinaryExpr, operator: '&&', left: c, right: negated(b!, shapeOf),
    location: loop.condition.location, leadingTrivia: [], trailingTrivia: [],
  } as BinaryExpr), loop.condition);
  const newBody: CompoundStmt = bodyStmt.kind === NodeKind.CompoundStmt
    ? updateNode(bodyStmt as CompoundStmt, { statements: rest })
    : { kind: NodeKind.CompoundStmt, statements: rest, location: bodyStmt.location, leadingTrivia: [], trailingTrivia: [] } as CompoundStmt;
  const init: Statement = { ...parts.init, leadingTrivia: [], trailingTrivia: [] };
  const first = parts.ahead ? parts.init : ifs;
  return {
    kind: NodeKind.ForStmt,
    init: site.keep ? null : init,
    condition,
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
        return site && !site.ahead ? rewrite(node, site, shapeOf) ?? undefined : undefined;
      },
      // A loop whose initialisation stands ahead of the `if` takes the place of both; the
      // statements between them stay ahead of the loop.
      visitCompoundStmt(node: CompoundStmt): ASTNode | undefined {
        const stmts = node.statements;
        const loops = new Map<number, ForStmt>();
        const moved = new Set<number>();
        stmts.forEach((s, i) => {
          const k = s.kind === NodeKind.IfStmt ? ifKey(s) : null;
          const site = k ? sites.get(k) : undefined;
          const at = i - 1 - (site?.gap ?? 0);
          if (!site?.ahead || at < 0 || moved.has(at) || loops.has(at)) return;
          const loop = rewrite(s as IfStmt, site, shapeOf, stmts[at]);
          if (loop) { loops.set(i, loop); if (!site.keep) moved.add(at); }
        });
        if (loops.size === 0) return undefined;
        const out = stmts.flatMap((s, i) => moved.has(i) ? [] : [loops.get(i) ?? s]);
        return updateNode(node, { statements: out });
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

/**
 * VC8 source forms recorded per function.
 *
 * Some choices of source form are evenly split across the original: as often a temporary
 * folded into its use as a temporary of its own, a field read again as a field cached in
 * a local, a guard returning early as one nested condition. No rule can pick the side, so
 * the side each function took is recorded in Ghidra, as a `vc8form` function tag, once a
 * VC8 compile of that form has matched the original's bytes. This pass writes the form the
 * tag names. Every form is addressed by names and expressions as the generator prints
 * them, never by line, and is applied after every other pass and the renames, to the body
 * as it is emitted. Every form refuses when its shape is not there: a tag that no
 * longer fits the body changes nothing.
 *
 * The forms (each argument is printed text; whitespace is ignored when comparing):
 *
 *   seq(L1,...,Ln)       the run of statements that store to (or declare and initialize)
 *                        L1..Ln, adjacent in one block and not in this order yet, is
 *                        written in the listed order. Refused when no run or more than
 *                        one fits; `seq(L1,...,Ln,@k)` takes the k-th of several. A
 *                        compound store and ++/-- store to their operand.
 *                        Refused when one statement mentions what another stores, or
 *                        when a statement that stores through memory shares the run with
 *                        a call.
 *   fold(V)              each value stored to local V is written into its uses up to the
 *                        next store to V, and the store goes; `*V` of a stored `&X` is X.
 *                        V's declaration goes once nothing names V. Refused when V's
 *                        address is taken or a store in between writes a name the value
 *                        reads.
 *   cache(E,N,T[,@A])    a new local `T N = E;` before the statement storing A, or the
 *                        if/while/switch testing A (default: before the first statement
 *                        that evaluates E, in the innermost block holding every E), and
 *                        every E from there to the block's end reads N; for E = `&X`, each
 *                        X reads `*N` (`X.m` reads `N->m`). With an anchor, reads before it
 *                        keep E; `cache(E,N,T,@A,k)` moves only the first k reads. Refused
 *                        when E or a name in E is stored in that range.
 *   cache(E,N)           N is an existing local stored from E: each E after that store
 *                        reads N, up to the next store to E or N.
 *   own(V,T[,N])         V's initializer is a dead copy Ghidra merged into it: V is
 *                        declared as a T of its own (named N), without it; a cast of V or
 *                        &V to T or T* goes, and the declaration moves onto V's first
 *                        store when that is a plain store in the same block.
 *   guards(K[,i])        the i-th early return guarded by `!(c1 && ... && cn)` (or
 *                        `!c1 || ... || !cn`) becomes two: c1..cK, then the rest.
 *   merge-guards([i])    the i-th pair of adjacent early returns of one value becomes one
 *                        guard of both conditions.
 *   retval(V,K)          `V = K;` that ends an arm falling through to `return V;` becomes
 *                        `return K;`.
 *   width(V,T)           local V is declared T; a cast of V to T, a cast to V's old type
 *                        stored into V, and a cast of V to T's width in a truth test go.
 *   arms(C)              the if/else whose condition prints C is written with the
 *                        condition negated and the arms swapped.
 *
 * Control-flow forms (C is the printed condition of an `if` with no else; `[,i]` picks the
 * i-th such if, default 1):
 *
 *   nest(C[,i])          the guard `if (C) J` whose arm always leaves (ends in return,
 *                        break, continue or goto), followed by the rest R of its block, is
 *                        written `if (!C) { R } else J`.
 *   merge-tail(C[,i])    a guard `if (C) return E;` whose block ends in `return E;` is
 *                        written `if (!C) { the statements between }` before that return;
 *                        an if on C whose arm ends in `return E;` and falls through to
 *                        `return E;` loses the arm's copy.
 *   tailguard(C[,i])     in a void function, the i-th top-level `if (!V) { BODY }`
 *                        followed only by two calls of the same function is written
 *                        `if (V) { calls; return; } { BODY } calls;`. V must be one
 *                        integral local or parameter. The BODY keeps its scope;
 *                        exits and labels inside BODY are refused.
 *   continue(C[,i])      the guard `if (C) J` that ends a loop body is written
 *                        `if (!C) continue;` followed by J's statements.
 *   select(C[,i])        the guard `if (C) return A;` followed by its block's last
 *                        statement `return B;` is written `return C ? A : B;`.
 *   unselect(C[,i])      `return C ? A : B;` is written `if (C) { return A; } return B;`.
 *   dup(S)               the expression statement S after an if/else (an else-if chain
 *                        with a final else) is written at the end of every arm instead;
 *                        refused when an arm can leave.
 *
 * Expression forms (E and C are printed expressions; `[,i]` picks the i-th, default: the
 * only one):
 *
 *   tarms(C[,i])         the conditional `C ? A : B` is written `!C ? B : A`.
 *   zero(E[,i])          `!E` is written `E == 0`.
 *   nonzero(E[,i])       E tested for truth (an if, while or for condition, an operand of
 *                        `&&` or `||`, or the condition of `?:`) is written `E != 0`.
 *   cmp(C,F[,i])         the comparison C is spelled another way: F = mirror (`a < b` as
 *                        `b > a`), lit (an integer literal right side moved across the
 *                        bound: `a < N` as `a <= N-1`, `a >= N` as `a > N-1`, and back),
 *                        mirror-lit (both, in this order).
 *   swap(E[,i])          the commutative `a op b` (+ * & | ^) is written `b op a`.
 *   ifsel(V)             `V = C ? A : B;` (or the declaration of V so initialized) is
 *                        written `if (C) { V = A; } else { V = B; }`.

 *   decl(V,W)            the declaration of V without an initializer moves to just before
 *                        the declaration of W in its block; refused when a statement it
 *                        moves past names V.
 *   split(V,T,N)         the store `V = E;` that begins a new life of V is written
 *                        `T N = E;` and that life's reads read N; refused when V is read
 *                        again after them before a new store, or inside a loop.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression,
  ExprStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, ParenExpr, ReturnStmt, Statement, TranslationUnit,
  TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';

export type Vc8Form =
  | { op: 'seq'; targets: string[]; index?: number }
  | { op: 'fold'; name: string }
  | { op: 'cache'; expr: string; name: string; type?: string; anchor?: string; count?: number }
  | { op: 'own'; name: string; type: string; rename?: string }
  | { op: 'guards'; split: number; index: number }
  | { op: 'merge-guards'; index: number }
  | { op: 'retval'; name: string; value: string }
  | { op: 'width'; name: string; type: string }
  | { op: 'arms'; cond: string }
  | { op: 'nest'; cond: string; index: number }
  | { op: 'merge-tail'; cond: string; index: number }
  | { op: 'tailguard'; cond: string; index: number }
  | { op: 'continue'; cond: string; index: number }
  | { op: 'dup'; stmt: string }
  | { op: 'tarms'; cond: string; index: number }
  | { op: 'zero'; expr: string; index: number }
  | { op: 'nonzero'; expr: string; index: number }
  | { op: 'cmp'; cond: string; how: 'mirror' | 'lit' | 'mirror-lit'; index: number }
  | { op: 'swap'; expr: string; index: number }
  | { op: 'ifsel'; name: string }
  | { op: 'select'; cond: string; index: number }
  | { op: 'decl'; name: string; before: string }
  | { op: 'unselect'; cond: string; index: number }
  | { op: 'split'; name: string; type: string; rename: string };

export interface Vc8FormSite {
  form: Vc8Form;
  /** The tag the form came from, for the report. */
  tag?: string;
  applied: boolean;
  why?: string;
}

export interface Vc8FormOptions {
  forms: Array<{ form: Vc8Form; tag?: string }>;
  onSite?: (site: Vc8FormSite) => void;
}

const OPS = new Set(['seq', 'fold', 'cache', 'own', 'guards', 'merge-guards', 'retval', 'width', 'arms',
  'nest', 'merge-tail', 'tailguard', 'continue', 'dup', 'tarms', 'zero', 'nonzero', 'cmp', 'swap', 'ifsel', 'split', 'select', 'decl', 'unselect']);

/** Split at the commas outside brackets, parentheses, angle-free. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

/**
 * Parse the form part of a tag: `op(arg,...)`. Returns undefined for an unknown op or a
 * wrong argument count.
 */
export function parseVc8Form(text: string): Vc8Form | undefined {
  const m = /^\s*([a-z-]+)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!m || !OPS.has(m[1])) return undefined;
  const args = splitArgs(m[2]);
  const anchor = args.length > 0 && args[args.length - 1].startsWith('@') ? args.pop()!.slice(1) : undefined;
  const int = (s: string | undefined, d: number) => (s === undefined || s === '' ? d : /^\d+$/.test(s) ? Number(s) : NaN);
  switch (m[1]) {
    case 'seq': {
      // `seq(a,b,@N)`: the N-th run, when several store these.
      const n = anchor === undefined ? 0 : /^\d+$/.test(anchor) ? Number(anchor) : NaN;
      return args.length >= 2 && (n === 0 || n >= 1) ? { op: 'seq', targets: args, ...(n ? { index: n } : {}) } : undefined;
    }
    case 'fold': return args.length === 1 && !anchor ? { op: 'fold', name: args[0] } : undefined;
    case 'cache':
      if (args.length === 2 && !anchor) return { op: 'cache', expr: args[0], name: args[1] };
      if (args.length === 3) return { op: 'cache', expr: args[0], name: args[1], type: args[2], anchor };
      // `cache(E,N,T,@A,k)`: only the first k reads from the anchor on.
      if (!anchor && args.length === 5 && args[3].startsWith('@') && int(args[4], NaN) >= 1) {
        return { op: 'cache', expr: args[0], name: args[1], type: args[2], anchor: args[3].slice(1), count: int(args[4], NaN) };
      }
      return undefined;
    case 'own':
      if (anchor || args.length < 2 || args.length > 3) return undefined;
      return { op: 'own', name: args[0], type: args[1], rename: args[2] };
    case 'guards': {
      const k = int(args[0], NaN), i = int(args[1], 1);
      return !anchor && args.length <= 2 && k >= 1 && i >= 1 ? { op: 'guards', split: k, index: i } : undefined;
    }
    case 'merge-guards': {
      const i = int(args[0], 1);
      return !anchor && args.length <= 1 && i >= 1 ? { op: 'merge-guards', index: i } : undefined;
    }
    case 'retval': return args.length === 2 && !anchor ? { op: 'retval', name: args[0], value: args[1] } : undefined;
    case 'width': return args.length === 2 && !anchor ? { op: 'width', name: args[0], type: args[1] } : undefined;
    case 'arms': return args.length === 1 && !anchor ? { op: 'arms', cond: args[0] } : undefined;
    case 'nest': case 'merge-tail': case 'tailguard': case 'continue': case 'select': {
      const i = int(args[1], 1);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 1) || args[0] === '') return undefined;
      return { op: m[1], cond: args[0], index: i } as Vc8Form;
    }
    case 'zero': case 'nonzero': case 'swap': case 'tarms': case 'unselect': {
      const i = int(args[1], 0);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 0) || args[0] === '') return undefined;
      return (m[1] === 'tarms' || m[1] === 'unselect' ? { op: m[1], cond: args[0], index: i } : { op: m[1], expr: args[0], index: i }) as Vc8Form;
    }
    case 'cmp': {
      const i = int(args[2], 0);
      if (anchor || args.length < 2 || args.length > 3 || !(i >= 0)) return undefined;
      if (args[1] !== 'mirror' && args[1] !== 'lit' && args[1] !== 'mirror-lit') return undefined;
      return { op: 'cmp', cond: args[0], how: args[1], index: i };
    }
    case 'dup': return args.length === 1 && !anchor && args[0] !== '' ? { op: 'dup', stmt: args[0] } : undefined;
    case 'ifsel': return args.length === 1 && !anchor ? { op: 'ifsel', name: args[0] } : undefined;
    case 'decl': return args.length === 2 && !anchor ? { op: 'decl', name: args[0], before: args[1] } : undefined;
    case 'split': return args.length === 3 && !anchor ? { op: 'split', name: args[0], type: args[1], rename: args[2] } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Text, parsing, walking

const norm = (s: string) => s.replace(/\s+/g, '');
const text = (n: ASTNode) => norm(emit(n as never));

function unparen(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function parseType(t: string): TypeNode {
  const fn = parse(`void __vc8f() { ${t} __vc8v = 0; }`).declarations[0] as FunctionDecl;
  const d = fn.body!.statements[0] as DeclStmt;
  if (d.kind !== NodeKind.DeclStmt) throw new Error(`not a type: ${t}`);
  return (d.declarations[0] as VariableDecl).type;
}

function parseExpr(e: string): Expression {
  const fn = parse(`void __vc8f() { __vc8x = (${e}); }`).declarations[0] as FunctionDecl;
  const s = fn.body!.statements[0] as ExprStmt;
  if (s.kind !== NodeKind.ExprStmt) throw new Error(`not an expression: ${e}`);
  return unparen((s.expression as AssignExpr).right);
}

interface Slot { parent: Record<string, unknown> | unknown[]; key: string | number }

/**
 * Every node under root, preorder, with the slot that holds it. A member's name is no
 * variable and is not visited.
 */
function* walk(root: ASTNode, slot?: Slot): Generator<{ node: ASTNode; slot?: Slot }> {
  yield { node: root, slot };
  for (const key of Object.keys(root)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    if (key === 'member' && root.kind === NodeKind.MemberExpr) continue;
    const v = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') yield* walk(x as ASTNode, { parent: v, key: i });
      }
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
      yield* walk(v as ASTNode, { parent: root as unknown as Record<string, unknown>, key });
    }
  }
}

function put(slot: Slot, n: ASTNode): void {
  (slot.parent as Record<string | number, unknown>)[slot.key as never] = n;
}

const isId = (e: ASTNode | null | undefined, name?: string): e is Identifier =>
  !!e && e.kind === NodeKind.Identifier && (name === undefined || (e as Identifier).name === name);

function mentions(n: ASTNode, name: string): boolean {
  for (const { node } of walk(n)) if (isId(node, name)) return true;
  return false;
}

function hasCall(n: ASTNode): boolean {
  for (const { node } of walk(n)) if (node.kind === NodeKind.CallExpr) return true;
  return false;
}

/** The plain store `L = R;` a statement is, or undefined. */
function storeOf(s: Statement): AssignExpr | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? (e as AssignExpr) : undefined;
}

/** The single variable a declaration statement declares. */
function declOf(s: Statement): VariableDecl | undefined {
  if (s.kind !== NodeKind.DeclStmt) return undefined;
  const d = (s as DeclStmt).declarations;
  return d.length === 1 && d[0].kind === NodeKind.VariableDecl ? (d[0] as VariableDecl) : undefined;
}

/** What a statement stores to, as printed: the store's left side, or the declared name. */
function targetOf(s: Statement): string | undefined {
  const st = storeOf(s);
  if (st) return text(st.left);
  // A declaration without an initializer stores nothing.
  const d = declOf(s);
  return d && d.initializer ? d.name.name : undefined;
}

function blocks(fn: FunctionDecl): CompoundStmt[] {
  const out: CompoundStmt[] = [];
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.CompoundStmt) out.push(node as CompoundStmt);
  return out;
}

/** Root names an lvalue stores into: `x` for x, x.f, x[i]; '*' for memory through a pointer or a global. */
function storeRoot(e: Expression, locals: Set<string>): string {
  e = unparen(e);
  for (;;) {
    if (isId(e)) return locals.has(e.name) ? e.name : '*';
    if (e.kind === NodeKind.MemberExpr && !(e as unknown as { isArrow: boolean }).isArrow) { e = unparen((e as unknown as { object: Expression }).object); continue; }
    if (e.kind === NodeKind.SubscriptExpr) {
      const a = unparen((e as unknown as { array: Expression }).array);
      if (isId(a) && locals.has(a.name)) { e = a; continue; }
    }
    return '*';
  }
}

function localNames(fn: FunctionDecl): Set<string> {
  const out = new Set<string>();
  for (const p of fn.parameters) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && isId(n)) out.add(n.name);
  }
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.VariableDecl) out.add((node as VariableDecl).name.name);
  return out;
}

function addressTaken(fn: FunctionDecl, name: string): boolean {
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && isId(unparen((node as UnaryExpr).operand), name)) return true;
  }
  return false;
}

/** Variables a statement stores into (assignment, compound assignment, ++/--). */
function storedNames(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const { node } of walk(n)) {
    let lhs: Expression | undefined;
    if (node.kind === NodeKind.AssignExpr) lhs = (node as AssignExpr).left;
    else if ((node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator)) || node.kind === NodeKind.PostfixExpr) lhs = (node as UnaryExpr).operand;
    if (!lhs) continue;
    // The variable the store lands in: through `.` and `[]`; a store through `*` or `->`
    // writes memory, not the pointer.
    let e = unparen(lhs);
    while (e.kind === NodeKind.SubscriptExpr || (e.kind === NodeKind.MemberExpr && !(e as unknown as { isArrow: boolean }).isArrow)) {
      e = unparen(e.kind === NodeKind.SubscriptExpr ? (e as unknown as { array: Expression }).array : (e as unknown as { object: Expression }).object);
    }
    if (isId(e)) out.add(e.name);
  }
  return out;
}

function identifiers(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const { node } of walk(n)) if (isId(node)) out.add(node.name);
  return out;
}

/** The negation of a condition, pushed through comparisons and De Morgan. */
const FLIP: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
function negate(c: Expression): Expression {
  c = unparen(c);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return unparen((c as UnaryExpr).operand);
  if (c.kind === NodeKind.BinaryExpr) {
    const b = c as BinaryExpr;
    if (FLIP[b.operator]) return { ...b, operator: FLIP[b.operator] as BinaryExpr['operator'] };
    if (b.operator === '||') return { ...b, operator: '&&', left: negate(b.left), right: negate(b.right) };
    if (b.operator === '&&') return { ...b, operator: '||', left: negate(b.left), right: negate(b.right) };
  }
  return { kind: NodeKind.UnaryExpr, operator: '!', operand: c } as unknown as UnaryExpr;
}

/** The negation the control-flow forms write: a comparison flipped, `!x` as x, anything else as `!(c)`. */
function negateWrap(c: Expression): Expression {
  c = unparen(c);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return unparen((c as UnaryExpr).operand);
  if (c.kind === NodeKind.BinaryExpr && FLIP[(c as BinaryExpr).operator]) return { ...(c as BinaryExpr), operator: FLIP[(c as BinaryExpr).operator] as BinaryExpr['operator'] };
  return { kind: NodeKind.UnaryExpr, operator: '!', operand: { kind: NodeKind.ParenExpr, expression: c } } as unknown as UnaryExpr;
}

function chain(c: Expression, op: '&&' | '||'): Expression[] {
  c = unparen(c);
  if (c.kind === NodeKind.BinaryExpr && (c as BinaryExpr).operator === op) {
    return [...chain((c as BinaryExpr).left, op), ...chain((c as BinaryExpr).right, op)];
  }
  return [c];
}

function join(parts: Expression[], op: '&&' | '||'): Expression {
  return parts.reduce((l, r) => ({ kind: NodeKind.BinaryExpr, operator: op, left: l, right: r }) as unknown as BinaryExpr);
}

/** The single `return R;` an if's then-branch is, or undefined. */
function soleReturn(s: Statement): ReturnStmt | undefined {
  if (s.kind === NodeKind.ReturnStmt) return s as ReturnStmt;
  if (s.kind === NodeKind.CompoundStmt) {
    const st = (s as CompoundStmt).statements;
    if (st.length === 1 && st[0].kind === NodeKind.ReturnStmt) return st[0] as ReturnStmt;
  }
  return undefined;
}

class Refuse extends Error {}
const refuse = (why: string): never => { throw new Refuse(why); };

// ---------------------------------------------------------------------------------------
// The forms

/** What a statement stores to for seq: a plain or compound store, ++/--, or an initialized declaration. */
function seqLhs(s: Statement): Expression | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  if (e.kind === NodeKind.AssignExpr) return (e as AssignExpr).left;
  if (e.kind === NodeKind.PostfixExpr || (e.kind === NodeKind.UnaryExpr && ['++', '--'].includes((e as UnaryExpr).operator))) return (e as UnaryExpr).operand;
  return undefined;
}

function seqTargetOf(s: Statement): string | undefined {
  const l = seqLhs(s);
  return l ? text(l) : targetOf(s);
}

function doSeq(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'seq' }>): void {
  const want = f.targets.map(norm);
  if (new Set(want).size !== want.length) refuse('a target listed twice');
  const locals = localNames(fn);
  // The runs that store exactly these and are not in the listed order yet; one is the site.
  const runs: Array<{ st: Statement[]; i: number; got: string[] }> = [];
  for (const b of blocks(fn)) {
    const st = b.statements;
    for (let i = 0; i + want.length <= st.length; i++) {
      const got = st.slice(i, i + want.length).map(s => seqTargetOf(s));
      if (!got.every(g => g !== undefined && want.includes(g)) || new Set(got).size !== want.length) continue;
      if (got.every((g, k) => g === want[k])) continue;
      runs.push({ st, i, got: got as string[] });
    }
  }
  if (runs.length === 0) refuse('no adjacent run out of this order stores exactly these');
  if (runs.length > 1 && !f.index) refuse(`${runs.length} runs store these`);
  if (f.index && f.index > runs.length) refuse(`no run #${f.index} stores these`);
  {
    const { st, i, got } = runs[(f.index ?? 1) - 1];
    {
      const run = st.slice(i, i + want.length);
      // Value-preserving: no statement mentions what another stores, and a store through
      // memory shares the run with no call.
      // Only a pair whose order the move flips can change a value.
      const pos = got.map(g => want.indexOf(g!));
      const reads = (hay: string, needle: string) => new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])').test(hay);
      for (let x = 0; x < run.length; x++) {
        const lx = seqLhs(run[x]);
        const tx = got[x]!;
        for (let y = 0; y < run.length; y++) {
          if (x === y) continue;
          if ((x < y) === (pos[x] < pos[y])) continue;
          const ly = seqLhs(run[y]);
          if (!lx) {
            if (mentions(run[y], tx)) refuse(`${tx} is used by ${got[y]}`);
            continue;
          }
          const root = storeRoot(lx, locals);
          if (root === '*') {
            if (hasCall(run[x]) || hasCall(run[y])) refuse(`${tx} stores through memory beside a call`);
            if (reads(text(run[y]), tx)) refuse(`${tx} is read by ${got[y]}`);
            continue;
          }
          // A local: another member store into the same local is independent unless it
          // reads this member; anything else must not name the local at all.
          const sy = storeOf(run[y]);
          const sameAggregate = ly && storeRoot(ly, locals) === root && text(ly) !== root;
          // The other statement's reads: a plain store's right side; a compound store or
          // ++/-- also reads its own target.
          const readsOfY = sy && sy.operator === '=' ? text(sy.right) : text(run[y]);
          if (sameAggregate ? reads(readsOfY, tx) : mentions(run[y], root)) refuse(`${tx} is read by ${got[y]}`);
        }
      }
      const byTarget = new Map(run.map((s, k) => [got[k]!, s]));
      st.splice(i, want.length, ...want.map(w => byTarget.get(w)!));
    }
  }
}

function doFold(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'fold' }>): void {
  const v = f.name;
  if (addressTaken(fn, v)) refuse(`&${v} is taken`);
  let folded = 0;
  for (const b of blocks(fn)) {
    for (let i = 0; i < b.statements.length; i++) {
      const s = b.statements[i];
      const st = storeOf(s);
      const d = declOf(s);
      let value: Expression | null = null;
      if (st && st.operator === '=' && isId(unparen(st.left), v)) value = st.right;
      else if (d && d.name.name === v && d.initializer && d.initializer.kind !== NodeKind.InitListExpr) value = d.initializer as Expression;
      if (!value) continue;
      if (mentions(value, v)) refuse(`${v} is stored from itself`);
      // Its uses: the following statements of this block, up to the next store to v.
      let end = i + 1;
      while (end < b.statements.length) {
        const n = b.statements[end];
        const ns = storeOf(n);
        if ((ns && ns.operator === '=' && isId(unparen(ns.left), v)) || (declOf(n)?.name.name === v)) break;
        end++;
      }
      const reads = identifiers(value);
      const uses = b.statements.slice(i + 1, end);
      const lastUse = uses.reduce((k, n, j) => (mentions(n, v) ? j : k), -1);
      if (lastUse < 0) refuse(`the value stored to ${v} is never read`);
      for (let j = 0; j <= lastUse; j++) {
        const stored = storedNames(uses[j]);
        if (stored.has(v)) refuse(`${v} is stored again inside its uses`);
        if (j < lastUse) for (const r of reads) if (stored.has(r)) refuse(`${r} changes before ${v} is read`);
      }
      // Nothing after the range may read this value: the range ends at a store or at the
      // block's end, and the block must not be followed by a read in an outer block.
      if (end === b.statements.length && blockReadsAfter(fn, b, v, i)) refuse(`${v} is read after its block`);
      for (const n of uses.slice(0, lastUse + 1)) {
        for (const { node, slot } of [...walk(n)]) {
          if (!slot) continue;
          if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '*' && isId(unparen((node as UnaryExpr).operand), v)) {
            const inner = unparen(value);
            if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&') put(slot, cloneNode(unparen((inner as UnaryExpr).operand)));
            else put(slot, { kind: NodeKind.UnaryExpr, operator: '*', operand: cloneNode(value) } as unknown as UnaryExpr);
          }
        }
        for (const { node, slot } of [...walk(n)]) if (slot && isId(node, v)) put(slot, cloneNode(value));
      }
      b.statements.splice(i, 1);
      i--;
      folded++;
    }
  }
  if (folded === 0) refuse(`no store to ${v}`);
  // The bare declaration goes once nothing names v.
  if (!mentionsOutsideDecl(fn, v)) removeDecl(fn, v);
}

function parentsOf(fn: FunctionDecl): Map<ASTNode, ASTNode> {
  const m = new Map<ASTNode, ASTNode>();
  const rec = (n: ASTNode) => {
    for (const { node, slot } of walk(n)) {
      if (!slot) continue;
      const p = Array.isArray(slot.parent) ? undefined : (slot.parent as unknown as ASTNode);
      if (p) m.set(node, p);
    }
  };
  rec(fn.body!);
  // Array slots: map the array's items to the node owning the array.
  for (const { node } of walk(fn.body!)) {
    for (const key of Object.keys(node)) {
      const v = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') m.set(x as ASTNode, node);
    }
  }
  return m;
}

/**
 * Whether a statement after block b (in an enclosing block) names v. With `from`, the index
 * in b of the store whose value ends with b, a loop around b counts only where the next
 * iteration reads v before that store: its condition and increment, and the statements
 * before the path to the store (in b, those before `from`); without it, any mention in the
 * loop counts.
 */
function blockReadsAfter(fn: FunctionDecl, b: CompoundStmt, v: string, from?: number): boolean {
  const parents = parentsOf(fn);
  let cur: ASTNode = b;
  // The statements before the path, from b outwards to the innermost loop.
  const before: Statement[] = from === undefined ? [] : b.statements.slice(0, from);
  for (;;) {
    const p = parents.get(cur);
    if (!p) return false;
    if (p.kind === NodeKind.CompoundStmt) {
      const st = (p as CompoundStmt).statements;
      const k = st.indexOf(cur as Statement);
      if (st.slice(k + 1).some(s => mentions(s, v))) return true;
      before.push(...st.slice(0, k));
    }
    if (p.kind === NodeKind.WhileStmt || p.kind === NodeKind.ForStmt || p.kind === NodeKind.DoWhileStmt) {
      if (from === undefined) { if (mentions(p, v)) return true; }
      else {
        const l = p as unknown as { condition?: ASTNode | null; increment?: ASTNode | null; init?: ASTNode | null };
        if ((l.condition && mentions(l.condition, v)) || (l.increment && mentions(l.increment, v))) return true;
        if (before.some(s => mentions(s, v))) return true;
      }
    }
    cur = p;
  }
}

function mentionsOutsideDecl(fn: FunctionDecl, v: string): boolean {
  for (const { node, slot } of walk(fn.body!)) {
    if (!isId(node, v)) continue;
    const owner = slot && !Array.isArray(slot.parent) ? (slot.parent as unknown as ASTNode) : undefined;
    if (owner && owner.kind === NodeKind.VariableDecl && slot!.key === 'name') continue;
    return true;
  }
  return false;
}

function removeDecl(fn: FunctionDecl, v: string): void {
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => declOf(s)?.name.name === v);
    if (k >= 0) { b.statements.splice(k, 1); return; }
  }
}

/** The statement an anchor names: the one storing (or declaring) it, or the if/while/switch on it. */
function anchors(s: Statement, a: string): boolean {
  if (targetOf(s) === a) return true;
  if (s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.SwitchStmt) return text((s as IfStmt).condition) === a;
  return false;
}

function doCache(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'cache' }>): void {
  // `&X` caches X's address: each X is read through the local, `X.m` as `N->m`.
  const byAddress = f.type !== undefined && norm(f.expr).startsWith('&');
  const want = byAddress ? norm(f.expr).slice(1) : norm(f.expr);
  const locals = localNames(fn);
  const isE = (n: ASTNode) => (n as Expression).kind !== undefined && text(n) === want;
  const stores = (n: ASTNode) => {
    for (const { node } of walk(n)) {
      if (node.kind !== NodeKind.AssignExpr) continue;
      const l = text((node as AssignExpr).left);
      if (l === want || identifiers((node as AssignExpr).left).has(f.name)) return true;
      if (isId(unparen((node as AssignExpr).left)) && identifiers(parseExpr(f.expr)).has((unparen((node as AssignExpr).left) as Identifier).name)) return true;
    }
    return false;
  };
  const replaceIn = (n: ASTNode): number => {
    let k = 0;
    for (const { node, slot } of [...walk(n)]) {
      if (!slot || !isE(node)) continue;
      const owner = !Array.isArray(slot.parent) ? (slot.parent as unknown as ASTNode) : undefined;
      if (owner && owner.kind === NodeKind.AssignExpr && slot.key === 'left') refuse(`${f.expr} is stored`);
      const id = { kind: NodeKind.Identifier, name: f.name } as Identifier;
      if (!byAddress) put(slot, id);
      else if (owner && owner.kind === NodeKind.MemberExpr && slot.key === 'object' && !(owner as unknown as { isArrow: boolean }).isArrow) {
        (owner as unknown as { object: Expression }).object = id;
        (owner as unknown as { isArrow: boolean }).isArrow = true;
      } else put(slot, { kind: NodeKind.UnaryExpr, operator: '*', operand: id } as unknown as UnaryExpr);
      k++;
    }
    return k;
  };
  if (f.type) {
    if (locals.has(f.name)) refuse(`${f.name} exists`);
    let block: CompoundStmt | undefined, at = -1;
    if (f.anchor) {
      const a = norm(f.anchor);
      for (const b of blocks(fn)) { const k = b.statements.findIndex(s => anchors(s, a)); if (k >= 0) { block = b; at = k; break; } }
      if (!block) refuse(`no statement stores or tests ${f.anchor}`);
    } else {
      // The innermost block whose statements hold every E.
      const all = blocks(fn).filter(b => b.statements.some(s => [...walk(s)].some(x => isE(x.node))));
      const total = [...walk(fn.body!)].filter(x => isE(x.node)).length;
      if (total === 0) refuse(`${f.expr} does not occur`);
      for (const b of all.reverse()) {
        const inB = b.statements.reduce((k, s) => k + [...walk(s)].filter(x => isE(x.node)).length, 0);
        if (inB === total) { block = b; at = b.statements.findIndex(s => [...walk(s)].some(x => isE(x.node))); break; }
      }
      if (!block) refuse(`no block holds every ${f.expr}`);
    }
    const rest = block!.statements.slice(at);
    const reads = (s: ASTNode) => [...walk(s)].filter(x => isE(x.node)).length;
    // Without an anchor every read is after the local; with one, reads before it keep E.
    const before = reads(fn.body!) - rest.reduce((k, s) => k + reads(s), 0);
    if (before > 0 && !f.anchor) refuse(`${f.expr} is read before the new local`);
    // The statements whose reads move to the local: all of them, or the first `count` reads.
    let last = -1, seen = 0;
    for (let k = 0; k < rest.length && seen < (f.count ?? Infinity); k++) { const r = reads(rest[k]); if (r > 0) { last = k; seen += r; } }
    if (last < 0) refuse(`${f.expr} is not read after the anchor`);
    if (f.count !== undefined && seen !== f.count) refuse(`the first ${f.count} reads of ${f.expr} do not end a statement`);
    for (let k = 0; k < last; k++) if (stores(rest[k])) refuse(`${f.expr} changes before its last read`);
    let n = 0;
    for (const s of rest.slice(0, last + 1)) n += replaceIn(s);
    const decl = parse(`void __vc8f() { ${f.type} ${f.name} = ${f.expr}; }`).declarations[0] as FunctionDecl;
    const d = decl.body!.statements[0];
    if (!declOf(d)) refuse(`cannot declare ${f.type} ${f.name}`);
    (declOf(d)!).type = parseType(f.type);
    block!.statements.splice(at, 0, d);
    if (n === 0) refuse('nothing to read the local');
    return;
  }
  // N exists and is stored from E: the reads of E that follow its store read N.
  if (!locals.has(f.name)) refuse(`${f.name} is no local`);
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => {
      const st = storeOf(s); const d = declOf(s);
      return (st && st.operator === '=' && isId(unparen(st.left), f.name) && text(st.right) === want) ||
        (d && d.name.name === f.name && d.initializer && text(d.initializer) === want);
    });
    if (k < 0) continue;
    let n = 0;
    for (let j = k + 1; j < b.statements.length; j++) {
      const s = b.statements[j];
      if (stores(s)) {
        // A store to E or N ends the range; reads in its right side still see the old value.
        const st = storeOf(s);
        if (st && text(st.left) === want) n += replaceIn(st.right);
        break;
      }
      n += replaceIn(s);
    }
    if (n === 0) refuse(`no read of ${f.expr} after ${f.name}'s store`);
    return;
  }
  refuse(`${f.name} is never stored from ${f.expr}`);
}

function doOwn(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'own' }>): void {
  const newName = f.rename ?? f.name;
  const T = norm(f.type);
  let found = false;
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => declOf(s)?.name.name === f.name);
    if (k < 0) continue;
    const d = declOf(b.statements[k])!;
    if (d.initializer) {
      const init = unparen(d.initializer as Expression);
      const simple = (e: Expression): boolean => { e = unparen(e); return isId(e) || e.kind === NodeKind.IntegerLiteral || e.kind === NodeKind.NullptrLiteral || (e.kind === NodeKind.CStyleCastExpr && simple((e as CStyleCastExpr).expression)); };
      if (!simple(init)) refuse(`${f.name}'s initializer has effects`);
    }
    d.initializer = null;
    d.type = parseType(f.type);
    found = true;
    // The first statement after the declaration that names v: a plain store takes the declaration.
    const next = b.statements.findIndex((s, j) => j > k && mentions(s, f.name));
    if (next > k) {
      const st = storeOf(b.statements[next]);
      if (st && st.operator === '=' && isId(unparen(st.left), f.name) && !mentions(st.right, f.name)) {
        d.initializer = st.right;
        b.statements.splice(next, 1, b.statements[k]);
        b.statements.splice(k, 1);
      }
    }
    break;
  }
  if (!found) refuse(`no declaration of ${f.name}`);
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot || node.kind !== NodeKind.CStyleCastExpr) continue;
    const c = node as CStyleCastExpr;
    const inner = unparen(c.expression);
    const ct = text(c.type);
    if (isId(inner, f.name) && ct === T) put(slot, inner);
    // `T*`, or its Win32 spelling `LPT` (LPDWORD for DWORD*).
    else if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&' && isId(unparen((inner as UnaryExpr).operand), f.name) && (ct === T + '*' || ct === 'LP' + T)) put(slot, inner);
  }
  if (newName !== f.name) {
    if (localNames(fn).has(newName)) refuse(`${newName} exists`);
    for (const { node } of walk(fn.body!)) if (isId(node, f.name)) (node as Identifier).name = newName;
  }
}

function guardIfs(fn: FunctionDecl): IfStmt[] {
  const out: IfStmt[] = [];
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.IfStmt) continue;
    const s = node as IfStmt;
    if (!s.elseBranch && soleReturn(s.thenBranch)) out.push(s);
  }
  return out;
}

function doGuards(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'guards' }>): void {
  const cands: Array<{ s: IfStmt; parts: Expression[] }> = [];
  for (const s of guardIfs(fn)) {
    const c = unparen(s.condition);
    let parts: Expression[] | undefined;
    if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
      const conj = chain((c as UnaryExpr).operand, '&&');
      if (conj.length > 1) parts = conj;
    } else {
      const disj = chain(c, '||');
      if (disj.length > 1) parts = disj.map(negate);
    }
    if (parts && parts.length > f.split) cands.push({ s, parts });
  }
  const hit = cands[f.index - 1] ?? refuse(`no guard #${f.index} of more than ${f.split} conditions`);
  for (const b of blocks(fn)) {
    const k = b.statements.indexOf(hit.s);
    if (k < 0) continue;
    const first: IfStmt = { ...hit.s, condition: join(hit.parts.slice(0, f.split).map(negate), '||'), thenBranch: cloneNode(hit.s.thenBranch) };
    const second: IfStmt = { ...hit.s, condition: join(hit.parts.slice(f.split).map(negate), '||'), thenBranch: cloneNode(hit.s.thenBranch) };
    b.statements.splice(k, 1, first, second);
    return;
  }
  refuse('the guard is not in a block');
}

function doMergeGuards(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'merge-guards' }>): void {
  let seen = 0;
  for (const b of blocks(fn)) {
    for (let i = 0; i + 1 < b.statements.length; i++) {
      const [x, y] = [b.statements[i], b.statements[i + 1]];
      if (x.kind !== NodeKind.IfStmt || y.kind !== NodeKind.IfStmt) continue;
      const [a, c] = [x as IfStmt, y as IfStmt];
      const ra = !a.elseBranch && soleReturn(a.thenBranch), rc = !c.elseBranch && soleReturn(c.thenBranch);
      if (!ra || !rc || text(ra) !== text(rc)) continue;
      if (++seen !== f.index) continue;
      b.statements.splice(i, 2, { ...a, condition: join([a.condition, c.condition], '||') });
      return;
    }
  }
  refuse(`no pair #${f.index} of adjacent guards returning one value`);
}

function doRetval(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'retval' }>): void {
  const parents = parentsOf(fn);
  const val = norm(f.value);
  for (const b of blocks(fn)) {
    const st = b.statements;
    const last = st[st.length - 1];
    const s = last && storeOf(last);
    if (!s || s.operator !== '=' || !isId(unparen(s.left), f.name) || text(s.right) !== val) continue;
    // Walk out while the construct ends here, to the statement whose next is `return V;`.
    let cur: ASTNode = b;
    for (;;) {
      const p = parents.get(cur);
      if (!p) break;
      if (p.kind === NodeKind.CompoundStmt) {
        const ps = (p as CompoundStmt).statements;
        const k = ps.indexOf(cur as Statement);
        const nx = ps[k + 1];
        if (nx && nx.kind === NodeKind.ReturnStmt && isId(unparen((nx as ReturnStmt).value as Expression), f.name)) {
          st[st.length - 1] = { kind: NodeKind.ReturnStmt, value: s.right } as unknown as ReturnStmt;
          return;
        }
        if (k !== ps.length - 1) break;
      } else if (![NodeKind.IfStmt, NodeKind.SwitchStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt].includes(p.kind)) break;
      cur = p;
    }
  }
  refuse(`no ${f.name} = ${f.value} falling through to return ${f.name}`);
}

const WIDTH: Record<string, number> = {
  char: 1, bool: 1, int8_t: 1, uint8_t: 1, BYTE: 1, byte: 1, undefined1: 1, 'unsignedchar': 1, 'signedchar': 1,
  short: 2, 'shortint': 2, 'unsignedshort': 2, 'unsignedshortint': 2, int16_t: 2, uint16_t: 2, WORD: 2, ushort: 2, undefined2: 2, wchar_t: 2,
  int: 4, 'unsignedint': 4, unsigned: 4, uint: 4, int32_t: 4, uint32_t: 4, DWORD: 4, BOOL: 4, long: 4, 'unsignedlong': 4, ulong: 4, size_t: 4, undefined4: 4,
};

function doWidth(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'width' }>): void {
  let d: VariableDecl | undefined;
  for (const b of blocks(fn)) { for (const s of b.statements) { const x = declOf(s); if (x?.name.name === f.name) d = x; } }
  if (!d) refuse(`no declaration of ${f.name}`);
  const old = text(d!.type), T = norm(f.type);
  if (old === T) refuse(`${f.name} is ${f.type} already`);
  const w = WIDTH[T];
  d!.type = parseType(f.type);
  const truth = new Set<ASTNode>();
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.IfStmt || node.kind === NodeKind.WhileStmt) truth.add(unparen((node as IfStmt).condition));
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '!') truth.add(unparen((node as UnaryExpr).operand));
    if (node.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((node as BinaryExpr).operator)) { truth.add(unparen((node as BinaryExpr).left)); truth.add(unparen((node as BinaryExpr).right)); }
  }
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot) continue;
    if (node.kind === NodeKind.CStyleCastExpr) {
      const c = node as CStyleCastExpr; const inner = unparen(c.expression); const ct = text(c.type);
      if (isId(inner, f.name) && (ct === T || (truth.has(node) && w !== undefined && WIDTH[ct] === w))) put(slot, inner);
    }
    if (node.kind === NodeKind.AssignExpr && isId(unparen((node as AssignExpr).left), f.name)) {
      const r = unparen((node as AssignExpr).right);
      if (r.kind === NodeKind.CStyleCastExpr && text((r as CStyleCastExpr).type) === old) (node as AssignExpr).right = (r as CStyleCastExpr).expression;
    }
  }
}

function doArms(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'arms' }>): void {
  const want = norm(f.cond);
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.IfStmt) continue;
    const s = node as IfStmt;
    if (!s.elseBranch || text(s.condition) !== want) continue;
    if (s.elseBranch.kind === NodeKind.IfStmt) refuse('the else arm is an else-if chain');
    const t = s.thenBranch;
    s.condition = negate(s.condition);
    s.thenBranch = s.elseBranch;
    s.elseBranch = t;
    return;
  }
  refuse(`no if/else on ${f.cond}`);
}

// ---------------------------------------------------------------------------------------
// Control-flow and expression forms

const asBlock = (s: Statement): CompoundStmt =>
  s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt) : ({ kind: NodeKind.CompoundStmt, statements: [s] } as unknown as CompoundStmt);

const stmtsOf = (s: Statement): Statement[] => (s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s]);

const JUMPS = new Set<string>([NodeKind.ReturnStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.GotoStmt]);

/** A call to exit or abort, which never returns. */
function noReturnCall(s: Statement): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  const e = unparen((s as ExprStmt).expression);
  if (e.kind !== NodeKind.CallExpr) return false;
  const c = unparen((e as unknown as { callee: Expression }).callee);
  return isId(c) && ['exit', 'abort', '_exit'].includes(c.name);
}

/** Whether a statement always leaves: it ends in a jump, exit() or abort(), a block that leaves, or an if/else whose arms both leave. */
function leaves(s: Statement): boolean {
  const st = stmtsOf(s);
  const last = st[st.length - 1];
  if (!last) return false;
  if (JUMPS.has(last.kind)) return true;
  if (noReturnCall(last)) return true;
  if (last.kind === NodeKind.CompoundStmt) return leaves(last);
  if (last.kind === NodeKind.IfStmt) { const x = last as IfStmt; return !!x.elseBranch && leaves(x.thenBranch) && leaves(x.elseBranch); }
  return false;
}

/** Labels, case labels and declarations at the top of a statement list cannot move into a new scope. */
function movable(st: Statement[], declsOk: boolean): string | undefined {
  for (const s of st) {
    for (const { node } of walk(s)) {
      if (node.kind === NodeKind.LabelStmt || node.kind === NodeKind.CaseStmt || node.kind === NodeKind.DefaultStmt) return 'a label would move';
    }
    if (!declsOk && s.kind === NodeKind.DeclStmt) return 'a declaration would change scope';
  }
  return undefined;
}

/** The i-th (1-based) `if` with no else on condition `want`, with its block and index. */
function nthIf(fn: FunctionDecl, want: string, index: number): { b: CompoundStmt; k: number; s: IfStmt } {
  const w = norm(want);
  let seen = 0;
  for (const b of blocks(fn)) {
    for (let k = 0; k < b.statements.length; k++) {
      const s = b.statements[k];
      if (s.kind !== NodeKind.IfStmt) continue;
      const x = s as IfStmt;
      if (x.elseBranch || x.init || text(x.condition) !== w) continue;
      if (++seen === index) return { b, k, s: x };
    }
  }
  return refuse(`no if #${index} on ${want} without an else`);
}

function doNest(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'nest' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (!leaves(s.thenBranch)) refuse('the guard does not always leave');
  const rest = b.statements.slice(k + 1);
  if (rest.length === 0) refuse('nothing follows the guard');
  const why = movable(rest, true);
  if (why) refuse(why);
  const then = { kind: NodeKind.CompoundStmt, statements: rest } as unknown as CompoundStmt;
  b.statements.splice(k, rest.length + 1, { ...s, condition: negateWrap(s.condition), thenBranch: then, elseBranch: asBlock(s.thenBranch) } as IfStmt);
}

function doMergeTail(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'merge-tail' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  const arm = stmtsOf(s.thenBranch);
  const last = arm[arm.length - 1];
  if (!last || last.kind !== NodeKind.ReturnStmt) refuse('the arm does not end in a return');
  const ret = text(last);
  if (arm.length === 1) {
    // The guard: the block ends in the same return.
    const tail = b.statements[b.statements.length - 1];
    if (b.statements.length - 1 <= k || !tail || tail.kind !== NodeKind.ReturnStmt || text(tail) !== ret) refuse('the block does not end in the guard\'s return');
    const between = b.statements.slice(k + 1, b.statements.length - 1);
    if (between.length === 0) refuse('nothing between the guard and the return');
    const why = movable(between, true);
    if (why) refuse(why);
    if (between.some(x => x.kind === NodeKind.DeclStmt && mentions(tail, (declOf(x)?.name.name) ?? '\u0000'))) refuse('the return reads a declaration that would move');
    const then = { kind: NodeKind.CompoundStmt, statements: between } as unknown as CompoundStmt;
    b.statements.splice(k, between.length + 1, { ...s, condition: negateWrap(s.condition), thenBranch: then } as IfStmt);
    return;
  }
  // The arm: the if falls through to the same return, or the block ends in it after other
  // statements, which become the else arm.
  const next = b.statements[k + 1];
  if (next && next.kind === NodeKind.ReturnStmt && text(next) === ret) { arm.pop(); return; }
  const tail = b.statements[b.statements.length - 1];
  if (b.statements.length - 1 <= k + 1 || tail.kind !== NodeKind.ReturnStmt || text(tail) !== ret) refuse('the if does not fall through to the same return');
  const between = b.statements.slice(k + 1, b.statements.length - 1);
  const why = movable(between, true);
  if (why) refuse(why);
  if (between.some(x => x.kind === NodeKind.DeclStmt && mentions(tail, (declOf(x)?.name.name) ?? '\u0000'))) refuse('the return reads a declaration that would move');
  arm.pop();
  s.thenBranch = asBlock(s.thenBranch);
  (s.thenBranch as CompoundStmt).statements = arm;
  s.elseBranch = { kind: NodeKind.CompoundStmt, statements: between } as unknown as CompoundStmt;
  b.statements.splice(k + 1, between.length);
}

/** Put a shared, two-call void tail on the path that skips one invitation-style arm. */
function doTailguard(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'tailguard' }>): void {
  if (text(fn.returnType) !== 'void') refuse('the function does not return void');
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (b !== fn.body) refuse('the if is not at function scope');
  if (s.isConstexpr) refuse('the if is constexpr');
  const condition = unparen(s.condition);
  if (condition.kind !== NodeKind.UnaryExpr || (condition as UnaryExpr).operator !== '!') refuse('the condition is not a negated flag');
  const flag = unparen((condition as UnaryExpr).operand);
  if (flag.kind !== NodeKind.Identifier) refuse('the flag is not an identifier');
  const flagName = (flag as Identifier).name;
  const localDecls = [...walk(fn.body!)].filter(({ node }) => node.kind === NodeKind.VariableDecl && (node as VariableDecl).name.name === flagName)
    .map(({ node }) => node as VariableDecl);
  const prefixDecls = b.statements.slice(0, k).map(declOf).filter((d): d is VariableDecl => d?.name.name === flagName);
  const parameterDecls = fn.parameters.filter(p => isId(p.name, flagName));
  if (localDecls.length + parameterDecls.length !== 1) refuse('the flag has no unique binding');
  const binding = parameterDecls[0] ?? (prefixDecls.length === 1 && prefixDecls[0] === localDecls[0] ? prefixDecls[0] : undefined);
  if (!binding || WIDTH[text(binding.type)] === undefined) refuse('the flag is not a visible integral local or parameter');
  if (s.thenBranch.kind !== NodeKind.CompoundStmt) refuse('the arm has no block scope');
  const arm = s.thenBranch as CompoundStmt;
  if (arm.statements.length === 0) refuse('the arm is empty');
  if ([...walk(arm)].some(({ node }) => [NodeKind.ReturnStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt,
    NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt].includes(node.kind)))
    refuse('the arm has an exit or label');
  const tail = b.statements.slice(k + 1);
  if (tail.length !== 2 || tail.some(x => x.kind !== NodeKind.ExprStmt || unparen((x as ExprStmt).expression).kind !== NodeKind.CallExpr))
    refuse('the function does not end in exactly two calls');
  const calls = tail.map(x => unparen((x as ExprStmt).expression) as unknown as { callee: Expression });
  if (text(calls[0].callee) !== text(calls[1].callee)) refuse('the tail calls differ');
  const ret = parse('void __vc8f() { return; }').declarations[0] as FunctionDecl;
  const guard = { ...s, condition: cloneNode(flag),
    thenBranch: { kind: NodeKind.CompoundStmt,
      statements: [cloneNode(tail[0]), cloneNode(tail[1]), ret.body!.statements[0]],
    } as CompoundStmt } as IfStmt;
  b.statements.splice(k, 1, guard, arm);
}

function doContinue(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'continue' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (k !== b.statements.length - 1) refuse('the if does not end its block');
  const parents = parentsOf(fn);
  const owner = parents.get(b);
  if (!owner || ![NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt].includes(owner.kind) || (owner as unknown as { body: ASTNode }).body !== b) refuse('the block is no loop body');
  const arm = stmtsOf(s.thenBranch);
  const why = movable(arm, false);
  if (why) refuse(why);
  const cont = { kind: NodeKind.CompoundStmt, statements: [{ kind: NodeKind.ContinueStmt } as unknown as Statement] } as unknown as CompoundStmt;
  b.statements.splice(k, 1, { ...s, condition: negateWrap(s.condition), thenBranch: cont } as IfStmt, ...arm);
}

function doDecl(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'decl' }>): void {
  for (const b of blocks(fn)) {
    const from = b.statements.findIndex(s => declOf(s)?.name.name === f.name);
    const to = b.statements.findIndex(s => declOf(s)?.name.name === f.before);
    if (from < 0 || to < 0) continue;
    const d = declOf(b.statements[from])!;
    if (d.initializer) refuse(`${f.name} is initialized`);
    if (from === to - 1) refuse(`${f.name} is before ${f.before} already`);
    const past = from < to ? b.statements.slice(from + 1, to) : b.statements.slice(to, from);
    if (past.some(s => mentions(s, f.name))) refuse(`${f.name} is named by a statement it moves past`);
    // Its type must not name what it moves above.
    if (from > to && past.some(s => { const x = declOf(s); return !!x && mentions(d.type as unknown as ASTNode, x.name.name); })) refuse(`${f.name}'s type names a declaration it moves past`);
    const [s] = b.statements.splice(from, 1);
    b.statements.splice(from < to ? to - 1 : to, 0, s);
    return;
  }
  refuse(`no block declares both ${f.name} and ${f.before}`);
}

function doSelect(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'select' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  const a = soleReturn(s.thenBranch);
  const next = b.statements[k + 1];
  if (!a || !a.value) refuse('the guard is no `return A;`');
  if (k + 1 !== b.statements.length - 1 || next.kind !== NodeKind.ReturnStmt || !(next as ReturnStmt).value) refuse('the guard is not followed by the block\'s last `return B;`');
  const sel = { kind: NodeKind.ConditionalExpr, condition: s.condition, thenExpr: a!.value, elseExpr: (next as ReturnStmt).value } as unknown as ConditionalExpr;
  b.statements.splice(k, 2, { kind: NodeKind.ReturnStmt, value: sel } as unknown as ReturnStmt);
}

function doUnselect(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'unselect' }>): void {
  const w = norm(f.cond);
  const hits: Array<{ b: CompoundStmt; k: number; c: ConditionalExpr }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return;
    const v = unparen((s as ReturnStmt).value!);
    if (v.kind === NodeKind.ConditionalExpr && text((v as ConditionalExpr).condition) === w) hits.push({ b, k, c: v as ConditionalExpr });
  });
  const hit = f.index === 0 ? (hits.length === 1 ? hits[0] : refuse(`${hits.length} returns select on ${f.cond}`)) : (hits[f.index - 1] ?? refuse(`no return #${f.index} selects on ${f.cond}`));
  const ret = (v: Expression) => ({ kind: NodeKind.ReturnStmt, value: v }) as unknown as ReturnStmt;
  const guard = { kind: NodeKind.IfStmt, condition: hit.c.condition, thenBranch: { kind: NodeKind.CompoundStmt, statements: [ret(hit.c.thenExpr)] }, elseBranch: null, isConstexpr: false } as unknown as IfStmt;
  hit.b.statements.splice(hit.k, 1, guard, ret(hit.c.elseExpr));
}

function doDup(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'dup' }>): void {
  const w = norm(f.stmt).replace(/;$/, '');
  const hits: Array<{ b: CompoundStmt; k: number }> = [];
  for (const b of blocks(fn)) {
    for (let k = 1; k < b.statements.length; k++) {
      const s = b.statements[k];
      if (s.kind === NodeKind.ExprStmt && text((s as ExprStmt).expression) === w && b.statements[k - 1].kind === NodeKind.IfStmt) hits.push({ b, k });
    }
  }
  if (hits.length !== 1) refuse(`${hits.length} statements ${f.stmt} after an if`);
  const { b, k } = hits[0];
  const arms: Array<{ holder: IfStmt; key: 'thenBranch' | 'elseBranch' }> = [];
  let cur = b.statements[k - 1] as IfStmt;
  for (;;) {
    if (cur.init) refuse('an if with an init statement');
    arms.push({ holder: cur, key: 'thenBranch' });
    if (!cur.elseBranch) refuse('the if has no final else');
    if (cur.elseBranch.kind === NodeKind.IfStmt) { cur = cur.elseBranch as IfStmt; continue; }
    arms.push({ holder: cur, key: 'elseBranch' });
    break;
  }
  const s = b.statements[k];
  // S lands at the end of each arm: an arm that ends in a jump would never reach it, and a
  // name the arm declares would capture one S reads.
  for (const a of arms) {
    const st = stmtsOf(a.holder[a.key]!);
    if (st.length > 0 && JUMPS.has(st[st.length - 1].kind)) refuse('an arm ends in a jump');
    for (const x of st) {
      if (x.kind !== NodeKind.DeclStmt) continue;
      for (const d of (x as DeclStmt).declarations) {
        const n = (d as unknown as { name?: Identifier }).name;
        if (!n || mentions(s, n.name)) refuse(`an arm declares ${n?.name ?? 'a name'} S reads`);
      }
    }
  }
  for (const a of arms) {
    const blk = asBlock(a.holder[a.key]!);
    blk.statements.push(cloneNode(s));
    a.holder[a.key] = blk;
  }
  b.statements.splice(k, 1);
}

/** The nodes of a kind whose text is `want`, in preorder; the i-th (1-based), or the only one for i = 0. */
function pick<T extends ASTNode>(fn: FunctionDecl, want: string, index: number, ok: (n: ASTNode) => n is T, key: (n: T) => ASTNode = n => n): T {
  const w = norm(want);
  const all = [...walk(fn.body!)].map(x => x.node).filter(ok).filter(n => text(key(n)) === w);
  if (index === 0) {
    if (all.length !== 1) refuse(`${all.length} sites of ${want}`);
    return all[0];
  }
  return all[index - 1] ?? refuse(`no site #${index} of ${want}`);
}

function doTarms(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'tarms' }>): void {
  const c = pick(fn, f.cond, f.index, (n): n is ConditionalExpr => n.kind === NodeKind.ConditionalExpr, n => n.condition);
  const t = c.thenExpr;
  c.condition = negate(c.condition);
  c.thenExpr = c.elseExpr;
  c.elseExpr = t;
}

function doZero(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'zero' }>): void {
  const u = pick(fn, f.expr, f.index, (n): n is UnaryExpr => n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '!', n => unparen(n.operand));
  const e: BinaryExpr = { kind: NodeKind.BinaryExpr, operator: '==', left: u.operand, right: intLit(0n, 10) } as unknown as BinaryExpr;
  // The node keeps its identity: rewrite in place.
  for (const k of Object.keys(u)) delete (u as unknown as Record<string, unknown>)[k];
  Object.assign(u, { kind: NodeKind.ParenExpr, expression: e });
}

function doNonzero(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'nonzero' }>): void {
  const w = norm(f.expr);
  const slots: Slot[] = [];
  for (const { node } of walk(fn.body!)) {
    const o = node as unknown as Record<string, unknown>;
    const at = (field: string) => { const e = o[field] as Expression | null; if (e && text(unparen(e)) === w) slots.push({ parent: o, key: field }); };
    if (node.kind === NodeKind.IfStmt || node.kind === NodeKind.WhileStmt || node.kind === NodeKind.DoWhileStmt || node.kind === NodeKind.ForStmt || node.kind === NodeKind.ConditionalExpr) at('condition');
    if (node.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((node as BinaryExpr).operator)) { at('left'); at('right'); }
  }
  const hit = f.index === 0 ? (slots.length === 1 ? slots[0] : refuse(`${slots.length} truth tests of ${f.expr}`)) : (slots[f.index - 1] ?? refuse(`no truth test #${f.index} of ${f.expr}`));
  const e = unparen((hit.parent as Record<string, unknown>)[hit.key as string] as Expression);
  if (e.kind === NodeKind.BinaryExpr && MIRROR[(e as BinaryExpr).operator] !== undefined) refuse(`${f.expr} is a comparison already`);
  put(hit, { kind: NodeKind.BinaryExpr, operator: '!=', left: { kind: NodeKind.ParenExpr, expression: e }, right: intLit(0n, 10) } as unknown as BinaryExpr);
}

function intLit(v: bigint, base: 10 | 16): Expression {
  const raw = base === 16 ? '0x' + v.toString(16) : v.toString();
  return { kind: NodeKind.IntegerLiteral, value: v, suffix: '', base, raw } as unknown as Expression;
}

/** The signed value of an integer literal, `-N` included; undefined otherwise. */
function litValue(e: Expression): { v: bigint; base: 10 | 16; suffix: string } | undefined {
  e = unparen(e);
  let neg = false;
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '-') { neg = true; e = unparen((e as UnaryExpr).operand); }
  if (e.kind !== NodeKind.IntegerLiteral) return undefined;
  const l = e as unknown as IntegerLiteralExpr;
  if (l.base !== 10 && l.base !== 16) return undefined;
  return { v: neg ? -l.value : l.value, base: l.base, suffix: l.suffix };
}

function litExpr(v: bigint, base: 10 | 16, suffix: string): Expression {
  if (v < 0n) return { kind: NodeKind.UnaryExpr, operator: '-', operand: { ...intLit(-v, base), suffix } } as unknown as Expression;
  return { ...intLit(v, base), suffix } as Expression;
}

/** Whether an expression might be floating point: a float literal, or a cast to float or double. */
function maybeFloat(e: ASTNode, fn: FunctionDecl): boolean {
  const floats = new Set<string>();
  for (const { node } of walk(fn)) {
    if (node.kind === NodeKind.VariableDecl || node.kind === NodeKind.ParameterDecl) {
      const d = node as unknown as { name?: Identifier | null; type: TypeNode };
      if (d.name && /\b(float|double)\b/.test(emit(d.type as never))) floats.add(d.name.name);
    }
  }
  for (const { node } of walk(e)) {
    if (node.kind === NodeKind.FloatingLiteral) return true;
    if (node.kind === NodeKind.CStyleCastExpr && /\b(float|double)\b/.test(text((node as CStyleCastExpr).type))) return true;
    if (isId(node) && floats.has(node.name)) return true;
  }
  return false;
}

const SIGNED = /^(int|signedint|long|signedlong|short|signedshort|shortint|signedchar|int8_t|int16_t|int32_t|BOOL|LONG|INT|SHORT)$/;

/** Whether an expression is known to be signed: a local or parameter declared signed, or a cast to a signed type. */
function signedSide(e: Expression, fn: FunctionDecl): boolean {
  e = unparen(e);
  if (e.kind === NodeKind.CStyleCastExpr) return SIGNED.test(text((e as CStyleCastExpr).type));
  if (!isId(e)) return false;
  let t: string | undefined;
  for (const { node } of walk(fn)) {
    if (node.kind !== NodeKind.VariableDecl && node.kind !== NodeKind.ParameterDecl) continue;
    const d = node as unknown as { name?: Identifier | null; type: TypeNode };
    if (d.name && d.name.name === e.name) t = text(d.type);
  }
  return t !== undefined && SIGNED.test(t);
}

const MIRROR: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
const LIT: Record<string, { op: string; d: bigint }> = { '<': { op: '<=', d: -1n }, '<=': { op: '<', d: 1n }, '>': { op: '>=', d: 1n }, '>=': { op: '>', d: -1n } };

const effects = (e: ASTNode) => [...walk(e)].some(x => x.node.kind === NodeKind.CallExpr || x.node.kind === NodeKind.AssignExpr || x.node.kind === NodeKind.PostfixExpr ||
  (x.node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((x.node as UnaryExpr).operator)));

function doCmp(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'cmp' }>): void {
  const c = pick(fn, f.cond, f.index, (n): n is BinaryExpr => n.kind === NodeKind.BinaryExpr && MIRROR[(n as BinaryExpr).operator] !== undefined);
  if (f.how === 'mirror' || f.how === 'mirror-lit') {
    if (effects(c.left) && effects(c.right)) refuse('both sides have effects');
    const l = c.left;
    c.left = c.right; c.right = l;
    c.operator = MIRROR[c.operator] as BinaryExpr['operator'];
  }
  if (f.how === 'lit' || f.how === 'mirror-lit') {
    const m = LIT[c.operator];
    const lv = litValue(c.right);
    if (!m || !lv) refuse('no integer literal bound');
    if (maybeFloat(c.left, fn)) refuse('the compare may be floating point');
    const nv = lv!.v + m.d;
    // Stay inside one 32-bit range on both readings: no wrap at the signed or unsigned edge.
    if (nv < -0x80000000n || nv > 0xffffffffn || (lv!.v <= 0x7fffffffn) !== (nv <= 0x7fffffffn)) refuse('the bound would cross a range edge');
    // -1 and 0 are one apart only when the left side is signed: unsigned, -1 is the maximum.
    if ((lv!.v >= 0n) !== (nv >= 0n) && !signedSide(c.left, fn)) refuse('the bound would cross zero on a side not known to be signed');
    c.operator = m.op as BinaryExpr['operator'];
    c.right = litExpr(nv, lv!.base, lv!.suffix);
  }
}

const COMMUTES = new Set(['+', '*', '&', '|', '^']);

function doSwap(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'swap' }>): void {
  const b = pick(fn, f.expr, f.index, (n): n is BinaryExpr => n.kind === NodeKind.BinaryExpr && COMMUTES.has((n as BinaryExpr).operator));
  if (effects(b.left) && effects(b.right)) refuse('both operands have effects');
  const l = b.left;
  b.left = b.right; b.right = l;
}

function doIfsel(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'ifsel' }>): void {
  const store = (v: Expression) => ({ kind: NodeKind.CompoundStmt, statements: [{ kind: NodeKind.ExprStmt, expression: { kind: NodeKind.AssignExpr, operator: '=', left: { kind: NodeKind.Identifier, name: f.name }, right: v } }] }) as unknown as CompoundStmt;
  const hits: Array<{ b: CompoundStmt; k: number; c: ConditionalExpr; decl?: VariableDecl }> = [];
  for (const b of blocks(fn)) {
    b.statements.forEach((s, k) => {
      const st = storeOf(s); const d = declOf(s);
      if (st && st.operator === '=' && isId(unparen(st.left), f.name) && unparen(st.right).kind === NodeKind.ConditionalExpr) hits.push({ b, k, c: unparen(st.right) as ConditionalExpr });
      else if (d && d.name.name === f.name && d.initializer && unparen(d.initializer as Expression).kind === NodeKind.ConditionalExpr) hits.push({ b, k, c: unparen(d.initializer as Expression) as ConditionalExpr, decl: d });
    });
  }
  if (hits.length !== 1) refuse(`${hits.length} selects into ${f.name}`);
  const { b, k, c, decl } = hits[0];
  const sel = { kind: NodeKind.IfStmt, condition: c.condition, thenBranch: store(c.thenExpr), elseBranch: store(c.elseExpr), isConstexpr: false } as unknown as IfStmt;
  if (decl) {
    decl.initializer = null;
    b.statements.splice(k + 1, 0, sel);
  } else b.statements.splice(k, 1, sel);
}

function doSplit(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'split' }>): void {
  if (localNames(fn).has(f.rename)) refuse(`${f.rename} exists`);
  if (addressTaken(fn, f.name)) refuse(`&${f.name} is taken`);
  const parents = parentsOf(fn);
  const inLoop = (n: ASTNode) => { for (let p = parents.get(n); p; p = parents.get(p)) if ([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt].includes(p.kind)) return true; return false; };
  const sites: Array<{ b: CompoundStmt; k: number; end: number }> = [];
  for (const b of blocks(fn)) {
    for (let k = 0; k < b.statements.length; k++) {
      const st = storeOf(b.statements[k]);
      if (!st || st.operator !== '=' || !isId(unparen(st.left), f.name) || mentions(st.right, f.name)) continue;
      // Its life: up to the next plain store to V that does not read V, in this block.
      let end = k + 1;
      for (; end < b.statements.length; end++) {
        const n = storeOf(b.statements[end]);
        if (n && n.operator === '=' && isId(unparen(n.left), f.name) && !mentions(n.right, f.name)) break;
      }
      sites.push({ b, k, end });
    }
  }
  // The life to split is the only one after which nothing reads V: at the end of its block
  // the value must be dead.
  const ok = sites.filter(({ b, k, end }) => {
    const life = b.statements.slice(k + 1, end);
    if (!life.some(s => mentions(s, f.name))) return false;
    if (life.some(s => storedNames(s).has(f.name))) return false;
    if (inLoop(b.statements[k])) return false;
    if (end === b.statements.length && blockReadsAfter(fn, b, f.name, k)) return false;
    return true;
  });
  if (ok.length === 0) refuse(`no life of ${f.name} to split`);
  // The last such life: the earlier ones are the original variable's.
  const { b, k, end } = ok[ok.length - 1];
  const st = storeOf(b.statements[k])!;
  const decl = parse(`void __vc8f() { ${f.type} ${f.rename} = 0; }`).declarations[0] as FunctionDecl;
  const d = decl.body!.statements[0];
  declOf(d)!.initializer = st.right;
  b.statements[k] = d;
  for (const s of b.statements.slice(k + 1, end)) for (const { node } of walk(s)) if (isId(node, f.name)) (node as Identifier).name = f.rename;
}

const APPLY: { [K in Vc8Form['op']]: (fn: FunctionDecl, f: Extract<Vc8Form, { op: K }>) => void } = {
  seq: doSeq, fold: doFold, cache: doCache, own: doOwn, guards: doGuards, 'merge-guards': doMergeGuards,
  retval: doRetval, width: doWidth, arms: doArms,
  nest: doNest, 'merge-tail': doMergeTail, tailguard: doTailguard, continue: doContinue, dup: doDup, tarms: doTarms, zero: doZero, nonzero: doNonzero,
  cmp: doCmp, swap: doSwap, ifsel: doIfsel, split: doSplit, select: doSelect, decl: doDecl, unselect: doUnselect,
};

/**
 * Apply the forms to the (single) function definition in tu, in order. Each form works on
 * a copy and is kept only when it applied whole.
 */
export function applyVc8Forms(tu: TranslationUnit, forms: Array<{ form: Vc8Form; tag?: string }>,
  onSite?: (s: Vc8FormSite) => void): TranslationUnit {
  if (forms.length === 0) return tu;
  let cur = tu;
  for (const { form, tag } of forms) {
    const next = cloneNode(cur);
    const fn = next.declarations.find(d => d.kind === NodeKind.FunctionDecl && (d as FunctionDecl).body) as FunctionDecl | undefined;
    try {
      if (!fn) refuse('no function body');
      (APPLY[form.op] as (fn: FunctionDecl, f: Vc8Form) => void)(fn!, form);
      cur = next;
      onSite?.({ form, tag, applied: true });
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      onSite?.({ form, tag, applied: false, why: e.message });
    }
  }
  return cur;
}

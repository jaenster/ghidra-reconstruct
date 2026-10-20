/**
 * Conditional branches on CPU flags, lowered to the comparison they implement.
 *
 * Ghidra prints a signed conditional jump through the flags the compare set:
 *
 *   jl   OF != SF          jge  OF == SF
 *   jle  ZF || OF != SF    jg   !ZF && OF == SF
 *
 * with OF = SBORROWn(a, b), SF = (a - b) < 0 and ZF = a == b after `CMP a, b`, or
 * OF = false, SF = x < 0, ZF = x == 0 after `TEST x, x`. Those ARE the definitions of the
 * signed conditions, so each is exactly `a < b`, `a >= b`, `a <= b`, `a > b` (or `x OP 0`).
 *
 * The decompiler does not always print that shape on one line:
 *
 *  - Where several paths jump into one conditional branch, it keeps the flags in
 *    variables, set on each path (`bOF = SBORROW4(n, 1); bZF = n == 1; goto LAB;`), and
 *    the paths may set them from different instructions (CMP on one, TEST on another).
 *    PropertyFunc_Charges 0065dbc0, pqdownheap 0042ba50, INPUT_MiniPanelMouseDown 0047ef30.
 *  - It substitutes known values into the companion terms: `SBORROW4(x, r) != r * -2 < 0`
 *    where x = -r (MISSILES_SpawnAreaPattern 005a9530), or `SBORROW4(c, 1)` with the sign
 *    test spelled on s where c = s + 1.
 *  - It keeps a constant the compare used in a register variable (`nBelt = -4`) and spells
 *    the sign test through it (`n + nBelt < 0`).
 *
 * This pass recovers the comparison in all three cases, and only when it can PROVE it:
 *
 *  1. The condition is one of the four shapes, over components that are flag variables or
 *     the flag expressions themselves.
 *  2. Every flag variable's reaching definitions (over the function's CFG) are assignments
 *     in straight-line GROUPS: one run of expression statements per path, entered only at
 *     its first statement, that defines every flag variable the condition reads.
 *  3. At the end of each group, the condition's value is computed by substituting the
 *     group's definitions; no variable the condition or a definition reads may change
 *     between the definition and the group end, or between the group end and the
 *     condition on any path.
 *  4. The substituted triple must be a signed compare by the identities above, where
 *     "a - b" and "x" are matched as LINEAR FORMS modulo 2^32 (with the single reaching
 *     definition of a variable expanded when nothing it reads changes in between), not as
 *     text. `-r == r` matches `x == r` when x = -r reaches; `s < 0` matches the sign of
 *     `c - 1` when c = s + 1 reaches.
 *
 * Then each group ends with `bSignedLess = a < b;` (one name per condition kind), the
 * condition reads that variable, and the flag assignments - and any assignment in a group
 * whose only reader was the condition - are removed. A condition with no flag variables is
 * replaced by its compare in place. Anything that fails a check is left alone, to be
 * lowered exactly (bitwise) by `pseudo-op-lower`.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  CallExpr,
  CStyleCastExpr,
  DeclStmt,
  Expression,
  ExprStmt,
  Identifier,
  IntegerLiteralExpr,
  Statement,
  UnaryExpr,
  VariableDecl,
  AssignExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { buildFunctionFlow, ENTRY_DEF, type FunctionFlow } from '../../cfg/dataflow.js';
import { unwrapParens } from './call-arg-cast.js';

export interface FlagOperandClass {
  kind: 'int' | 'ptr' | 'float' | 'unknown';
  width?: number;
  signed?: boolean;
}

export interface FlagConditionDeps {
  classify: (e: Expression) => FlagOperandClass;
  isPure: (e: ASTNode) => boolean;
  /** Parameters and locals of the function. */
  locals: ReadonlySet<string>;
}

export type FlagCondKind = 'lt' | 'ge' | 'le' | 'gt';
const KIND_OP: Record<FlagCondKind, string> = { lt: '<', ge: '>=', le: '<=', gt: '>' };
export const FLAG_COND_NAME: Record<FlagCondKind, string> = {
  le: 'bSignedLessOrEqual', gt: 'bSignedGreater', lt: 'bSignedLess', ge: 'bSignedGreaterOrEqual',
};

// ============================================
// LINEAR FORMS (mod 2^32)
// ============================================

const MOD = 1n << 32n;
const norm = (v: bigint) => ((v % MOD) + MOD) % MOD;

/** sum(coef * atom) + c, modulo 2^32. Atoms are keyed by a canonical spelling. */
interface Lin { terms: Map<string, bigint>; c: bigint }

const linConst = (c: bigint): Lin => ({ terms: new Map(), c: norm(c) });
function linAdd(a: Lin, b: Lin, sign: bigint): Lin {
  const terms = new Map(a.terms);
  for (const [k, v] of b.terms) {
    const r = norm((terms.get(k) ?? 0n) + sign * v);
    if (r === 0n) terms.delete(k); else terms.set(k, r);
  }
  return { terms, c: norm(a.c + sign * b.c) };
}
function linScale(a: Lin, k: bigint): Lin {
  const terms = new Map<string, bigint>();
  for (const [t, v] of a.terms) { const r = norm(v * k); if (r !== 0n) terms.set(t, r); }
  return { terms, c: norm(a.c * k) };
}
const linIsZero = (a: Lin) => a.terms.size === 0 && a.c === 0n;
const linEq = (a: Lin, b: Lin) => linIsZero(linAdd(a, b, -1n));

/** The integer value of a literal expression, or null. */
function literalValue(e: Expression): bigint | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = literalValue((x as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  return null;
}

/**
 * Value environment for linear forms: `expand(name)` returns the expression a variable
 * provably holds at the evaluation point, or null to keep it as an atom.
 */
type Expand = (name: string) => Expression | null;

function makeLinearizer(deps: FlagConditionDeps) {
  const isWord = (e: Expression) => {
    const c = deps.classify(e);
    return (c.kind === 'int' && (c.width ?? 0) <= 4) || c.kind === 'ptr';
  };
  const lin = (e: Expression, expand: Expand, depth: number, seen: ReadonlySet<string>): Lin | null => {
    const x = unwrapParens(e);
    const lit = literalValue(x);
    if (lit !== null) return linConst(lit);
    switch (x.kind) {
      case NodeKind.Identifier: {
        const name = (x as Identifier).name;
        if (!isWord(x)) return null;
        if (depth < 6 && !seen.has(name)) {
          const def = expand(name);
          if (def) {
            const inner = lin(def, expand, depth + 1, new Set([...seen, name]));
            if (inner) return inner;
          }
        }
        return { terms: new Map([[`v:${name}`, 1n]]), c: 0n };
      }
      case NodeKind.CStyleCastExpr: {
        // A cast between 4-byte integers (or a pointer and one) keeps the bits.
        const c = deps.classify(x);
        const inner = (x as CStyleCastExpr).expression;
        const ic = deps.classify(inner);
        const word = (k: FlagOperandClass) => (k.kind === 'int' && k.width === 4) || k.kind === 'ptr';
        if (word(c) && word(ic)) return lin(inner, expand, depth, seen);
        // A widening of a narrower integer is its (promoted) value: an atom of its own.
        break;
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '-' || u.operator === '+') {
          if (!isWord(u.operand) || deps.classify(u.operand).kind === 'ptr') return null;
          const inner = lin(u.operand, expand, depth, seen);
          return inner && (u.operator === '-' ? linScale(inner, -1n) : inner);
        }
        break;
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if (b.operator === '+' || b.operator === '-') {
          const lc = deps.classify(b.left), rc = deps.classify(b.right);
          // Pointer arithmetic scales; only integer + integer is linear in the bits.
          if (lc.kind !== 'int' || rc.kind !== 'int' || (lc.width ?? 8) > 4 || (rc.width ?? 8) > 4) return null;
          const l = lin(b.left, expand, depth, seen), r = lin(b.right, expand, depth, seen);
          return l && r ? linAdd(l, r, b.operator === '+' ? 1n : -1n) : null;
        }
        if (b.operator === '*') {
          const lv = literalValue(b.left), rv = literalValue(b.right);
          if (rv !== null && isWord(b.left)) { const l = lin(b.left, expand, depth, seen); return l && linScale(l, rv); }
          if (lv !== null && isWord(b.right)) { const r = lin(b.right, expand, depth, seen); return r && linScale(r, lv); }
        }
        break;
      }
      default:
        break;
    }
    // Any other pure 4-byte value is an atom, keyed by what it says.
    if (!deps.isPure(x) || !isWord(x)) return null;
    return { terms: new Map([[`e:${emit(x as AnyNode).replace(/\s+/g, ' ')}`, 1n]]), c: 0n };
  };
  return (e: Expression, expand: Expand) => lin(e, expand, 0, new Set());
}

// ============================================
// CONDITION SHAPES
// ============================================

/** The four signed-condition shapes, with the flag components still unresolved. */
interface CondShape {
  kind: FlagCondKind;
  /** The OF and SF components, in either order (resolved by evaluation). */
  pair: [Expression, Expression];
  /** The ZF component (`le`/`gt` only). */
  zf?: Expression;
}

function matchShape(e: Expression): CondShape | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.BinaryExpr) return null;
  const b = x as BinaryExpr;
  if (b.operator === '!=' || b.operator === '==') {
    return { kind: b.operator === '!=' ? 'lt' : 'ge', pair: [b.left, b.right] };
  }
  if (b.operator === '||' || b.operator === '&&') {
    const inner = b.operator === '||' ? '!=' : '==';
    for (const [z, p] of [[b.left, b.right], [b.right, b.left]] as const) {
      const pp = unwrapParens(p);
      if (pp.kind !== NodeKind.BinaryExpr || (pp as BinaryExpr).operator !== inner) continue;
      let zf: Expression = z;
      if (b.operator === '&&') {
        const zz = unwrapParens(z);
        if (zz.kind !== NodeKind.UnaryExpr || (zz as UnaryExpr).operator !== '!') continue;
        zf = (zz as UnaryExpr).operand;
      }
      return { kind: b.operator === '||' ? 'le' : 'gt', pair: [(pp as BinaryExpr).left, (pp as BinaryExpr).right], zf };
    }
  }
  return null;
}

/** `SBORROWn(a, b)`: n and the operands. */
function sborrowOf(e: Expression): { n: number; a: Expression; b: Expression } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CallExpr) return null;
  const c = x as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier || c.arguments.length !== 2) return null;
  const m = /^SBORROW(\d)$/.exec((c.callee as Identifier).name);
  return m ? { n: Number(m[1]), a: c.arguments[0], b: c.arguments[1] } : null;
}

const isFalse = (e: Expression) => {
  const x = unwrapParens(e);
  return (x.kind === NodeKind.BoolLiteral && (x as unknown as { value: boolean }).value === false)
    || (x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n);
};

const containsSborrow = (e: unknown): boolean => {
  if (Array.isArray(e)) return e.some(containsSborrow);
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.CallExpr && sborrowOf(o as unknown as Expression)) return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && containsSborrow(v)) return true;
  }
  return false;
};

/** Identifiers read by an expression. */
function freeNames(e: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(e)) { for (const x of e) freeNames(x, out); return out; }
  if (!e || typeof e !== 'object') return out;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.Identifier) { out.add(o.name as string); return out; }
  if (o.kind === NodeKind.CallExpr) {
    // A pseudo-op's name is not a variable.
    for (const a of (o as unknown as CallExpr).arguments) freeNames(a, out);
    return out;
  }
  if (o.kind === NodeKind.MemberExpr) { freeNames(o.object, out); return out; }
  if (o.kind === NodeKind.UnaryExpr && (o.operator === '*')) out.add('*mem');
  if (o.kind === NodeKind.MemberExpr || o.kind === NodeKind.SubscriptExpr) out.add('*mem');
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
    if (v && typeof v === 'object') freeNames(v, out);
  }
  return out;
}

/** Does `e` read memory (a dereference, `->`, or a subscript)? */
function readsMemory(e: unknown): boolean {
  if (Array.isArray(e)) return e.some(readsMemory);
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.UnaryExpr && o.operator === '*') return true;
  if (o.kind === NodeKind.MemberExpr && o.isArrow) return true;
  if (o.kind === NodeKind.SubscriptExpr) return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
    if (v && typeof v === 'object' && readsMemory(v)) return true;
  }
  return false;
}

/** Copy-on-write rebuild: `fn` returns a replacement for a node, or undefined to descend. */
function rebuild<T>(root: T, fn: (n: ASTNode) => ASTNode | undefined): T {
  const go = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let changed = false;
      const out = x.map(i => { const r = go(i); if (r !== i) changed = true; return r; });
      return changed ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (typeof o.kind === 'string') {
      const r = fn(o as unknown as ASTNode);
      if (r !== undefined) return r;
    }
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || !v || typeof v !== 'object') continue;
      const r = go(v);
      if (r !== v) { copy = copy ?? { ...o }; copy[k] = r; }
    }
    return copy ?? x;
  };
  return go(root) as T;
}

// ============================================
// EVALUATION
// ============================================

interface Resolved { kind: FlagCondKind; a: Expression; b: Expression | null }

/**
 * Given the component VALUES (flag variables already substituted), decide which compare
 * the condition is. Returns null when the identities cannot be proven.
 */
function resolveCompare(
  shape: CondShape, values: { pair: [Expression, Expression]; zf?: Expression },
  deps: FlagConditionDeps, linear: ReturnType<typeof makeLinearizer>, expand: Expand,
): Resolved | null {
  const L = (e: Expression) => linear(e, expand);
  /** `E < 0` where E is a signed value of width n: E. */
  const signTest = (e: Expression, n: number): Expression | null => {
    const x = unwrapParens(e);
    if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '<') return null;
    if (literalValue((x as BinaryExpr).right) !== 0n) return null;
    const lhs = (x as BinaryExpr).left;
    const c = deps.classify(lhs);
    if (c.kind !== 'int' || c.width !== n || c.signed !== true) return null;
    return lhs;
  };
  /** `p == q`: the linear form of p - q. */
  const eqForm = (e: Expression): Lin | null => {
    const x = unwrapParens(e);
    if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '==') return null;
    const p = L((x as BinaryExpr).left), q = L((x as BinaryExpr).right);
    return p && q ? linAdd(p, q, -1n) : null;
  };
  const zfMatches = (diff: Lin): boolean => {
    if (!shape.zf) return true;
    const z = eqForm(values.zf!);
    return !!z && (linEq(z, diff) || linEq(z, linScale(diff, -1n)));
  };

  for (const [of, sf] of [[values.pair[0], values.pair[1]], [values.pair[1], values.pair[0]]] as const) {
    const sb = sborrowOf(of);
    if (sb) {
      if (sb.n !== 4) continue;
      if (!deps.isPure(sb.a) || !deps.isPure(sb.b)) return null;
      const E = signTest(sf, 4);
      if (!E) continue;
      const la = L(sb.a), lb = L(sb.b), le = L(E);
      if (!la || !lb || !le) return null;
      const diff = linAdd(la, lb, -1n);
      if (!linEq(le, diff)) continue;
      if (!zfMatches(diff)) return null;
      return { kind: shape.kind, a: sb.a, b: sb.b };
    }
    if (isFalse(of)) {
      // TEST x, x: OF clear, SF = x < 0, ZF = x == 0.
      const E = signTest(sf, 4);
      if (!E) continue;
      const le = L(E);
      if (!le) return null;
      if (!zfMatches(le)) return null;
      return { kind: shape.kind, a: E, b: null };
    }
  }
  return null;
}

/** The signed n-byte view of e: e itself when it already is one. */
function signedView(e: Expression, deps: FlagConditionDeps): Expression {
  const lit = literalValue(e);
  if (lit !== null && lit >= -(1n << 31n) && lit < (1n << 31n)) return e;
  const c = deps.classify(e);
  if (c.kind === 'int' && c.width === 4 && c.signed === true) return e;
  return Expr.cast(Type.typedef('int32_t'), Expr.paren(e));
}

function compareExpr(r: Resolved, deps: FlagConditionDeps): Expression {
  const a = signedView(r.a, deps);
  const b = r.b ? signedView(r.b, deps) : Expr.intLiteral(0n);
  return Expr.binary(a, KIND_OP[r.kind] as never, b);
}

// ============================================
// THE REWRITE
// ============================================

interface StmtSlot { list: Statement[]; index: number; owner: ASTNode }

/** The statement under any case/default/label wrappers. */
function innerStmt(st: Statement): Statement {
  let x = st as ASTNode;
  while (x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt || x.kind === NodeKind.LabelStmt) {
    x = (x as unknown as { statement: ASTNode }).statement;
  }
  return x as Statement;
}
const isWrapped = (st: Statement) => innerStmt(st) !== st;

/** `v = rhs;` as a plain statement: v and rhs. */
function simpleAssign(st: Statement): { v: string; rhs: Expression } | null {
  if (st.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens((st as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrapParens((e as AssignExpr).left);
  if (l.kind !== NodeKind.Identifier) return null;
  return { v: (l as Identifier).name, rhs: (e as AssignExpr).right };
}

/** Every statement list in the body, with its owning compound. */
function statementSlots(body: ASTNode): Map<Statement, StmtSlot> {
  const out = new Map<Statement, StmtSlot>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.CompoundStmt) {
      const list = (n as unknown as { statements: Statement[] }).statements;
      list.forEach((s, i) => {
        out.set(s, { list, index: i, owner: n });
        // A wrapped statement's inner statement shares the slot.
        if (isWrapped(s)) out.set(innerStmt(s), { list, index: i, owner: n });
      });
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(body);
  return out;
}

interface Group {
  slot: StmtSlot;
  /** First and last index of the run in slot.list. */
  lo: number;
  end: number;
  /** flag variable -> index of its definition. */
  defs: Map<string, number>;
}

interface Candidate { node: number; cond: Expression; shape: CondShape }

/** The conditions in a node's own expressions, outermost first, not nested in each other. */
function candidatesIn(flow: FunctionFlow, node: number, flagVars: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as ASTNode;
    if (o.kind === NodeKind.BinaryExpr) {
      const shape = matchShape(o as Expression);
      if (shape) {
        const comps = [...shape.pair, ...(shape.zf ? [shape.zf] : [])];
        const flagged = comps.some(c => {
          const u = unwrapParens(c);
          return (u.kind === NodeKind.Identifier && flagVars.has((u as Identifier).name)) || !!sborrowOf(u);
        });
        if (flagged) { out.push({ node, cond: o as Expression, shape }); return; }
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') visit(v);
    }
  };
  for (const e of flow.ownExprs(node)) visit(e);
  return out;
}

/**
 * Lower every provable flag condition in a function body. `body` is the function's
 * statement list; the result is the new list (the same array when nothing changed).
 */
export function lowerFlagConditions(body: Statement[], given: FlagConditionDeps): Statement[] {
  // A flag pseudo-op reads its operands and nothing else.
  const isPure = (e: ASTNode): boolean => {
    const s = sborrowOf(e as Expression);
    return s ? isPure(s.a) && isPure(s.b) : given.isPure(e);
  };
  const deps: FlagConditionDeps = { ...given, isPure };
  const linear = makeLinearizer(deps);
  let current = body;
  const declared = new Set<string>(deps.locals);
  // One condition per round: each rewrite changes the graph the next proof needs.
  for (let round = 0; round < 64; round++) {
    const next = lowerOne(current, deps, linear, declared);
    if (!next) break;
    current = next;
  }
  return current;
}

function lowerOne(
  body: Statement[], deps: FlagConditionDeps, linear: ReturnType<typeof makeLinearizer>, declared: Set<string>,
): Statement[] | null {
  const root = { kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode;
  if (!containsSborrow(root)) return null;
  const flow = buildFunctionFlow(body, deps.locals);
  const slots = statementSlots(root);

  // Flag variables: locals with a definition `v = SBORROWn(...)` somewhere.
  const flagVars = new Set<string>();
  for (const [st] of slots) {
    const a = simpleAssign(innerStmt(st));
    if (a && deps.locals.has(a.v) && !flow.isEscaped(a.v) && sborrowOf(a.rhs)) flagVars.add(a.v);
  }

  for (const n of flow.cfg.nodes) {
    for (const cand of candidatesIn(flow, n.id, flagVars)) {
      const out = tryCandidate(cand, body, flow, slots, flagVars, deps, linear, declared);
      if (out) return out;
    }
  }
  return null;
}

/** Set FLAG_CONDITIONS_TRACE=1 to log why each candidate condition was left alone. */
const TRACE = typeof process !== 'undefined' && process.env?.FLAG_CONDITIONS_TRACE === '1';
const fail = (why: number): null => {
  if (TRACE) console.error(`[flag-conditions] rejected at check ${why}`);
  return null;
};

function tryCandidate(
  cand: Candidate, body: Statement[], flow: FunctionFlow, slots: Map<Statement, StmtSlot>,
  flagVars: ReadonlySet<string>, deps: FlagConditionDeps, linear: ReturnType<typeof makeLinearizer>,
  declared: Set<string>,
): Statement[] | null {
  const { node, shape } = cand;
  const comps = [...shape.pair, ...(shape.zf ? [shape.zf] : [])];
  const vars = new Set<string>();
  for (const c of comps) {
    const u = unwrapParens(c);
    if (u.kind === NodeKind.Identifier && flagVars.has((u as Identifier).name)) vars.add((u as Identifier).name);
    else if (u.kind === NodeKind.Identifier && deps.locals.has((u as Identifier).name)) {
      // A component held in a variable that is not a flag variable: a ZF/SF variable of a
      // triple qualifies once its group is found below.
      vars.add((u as Identifier).name);
    }
  }
  for (const v of vars) if (!deps.locals.has(v) || flow.isEscaped(v)) return fail(1);

  /** Expansion of a variable at the START of node `at`, through its single reaching def. */
  const expandAt = (at: number, exclude: ReadonlySet<string>): Expand => (name) => {
    if (exclude.has(name) || !deps.locals.has(name) || flow.isEscaped(name)) return null;
    const defs = flow.reaching(at, name);
    if (defs.size !== 1) return null;
    const d = [...defs][0];
    if (d === ENTRY_DEF) return null;
    const info = flow.definition(d, name);
    if (!info || !info.killing || !info.rhs || !deps.isPure(info.rhs)) return null;
    const reads = freeNames(info.rhs);
    reads.add(name);
    if (readsMemory(info.rhs)) reads.add('*mem');
    if ([...reads].some(r => r !== '*mem' && (!deps.locals.has(r) || flow.isEscaped(r)))) return null;
    if (writtenBetweenOrMem(flow, d, at, reads)) return null;
    return info.rhs;
  };

  // ---- Inline: no flag variables, the condition is the compare on its own line.
  if (vars.size === 0) {
    const r = resolveCompare(shape, { pair: shape.pair, zf: shape.zf }, deps, linear, expandAt(node, new Set()));
    if (!r) return fail(8);
    const cmp = compareExpr(r, deps);
    return rebuild(body, x => (x === cand.cond ? withTrivia(Expr.paren(cmp), x) : undefined));
  }

  // ---- Grouped: every flag variable's reaching definitions are in groups.
  const found: Array<{ v: string; slot: StmtSlot }> = [];
  for (const v of vars) {
    const defs = flow.reaching(node, v);
    if (defs.has(ENTRY_DEF)) return fail(9);
    for (const d of defs) {
      const info = flow.definition(d, v);
      const st = flow.cfg.nodes[d].stmt;
      if (!info || !info.killing || !info.rhs || !st) return fail(10);
      const a = simpleAssign(st);
      if (!a || a.v !== v) return fail(11);
      const slot = slots.get(st);
      if (!slot) return fail(12);
      // Its definition is used by this condition only.
      const uses = flow.usesOf(d, v);
      if (uses.length !== 1 || uses[0] !== node) return fail(13);
      found.push({ v, slot });
    }
  }
  // Cluster the definitions: same statement list, separated only by unwrapped expression
  // statements that read no flag variable. A wrapped (labelled) definition starts a group.
  const groupList: Group[] = [];
  const byList = new Map<Statement[], Array<{ v: string; slot: StmtSlot }>>();
  for (const f of found) {
    const l = byList.get(f.slot.list) ?? [];
    l.push(f);
    byList.set(f.slot.list, l);
  }
  for (const [list, fs] of byList) {
    fs.sort((x, y) => x.slot.index - y.slot.index);
    let g: Group | null = null;
    for (const f of fs) {
      const i = f.slot.index;
      let joins = !!g && !isWrapped(list[i]);
      if (g && joins) {
        for (let j = g.end + 1; j < i; j++) {
          if (isWrapped(list[j]) || list[j].kind !== NodeKind.ExprStmt || readsAny(list[j], vars, flow)) { joins = false; break; }
        }
      }
      if (!g || !joins) {
        g = { slot: f.slot, lo: i, end: i, defs: new Map() };
        groupList.push(g);
      }
      if (g.defs.has(f.v)) return fail(14);
      g.defs.set(f.v, i);
      g.end = i;
    }
  }
  const groups = new Map<string, Group>(groupList.map((g, i) => [String(i), g]));
  // Every group defines every variable, the run is straight-line, and ends before the
  // condition and before anything that reads a flag variable.
  for (const g of groups.values()) {
    if (g.defs.size !== vars.size) return fail(15);
    let end = Math.max(...g.defs.values());
    while (end + 1 < g.slot.list.length) {
      const s = g.slot.list[end + 1];
      if (isWrapped(s) || s.kind !== NodeKind.ExprStmt) break;
      const sn = flow.nodeOf(s);
      if (sn === undefined || sn === node || readsAny(s, vars, flow)) break;
      end++;
    }
    for (let i = g.lo + 1; i <= end; i++) {
      if (isWrapped(g.slot.list[i]) || g.slot.list[i].kind !== NodeKind.ExprStmt) return fail(16);
    }
    g.end = end;
  }
  const groupStarts = new Set<number>();
  for (const g of groups.values()) {
    const sn = flow.nodeOf(g.slot.list[g.lo]);
    if (sn === undefined) return fail(17);
    groupStarts.add(sn);
  }

  // Variables the condition reads besides the flags must not change between a group's
  // end and the condition.
  const condReads = freeNames(cand.cond);
  if (readsMemory(cand.cond)) condReads.add('*mem');
  for (const r of condReads) if (r !== '*mem' && !vars.has(r) && (!deps.locals.has(r) || flow.isEscaped(r))) return fail(18);

  const perGroup: Array<{ g: Group; cmp: Expression }> = [];
  let kind: FlagCondKind | null = null;
  for (const g of groups.values()) {
    const endNode = flow.nodeOf(g.slot.list[g.end])!;
    if (writtenBetweenOrMem(flow, endNode, node, new Set([...condReads, ...vars]), groupStarts)) return fail(19);
    // Each definition's operands are unchanged from it to the group end.
    const stmtNode = (i: number) => flow.nodeOf(g.slot.list[i])!;
    const env = new Map<string, Expression>();
    const writtenInRun = new Set<string>();
    for (let i = g.lo; i <= g.end; i++) for (const w of flow.writes(stmtNode(i))) writtenInRun.add(w);
    const stableFrom = (i: number, e: Expression) => {
      const reads = freeNames(e);
      const mem = readsMemory(e);
      for (let j = i + 1; j <= g.end; j++) {
        const sn = stmtNode(j);
        for (const r of reads) if (flow.writes(sn).has(r)) return false;
        if (mem && clobbers(flow, sn)) return false;
      }
      return true;
    };
    for (let i = g.lo; i <= g.end; i++) {
      const a = simpleAssign(innerStmt(g.slot.list[i]));
      if (!a) continue;
      if (!deps.isPure(a.rhs)) { env.delete(a.v); continue; }
      if (stableFrom(i, a.rhs)) env.set(a.v, a.rhs); else env.delete(a.v);
    }
    for (const v of vars) {
      const i = g.defs.get(v)!;
      const a = simpleAssign(innerStmt(g.slot.list[i]))!;
      if (!deps.isPure(a.rhs) || !stableFrom(i, a.rhs)) return fail(20);
    }
    // Values at the group end: the group's own definitions, else what reaches its start.
    const startNode = stmtNode(g.lo);
    const outer = expandAt(startNode, writtenInRun);
    const expand: Expand = (name) => env.get(name) ?? outer(name);
    const sub = (e: Expression): Expression => {
      const u = unwrapParens(e);
      if (u.kind === NodeKind.Identifier && vars.has((u as Identifier).name)) {
        return simpleAssign(innerStmt(g.slot.list[g.defs.get((u as Identifier).name)!]))!.rhs;
      }
      return e;
    };
    const values = { pair: [sub(shape.pair[0]), sub(shape.pair[1])] as [Expression, Expression], zf: shape.zf && sub(shape.zf) };
    // A component spelled through a group variable (`n + nBelt < 0`) is matched through
    // `expand`, which knows the group's values; the text is not substituted, so a sign
    // test keeps the type of the variable it reads.
    const r = resolveCompare(shape, values, deps, linear, expand);
    if (!r) return fail(21);
    if (kind && kind !== r.kind) return fail(22);
    kind = r.kind;
    // The compare's operands are read at the group end: they must be the values there.
    const opsReads = new Set([...freeNames(r.a), ...(r.b ? freeNames(r.b) : [])]);
    for (const o of opsReads) if (o !== '*mem' && (!deps.locals.has(o) || flow.isEscaped(o))) {
      if (readsMemory(r.a) || (r.b && readsMemory(r.b))) return fail(23);
    }
    perGroup.push({ g, cmp: compareExpr(r, deps) });
  }
  if (!kind) return fail(24);

  // Assignments in the groups whose value only this condition read go with the flags.
  const deadInGroup = new Set<Statement>();
  for (const { g } of perGroup) {
    for (let i = g.lo; i <= g.end; i++) {
      const st = innerStmt(g.slot.list[i]);
      const a = simpleAssign(st);
      if (!a) continue;
      if (vars.has(a.v)) { deadInGroup.add(st); continue; }
      if (!condReads.has(a.v) || !deps.isPure(a.rhs) || flow.isEscaped(a.v)) continue;
      const sn = flow.nodeOf(st);
      if (sn === undefined) continue;
      const uses = flow.usesOf(sn, a.v);
      if (uses.length !== 1 || uses[0] !== node) continue;
      // The condition node must read it only inside the condition.
      if (countName(flow.ownExprs(node), a.v) !== countName([cand.cond], a.v)) continue;
      deadInGroup.add(st);
    }
  }

  let name: string = FLAG_COND_NAME[kind];
  for (let k = 2; declared.has(name); k++) name = `${FLAG_COND_NAME[kind]}${k}`;
  declared.add(name);
  const condName = name;

  // Rebuild every group's statement list (back to front, so indices stay valid), then
  // the condition.
  const listEdits = new Map<Statement[], Statement[]>();
  const lists = new Set(perGroup.map(p => p.g.slot.list));
  for (const orig of lists) {
    const list = [...orig];
    const gs = perGroup.filter(p => p.g.slot.list === orig).sort((x, y) => y.g.lo - x.g.lo);
    for (const { g, cmp } of gs) {
      const assign = {
        kind: NodeKind.ExprStmt,
        expression: Expr.assign(Expr.identifier(condName), cmp),
      } as unknown as Statement;
      const out: Statement[] = [];
      let wrapper: Statement | null = null;
      for (let i = g.lo; i <= g.end; i++) {
        const st = orig[i];
        if (deadInGroup.has(innerStmt(st))) {
          if (i === g.lo && isWrapped(st)) wrapper = st;
          continue;
        }
        out.push(st);
      }
      out.push(assign);
      if (wrapper) out[0] = rewrapStmt(wrapper, out[0]);
      list.splice(g.lo, g.end - g.lo + 1, ...out);
    }
    listEdits.set(orig, list);
  }

  const visitor = (x: ASTNode): ASTNode | undefined => {
    if (x === (cand.cond as unknown as ASTNode)) return withTrivia(Expr.identifier(condName), x) as unknown as ASTNode;
    if (x.kind === NodeKind.CompoundStmt) {
      const own = (x as unknown as { statements: Statement[] }).statements;
      const edited = listEdits.get(own);
      if (edited) {
        const inner = edited.map(st => (own.includes(st) ? rebuild(st, visitor) : st));
        return { ...(x as object), statements: inner } as unknown as ASTNode;
      }
    }
    return undefined;
  };
  // One rebuild from a synthetic root, so an edit of the top-level list and an edit of a
  // nested list both land.
  const synthetic = { kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode;
  const rebuilt = rebuild(synthetic, visitor);
  let changedBody = (rebuilt as unknown as { statements: Statement[] }).statements;

  // Declarations: the flag variables nothing references any more go; the condition
  // variable is declared where the first of them was, or at the top of the body.
  // Candidates: the flag variables and every variable a removed group statement assigned.
  const removable = new Set<string>(vars);
  for (const st of deadInGroup) { const a = simpleAssign(st); if (a) removable.add(a.v); }
  const remaining = new Set<string>();
  for (const v of removable) if (countName(changedBody, v, true) > 0) remaining.add(v);
  let placed = false;
  const decl = (): Statement => ({
    kind: NodeKind.DeclStmt,
    declarations: [{
      kind: NodeKind.VariableDecl,
      name: Expr.identifier(condName),
      type: Type.bool(),
      initializer: null,
      specifiers: [],
      attributes: [],
    }],
  } as unknown as Statement);
  const dropDecls = (list: Statement[]): Statement[] => {
    const out: Statement[] = [];
    for (const s of list) {
      if (s.kind === NodeKind.DeclStmt) {
        const ds = (s as DeclStmt).declarations as VariableDecl[];
        if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !ds[0].initializer
          && removable.has(ds[0].name.name) && !remaining.has(ds[0].name.name)) {
          if (!placed && vars.has(ds[0].name.name)) { placed = true; out.push(decl()); }
          continue;
        }
      }
      out.push(s);
    }
    return out;
  };
  changedBody = dropDecls(changedBody);
  changedBody = rebuild(changedBody, x => {
    if (x.kind !== NodeKind.CompoundStmt) return undefined;
    const st = (x as unknown as { statements: Statement[] }).statements;
    const nd = dropDecls(st);
    return nd.length !== st.length || nd.some((s, i) => s !== st[i]) ? ({ ...(x as object), statements: nd } as unknown as ASTNode) : undefined;
  });
  if (!placed) changedBody = [decl(), ...changedBody];
  return changedBody;
}

function rewrapStmt(wrapper: Statement, replacement: Statement): Statement {
  if (wrapper.kind === NodeKind.CaseStmt || wrapper.kind === NodeKind.DefaultStmt || wrapper.kind === NodeKind.LabelStmt) {
    const w = wrapper as unknown as { statement: Statement };
    return { ...(wrapper as object), statement: rewrapStmt(w.statement, replacement) } as unknown as Statement;
  }
  return replacement;
}

function withTrivia<T extends object>(e: T, from: ASTNode): T {
  return { ...e, leadingTrivia: from.leadingTrivia, trailingTrivia: from.trailingTrivia } as T;
}

function readsAny(st: Statement, vars: ReadonlySet<string>, flow: FunctionFlow): boolean {
  const n = flow.nodeOf(innerStmt(st)) ?? flow.nodeOf(st);
  if (n === undefined) return true;
  const a = simpleAssign(innerStmt(st));
  const reads = new Set(flow.reads(n));
  // `v = ...` does not read v.
  if (a && !freeNames(a.rhs).has(a.v)) reads.delete(a.v);
  return [...vars].some(v => reads.has(v));
}

function clobbers(flow: FunctionFlow, node: number): boolean {
  // A node that writes any escaped name (a global counts) is a call or a store.
  return [...flow.writes(node)].some(w => flow.isEscaped(w));
}

function writtenBetweenOrMem(flow: FunctionFlow, from: number, to: number, vars: ReadonlySet<string>, stop?: ReadonlySet<number>): boolean {
  const plain = [...vars].filter(v => v !== '*mem');
  if (flow.writtenBetween(from, to, plain, stop)) return true;
  if (!vars.has('*mem')) return false;
  // Memory: any call or store on the way.
  return flow.nodesBetween(from, to, stop).some(id => clobbers(flow, id));
}

/** Occurrences of identifier `name` as a value (declaration names excluded when `skipDecls`). */
function countName(e: unknown, name: string, skipDecls = false): number {
  if (Array.isArray(e)) return e.reduce((n: number, x) => n + countName(x, name, skipDecls), 0);
  if (!e || typeof e !== 'object') return 0;
  const o = e as Record<string, unknown>;
  if (skipDecls && o.kind === NodeKind.VariableDecl) return o.initializer ? countName(o.initializer, name, skipDecls) : 0;
  if (o.kind === NodeKind.MemberExpr) return countName(o.object, name, skipDecls);
  let n = o.kind === NodeKind.Identifier && o.name === name ? 1 : 0;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object') n += countName(v, name, skipDecls);
  }
  return n;
}

// ============================================
// TEST AFTER NEG (|v| <= 0)
// ============================================

/**
 * The magnitude test the compiler emits as `TEST v,v; JGE L; NEG v; TEST v,v; L: JG`
 * (DRLGPATH_RaycastCollisionLine 006795a1, DRLGPATH_CheckRayCollisionToTarget). Both
 * paths end in TEST, so OF is clear and `jg` is `x > 0`; the decompiler keeps SF in a
 * variable it sets only on the negating path:
 *
 *   F = false;  x = v;  if (v < 0) { x = -v; F = x < 0; }  if (x == 0 || F) ...
 *
 * (or, negating in place, `F = false; if (x < 0) { x = -x; F = x < 0; }`). On the path
 * that does not negate, F is false and x = v >= 0, so `x == 0` is `x <= 0`; on the other
 * F is `x < 0` and the condition is `x == 0 || x < 0`. Either way it is `x <= 0`. The
 * flag goes, and the condition reads `x <= 0`.
 */
export function lowerNegTestConditions(body: Statement[], deps: FlagConditionDeps): Statement[] {
  const signed32 = (e: Expression) => {
    const c = deps.classify(e);
    return c.kind === 'int' && c.width === 4 && c.signed === true;
  };
  const sameValue = (a: Expression, b: Expression) => deps.isPure(a) && deps.isPure(b)
    && emit(unwrapParens(a) as AnyNode) === emit(unwrapParens(b) as AnyNode);
  const ident = (e: Expression | undefined) => {
    const u = e && unwrapParens(e);
    return u && u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
  };
  const isLt0 = (e: Expression, x: Expression) => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '<'
      && literalValue((u as BinaryExpr).right) === 0n && sameValue((u as BinaryExpr).left, x);
  };
  const isEq0 = (e: Expression, x: Expression) => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '=='
      && literalValue((u as BinaryExpr).right) === 0n && sameValue((u as BinaryExpr).left, x);
  };
  /** `x = -v` with v the given operand. */
  const isNegationOf = (st: Statement, x: Expression, v: Expression) => {
    if (st.kind !== NodeKind.ExprStmt) return false;
    const e = unwrapParens((st as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return false;
    const r = unwrapParens((e as AssignExpr).right);
    return sameValue((e as AssignExpr).left, x) && r.kind === NodeKind.UnaryExpr
      && (r as UnaryExpr).operator === '-' && sameValue((r as UnaryExpr).operand, v);
  };
  const assignOfStmt = (st: Statement | undefined) => {
    if (!st || st.kind !== NodeKind.ExprStmt) return null;
    const e = unwrapParens((st as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    return { left: (e as AssignExpr).left, right: (e as AssignExpr).right };
  };
  const thenStmts = (s: Statement): Statement[] | null => {
    const t = (s as unknown as { thenBranch: Statement }).thenBranch;
    if (t.kind === NodeKind.CompoundStmt) return (t as unknown as { statements: Statement[] }).statements;
    return null;
  };

  // Count references of each local flag candidate, to require that the idiom accounts for all.
  const refs = new Map<string, number>();
  const countRefs = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(countRefs); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    if (o.kind === NodeKind.VariableDecl) { if (o.initializer) countRefs(o.initializer); return; }
    if (o.kind === NodeKind.Identifier) refs.set(o.name as string, (refs.get(o.name as string) ?? 0) + 1);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') countRefs(v);
    }
  };
  countRefs(body);

  interface Match { list: Statement[]; i: number; k: number; F: string; x: Expression; v: Expression }
  const matches: Match[] = [];
  const scan = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(scan); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.CompoundStmt) {
      const list = (n as unknown as { statements: Statement[] }).statements;
      for (let i = 0; i + 2 < list.length; i++) {
        const f = assignOfStmt(list[i]);
        const F = ident(f?.left);
        if (!f || !F || !isFalse(f.right) || !deps.locals.has(F)) continue;
        // Optional copy `x = v;`, then `if (v < 0) { x = -v; F = x < 0; }`.
        let k = i + 1;
        const copy = assignOfStmt(list[k]);
        let x0: Expression | null = null;
        let v0: Expression | null = null;
        if (copy && list[k + 1]?.kind === NodeKind.IfStmt) { x0 = copy.left; v0 = copy.right; k++; }
        const ifs = list[k];
        if (!ifs || ifs.kind !== NodeKind.IfStmt || (ifs as unknown as { elseBranch: unknown }).elseBranch) continue;
        const cond = unwrapParens((ifs as unknown as { condition: Expression }).condition);
        if (cond.kind !== NodeKind.BinaryExpr || (cond as BinaryExpr).operator !== '<' || literalValue((cond as BinaryExpr).right) !== 0n) continue;
        const v = (cond as BinaryExpr).left;
        const xv = x0 ?? v;
        if (x0 && !sameValue(v0!, v)) continue;
        const ts = thenStmts(ifs);
        if (!ts || ts.length !== 2 || !isNegationOf(ts[0], xv, v)) continue;
        const fs = assignOfStmt(ts[1]);
        if (!fs || ident(fs.left) !== F || !isLt0(fs.right, xv)) continue;
        // Then `if (x == 0 || F)`.
        const use = list[k + 1];
        if (!use || use.kind !== NodeKind.IfStmt) continue;
        const uc = unwrapParens((use as unknown as { condition: Expression }).condition);
        if (uc.kind !== NodeKind.BinaryExpr || (uc as BinaryExpr).operator !== '||') continue;
        const ub = uc as BinaryExpr;
        const ok = (isEq0(ub.left, xv) && ident(ub.right) === F) || (isEq0(ub.right, xv) && ident(ub.left) === F);
        if (!ok) continue;
        if (!signed32(xv) || !signed32(v) || !deps.isPure(xv) || !deps.isPure(v)) continue;
        matches.push({ list, i, k, F, x: xv, v });
      }
    }
    for (const [key, val] of Object.entries(n)) {
      if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
      if (val && typeof val === 'object') scan(val);
    }
  };
  scan({ kind: NodeKind.CompoundStmt, statements: body });
  // Every reference of F must be one of the matched instances (three each).
  const perFlag = new Map<string, number>();
  for (const m of matches) perFlag.set(m.F, (perFlag.get(m.F) ?? 0) + 1);
  const accepted = matches.filter(m => (refs.get(m.F) ?? 0) === 3 * (perFlag.get(m.F) ?? 0));
  if (accepted.length === 0) return body;

  const edits = new Map<Statement[], Match[]>();
  for (const m of accepted) edits.set(m.list, [...(edits.get(m.list) ?? []), m]);
  const visit = (x: ASTNode): ASTNode | undefined => {
    if (x.kind !== NodeKind.CompoundStmt) return undefined;
    const own = (x as unknown as { statements: Statement[] }).statements;
    const ms = edits.get(own);
    if (!ms) return undefined;
    const drop = new Set<number>();
    const replace = new Map<number, Statement>();
    for (const m of ms) {
      drop.add(m.i);
      const ifs = own[m.k] as unknown as { thenBranch: { statements: Statement[] } };
      replace.set(m.k, { ...(own[m.k] as object), thenBranch: { ...(ifs.thenBranch as object), statements: [ifs.thenBranch.statements[0]] } } as unknown as Statement);
      const use = own[m.k + 1] as unknown as { condition: Expression };
      const cmp = Expr.paren(Expr.binary(m.x, '<=' as never, Expr.intLiteral(0n)));
      replace.set(m.k + 1, { ...(own[m.k + 1] as object), condition: withTrivia(cmp, use.condition as unknown as ASTNode) } as unknown as Statement);
    }
    const next: Statement[] = [];
    own.forEach((st, idx) => {
      if (drop.has(idx)) return;
      const r = replace.get(idx) ?? st;
      next.push(rebuild(r, visit));
    });
    return { ...(x as object), statements: next } as unknown as ASTNode;
  };
  const root = rebuild({ kind: NodeKind.CompoundStmt, statements: body } as unknown as ASTNode, visit);
  // The flag's declaration goes with its last reference.
  const flags = new Set(accepted.map(m => m.F));
  return dropFlagDecls((root as unknown as { statements: Statement[] }).statements, flags);
}

/** Remove `T v;` (no initializer) for each named variable, in every statement list. */
function dropFlagDecls(list: Statement[], names: ReadonlySet<string>): Statement[] {
  const isDecl = (s: Statement) => {
    if (s.kind !== NodeKind.DeclStmt) return false;
    const ds = (s as DeclStmt).declarations as VariableDecl[];
    return ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !ds[0].initializer && names.has(ds[0].name.name);
  };
  const root = rebuild({ kind: NodeKind.CompoundStmt, statements: list } as unknown as ASTNode, function visit(x: ASTNode): ASTNode | undefined {
    if (x.kind !== NodeKind.CompoundStmt) return undefined;
    const st = (x as unknown as { statements: Statement[] }).statements;
    return { ...(x as object), statements: st.filter(s => !isDecl(s)).map(s => rebuild(s, visit)) } as unknown as ASTNode;
  });
  return (root as unknown as { statements: Statement[] }).statements;
}

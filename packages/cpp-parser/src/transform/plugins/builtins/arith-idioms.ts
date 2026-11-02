/**
 * Arithmetic idioms written back as the operator they compiled from.
 *
 * Ghidra decompiles what the compiler made of a division, a remainder or a 64-bit
 * runtime call, and does not always fold it back. Compiled as printed, MSVC turns
 * each of these into different code from the original's: a 64-bit division of a
 * zero-extended dword calls `_aulldiv` where the original divides inline, the
 * signed power-of-two bias is copied by hand where the original's `/` has `cdq`.
 * Every rewrite here has the same value AND the same type as what it replaces,
 * for every input of the operand types; where a type is unknown nothing is
 * folded.
 *
 *   low dword    `(uint64_t)d2_bits_of(s) & K`, K < 2^32, s an 8-byte aggregate
 *                whose offset-0 member is an unsigned dword `lo`, is
 *                `(uint64_t)(s.lo & K)` (just `(uint64_t)s.lo` for K = 0xffffffff),
 *                and `(T)d2_bits_of(s)` for a T of at most 32 bits is `(T)s.lo`.
 *   narrow div   `(uint64_t)a / (uint64_t)b` and `%`, a and b unsigned of at most
 *                32 bits (b may be a constant 1..2^32-1), is `(uint64_t)(a / b)`:
 *                both values fit 32 bits, so the 32-bit quotient is exact.
 *   reciprocal   `(uint64_t)a * M >> S`, a an unsigned dword, is `(uint64_t)(a / d)`
 *                where M and S provably divide every dword by d (see foldMagic).
 *   cast chain   `(T)(uint64_t)e`, T and e integers of at most 32 bits, is `(T)e`:
 *                widening then truncating keeps the low bits either way. Where
 *                only the truth of `(uint64_t)e` is used it is `e`.
 *   modulo       `x + (C)(x / N) * -N` and `x - (C)(x / N) * N` are `x % N`, C a
 *                32-bit integer cast or none: in 32-bit wrapping arithmetic the
 *                sum is x - q*N. Kept only where the result type is that of `x % N`.
 *   divides      `x == (C)(x / N) * N` is `x % N == 0`, and `!=` likewise.
 *   signed div   `t = (int)((uint64_t)((int64_t)x * M) >> 0x20);` (or `... ± x`) followed by
 *                `t = (t >> S) - (t >> 0x1f);`, x a signed int, is `t = x / d` where M, S
 *                and the correction are what the signed reciprocal for d is (see
 *                signedReciprocal): the high product, shifted and rounded toward zero.
 *   pow2 div     `(int)(x + ((int)x >> 0x1f & 2^n-1)) >> n` is `x / 2^n` (`(int)x`
 *                for an unsigned x): a negative x is biased by 2^n-1 so the
 *                arithmetic shift rounds toward zero, as `/` does. Without the
 *                `(int)` the sum must itself be a signed int.
 *   long helpers `_alldiv(lo, hi, lo2, hi2)` (and `_aulldiv`, `_allrem`,
 *                `_aullrem`, `_allmul`, or their `__` spellings) whose dword pairs are recognisably one
 *                value - `((uint32_t)E, (uint32_t)((uint64_t)E >> 0x20))` is E,
 *                `(n, (int)n >> 0x1f)` is n sign-extended, `(n, 0)` n
 *                zero-extended - are the operator on `(int64_t)` / `(uint64_t)`.
 *
 * Every operand that the idiom repeats must be free of calls and assignments:
 * the rewrite evaluates it once.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, Expression, BinaryExpr, CStyleCastExpr, CallExpr, IntegerLiteralExpr,
  UnaryExpr, FunctionDecl, ParameterDecl, VariableDecl, TypeNode, MemberExpr,
  IfStmt, WhileStmt, DoWhileStmt, ForStmt, ConditionalExpr,
  CharLiteralExpr, FloatingLiteralExpr, Statement, ExprStmt, DeclStmt, CompoundStmt, AssignExpr, Identifier,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import {
  bareName, calleeName, shapeOfNode, shapeOfSpelling, unwrapParens, type TypedefResolver,
} from './call-arg-cast.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';

export interface ArithIdiomsOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  structFieldOffsets?: Record<string, Record<string, number>>;
  aggregateSizes?: Record<string, number>;
  unionNames?: string[];
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** The original's code offsets per line and per `if` (branch-layout); absent: no statement pair is folded. */
  branchLayout?: BranchLayoutEvidence | null;
}

export type ArithIdiom =
  | 'low-dword' | 'narrow-div' | 'magic-div' | 'cast-chain' | 'modulo' | 'divides' | 'pow2-div' | 'long-helper' | 'signed-div'
  | 'setcc-select' | 'pow2-rem' | 'u2f';

const stats: Record<ArithIdiom, number> = {
  'low-dword': 0, 'narrow-div': 0, 'magic-div': 0, 'cast-chain': 0, 'modulo': 0, 'divides': 0,
  'pow2-div': 0, 'long-helper': 0, 'signed-div': 0, 'setcc-select': 0, 'pow2-rem': 0, 'u2f': 0,
};

/** How many times each idiom has been folded since the last reset. */
export function getArithIdiomStats(): Readonly<Record<ArithIdiom, number>> { return { ...stats }; }
export function resetArithIdiomStats(): void {
  for (const k of Object.keys(stats) as ArithIdiom[]) stats[k] = 0;
}

// ============================================
// INTEGER TYPES
// ============================================

/** An integer type as the usual arithmetic conversions see it. */
export interface IntType { bits: 1 | 8 | 16 | 32 | 64; signed: boolean }

/**
 * Integer widths of the canonical bases (`call-arg-cast` reduces every alias to
 * one of these). `long` is 32 bits on the target and on every LLP64 build of it;
 * the pointer-sized names are left out because their width is the build's.
 */
const INT_BASES: Record<string, IntType> = {
  'bool': { bits: 1, signed: false },
  'char': { bits: 8, signed: true },
  'signed char': { bits: 8, signed: true },
  'unsigned char': { bits: 8, signed: false },
  'short': { bits: 16, signed: true },
  'unsigned short': { bits: 16, signed: false },
  'wchar_t': { bits: 16, signed: false },
  'int': { bits: 32, signed: true },
  'unsigned int': { bits: 32, signed: false },
  'long': { bits: 32, signed: true },
  'unsigned long': { bits: 32, signed: false },
  'long long': { bits: 64, signed: true },
  'unsigned long long': { bits: 64, signed: false },
};

const S32: IntType = { bits: 32, signed: true };
const U32: IntType = { bits: 32, signed: false };
const S64: IntType = { bits: 64, signed: true };
const U64: IntType = { bits: 64, signed: false };

export function promote(t: IntType): IntType {
  return t.bits < 32 ? S32 : t;
}

/** The common type of a binary arithmetic operator's operands. */
export function commonType(a: IntType, b: IntType): IntType {
  const pa = promote(a);
  const pb = promote(b);
  if (pa.bits === 64 || pb.bits === 64) {
    return (pa.bits === 64 && !pa.signed) || (pb.bits === 64 && !pb.signed) ? U64 : S64;
  }
  return pa.signed && pb.signed ? S32 : U32;
}

const sameType = (a: IntType | null, b: IntType | null) =>
  !!a && !!b && a.bits === b.bits && a.signed === b.signed;

/** The type of an integer literal; null where it depends on the compiler. */
export function literalType(lit: IntegerLiteralExpr): IntType | null {
  const v = lit.value;
  const suffix = (lit.suffix ?? '').toLowerCase();
  const unsigned = suffix.includes('u');
  const longLong = suffix.includes('ll');
  if (suffix.replace(/u/g, '').replace('ll', '') !== '') return null; // a bare `l`
  if (longLong) return unsigned ? U64 : (v <= 0x7fffffffffffffffn ? S64 : null);
  if (unsigned) return v <= 0xffffffffn ? U32 : U64;
  if (v <= 0x7fffffffn) return S32;
  // A decimal literal past INT_MAX is `long long` to one compiler and `unsigned
  // long` to another: no type is claimed for it.
  if (lit.base === 10) return null;
  if (v <= 0xffffffffn) return U32;
  return v <= 0x7fffffffffffffffn ? S64 : U64;
}

const COMPARISON = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);
const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^']);

function intLiteral(e: Expression): bigint | null {
  const u = unwrapParens(e);
  return u.kind === NodeKind.IntegerLiteral ? (u as IntegerLiteralExpr).value : null;
}

/** `-N` written either as a negative literal or as `-` of one. */
function negatedLiteral(e: Expression): bigint | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
    const v = intLiteral((u as UnaryExpr).operand as Expression);
    return v === null ? null : -v;
  }
  return intLiteral(u);
}

/** No call (other than the pure bit move), assignment, increment or comma. */
export function isPure(e: ASTNode): boolean {
  let pure = true;
  const visit = (n: unknown): void => {
    if (!pure || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const node = n as ASTNode;
    switch (node.kind) {
      case NodeKind.CallExpr: {
        const name = calleeName((node as CallExpr).callee);
        if (name !== 'd2_bits_of') { pure = false; return; }
        break;
      }
      case NodeKind.AssignExpr:
      case NodeKind.PostfixExpr:
      case NodeKind.CommaExpr:
        pure = false;
        return;
      case NodeKind.UnaryExpr: {
        const op = (node as UnaryExpr).operator;
        if (op === '++' || op === '--') { pure = false; return; }
        break;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(e);
  return pure;
}

/** The same expression, ignoring redundant parentheses. */
export function sameExpr(a: Expression, b: Expression): boolean {
  return emit(unwrapParens(a) as AnyNode).trim() === emit(unwrapParens(b) as AnyNode).trim();
}

const castNode = (spelling: string, e: Expression): Expression =>
  Expr.cast(spelling === 'int' ? Type.int() : Type.typedef(spelling), e);

// ============================================
// SIGNED RECIPROCALS
// ============================================

/**
 * The multiplier, shift and correction a compiler divides a signed int by d with
 * (Hacker's Delight 10-1, `magic`; MSVC computes the same): q = mulhs(M, n), plus n
 * when `add` is 1, minus n when -1, then `q >> s`, then the sign bit added. For
 * 2 <= |d| < 2^31 that is trunc(n / d) for every 32-bit n. Null for |d| < 2 or a
 * power of two, which compile to shifts instead.
 */
export function signedReciprocal(d: bigint): { m: bigint; s: number; add: -1 | 0 | 1 } | null {
  const ad = d < 0n ? -d : d;
  if (ad < 2n || ad >= 1n << 31n || (ad & (ad - 1n)) === 0n) return null;
  const two31 = 1n << 31n;
  const mask = (1n << 32n) - 1n;
  const t = two31 + (d < 0n ? 1n : 0n);
  const anc = t - 1n - (t % ad);
  let p = 31;
  let q1 = two31 / anc, r1 = two31 - q1 * anc;
  let q2 = two31 / ad, r2 = two31 - q2 * ad;
  let delta: bigint;
  do {
    p++;
    q1 = (2n * q1) & mask; r1 = (2n * r1) & mask;
    if (r1 >= anc) { q1 = (q1 + 1n) & mask; r1 = (r1 - anc) & mask; }
    q2 = (2n * q2) & mask; r2 = (2n * r2) & mask;
    if (r2 >= ad) { q2 = (q2 + 1n) & mask; r2 = (r2 - ad) & mask; }
    delta = ad - r2;
  } while (q1 < delta || (q1 === delta && r1 === 0n));
  let m = (q2 + 1n) & mask;
  if (m >= two31) m -= 1n << 32n;
  if (d < 0n) m = m === -two31 ? m : -m;
  const add = d > 0n && m < 0n ? 1 : d < 0n && m > 0n ? -1 : 0;
  return { m, s: p - 32, add };
}

// ============================================
// THE FOLDS
// ============================================

interface Folder {
  typeOf(e: Expression): IntType | null;
  fold(e: Expression): Expression | null;
  foldTruth(e: Expression): Expression | null;
  foldPair(a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined): Statement | null;
}

function createFolder(shapeOf: ExprShape, o: ArithIdiomsOptions, resolve: TypedefResolver): Folder {
  const structFields = o.structFields ?? {};
  const structFieldOffsets = o.structFieldOffsets ?? {};
  const aggregateSizes = o.aggregateSizes ?? {};
  const unions = new Set(o.unionNames ?? []);

  const typeOfNode = (t: TypeNode): IntType | null => {
    const s = shapeOfNode(t, 0, resolve);
    return s && s.stars === 0 ? INT_BASES[s.base] ?? null : null;
  };

  const typeOf = (expr: Expression): IntType | null => {
    const e = unwrapParens(expr);
    switch (e.kind) {
      case NodeKind.IntegerLiteral:
        return literalType(e as IntegerLiteralExpr);
      case NodeKind.CStyleCastExpr:
        return typeOfNode((e as CStyleCastExpr).type);
      case NodeKind.UnaryExpr: {
        const u = e as UnaryExpr;
        if (u.operator === '!') return S32;
        if (u.operator === '-' || u.operator === '~' || u.operator === '+') {
          const t = typeOf(u.operand as Expression);
          return t ? promote(t) : null;
        }
        break;
      }
      case NodeKind.BinaryExpr: {
        const b = e as BinaryExpr;
        if (COMPARISON.has(b.operator)) return S32;
        const l = typeOf(b.left as Expression);
        if (b.operator === '<<' || b.operator === '>>') {
          return l && typeOf(b.right as Expression) ? promote(l) : null;
        }
        if (!ARITH.has(b.operator)) return null;
        const r = typeOf(b.right as Expression);
        return l && r ? commonType(l, r) : null;
      }
      case NodeKind.ConditionalExpr: {
        const c = e as ConditionalExpr;
        const a = typeOf(c.thenExpr as Expression);
        const b2 = typeOf(c.elseExpr as Expression);
        return a && b2 ? commonType(a, b2) : null;
      }
    }
    const s = shapeOf(e);
    return s && s.stars === 0 ? INT_BASES[s.base] ?? null : null;
  };

  /** `(T)e` with T given by a cast node, else null. */
  const castOf = (e: Expression): { type: IntType; inner: Expression; node: CStyleCastExpr } | null => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.CStyleCastExpr) return null;
    const c = u as CStyleCastExpr;
    const t = typeOfNode(c.type);
    return t ? { type: t, inner: c.expression as Expression, node: c } : null;
  };

  /** e without any 32-bit integer casts on the outside. */
  const strip32 = (e: Expression): Expression => {
    let cur = e;
    for (let c = castOf(cur); c && c.type.bits === 32; c = castOf(cur)) cur = c.inner;
    return cur;
  };

  // --- low dword of an aggregate ----------------------------------------

  /** `s.lo` for an aggregate s whose low dword is an unsigned 32-bit member. */
  const lowDword = (s: Expression): Expression | null => {
    if (!isPure(s)) return null;
    const shape = shapeOf(s);
    if (!shape || shape.stars !== 0) return null;
    const name = shape.base;
    const key = [name, bareName(name)].find(k => structFields[k] && structFieldOffsets[k]);
    if (!key || unions.has(key) || unions.has(bareName(key))) return null;
    if ((aggregateSizes[key] ?? aggregateSizes[bareName(key)]) !== 8) return null;
    const atZero = Object.entries(structFieldOffsets[key]).filter(([, off]) => off === 0);
    if (atZero.length !== 1) return null;
    const [field] = atZero[0];
    const spelling = structFields[key][field];
    const fs = spelling ? shapeOfSpelling(spelling, resolve) : null;
    const ft = fs && fs.stars === 0 ? INT_BASES[fs.base] : undefined;
    if (!ft || ft.bits !== 32 || ft.signed) return null;
    return Expr.member(s, field, false);
  };

  /** The aggregate of `d2_bits_of(s)`. */
  const bitsOf = (e: Expression): Expression | null => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.CallExpr) return null;
    const call = u as CallExpr;
    if (calleeName(call.callee) !== 'd2_bits_of' || call.arguments.length !== 1) return null;
    return call.arguments[0] as Expression;
  };

  const foldLowDword = (e: Expression): Expression | null => {
    // (uint64_t)d2_bits_of(s) & K
    if (e.kind === NodeKind.BinaryExpr && (e as BinaryExpr).operator === '&') {
      const b = e as BinaryExpr;
      const k = intLiteral(b.right as Expression);
      const c = castOf(b.left as Expression);
      if (k === null || k < 0n || k > 0xffffffffn || !c || !sameType(c.type, U64)) return null;
      const s = bitsOf(c.inner);
      const lo = s && lowDword(s);
      if (!lo) return null;
      stats['low-dword']++;
      const masked = k === 0xffffffffn ? lo : Expr.binary(lo, '&', b.right as Expression);
      return castNode('uint64_t', Expr.paren(masked));
    }
    // (T)d2_bits_of(s), T at most 32 bits
    const c = castOf(e);
    if (c && c.type.bits <= 32 && c.type.bits > 1) {
      const s = bitsOf(c.inner);
      const lo = s && lowDword(s);
      if (!lo) return null;
      stats['low-dword']++;
      return updateNode(c.node, { expression: lo } as Partial<CStyleCastExpr>);
    }
    return null;
  };

  // --- 64-bit division of zero-extended dwords ---------------------------

  /** a, where e is `(uint64_t)a` with a unsigned and at most 32 bits. */
  const zeroExtended = (e: Expression): Expression | null => {
    const c = castOf(e);
    if (!c || !sameType(c.type, U64)) return null;
    const t = typeOf(c.inner);
    return t && !t.signed && t.bits <= 32 ? c.inner : null;
  };

  const foldNarrowDiv = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '/' && b.operator !== '%') return null;
    const a = zeroExtended(b.left as Expression);
    if (!a) return null;
    let d = zeroExtended(b.right as Expression);
    if (!d) {
      const k = intLiteral(b.right as Expression);
      const lt = k !== null ? typeOf(b.right as Expression) : null;
      if (k === null || k < 1n || k > 0xffffffffn || !lt) return null;
      d = b.right as Expression;
    }
    stats['narrow-div']++;
    return castNode('uint64_t', Expr.paren(Expr.binary(a, b.operator, d)));
  };

  // --- multiply by a reciprocal ------------------------------------------

  /**
   * `(uint64_t)a * M >> S` with a an unsigned dword is `a / d` exactly when
   * d = ceil(2^S / M) and M*d - 2^S <= 2^(S-32): the reciprocal's error then
   * stays below 1/d for every a < 2^32 (Granlund-Montgomery). Checked per
   * constant rather than looked up, so a pair that only approximates a divisor
   * is never folded.
   */
  const foldMagic = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '>>') return null;
    const shift = e as BinaryExpr;
    const s = intLiteral(shift.right as Expression);
    const mul = unwrapParens(shift.left as Expression);
    if (s === null || s < 32n || s > 63n) return null;
    if (mul.kind !== NodeKind.BinaryExpr || (mul as BinaryExpr).operator !== '*') return null;
    const { left, right } = mul as BinaryExpr;
    let m = intLiteral(right as Expression);
    let a = zeroExtended(left as Expression);
    if (m === null || !a) {
      m = intLiteral(left as Expression);
      a = zeroExtended(right as Expression);
    }
    if (m === null || !a || m < 2n || m > 0xffffffffn) return null;
    const p = 1n << s;
    const d = (p + m - 1n) / m;
    const err = m * d - p;
    if (d < 2n || d > 0xffffffffn || err > 1n << (s - 32n)) return null;
    // A power of two on either side is a shift or the high half of a plain
    // product (`(uint64_t)n * 2 >> 0x20`, operator new[]'s overflow test), never
    // a reciprocal the compiler chose.
    if ((m & (m - 1n)) === 0n || (d & (d - 1n)) === 0n) return null;
    stats['magic-div']++;
    return castNode('uint64_t', Expr.paren(Expr.binary(a, '/', Expr.intLiteral(d))));
  };

  // --- (T)(uint64_t)e ----------------------------------------------------

  const foldCastChain = (e: Expression): Expression | null => {
    const outer = castOf(e);
    if (!outer || outer.type.bits > 32 || outer.type.bits === 1) return null;
    const mid = castOf(outer.inner);
    if (!mid || mid.type.bits !== 64) return null;
    const t = typeOf(mid.inner);
    if (!t || t.bits > 32) return null;
    stats['cast-chain']++;
    return updateNode(outer.node, { expression: Expr.paren(mid.inner) } as Partial<CStyleCastExpr>);
  };

  // --- x - (x / N) * N ---------------------------------------------------

  /** x and N of `(C)(x / N)`, C a 32-bit integer cast or none. */
  const quotient = (e: Expression): { x: Expression; n: bigint; div: BinaryExpr } | null => {
    const q = unwrapParens(strip32(e));
    if (q.kind !== NodeKind.BinaryExpr || (q as BinaryExpr).operator !== '/') return null;
    const div = q as BinaryExpr;
    const n = intLiteral(div.right as Expression);
    if (n === null || n < 1n) return null;
    return { x: div.left as Expression, n, div };
  };

  /** `x % N` for the product `(C)(x / N) * M`, M = sign * N. */
  const remainderOf = (x: Expression, product: Expression, sign: 1n | -1n): BinaryExpr | null => {
    const p = unwrapParens(product);
    if (p.kind !== NodeKind.BinaryExpr || (p as BinaryExpr).operator !== '*') return null;
    const mul = p as BinaryExpr;
    const q = quotient(mul.left as Expression);
    const m = negatedLiteral(mul.right as Expression);
    if (!q || m === null || m !== sign * q.n || !sameExpr(q.x, x) || !isPure(x)) return null;
    const xt = typeOf(x);
    if (!xt || xt.bits > 32) return null;
    return Expr.binary(x, '%', q.div.right as Expression);
  };

  const foldModulo = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '+' && b.operator !== '-') return null;
    const rem = remainderOf(b.left as Expression, b.right as Expression, b.operator === '+' ? -1n : 1n);
    if (!rem || !sameType(typeOf(e), typeOf(rem))) return null;
    stats['modulo']++;
    return rem;
  };

  const foldDivides = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '==' && b.operator !== '!=') return null;
    const rem = remainderOf(b.left as Expression, b.right as Expression, 1n)
      ?? remainderOf(b.right as Expression, b.left as Expression, 1n);
    if (!rem) return null;
    stats['divides']++;
    return updateNode(b, { left: rem, right: Expr.intLiteral(0) } as Partial<BinaryExpr>);
  };

  // --- signed division by a power of two ---------------------------------

  const foldPow2Div = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '>>') return null;
    const shift = e as BinaryExpr;
    const n = intLiteral(shift.right as Expression);
    if (n === null || n < 1n || n > 30n) return null;
    let sum = unwrapParens(shift.left as Expression);
    let outerInt = false;
    const outer = castOf(sum);
    if (outer) {
      if (!sameType(outer.type, S32)) return null;
      outerInt = true;
      sum = unwrapParens(outer.inner);
    }
    if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+') return null;
    const add = sum as BinaryExpr;
    const bias = unwrapParens(add.right as Expression);
    if (bias.kind !== NodeKind.BinaryExpr || (bias as BinaryExpr).operator !== '&') return null;
    const and = bias as BinaryExpr;
    if (intLiteral(and.right as Expression) !== (1n << n) - 1n) return null;
    const sign = unwrapParens(and.left as Expression);
    if (sign.kind !== NodeKind.BinaryExpr || (sign as BinaryExpr).operator !== '>>'
        || intLiteral((sign as BinaryExpr).right as Expression) !== 31n) return null;
    const signSource = (sign as BinaryExpr).left as Expression;

    // x, the dividend, with an (int) on it or on its sign taken off.
    const x = add.left as Expression;
    const asInt = (v: Expression) => {
      const c = castOf(v);
      return c && sameType(c.type, S32) ? c.inner : v;
    };
    const y = asInt(x);
    if (!sameExpr(asInt(signSource), y) || !isPure(y)) return null;
    const yt = typeOf(y);
    if (!yt || yt.bits > 32) return null;
    // The sign must be that of y as a 32-bit int: `(int)y >> 31`, or `y >> 31`
    // where y promotes to a signed int.
    const st = typeOf(signSource);
    if (!st || !sameType(promote(st), S32)) return null;
    // Without the cast the shift must be arithmetic: the sum is a signed int.
    if (!outerInt && !sameType(typeOf(add), S32)) return null;
    stats['pow2-div']++;
    const dividend = promote(yt).signed ? y : castNode('int', y);
    return Expr.binary(dividend, '/', Expr.intLiteral(1n << n));
  };

  // --- the 64-bit runtime helpers ----------------------------------------

  /**
   * The one value a dword pair holds, as an expression whose integer conversion
   * to a 64-bit type gives exactly the bits `lo | (uint64_t)hi << 32`.
   */
  /** E for `*(T*)((char*)&E + 4)` (or `(uintptr_t)&E + 4`) with T a 32-bit integer. */
  const highDwordOf = (hi: Expression): Expression | null => {
    const d = unwrapParens(hi);
    if (d.kind !== NodeKind.UnaryExpr || (d as UnaryExpr).operator !== '*') return null;
    const p = unwrapParens((d as UnaryExpr).operand as Expression);
    const pc = p.kind === NodeKind.CStyleCastExpr ? p as CStyleCastExpr : null;
    if (!pc || pc.type.kind !== NodeKind.PointerType) return null;
    const pointee = shapeOfNode(pc.type, 0, resolve);
    if (!pointee || pointee.stars !== 1 || INT_BASES[pointee.base]?.bits !== 32) return null;
    const sum = unwrapParens(pc.expression as Expression);
    if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+'
        || intLiteral((sum as BinaryExpr).right as Expression) !== 4n) return null;
    const base = unwrapParens((sum as BinaryExpr).left as Expression);
    if (base.kind !== NodeKind.CStyleCastExpr) return null;
    const bt = shapeOfNode((base as CStyleCastExpr).type, 0, resolve);
    const bytePointer = bt && bt.stars === 1 && (bt.base === 'char' || bt.base === 'unsigned char' || bt.base === 'signed char');
    const address = bt && bt.stars === 0 && (bt.base === 'uintptr_t' || INT_BASES[bt.base]?.bits === 32);
    if (!bytePointer && !address) return null;
    const amp = unwrapParens((base as CStyleCastExpr).expression as Expression);
    if (amp.kind !== NodeKind.UnaryExpr || (amp as UnaryExpr).operator !== '&') return null;
    return (amp as UnaryExpr).operand as Expression;
  };

  const pairValue = (lo: Expression, hi: Expression): Expression | null => {
    // ((uint32_t)E, (uint32_t)((uint64_t)E >> 0x20)) is E itself.
    const loCast = castOf(lo);
    const hiCast = castOf(hi);
    if (loCast && hiCast && loCast.type.bits === 32 && !loCast.type.signed && hiCast.type.bits === 32) {
      const sh = unwrapParens(hiCast.inner);
      if (sh.kind === NodeKind.BinaryExpr && (sh as BinaryExpr).operator === '>>'
          && intLiteral((sh as BinaryExpr).right as Expression) === 32n) {
        const wide = castOf((sh as BinaryExpr).left as Expression);
        if (wide && sameType(wide.type, U64) && sameExpr(wide.inner, loCast.inner)
            && isPure(loCast.inner) && typeOf(loCast.inner)) {
          return loCast.inner;
        }
        // ((uint32_t)E, (uint32_t)(E >> 0x20)) with E 64 bits wide: either shift leaves
        // the high dword in the low 32 bits.
        const left = (sh as BinaryExpr).left as Expression;
        if (!castOf(left) && sameExpr(left, loCast.inner) && isPure(left) && typeOf(left)?.bits === 64) {
          return loCast.inner;
        }
      }
    }
    // ((uint32_t)E, *(uint32_t*)((char*)&E + 4)) with E a 64-bit lvalue: the high dword
    // read from memory, little-endian.
    if (loCast && loCast.type.bits === 32 && !loCast.type.signed) {
      const e = loCast.inner;
      const at = highDwordOf(hi);
      if (at && sameExpr(at, e) && isPure(e) && typeOf(e)?.bits === 64) return e;
    }
    const lt = typeOf(lo);
    if (!lt) return null;
    // (n, 0): n zero-extended.
    if (intLiteral(hi) === 0n) {
      const k = intLiteral(lo);
      if (k !== null) return k <= 0xffffffffn && typeOf(lo) ? lo : null;
      return !lt.signed && lt.bits <= 32 ? lo : castNode('uint32_t', lo);
    }
    // (n, (int)n >> 0x1f): n sign-extended.
    const sh = unwrapParens(hi);
    if (sh.kind === NodeKind.BinaryExpr && (sh as BinaryExpr).operator === '>>'
        && intLiteral((sh as BinaryExpr).right as Expression) === 31n) {
      const src = castOf((sh as BinaryExpr).left as Expression);
      if (src && sameType(src.type, S32) && sameExpr(strip32(src.inner), strip32(lo)) && isPure(lo)) {
        return sameType(lt, S32) ? lo : castNode('int', lo);
      }
    }
    return null;
  };

  // The CRT names them `_alldiv`; an older database spelled them `__alldiv`.
  const HELPERS: Record<string, { op: '/' | '%' | '*'; signed: boolean }> = {};
  for (const [name, h] of [
    ['alldiv', { op: '/', signed: true }], ['aulldiv', { op: '/', signed: false }],
    ['allrem', { op: '%', signed: true }], ['aullrem', { op: '%', signed: false }],
    ['allmul', { op: '*', signed: true }],
  ] as const) {
    HELPERS[`_${name}`] = h;
    HELPERS[`__${name}`] = h;
  }

  const foldLongHelper = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.CallExpr) return null;
    const call = e as CallExpr;
    const name = calleeName(call.callee);
    const h = name !== undefined ? HELPERS[bareName(name)] : undefined;
    if (!h || call.arguments.length !== 4) return null;
    const [lo1, hi1, lo2, hi2] = call.arguments as Expression[];
    const a = pairValue(lo1, hi1);
    const b = pairValue(lo2, hi2);
    if (!a || !b) return null;
    const t = h.signed ? 'int64_t' : 'uint64_t';
    const want = h.signed ? S64 : U64;
    // The right operand converts to the left's 64-bit type, except a 64-bit
    // operand of the other signedness, which would turn the whole operation.
    const bt = typeOf(b);
    if (!bt) return null;
    const right = bt.bits === 64 && bt.signed !== want.signed ? castNode(t, b) : b;
    // A left operand already of the helper's type needs no cast of its own.
    const left = sameType(typeOf(a), want) ? a : castNode(t, a);
    stats['long-helper']++;
    return Expr.paren(Expr.binary(left, h.op, right));
  };

  // --- arithmetic on a comparison's 0/1 -----------------------------------

  /** A literal's value and type as the usual arithmetic conversions see it, `-N` included. */
  const literalOf = (e: Expression): { v: bigint; t: IntType; hex: boolean } | null => {
    const u = unwrapParens(e);
    if (u.kind === NodeKind.IntegerLiteral) {
      const lit = u as IntegerLiteralExpr;
      const lt = literalType(lit);
      return lt && lt.bits <= 32 ? { v: lit.value, t: promote(lt), hex: lit.base === 16 } : null;
    }
    if (u.kind === NodeKind.CharLiteral) {
      const c = u as CharLiteralExpr;
      // A plain char literal is a signed char on both compilers of the tree (no /J).
      if (c.prefix !== '' || c.value < 0 || c.value > 0xff) return null;
      return { v: BigInt(c.value >= 0x80 ? c.value - 0x100 : c.value), t: S32, hex: false };
    }
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
      const inner = literalOf((u as UnaryExpr).operand as Expression);
      return inner ? { v: -inner.v, t: inner.t, hex: inner.hex } : null;
    }
    return null;
  };

  /** v as a literal of t (32 bits), or null when t cannot hold it. */
  const literalIn = (v: bigint, t: IntType, hex: boolean): Expression | null => {
    if (t.bits !== 32) return null;
    if (t.signed) {
      if (v < -0x7fffffffn || v > 0x7fffffffn) return null;
      return Expr.intLiteral(v, hex ? 16 : 10);
    }
    const u = ((v % 0x100000000n) + 0x100000000n) % 0x100000000n;
    const lit = Expr.intLiteral(u, 16);
    // A hex literal past INT_MAX is unsigned already; below it the suffix keeps the type.
    if (u <= 0x7fffffffn) return { ...lit, suffix: 'U', raw: lit.raw + 'U' } as IntegerLiteralExpr;
    return lit;
  };

  const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>=']);
  /** A comparison, or one under a cast to a 32-bit integer (still 0 or 1), with the type it has. */
  const comparisonOf = (e: Expression): { c: BinaryExpr; t: IntType } | null => {
    const cast = castOf(e);
    if (cast) {
      const inner = cast.type.bits === 32 ? comparisonOf(cast.inner) : null;
      return inner ? { c: inner.c, t: cast.type } : null;
    }
    const u = unwrapParens(e);
    return u.kind === NodeKind.BinaryExpr && COMPARE.has((u as BinaryExpr).operator) ? { c: u as BinaryExpr, t: S32 } : null;
  };

  /** `c * K`, `c` a comparison and K a literal: c and K. */
  const scaledTest = (e: Expression): { c: BinaryExpr; t: IntType; k: { v: bigint; t: IntType; hex: boolean }; bare?: true } | null => {
    const c = comparisonOf(e);
    if (c) return { c: c.c, t: c.t, k: { v: 1n, t: S32, hex: false }, bare: true };
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '*') return null;
    const b = u as BinaryExpr;
    const l = comparisonOf(b.left as Expression), r = comparisonOf(b.right as Expression);
    const k = l ? literalOf(b.right as Expression) : r ? literalOf(b.left as Expression) : null;
    if (!k || k.v === 0n) return null;
    return { c: (l ?? r)!.c, t: (l ?? r)!.t, k };
  };

  /**
   * `(c) * K + C`, `C + (c) * K`, `(c) * K - C`, `C - (c) * K`, and the same with K = 1, c a
   * comparison and K, C literals, is `c ? K+C : C` (`c ? C-K : C`, ...). A comparison is 0
   * or 1, so both have the value and the type (int, or unsigned int when a literal is) for
   * every operand. VC8 compiles the select branch-free (`setne cl; lea ecx,[ecx+ecx+0xb]`,
   * `neg; sbb; add`), and that branch-free code is all the decompiler prints as arithmetic
   * on a comparison; compiled as printed, VC8 does the arithmetic itself in the byte
   * (`add cl,cl; add cl,0xb`) or with `setne; sub` instead.
   */
  const foldSetccSelect = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '+' && b.operator !== '-') return null;
    let test = scaledTest(b.left as Expression);
    let other = literalOf(b.right as Expression);
    let scaledLeft = true;
    if (!test || !other) {
      test = scaledTest(b.right as Expression);
      other = literalOf(b.left as Expression);
      scaledLeft = false;
    }
    if (!test || !other) return null;
    // `(c) - C` is left: the measured forms are `C + (c)` and `C - (c)`.
    if (test.bare && b.operator === '-' && scaledLeft) return null;
    const type = commonType(commonType(test.t, test.k.t), other.t);
    if (type.bits !== 32) return null;
    const k = test.k.v, c = other.v;
    const whenTrue = scaledLeft ? (b.operator === '+' ? k + c : k - c) : (b.operator === '+' ? c + k : c - k);
    const whenFalse = scaledLeft ? (b.operator === '+' ? c : -c) : c;
    const hex = test.k.hex || other.hex;
    const yes = literalIn(whenTrue, type, hex), no = literalIn(whenFalse, type, hex);
    if (!yes || !no) return null;
    stats['setcc-select']++;
    return Expr.conditional(test.c, yes, no);
  };

  const RULES = [foldLongHelper, foldLowDword, foldNarrowDiv, foldMagic, foldCastChain, foldPow2Div, foldModulo, foldDivides, foldSetccSelect];

  /** One idiom at the root of e, its result folded again. */
  const fold = (e: Expression): Expression | null => {
    for (const rule of RULES) {
      const out = rule(e);
      if (out) return foldDeep(out) ?? out;
    }
    return null;
  };

  /** The rewrite's own children may now form an idiom too. */
  const foldDeep = (e: Expression): Expression | null => {
    const out = transformExpr(e);
    return out === e ? null : out;
  };

  const transformExpr = (e: Expression): Expression => {
    const t = createTransformer({
      visitNode(n: ASTNode) {
        return fold(n as Expression) ?? undefined;
      },
    });
    return t(e as ASTNode) as Expression;
  };

  /** Where only the truth of e is used: `(uint64_t)(x)` is x. */
  const foldTruth = (e: Expression): Expression | null => {
    const c = castOf(e);
    if (!c || c.type.bits !== 64) return null;
    const t = typeOf(c.inner);
    if (!t || t.bits > 32) return null;
    stats['cast-chain']++;
    return c.inner;
  };

  // --- statement pairs -------------------------------------------------

  const identName = (e: Expression | null | undefined): string | null => {
    const u = e ? unwrapParens(e) : null;
    return u && u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
  };

  /** `x = v;` or `T x = v;`: x, v, and how to put another value in v's place. */
  const assignmentOf = (s: Statement): { name: string; value: Expression; with: (v: Expression) => Statement } | null => {
    if (s.kind === NodeKind.ExprStmt) {
      const e = unwrapParens((s as ExprStmt).expression);
      if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
      const a = e as AssignExpr;
      const name = identName(a.left as Expression);
      if (!name) return null;
      return { name, value: a.right as Expression, with: v => updateNode(s as ExprStmt, { expression: updateNode(a, { right: v } as Partial<AssignExpr>) } as Partial<ExprStmt>) };
    }
    if (s.kind === NodeKind.DeclStmt) {
      const d = s as DeclStmt;
      if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return null;
      const v = d.declarations[0] as VariableDecl;
      if (!v.initializer || (v.initializer as Expression).kind === NodeKind.InitListExpr) return null;
      return {
        name: v.name.name, value: v.initializer as Expression,
        with: x => updateNode(d, { declarations: [updateNode(v, { initializer: x } as Partial<VariableDecl>)] } as Partial<DeclStmt>),
      };
    }
    return null;
  };

  /** The one statement an `if` without `else` runs. */
  const onlyStatement = (s: IfStmt): Statement | null => {
    if (s.elseBranch) return null;
    const th = s.thenBranch;
    if (th.kind !== NodeKind.CompoundStmt) return th;
    const body = (th as CompoundStmt).statements;
    return body.length === 1 ? body[0] : null;
  };

  /** `(int)x < 0`, or `x < 0` for a signed 32-bit x. */
  const signTestOf = (e: Expression, name: string): boolean => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '<' || intLiteral((u as BinaryExpr).right as Expression) !== 0n) return false;
    const l = (u as BinaryExpr).left as Expression;
    const c = castOf(l);
    if (c) return sameType(c.type, S32) && identName(c.inner) === name && typeOf(c.inner)?.bits === 32;
    return identName(l) === name && sameType(typeOf(l), S32);
  };

  const placedLine = (n: ASTNode): number | null =>
    n.location && n.location.file !== '<generated>' && n.location.start.line > 0 ? n.location.start.line : null;

  /**
   * The original branches on the sign right after the statement on `line`: the `if` on
   * `ifLine` has a conditional jump, and it is the instruction after the last one `line`
   * prints (the AND of a remainder, the FILD of a conversion and its TEST).
   */
  const branchesRightAfter = (layout: BranchLayoutEvidence | null | undefined, line: number | null, ifLine: number | null, gap: number): boolean => {
    if (!layout || line === null || ifLine === null) return false;
    const jcc = layout.ifs.get(ifLine);
    const offs = layout.lines.get(line);
    if (jcc === undefined || !offs || offs.length === 0) return false;
    const last = offs[offs.length - 1];
    return jcc > last && jcc - last <= gap;
  };

  /**
   * `r = x & (0x80000000 | m); if ((int)r < 0) { r = (r - 1 | ~m) + 1; }`, m = 2^k-1, is
   * `r = x % 2^k` for a signed 32-bit x: MSVC's `and; jns; dec; or; inc`. For x >= 0 the
   * AND leaves x's low k bits; for x < 0 it leaves them with the sign bit, and the
   * decrement, OR and increment turn that into low - 2^k, or 0 when the low bits are 0 -
   * the remainder `%` truncates to. Gated on the jump right after the AND.
   */
  const foldPow2Rem = (a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined): Statement | null => {
    if (b.kind !== NodeKind.IfStmt) return null;
    const asg = assignmentOf(a);
    if (!asg) return null;
    const rt = typeOf({ kind: NodeKind.Identifier, name: asg.name } as unknown as Expression);
    if (!rt || rt.bits !== 32) return null;
    const v = unwrapParens(asg.value);
    if (v.kind !== NodeKind.BinaryExpr || (v as BinaryExpr).operator !== '&') return null;
    const mask = intLiteral((v as BinaryExpr).right as Expression);
    if (mask === null || (mask & 0xffffffffn) !== mask || (mask & 0x80000000n) === 0n) return null;
    const m = mask ^ 0x80000000n;
    const n = m + 1n;
    if (n < 2n || n > 0x40000000n || (n & m) !== 0n) return null;
    const x = (v as BinaryExpr).left as Expression;
    const xt = typeOf(x);
    if (!xt || promote(xt).bits !== 32 || xt.bits !== 32) return null;

    const ifs = b as IfStmt;
    if (!signTestOf(ifs.condition, asg.name)) return null;
    const fix = onlyStatement(ifs);
    const fa = fix ? assignmentOf(fix) : null;
    if (!fa || fa.name !== asg.name || fix!.kind !== NodeKind.ExprStmt) return null;
    // (r - 1 | ~m) + 1
    const inc = unwrapParens(fa.value);
    if (inc.kind !== NodeKind.BinaryExpr || (inc as BinaryExpr).operator !== '+' || intLiteral((inc as BinaryExpr).right as Expression) !== 1n) return null;
    const or = unwrapParens((inc as BinaryExpr).left as Expression);
    if (or.kind !== NodeKind.BinaryExpr || (or as BinaryExpr).operator !== '|') return null;
    const notM = negatedLiteral((or as BinaryExpr).right as Expression);
    if (notM === null || ((notM % 0x100000000n) + 0x100000000n) % 0x100000000n !== (0xffffffffn ^ m)) return null;
    const dec = unwrapParens((or as BinaryExpr).left as Expression);
    if (dec.kind !== NodeKind.BinaryExpr || identName((dec as BinaryExpr).left as Expression) !== asg.name) return null;
    const step = (dec as BinaryExpr).operator === '-' ? intLiteral((dec as BinaryExpr).right as Expression)
      : (dec as BinaryExpr).operator === '+' ? negatedLiteral((dec as BinaryExpr).right as Expression) : null;
    if (!(((dec as BinaryExpr).operator === '-' && step === 1n) || ((dec as BinaryExpr).operator === '+' && step === -1n))) return null;

    if (!branchesRightAfter(layout, placedLine(a), placedLine(b), 8)) return null;
    stats['pow2-rem']++;
    const dividend = xt.signed ? x : castNode('int', x);
    return asg.with(Expr.binary(dividend, '%', Expr.intLiteral(n)));
  };

  const floatSpelling = (t: TypeNode): 'float' | 'double' | null => {
    const s = shapeOfNode(t, 0, resolve);
    return s && s.stars === 0 && (s.base === 'float' || s.base === 'double') ? s.base : null;
  };

  /**
   * `f = (F)(int)u; if ((int)u < 0) { f += 2^32; }` (or `f = f + 2^32`), F float or double
   * and u a 32-bit integer, is `f = (F)(uint32_t)u`: VC8's conversion of an unsigned dword
   * loads it as a signed one (FILD) and adds 2^32 when the sign was set. The x87 sum is
   * exact, so the original rounds once, to F, as the conversion does. Gated on the jump
   * after the load.
   */
  const foldU2F = (a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined): Statement | null => {
    if (b.kind !== NodeKind.IfStmt) return null;
    const asg = assignmentOf(a);
    if (!asg) return null;
    const conv = unwrapParens(asg.value);
    if (conv.kind !== NodeKind.CStyleCastExpr) return null;
    const ft = floatSpelling((conv as CStyleCastExpr).type);
    if (!ft) return null;
    const asInt = castOf((conv as CStyleCastExpr).expression as Expression);
    if (!asInt || !sameType(asInt.type, S32)) return null;
    const u = asInt.inner;
    const uName = identName(u);
    if (!uName || typeOf(u)?.bits !== 32) return null;

    const ifs = b as IfStmt;
    if (!signTestOf(ifs.condition, uName)) return null;
    const fix = onlyStatement(ifs);
    if (!fix || fix.kind !== NodeKind.ExprStmt) return null;
    const fe = unwrapParens((fix as ExprStmt).expression);
    if (fe.kind !== NodeKind.AssignExpr || identName((fe as AssignExpr).left as Expression) !== asg.name) return null;
    let addend: Expression | null = null;
    if ((fe as AssignExpr).operator === '+=') addend = (fe as AssignExpr).right as Expression;
    else if ((fe as AssignExpr).operator === '=') {
      const s = unwrapParens((fe as AssignExpr).right as Expression);
      if (s.kind === NodeKind.BinaryExpr && (s as BinaryExpr).operator === '+' && identName((s as BinaryExpr).left as Expression) === asg.name) addend = (s as BinaryExpr).right as Expression;
    }
    const k = addend ? unwrapParens(addend) : null;
    if (!k || k.kind !== NodeKind.FloatingLiteral) return null;
    // 2^32 as the decompiler prints it: exactly, or the float nearest it to 8 digits.
    if (Math.abs((k as FloatingLiteralExpr).value - 4294967296) > 4294967296 * 1e-7) return null;

    if (!branchesRightAfter(layout, placedLine(a), placedLine(b), 16)) return null;
    stats['u2f']++;
    const unsignedU = sameType(typeOf(u), U32) ? u : castNode('uint32_t', u);
    return asg.with(updateNode(conv as CStyleCastExpr, { expression: unsignedU } as Partial<CStyleCastExpr>));
  };

  /**
   * x, the multiplier and the correction of `(int)((uint64_t)((int64_t)x * M) >> 0x20)`,
   * `... + x` or `... - x`, with x a signed int. The multiplier is reduced to a signed
   * dword: a literal of 2^31 or more adds x once more to the high half.
   */
  const highProductOf = (e: Expression): { x: Expression; m: bigint; add: bigint } | null => {
    let u = unwrapParens(e);
    let add = 0n;
    let other: Expression | null = null;
    if (u.kind === NodeKind.BinaryExpr && ((u as BinaryExpr).operator === '+' || (u as BinaryExpr).operator === '-')) {
      add = (u as BinaryExpr).operator === '+' ? 1n : -1n;
      other = (u as BinaryExpr).right as Expression;
      u = unwrapParens((u as BinaryExpr).left as Expression);
    }
    const hi = castOf(u);
    if (!hi || !sameType(hi.type, S32)) return null;
    const sh = unwrapParens(hi.inner);
    if (sh.kind !== NodeKind.BinaryExpr || (sh as BinaryExpr).operator !== '>>'
        || intLiteral((sh as BinaryExpr).right as Expression) !== 32n) return null;
    const wide = castOf((sh as BinaryExpr).left as Expression);
    if (!wide || wide.type.bits !== 64) return null;
    const mul = unwrapParens(wide.inner);
    if (mul.kind !== NodeKind.BinaryExpr || (mul as BinaryExpr).operator !== '*') return null;
    const sx = castOf((mul as BinaryExpr).left as Expression);
    const mv = negatedLiteral((mul as BinaryExpr).right as Expression);
    if (!sx || !sameType(sx.type, S64) || mv === null) return null;
    // The literal's own type must widen to the product without changing its value.
    const mt = typeOf((mul as BinaryExpr).right as Expression);
    if (!mt || mt.bits !== 32 || mv < -(1n << 31n) || mv >= 1n << 32n) return null;
    const x = sx.inner;
    if (!sameType(typeOf(x), S32) || !isPure(x)) return null;
    // x again, through casts that keep its low 32 bits: the sum wraps the same way.
    if (other && (!sameExpr(strip32(other), strip32(x)) || (typeOf(other)?.bits ?? 0) < 32)) return null;
    let m = mv;
    if (m >= 1n << 31n) { m -= 1n << 32n; add += 1n; }
    return { x, m, add };
  };

  /** S of `(t >> S) - (t >> 0x1f)`, or 0 for `t - (t >> 0x1f)`. */
  const roundedShiftOf = (e: Expression, name: string): number | null => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '-') return null;
    const sign = unwrapParens((u as BinaryExpr).right as Expression);
    if (sign.kind !== NodeKind.BinaryExpr || (sign as BinaryExpr).operator !== '>>'
        || intLiteral((sign as BinaryExpr).right as Expression) !== 31n
        || identName((sign as BinaryExpr).left as Expression) !== name) return null;
    const l = unwrapParens((u as BinaryExpr).left as Expression);
    if (identName(l) === name) return 0;
    if (l.kind !== NodeKind.BinaryExpr || (l as BinaryExpr).operator !== '>>'
        || identName((l as BinaryExpr).left as Expression) !== name) return null;
    const s = intLiteral((l as BinaryExpr).right as Expression);
    return s !== null && s >= 1n && s <= 31n ? Number(s) : null;
  };

  /**
   * `t = (int)((uint64_t)((int64_t)x * M) >> 0x20) [± x]; t = (t >> S) - (t >> 0x1f);`,
   * t and x signed ints, is `t = x / d`: the high product, its correction and the
   * shift are exactly the signed reciprocal of d, and subtracting the sign
   * (`t >> 0x1f` is -1 or 0) rounds the quotient toward zero as `/` does. The
   * candidates for d are the ones the multiplier approximates 2^(32+S) / d with;
   * each is checked by computing its reciprocal, so an approximate constant never
   * folds. t's value between the two statements is read nowhere else.
   */
  const foldSignedDiv = (a: Statement, b: Statement): Statement | null => {
    if (b.kind !== NodeKind.ExprStmt) return null;
    const asg = assignmentOf(a);
    if (!asg) return null;
    const tt = typeOf({ kind: NodeKind.Identifier, name: asg.name } as unknown as Expression);
    if (!sameType(tt, S32)) return null;
    const hp = highProductOf(asg.value);
    if (!hp) return null;
    const be = unwrapParens((b as ExprStmt).expression);
    if (be.kind !== NodeKind.AssignExpr || (be as AssignExpr).operator !== '=' || identName((be as AssignExpr).left as Expression) !== asg.name) return null;
    const s = roundedShiftOf((be as AssignExpr).right as Expression, asg.name);
    if (s === null || hp.add < -1n || hp.add > 1n) return null;
    // M + add * 2^32 ~ 2^(32+S) / d.
    const eff = hp.m + hp.add * (1n << 32n);
    if (eff === 0n) return null;
    const approx = (1n << BigInt(32 + s)) / eff;
    for (const d of [approx - 1n, approx, approx + 1n]) {
      const r = signedReciprocal(d);
      if (!r || r.m !== hp.m || r.s !== s || BigInt(r.add) !== hp.add) continue;
      stats['signed-div']++;
      const xu = unwrapParens(hp.x);
      const dividend = xu.kind === NodeKind.BinaryExpr || xu.kind === NodeKind.ConditionalExpr ? Expr.paren(hp.x) : hp.x;
      const divisor = d < 0n ? Expr.unary('-', Expr.intLiteral(-d)) : Expr.intLiteral(d);
      return asg.with(Expr.binary(dividend, '/', divisor));
    }
    return null;
  };

  /** A statement and the one after it folded into one, or null. */
  const foldPair = (a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined): Statement | null =>
    foldPow2Rem(a, b, layout) ?? foldU2F(a, b, layout) ?? foldSignedDiv(a, b);

  return { typeOf, fold, foldTruth, foldPair };
}

// ============================================
// TRANSFORMER
// ============================================

export function createArithIdiomsTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ArithIdiomsOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const folder = createFolder(shapeOf, o, resolve);

      let changed = false;
      const truth = <T extends ASTNode>(n: T, key: keyof T): T | undefined => {
        const cond = n[key] as unknown as Expression | null;
        const out = cond ? folder.foldTruth(cond) : null;
        if (!out) return undefined;
        changed = true;
        return updateNode(n, { [key]: out } as unknown as Partial<T>);
      };
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          switch (n.kind) {
            case NodeKind.IfStmt: return truth(n as IfStmt, 'condition');
            case NodeKind.WhileStmt: return truth(n as WhileStmt, 'condition');
            case NodeKind.DoWhileStmt: return truth(n as DoWhileStmt, 'condition');
            case NodeKind.ForStmt: return truth(n as ForStmt, 'condition');
            case NodeKind.ConditionalExpr: return truth(n as ConditionalExpr, 'condition');
            case NodeKind.UnaryExpr:
              return (n as UnaryExpr).operator === '!' ? truth(n as UnaryExpr, 'operand') : undefined;
            case NodeKind.BinaryExpr: {
              const b = n as BinaryExpr;
              if (b.operator === '&&' || b.operator === '||') {
                const l = folder.foldTruth(b.left as Expression);
                const r = folder.foldTruth(b.right as Expression);
                if (!l && !r) return undefined;
                changed = true;
                return updateNode(b, { left: l ?? b.left, right: r ?? b.right } as Partial<BinaryExpr>);
              }
              break;
            }
          }
          const out = folder.fold(n as Expression);
          if (!out) return undefined;
          changed = true;
          return out as ASTNode;
        },
      });
      const pairs = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CompoundStmt) return undefined;
          const stmts = (n as CompoundStmt).statements;
          let out: Statement[] | null = null;
          for (let i = 0; i < stmts.length; i++) {
            const folded = i + 1 < stmts.length ? folder.foldPair(stmts[i], stmts[i + 1], o.branchLayout) : null;
            if (!folded) { out?.push(stmts[i]); continue; }
            out ??= stmts.slice(0, i);
            const dropped = stmts[i + 1];
            out.push({ ...folded, trailingTrivia: [...(folded.trailingTrivia ?? []), ...(dropped.leadingTrivia ?? [])] } as Statement);
            i++;
          }
          if (!out) return undefined;
          changed = true;
          return updateNode(n as CompoundStmt, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const body = inner(pairs(node.body) as typeof node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/**
 * Arithmetic Idioms Plugin
 *
 * Runs after `float-pointer-bitcast`, which is what spells a seed's 64 bits as
 * `d2_bits_of`, and before the casts that follow it are settled.
 */
export const arithIdiomsPlugin: TransformPlugin = {
  id: 'arith-idioms',
  name: 'Arithmetic Idioms',
  description:
    'Write division, remainder and 64-bit helper idioms back as the operator: x + (x>>31&3) >> 2 -> x / 4, (uint64_t)u * 0xaaaaaaab >> 33 -> u / 3, __alldiv(lo, hi, 100, 0) -> x / 100',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 619,
  tags: ['correctness', 'matching'],

  createTransformer(options?: PluginOptions) {
    return createArithIdiomsTransformer(options);
  },
};

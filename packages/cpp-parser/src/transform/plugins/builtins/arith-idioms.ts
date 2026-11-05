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
 *   widened      32-bit operations the decompiler printed 64 bits wide, which VC8 compiles to
 *                the long helpers: `(T)(A / B)` of sign-extended int32 values (sdiv-widened),
 *                `(E & 0xffffffff) / K` (low-word-div) and the remainder spelled with it,
 *                `(T)((uint64_t)a * K)` (trunc-mul), a constant over a zero-extended dword
 *                (narrow-div), the doubled sign terms of a recovered quotient
 *                (narrow-residue), and a signed reciprocal whose quotient is used inside a
 *                larger expression (signed-div-use). Each fold's comment holds its proof.
 *
 * Every operand that the idiom repeats must be free of calls and assignments:
 * the rewrite evaluates it once.
 *
 * The signed remainder by 2^k (VC8's `and r, 0x80000000|(2^k-1); jns; dec; or r, -2^k;
 * inc`) is folded by its own pass, `pow2-remainder` (priority 51), which runs before
 * `early-return` turns the fix-up's `if` into a guard and copies the tail (see
 * createPow2RemainderTransformer). `arith-idioms` still folds the plain pair.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, Expression, BinaryExpr, CStyleCastExpr, CallExpr, IntegerLiteralExpr,
  UnaryExpr, FunctionDecl, ParameterDecl, VariableDecl, TypeNode, MemberExpr,
  IfStmt, WhileStmt, DoWhileStmt, ForStmt, ConditionalExpr,
  CharLiteralExpr, FloatingLiteralExpr, Statement, ExprStmt, DeclStmt, CompoundStmt, AssignExpr, Identifier, ParenExpr,
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
  | 'setcc-select' | 'pow2-rem' | 'pow2-rem-test' | 'pow2-rem-mask' | 'u2f' | 'abs'
  | 'sdiv-widened' | 'low-word-div' | 'trunc-mul' | 'narrow-residue' | 'signed-div-use' | 'nonneg-div' | 'zext-local' | 'zext-operand' | 'promoted-dividend';

const stats: Record<ArithIdiom, number> = {
  'low-dword': 0, 'narrow-div': 0, 'magic-div': 0, 'cast-chain': 0, 'modulo': 0, 'divides': 0,
  'pow2-div': 0, 'long-helper': 0, 'signed-div': 0, 'setcc-select': 0, 'pow2-rem': 0, 'pow2-rem-test': 0,
  'pow2-rem-mask': 0, 'u2f': 0, 'abs': 0,
  'sdiv-widened': 0, 'low-word-div': 0, 'trunc-mul': 0, 'narrow-residue': 0, 'signed-div-use': 0,
  'nonneg-div': 0, 'zext-local': 0, 'zext-operand': 0, 'promoted-dividend': 0,
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
  foldPair(a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined, ctx?: RemainderRunContext): Statement | null;
  foldRemainderRun(stmts: Statement[], i: number, ctx: RemainderRunContext): { out: Statement[]; next: number } | null;
  foldRemainderMask(value: Expression): Expression | null;
}

/** What a remainder run may need to know beyond its own statements. */
export interface RemainderRunContext {
  layout: BranchLayoutEvidence | null | undefined;
  /** A parameter or local of the function (not a global another call could change). */
  isLocal(name: string): boolean;
  /** The value `name` holds after `stmt` (an `if` of the function) is never read. */
  deadAfter(name: string, stmt: Statement, run: Statement[]): boolean;
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
    let a = zeroExtended(b.left as Expression);
    // A constant dividend 0..INT_MAX: an int that converts to the unsigned divisor's type
    // unchanged (`0x10001 / (uint64_t)v`).
    let constant = false;
    if (!a) {
      const k = intLiteral(b.left as Expression);
      const lt = k !== null ? literalType(unwrapParens(b.left as Expression) as IntegerLiteralExpr) : null;
      if (k === null || k > 0x7fffffffn || !lt || lt.bits > 32) return null;
      a = b.left as Expression;
      constant = true;
    }
    let d = zeroExtended(b.right as Expression);
    if (constant && !d) return null;
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

  /**
   * `x == (uint32_t)x / N * N`, x a 32-bit int: the compare converts x to unsigned, as the
   * dividend is, so it is `(uint32_t)x % N == 0` (ClientSideGameLoop 0044c790).
   */
  const unsignedRemainderOf = (x: Expression, product: Expression): BinaryExpr | null => {
    const p = unwrapParens(product);
    if (p.kind !== NodeKind.BinaryExpr || (p as BinaryExpr).operator !== '*') return null;
    const q = quotient((p as BinaryExpr).left as Expression);
    if (!q || negatedLiteral((p as BinaryExpr).right as Expression) !== q.n) return null;
    const c = castOf(unwrapParens(q.x));
    if (!c || !sameType(c.type, U32) || !sameExpr(c.inner, x) || !isPure(x)) return null;
    const xt = typeOf(x);
    if (!xt || xt.bits !== 32) return null;
    return Expr.binary(q.x, '%', q.div.right as Expression);
  };

  const foldDivides = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '==' && b.operator !== '!=') return null;
    const rem = remainderOf(b.left as Expression, b.right as Expression, 1n)
      ?? remainderOf(b.right as Expression, b.left as Expression, 1n)
      ?? unsignedRemainderOf(b.left as Expression, b.right as Expression)
      ?? unsignedRemainderOf(b.right as Expression, b.left as Expression);
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
    // The bias on either side: `(x >> 0x1f & 3U) + x` is the same sum (MISSILE_GetPoisonNovaRadius
    // 004cc950, ConvertCoordToPerspectiveView 0045aff0).
    const isBias = (v: Expression) => {
      const u = unwrapParens(v);
      return u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&';
    };
    const biasFirst = !isBias(add.right as Expression) && isBias(add.left as Expression);
    const bias = unwrapParens((biasFirst ? add.left : add.right) as Expression);
    if (bias.kind !== NodeKind.BinaryExpr || (bias as BinaryExpr).operator !== '&') return null;
    const and = bias as BinaryExpr;
    if (intLiteral(and.right as Expression) !== (1n << n) - 1n) return null;
    const sign = unwrapParens(and.left as Expression);
    if (sign.kind !== NodeKind.BinaryExpr || (sign as BinaryExpr).operator !== '>>'
        || intLiteral((sign as BinaryExpr).right as Expression) !== 31n) return null;
    const signSource = (sign as BinaryExpr).left as Expression;

    // x, the dividend, with an (int) on it or on its sign taken off.
    const x = (biasFirst ? add.right : add.left) as Expression;
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

  // --- abs ----------------------------------------------------------------

  /**
   * `(x ^ x >> 0x1f) - (x >> 0x1f)`, x a signed 32-bit int (or `(int)y` of a 32-bit y in the
   * shifts), is `abs(x)`: VC8 inlines abs as `cdq; xor eax, edx; sub eax, edx`, the
   * expression as printed compiles to `sar`/`xor`/`sub` (INPUT_HandleMouseWheel 0044c400).
   * Both wrap INT_MIN to itself. The result's type must be int.
   */
  const foldAbs = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '-') return null;
    const sub = e as BinaryExpr;
    const signOf = (v: Expression): Expression | null => {
      const u = unwrapParens(v);
      if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '>>'
          || intLiteral((u as BinaryExpr).right as Expression) !== 31n) return null;
      return (u as BinaryExpr).left as Expression;
    };
    const s2 = signOf(sub.right as Expression);
    const xor = unwrapParens(sub.left as Expression);
    if (!s2 || xor.kind !== NodeKind.BinaryExpr || (xor as BinaryExpr).operator !== '^') return null;
    const xb = xor as BinaryExpr;
    const s1 = signOf(xb.right as Expression);
    if (!s1 || !sameExpr(s1, s2)) return null;
    const asInt = (v: Expression) => {
      const c = castOf(unwrapParens(v));
      return c && sameType(c.type, S32) ? c.inner : unwrapParens(v);
    };
    const y = asInt(xb.left as Expression);
    if (!sameExpr(asInt(s1), y) || !isPure(y)) return null;
    const yt = typeOf(y);
    if (!yt || yt.bits !== 32 || !sameType(typeOf(s1), S32) || !sameType(typeOf(e), S32)) return null;
    stats['abs']++;
    return Expr.call(Expr.identifier('abs'), [yt.signed ? y : castNode('int', y)]);
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

  // --- 32-bit arithmetic the decompiler printed 64 bits wide --------------

  /** e in parentheses unless it is a primary expression a cast can stand in front of. */
  const operandOf = (e: Expression): Expression => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.Identifier || u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CStyleCastExpr
      || u.kind === NodeKind.MemberExpr || u.kind === NodeKind.SubscriptExpr || u.kind === NodeKind.CallExpr
      ? e : Expr.paren(e);
  };

  /**
   * A 32-bit expression with the value of the 64-bit e, for an e whose value provably lies in
   * [INT_MIN, INT_MAX]; null when that is not shown. The result promotes to a signed int.
   *
   *   `(int64_t)x`, x a signed integer of at most 32 bits: the sign extension of x, so x.
   *   `(int64_t)u` or `(uint64_t)u`, u unsigned and narrower than 32 bits: u, at most 0xffff.
   *   `(int64_t)(uint64_t)u` likewise; `(int64_t)(uint64_t)x` for a signed x is the sign
   *   extension again (zero- or sign-extending, then reading the 64 bits as signed, of a
   *   value whose 64-bit pattern is that of x), so x.
   *   `W << k`, W one of the zero-extensions above of a b-bit u with b + k <= 31: `u << k`,
   *   which is below 2^31 and so neither overflows the int nor differs from the 64-bit shift.
   *   A literal of at most 32 bits in [0, INT_MAX]: itself.
   *   `(int64_t)W` or `(uint64_t)W` of a 64-bit W that narrows: W's narrowing.
   */
  const narrowS32 = (e: Expression): Expression | null => {
    const u = unwrapParens(e);
    if (u.kind === NodeKind.IntegerLiteral) {
      const lt = literalType(u as IntegerLiteralExpr);
      return lt && lt.bits <= 32 && (u as IntegerLiteralExpr).value <= 0x7fffffffn ? u : null;
    }
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '<<') {
      const k = intLiteral((u as BinaryExpr).right as Expression);
      const w = castOf((u as BinaryExpr).left as Expression);
      if (k === null || !w || w.type.bits !== 64) return null;
      const t = typeOf(w.inner);
      if (!t || t.signed || t.bits >= 32 || BigInt(t.bits) + k > 31n) return null;
      return Expr.binary(operandOf(w.inner), '<<', (u as BinaryExpr).right as Expression);
    }
    const c = castOf(u);
    if (!c || c.type.bits !== 64) return null;
    let inner = c.inner;
    // A 64-bit cast of a 64-bit operand only reinterprets the bits; every value narrowS32
    // admits is in [INT_MIN, INT_MAX] in the operand's own type (an unsigned one never
    // negative), so the reinterpretation keeps it.
    if (typeOf(inner)?.bits === 64 && !castOf(inner)) return narrowS32(inner);
    const mid = castOf(inner);
    // (int64_t)(uint64_t)x: the outer cast only reinterprets the 64 bits.
    if (c.type.signed && mid && sameType(mid.type, U64)) {
      const t = typeOf(mid.inner);
      if (!t || t.bits > 32) return null;
      inner = mid.inner;
      return t.signed || t.bits < 32 ? inner : null;
    }
    const t = typeOf(inner);
    if (!t || t.bits > 32) return null;
    if (!t.signed) return t.bits < 32 ? inner : null;
    return c.type.signed ? inner : null;
  };

  /** Does every value in [0, max] fit t without wrapping or overflowing? */
  const fitsIn = (max: bigint, t: IntType | null): boolean =>
    !!t && max < (1n << BigInt(t.signed ? t.bits - 1 : t.bits));

  /**
   * An upper bound M of e for an e whose value provably lies in [0, M], else null. Each step
   * holds for every input of the operand types, and an arithmetic step is taken only where
   * its result fits the type it is computed in, so nothing wraps:
   *
   *   a literal v >= 0 is [0, v]; an expression of an unsigned type of b bits is [0, 2^b - 1].
   *   `(T)x` keeps x's bound where that fits T, else is [0, 2^b - 1] for an unsigned T of b bits.
   *   `a & b`: in two's complement an AND with a non-negative value has its sign bit clear
   *   and no bit that value lacks, so it is at most that value - the other side may be anything.
   *   `a | b`, `a ^ b` of two bounded values: below the next power of two above both.
   *   `a >> k`: M >> k; `a << k`, `a + b`, `a * b`: the bound shifted, summed or multiplied.
   *   `a / b` with b >= 0: at most a; `a % b`: at most a and below b.
   */
  const rangeMax = (expr: Expression): bigint | null => {
    const e = unwrapParens(expr);
    const own = typeOf(e);
    const ofType = own && !own.signed ? (1n << BigInt(own.bits)) - 1n : null;
    switch (e.kind) {
      case NodeKind.IntegerLiteral: {
        const v = (e as IntegerLiteralExpr).value;
        return own && v >= 0n ? v : null;
      }
      case NodeKind.CStyleCastExpr: {
        const c = castOf(e);
        if (!c) return null;
        const m = rangeMax(c.inner);
        if (m !== null && fitsIn(m, c.type)) return m;
        return c.type.signed ? null : (1n << BigInt(c.type.bits)) - 1n;
      }
      case NodeKind.BinaryExpr: {
        const b = e as BinaryExpr;
        const l = b.left as Expression;
        const r = b.right as Expression;
        switch (b.operator) {
          case '&': {
            const ml = rangeMax(l);
            const mr = rangeMax(r);
            if (ml !== null && mr !== null) return ml < mr ? ml : mr;
            return ml ?? mr;
          }
          case '|': case '^': {
            const ml = rangeMax(l);
            const mr = rangeMax(r);
            if (ml === null || mr === null) return ofType;
            const hi = ml > mr ? ml : mr;
            return (1n << BigInt(hi.toString(2).length)) - 1n;
          }
          case '>>': {
            const k = intLiteral(r);
            if (k === null || k < 0n || k > 63n) return null;
            const ml = rangeMax(l);
            return ml !== null ? ml >> k : null;
          }
          case '<<': case '+': case '*': {
            const ml = rangeMax(l);
            let out: bigint | null = null;
            if (b.operator === '<<') {
              const k = intLiteral(r);
              if (ml !== null && k !== null && k >= 0n && k <= 63n) out = ml << k;
            } else {
              const mr = rangeMax(r);
              if (ml !== null && mr !== null) out = b.operator === '+' ? ml + mr : ml * mr;
            }
            return out !== null && fitsIn(out, own) ? out : ofType;
          }
          case '/': case '%': {
            const ml = rangeMax(l);
            const mr = rangeMax(r);
            if (ml === null || mr === null) return ofType;
            if (b.operator === '/') return ml;
            return mr > 0n && mr - 1n < ml ? mr - 1n : ml;
          }
        }
        return ofType;
      }
    }
    return ofType;
  };

  /**
   * The 32-bit operand under the 64-bit casts of e, for an e whose value is shown to lie in
   * [0, INT_MAX] (see rangeMax), else null. Every widening of a non-negative value keeps it, so
   * the operand has e's value, and `(int)` of it is exact.
   */
  const nonNeg32 = (e: Expression): Expression | null => {
    let inner = e;
    for (let c = castOf(inner); c && c.type.bits === 64; c = castOf(inner)) inner = c.inner;
    const t = typeOf(inner);
    if (t && t.bits > 32) return null;
    const m = rangeMax(inner);
    return m !== null && m <= 0x7fffffffn ? inner : null;
  };

  /** Does a 64-bit cast chain over e sign-extend somewhere - `(uint64_t)(int64_t)(int)x`? */
  const signExtended = (e: Expression): boolean => {
    for (let c = castOf(e); c && c.type.bits === 64; c = castOf(c.inner)) {
      if (c.type.signed) {
        const t = typeOf(c.inner);
        if (t && t.bits <= 32 && t.signed) return true;
      }
    }
    return false;
  };

  /**
   * `(T)(A / B)` and `(T)(A % B)`, T an integer type of at most 32 bits and A, B 64-bit
   * operands whose values are 32-bit signed ints (see narrowS32), is `(T)(a / b)` in int:
   * both quotients truncate toward zero, and a quotient of two int32 values is an int32
   * value, except INT_MIN / -1 - which the original's `cdq; idiv` traps on too (#DE), so no
   * run of the original reaches it. The remainder of two int32 values is an int32 value and
   * has the dividend's sign in both widths. This is MSVC's `cdq; idiv` the decompiler
   * printed as a 64-bit SDIV of sign-extended operands, and that VC8 compiles to `_alldiv`.
   * A signed operand the narrowing does not see may still be shown to lie in [0, INT_MAX]
   * (nonNeg32).
   *
   * The same division typed unsigned (`(uint64_t)u8 / (uint64_t)(int64_t)(int)w`) is the
   * decompiler's own rewrite of that SDIV once it proved both operands non-negative: the
   * divisor still carries the `cdq`'s sign extension. With both operands shown to lie in
   * [0, INT_MAX], the unsigned and the signed quotient and remainder are the same number, and
   * it fits an int, so `(T)((int)a / (int)b)` has the value of what it replaces - and VC8
   * gives it the original's `cdq; idiv`. Without the sign extension the division is a `div`
   * and stays unsigned (narrow-div).
   */
  const foldSdivWidened = (e: Expression): Expression | null => {
    const outer = castOf(e);
    if (!outer || outer.type.bits > 32 || outer.type.bits === 1) return null;
    const d = unwrapParens(outer.inner);
    if (d.kind !== NodeKind.BinaryExpr) return null;
    const b = d as BinaryExpr;
    if (b.operator !== '/' && b.operator !== '%') return null;
    const dt = typeOf(b);
    let x: Expression | null;
    let y: Expression | null;
    let idiom: ArithIdiom = 'sdiv-widened';
    if (sameType(dt, S64)) {
      x = narrowS32(b.left as Expression) ?? nonNeg32(b.left as Expression);
      y = narrowS32(b.right as Expression) ?? nonNeg32(b.right as Expression);
    } else if (sameType(dt, U64) && signExtended(b.right as Expression)) {
      x = nonNeg32(b.left as Expression);
      y = nonNeg32(b.right as Expression);
      idiom = 'nonneg-div';
    } else {
      return null;
    }
    if (!x || !y) return null;
    const asInt = (v: Expression) => {
      const t = typeOf(v);
      return t && sameType(promote(t), S32) ? operandOf(v) : castNode('int', operandOf(v));
    };
    stats[idiom]++;
    return updateNode(outer.node, { expression: Expr.paren(Expr.binary(asInt(x), b.operator, asInt(y))) } as Partial<CStyleCastExpr>);
  };

  /** E of `E & 0xffffffff` with E a 64-bit integer, else null. */
  const lowWordOf = (e: Expression): Expression | null => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '&') return null;
    if (intLiteral((u as BinaryExpr).right as Expression) !== 0xffffffffn) return null;
    const x = (u as BinaryExpr).left as Expression;
    return typeOf(x)?.bits === 64 && isPure(x) ? x : null;
  };

  /**
   * `(E & 0xffffffff) / D` and `% D`, E a 64-bit integer and D a zero-extended unsigned dword
   * or a constant 1..2^32-1, is `(uint64_t)((uint32_t)E / D)`: the mask leaves the low dword
   * of E, a value below 2^32, and the operands then fit 32 bits as in narrow-div. The type
   * stays the 64-bit one of the mask (unsigned 64 bits: the literal is an unsigned int and
   * E 64 bits wide, so a signed E's sum type is int64_t - the value is the same non-negative
   * number either way, and the cast to uint64_t is then kept only for an unsigned E).
   */
  const foldLowWordDiv = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '/' && b.operator !== '%') return null;
    const x = lowWordOf(b.left as Expression);
    if (!x) return null;
    const t = typeOf(b);
    if (!t || t.bits !== 64) return null;
    let d = zeroExtended(b.right as Expression);
    if (!d) {
      const k = intLiteral(b.right as Expression);
      if (k === null || k < 1n || k > 0xffffffffn || !typeOf(b.right as Expression)) return null;
      d = b.right as Expression;
    }
    stats['low-word-div']++;
    const low = castNode('uint32_t', operandOf(x));
    return castNode(t.signed ? 'int64_t' : 'uint64_t', Expr.paren(Expr.binary(truncMul(low) ?? low, b.operator, operandOf(d))));
  };

  /**
   * `(C1)E + (C2)((uint32_t)E / K) * -K` (and `- (C2)(...) * K`), C1 and C2 casts to 32-bit
   * integers or none, E's low dword the same on both sides and 1 <= K <= INT_MAX, is
   * `(T)((uint32_t)E % K)` with T the type of the sum. In the sum's 32-bit wrapping
   * arithmetic it is u - (u / K) * K for u the low dword, which is u % K, and that lies in
   * [0, K) and so is the same number as an int or an unsigned int.
   */
  const foldLowWordModulo = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '+' && b.operator !== '-') return null;
    const st = typeOf(b);
    if (!st || st.bits !== 32) return null;
    const p = unwrapParens(b.right as Expression);
    if (p.kind !== NodeKind.BinaryExpr || (p as BinaryExpr).operator !== '*') return null;
    const q = quotient((p as BinaryExpr).left as Expression);
    const m = negatedLiteral((p as BinaryExpr).right as Expression);
    if (!q || m === null || q.n > 0x7fffffffn || m !== (b.operator === '+' ? -q.n : q.n)) return null;
    const qc = castOf(q.x);
    if (!qc || !sameType(qc.type, U32)) return null;
    const left = b.left as Expression;
    if (castOf(left) && castOf(left)!.type.bits !== 32) return null;
    const lt = typeOf(left);
    if (!lt || lt.bits < 32) return null;
    if (!sameExpr(strip32(left), qc.inner) || !isPure(left)) return null;
    stats['modulo']++;
    const rem = Expr.binary(q.x, '%', q.div.right as Expression);
    return sameType(st, U32) ? rem : castNode(st.signed ? 'int' : 'uint32_t', Expr.paren(rem));
  };

  /**
   * `(T)(X * Y)`, T an integer type of at most 32 bits and X * Y a 64-bit product of
   * operands that are each a 64-bit cast of an integer of at most 32 bits or a literal, is
   * `(T)(x * y)` in unsigned 32-bit arithmetic: the low 32 bits of a product depend only on
   * the low 32 bits of its factors, a widening (zero- or sign-) keeps those, and T keeps no
   * more. The product is taken unsigned so that it wraps instead of overflowing an int.
   *
   * A bare `(uint32_t)` of the product is left to the caller that made it (foldLowWordDiv):
   * it is also the low half of a dword pair, which the long helpers read as one value and
   * fold whole once they reach their call.
   */
  const truncMul = (e: Expression): Expression | null => {
    const outer = castOf(e);
    if (!outer || outer.type.bits > 32 || outer.type.bits === 1) return null;
    const m = unwrapParens(outer.inner);
    if (m.kind !== NodeKind.BinaryExpr || (m as BinaryExpr).operator !== '*') return null;
    if (typeOf(m)?.bits !== 64) return null;
    const low = (v: Expression): Expression | null => {
      const k = intLiteral(v);
      if (k !== null) return k <= 0xffffffffn && typeOf(v) ? unwrapParens(v) : null;
      const c = castOf(v);
      if (!c || c.type.bits !== 64) return null;
      const t = typeOf(c.inner);
      return t && t.bits <= 32 ? c.inner : null;
    };
    const x = low((m as BinaryExpr).left as Expression);
    const y = low((m as BinaryExpr).right as Expression);
    if (!x || !y) return null;
    const unsignedX = sameType(typeOf(x), U32) || sameType(typeOf(y), U32) ? operandOf(x) : castNode('uint32_t', operandOf(x));
    stats['trunc-mul']++;
    return updateNode(outer.node, { expression: Expr.paren(Expr.binary(unsignedX, '*', operandOf(y))) } as Partial<CStyleCastExpr>);
  };
  const foldTruncMul = (e: Expression): Expression | null => {
    const outer = castOf(e);
    return outer && sameType(outer.type, U32) && emit(outer.node.type as AnyNode).trim() === 'uint32_t' ? null : truncMul(e);
  };

  /**
   * `(c)(x / C) + (c)(x >> 0x1f) - (c)((int64_t)x * M >> 0x3f)`, x a signed int, M a
   * positive literal below 2^32 and c the same cast (or none) on all three, is `(c)(x / C)`.
   * |x * M| < 2^31 * 2^32 = 2^63, so the 64-bit product does not overflow and has the sign
   * of x (it is 0 only for x = 0); `>> 0x3f` of it is then -1 or 0 exactly as `x >> 0x1f`
   * is, so the two sign terms are the same int and cancel. What is left is the first
   * term, whose promoted value is the sum's. They are the residue of a magic division whose
   * quotient the decompiler recovered but whose sign fix-up it printed twice.
   */
  const foldNarrowResidue = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '-') return null;
    const sub = e as BinaryExpr;
    const sum = unwrapParens(sub.left as Expression);
    if (sum.kind !== NodeKind.BinaryExpr || (sum as BinaryExpr).operator !== '+') return null;
    const peel = (v: Expression): { cast: string | null; inner: Expression } => {
      const c = castOf(v);
      return c && c.type.bits < 64 ? { cast: emit(c.node.type as AnyNode).trim(), inner: unwrapParens(c.inner) } : { cast: null, inner: unwrapParens(v) };
    };
    const first = peel((sum as BinaryExpr).left as Expression);
    const sign = peel((sum as BinaryExpr).right as Expression);
    const hi = peel(sub.right as Expression);
    if (first.cast !== sign.cast || sign.cast !== hi.cast) return null;
    // x >> 0x1f
    if (sign.inner.kind !== NodeKind.BinaryExpr || (sign.inner as BinaryExpr).operator !== '>>'
        || intLiteral((sign.inner as BinaryExpr).right as Expression) !== 31n) return null;
    const x = (sign.inner as BinaryExpr).left as Expression;
    if (!sameType(typeOf(x), S32) || !isPure(x)) return null;
    // (int64_t)x * M >> 0x3f
    if (hi.inner.kind !== NodeKind.BinaryExpr || (hi.inner as BinaryExpr).operator !== '>>'
        || intLiteral((hi.inner as BinaryExpr).right as Expression) !== 63n) return null;
    const mul = unwrapParens((hi.inner as BinaryExpr).left as Expression);
    if (mul.kind !== NodeKind.BinaryExpr || (mul as BinaryExpr).operator !== '*') return null;
    const sx = castOf((mul as BinaryExpr).left as Expression);
    const mv = intLiteral((mul as BinaryExpr).right as Expression);
    if (!sx || !sameType(sx.type, S64) || !sameExpr(sx.inner, x) || mv === null || mv < 1n || mv > 0xffffffffn) return null;
    // (c)(x / C)
    if (first.inner.kind !== NodeKind.BinaryExpr || (first.inner as BinaryExpr).operator !== '/'
        || !sameExpr((first.inner as BinaryExpr).left as Expression, x)) return null;
    stats['narrow-residue']++;
    return Expr.paren((sum as BinaryExpr).left as Expression);
  };

  /**
   * `(T)E`, T a 64-bit unsigned integer type and E a binary operation `zext-site` tagged (the
   * p-code zero-extends its 32-bit result), is `(T)(uint32_t)(E)`: the p-code's value is the
   * low 32 bits of E taken as unsigned, which is what `(uint32_t)` keeps, and the cast then
   * widens a non-negative dword. Printed without it, a signed E is sign-extended. An E whose
   * type is already an unsigned dword is left: the cast zero-extends it as it stands.
   */
  const foldZextOperand = (e: Expression): Expression | null => {
    const c = castOf(e);
    if (!c || !sameType(c.type, U64)) return null;
    const inner = unwrapParens(c.inner);
    if (inner.kind !== NodeKind.BinaryExpr || !inner.ghidraInfo?.zextOperand) return null;
    if (sameType(typeOf(inner), U32)) return null;
    stats['zext-operand']++;
    return updateNode(c.node, { expression: castNode('uint32_t', Expr.paren(inner)) } as Partial<CStyleCastExpr>);
  };

  /**
   * `(uint32_t)x / K` or `% K`, the operation `signed-divide-site` tagged (the original divides
   * with IDIV), x an unsigned byte or word and K an int constant from 1, is `(uint32_t)(x / K)`:
   * x promotes to a non-negative int, so the division of the int and that of its unsigned
   * value give the same quotient and remainder, and the outer cast keeps the expression's
   * type. Compiled with the cast on x, VC8 divides unsigned (`xor edx, edx; div`); the
   * original's `cdq; idiv` is the division of the promoted int (OpenLogFileWithTimestamp
   * 0040ebd0). A dividend wider than the cast operand (`(uint32_t)a * (uint32_t)b / 0xff`) is
   * not this shape.
   */
  const foldPromotedDividend = (e: Expression): Expression | null => {
    if (e.kind !== NodeKind.BinaryExpr || !e.ghidraInfo?.signedDivide) return null;
    const b = e as BinaryExpr;
    if (b.operator !== '/' && b.operator !== '%') return null;
    const c = castOf(b.left as Expression);
    if (!c || !sameType(c.type, U32)) return null;
    const t = typeOf(c.inner);
    if (!t || t.signed || (t.bits !== 8 && t.bits !== 16)) return null;
    const k = intLiteral(b.right as Expression);
    if (k === null || k < 1n || k > 0x7fffffffn) return null;
    // An unsigned literal (`100U`) keeps the division unsigned.
    const kt = literalType(unwrapParens(b.right as Expression) as IntegerLiteralExpr);
    if (!kt || !kt.signed || kt.bits !== 32) return null;
    stats['promoted-dividend']++;
    return castNode('uint32_t', Expr.paren(Expr.binary(c.inner, b.operator, b.right as Expression)));
  };

  const RULES = [
    foldPromotedDividend, foldZextOperand, foldLongHelper, foldLowDword, foldLowWordDiv, foldNarrowDiv, foldMagic, foldSdivWidened, foldTruncMul, foldCastChain,
    foldPow2Div, foldLowWordModulo, foldModulo, foldDivides, foldSetccSelect, foldNarrowResidue, foldAbs,
  ];

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

  // --- the signed power-of-two remainder, as the decompiler spells it around the jump ---

  const mod32 = (v: bigint): bigint => ((v % 0x100000000n) + 0x100000000n) % 0x100000000n;

  /** 2^k for the mask 0x80000000 | (2^k - 1), 1 <= k <= 30; null for any other value. */
  const remainderModulus = (mask: bigint | null): bigint | null => {
    if (mask === null || (mask & 0xffffffffn) !== mask || (mask & 0x80000000n) === 0n) return null;
    const m = mask ^ 0x80000000n;
    const n = m + 1n;
    return n >= 2n && n <= 0x40000000n && (n & m) === 0n ? n : null;
  };

  /** e in parentheses where a cast in front of it would bind to its first operand only. */
  const operand = (e: Expression): Expression => {
    const u = unwrapParens(e);
    return u.kind === NodeKind.BinaryExpr || u.kind === NodeKind.ConditionalExpr || u.kind === NodeKind.AssignExpr
      ? Expr.paren(e) : e;
  };

  /** `x % n`, x cast to int unless it is a signed int already. */
  const remainder = (x: Expression, xt: IntType, n: bigint): Expression =>
    Expr.binary(sameType(xt, S32) ? operand(x) : castNode('int', operand(x)), '%', Expr.intLiteral(n));

  /** `(r - 1 | ~(n - 1))` (or `r + -1`): the decrement and the OR of the fix-up. */
  const isFixupOr = (e: Expression, name: string, n: bigint): boolean => {
    const or = unwrapParens(e);
    if (or.kind !== NodeKind.BinaryExpr || (or as BinaryExpr).operator !== '|') return false;
    const notM = negatedLiteral((or as BinaryExpr).right as Expression);
    if (notM === null || mod32(notM) !== (0xffffffffn ^ (n - 1n))) return false;
    const dec = unwrapParens((or as BinaryExpr).left as Expression);
    if (dec.kind !== NodeKind.BinaryExpr || identName((dec as BinaryExpr).left as Expression) !== name) return false;
    const op = (dec as BinaryExpr).operator;
    const step = op === '-' ? intLiteral((dec as BinaryExpr).right as Expression)
      : op === '+' ? negatedLiteral((dec as BinaryExpr).right as Expression) : null;
    return (op === '-' && step === 1n) || (op === '+' && step === -1n);
  };

  /** `r = (r - 1 | ~m) + 1;`: the fix-up that leaves the remainder in r. */
  const isValueFixup = (s: Statement, name: string, n: bigint): boolean => {
    const a = s.kind === NodeKind.ExprStmt ? assignmentOf(s) : null;
    if (!a || a.name !== name) return false;
    const inc = unwrapParens(a.value);
    return inc.kind === NodeKind.BinaryExpr && (inc as BinaryExpr).operator === '+'
      && intLiteral((inc as BinaryExpr).right as Expression) === 1n && isFixupOr((inc as BinaryExpr).left as Expression, name, n);
  };

  /**
   * `b = (r - 1 | ~m) == -1;` (or `!=`): where only whether the remainder is 0 is used, the
   * decompiler keeps the INC's zero flag, `(r - 1 | ~m) + 1 == 0`, as this. The operator.
   */
  const zeroFixupOf = (s: Statement, flag: string, name: string, n: bigint): '==' | '!=' | null => {
    const a = s.kind === NodeKind.ExprStmt ? assignmentOf(s) : null;
    if (!a || a.name !== flag) return null;
    const c = unwrapParens(a.value);
    if (c.kind !== NodeKind.BinaryExpr) return null;
    const op = (c as BinaryExpr).operator;
    if (op !== '==' && op !== '!=') return null;
    const minusOne = negatedLiteral((c as BinaryExpr).right as Expression);
    if (minusOne === null || mod32(minusOne) !== 0xffffffffn) return null;
    return isFixupOr((c as BinaryExpr).left as Expression, name, n) ? op : null;
  };

  /** `b = r == 0;`, `b = !r;`, `b = r != 0;` (or declaring b): the flag, its test and how to set it. */
  const zeroTestOf = (s: Statement, name: string): { flag: string; op: '==' | '!='; with: (v: Expression) => Statement } | null => {
    const a = assignmentOf(s);
    if (!a || a.name === name) return null;
    const ft = typeOf(Expr.identifier(a.name));
    if (!ft || (ft.bits !== 1 && ft.bits !== 8 && ft.bits !== 32)) return null;
    const v = unwrapParens(a.value);
    if (v.kind === NodeKind.UnaryExpr && (v as UnaryExpr).operator === '!' && identName((v as UnaryExpr).operand as Expression) === name) {
      return { flag: a.name, op: '==', with: a.with };
    }
    if (v.kind === NodeKind.BinaryExpr && ((v as BinaryExpr).operator === '==' || (v as BinaryExpr).operator === '!=')
        && identName((v as BinaryExpr).left as Expression) === name && intLiteral((v as BinaryExpr).right as Expression) === 0n) {
      return { flag: a.name, op: (v as BinaryExpr).operator as '==' | '!=', with: a.with };
    }
    return null;
  };

  /** The AND that starts the idiom: `r = x & mask;`, `T r = x & mask;` or `r &= mask;`. */
  const remainderAndOf = (s: Statement): { name: string; x: Expression; n: bigint; decl: boolean; with: (v: Expression) => Statement } | null => {
    if (s.kind === NodeKind.ExprStmt) {
      const e = unwrapParens((s as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '&=') {
        const a = e as AssignExpr;
        const name = identName(a.left as Expression);
        const n = remainderModulus(intLiteral(a.right as Expression));
        if (!name || n === null) return null;
        return {
          name, x: a.left as Expression, n, decl: false,
          with: v => updateNode(s as ExprStmt, { expression: updateNode(a, { operator: '=', right: v } as Partial<AssignExpr>) } as Partial<ExprStmt>),
        };
      }
    }
    const asg = assignmentOf(s);
    if (!asg) return null;
    const v = unwrapParens(asg.value);
    if (v.kind !== NodeKind.BinaryExpr || (v as BinaryExpr).operator !== '&') return null;
    const n = remainderModulus(intLiteral((v as BinaryExpr).right as Expression));
    if (n === null) return null;
    return { name: asg.name, x: (v as BinaryExpr).left as Expression, n, decl: s.kind === NodeKind.DeclStmt, with: asg.with };
  };

  /**
   * The original branches on the sign right after the last instruction of the statements
   * on `lines` (the AND, and what the compiler scheduled between it and the JNS): the `if`
   * on `ifLine` has a conditional jump at most `gap` bytes after it.
   */
  const runBranchesRightAfter = (layout: BranchLayoutEvidence | null | undefined, andLine: number | null, lines: (number | null)[], ifLine: number | null, gap: number): boolean => {
    if (!layout || andLine === null || ifLine === null) return false;
    const jcc = layout.ifs.get(ifLine);
    const andOffs = layout.lines.get(andLine);
    if (jcc === undefined || !andOffs || andOffs.length === 0 || andOffs[andOffs.length - 1] >= jcc) return false;
    let last = andOffs[andOffs.length - 1];
    for (const l of lines) {
      if (l === null) return false;
      for (const off of layout.lines.get(l) ?? []) if (off < jcc && off > last) last = off;
    }
    return jcc - last <= gap;
  };

  /**
   * The signed remainder by 2^k, as a run of statements:
   *
   *   r = x & (0x80000000 | m); [S...] if ((int)r < 0) { r = (r - 1 | ~m) + 1; [if ((int)r < 0) {...}] }
   *     -> r = x % 2^k; [S...] [if ((int)r < 0) {...}]
   *   r = x & (0x80000000 | m); b = r == 0; [S...] if ((int)r < 0) { b = (r - 1 | ~m) == -1; }
   *     -> b = x % 2^k == 0; [S...]                       (`!r` for `r == 0`, `!=` likewise)
   *
   * x is a 32-bit integer (cast to int unless signed), `r &= mask` stands for `r = r & mask`,
   * and m = 2^k - 1. For x >= 0 the AND leaves x's low k bits; for x < 0 it leaves them with
   * the sign bit, and the decrement, OR and increment make that low - 2^k, or 0 when the low
   * bits are 0: the remainder `%` truncates to. A nested `if ((int)r < 0)` after the fix-up
   * (an absolute value) tests the remainder, which is negative only where the AND's result
   * was. S are up to three statements the compiler scheduled between the AND and the JNS
   * (a load, the zero test's flag): plain statements that do not mention r or b - nor, for
   * a global r, call anything. The zero test drops the value the AND leaves in r, so r must
   * be a local and dead after the `if` (`ctx.deadAfter`); a global's value outlives the
   * function. Gated on the original's jump right after the
   * last instruction of the AND and S (`runBranchesRightAfter`).
   */
  const foldRemainderRun = (stmts: Statement[], i: number, ctx: RemainderRunContext): { out: Statement[]; next: number } | null => {
    const and = remainderAndOf(stmts[i]);
    if (!and) return null;
    const rt = typeOf(Expr.identifier(and.name));
    if (!rt || rt.bits !== 32) return null;
    const xt = typeOf(and.x);
    if (!xt || xt.bits !== 32) return null;

    const local = ctx.isLocal(and.name);
    let zero: { at: number; flag: string; op: '==' | '!='; with: (v: Expression) => Statement } | null = null;
    const between: Statement[] = [];
    let j = i + 1;
    for (; j < stmts.length && j - i <= 4; j++) {
      const s = stmts[j];
      if (s.kind === NodeKind.IfStmt) break;
      if (j === i + 1 && !and.decl) {
        const z = zeroTestOf(s, and.name);
        if (z) { zero = { at: j, ...z }; continue; }
      }
      if (s.kind !== NodeKind.ExprStmt && s.kind !== NodeKind.DeclStmt) return null;
      if (mentionsName(s, and.name) || (zero && mentionsName(s, zero.flag))) return null;
      if (!local && !isPure(s)) return null;
      between.push(s);
      if (between.length > 3) return null;
    }
    if (j >= stmts.length || stmts[j].kind !== NodeKind.IfStmt) return null;
    const ifs = stmts[j] as IfStmt;
    if (ifs.elseBranch || ifs.init || !signTestOf(ifs.condition, and.name)) return null;
    const body = ifs.thenBranch.kind === NodeKind.CompoundStmt ? (ifs.thenBranch as CompoundStmt).statements : [ifs.thenBranch];
    if (body.length === 0) return null;

    const runLines = (zero ? [stmts[zero.at]] : []).concat(between).map(placedLine);
    if (!runBranchesRightAfter(ctx.layout, placedLine(stmts[i]), runLines, placedLine(ifs), 8)) return null;

    const rem = remainder(and.x, xt, and.n);
    if (zero) {
      if (body.length !== 1 || zeroFixupOf(body[0], zero.flag, and.name, and.n) !== zero.op) return null;
      if (!local || !ctx.deadAfter(and.name, ifs, stmts.slice(i, j + 1))) return null;
      stats['pow2-rem-test']++;
      return { out: [zero.with(Expr.binary(rem, zero.op, Expr.intLiteral(0))), ...between], next: j + 1 };
    }
    if (!isValueFixup(body[0], and.name, and.n)) return null;
    const rest = body.slice(1);
    if (rest.length > 1) return null;
    if (rest.length === 1) {
      const nested = rest[0];
      if (nested.kind !== NodeKind.IfStmt || (nested as IfStmt).elseBranch || !signTestOf((nested as IfStmt).condition, and.name)) return null;
    }
    stats['pow2-rem']++;
    return { out: [and.with(rem), ...between, ...rest], next: j + 1 };
  };

  /**
   * `x & (0x80000000 | m)` with the fix-up gone: the decompiler drops the JNS arm where it
   * knows x is not negative, and prints the AND as it is. Folded to `x % 2^k` where that
   * has the same value for every x - x zero-extended (an unsigned type narrower than 32
   * bits, so the sign bit is 0) - or where the value is masked again with `& m'`,
   * m' + 1 a power of two at most 2^k, after only additions, subtractions and negations
   * (both are the same modulo 2^k). `value` is the right side of an assignment to a 32-bit
   * integer, where the result type (int against unsigned int) cannot tell.
   */
  const foldRemainderMask = (value: Expression): Expression | null => {
    const direct = (e: Expression): Expression | null => {
      const u = unwrapParens(e);
      if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '&') return null;
      const n = remainderModulus(intLiteral((u as BinaryExpr).right as Expression));
      if (n === null) return null;
      const x = (u as BinaryExpr).left as Expression;
      const xt = typeOf(x);
      if (!xt || xt.signed || xt.bits >= 32) return null;
      stats['pow2-rem-mask']++;
      return remainder(x, xt, n);
    };
    const whole = direct(value);
    if (whole) return whole;

    const u = unwrapParens(value);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '&') return null;
    const outer = intLiteral((u as BinaryExpr).right as Expression);
    if (outer === null || outer < 1n || (outer & (outer + 1n)) !== 0n) return null;
    let changed = false;
    // e with its innermost node (below any parentheses) replaced.
    const rewrap = (e: Expression, inner: Expression): Expression =>
      e.kind === NodeKind.ParenExpr
        ? updateNode(e as ParenExpr, { expression: rewrap((e as ParenExpr).expression as Expression, inner) } as Partial<ParenExpr>)
        : inner;
    // Through + - and unary -, parentheses and 32-bit casts, the AND's value only matters modulo outer + 1.
    const walk = (e: Expression): Expression => {
      const w = unwrapParens(e);
      if (w.kind === NodeKind.BinaryExpr) {
        const b = w as BinaryExpr;
        if (b.operator === '&') {
          const n = remainderModulus(intLiteral(b.right as Expression));
          const xt = typeOf(b.left as Expression);
          if (n !== null && n >= outer + 1n && xt && xt.bits === 32) {
            changed = true;
            stats['pow2-rem-mask']++;
            return Expr.paren(remainder(b.left as Expression, xt, n));
          }
          return e;
        }
        if (b.operator === '+' || b.operator === '-') {
          const l = walk(b.left as Expression);
          const r = walk(b.right as Expression);
          return l === b.left && r === b.right ? e : rewrap(e, updateNode(b, { left: l, right: r } as Partial<BinaryExpr>));
        }
        return e;
      }
      if (w.kind === NodeKind.UnaryExpr && (w as UnaryExpr).operator === '-') {
        const o = walk((w as UnaryExpr).operand as Expression);
        return o === (w as UnaryExpr).operand ? e : rewrap(e, updateNode(w as UnaryExpr, { operand: o } as Partial<UnaryExpr>));
      }
      const c = castOf(w);
      if (c && c.type.bits === 32) {
        const inner = walk(c.inner);
        return inner === c.inner ? e : rewrap(e, updateNode(c.node, { expression: inner } as Partial<CStyleCastExpr>));
      }
      return e;
    };
    const left = walk((u as BinaryExpr).left as Expression);
    return changed ? updateNode(u as BinaryExpr, { left } as Partial<BinaryExpr>) : null;
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
  /** d where `hp` shifted right by s and rounded toward zero is exactly `x / d`, else null. */
  const reciprocalDivisor = (hp: { m: bigint; add: bigint }, s: number): bigint | null => {
    if (hp.add < -1n || hp.add > 1n) return null;
    // M + add * 2^32 ~ 2^(32+S) / d.
    const eff = hp.m + hp.add * (1n << 32n);
    if (eff === 0n) return null;
    const approx = (1n << BigInt(32 + s)) / eff;
    for (const d of [approx - 1n, approx, approx + 1n]) {
      const r = signedReciprocal(d);
      if (r && r.m === hp.m && r.s === s && BigInt(r.add) === hp.add) return d;
    }
    return null;
  };

  const quotientExpr = (x: Expression, d: bigint): BinaryExpr => {
    const xu = unwrapParens(x);
    const dividend = xu.kind === NodeKind.BinaryExpr || xu.kind === NodeKind.ConditionalExpr ? Expr.paren(x) : x;
    const divisor = d < 0n ? Expr.unary('-', Expr.intLiteral(-d)) : Expr.intLiteral(d);
    return Expr.binary(dividend, '/', divisor);
  };

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
    if (s === null) return null;
    const d = reciprocalDivisor(hp, s);
    if (d === null) return null;
    stats['signed-div']++;
    return asg.with(quotientExpr(hp.x, d));
  };

  /** The bit width of an assignment target, or null. */
  const widthOf = (e: Expression): number | null => typeOf(e)?.bits ?? null;

  /**
   * `t = (int)((uint64_t)((int64_t)x * M) >> 0x20) [± x];` followed by a statement that
   * reads t only in `(t >> S) - (t >> 0x1f)` is that statement with `x / d` in its place, as
   * foldSignedDiv proves, when t is a local whose value is read nowhere after. The decompiler
   * leaves the high product in its own statement when the quotient is not stored back to t
   * but used in a larger expression (`nY += (t >> 4) - (t >> 0x1f)`; MSVC's reciprocal for a
   * negative divisor, which Ghidra does not fold).
   *
   * Spelled `(c)(t >> S) - (c)(t >> 0x1f)` with c a cast to an integer of b < 32 bits, the
   * difference agrees with `(c)(x / d)` modulo 2^b only, so it is taken only where every
   * operator between it and an assignment into a target of at most b bits is `+`, `-`, `*`
   * or unary `-`, all of which keep the value modulo 2^b. The second statement must be an
   * assignment free of calls and of any other store, so that x is read there with the value
   * it had in the first.
   */
  const foldSignedDivUse = (a: Statement, b: Statement, ctx: RemainderRunContext | undefined): Statement | null => {
    if (!ctx || a.kind !== NodeKind.ExprStmt || b.kind !== NodeKind.ExprStmt) return null;
    const asg = assignmentOf(a);
    if (!asg || !ctx.isLocal(asg.name)) return null;
    if (!sameType(typeOf({ kind: NodeKind.Identifier, name: asg.name } as unknown as Expression), S32)) return null;
    const hp = highProductOf(asg.value);
    if (!hp) return null;
    const be = unwrapParens((b as ExprStmt).expression);
    // A call of a named function with pure arguments reads x before the callee runs, as an
    // assignment's right side does before the store.
    if (be.kind === NodeKind.CallExpr) {
      const call = be as CallExpr;
      if (calleeName(call.callee) === undefined || !call.arguments.every(a => isPure(a as Expression))) return null;
    } else if (be.kind === NodeKind.AssignExpr) {
      const as = be as AssignExpr;
      if (as.operator !== '=' && as.operator !== '+=' && as.operator !== '-=') return null;
      if (!isPure(as.left as Expression) || !isPure(as.right as Expression)) return null;
      if (mentionsName(as.left, asg.name)) return null;
    } else {
      return null;
    }
    // Needed only for a byte or word spelling of the difference, which a call argument never is.
    const target = be.kind === NodeKind.AssignExpr ? widthOf((be as AssignExpr).left as Expression) ?? 64 : 64;
    const modularRoot = be.kind === NodeKind.AssignExpr;

    let found = 0;
    let dividend: Expression = hp.x;
    /** e with the rounded shift of t replaced; `modular` while only mod-2^b-safe operators lie above. */
    const replace = (e: Expression, modular: boolean): Expression => {
      const u = unwrapParens(e);
      const s = roundedShiftOf(u, asg.name);
      if (s !== null) {
        const d = reciprocalDivisor(hp, s);
        if (d === null) return e;
        found++;
        return Expr.paren(quotientExpr(dividend, d));
      }
      if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '-') {
        const l = castOf((u as BinaryExpr).left as Expression);
        const r = castOf((u as BinaryExpr).right as Expression);
        if (modular && l && r && l.type.bits < 32 && l.type.bits > 1 && sameType(l.type, r.type) && target <= l.type.bits) {
          const inner = Expr.binary(l.inner, '-', r.inner);
          const sh = roundedShiftOf(inner, asg.name);
          const d = sh === null ? null : reciprocalDivisor(hp, sh);
          if (d !== null) {
            found++;
            return updateNode(l.node, { expression: Expr.paren(quotientExpr(dividend, d)) } as Partial<CStyleCastExpr>);
          }
        }
      }
      if (u.kind === NodeKind.BinaryExpr) {
        const bo = u as BinaryExpr;
        const keeps = modular && (bo.operator === '+' || bo.operator === '-' || bo.operator === '*');
        const left = replace(bo.left as Expression, keeps);
        const right = replace(bo.right as Expression, keeps);
        return left === bo.left && right === bo.right ? e : updateNode(bo, { left, right } as Partial<BinaryExpr>);
      }
      if (u.kind === NodeKind.UnaryExpr) {
        const uo = u as UnaryExpr;
        const operand = replace(uo.operand as Expression, modular && uo.operator === '-');
        return operand === uo.operand ? e : updateNode(uo, { operand } as Partial<UnaryExpr>);
      }
      if (u.kind === NodeKind.CStyleCastExpr) {
        const c = u as CStyleCastExpr;
        const inner = replace(c.expression as Expression, false);
        return inner === c.expression ? e : updateNode(c, { expression: inner } as Partial<CStyleCastExpr>);
      }
      return e;
    };
    // t may be read nowhere else in the statement; x itself may name t (`t = hi(t * M)`),
    // since with the first statement gone t still holds x there.
    const rewrite = (): Expression | null => {
      if (be.kind === NodeKind.AssignExpr) {
        const as = be as AssignExpr;
        const right = replace(as.right as Expression, modularRoot);
        return right === as.right ? null : updateNode(as, { right } as Partial<AssignExpr>);
      }
      const call = be as CallExpr;
      const args = call.arguments.map(a => replace(a as Expression, false));
      return args.every((a, i) => a === call.arguments[i]) ? null : updateNode(call, { arguments: args } as Partial<CallExpr>);
    };
    dividend = { kind: NodeKind.IntegerLiteral, value: 1n, base: 10, raw: '1' } as unknown as Expression;
    const probe = rewrite();
    if (!probe || found !== 1 || mentionsName(probe, asg.name)) return null;
    found = 0;
    dividend = hp.x;
    const out = rewrite();
    if (!out || !ctx.deadAfter(asg.name, b, [a, b])) return null;
    stats['signed-div-use']++;
    return updateNode(b as ExprStmt, { expression: out } as Partial<ExprStmt>);
  };

  /** A statement and the one after it folded into one, or null. */
  const foldPair = (a: Statement, b: Statement, layout: BranchLayoutEvidence | null | undefined, ctx?: RemainderRunContext): Statement | null =>
    foldPow2Rem(a, b, layout) ?? foldU2F(a, b, layout) ?? foldSignedDiv(a, b) ?? foldSignedDivUse(a, b, ctx);

  return { typeOf, fold, foldTruth, foldPair, foldRemainderRun, foldRemainderMask };
}

// ============================================
// WHETHER A VALUE IS READ AGAIN
// ============================================

/**
 * Whether `name` occurs in n as a variable. A member name does not count, nor a
 * qualified name (a global), nor - unless `decls` - the name a declaration declares.
 * `skip` holds the locations of statements not to look into.
 */
function mentionsName(n: unknown, name: string, decls = true, skip?: Set<object>): boolean {
  let found = false;
  const visit = (x: unknown): void => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    const node = x as ASTNode;
    if (skip && node.location && skip.has(node.location)) return;
    switch (node.kind) {
      case NodeKind.Identifier:
        if ((node as Identifier).name === name) found = true;
        return;
      case NodeKind.QualifiedId:
        return;
      case NodeKind.MemberExpr:
        visit((node as MemberExpr).object);
        return;
      case NodeKind.VariableDecl: {
        const v = node as VariableDecl;
        if (decls && v.name.name === name) { found = true; return; }
        visit(v.initializer);
        return;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(n);
  return found;
}

/** A block of statements, the index of one of them, and the statement the block belongs to. */
interface BlockFrame { stmts: Statement[]; index: number; owner: Statement | null }

const LOOPS = new Set<NodeKind>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

/**
 * Liveness on the function as the decompiler printed it, before this pass changes it. The
 * transformer copies every node it passes, but a copy keeps its `location` object, so a
 * statement is found again by that.
 */
function createLiveness(body: CompoundStmt, throughLoops = false): (name: string, after: Statement, run: Statement[]) => boolean {
  const paths = new Map<object, BlockFrame[]>();
  let jumps = false;
  const listOf = (s: Statement): Statement[] => s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
  const walk = (stmts: Statement[], owner: Statement | null, path: BlockFrame[]): void => {
    stmts.forEach((s, index) => {
      const frames = [...path, { stmts, index, owner }];
      if (s.location) paths.set(s.location, frames);
      switch (s.kind) {
        case NodeKind.CompoundStmt: walk((s as CompoundStmt).statements, s, frames); break;
        case NodeKind.IfStmt: {
          const f = s as IfStmt;
          walk(listOf(f.thenBranch), s, frames);
          if (f.elseBranch) walk(listOf(f.elseBranch), s, frames);
          break;
        }
        case NodeKind.WhileStmt: case NodeKind.DoWhileStmt: case NodeKind.ForStmt: case NodeKind.ForRangeStmt:
          walk(listOf((s as WhileStmt).body), s, frames);
          break;
        case NodeKind.GotoStmt: case NodeKind.LabelStmt:
          jumps = true;
          break;
      }
    });
  };
  walk(body.statements, null, []);
  if (!jumps) jumps = findNodesByKind(body, NodeKind.GotoStmt).length > 0 || findNodesByKind(body, NodeKind.LabelStmt).length > 0;

  type Flow = 'read' | 'kill' | 'none';
  const flow = (s: Statement, name: string): Flow => {
    switch (s.kind) {
      case NodeKind.NullStmt:
        return 'none';
      case NodeKind.ExprStmt: {
        const e = unwrapParens((s as ExprStmt).expression);
        if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '='
            && unwrapParens((e as AssignExpr).left as Expression).kind === NodeKind.Identifier
            && ((unwrapParens((e as AssignExpr).left as Expression)) as Identifier).name === name
            && !mentionsName((e as AssignExpr).right, name)) return 'kill';
        return mentionsName(s, name) ? 'read' : 'none';
      }
      case NodeKind.DeclStmt:
        return mentionsName(s, name) ? 'read' : 'none';
      case NodeKind.ReturnStmt:
        return mentionsName(s, name) ? 'read' : 'kill';
      case NodeKind.CompoundStmt:
        return seq((s as CompoundStmt).statements, name);
      case NodeKind.IfStmt: {
        const f = s as IfStmt;
        if (f.init || mentionsName(f.condition, name)) return 'read';
        const t = flow(f.thenBranch, name);
        const e = f.elseBranch ? flow(f.elseBranch, name) : 'none';
        if (t === 'read' || e === 'read') return 'read';
        return t === 'kill' && e === 'kill' ? 'kill' : 'none';
      }
      case NodeKind.DoWhileStmt: {
        if (!throughLoops) break;
        // A loop that does not name it neither reads nor kills it; its break and continue stay in it.
        if (!mentionsName(s, name)) return 'none';
        // The body runs at least once; a break or continue in it reads (see the default).
        const f = flow((s as DoWhileStmt).body, name);
        if (f !== 'none') return f;
        return mentionsName((s as DoWhileStmt).condition, name) ? 'read' : 'none';
      }
      case NodeKind.WhileStmt: case NodeKind.ForStmt: {
        if (!throughLoops) break;
        if (!mentionsName(s, name)) return 'none';
        // The body may not run at all: it can read the name, never kill it for the code after.
        const head = s.kind === NodeKind.ForStmt
          ? [(s as ForStmt).init, (s as ForStmt).condition, (s as ForStmt).increment] : [(s as WhileStmt).condition];
        if (head.some(h => mentionsName(h, name))) return 'read';
        return flow((s as WhileStmt).body, name) === 'read' ? 'read' : 'none';
      }
    }
    switch (s.kind) {
      default:
        // Loops, switches, jumps: followed nowhere; anything that mentions the name reads it.
        return mentionsName(s, name) || s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt
          || s.kind === NodeKind.GotoStmt ? 'read' : 'none';
    }
  };
  const seq = (stmts: Statement[], name: string): Flow => {
    for (const s of stmts) {
      const f = flow(s, name);
      if (f !== 'none') return f;
    }
    return 'none';
  };

  return (name, after, run) => {
    const skip = new Set<object>(run.map(s => s.location).filter((l): l is NonNullable<typeof l> => !!l));
    if (skip.size !== run.length) return false;
    if (!mentionsName(body, name, false, skip)) return true;
    const frames = after.location ? paths.get(after.location) : undefined;
    if (!frames || jumps) return false;
    for (let level = frames.length - 1; level >= 0; level--) {
      const { stmts, index, owner } = frames[level];
      const f = seq(stmts.slice(index + 1), name);
      if (f !== 'none') return f === 'kill';
      // Past the end of this block control goes on after its owner - unless that is a loop.
      if (owner === null) return true;
      if (throughLoops && LOOPS.has(owner.kind) && owner.kind !== NodeKind.ForRangeStmt) {
        // Past the end of a loop body control reaches the loop's own expressions, then the
        // body from its start or the statement after the loop. Neither the expressions nor
        // the body's start may read the name; after the loop is the next level's question.
        const cond = (owner as WhileStmt | DoWhileStmt | ForStmt).condition;
        if (mentionsName(cond, name) || (owner.kind === NodeKind.ForStmt && mentionsName((owner as ForStmt).increment, name))) return false;
        if (seq(stmts, name) === 'read') return false;
        continue;
      }
      if (LOOPS.has(owner.kind) || (owner.kind !== NodeKind.IfStmt && owner.kind !== NodeKind.CompoundStmt)) return false;
    }
    return true;
  };
}

// ============================================
// ZERO-EXTENDED 64-BIT LOCALS
// ============================================

/**
 * A 64-bit local that only ever holds a zero-extended dword, declared as the dword.
 *
 * `uint64_t nDivisor; nDivisor = (uint64_t)nLoopIdx; ... 0x10000 / nDivisor` is how the
 * decompiler prints a 32-bit `xor edx, edx; div` whose dividend register it merged with the
 * zero-extension; Ghidra keeps the variable 8 bytes wide (the storage is the ZEXT's output and
 * cannot be resized), and VC8 compiles the 64-bit division to `_aulldiv` and the product to
 * `_allmul` where the original has one `div` or `mul`.
 *
 * Held to a local declared once (not a parameter), every definition of which - the initialiser
 * or a plain `=` - is a 64-bit cast of an unsigned integer of at most 32 bits (or a literal in
 * [0, 2^32)), and every read of which is an operand of `/`, `%` or `*`, or the operand of a cast
 * to an integer of at most 32 bits. Then:
 *
 *   - every value the local holds lies in [0, 2^32), so a uint32_t holds the same number;
 *   - each definition stores its 32-bit operand: the same value, converted to uint32_t exactly;
 *   - each arithmetic read becomes `(T)x`, T the old 64-bit type: the zero-extension of the
 *     same number is that number in T, so the operation sees the value and type it saw;
 *   - each truncating read `(U)x` of the uint32_t is the truncation of the same number.
 *
 * The arithmetic is then a 64-bit operation on zero-extended dwords, which the narrow-div,
 * cast-chain and trunc-mul folds reduce, each with its own proof.
 */
function retypeZextLocals(fn: FunctionDecl, o: ArithIdiomsOptions, resolve: TypedefResolver): FunctionDecl {
  if (!fn.body) return fn;
  const { folder } = functionFolder(fn, o, resolve);
  const params = new Set(fn.parameters.map(p => (p as ParameterDecl).name?.name).filter((n): n is string => !!n));
  const decls = new Map<string, VariableDecl[]>();
  for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    decls.set(v.name.name, [...(decls.get(v.name.name) ?? []), v]);
  }
  const intOf = (t: TypeNode): IntType | null => {
    const sh = shapeOfNode(t, 0, resolve);
    return sh && sh.stars === 0 ? INT_BASES[sh.base] ?? null : null;
  };
  /** The dword a definition stores, or null when it is not a zero-extension of one. */
  const zextOperand = (rhs: Expression): Expression | null => {
    const u = unwrapParens(rhs);
    if (u.kind === NodeKind.IntegerLiteral) {
      const v = (u as IntegerLiteralExpr).value;
      const lt = literalType(u as IntegerLiteralExpr);
      return lt && v >= 0n && v <= 0xffffffffn ? u : null;
    }
    if (u.kind !== NodeKind.CStyleCastExpr) return null;
    const ct = intOf((u as CStyleCastExpr).type);
    if (!ct || ct.bits !== 64) return null;
    const inner = (u as CStyleCastExpr).expression as Expression;
    const t = folder.typeOf(inner);
    return t && !t.signed && t.bits <= 32 ? inner : null;
  };

  type Site = 'def' | 'arith' | 'trunc';
  const candidates = new Map<string, { decl: VariableDecl; type: TypeNode }>();
  for (const [name, ds] of decls) {
    if (ds.length !== 1 || params.has(name)) continue;
    const t = intOf(ds[0].type);
    if (!t || t.bits !== 64) continue;
    if (ds[0].initializer && !zextOperand(ds[0].initializer as Expression)) continue;
    candidates.set(name, { decl: ds[0], type: ds[0].type });
  }
  if (candidates.size === 0) return fn;

  // Every reference of each candidate, by the Identifier node, and what it is.
  const sites = new Map<object, Site>();
  const bad = new Set<string>();
  const isRef = (n: unknown, name?: string): n is Identifier => {
    const u = n && unwrapParens(n as Expression);
    return !!u && u.kind === NodeKind.Identifier && candidates.has((u as Identifier).name)
      && (name === undefined || (u as Identifier).name === name);
  };
  const visit = (n: unknown, parent: ASTNode | null, key: string): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(c => visit(c, parent, key)); return; }
    const node = n as ASTNode;
    if (node.kind === NodeKind.QualifiedId) return;
    if (node.kind === NodeKind.MemberExpr) { visit((node as MemberExpr).object, node, 'object'); return; }
    if (node.kind === NodeKind.VariableDecl) { visit((node as VariableDecl).initializer, node, 'initializer'); return; }
    if (node.kind === NodeKind.Identifier) {
      const name = (node as Identifier).name;
      if (!candidates.has(name)) return;
      let p = parent;
      // The parent that is not a parenthesis.
      let site: Site | null = null;
      if (p && p.kind === NodeKind.ParenExpr) p = null;
      if (p?.kind === NodeKind.AssignExpr && key === 'left' && (p as AssignExpr).operator === '='
          && zextOperand((p as AssignExpr).right as Expression)) site = 'def';
      else if (p?.kind === NodeKind.BinaryExpr && ['/', '%', '*'].includes((p as BinaryExpr).operator)) site = 'arith';
      else if (p?.kind === NodeKind.CStyleCastExpr) {
        const ct = intOf((p as CStyleCastExpr).type);
        if (ct && ct.bits <= 32) site = 'trunc';
      }
      if (site) sites.set(node, site); else bad.add(name);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') visit(v, node, k);
    }
  };
  visit(fn.body, null, '');
  for (const name of bad) candidates.delete(name);
  if (candidates.size === 0) return fn;

  const t = createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      switch (n.kind) {
        case NodeKind.VariableDecl: {
          const v = n as VariableDecl;
          if (!candidates.has(v.name.name)) return undefined;
          const init = v.initializer ? zextOperand(v.initializer as Expression) : null;
          stats['zext-local']++;
          return updateNode(v, { type: Type.typedef('uint32_t'), ...(init ? { initializer: init } : {}) } as Partial<VariableDecl>);
        }
        case NodeKind.AssignExpr: {
          const a = n as AssignExpr;
          if (a.operator !== '=' || !isRef(a.left)) return undefined;
          const inner = zextOperand(a.right as Expression);
          return inner ? updateNode(a, { right: inner } as Partial<AssignExpr>) : undefined;
        }
        case NodeKind.BinaryExpr: {
          const b = n as BinaryExpr;
          if (!['/', '%', '*'].includes(b.operator)) return undefined;
          const wrap = (e: Expression): Expression => {
            if (!isRef(e)) return e;
            const name = (unwrapParens(e) as Identifier).name;
            return Expr.cast(candidates.get(name)!.type, unwrapParens(e));
          };
          const l = wrap(b.left as Expression);
          const r = wrap(b.right as Expression);
          return l === b.left && r === b.right ? undefined : updateNode(b, { left: l, right: r } as Partial<BinaryExpr>);
        }
      }
      return undefined;
    },
  });
  return t(fn) as FunctionDecl;
}

// ============================================
// TRANSFORMER
// ============================================

/** The function's parameter and local types, and a folder that types expressions with them. */
function functionFolder(node: FunctionDecl, o: ArithIdiomsOptions, resolve: TypedefResolver): { localTypes: Map<string, TypeNode>; folder: Folder } {
  const localTypes = new Map<string, TypeNode>();
  for (const p of node.parameters) {
    const pd = p as ParameterDecl;
    if (pd.name) localTypes.set(pd.name.name, pd.type);
  }
  if (node.body) {
    for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
      const v = d as VariableDecl;
      if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
    }
  }
  const shapeOf = createExprShape(localTypes, {
    globalTypes: o.globalTypes ?? {},
    enclosingVarTypes: o.enclosingVarTypes ?? {},
    structFields: o.structFields ?? {},
    fieldTypes: o.fieldTypes ?? {},
    returnTypes: o.functionReturnTypes ?? {},
    resolve,
  });
  return { localTypes, folder: createFolder(shapeOf, o, resolve) };
}

export function createArithIdiomsTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ArithIdiomsOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

  return createTransformer({
    visitFunctionDecl(original: FunctionDecl): ASTNode | undefined {
      if (!original.body) return undefined;
      const node = retypeZextLocals(original, o, resolve);
      const retyped = node !== original;
      const { localTypes, folder } = functionFolder(node, o, resolve);
      const pairCtx: RemainderRunContext = {
        layout: o.branchLayout,
        isLocal: name => localTypes.has(name),
        deadAfter: createLiveness(node.body as CompoundStmt, true),
      };

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
            const folded = i + 1 < stmts.length ? folder.foldPair(stmts[i], stmts[i + 1], o.branchLayout, pairCtx) : null;
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
      const body = inner(pairs(node.body!) as typeof node.body);
      return changed || retyped ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
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

/**
 * VC8's signed remainder by a power of two, in the shapes the decompiler prints it in,
 * back to `%` (see foldRemainderRun and foldRemainderMask). Compiled as printed, the
 * flag of a zero test, a statement scheduled between the AND and its jump, or a fix-up
 * the decompiler dropped each give other code than the original's `x % 2^k`.
 */
export function createPow2RemainderTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ArithIdiomsOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

  return createTransformer({
    visitFunctionDecl(original: FunctionDecl): ASTNode | undefined {
      if (!original.body) return undefined;
      const node = retypeZextLocals(original, o, resolve);
      const retyped = node !== original;
      const { localTypes, folder } = functionFolder(node, o, resolve);
      const ctx: RemainderRunContext = {
        layout: o.branchLayout,
        isLocal: name => localTypes.has(name),
        deadAfter: createLiveness(node.body as CompoundStmt),
      };

      let changed = false;
      const runs = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CompoundStmt) return undefined;
          const stmts = (n as CompoundStmt).statements;
          let out: Statement[] | null = null;
          for (let i = 0; i < stmts.length;) {
            const folded = folder.foldRemainderRun(stmts, i, ctx);
            if (!folded) { out?.push(stmts[i]); i++; continue; }
            out ??= stmts.slice(0, i);
            // Comments on the statements the fold drops stay with what replaces them.
            const kept = new Set<Statement>(folded.out);
            const trivia = stmts.slice(i, folded.next).filter(s => !kept.has(s))
              .flatMap(s => [...(s.leadingTrivia ?? []), ...(s.trailingTrivia ?? [])]);
            const [first, ...others] = folded.out;
            out.push(trivia.length ? { ...first, leadingTrivia: [...(first.leadingTrivia ?? []), ...trivia] } as Statement : first, ...others);
            i = folded.next;
          }
          if (!out) return undefined;
          changed = true;
          return updateNode(n as CompoundStmt, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const masks = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.AssignExpr && (n as AssignExpr).operator === '=') {
            const a = n as AssignExpr;
            if (folder.typeOf(a.left as Expression)?.bits !== 32) return undefined;
            const v = folder.foldRemainderMask(a.right as Expression);
            if (!v) return undefined;
            changed = true;
            return updateNode(a, { right: v } as Partial<AssignExpr>);
          }
          if (n.kind === NodeKind.VariableDecl) {
            const d = n as VariableDecl;
            if (!d.initializer || (d.initializer as Expression).kind === NodeKind.InitListExpr) return undefined;
            if (folder.typeOf(Expr.identifier(d.name.name))?.bits !== 32) return undefined;
            const v = folder.foldRemainderMask(d.initializer as Expression);
            if (!v) return undefined;
            changed = true;
            return updateNode(d, { initializer: v } as Partial<VariableDecl>);
          }
          return undefined;
        },
      });
      const body = masks(runs(node.body) as typeof node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/**
 * Signed Power-of-Two Remainder Plugin
 *
 * Before `early-return` (60): that pass turns `if ((int)r < 0) { fix-up } return E;` into
 * `if ((int)r >= 0) return E; fix-up; return E;`, which no longer reads as the remainder.
 * After `signed-literal` (30), `redundant-negation` (40) and `boolean-cleanup` (50); the
 * folds take the literals and the flag in either spelling.
 */
export const pow2RemainderPlugin: TransformPlugin = {
  id: 'pow2-remainder',
  name: 'Signed Power-of-Two Remainder',
  description:
    "Write VC8's signed remainder by 2^k back as %: r = x & 0x80000003; if ((int)r < 0) r = (r - 1 | -4) + 1; -> r = x % 4, with its zero test, scheduled and fix-up-less spellings",
  version: '1.0.0',
  defaultEnabled: true,
  priority: 51,
  tags: ['correctness', 'matching'],

  createTransformer(options?: PluginOptions) {
    return createPow2RemainderTransformer(options);
  },
};

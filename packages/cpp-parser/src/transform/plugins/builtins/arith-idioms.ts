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
 *   pow2 div     `(int)(x + ((int)x >> 0x1f & 2^n-1)) >> n` is `x / 2^n` (`(int)x`
 *                for an unsigned x): a negative x is biased by 2^n-1 so the
 *                arithmetic shift rounds toward zero, as `/` does. Without the
 *                `(int)` the sum must itself be a signed int.
 *   long helpers `__alldiv(lo, hi, lo2, hi2)` (and `__aulldiv`, `__allrem`,
 *                `__aullrem`, `__allmul`) whose dword pairs are recognisably one
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
}

export type ArithIdiom =
  | 'low-dword' | 'narrow-div' | 'magic-div' | 'cast-chain' | 'modulo' | 'divides' | 'pow2-div' | 'long-helper';

const stats: Record<ArithIdiom, number> = {
  'low-dword': 0, 'narrow-div': 0, 'magic-div': 0, 'cast-chain': 0, 'modulo': 0, 'divides': 0,
  'pow2-div': 0, 'long-helper': 0,
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
// THE FOLDS
// ============================================

interface Folder {
  typeOf(e: Expression): IntType | null;
  fold(e: Expression): Expression | null;
  foldTruth(e: Expression): Expression | null;
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
      }
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

  const HELPERS: Record<string, { op: '/' | '%' | '*'; signed: boolean }> = {
    '__alldiv': { op: '/', signed: true },
    '__aulldiv': { op: '/', signed: false },
    '__allrem': { op: '%', signed: true },
    '__aullrem': { op: '%', signed: false },
    '__allmul': { op: '*', signed: true },
  };

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

  const RULES = [foldLongHelper, foldLowDword, foldNarrowDiv, foldMagic, foldCastChain, foldPow2Div, foldModulo, foldDivides];

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

  return { typeOf, fold, foldTruth };
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
      const body = inner(node.body);
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

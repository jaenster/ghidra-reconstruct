/**
 * Decompiler pseudo-ops lowered to the C++ that computes the same value.
 *
 * Ghidra prints a p-code operation that has no C spelling as a call: `SUB41(x, 1)` is
 * SUBPIECE, `CONCAT31(hi, lo)` is PIECE, `ZEXT14`/`SEXT14` are INT_ZEXT/INT_SEXT and
 * `CARRY4`/`SCARRY4`/`SBORROW4` are the carry and overflow flags. None of them is a symbol
 * in the binary. This pass replaces each call with the exact expression, on the AST:
 *
 *   SUBnm(x, k)     (uintM_t)((uintN_t)x >> 8k)            k counted from the LOW byte
 *   CONCATnm(h, l)  (T)(((T)(uintN_t)h << 8m) | (T)(uintM_t)l)
 *   ZEXTnm(x)       (uintM_t)(uintN_t)x
 *   SEXTnm(x)       (intM_t)(intN_t)x
 *   CARRYn(a, b)    (uintN_t)((uintN_t)a + (uintN_t)b) < (uintN_t)a
 *   SBORROWn(a, b)  (intN_t)((a ^ b) & (a ^ (uintN_t)(a - b))) < 0     (all uintN_t)
 *   SCARRYn(a, b)   (intN_t)(~(a ^ b) & (a ^ (uintN_t)(a + b))) < 0
 *
 * Every intermediate is unsigned and exactly as wide as the varnode Ghidra named, so no
 * shift sign-smears and no sub-int width escapes through promotion. A 3-, 5-, 6- or
 * 7-byte value lives in the next C width and is masked to its size.
 *
 * What an operand IS decides the spelling: an integer is cast, a pointer goes through
 * `uintptr_t`, and a float or double is a bit pattern, read with `d2_bit_cast`. The type
 * comes from the same tables the cast passes use (`expr-shape`); a float is never converted
 * by value, because SUBPIECE and PIECE never are. An operand whose type is
 * not known, or that is narrower than the bytes the operation reads, is NOT guessed at:
 * the call is left as it was and reported. In strict mode it throws instead, so a regen
 * names every function Ghidra still has to type. Flag operations name their operands
 * twice; an operand with a side effect (a call, an assignment) is reported the same way.
 *
 * A flag op whose companion sign test is in the same expression is folded to the signed
 * comparison it implements (`SBORROW4(a, b) != (int)(a - b) < 0` is `a < b`), but only when
 * the operands on both sides are the same AST. Ghidra sometimes substitutes a known value
 * into the companion (`SBORROW4(x, r) != r * -2 < 0`); that is not this shape and is lowered
 * exactly instead.
 *
 * `NAN(x)` is renamed to `D2_IsNaN(x)`: the spelling collides with <cmath>'s object-like
 * NAN macro, which would turn the call into a constant applied to an argument.
 *
 * The instruction-like ops get the spelling of the instruction: ROUND -> std::nearbyint,
 * ABS -> std::fabs, rdtsc -> __rdtsc, cpuid_<leaf> -> D2_Cpuid, builtin_strncpy -> memcpy,
 * ZPULL/SPULL -> shift and mask, `(code*)swi(3)` called -> __debugbreak, and a LOCK/UNLOCK
 * compare-exchange region -> __atomic_compare_exchange_n.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  CallExpr,
  ConditionalExpr,
  CStyleCastExpr,
  Expression,
  FloatingLiteralExpr,
  FunctionDecl,
  Identifier,
  IntegerLiteralExpr,
  ParenExpr,
  TypeNode,
  UnaryExpr,
  VariableDecl,
  MemberExpr,
  ParameterDecl,
  Statement,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, type ExprShapeTables } from './expr-shape.js';
import { calleeName, unwrapParens, type TypeShape } from './call-arg-cast.js';
import { lowerFlagConditions, lowerNegTestConditions } from './flag-conditions.js';
import { lowerCarryChains, lowerWholeConcat, lowerWholeZeroTest } from './carry-chains.js';
import { lowerStringIntrinsics, localArraysOf, localArrayPointersOf } from './string-intrinsics.js';

// ============================================
// REPORTING
// ============================================

/** One pseudo-op the pass could not lower exactly. */
export interface ArtifactRecord {
  /** The pseudo-op, e.g. `SUB41`. */
  op: string;
  /** Why it was left alone. */
  reason: string;
}

/** `report`: leave the call, record it. `strict`: throw. */
export type ArtifactMode = 'report' | 'strict';

/** Thrown in strict mode; the caller turns it into a hard error for the function. */
export class UnlowerableArtifactError extends Error {
  constructor(readonly record: ArtifactRecord) {
    super(`decompiler artifact not lowered: ${record.op}: ${record.reason}`);
    this.name = 'UnlowerableArtifactError';
  }
}

export interface PseudoOpLowerOptions extends PluginOptions {
  mode?: ArtifactMode;
  /** Receives every record in report mode. */
  onArtifact?: (record: ArtifactRecord) => void;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** The function's stack frame: name, frame offset and size of each slot. */
  stackSlots?: ReadonlyArray<{ name: string; offset: number; size: number }>;
  /** Aggregates that are unions: their members overlap. */
  unionNames?: readonly string[];
  /** Aggregate name -> field name -> byte offset. */
  structFieldOffsets?: Record<string, Record<string, number>>;
  /** Aggregate name -> size in bytes. */
  aggregateSizes?: Record<string, number>;
}

// ============================================
// SIZES
// ============================================

/** The byte sizes Ghidra prints in a pseudo-op name. */
const VALID_SIZES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 16, 32]);

/**
 * Split the digit suffix of a two-size op (`SUB161` is 16 -> 1, `CONCAT816` is 8 + 16).
 * Ghidra writes the sizes with no separator; exactly one split into valid sizes may
 * exist, and anything else is an error rather than a guess.
 */
export function splitSizes(digits: string): [number, number] {
  const parses: Array<[number, number]> = [];
  for (let i = 1; i < digits.length; i++) {
    const a = digits.slice(0, i);
    const b = digits.slice(i);
    if (a.startsWith('0') || b.startsWith('0')) continue;
    const na = Number(a);
    const nb = Number(b);
    if (VALID_SIZES.has(na) && VALID_SIZES.has(nb)) parses.push([na, nb]);
  }
  if (parses.length !== 1) {
    throw new Error(`pseudo-op size suffix "${digits}" has ${parses.length} readings`);
  }
  return parses[0];
}

/** The unsigned C container of an n-byte value. */
function uType(n: number): string {
  if (n === 1) return 'uint8_t';
  if (n === 2) return 'uint16_t';
  if (n <= 4) return 'uint32_t';
  return 'uint64_t';
}

function sType(n: number): string {
  return uType(n).slice(1);
}

/** Widths with no C type of their own: they need a mask. */
const isOddWidth = (n: number) => n === 3 || n === 5 || n === 6 || n === 7;

const maskLiteral = (n: number) => `0x${((1n << BigInt(n * 8)) - 1n).toString(16)}u`;

// ============================================
// OPERAND CLASSES
// ============================================

export type Operand =
  /** `signed`: the C type is a signed integer, so `x < 0` is a sign test. Unset when not known. */
  | { kind: 'int'; width: number; signed?: boolean }
  | { kind: 'ptr' }
  | { kind: 'float'; width: number }
  | { kind: 'unknown'; why: string };

/** Canonical base (after `canonicalBase`) -> integer width in bytes. */
const INT_WIDTHS: Record<string, number> = {
  'bool': 1, 'char': 1, 'signed char': 1, 'unsigned char': 1, 'unkbool1': 1,
  // Ghidra's 1-byte float varnode is the AL of a bool return, never a float value.
  'unkfloat1': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2, 'WCHAR': 2, 'float2': 2, 'char16_t': 2,
  'int3': 3, 'uint3': 3, 'undefined3': 3,
  'int': 4, 'unsigned int': 4, 'long': 4, 'unsigned long': 4,
  'uintptr_t': 4, 'intptr_t': 4, 'size_t': 4, 'ssize_t': 4, 'ptrdiff_t': 4,
  'HRESULT': 4, 'LRESULT': 4, 'WPARAM': 4, 'LPARAM': 4, 'SOCKET': 4,
  'int5': 5, 'uint5': 5, 'undefined5': 5,
  'int6': 6, 'uint6': 6, 'undefined6': 6,
  'int7': 7, 'uint7': 7, 'undefined7': 7,
  'long long': 8, 'unsigned long long': 8, '__int64': 8, 'QWORD': 8,
  'LONGLONG': 8, 'ULONGLONG': 8,
};

const FLOAT_WIDTHS: Record<string, number> = {
  'float': 4, 'FxFloat': 4, 'double': 8, 'long double': 10, 'float10': 10,
};

/** Ghidra's 3-byte integer types: a cast to one truncates to 24 bits. */
const THREE_BYTE_TYPES = new Set(['int3', 'uint3', 'undefined3']);

/** Canonical bases of the SIGNED integer types (everything else in INT_WIDTHS is unsigned). */
const SIGNED_BASES = new Set([
  'char', 'signed char', 'short', 'int', 'long', 'long long', '__int64', 'LONGLONG',
  'int3', 'int5', 'int6', 'int7', 'intptr_t', 'ssize_t', 'ptrdiff_t', 'HRESULT', 'LRESULT', 'LPARAM',
]);

function typeName(t: TypeNode): string | undefined {
  const n = (t as { name?: unknown }).name;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && typeof (n as Identifier).name === 'string') return (n as Identifier).name;
  return undefined;
}

function classOfShape(s: TypeShape | null): Operand {
  if (!s) return { kind: 'unknown', why: 'type not known' };
  if (s.stars > 0) return { kind: 'ptr' };
  const iw = INT_WIDTHS[s.base];
  if (iw !== undefined) return { kind: 'int', width: iw, signed: SIGNED_BASES.has(s.base) };
  const fw = FLOAT_WIDTHS[s.base];
  if (fw !== undefined) return { kind: 'float', width: fw };
  return { kind: 'unknown', why: `type ${s.base} is not a scalar this pass knows` };
}

/**
 * Signedness after integer promotion: anything narrower than int becomes a signed int.
 * Undefined when the operand's own signedness is not known.
 */
function promotedSigned(o: { width: number; signed?: boolean }): boolean | undefined {
  return o.width < 4 ? true : o.signed;
}

/**
 * Signedness of `l op r` under the usual arithmetic conversions, for operands of at most
 * 8 bytes: the wider type wins, and at equal width an unsigned operand makes it unsigned.
 */
function arithmeticSigned(l: { width: number; signed?: boolean }, r: { width: number; signed?: boolean }): boolean | undefined {
  const lw = Math.max(4, l.width), rw = Math.max(4, r.width);
  const ls = promotedSigned(l), rs = promotedSigned(r);
  if (lw !== rw) {
    const wide = lw > rw ? ls : rs;
    const narrow = lw > rw ? rs : ls;
    // A wider signed type holds every value of the narrower one, signed or not.
    if (wide === true) return narrow === undefined ? undefined : true;
    return wide;
  }
  if (ls === undefined || rs === undefined) return ls === false || rs === false ? false : undefined;
  return ls && rs;
}

const ARITH = new Set(['+', '-', '*', '/', '%', '&', '|', '^']);
const SHIFT = new Set(['<<', '>>']);
const COMPARE = new Set(['<', '>', '<=', '>=', '==', '!=', '&&', '||']);

// ============================================
// PURITY
// ============================================

/** Helpers this pass emits that read their argument and nothing else. */
const PURE_HELPERS = new Set(['d2_bit_cast', 'd2_load24']);

/** An expression that may be evaluated twice: no call, no assignment, no increment. */
export function isPure(e: ASTNode): boolean {
  switch (e.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
    case NodeKind.IntegerLiteral:
    case NodeKind.FloatingLiteral:
    case NodeKind.CharLiteral:
    case NodeKind.BoolLiteral:
    case NodeKind.NullptrLiteral:
    case NodeKind.StringLiteral:
    case NodeKind.ThisExpr:
    case NodeKind.SizeofExpr:
      return true;
    case NodeKind.ParenExpr:
      return isPure((e as ParenExpr).expression);
    case NodeKind.CStyleCastExpr:
      return isPure((e as CStyleCastExpr).expression);
    case NodeKind.MemberExpr:
      return isPure((e as unknown as { object: ASTNode }).object);
    case NodeKind.SubscriptExpr: {
      const s = e as unknown as { array: ASTNode; index: ASTNode };
      return isPure(s.array) && isPure(s.index);
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      return u.operator !== '++' && u.operator !== '--' && isPure(u.operand);
    }
    case NodeKind.BinaryExpr: {
      const b = e as BinaryExpr;
      return (b.operator as string) !== ',' && isPure(b.left) && isPure(b.right);
    }
    case NodeKind.ConditionalExpr: {
      const c = e as ConditionalExpr;
      return isPure(c.condition) && isPure(c.thenExpr) && isPure(c.elseExpr);
    }
    case NodeKind.CallExpr: {
      const c = e as CallExpr;
      const callee = c.callee as { kind: NodeKind; name?: unknown };
      const name = callee.kind === NodeKind.TemplateType ? typeName(callee as unknown as TypeNode) : undefined;
      return !!name && PURE_HELPERS.has(name) && c.arguments.every(isPure);
    }
    default:
      return false;
  }
}

// ============================================
// AST EQUALITY
// ============================================

const IGNORED_KEYS = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'raw']);

/** Same node shape and the same names and values, ignoring spelling and position. */
export function sameAst(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameAst(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // A parenthesis changes nothing about the value.
  if (ao.kind === NodeKind.ParenExpr) return sameAst(ao.expression, b);
  if (bo.kind === NodeKind.ParenExpr) return sameAst(a, bo.expression);
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (IGNORED_KEYS.has(k)) continue;
    if (!sameAst(ao[k], bo[k])) return false;
  }
  return true;
}

// ============================================
// TEMPLATES
// ============================================

const templateCache = new Map<string, Expression>();

/**
 * Parse `text` once as an expression and substitute the placeholders `__A`, `__B`, ... with
 * the given operand nodes (each parenthesised). The substitution is on the AST: the text is
 * only ever the lowering's own fixed form, never generated code.
 */
function fromTemplate(text: string, binds: Record<string, Expression>): Expression {
  let tpl = templateCache.get(text);
  if (!tpl) {
    const tu = parse(`void __t() { __r = ${text}; }`) as unknown as {
      declarations: Array<{ body: { statements: Array<{ expression: { right: Expression } }> } }>;
    };
    tpl = tu.declarations[0].body.statements[0].expression.right;
    templateCache.set(text, tpl);
  }
  const subst = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(subst);
    if (n === null || typeof n !== 'object') return n;
    const o = n as Record<string, unknown>;
    if (o.kind === NodeKind.Identifier && typeof o.name === 'string' && o.name in binds) {
      return Expr.paren(binds[o.name]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = k === 'location' ? v : subst(v);
    }
    return out;
  };
  return Expr.paren(subst(tpl) as Expression);
}

// ============================================
// LOWERING
// ============================================
/**
 * `(T)e`, without a second identical cast when e already is one. Value-preserving: a cast
 * to the type an expression already has is the identity.
 */
function castTo(T: string, e: Expression): Expression {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.CStyleCastExpr && typeName((x as CStyleCastExpr).type) === T) return e;
  return fromTemplate(`(${T})__A`, { __A: e });
}

/**
 * `(T)(e & mask)`, without a second identical mask when e already is `(T)(x & mask)` or
 * `x & mask` with the same mask. Value-preserving: masking twice with one mask is masking once.
 */
function maskTo(T: string, n: number, e: Expression): Expression {
  const lit = maskLiteral(n);
  let x = unwrapParens(e);
  if (x.kind === NodeKind.CStyleCastExpr && typeName((x as CStyleCastExpr).type) === T) x = unwrapParens((x as CStyleCastExpr).expression);
  if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '&') {
    const r = unwrapParens((x as BinaryExpr).right);
    if (r.kind === NodeKind.IntegerLiteral && (r as IntegerLiteralExpr).value === (1n << BigInt(n * 8)) - 1n) {
      return castTo(T, e);
    }
  }
  return fromTemplate(`(${T})(__A & ${lit})`, { __A: e });
}


class Unlowerable extends Error {
  constructor(readonly reason: string) { super(reason); }
}

interface Ctx {
  classify: (e: Expression) => Operand;
  /** Names the function itself declares: parameters and locals. */
  isLocal?: (name: string) => boolean;
  stackSlots?: ReadonlyArray<{ name: string; offset: number; size: number }>;
}

/** The FLAG and SIZE ops, and how many sizes each name carries. */
const TWO_SIZE_OPS = ['CONCAT', 'SUB', 'ZEXT', 'SEXT'] as const;
const ONE_SIZE_OPS = ['CARRY', 'SCARRY', 'SBORROW'] as const;

export function parseOpName(name: string):
  | { op: typeof TWO_SIZE_OPS[number]; n: number; m: number }
  | { op: typeof ONE_SIZE_OPS[number]; n: number }
  | null {
  // Anchored: the whole identifier is the op name followed by its digits.
  for (const op of ONE_SIZE_OPS) {
    if (name.startsWith(op)) {
      const digits = name.slice(op.length);
      if (!/^\d+$/.test(digits)) return null;
      const n = Number(digits);
      if (!VALID_SIZES.has(n)) throw new Error(`pseudo-op ${name}: size ${n} is not a varnode size`);
      return { op, n };
    }
  }
  for (const op of TWO_SIZE_OPS) {
    if (name.startsWith(op)) {
      const digits = name.slice(op.length);
      if (!/^\d+$/.test(digits)) return null;
      const [n, m] = splitSizes(digits);
      return { op, n, m };
    }
  }
  return null;
}

/** A cast to a 3-byte Ghidra type: the inner expression and whether it is `int3`. */
function threeByteCast(e: Expression): { inner: Expression; signed: boolean } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CStyleCastExpr) return null;
  const name = typeName((x as CStyleCastExpr).type);
  return name && THREE_BYTE_TYPES.has(name)
    ? { inner: (x as CStyleCastExpr).expression, signed: name === 'int3' }
    : null;
}

/**
 * `uintN_t` holding the n-byte bit pattern of `e`, readable for at least `need` bytes.
 * Floats are a bit pattern, pointers an address, integers themselves.
 */
function raw(ctx: Ctx, e: Expression, n: number, need: number): Expression {
  const U = uType(n);
  const mask3 = (x: Expression) => maskTo(U, 3, x);

  // Ghidra's own cast to a 24-bit type. From a wider value it keeps the low three bytes,
  // which the container cast and mask below say again; from a narrower one it is the
  // extension `int3` (sign) or `uint3`/`undefined3` (zero) names. Either way the cast
  // itself is not emitted: `int3` is a 4-byte typedef that would not truncate, and
  // `undefined3` a 1-byte one that would lose two bytes.
  const cast3 = n === 3 ? threeByteCast(e) : null;
  if (cast3) {
    const ic = ctx.classify(cast3.inner);
    if (ic.kind === 'int' && ic.width < 3) {
      const ext = cast3.signed
        ? fromTemplate(`(uint32_t)(int32_t)(${sType(ic.width)})__A`, { __A: cast3.inner })
        : castTo('uint32_t', castTo(uType(ic.width), cast3.inner));
      return mask3(ext);
    }
    e = cast3.inner;
  }

  const cls = ctx.classify(e);
  const spelled = () => emit(e as AnyNode).replace(/\s+/g, ' ').slice(0, 60);
  const masked = (x: Expression) => (isOddWidth(n) ? maskTo(U, n, x) : x);
  switch (cls.kind) {
    case 'unknown':
      throw new Unlowerable(`operand type unknown (${cls.why}): ${spelled()}`);
    case 'ptr':
      // A pointer is 4 bytes on the target; fewer may be read from it, never more.
      if (n > 4 || need > 4) throw new Unlowerable(`a pointer operand is 4 bytes, not ${n}`);
      return masked(fromTemplate(`(${U})(uintptr_t)__A`, { __A: e }));
    case 'int':
      if (cls.width < need) throw new Unlowerable(`operand is ${cls.width} bytes, the operation reads ${need}`);
      return masked(castTo(U, e));
    case 'float': {
      // `(float)E` of a 1- or 2-byte integer: the value and the bit reading of Ghidra's
      // cast agree for E < 2^24, so the integer itself is exact under both.
      const x = unwrapParens(e);
      if (x.kind === NodeKind.CStyleCastExpr) {
        const innerCls = ctx.classify((x as CStyleCastExpr).expression);
        if (innerCls.kind === 'int' && innerCls.width <= 2) {
          return fromTemplate(`(${U})__A`, { __A: (x as CStyleCastExpr).expression });
        }
      }
      // SUBPIECE and PIECE are bit-level: a float operand is its IEEE bit pattern, never
      // its value converted to an integer. `grGet` writes integer bits into the float
      // `fGammaVal`; converting that denormal gives 0 where the machine reads 0x0C.
      if (x.kind === NodeKind.FloatingLiteral && (n === 4 || n === 8)) {
        return fromTemplate(`d2_bit_cast<${U}>((${n === 4 ? 'float' : 'double'})__A)`, { __A: e });
      }
      if (cls.width !== n || (n !== 4 && n !== 8)) {
        throw new Unlowerable(`floating operand is ${cls.width} bytes, the varnode ${n}`);
      }
      return fromTemplate(`d2_bit_cast<${U}>(__A)`, { __A: e });
    }
  }
}

function lowerSub(ctx: Ctx, n: number, m: number, args: Expression[]): Expression {
  const [x, kExpr] = args;
  const k = unwrapParens(kExpr);
  if (k.kind !== NodeKind.IntegerLiteral) throw new Unlowerable('SUBPIECE offset is not a literal');
  const off = Number((k as IntegerLiteralExpr).value);
  if (m > n) {
    // Output wider than input is not a SUBPIECE. Ghidra printed a 1-byte bool extended
    // into a wider slot; the zero extension is the reading that matches.
    if (off !== 0) throw new Unlowerable(`SUB${n}${m} with offset ${off}`);
    return fromTemplate(`(${uType(m)})__A`, { __A: raw(ctx, x, n, n) });
  }
  if (off + m > n) throw new Unlowerable(`SUB${n}${m} offset ${off} reads past the operand`);
  const src = raw(ctx, x, n, off + m);
  const shifted = off === 0 ? src : fromTemplate(`__A >> ${off * 8}`, { __A: src });
  return isOddWidth(m) ? maskTo(uType(m), m, shifted) : castTo(uType(m), shifted);
}

function lowerConcat(ctx: Ctx, n: number, m: number, args: Expression[]): Expression {
  const [hi, lo] = args;
  const T = uType(n + m);
  const h = raw(ctx, hi, n, n);
  const l = raw(ctx, lo, m, m);
  const joined = fromTemplate(`(${T})(__A << ${m * 8} | __B)`, { __A: castTo(T, h), __B: castTo(T, l) });
  return isOddWidth(n + m) ? maskTo(T, n + m, joined) : joined;
}

/**
 * `x = CONCATnm(hi, lo)` where `x` holds at most m bytes: the assignment keeps the low m
 * bytes, which are `lo`'s, so `hi` never reaches a value. Ghidra prints this where the
 * binary stores n+m bytes over a narrower variable and its neighbour, writing the
 * neighbour's own bytes back (`OOGMENU_CreateGame`: a 4-byte store over the `ushort`
 * request id, `hi` the next global's two bytes). Single-threaded the neighbour is
 * unchanged either way, so the lowering is `lo` at m bytes; `hi` must be pure, so dropping
 * it drops no side effect. Any other shape returns null and takes the full lowering.
 */
function lowerDeadHighConcat(ctx: Ctx, target: Expression, value: Expression): Expression | null {
  const call = unwrapParens(value);
  if (call.kind !== NodeKind.CallExpr) return null;
  const callee = (call as CallExpr).callee;
  if (callee.kind !== NodeKind.Identifier) return null;
  const parsed = parseOpName((callee as Identifier).name);
  if (!parsed || parsed.op !== 'CONCAT' || (call as CallExpr).arguments.length !== 2) return null;
  const [hi, lo] = (call as CallExpr).arguments;
  const t = unwrapParens(target);
  // The neighbour's bytes are its OWN value written back only for the global case this
  // rule was made from. Over a LOCAL, `hi` is a value the function stores into the next
  // frame slot (UNICODE_BinarySearchKamap 00527b00: `_searchKey = CONCAT22(wChar, wMapChar)`
  // builds a 4-byte bsearch key) - see lowerLocalSlotConcat.
  if (t.kind === NodeKind.Identifier && /^_[A-Za-z]/.test((t as Identifier).name)
    && ctx.isLocal?.((t as Identifier).name.slice(1))) return null;
  let dest = ctx.classify(target);
  // `_X` over the global `X` is Ghidra's name for the same storage accessed wider (here the
  // 4-byte store over the 2-byte id); underscore-storage-alias binds it to `X` later, so
  // what the assignment stores into is `X`'s type.
  if (dest.kind === 'unknown' && t.kind === NodeKind.Identifier && /^_[A-Za-z]/.test((t as Identifier).name)) {
    dest = ctx.classify(Expr.identifier((t as Identifier).name.slice(1)));
  }
  if (dest.kind !== 'int' || dest.width > parsed.m || !isPure(hi)) return null;
  const l = raw(ctx, lo, parsed.m, parsed.m);
  return isOddWidth(parsed.m) ? l : castTo(uType(parsed.m), l);
}

/**
 * `_X = CONCATnm(hi, lo)` over a LOCAL `X`: one n+m-byte store across two frame slots.
 *
 * Ghidra names the wide access `_X` and keeps one variable per slot. When `X` is exactly
 * the low m bytes and the frame has a slot `Y` that is exactly the next n bytes, the
 * store is `X = lo, Y = hi` - every byte the machine writes, into the slot that holds it,
 * and nothing outside the two. UNICODE_BinarySearchKamap's key is
 * `searchKey = wMapChar, wSearchHi = wChar`. Any other layout returns null.
 */
function lowerLocalSlotConcat(ctx: Ctx, target: Expression, value: Expression): Expression | null {
  const t = unwrapParens(target);
  if (t.kind !== NodeKind.Identifier) return null;
  const alias = (t as Identifier).name;
  if (!/^_[A-Za-z]/.test(alias) || ctx.isLocal?.(alias) || !ctx.isLocal?.(alias.slice(1))) return null;
  const call = unwrapParens(value);
  if (call.kind !== NodeKind.CallExpr) return null;
  const callee = (call as CallExpr).callee;
  if (callee.kind !== NodeKind.Identifier) return null;
  const parsed = parseOpName((callee as Identifier).name);
  if (!parsed || parsed.op !== 'CONCAT' || (call as CallExpr).arguments.length !== 2) return null;
  if (isOddWidth(parsed.n) || isOddWidth(parsed.m)) return null;
  const slots = ctx.stackSlots ?? [];
  const x = slots.find(s => s.name === alias.slice(1));
  if (!x || x.size !== parsed.m) return null;
  const y = slots.filter(s => s.offset === x.offset + parsed.m && s.size === parsed.n);
  if (y.length !== 1 || !ctx.isLocal?.(y[0].name)) return null;
  const [hi, lo] = (call as CallExpr).arguments;
  const store = (name: string, n: number, e: Expression): Expression => ({
    kind: NodeKind.AssignExpr, operator: '=', left: Expr.identifier(name), right: castTo(uType(n), e),
    location: value.location, leadingTrivia: [], trailingTrivia: [],
  } as unknown as Expression);
  return {
    kind: NodeKind.CommaExpr,
    expressions: [store(x.name, parsed.m, lo), store(y[0].name, parsed.n, hi)],
    location: value.location, leadingTrivia: [], trailingTrivia: [],
  } as unknown as Expression;
}

function lowerExt(ctx: Ctx, signed: boolean, n: number, m: number, args: Expression[]): Expression {
  if (m < n) throw new Unlowerable(`extension from ${n} to ${m} bytes narrows`);
  const src = raw(ctx, args[0], n, n);
  if (!signed) return castTo(uType(m), src);
  if (n === 3) {
    // 24-bit sign extension: the sign bit moved to bit 31 and shifted back arithmetically.
    return fromTemplate(`(${sType(m)})((int32_t)((uint32_t)__A << 8) >> 8)`, { __A: src });
  }
  if (isOddWidth(n)) throw new Unlowerable(`sign extension from ${n} bytes`);
  return fromTemplate(`(${sType(m)})(${sType(n)})__A`, { __A: src });
}

function lowerFlag(ctx: Ctx, op: 'CARRY' | 'SCARRY' | 'SBORROW', n: number, args: Expression[]): Expression {
  if (isOddWidth(n) || n > 8) throw new Unlowerable(`${op}${n}: no ${n}-byte arithmetic`);
  for (const a of args) {
    if (!isPure(a)) throw new Unlowerable(`${op}${n} names an operand with a side effect twice`);
  }
  // a - a never overflows: SBORROWn(a, a) is false whatever a is (CMP r, r; JL in
  // NPCMENU_ConfigureMenuOption 004b64b6, where the compiler folded both operands to ESI).
  if (op === 'SBORROW' && sameAst(args[0], args[1])) return Expr.boolLiteral(false);
  const U = uType(n);
  const S = sType(n);
  const a = raw(ctx, args[0], n, n);
  const b = raw(ctx, args[1], n, n);
  switch (op) {
    case 'CARRY':
      return fromTemplate(`(${U})(__A + __B) < __A`, { __A: a, __B: b });
    case 'SBORROW':
      return fromTemplate(`(${S})((__A ^ __B) & (__A ^ (${U})(__A - __B))) < 0`, { __A: a, __B: b });
    case 'SCARRY':
      return fromTemplate(`(${S})(~(__A ^ __B) & (__A ^ (${U})(__A + __B))) < 0`, { __A: a, __B: b });
  }
}

// ============================================
// SBORROW FOLD
// ============================================

/** `SBORROWn(a, b)`: its n and operands, else null. */
function sborrowCall(e: Expression): { n: number; a: Expression; b: Expression } | null {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CallExpr) return null;
  const c = x as CallExpr;
  if (c.callee.kind !== NodeKind.Identifier) return null;
  const name = (c.callee as Identifier).name;
  if (!name.startsWith('SBORROW') || c.arguments.length !== 2) return null;
  const digits = name.slice('SBORROW'.length);
  if (!/^\d$/.test(digits)) return null;
  return { n: Number(digits), a: c.arguments[0], b: c.arguments[1] };
}

/** Strip parentheses and casts to a signed n-byte type: the operand the sign test reads. */
function stripSignedCast(e: Expression, n: number, ctx: Ctx): Expression | null {
  let x = unwrapParens(e);
  if (x.kind === NodeKind.CStyleCastExpr) {
    const cls = ctx.classify(x);
    if (cls.kind !== 'int' || cls.width !== n) return null;
    x = unwrapParens((x as CStyleCastExpr).expression);
  }
  return x;
}

/**
 * Is `e` the sign test of `a - b` at width n: `(intN)(a - b) < 0`, `a - b < 0`, or with b
 * the literal c, `a + -c < 0`? Operands must be the SAME AST as the SBORROW's.
 */
function isSignOfDifference(e: Expression, n: number, a: Expression, b: Expression, ctx: Ctx): boolean {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.BinaryExpr) return false;
  const cmp = x as BinaryExpr;
  if (cmp.operator !== '<') return false;
  const zero = unwrapParens(cmp.right);
  if (zero.kind !== NodeKind.IntegerLiteral || (zero as IntegerLiteralExpr).value !== 0n) return false;
  // The difference must be evaluated at width n: either cast to the signed n-byte type,
  // or both operands already are that type (n = 4 and int arithmetic).
  const lhs = unwrapParens(cmp.left);
  let diff: Expression | null;
  if (lhs.kind === NodeKind.CStyleCastExpr) {
    diff = stripSignedCast(lhs, n, ctx);
  } else {
    if (n !== 4) return false;
    const ca = ctx.classify(a);
    const cb = ctx.classify(b);
    if (ca.kind !== 'int' || cb.kind !== 'int' || ca.width !== 4 || cb.width !== 4) return false;
    diff = lhs;
  }
  if (!diff || diff.kind !== NodeKind.BinaryExpr) return false;
  const d = diff as BinaryExpr;
  if (d.operator === '-') return sameAst(d.left, a) && sameAst(d.right, b);
  if (d.operator === '+') {
    // a + -c with b == c, a literal.
    const r = unwrapParens(d.right);
    const bl = unwrapParens(b);
    if (bl.kind !== NodeKind.IntegerLiteral) return false;
    let negated: bigint | null = null;
    if (r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '-') {
      const v = unwrapParens((r as UnaryExpr).operand);
      if (v.kind === NodeKind.IntegerLiteral) negated = -(v as IntegerLiteralExpr).value;
    } else if (r.kind === NodeKind.IntegerLiteral) {
      negated = (r as IntegerLiteralExpr).value;
    }
    return negated !== null && negated === -(bl as IntegerLiteralExpr).value && sameAst(d.left, a);
  }
  return false;
}

/**
 * `SBORROWn(a,b) != N` is the x86 `jl` condition with N the sign of a - b; it is exactly
 * `(intN)a < (intN)b`. `==` is `jge`. With `a == b ||` in front it is `jle`, and with
 * `a != b &&` it is `jg`. These are the definitions of the signed conditions.
 */
function foldSborrow(e: BinaryExpr, ctx: Ctx): Expression | null {
  const tryCompare = (cmp: Expression): { lt: boolean; n: number; a: Expression; b: Expression } | null => {
    const x = unwrapParens(cmp);
    if (x.kind !== NodeKind.BinaryExpr) return null;
    const be = x as BinaryExpr;
    if (be.operator !== '!=' && be.operator !== '==') return null;
    for (const [s, other] of [[be.left, be.right], [be.right, be.left]] as const) {
      const sb = sborrowCall(s);
      if (!sb) continue;
      if (!isPure(sb.a) || !isPure(sb.b)) return null;
      if (isSignOfDifference(other, sb.n, sb.a, sb.b, ctx)) {
        return { lt: be.operator === '!=', n: sb.n, a: sb.a, b: sb.b };
      }
    }
    return null;
  };
  const signedOperand = (x: Expression, n: number) => {
    const cls = ctx.classify(x);
    if (cls.kind === 'int' && cls.width === n) {
      return fromTemplate(`(${sType(n)})__A`, { __A: x });
    }
    if (cls.kind === 'unknown' || cls.kind === 'float') return null;
    return fromTemplate(`(${sType(n)})__A`, { __A: raw(ctx, x, n, n) });
  };
  const build = (op: '<' | '>=' | '<=' | '>', n: number, a: Expression, b: Expression): Expression | null => {
    const sa = signedOperand(a, n);
    const sb = signedOperand(b, n);
    if (!sa || !sb) return null;
    return Expr.paren(Expr.binary(sa, op, sb));
  };

  if (e.operator === '!=' || e.operator === '==') {
    const r = tryCompare(e);
    return r ? build(r.lt ? '<' : '>=', r.n, r.a, r.b) : null;
  }
  if (e.operator === '||' || e.operator === '&&') {
    const eqOp = e.operator === '||' ? '==' : '!=';
    const wantLt = e.operator === '||';
    for (const [eqSide, cmpSide] of [[e.left, e.right], [e.right, e.left]] as const) {
      const r = tryCompare(cmpSide);
      if (!r || r.lt !== wantLt) continue;
      const eq = unwrapParens(eqSide);
      if (eq.kind !== NodeKind.BinaryExpr || (eq as BinaryExpr).operator !== eqOp) continue;
      const eb = eq as BinaryExpr;
      const matches = (sameAst(eb.left, r.a) && sameAst(eb.right, r.b))
        || (sameAst(eb.left, r.b) && sameAst(eb.right, r.a));
      if (!matches) continue;
      return build(wantLt ? '<=' : '>', r.n, r.a, r.b);
    }
  }
  return null;
}

// ============================================
// TRANSFORMER
// ============================================

function lowerCall(ctx: Ctx, name: string, args: Expression[]): Expression | null {
  const parsed = parseOpName(name);
  if (!parsed) return null;
  const want = parsed.op === 'ZEXT' || parsed.op === 'SEXT' ? 1 : 2;
  if (args.length !== want) throw new Unlowerable(`${name} with ${args.length} arguments`);
  switch (parsed.op) {
    case 'SUB': return lowerSub(ctx, parsed.n, parsed.m, args);
    case 'CONCAT': return lowerConcat(ctx, parsed.n, parsed.m, args);
    case 'ZEXT': return lowerExt(ctx, false, parsed.n, parsed.m, args);
    case 'SEXT': return lowerExt(ctx, true, parsed.n, parsed.m, args);
    case 'CARRY':
    case 'SCARRY':
    case 'SBORROW':
      return lowerFlag(ctx, parsed.op, parsed.n, args);
  }
}

/** Ghidra spelling -> the spelling d2_platform.h declares. */
const RENAMES: Record<string, string> = {
  NAN: 'D2_IsNaN',
};

/**
 * Floating pseudo-ops with a standard spelling that computes the same thing.
 *
 * ROUND is FLOAT_ROUND: FRNDINT, and the rounding half of FIST/FISTP. Both round in
 * the x87 control word's mode, nearest-even unless changed, and the game never changes
 * it (`_ftol` saves and restores it). `round()` rounds half away from zero: ROUND(2.5)
 * is 2 on the machine and was 3 here. `std::nearbyint` uses the current mode.
 * Integer ABS does not exist in p-code, so ABS is always the float operation.
 */
const STD_SPELLINGS: Record<string, string[]> = {
  ROUND: ['std', 'nearbyint'],
  // ABS is FLOAT_ABS (FABS): it clears the sign bit, so ABS(-0.0) is +0.0 and a
  // negative NaN loses its sign. `x < 0 ? -x : x` kept both signs.
  ABS: ['std', 'fabs'],
};

/**
 * Constants whose value is not in the decompiler's text, so no lowering can be exact:
 *
 *   NAN / -NAN       Ghidra prints EVERY NaN bit pattern this way, by sign alone.
 *                    C++'s NAN is 0x7FC00000; the Glide debug-font ARGB colour Ghidra
 *                    printed as -NAN is almost certainly 0xFFFFFFFF.
 *   FLOAT_UNKNOWN    an immediate Ghidra could not type.
 *   halt_baddata()   data decoded as code.
 *
 * They are left as written (the header still defines them) and reported; strict mode
 * makes each a hard error. The fix is a retype in Ghidra, after which the constant
 * prints as the integer it is. `INFINITY` has one bit pattern per sign and is exact.
 */
function reportValuelessConstants(body: ASTNode, report: (r: ArtifactRecord) => void): void {
  const walk = (n: unknown, isCallee: boolean, negated: boolean): void => {
    if (Array.isArray(n)) { for (const x of n) walk(x, false, false); return; }
    if (n === null || typeof n !== 'object') return;
    const node = n as Record<string, unknown> & { kind?: NodeKind };
    if (node.kind === NodeKind.Identifier) {
      const name = node.name as string;
      if (name === 'NAN' && !isCallee) {
        report({ op: negated ? '-NAN' : 'NAN', reason: 'NaN constant: Ghidra prints every NaN bit pattern this way; retype the variable in Ghidra' });
      } else if (name === 'FLOAT_UNKNOWN') {
        report({ op: name, reason: 'immediate Ghidra could not type; the value is not in the decompiler output' });
      } else if (name === 'halt_baddata' && isCallee) {
        report({ op: name, reason: 'data decoded as code' });
      }
      return;
    }
    if (node.kind === NodeKind.CallExpr) {
      walk(node.callee, true, false);
      walk(node.arguments, false, false);
      return;
    }
    if (node.kind === NodeKind.UnaryExpr && node.operator === '-') {
      walk(node.operand, false, true);
      return;
    }
    if (node.kind === NodeKind.ParenExpr) { walk(node.expression, false, negated); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (v && typeof v === 'object') walk(v, false, false);
    }
  };
  walk(body, false, false);
}

// ============================================
// INTRINSIC-LIKE OPS
// ============================================

/** Ghidra's builtin_* with the libc function that does exactly the same. */
const BUILTIN_SPELLINGS: Record<string, string> = {
  builtin_memcpy: 'memcpy',
  builtin_memset: 'memset',
  builtin_strcmp: 'strcmp',
  builtin_strlen: 'strlen',
  builtin_strcpy: 'strcpy',
};

/**
 * `builtin_strncpy(d, "lit", n)` is Ghidra's name for an n-byte store of a constant, not
 * strncpy: strncpy stops at an embedded NUL and zero-fills, the store copies every byte.
 * memcpy is the store, provided the literal has n bytes to give (its NUL included).
 */
function lowerBuiltinStrncpy(args: Expression[]): Expression {
  if (args.length !== 3) throw new Unlowerable(`builtin_strncpy with ${args.length} arguments`);
  const lit = unwrapParens(args[1]);
  const n = unwrapParens(args[2]);
  if (lit.kind !== NodeKind.StringLiteral) throw new Unlowerable('builtin_strncpy source is not a string literal');
  if (n.kind !== NodeKind.IntegerLiteral) throw new Unlowerable('builtin_strncpy length is not a literal');
  const value = (lit as unknown as { value: string; prefix?: string }).value;
  if ((lit as unknown as { prefix?: string }).prefix) throw new Unlowerable('builtin_strncpy of a wide literal');
  if ([...value].some(ch => ch.charCodeAt(0) > 0xff)) throw new Unlowerable('builtin_strncpy literal is not a byte string');
  const size = BigInt(value.length + 1);
  if ((n as IntegerLiteralExpr).value > size) {
    throw new Unlowerable(`builtin_strncpy copies ${(n as IntegerLiteralExpr).value} bytes from a ${size}-byte literal`);
  }
  return Expr.call('memcpy', args);
}

/**
 * ZPULL/SPULL(x, pos, bits): `bits` bits of x from bit `pos` (counted from the least
 * significant), zero- or sign-extended. Both counts must be literals.
 */
function lowerPull(ctx: Ctx, signed: boolean, args: Expression[]): Expression {
  if (args.length !== 3) throw new Unlowerable(`PULL with ${args.length} arguments`);
  const [x, pe, ne] = args.map(a => unwrapParens(a));
  if (pe.kind !== NodeKind.IntegerLiteral || ne.kind !== NodeKind.IntegerLiteral) throw new Unlowerable('PULL position or width is not a literal');
  const pos = Number((pe as IntegerLiteralExpr).value);
  const bits = Number((ne as IntegerLiteralExpr).value);
  const cls = ctx.classify(args[0]);
  const w = cls.kind === 'int' ? (cls.width <= 4 ? 4 : 8) : cls.kind === 'ptr' ? 4 : 0;
  if (w === 0) throw new Unlowerable(`PULL operand ${cls.kind === 'unknown' ? `type unknown (${cls.why})` : 'is floating'}`);
  if (bits < 1 || pos < 0 || pos + bits > w * 8 || bits > 32) throw new Unlowerable(`PULL of bits [${pos}, ${pos + bits}) from ${w} bytes`);
  const src = raw(ctx, args[0], w, Math.ceil((pos + bits) / 8));
  if (!signed) {
    const mask = `0x${((1n << BigInt(bits)) - 1n).toString(16)}u`;
    return fromTemplate(`(uint32_t)(__A >> ${pos} & ${mask})`, { __A: src });
  }
  const S = sType(w);
  return fromTemplate(`(int32_t)((${S})(__A << ${w * 8 - pos - bits}) >> ${w * 8 - bits})`, { __A: src });
}

const isCallTo = (e: ASTNode | undefined, name: string, argc?: number): e is CallExpr => {
  if (!e || e.kind !== NodeKind.CallExpr) return false;
  const c = e as CallExpr;
  return c.callee.kind === NodeKind.Identifier && (c.callee as Identifier).name === name
    && (argc === undefined || c.arguments.length === argc);
};

const exprOf = (st: ASTNode | undefined): Expression | undefined =>
  st && st.kind === NodeKind.ExprStmt ? (st as unknown as { expression: Expression }).expression : undefined;

/** `target = value` as a plain assignment statement. */
function assignOf(st: ASTNode | undefined): { left: Expression; right: Expression } | null {
  const e = exprOf(st);
  if (!e || e.kind !== NodeKind.AssignExpr) return null;
  const a = e as unknown as { operator: string; left: Expression; right: Expression };
  return a.operator === '=' ? { left: a.left, right: a.right } : null;
}

/** Does `e` mention the identifier `name` anywhere? */
function mentions(e: unknown, name: string): boolean {
  if (Array.isArray(e)) return e.some(x => mentions(x, name));
  if (e === null || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.Identifier && o.name === name) return true;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object' && mentions(v, name)) return true;
  }
  return false;
}

const stmt = (expression: Expression): ASTNode =>
  ({ kind: NodeKind.ExprStmt, expression, location: expression.location, leadingTrivia: [], trailingTrivia: [] }) as unknown as ASTNode;

/**
 * `LOCK(); T = *P; [B =] X == T; if (B) { *P = N; ... } else { ... } UNLOCK();` is
 * CMPXCHG8B: compare EDX:EAX (X) with *P and store ECX:EBX (N) if equal, else load *P.
 * T holds the old *P afterwards on both paths. That is __atomic_compare_exchange_n with
 * T as the expected value, which also leaves the old value in T when it fails:
 *
 *   T = X; [B =] __atomic_compare_exchange_n(P, &T, N, false, SEQ_CST, SEQ_CST);
 *   if (B) { ... } else { ... }
 *
 * Without the builtin the rebuild's region is not atomic at all (LOCK was empty).
 * Returns the replacement statements for [lockIndex, unlockIndex], or null.
 */
function lowerLockRegion(region: ASTNode[]): ASTNode[] | null {
  // region = LOCK(), S1, (S2), IF, UNLOCK()
  if (region.length !== 4 && region.length !== 5) return null;
  const load = assignOf(region[1]);
  if (!load) return null;
  const T = unwrapParens(load.left);
  const deref = unwrapParens(load.right);
  if (T.kind !== NodeKind.Identifier || deref.kind !== NodeKind.UnaryExpr || (deref as UnaryExpr).operator !== '*') return null;
  const tName = (T as Identifier).name;
  const P = (deref as UnaryExpr).operand;
  if (!isPure(P) || mentions(P, tName)) return null;

  let flag: Expression | null = null;
  let cmp: Expression;
  const ifSt = region[region.length - 2] as unknown as { kind: NodeKind; condition: Expression; thenBranch: ASTNode; elseBranch: ASTNode | null };
  if (ifSt.kind !== NodeKind.IfStmt) return null;
  if (region.length === 5) {
    const f = assignOf(region[2]);
    if (!f) return null;
    flag = f.left;
    cmp = f.right;
    if (!sameAst(ifSt.condition, flag)) return null;
  } else {
    cmp = ifSt.condition;
  }
  const c = unwrapParens(cmp);
  if (c.kind !== NodeKind.BinaryExpr || (c as BinaryExpr).operator !== '==') return null;
  const cb = c as BinaryExpr;
  const X = sameAst(cb.right, T) ? cb.left : sameAst(cb.left, T) ? cb.right : null;
  if (!X || !isPure(X) || mentions(X, tName)) return null;

  const thenBody = ifSt.thenBranch.kind === NodeKind.CompoundStmt
    ? (ifSt.thenBranch as unknown as { statements: ASTNode[] }).statements
    : [ifSt.thenBranch];
  const store = assignOf(thenBody[0]);
  if (!store) return null;
  const sl = unwrapParens(store.left);
  if (sl.kind !== NodeKind.UnaryExpr || (sl as UnaryExpr).operator !== '*' || !sameAst((sl as UnaryExpr).operand, P)) return null;
  const N = store.right;
  if (!isPure(N) || mentions(N, tName)) return null;

  const cas = fromTemplate('__atomic_compare_exchange_n(__P, &__T, __N, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST)',
    { __P: P, __T: T, __N: N });
  const restThen = { ...(ifSt.thenBranch.kind === NodeKind.CompoundStmt ? ifSt.thenBranch : {
    kind: NodeKind.CompoundStmt, location: ifSt.thenBranch.location, leadingTrivia: [], trailingTrivia: [] }),
    statements: thenBody.slice(1) } as unknown as ASTNode;
  const out: ASTNode[] = [stmt(Expr.assign(T, X))];
  if (flag) {
    out.push(stmt(Expr.assign(flag, cas)));
    out.push({ ...ifSt, thenBranch: restThen } as unknown as ASTNode);
  } else {
    out.push({ ...ifSt, condition: cas, thenBranch: restThen } as unknown as ASTNode);
  }
  return out;
}

/**
 * Statement-level pseudo-ops: the LOCK/UNLOCK region, and `v = (code *)swi(3); (*v)();`,
 * which is INT3. `__debugbreak` is INT3; `__builtin_trap` would be UD2, the wrong
 * instruction. Returns the new statement list, or null when nothing matched; `swiTemps`
 * collects the temporaries whose declaration may now be unused.
 */
function lowerStatements(stmts: ASTNode[], report: (r: ArtifactRecord) => void, swiTemps: Set<string>): ASTNode[] | null {
  let changed = false;
  const out: ASTNode[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    if (isCallTo(exprOf(st), 'LOCK', 0)) {
      const end = stmts.findIndex((x, k) => k > i && isCallTo(exprOf(x), 'UNLOCK', 0));
      const lowered = end > i ? lowerLockRegion(stmts.slice(i, end + 1)) : null;
      if (lowered) {
        out.push(...lowered);
        i = end;
        changed = true;
        continue;
      }
      report({ op: 'LOCK', reason: 'the locked region is not the compare-exchange shape' });
    }
    const a = assignOf(st);
    const castCall = a ? unwrapParens(a.right) : undefined;
    const swiCall = castCall?.kind === NodeKind.CStyleCastExpr ? unwrapParens((castCall as CStyleCastExpr).expression) : castCall;
    if (a && unwrapParens(a.left).kind === NodeKind.Identifier && isCallTo(swiCall, 'swi', 1)) {
      const v = (unwrapParens(a.left) as Identifier).name;
      const vec = unwrapParens((swiCall as CallExpr).arguments[0]);
      const next = exprOf(stmts[i + 1]);
      let callee = next?.kind === NodeKind.CallExpr && (next as CallExpr).arguments.length === 0
        ? unwrapParens((next as CallExpr).callee) : undefined;
      if (callee?.kind === NodeKind.UnaryExpr && (callee as UnaryExpr).operator === '*') callee = unwrapParens((callee as UnaryExpr).operand);
      if (vec.kind === NodeKind.IntegerLiteral && (vec as IntegerLiteralExpr).value === 3n
          && callee?.kind === NodeKind.Identifier && (callee as Identifier).name === v) {
        out.push({ ...stmt(Expr.call('__debugbreak', [])), leadingTrivia: (st as ASTNode).leadingTrivia ?? [] } as ASTNode);
        swiTemps.add(v);
        i++;
        changed = true;
        continue;
      }
      report({ op: 'swi', reason: 'software interrupt other than INT3 followed by its call' });
    }
    out.push(st);
  }
  return changed ? out : null;
}

/** Occurrences of the identifier `name` in `e` as a value: declarations' own names excluded. */
function refCount(e: unknown, name: string): number {
  if (Array.isArray(e)) return e.reduce((n: number, x) => n + refCount(x, name), 0);
  if (e === null || typeof e !== 'object') return 0;
  const o = e as Record<string, unknown>;
  if (o.kind === NodeKind.VariableDecl) return o.initializer ? refCount(o.initializer, name) : 0;
  if (o.kind === NodeKind.MemberExpr) return refCount(o.object, name);
  let n = o.kind === NodeKind.Identifier && o.name === name ? 1 : 0;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    if (v && typeof v === 'object') n += refCount(v, name);
  }
  return n;
}

/** Register inputs the decompiler names but no instruction in the function defines. */
const REGISTER_INPUT = /^(in_[A-Z][A-Z0-9_]*|in_register_[0-9a-f]+)$/;

/**
 * A register input that reaches only bytes of a frame slot nothing reads as a value.
 *
 * MSVC reserves a 4-byte frame slot with `PUSH ECX`. The bytes the function never writes
 * keep whatever the caller left in ECX, and when the slot's address escapes (to a send or
 * a copy) the decompiler keeps the PUSH as a store of a register nothing defined:
 * `aPacketFrame._0_3_ = in_ECX`, `CONCAT31(in_register_00000005, nOpcode)` (CL a real
 * parameter, the upper bytes junk), `_aPacket = CONCAT22((short)(in_ECX >> 16), 0xaf)`,
 * `dwScratch = in_ECX` before `&dwScratch + 3` goes to a callee. Those bytes are
 * indeterminate in the binary: the program never defines them, so any value is one the
 * machine could have held, and none of them is a value the function computes.
 *
 * The register is replaced by 0 when every use of it is in the value stored to a local
 * that is a frame object (an array, or a local whose address is taken) - those bytes are
 * then zero instead of the caller's leftovers, and every byte the function itself defines
 * is stored unchanged. A store to a local nothing ever reads (`byHighByte = in_reg >> 16`)
 * is dropped. A register input used anywhere else is a value Ghidra lost and stays loud.
 */
function retireIndeterminateRegisters(body: ASTNode, dropped: Set<string>): ASTNode {
  const decls = new Map<string, VariableDecl>();
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    decls.set(v.name.name, v);
  }
  const registers = [...decls.values()]
    .filter(v => REGISTER_INPUT.test(v.name.name) && !v.initializer)
    .map(v => v.name.name);
  if (registers.length === 0) return body;

  const addressTaken = new Set<string>();
  for (const u of findNodesByKind(body, NodeKind.UnaryExpr)) {
    const x = unwrapParens((u as UnaryExpr).operand);
    if ((u as UnaryExpr).operator === '&' && x.kind === NodeKind.Identifier) addressTaken.add((x as Identifier).name);
  }
  /**
   * The local a store target names: `X`, `X._N_M_`, `X[i]` for an array `X`, or the
   * decompiler's `_X` alias of a local `X`. The element form is UNICODE_BinarySearchKamap's
   * (v1105): `aSearchKey[0] = in_CX`, the PUSH ECX half its comparator never reads.
   */
  const targetLocal = (t: Expression): string | null => {
    let x = unwrapParens(t);
    if (x.kind === NodeKind.SubscriptExpr) {
      const arr = unwrapParens((x as unknown as { array: Expression }).array);
      if (arr.kind !== NodeKind.Identifier) return null;
      const n = (arr as Identifier).name;
      return decls.get(n)?.type.kind === NodeKind.ArrayType ? n : null;
    }
    if (x.kind === NodeKind.MemberExpr) {
      const m = x as unknown as MemberExpr;
      const mn = (m.member as Identifier).name;
      if (m.isArrow || typeof mn !== 'string' || !/^_\d+_\d+_$/.test(mn)) return null;
      x = unwrapParens(m.object);
    }
    if (x.kind !== NodeKind.Identifier) return null;
    const name = (x as Identifier).name;
    if (decls.has(name)) return name;
    return name.startsWith('_') && decls.has(name.slice(1)) ? name.slice(1) : null;
  };
  const frameObject = (n: string) =>
    decls.get(n)!.type.kind === NodeKind.ArrayType || addressTaken.has(n) || addressTaken.has(`_${n}`);
  /** Every reference to `n` (and its `_n` alias) is as the target of a plain store. */
  const neverRead = (n: string, stores: Array<{ local: string }>) =>
    refCount(body, n) + refCount(body, `_${n}`) === stores.filter(st => st.local === n).length;

  const stores: Array<{ local: string; right: Expression }> = [];
  for (const st of findNodesByKind(body, NodeKind.ExprStmt)) {
    const a = assignOf(st);
    const local = a ? targetLocal(a.left) : null;
    if (a && local) stores.push({ local, right: a.right });
  }

  const zeroed = new Set<string>();
  const deadLocals = new Set<string>();
  for (const r of registers) {
    const total = refCount(body, r);
    if (total === 0) continue;
    const reaching = stores.filter(st => refCount(st.right, r) > 0);
    if (reaching.reduce((n, st) => n + refCount(st.right, r), 0) !== total) continue;
    // A dead store is dropped whole, so its value must have no side effect to keep.
    if (!reaching.every(st => frameObject(st.local) || (neverRead(st.local, stores) && isPure(st.right)))) continue;
    for (const st of reaching) {
      if (!frameObject(st.local) && neverRead(st.local, stores)) {
        deadLocals.add(st.local);
        dropped.add(st.local);
      }
    }
    zeroed.add(r);
    dropped.add(r);
  }
  if (zeroed.size === 0) return body;

  const withoutDead = deadLocals.size === 0 ? body : createTransformer({
    visitCompoundStmt(node) {
      // Matched by shape, not identity: the walk rebuilds nodes it passes through.
      const kept = (node.statements as ASTNode[]).filter(st => {
        const a = assignOf(st);
        const local = a ? targetLocal(a.left) : null;
        return !(a && local && deadLocals.has(local) && [...zeroed].some(r => refCount(a.right, r) > 0));
      });
      return kept.length === node.statements.length ? undefined : ({ ...node, statements: kept } as ASTNode);
    },
  })(body);
  // Only inside the stored values: the declaration keeps its name, for dropUnusedDecls.
  const zero = createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.Identifier || !zeroed.has((node as Identifier).name)) return undefined;
      return { ...Expr.intLiteral(0), leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as ASTNode;
    },
  });
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.ExprStmt) return undefined;
      const e = exprOf(node) as unknown as { operator: string; right: Expression } | undefined;
      if (!assignOf(node) || ![...zeroed].some(r => refCount(e!.right, r) > 0)) return undefined;
      const assign = exprOf(node)!;
      return { ...node, expression: { ...assign, right: zero(e!.right as ASTNode) } } as unknown as ASTNode;
    },
  })(withoutDead);
}

/** Drop the declaration of a temporary (or an in_stack_ slot) nothing refers to. */
function dropUnusedDecls(body: ASTNode, names: Set<string>): ASTNode {
  if (names.size === 0) return body;
  const unused = [...names].filter(n => {
    let refs = 0;
    const count = (e: unknown): void => {
      if (Array.isArray(e)) { e.forEach(count); return; }
      if (e === null || typeof e !== 'object') return;
      const o = e as Record<string, unknown>;
      if (o.kind === NodeKind.VariableDecl) { if (o.initializer) count(o.initializer); return; }
      if (o.kind === NodeKind.Identifier && o.name === n) refs++;
      for (const [k, v] of Object.entries(o)) if (k !== 'location' && v && typeof v === 'object') count(v);
    };
    count(body);
    return refs === 0;
  });
  if (unused.length === 0) return body;
  return createTransformer({
    visitCompoundStmt(node) {
      const kept = (node.statements as ASTNode[]).filter(st => {
        if (st.kind !== NodeKind.DeclStmt) return true;
        const ds = (st as unknown as { declarations: Array<{ kind: NodeKind; name?: { name: string }; initializer?: unknown }> }).declarations;
        return !(ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !ds[0].initializer && unused.includes(ds[0].name!.name));
      });
      return kept.length === node.statements.length ? undefined : ({ ...node, statements: kept } as ASTNode);
    },
  })(body);
}

function createPseudoOpLowerTransformer(options: PseudoOpLowerOptions = {}): Transformer {
  const mode: ArtifactMode = options.mode ?? 'report';
  const report = (record: ArtifactRecord) => {
    if (mode === 'strict') throw new UnlowerableArtifactError(record);
    options.onArtifact?.(record);
  };
  const tables: ExprShapeTables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields: options.structFields,
    fieldTypes: options.fieldTypes,
    returnTypes: options.functionReturnTypes,
    resolve: options.typedefTargets ? (n: string) => options.typedefTargets![n] : undefined,
  };

  const lowerBody = (body: ASTNode, localTypes: Map<string, TypeNode>): ASTNode => {
    const shape = createExprShape(localTypes, tables);
    const classify = (e: Expression): Operand => {
      const x = unwrapParens(e);
      switch (x.kind) {
        case NodeKind.IntegerLiteral: {
          const v = (x as IntegerLiteralExpr).value;
          const unsignedSuffix = /u/i.test(String((x as unknown as { suffix?: string }).suffix ?? ''));
          return {
            kind: 'int', width: v >= -(1n << 31n) && v < (1n << 32n) ? 4 : 8,
            signed: unsignedSuffix ? false : v < (1n << 31n) ? true : undefined,
          };
        }
        case NodeKind.CharLiteral:
        case NodeKind.BoolLiteral:
          return { kind: 'int', width: 1 };
        case NodeKind.FloatingLiteral: {
          const suffix = ((x as FloatingLiteralExpr).suffix ?? '').toLowerCase();
          return { kind: 'float', width: suffix === 'f' ? 4 : 8 };
        }
        case NodeKind.UnaryExpr: {
          const u = x as UnaryExpr;
          if (u.operator === '!') return { kind: 'int', width: 1 };
          if (u.operator === '-' || u.operator === '~' || u.operator === '+') {
            const inner = classify(u.operand);
            return inner.kind === 'int' ? { kind: 'int', width: Math.max(4, inner.width), signed: promotedSigned(inner) } : inner;
          }
          break;
        }
        case NodeKind.BinaryExpr: {
          const b = x as BinaryExpr;
          if (COMPARE.has(b.operator)) return { kind: 'int', width: 1 };
          const l = classify(b.left);
          if (SHIFT.has(b.operator)) {
            return l.kind === 'int' ? { kind: 'int', width: Math.max(4, l.width), signed: promotedSigned(l) } : { kind: 'unknown', why: 'shift of a non-integer' };
          }
          if (ARITH.has(b.operator)) {
            const r = classify(b.right);
            if (l.kind === 'int' && r.kind === 'int') {
              return { kind: 'int', width: Math.max(4, l.width, r.width), signed: arithmeticSigned(l, r) };
            }
            if (l.kind === 'ptr' && r.kind === 'int' && (b.operator === '+' || b.operator === '-')) return l;
            if (r.kind === 'ptr' && l.kind === 'int' && b.operator === '+') return r;
            if (l.kind === 'ptr' && r.kind === 'ptr' && b.operator === '-') return { kind: 'int', width: 4 };
            if (l.kind === 'float' || r.kind === 'float') {
              if (l.kind === 'unknown' || r.kind === 'unknown') return { kind: 'unknown', why: 'mixed arithmetic' };
              const lw = l.kind === 'float' ? l.width : 0;
              const rw = r.kind === 'float' ? r.width : 0;
              return { kind: 'float', width: Math.max(lw, rw) };
            }
            return { kind: 'unknown', why: `${b.operator} of operands of unknown type` };
          }
          break;
        }
        case NodeKind.ConditionalExpr: {
          const c = x as ConditionalExpr;
          const a = classify(c.thenExpr);
          const b = classify(c.elseExpr);
          if (a.kind === 'int' && b.kind === 'int') return { kind: 'int', width: Math.max(4, a.width, b.width) };
          return a.kind === b.kind && a.kind !== 'unknown' ? a : { kind: 'unknown', why: 'conditional arms disagree' };
        }
        case NodeKind.MemberExpr: {
          // Ghidra's `x._N_M_` is M raw bytes of x, whatever x is; subpiece-access
          // spells it later.
          const member = (x as unknown as { member: { name?: string } }).member;
          const m = typeof member?.name === 'string' ? /^_(\d+)_(\d+)_$/.exec(member.name) : null;
          if (m) return { kind: 'int', width: Number(m[2]) };
          break;
        }
        case NodeKind.CallExpr: {
          const callee = (x as CallExpr).callee as unknown as TypeNode;
          if (callee.kind === NodeKind.TemplateType && PURE_HELPERS.has(typeName(callee) ?? '')) {
            const arg = (callee as unknown as { arguments: Array<{ type?: TypeNode }> }).arguments[0]?.type;
            if (arg) return classOfShape(shapeOf(arg));
          }
          if ((callee as unknown as ASTNode).kind === NodeKind.Identifier && (callee as unknown as Identifier).name === 'd2_load24') return { kind: 'int', width: 4 };
          break;
        }
        default:
          break;
      }
      return classOfShape(shape(x));
    };
    const shapeOf = (t: TypeNode) => shape(Expr.cast(t, Expr.identifier('__x')));
    const ctx: Ctx = { classify, isLocal: (n: string) => localTypes.has(n), stackSlots: options.stackSlots };
    const unions = new Set(options.unionNames ?? []);
    const carryDeps = {
      shape: (e: Expression) => shape(e), isPure, locals: new Set(localTypes.keys()), isUnion: (n: string) => unions.has(n),
    };

    // The fold has to see the SBORROW calls before they are lowered, and the `||`/`&&`
    // forms before their inner `!=` is folded on its own: the traversal is bottom-up, so
    // each is its own walk.
    const fold = (ops: readonly string[]) => createTransformer({
      visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
        if (!ops.includes(node.operator)) return undefined;
        if (node.operator === '&&' || node.operator === '||') {
          const whole = lowerWholeZeroTest(node, carryDeps);
          if (whole) return { ...whole, leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as ASTNode;
        }
        try {
          return foldSborrow(node, ctx) ?? undefined;
        } catch (e) {
          if (e instanceof Unlowerable) return undefined;
          throw e;
        }
      },
    });
    const lower = createTransformer({
      // `!SBORROWn(a, a)` lowers to `!false`: say `true` (the traversal is bottom-up, so
      // the operand is already lowered here).
      visitUnaryExpr(node: UnaryExpr): ASTNode | undefined {
        if (node.operator !== '!') return undefined;
        const inner = unwrapParens(node.operand);
        if (inner.kind !== NodeKind.BoolLiteral) return undefined;
        const v = (inner as unknown as { value: boolean }).value;
        return { ...Expr.boolLiteral(!v), leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as ASTNode;
      },
      visitCallExpr(call: CallExpr): ASTNode | undefined {
        if (call.callee.kind !== NodeKind.Identifier) return undefined;
        const name = (call.callee as Identifier).name;
        if (name === 'CONCAT44') {
          // Both halves of one 8-byte object: that object's value, not a reassembly.
          const whole = lowerWholeConcat(call, carryDeps);
          if (whole) return { ...whole, leadingTrivia: call.leadingTrivia, trailingTrivia: call.trailingTrivia } as Expression;
        }
        const renamed = RENAMES[name];
        if (renamed) return updateNode(call, { callee: Expr.identifier(renamed) } as Partial<CallExpr>);
        const std = STD_SPELLINGS[name];
        if (std && call.arguments.length === 1) {
          return updateNode(call, { callee: Expr.qualifiedId(std) } as Partial<CallExpr>);
        }
        const libc = BUILTIN_SPELLINGS[name];
        if (libc) return updateNode(call, { callee: Expr.identifier(libc) } as Partial<CallExpr>);
        // CPUID: one pseudo-op per leaf, each taking EAX - the leaf itself - and
        // returning a pointer to the four result registers. D2_Cpuid is that contract.
        if ((name === 'cpuid' || name.startsWith('cpuid_')) && call.arguments.length === 1) {
          return updateNode(call, { callee: Expr.identifier('D2_Cpuid') } as Partial<CallExpr>);
        }
        if (name === 'rdtsc' && call.arguments.length === 0) {
          return updateNode(call, { callee: Expr.identifier('__rdtsc') } as Partial<CallExpr>);
        }
        let lowered: Expression | null;
        try {
          lowered = name === 'builtin_strncpy' ? lowerBuiltinStrncpy(call.arguments)
            : name === 'ZPULL' || name === 'SPULL' ? lowerPull(ctx, name === 'SPULL', call.arguments)
            : lowerCall(ctx, name, call.arguments);
        } catch (e) {
          if (!(e instanceof Unlowerable)) throw e;
          report({ op: name, reason: e.reason });
          return undefined;
        }
        if (!lowered) return undefined;
        return { ...lowered, leadingTrivia: call.leadingTrivia, trailingTrivia: call.trailingTrivia } as Expression;
      },
    });
    // Before `lower`: a CONCAT whose high half no value reaches may have a `hi` of no
    // knowable width, which `lower` would report.
    const deadHigh = createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        if (node.kind !== NodeKind.AssignExpr) return undefined;
        const a = node as unknown as { operator: string; left: Expression; right: Expression };
        if (a.operator !== '=') return undefined;
        const split = lowerLocalSlotConcat(ctx, a.left, a.right);
        if (split) return { ...split, leadingTrivia: node.leadingTrivia, trailingTrivia: node.trailingTrivia } as unknown as ASTNode;
        let lowered: Expression | null;
        try {
          lowered = lowerDeadHighConcat(ctx, a.left, a.right);
        } catch (e) {
          if (e instanceof Unlowerable) return undefined;
          throw e;
        }
        return lowered ? ({ ...node, right: lowered } as unknown as ASTNode) : undefined;
      },
    });
    reportValuelessConstants(body, report);
    const swiTemps = new Set<string>();
    const statements = createTransformer({
      visitCompoundStmt(node) {
        const next = lowerStatements(node.statements as ASTNode[], report, swiTemps);
        return next ? ({ ...node, statements: next } as ASTNode) : undefined;
      },
    });
    // `undefined3 in_stack_00000005;` declared and never used: the upper bytes of a byte
    // parameter's slot. A declaration nothing reads cannot change a value; it goes.
    // An in_stack_ name that IS used is a value Ghidra lost or misnamed, left for Ghidra.
    // Not while a frame address is still unbound: stack-frame-address resolves those later
    // against the frame, and may name the slot.
    const frameAddressLeft = findNodesByKind(body, NodeKind.Identifier)
      .some(n => (n as Identifier).name.startsWith('stack0x'));
    if (!frameAddressLeft) {
      for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
        const name = (d as VariableDecl).name.name;
        if (/^in_stack_[0-9a-f]+$/.test(name)) swiTemps.add(name);
      }
    }
    // Flag conditions first: they need the SBORROW calls the exact lowering would expand.
    const registersRetired = retireIndeterminateRegisters(body, swiTemps);
    const retired = registersRetired.kind === NodeKind.CompoundStmt
      ? (() => {
        const list = (registersRetired as unknown as { statements: Statement[] }).statements;
        const deps = { classify, isPure, locals: new Set(localTypes.keys()) };
        const stringDeps = {
          shape: (e: Expression) => shape(e), isPure, locals: deps.locals,
          localArrays: localArraysOf(body), localArrayPointers: localArrayPointersOf(body),
          stackSlots: options.stackSlots, fieldOffsets: options.structFieldOffsets,
          structFields: options.structFields, aggregateSizes: options.aggregateSizes,
        };
        const next = lowerStringIntrinsics(
          lowerCarryChains(lowerNegTestConditions(lowerFlagConditions(list, deps), deps), carryDeps), stringDeps);
        return next === list ? registersRetired : ({ ...(registersRetired as object), statements: next } as unknown as ASTNode);
      })()
      : registersRetired;
    return dropUnusedDecls(statements(lower(deadHigh(fold(['==', '!='])(fold(['||', '&&'])(retired))))), swiTemps);
  };

  return (root: ASTNode) => {
    // Each function body is lowered against its own parameters and locals.
    return createTransformer({
      visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
        if (!fn.body) return undefined;
        const localTypes = new Map<string, TypeNode>();
        for (const p of fn.parameters) {
          const pd = p as ParameterDecl;
          if (pd.name) localTypes.set(pd.name.name, pd.type);
        }
        for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
          const v = d as VariableDecl;
          if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
        }
        return { ...fn, body: lowerBody(fn.body, localTypes) } as FunctionDecl;
      },
    })(root);
  };
}

export const pseudoOpLowerPlugin: TransformPlugin = {
  id: 'pseudo-op-lower',
  name: 'Pseudo-op Lowering',
  description: 'Replaces decompiler pseudo-ops (SUB, CONCAT, ZEXT/SEXT, CARRY/SCARRY/SBORROW) with the exact C++ expression',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 20,
  tags: ['cleanup', 'ghidra', 'macros'],
  createTransformer: createPseudoOpLowerTransformer,
};

/** For callers that need the name test without the pass. */
export const isPseudoOpCallee = (callee: Expression): boolean => {
  const n = calleeName(callee);
  if (!n) return false;
  try { return parseOpName(n) !== null; } catch { return true; }
};

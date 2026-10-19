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
  ParameterDecl,
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
  | { kind: 'int'; width: number }
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
  if (iw !== undefined) return { kind: 'int', width: iw };
  const fw = FLOAT_WIDTHS[s.base];
  if (fw !== undefined) return { kind: 'float', width: fw };
  return { kind: 'unknown', why: `type ${s.base} is not a scalar this pass knows` };
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

class Unlowerable extends Error {
  constructor(readonly reason: string) { super(reason); }
}

interface Ctx {
  classify: (e: Expression) => Operand;
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
  const mask3 = (x: Expression) => fromTemplate(`(${U})(__A & ${maskLiteral(3)})`, { __A: x });

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
        : fromTemplate(`(uint32_t)(${uType(ic.width)})__A`, { __A: cast3.inner });
      return mask3(ext);
    }
    e = cast3.inner;
  }

  const cls = ctx.classify(e);
  const spelled = () => emit(e as AnyNode).replace(/\s+/g, ' ').slice(0, 60);
  const masked = (x: Expression) => (isOddWidth(n) ? fromTemplate(`(${U})(__A & ${maskLiteral(n)})`, { __A: x }) : x);
  switch (cls.kind) {
    case 'unknown':
      throw new Unlowerable(`operand type unknown (${cls.why}): ${spelled()}`);
    case 'ptr':
      // A pointer is 4 bytes on the target; fewer may be read from it, never more.
      if (n > 4 || need > 4) throw new Unlowerable(`a pointer operand is 4 bytes, not ${n}`);
      return masked(fromTemplate(`(${U})(uintptr_t)__A`, { __A: e }));
    case 'int':
      if (cls.width < need) throw new Unlowerable(`operand is ${cls.width} bytes, the operation reads ${need}`);
      return masked(fromTemplate(`(${U})__A`, { __A: e }));
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
  return isOddWidth(m)
    ? fromTemplate(`(${uType(m)})(__A & ${maskLiteral(m)})`, { __A: shifted })
    : fromTemplate(`(${uType(m)})__A`, { __A: shifted });
}

function lowerConcat(ctx: Ctx, n: number, m: number, args: Expression[]): Expression {
  const [hi, lo] = args;
  const T = uType(n + m);
  const h = raw(ctx, hi, n, n);
  const l = raw(ctx, lo, m, m);
  const joined = fromTemplate(`(${T})((${T})__A << ${m * 8} | (${T})__B)`, { __A: h, __B: l });
  return isOddWidth(n + m) ? fromTemplate(`(${T})(__A & ${maskLiteral(n + m)})`, { __A: joined }) : joined;
}

function lowerExt(ctx: Ctx, signed: boolean, n: number, m: number, args: Expression[]): Expression {
  if (m < n) throw new Unlowerable(`extension from ${n} to ${m} bytes narrows`);
  const src = raw(ctx, args[0], n, n);
  if (!signed) return fromTemplate(`(${uType(m)})__A`, { __A: src });
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
          return { kind: 'int', width: v >= -(1n << 31n) && v < (1n << 32n) ? 4 : 8 };
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
            return inner.kind === 'int' ? { kind: 'int', width: Math.max(4, inner.width) } : inner;
          }
          break;
        }
        case NodeKind.BinaryExpr: {
          const b = x as BinaryExpr;
          if (COMPARE.has(b.operator)) return { kind: 'int', width: 1 };
          const l = classify(b.left);
          if (SHIFT.has(b.operator)) {
            return l.kind === 'int' ? { kind: 'int', width: Math.max(4, l.width) } : { kind: 'unknown', why: 'shift of a non-integer' };
          }
          if (ARITH.has(b.operator)) {
            const r = classify(b.right);
            if (l.kind === 'int' && r.kind === 'int') return { kind: 'int', width: Math.max(4, l.width, r.width) };
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
    const ctx: Ctx = { classify };

    // The fold has to see the SBORROW calls before they are lowered, and the `||`/`&&`
    // forms before their inner `!=` is folded on its own: the traversal is bottom-up, so
    // each is its own walk.
    const fold = (ops: readonly string[]) => createTransformer({
      visitBinaryExpr(node: BinaryExpr): ASTNode | undefined {
        if (!ops.includes(node.operator)) return undefined;
        try {
          return foldSborrow(node, ctx) ?? undefined;
        } catch (e) {
          if (e instanceof Unlowerable) return undefined;
          throw e;
        }
      },
    });
    const lower = createTransformer({
      visitCallExpr(call: CallExpr): ASTNode | undefined {
        if (call.callee.kind !== NodeKind.Identifier) return undefined;
        const name = (call.callee as Identifier).name;
        const renamed = RENAMES[name];
        if (renamed) return updateNode(call, { callee: Expr.identifier(renamed) } as Partial<CallExpr>);
        const std = STD_SPELLINGS[name];
        if (std && call.arguments.length === 1) {
          return updateNode(call, { callee: Expr.qualifiedId(std) } as Partial<CallExpr>);
        }
        let lowered: Expression | null;
        try {
          lowered = lowerCall(ctx, name, call.arguments);
        } catch (e) {
          if (!(e instanceof Unlowerable)) throw e;
          report({ op: name, reason: e.reason });
          return undefined;
        }
        if (!lowered) return undefined;
        return { ...lowered, leadingTrivia: call.leadingTrivia, trailingTrivia: call.trailingTrivia } as Expression;
      },
    });
    reportValuelessConstants(body, report);
    return lower(fold(['==', '!='])(fold(['||', '&&'])(body)));
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

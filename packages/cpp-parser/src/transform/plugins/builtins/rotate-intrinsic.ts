/**
 * Rotate Intrinsic Plugin
 *
 * Ghidra's p-code has no rotate, so `rol ecx, 0x1e` is decompiled as the shift pair
 * `x << 0x1e | x >> 2`. VC8 compiles that pair as a rotate again, but always the one with
 * the smaller count (`ror ecx, 2`): a rotate the original wrote with a count above 16 only
 * comes back from `_rotl(x, 0x1e)`, which VC8 keeps as written (Storm SHA1_Round1..4
 * 00425730.., SSignature.cpp `*pnB = *pnB << 0x1e | *pnB >> 2;` against `rol ecx, 0x1e`).
 *
 * The text cannot say which rotate the original performed, nor whether the pair was a rotate
 * at all (two shifts of a signed value, XSHA1_Transform 005206b0); the instruction can. The
 * rotate-sites facts (reconstruct extract/rotate-sites.ts) list, per line, each ROL/ROR of a
 * 32-bit register by an immediate. A pair on a line is rewritten when that line's facts hold
 * the rotate the pair spells with a count above 16:
 *
 *     x << n | x >> (32 - n)    ROL n, n > 16          ->  _rotl(x, n)
 *     x << n | x >> (32 - n)    ROR (32 - n) > 16      ->  _rotr(x, 32 - n)
 *
 * either operand order, both shifts by integer literals summing to 32, the same x on both
 * sides (structurally, with no call, assignment or increment in it), no cast on either x. A
 * count of 16 or less is left alone: VC8 compiles the pair to that instruction already.
 *
 * Ghidra prints a left shift by a constant as a multiply when it folded one, so the pair also
 * reads `x * 0x20 | x >> 0x1b`. VC8 does not see a rotate in that spelling at all and emits
 * shl/shr/or (Bnclient SHA1_Transform 00528c90, `rol edi, 5` / `rol edx, 0x1e` in the
 * original); it is written as the intrinsic whatever the count:
 *
 *     x * 2^n | x >> (32 - n)   ROL n             ->  _rotl(x, n)
 *     x * 2^n | x >> (32 - n)   ROR (32 - n)      ->  _rotr(x, 32 - n)
 *
 * The rotate by 1 is printed with the top bit as a sign test, `x << 1 | (uint32_t)((int)x < 0)`
 * (`rol edx, 1`, the same function's message schedule), and is taken the same way.
 *
 * The big-endian load of a SHA-1 block is two rotates in the original (the common `blk0`
 * macro, `rol(x, 24) & 0xff00ff00 | rol(x, 8) & 0x00ff00ff`), which Ghidra prints as the four-term
 * byte swap `x << 0x18 | x >> 8 & 0xff00ff00 | (x & 0xff00) << 8 | x >> 0x18`. Where the
 * line's facts hold both rotates (ROL 24 or ROR 8, and ROL 8 or ROR 24) it is written back as
 *
 *     _rotl(x, 0x18) & 0xff00ff00 | _rotl(x, 8) & 0xff00ff
 *
 * with each rotate spelled in the direction the facts give and the two in instruction order.
 *
 * Every candidate is judged by its value, not its spelling: the `|` chain is evaluated bit by
 * bit over its one operand x (shifts, power-of-two multiplies, masks, the sign test,
 * `_rotl`/`_rotr` by constants), and a rewrite happens only when that bit map is exactly the
 * rotate or the byte swap, with the terms' bits disjoint. That holds for a 32-bit unsigned x only, so x must be
 * KNOWN to be `unsigned int` (or `unsigned long`) - a parameter, local, global or member the
 * function's types declare so; a signed x makes `>>` arithmetic and the pair no rotate. A
 * pair spelled with shifts whose operand type is unknown keeps the older rule (the rotate
 * fact alone), a known non-u32 operand is never rewritten. `_rotl` is declared
 * `unsigned int _rotl(unsigned int, int)` by <stdlib.h> in both builds (an intrinsic under
 * VC8's /O2). The facts tie the rewrite to the line, so a line without the rotate keeps its
 * text.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CallExpr, CStyleCastExpr, Expression, FunctionDecl, IntegerLiteralExpr,
  ParameterDecl, ParenExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind, traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { placed } from './access-order-evidence.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { calleeName, canonicalBase, shapeOfNode, type TypedefResolver } from './call-arg-cast.js';

/** One rotate the original's instruction performs: ROL (left) or ROR by `count`. */
export interface RotateFact {
  left: boolean;
  count: number;
}

export interface RotateIntrinsicOptions extends PluginOptions {
  /** Parsed-text line -> the rotates its instructions perform. Absent: nothing changes. */
  rotates?: ReadonlyMap<number, readonly RotateFact[]>;
  onSite?: (e: { line: number; spelling: string }) => void;
  /** Type tables for deciding that x is an unsigned dword (expr-shape.ts). */
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function literal(e: Expression): IntegerLiteralExpr | null {
  const x = unwrap(e);
  return x.kind === NodeKind.IntegerLiteral ? x as IntegerLiteralExpr : null;
}

/** A literal's value as the 32 bits it contributes: an int or unsigned int literal only. */
function literalBits(e: Expression): number | null {
  let x = unwrap(e), neg = false;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    neg = true;
    x = unwrap((x as UnaryExpr).operand as Expression);
  }
  if (x.kind !== NodeKind.IntegerLiteral) return null;
  const lit = x as IntegerLiteralExpr;
  if (!/^u?$/i.test(lit.suffix)) return null;
  let v = lit.value;
  if (v > 0xffffffffn) return null;
  if (neg) {
    if (v > 0x80000000n) return null;
    v = -v;
  }
  return Number(BigInt.asUintN(32, v));
}

/** A shift count or rotate count 1..31 written as a literal. */
function countOf(e: Expression): number | null {
  const l = literal(e);
  if (!l || !/^u?$/i.test(l.suffix) || l.value < 1n || l.value > 31n) return null;
  return Number(l.value);
}

/** x reads only: no call, assignment, increment, cast or comma anywhere in it. */
function pureOperand(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr:
      case NodeKind.CStyleCastExpr: case NodeKind.CommaExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (n as unknown as { operator: string }).operator;
        if (op === '++' || op === '--') return false;
        break;
      }
      default:
        break;
    }
  }
  return true;
}

// ============================================
// BIT MAPS
// ============================================

/** Output bit i -> the bit of x it holds, or -1 for a constant zero. */
type BitMap = number[];

const identity = (): BitMap => Array.from({ length: 32 }, (_, i) => i);
const shl = (m: BitMap, k: number): BitMap => m.map((_, i) => (i - k >= 0 ? m[i - k] : -1));
const shr = (m: BitMap, k: number): BitMap => m.map((_, i) => (i + k < 32 ? m[i + k] : -1));
const rol = (m: BitMap, k: number): BitMap => m.map((_, i) => m[(i - k + 32) % 32]);
const mask = (m: BitMap, c: number): BitMap => m.map((b, i) => ((c >>> i) & 1 ? b : -1));

/** The left rotate count a bit map is, or null. */
function rotateOf(m: BitMap): number | null {
  const k = (32 - m[0]) % 32;
  if (m[0] < 0 || k === 0) return null;
  return m.every((b, i) => b === (i - k + 32) % 32) ? k : null;
}

const isByteSwap = (m: BitMap): boolean => m.every((b, i) => b === ((3 - (i >> 3)) << 3 | (i & 7)));

interface Eval {
  x: Expression;
  bits: BitMap;
  /** A term is spelled other than a shift: `*` for a left shift, or the sign test for `>> 31`. */
  unshifted: boolean;
}

/** The canonical base of a cast's target type, when it is not a pointer. */
function castBase(t: TypeNode): string | null {
  const s = shapeOfNode(t, 0);
  return s && s.stars === 0 ? canonicalBase(s.base) : null;
}

const INT32 = new Set(['int', 'long']);
const DWORD32 = new Set(['int', 'long', 'unsigned int', 'unsigned long']);

/**
 * x for `(uint32_t)((int)x < 0)` (or the bare comparison): Ghidra's spelling of `x >> 31`,
 * the top bit of x as 0 or 1, which is how it prints the right half of a rotate by 1
 * (`x << 1 | (uint32_t)((int)x < 0)` against `rol edx, 1`, SHA1_Transform 00528c90).
 */
function signBitOperand(e: Expression): Expression | null {
  let u = unwrap(e);
  if (u.kind === NodeKind.CStyleCastExpr) {
    const c = u as CStyleCastExpr;
    const base = castBase(c.type);
    if (!base || !DWORD32.has(base)) return null;
    u = unwrap(c.expression);
  }
  if (u.kind !== NodeKind.BinaryExpr) return null;
  const b = u as BinaryExpr;
  const zero = literal(b.right as Expression);
  if (b.operator !== '<' || !zero || zero.value !== 0n) return null;
  const l = unwrap(b.left as Expression);
  if (l.kind !== NodeKind.CStyleCastExpr) return null;
  const inner = l as CStyleCastExpr;
  const base = castBase(inner.type);
  if (!base || !INT32.has(base)) return null;
  const x = unwrap(inner.expression);
  return x.kind !== NodeKind.IntegerLiteral && pureOperand(x) ? x : null;
}

/**
 * The bit map of `e` over a single side-effect-free operand x, or null when e is anything
 * other than shifts, power-of-two multiplies, masks, `|` of disjoint bits and constant
 * rotates of that one x. Unsigned 32-bit arithmetic is assumed; the caller checks x's type.
 */
function evaluate(e: Expression): Eval | null {
  const u = unwrap(e);
  const top = signBitOperand(u);
  if (top) return { x: top, bits: shr(identity(), 31), unshifted: true };
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const op = b.operator;
    if (op === '|') {
      const l = evaluate(b.left as Expression), r = evaluate(b.right as Expression);
      if (!l || !r || emit(l.x) !== emit(r.x)) return null;
      const bits: BitMap = [];
      for (let i = 0; i < 32; i++) {
        const p = l.bits[i], q = r.bits[i];
        if (p >= 0 && q >= 0 && p !== q) return null;
        bits.push(p >= 0 ? p : q);
      }
      return { x: l.x, bits, unshifted: l.unshifted || r.unshifted };
    }
    if (op === '<<' || op === '>>') {
      const k = countOf(b.right as Expression);
      const v = k === null ? null : evaluate(b.left as Expression);
      return v && k !== null ? { ...v, bits: op === '<<' ? shl(v.bits, k) : shr(v.bits, k) } : null;
    }
    if (op === '*') {
      for (const [a, c] of [[b.left, b.right], [b.right, b.left]] as Expression[][]) {
        const n = literalBits(c);
        if (n === null || n === 0 || (n & (n - 1)) !== 0 || n === 1) continue;
        const v = evaluate(a);
        return v ? { ...v, bits: shl(v.bits, 31 - Math.clz32(n)), unshifted: true } : null;
      }
      return null;
    }
    if (op === '&') {
      for (const [a, c] of [[b.left, b.right], [b.right, b.left]] as Expression[][]) {
        const n = literalBits(c);
        if (n === null) continue;
        const v = evaluate(a);
        return v ? { ...v, bits: mask(v.bits, n) } : null;
      }
      return null;
    }
    return null;
  }
  if (u.kind === NodeKind.CallExpr) {
    const c = u as CallExpr;
    const name = calleeName(c.callee);
    if ((name !== '_rotl' && name !== '_rotr') || c.arguments.length !== 2) return null;
    const k = countOf(c.arguments[1] as Expression);
    const v = k === null ? null : evaluate(c.arguments[0] as Expression);
    return v && k !== null ? { ...v, bits: rol(v.bits, name === '_rotl' ? k : 32 - k) } : null;
  }
  if (u.kind === NodeKind.IntegerLiteral || !pureOperand(u)) return null;
  return { x: u, bits: identity(), unshifted: false };
}

// ============================================
// THE REWRITES
// ============================================

/** The line's fact performing a rotate left by k (ROL k or ROR 32 - k) that `ok` accepts. */
const factFor = (k: number, facts: readonly RotateFact[], ok: (f: RotateFact) => boolean = () => true) =>
  facts.findIndex(f => ((f.left && f.count === k) || (!f.left && f.count === 32 - k)) && ok(f));

/** `_rotl(x, n)` or `_rotr(x, n)` as the fact performs it. */
const intrinsic = (f: RotateFact, x: Expression): CallExpr =>
  Expr.call(f.left ? '_rotl' : '_rotr', [cloneNode(x), Expr.intLiteral(f.count, f.count > 9 ? 16 : 10)]);

/** A single `x << n`, `x >> n`, `x * 2^n` (either operand order) or sign test on its operand. */
function singleShift(e: Expression): boolean {
  const u = unwrap(e);
  if (signBitOperand(u)) return true;
  if (u.kind !== NodeKind.BinaryExpr) return false;
  const b = u as BinaryExpr;
  if (b.operator === '*') return literalBits(b.left as Expression) !== null || literalBits(b.right as Expression) !== null;
  return b.operator === '<<' || b.operator === '>>';
}

type Unsigned32 = (x: Expression) => boolean | null;

function rewrite(b: BinaryExpr, facts: readonly RotateFact[], isU32: Unsigned32): { out: Expression; spelling: string } | null {
  const v = evaluate(b);
  if (!v) return null;
  const known = isU32(v.x);
  if (known === false) return null;
  const k = rotateOf(v.bits);
  if (k !== null) {
    if (!singleShift(b.left as Expression) || !singleShift(b.right as Expression)) return null;
    // `x << n | x >> (32 - n)` compiles to the rotate by the smaller count as printed, so it
    // is rewritten only for a fact counting above 16; an operand of unknown type is still
    // taken in this spelling. VC8 sees no rotate in the multiply or sign-test spelling at all.
    const i = v.unshifted
      ? (known === true ? factFor(k, facts) : -1)
      : factFor(k, facts, f => f.count > 16);
    if (i < 0) return null;
    const out = intrinsic(facts[i], v.x);
    return { out, spelling: facts[i].left ? '_rotl' : '_rotr' };
  }
  if (known === true && isByteSwap(v.bits)) {
    const i24 = factFor(24, facts), i8 = factFor(8, facts);
    if (i24 < 0 || i8 < 0) return null;
    const hi = Expr.binary(intrinsic(facts[i24], v.x), '&', Expr.intLiteral(0xff00ff00, 16));
    const lo = Expr.binary(intrinsic(facts[i8], v.x), '&', Expr.intLiteral(0xff00ff, 16));
    return { out: i24 <= i8 ? Expr.binary(hi, '|', lo) : Expr.binary(lo, '|', hi), spelling: 'byte swap' };
  }
  return null;
}

/** The unsigned-dword test for one function: true, false (known otherwise), or null (unknown). */
function unsigned32(fn: FunctionDecl | null, o: RotateIntrinsicOptions): Unsigned32 {
  const localTypes = new Map<string, TypeNode>();
  const clash = new Set<string>();
  if (fn) {
    for (const p of fn.parameters) {
      const pd = p as ParameterDecl;
      if (pd.name) localTypes.set(pd.name.name, pd.type);
    }
    if (fn.body) {
      for (const d of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
        const vd = d as VariableDecl;
        const prev = localTypes.get(vd.name.name);
        if (prev && emit(prev) !== emit(vd.type)) clash.add(vd.name.name);
        else if (!prev) localTypes.set(vd.name.name, vd.type);
      }
    }
  }
  for (const n of clash) localTypes.delete(n);
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const shape: ExprShape = createExprShape(localTypes, {
    globalTypes: o.globalTypes ?? {},
    enclosingVarTypes: o.enclosingVarTypes ?? {},
    structFields: o.structFields ?? {},
    fieldTypes: o.fieldTypes ?? {},
    returnTypes: o.functionReturnTypes ?? {},
    resolve,
  });
  return (x: Expression) => {
    const root = unwrap(x);
    if (root.kind === NodeKind.Identifier && clash.has(emit(root))) return null;
    const s = shape(x);
    if (!s) return null;
    if (s.stars !== 0) return false;
    const base = canonicalBase(s.base);
    return base === 'unsigned int' || base === 'unsigned long';
  };
}

export const rotateIntrinsicPlugin: TransformPlugin = {
  id: 'rotate-intrinsic',
  name: 'Rotate Intrinsic',
  description: 'A shift pair, multiply pair or byte swap the original performs with rotates is written with _rotl/_rotr',
  version: '1.1.0',
  defaultEnabled: true,
  priority: 59.65,
  tags: ['matching'],
  createTransformer: (options: RotateIntrinsicOptions = {}): Transformer => {
    const rotates = options.rotates;
    const inFunction = (fn: FunctionDecl | null) => {
      const isU32 = unsigned32(fn, options);
      return createTransformer({
        visitNode(node: ASTNode): ASTNode | undefined {
          if (!rotates || node.kind !== NodeKind.BinaryExpr || !placed(node)) return undefined;
          if ((node as BinaryExpr).operator !== '|') return undefined;
          const facts = rotates.get(node.location.start.line);
          if (!facts || facts.length === 0) return undefined;
          const r = rewrite(node as BinaryExpr, facts, isU32);
          if (!r) return undefined;
          r.out.location = node.location;
          options.onSite?.({ line: node.location.start.line, spelling: r.spelling });
          return r.out;
        },
      });
    };
    return (root: ASTNode): ASTNode => {
      if (!rotates) return root;
      let sawFunction = false;
      const outer = createTransformer({
        visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
          sawFunction = true;
          if (!fn.body) return undefined;
          return inFunction(fn)(fn);
        },
      });
      const out = outer(root);
      return sawFunction ? out : inFunction(null)(root);
    };
  },
};

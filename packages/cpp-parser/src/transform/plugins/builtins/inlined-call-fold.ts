/**
 * Bit-level evaluation of a flag test, to prove that a constant-folded inlined copy
 * computes what the callee computes with that constant passed.
 *
 * VC8 folds a constant argument into an inlined body: ARENA_TestFlag (0053f470) is
 *
 *     return (pGame->pArenaCtrl->eArenaFlags & nParam) != 0;
 *
 * and ARENA_IsFlag0x200Set (0053fed0), which called it with 0x200, holds
 *
 *     return pGame->pArenaCtrl->eArenaFlags >> 9 & 1;
 *
 * Every value here is a vector of bits, each a constant or one bit of one input (a
 * read the expression does not interpret, such as the member above), possibly
 * inverted. That is a canonical form: two expressions whose vectors are equal compute
 * the same value for every input. Anything the form cannot hold - an arithmetic
 * operator, a conjunction of two different input bits, a read of unknown width -
 * throws, and nothing is claimed.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  BinaryExpr, CStyleCastExpr, Expression, Identifier, IntegerLiteralExpr, TypeNode, UnaryExpr,
} from '../../../ast/nodes.js';
import { canonicalBase, shapeOfNode, unwrapParens, type TypeShape, type TypedefResolver } from './call-arg-cast.js';

/** 0, 1, or input bit `(code - 2) >> 1`, inverted when the low bit is set. */
type Bit = number;

/** An integer value: its bits, least significant first, and whether its type is signed. */
export interface BitValue { bits: Bit[]; signed: boolean }

export interface IntType { bits: number; signed: boolean }

class Unprovable extends Error {}

const fail = (why: string): never => { throw new Unprovable(why); };

const inv = (b: Bit): Bit => (b < 2 ? 1 - b : b ^ 1);

function and(a: Bit, b: Bit): Bit {
  if (a === 0 || b === 0) return 0;
  if (a === 1) return b;
  if (b === 1) return a;
  if (a === b) return a;
  if (a === inv(b)) return 0;
  return fail('two input bits');
}

const or = (a: Bit, b: Bit): Bit => inv(and(inv(a), inv(b)));

function xor(a: Bit, b: Bit): Bit {
  if (a === 0) return b;
  if (b === 0) return a;
  if (a === 1) return inv(b);
  if (b === 1) return inv(a);
  if (a === b) return 0;
  if (a === inv(b)) return 1;
  return fail('two input bits');
}

/**
 * The integer type a declared type names, or undefined for anything else. An enum is
 * emitted as a typedef of the integer of its width, which `resolve` gives.
 */
export function intTypeOf(shape: TypeShape | null, resolve?: TypedefResolver): IntType | undefined {
  if (!shape || shape.stars !== 0) return undefined;
  let base = canonicalBase(shape.base).replace(/^::/, '');
  for (let depth = 0; depth < 8; depth++) {
    switch (base) {
      case 'char': case 'signed char': return { bits: 8, signed: true };
      case 'unsigned char': return { bits: 8, signed: false };
      case 'short': return { bits: 16, signed: true };
      case 'unsigned short': case 'wchar_t': return { bits: 16, signed: false };
      case 'int': case 'long': return { bits: 32, signed: true };
      case 'unsigned int': case 'unsigned long': return { bits: 32, signed: false };
    }
    const next = resolve?.(base);
    if (!next || /[*&[(]/.test(next)) return undefined;
    base = canonicalBase(next).replace(/^::/, '');
  }
  return undefined;
}

function constant(v: bigint, t: IntType): BitValue {
  const bits: Bit[] = [];
  for (let i = 0; i < t.bits; i++) bits.push(Number((BigInt.asUintN(t.bits, v) >> BigInt(i)) & 1n));
  return { bits, signed: t.signed };
}

/** `v` converted to `t`: truncated, or extended by its own signedness. */
export function convert(v: BitValue, t: IntType): BitValue {
  const bits = v.bits.slice(0, t.bits);
  const fill = v.signed ? v.bits[v.bits.length - 1] : 0;
  while (bits.length < t.bits) bits.push(fill);
  return { bits, signed: t.signed };
}

/** Integral promotion: anything narrower than int becomes int. */
const promote = (v: BitValue): BitValue => (v.bits.length < 32 ? convert(v, { bits: 32, signed: true }) : v);

/** The usual arithmetic conversions of two promoted 32-bit operands. */
function common(a: BitValue, b: BitValue): [BitValue, BitValue] {
  const pa = promote(a), pb = promote(b);
  if (pa.bits.length !== 32 || pb.bits.length !== 32) fail('wider than 32 bits');
  const signed = pa.signed && pb.signed;
  return [{ ...pa, signed }, { ...pb, signed }];
}

/** `v != 0` as an int. */
function nonZero(v: BitValue): BitValue {
  let r: Bit = 0;
  for (const b of v.bits) r = or(r, b);
  return { bits: [r, ...new Array<Bit>(31).fill(0)], signed: true };
}

export interface BitEnv {
  /** The value of a read the evaluator does not interpret, or undefined to give up. */
  leaf: (e: Expression) => BitValue | undefined;
  enumValues: Readonly<Record<string, number>>;
  resolve: TypedefResolver;
}

function castType(t: TypeNode, env: BitEnv): IntType | 'bool' {
  const s = shapeOfNode(t, 0, env.resolve);
  if (s && s.stars === 0 && canonicalBase(s.base) === 'bool') return 'bool';
  return intTypeOf(s, env.resolve) ?? fail('cast to a type that is not an integer');
}

function literalValue(l: IntegerLiteralExpr): BitValue {
  const unsigned = /u/i.test(l.suffix) || l.value > 0x7fffffffn;
  if (l.value > 0xffffffffn || /ll/i.test(l.suffix)) fail('64-bit literal');
  return constant(l.value, { bits: 32, signed: !unsigned });
}

function evaluate(e: Expression, env: BitEnv): BitValue {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.IntegerLiteral:
      return literalValue(u as IntegerLiteralExpr);
    case NodeKind.Identifier: {
      // Small enough to be the same in an enum of any width and sign.
      const v = env.enumValues[(u as Identifier).name];
      if (v !== undefined && v >= 0 && v <= 0x7f) return constant(BigInt(v), { bits: 32, signed: true });
      break;
    }
    case NodeKind.CStyleCastExpr: {
      const c = u as CStyleCastExpr;
      const inner = evaluate(c.expression, env);
      const t = castType(c.type, env);
      return t === 'bool' ? convert(nonZero(inner), { bits: 8, signed: false }) : convert(inner, t);
    }
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator === '~') {
        const v = promote(evaluate(x.operand, env));
        return { bits: v.bits.map(inv), signed: v.signed };
      }
      if (x.operator === '!') {
        const r = nonZero(evaluate(x.operand, env));
        return { bits: [inv(r.bits[0]), ...r.bits.slice(1)], signed: true };
      }
      if (x.operator === '*') break;
      return fail(`unary ${x.operator}`);
    }
    case NodeKind.BinaryExpr: {
      const b = u as BinaryExpr;
      switch (b.operator) {
        case '&': case '|': case '^': {
          const [l, r] = common(evaluate(b.left, env), evaluate(b.right, env));
          const op = b.operator === '&' ? and : b.operator === '|' ? or : xor;
          return { bits: l.bits.map((x, i) => op(x, r.bits[i])), signed: l.signed };
        }
        case '<<': case '>>': {
          const l = promote(evaluate(b.left, env));
          const n = unwrapParens(b.right);
          if (n.kind !== NodeKind.IntegerLiteral) return fail('shift by a variable');
          const k = Number((n as IntegerLiteralExpr).value);
          if (k < 0 || k >= l.bits.length) return fail('shift out of range');
          const w = l.bits.length;
          const bits = b.operator === '<<'
            ? l.bits.map((_, i) => (i < k ? 0 : l.bits[i - k]))
            : l.bits.map((_, i) => (i + k < w ? l.bits[i + k] : l.signed ? l.bits[w - 1] : 0));
          return { bits, signed: l.signed };
        }
        case '==': case '!=': {
          const [l, r] = common(evaluate(b.left, env), evaluate(b.right, env));
          const ne = nonZero({ bits: l.bits.map((x, i) => xor(x, r.bits[i])), signed: false });
          return b.operator === '!=' ? ne : { bits: [inv(ne.bits[0]), ...ne.bits.slice(1)], signed: true };
        }
      }
      return fail(`operator ${b.operator}`);
    }
  }
  return env.leaf(u) ?? fail('a read of unknown width');
}

/** The value of `e`, or undefined when it is not a flag test this form can hold. */
export function bitValue(e: Expression, env: BitEnv): BitValue | undefined {
  try {
    return evaluate(e, env);
  } catch (err) {
    if (err instanceof Unprovable) return undefined;
    throw err;
  }
}

/** A value converted to bool and then to `t`, as `return` converts a bool callee's result. */
export function viaBool(v: BitValue, t: IntType): BitValue | undefined {
  try {
    return convert(nonZero(v), t);
  } catch (err) {
    if (err instanceof Unprovable) return undefined;
    throw err;
  }
}

/** The input bit a value is, when it is exactly one (uninverted) input bit and zeros. */
export function singleInputBit(v: BitValue): number | undefined {
  if (v.bits.slice(1).some(b => b !== 0)) return undefined;
  const b = v.bits[0];
  return b >= 2 && (b & 1) === 0 ? (b - 2) >> 1 : undefined;
}

/** A leaf's value: its bits are input bits `base .. base + width - 1`. */
export function inputValue(base: number, t: IntType): BitValue {
  const bits: Bit[] = [];
  for (let i = 0; i < t.bits; i++) bits.push(2 + 2 * (base + i));
  return { bits, signed: t.signed };
}

export const sameBits = (a: BitValue, b: BitValue): boolean =>
  a.bits.length === b.bits.length && a.bits.every((x, i) => x === b.bits[i]);


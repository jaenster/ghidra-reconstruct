/**
 * Compare Form Plugin
 *
 * Ghidra prints an ordered comparison with `<`/`<=` only and moves the constant to fit; VC8
 * compiles each spelling as written. InitLogFilePathPointers @0040eb90:
 *
 *   printed                    instructions               written
 *   nCount != 0                TEST EDX,EDX; JBE          nCount > 0
 *   0x144f < nByteOffset       CMP EDI,0x1450; JNC        nByteOffset >= 0x1450
 *   nIndex < nCount            CMP EAX,EDX; JC            unchanged
 *
 * The decisions come from the instructions (reconstruct's codegen/compare-form-spec.ts, from
 * extract/compare-sites.ts). This pass ties them to the body's comparisons: by position in
 * text order when the body has exactly the comparisons the decompile printed, each checked
 * against the printed operator and both operands' fingerprints; otherwise only a comparison
 * whose operator and fingerprints are unique on both sides is tied.
 *
 * Every rewrite keeps the value:
 *  - swapping the operands mirrors the operator;
 *  - a constant moves by one only on a bare literal whose spelling keeps its C++ type (no
 *    `L` suffix; unsuffixed values stay within int; `U` values stay within unsigned) and
 *    does not cross zero, so it wraps in neither the signed nor the unsigned 32-bit domain
 *    (the instructions already proved it does not wrap in the machine's). A signed compare
 *    may cross zero (`-1 < n` -> `n >= 0`) when the operand's declared type is signed, so
 *    the compare cannot be unsigned in C++; the node is tagged, and `compare-signedness`
 *    casts the operand back to signed should the final types make it unsigned;
 *  - `X == 0`/`X != 0` becomes `X <= 0`/`X > 0` only as an unsigned compare: X is cast to
 *    the unsigned type of the compare's width unless its declared type already is one. A
 *    pointer operand is left alone. The node is tagged, and `compare-signedness` checks the
 *    operand again against the final types.
 * A constant side that is not a bare literal (an enum member, a cast pointer) only swaps.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BinaryOperator, BoolLiteralExpr, CharLiteralExpr, CStyleCastExpr, Expression, FunctionDecl, Identifier,
  IntegerLiteralExpr, MemberExpr, ParameterDecl, ParenExpr, SubscriptExpr, TypeNode, TypedefType, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { unwrapParens } from './call-arg-cast.js';
import { Expr } from '../../../ast/factory.js';

/** One comparison tied to its instructions; `keep` when it already has their form. */
export interface CompareFormDecision {
  /** Position among the decompile's comparison tokens, in text order. */
  ord: number;
  /** The operator as printed. */
  text: string;
  /** The printed operands' fingerprints: `c:<hex>`, `v:<name>` or `e`. */
  fp: [string, string];
  /** The compare's width in bytes. */
  width: number;
  /** The CMP/TEST's address. */
  address: string;
  keep?: boolean;
  /** The operator to write, with the operands in their written order. */
  op?: string;
  /** Write the right operand first. */
  swap?: boolean;
  /** The step on the constant, as the machine reads it. */
  delta?: -1 | 0 | 1;
  /** The constant as an unsigned `width`-byte value. */
  k?: number;
  /** The compare must be unsigned at `width`. */
  unsigned?: boolean;
  /** The machine compares signed (an ordered compare read by JL/JLE/JG/JGE). */
  signed?: boolean;
}

export interface CompareFormOptions extends PluginOptions {
  /** Every comparison token of the decompile, in text order. */
  sites?: Array<{ text: string; fp: [string, string]; size?: number }>;
  decisions?: CompareFormDecision[];
  /** Called once per body with how many decisions were tied and how many were not. */
  onCensus?: (c: { tied: number; rewritten: number; untied: number; zipped: boolean }) => void;
}

const COMPARISON = new Set(['<', '<=', '>', '>=', '==', '!=']);

/** Signed integer spellings, after typedef resolution where the caller has it. */
const SIGNED_NAMES = new Set([
  'int', 'int8_t', 'int16_t', 'int32_t', 'short', 'char', 'signed char', 'long', 'INT', 'LONG', 'SHORT', 'BOOL',
  'signed', 'signed int', 'short int', 'long int', 'sdword', 'sword', 'sbyte',
]);

/** Unsigned spellings, after typedef resolution where the caller has it. */
const UNSIGNED_NAMES = new Set([
  'uint', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'ushort', 'uchar', 'ulong', 'byte', 'word', 'dword',
  'BYTE', 'WORD', 'DWORD', 'UINT', 'ULONG', 'USHORT', 'UCHAR', 'size_t', 'uintptr_t', 'bool',
  'unsigned', 'unsigned int', 'unsigned char', 'unsigned short', 'unsigned long',
]);

const UNSIGNED_OF_WIDTH: Record<number, string> = { 1: 'uint8_t', 2: 'uint16_t', 4: 'uint32_t' };
const SIGNED_OF_WIDTH: Record<number, string> = { 1: 'int8_t', 2: 'int16_t', 4: 'int32_t' };

function unwrapCasts(e: Expression): Expression {
  let x = unwrapParens(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrapParens((x as CStyleCastExpr).expression);
  return x;
}

/** A bare literal, or `-literal`, as its signed value; null otherwise. */
function literalOf(e: Expression): { value: bigint; lit: IntegerLiteralExpr } | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return { value: (x as IntegerLiteralExpr).value, lit: x as IntegerLiteralExpr };
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const o = unwrapParens((x as UnaryExpr).operand);
    if (o.kind === NodeKind.IntegerLiteral) return { value: -(o as IntegerLiteralExpr).value, lit: o as IntegerLiteralExpr };
  }
  return null;
}

function nameOf(x: Expression): string | null {
  if (x.kind === NodeKind.Identifier) {
    const n = (x as Identifier).name;
    return n === 'self' ? 'this' : n;
  }
  if (x.kind === NodeKind.QualifiedId) return (x as unknown as { name: { name?: string } }).name.name ?? null;
  return null;
}

/** The fingerprint the extraction gives a printed operand: `c:<hex>`, `v:<name>` or `e`. */
export function compareFingerprint(e: Expression, size: number): string {
  const x = unwrapCasts(e);
  const lit = literalOf(x);
  const bits = BigInt(8 * Math.max(1, size));
  const mod = (v: bigint) => ((v % (1n << bits)) + (1n << bits)) % (1n << bits);
  if (lit) return `c:${mod(lit.value).toString(16)}`;
  if (x.kind === NodeKind.CharLiteral) return `c:${mod(BigInt((x as CharLiteralExpr).value)).toString(16)}`;
  if (x.kind === NodeKind.BoolLiteral) return (x as BoolLiteralExpr).value ? 'c:1' : 'c:0';
  const n = nameOf(x);
  return n ? `v:${n}` : 'e';
}

/** The variable an access path starts from: `g` of `g.a[i].b`. */
function rootName(e: Expression): string | null {
  let x = unwrapCasts(e);
  for (;;) {
    if (x.kind === NodeKind.MemberExpr && !(x as MemberExpr).isArrow) x = unwrapCasts((x as MemberExpr).object);
    else if (x.kind === NodeKind.SubscriptExpr) x = unwrapCasts((x as SubscriptExpr).array);
    else break;
  }
  return nameOf(x);
}

/**
 * Whether a printed operand fits the extraction's fingerprint. `e` (an expression the
 * extraction did not name) fits anything; a variable fits its own name, or an access path
 * into it (a member of a global struct is the struct's symbol); a constant fits its value,
 * or a name the body does not declare (an enum member or a #define).
 */
export function fitsFingerprint(e: Expression, fp: string, size: number, declared: ReadonlySet<string>): boolean {
  if (fp === 'e') return true;
  const mine = compareFingerprint(e, size);
  if (mine === fp) return true;
  if (fp.startsWith('v:')) return rootName(e) === fp.slice(2);
  if (fp.startsWith('c:') && mine.startsWith('v:')) return !declared.has(mine.slice(2));
  return false;
}

/** A literal spelled like `like`, with value `value` (which may be negative). */
function spellLiteral(like: IntegerLiteralExpr, value: bigint, at: ASTNode): Expression {
  const abs = value < 0n ? -value : value;
  const raw = like.raw;
  let text: string;
  switch (like.base) {
    case 16: {
      const digits = abs.toString(16);
      const upper = /[A-F]/.test(raw.slice(2).replace(/[uUlL]+$/, ''));
      text = raw.slice(0, 2) + (upper ? digits.toUpperCase() : digits);
      break;
    }
    case 8: text = abs === 0n ? '0' : `0${abs.toString(8)}`; break;
    case 2: text = raw.slice(0, 2) + abs.toString(2); break;
    default: text = abs.toString(10);
  }
  const suffix = /[uUlL]*$/.exec(raw)![0];
  const lit: IntegerLiteralExpr = {
    ...like, value: abs, raw: text + suffix,
    location: at.location, leadingTrivia: [], trailingTrivia: [],
  };
  if (value >= 0n) return lit;
  return { ...Expr.unary('-', lit), location: at.location, leadingTrivia: [], trailingTrivia: [] };
}

/**
 * The constant after a step, or null when the step could change a C++ value: an `L`
 * suffix, an unsuffixed value outside int (its type would change), a `U` value outside
 * unsigned, or a step across zero (a wrap in the unsigned 32-bit domain) unless the caller
 * knows the compare is signed.
 */
export function steppedConstant(lit: IntegerLiteralExpr, value: bigint, delta: number, signedCompare = false): bigint | null {
  const next = value + BigInt(delta);
  const suffix = lit.suffix.toLowerCase();
  if (suffix.includes('l')) return null;
  if (suffix.includes('u')) {
    if (value < 0n || next < 0n || next > 0xffffffffn) return null;
    return next;
  }
  const max = 0x7fffffffn;
  if (value > max || value < -max || next > max || next < -max) return null;
  if ((value < 0n) !== (next < 0n) && !signedCompare) return null;
  return next;
}

/** `(uintW_t)(x)`, or `(intW_t)(x)` for a signed cast. */
export function compareCast(x: Expression, width: number, signed = false): CStyleCastExpr {
  const name = signed ? SIGNED_OF_WIDTH[width] ?? 'int32_t' : UNSIGNED_OF_WIDTH[width] ?? 'uint32_t';
  const type: TypedefType = {
    kind: NodeKind.TypedefType,
    name: { ...Expr.identifier(name), location: x.location, leadingTrivia: [], trailingTrivia: [] },
    location: x.location, leadingTrivia: [], trailingTrivia: [],
  } as TypedefType;
  return {
    kind: NodeKind.CStyleCastExpr,
    type,
    expression: { kind: NodeKind.ParenExpr, expression: unwrapParens(x), location: x.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr,
    location: x.location, leadingTrivia: [], trailingTrivia: [],
  };
}

/** How `x` compares by its declared type; `unknown` when no type is known. */
export function operandSignedness(x: Expression, shapeOf: ExprShape): 'unsigned' | 'signed' | 'pointer' | 'unknown' {
  const s = shapeOf(x);
  if (!s) return 'unknown';
  if (s.stars > 0) return 'pointer';
  if (UNSIGNED_NAMES.has(s.base)) return 'unsigned';
  return SIGNED_NAMES.has(s.base) ? 'signed' : 'unknown';
}

/** The declared types of a function's parameters and locals. */
export function localTypesOf(node: FunctionDecl): Map<string, TypeNode> {
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
  return localTypes;
}

function keyOf(be: BinaryExpr): string | null {
  const a = be.location?.start?.offset, b = be.right.location?.start?.offset;
  if (a === undefined || b === undefined) return null;
  return `${a}:${b}:${be.operator}`;
}

export function createCompareFormTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as CompareFormOptions;
  const sites = o.sites ?? [];
  const decisions = o.decisions ?? [];

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || sites.length === 0 || decisions.length === 0) return undefined;
      const sizeOf = (ord: number) => sites[ord]?.size ?? decisions.find(d => d.ord === ord)?.width ?? 4;

      // The body's comparisons in text order: the operator sits just before its right operand.
      const found = findNodesByKind(node.body, NodeKind.BinaryExpr)
        .map(n => n as BinaryExpr)
        .filter(be => COMPARISON.has(be.operator));
      const keyed = found.map(be => ({ be, key: keyOf(be) }));
      const located = keyed.every(k => k.key !== null);
      keyed.sort((a, b) => (a.be.right.location?.start?.offset ?? 0) - (b.be.right.location?.start?.offset ?? 0));

      const localTypes = localTypesOf(node);
      const declared = new Set(localTypes.keys());
      const matches = (be: BinaryExpr, d: CompareFormDecision) =>
        be.operator === d.text
        && fitsFingerprint(be.left, d.fp[0], d.width, declared)
        && fitsFingerprint(be.right, d.fp[1], d.width, declared);

      // Tie each decision to a node key.
      const tied = new Map<string, CompareFormDecision>();
      const zipped = located && keyed.length === sites.length;
      if (zipped) {
        for (const d of decisions) {
          const k = keyed[d.ord];
          if (k && matches(k.be, d)) tied.set(k.key!, d);
        }
      } else if (located) {
        const sig = (text: string, fp: [string, string]) => `${text}|${fp[0]}|${fp[1]}`;
        const siteCount = new Map<string, number>();
        for (const s of sites) siteCount.set(sig(s.text, s.fp), (siteCount.get(sig(s.text, s.fp)) ?? 0) + 1);
        for (const d of decisions) {
          if (siteCount.get(sig(d.text, d.fp)) !== 1) continue;
          const hits = keyed.filter(k => matches(k.be, d));
          if (hits.length === 1) tied.set(hits[0].key!, d);
        }
      }

      let rewritten = 0;
      const shapeOf = createExprShape(localTypes, {});
      const inner = createTransformer({
        visitBinaryExpr(be: BinaryExpr): ASTNode | undefined {
          const key = keyOf(be);
          const d = key ? tied.get(key) : undefined;
          if (d?.keep) {
            const out = byteCompareWithOne(be, d);
            if (out) rewritten++;
            return out ?? undefined;
          }
          if (!d || !d.op) return undefined;
          const out = rewrite(be, d, sizeOf(d.ord), shapeOf);
          if (out) rewritten++;
          return out ?? undefined;
        },
      });
      const body = inner(node.body);
      o.onCensus?.({ tied: tied.size, rewritten, untied: decisions.length - tied.size, zipped });
      return rewritten > 0 ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/**
 * `b == true` / `b != true` where the instruction is `CMP <byte>, 1`: the constant is written
 * `1`. Both compare the promoted byte with 1, so the value is the same; written `true`,
 * boolean-cleanup folds it to `b` / `!b`, which VC8 compiles as `CMP <byte>, 0` with the
 * branch inverted - the same test only while the byte holds 0 or 1, and not the original's
 * instruction. Q06_SequenceFilter 005968e0 compares one flag of a struct with 1 and the next
 * with 0 in one condition, so this follows the instruction at each site, never the type.
 */
function byteCompareWithOne(be: BinaryExpr, d: CompareFormDecision): BinaryExpr | null {
  if (d.width !== 1 || d.k !== 1 || (be.operator !== '==' && be.operator !== '!=')) return null;
  const r = unwrapParens(be.right);
  if (r.kind !== NodeKind.BoolLiteral || !(r as BoolLiteralExpr).value) return null;
  const one: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral, value: 1n, suffix: '', base: 10, raw: '1',
    location: be.right.location, leadingTrivia: be.right.leadingTrivia, trailingTrivia: be.right.trailingTrivia,
  } as IntegerLiteralExpr;
  return updateNode(be, { right: one, ghidraInfo: { ...(be.ghidraInfo ?? {}), originalAddress: `0x${d.address}` } } as Partial<BinaryExpr>);
}

/** The rewritten comparison, or null when a check fails. */
function rewrite(be: BinaryExpr, d: CompareFormDecision, size: number, shapeOf: ExprShape): BinaryExpr | null {
  let left = d.swap ? be.right : be.left;
  let right = d.swap ? be.left : be.right;
  const delta = d.delta ?? 0;
  let crossed = false;
  if (d.k !== undefined && (delta !== 0 || d.unsigned)) {
    // The constant is the written right operand; it must be a bare literal the
    // instructions agree with.
    const c = literalOf(right);
    if (!c) return null;
    const bits = BigInt(8 * size);
    const mod = ((c.value % (1n << bits)) + (1n << bits)) % (1n << bits);
    if (mod !== BigInt(d.k)) return null;
    if (delta !== 0) {
      let next = steppedConstant(c.lit, c.value, delta);
      if (next === null && d.signed && operandSignedness(left, shapeOf) === 'signed') {
        next = steppedConstant(c.lit, c.value, delta, true);
        if (next !== null) crossed = true;
      }
      if (next === null) return null;
      right = spellLiteral(c.lit, next, right);
    }
  }
  const info = { ...(be.ghidraInfo ?? {}), originalAddress: `0x${d.address}` };
  if (crossed) info.signedCompareWidth = d.width;
  if (d.unsigned) {
    if (literalOf(right)?.value !== 0n) return null;
    const s = operandSignedness(left, shapeOf);
    if (s === 'pointer') return null;
    if (s !== 'unsigned') left = compareCast(left, d.width);
    info.unsignedCompareWidth = d.width;
  }
  // Swapped operands leave their trivia behind: it belonged to the position.
  if (d.swap) {
    left = { ...left, leadingTrivia: be.left.leadingTrivia, trailingTrivia: be.left.trailingTrivia };
    right = { ...right, leadingTrivia: be.right.leadingTrivia, trailingTrivia: be.right.trailingTrivia };
  }
  return updateNode(be, { operator: d.op as BinaryOperator, left, right, ghidraInfo: info } as Partial<BinaryExpr>);
}

export const compareFormPlugin: TransformPlugin = createPlugin(
  'compare-form',
  'Compare Form',
  'A comparison takes the operator, constant and operand order its CMP/TEST and Jcc show',
  (options?: PluginOptions) => createCompareFormTransformer(options),
  {
    priority: 3, // before any pass reshapes the printed comparisons the decisions are tied to
    defaultEnabled: true,
    tags: ['fidelity'],
    version: '1.0.0',
  },
);

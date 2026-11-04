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
 *    operand again against the final types;
 *  - `X == 0`/`X != 0` becomes `X < 1`/`X >= 1` (`CMP X,1; JB/JAE`) only where X is declared
 *    unsigned: no cast is written, since a signed X would mean the type is wrong, not the
 *    compare. The node is tagged the same way;
 *  - a character literal steps like an integer one while it stays within 0..0x7f, where its
 *    value is the same whether char is signed or not; the stepped value is written as a
 *    character where it is a printable one, else as a decimal integer, which compares the
 *    same after promotion (`c == '\0'` -> `c < 1`, `'/' < c` -> `c >= '0'`).
 *  - an enum member steps to the member of the same enum worth exactly one more or less
 *    (`eType < UNIT_OBJECT` -> `eType <= UNIT_MONSTER`), when exactly one member has that
 *    value and its bare name means only it. Both values stay within 0..0x7fffffff, so the
 *    step wraps in neither domain. No such member, no rewrite: a literal is never invented
 *    for an enum-typed comparison.
 * Any other constant side that is not a bare literal (a cast pointer) only swaps.
 *
 * Every tied comparison, rewritten or kept as printed, also carries what its instructions
 * say for the passes that run on the final types: the CMP's width (`compareWidth`), read by
 * `narrow-local-widen`, and where a signed Jcc reads the flags its width (`signedJccWidth`),
 * read by `compare-signedness`. Recording them changes nothing in the text.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, BinaryOperator, BoolLiteralExpr, BuiltinType, ReturnStmt, CharLiteralExpr, CStyleCastExpr, Expression, FunctionDecl, Identifier,
  IntegerLiteralExpr, MemberExpr, ParameterDecl, ParenExpr, SubscriptExpr, TypeNode, TypedefType, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape, type ExprShape, type ExprShapeTables } from './expr-shape.js';
import { unwrapParens } from './call-arg-cast.js';
import { Expr } from '../../../ast/factory.js';
import { fieldRead, nullTest, pointeeName, type NullGetterTable } from './null-getter.js';

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
  /**
   * An unsigned op read by a signed Jcc: written only where the operand is a sum of values
   * zero-extended from 8 or 16 bits, so it is non-negative and the two compares agree.
   */
  zextSum?: boolean;
  /** The flags are read by a SETcc: the compare's 0/1 is a value, not a branch. */
  set?: boolean;
  /** An equality kept as printed whose operand the instructions loaded into a register before the CMP. */
  load?: boolean;
}

export interface CompareFormOptions extends PluginOptions {
  /** The type tables an operand's declared signedness is read from (as compare-signedness). */
  enumTypes?: string[];
  /** Enum constant -> the enum declaring it, for names only one enum declares. */
  enumConstantTypes?: Record<string, string>;
  /** Enum name -> member name -> value: where a stepped enum constant finds its neighbour. */
  enumMemberValues?: Record<string, Record<string, number>>;
  /**
   * Whether every enum declaring a member name gives it 0. The caller's answer, so it can
   * record which names a function's text depended on; absent: read from enumMemberValues.
   */
  zeroEnumMember?: (name: string) => boolean;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Every comparison token of the decompile, in text order. */
  sites?: Array<{ text: string; fp: [string, string]; size?: number }>;
  decisions?: CompareFormDecision[];
  /**
   * The null default of each field read through a null-guarded getter (`null-getter.ts`),
   * keyed `<pointee type>|<member path>`.
   */
  nullGetters?: NullGetterTable;
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

/**
 * A bare literal, or `-literal`, as its signed value; null otherwise. A plain character
 * literal of 0..0x7f counts, as an unsuffixed decimal of its value with `char` set: its
 * value is the same whether char is signed or not.
 */
function literalOf(e: Expression): { value: bigint; lit: IntegerLiteralExpr; char?: CharLiteralExpr } | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return { value: (x as IntegerLiteralExpr).value, lit: x as IntegerLiteralExpr };
  if (x.kind === NodeKind.CharLiteral) {
    const c = x as CharLiteralExpr;
    if (c.prefix || c.value < 0 || c.value > 0x7f) return null;
    const lit = { kind: NodeKind.IntegerLiteral, value: BigInt(c.value), raw: String(c.value), base: 10, suffix: '', location: c.location } as IntegerLiteralExpr;
    return { value: BigInt(c.value), lit, char: c };
  }
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

/**
 * A character value 0..0x7f as a literal: a character literal where it prints as itself,
 * else a decimal integer, which compares the same after promotion.
 */
export function spellCharValue(value: bigint, at: ASTNode): Expression {
  const loc = { location: at.location, leadingTrivia: [], trailingTrivia: [] };
  if (value >= 0x20n && value <= 0x7en) {
    const ch = String.fromCharCode(Number(value));
    const raw = ch === "'" || ch === '\\' ? `'\\${ch}'` : `'${ch}'`;
    return { kind: NodeKind.CharLiteral, value: Number(value), prefix: '', raw, ...loc } as CharLiteralExpr;
  }
  return { kind: NodeKind.IntegerLiteral, value, raw: value.toString(10), base: 10, suffix: '', ...loc } as IntegerLiteralExpr;
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
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const tables: ExprShapeTables = {
    globalTypes: o.globalTypes ?? {},
    enclosingVarTypes: o.enclosingVarTypes ?? {},
    structFields: o.structFields ?? {},
    fieldTypes: o.fieldTypes ?? {},
    returnTypes: o.functionReturnTypes ?? {},
    // An enum is not unsigned whatever it is spelled with.
    resolve: name => (enumTypes.has(name) ? undefined : typedefTargets[name]),
  };

  const enumStep = enumStepper(o.enumConstantTypes ?? {}, o.enumMemberValues ?? {});
  const zeroEnum = zeroEnumConstant(o.zeroEnumMember ?? memberIsZeroEverywhere(o.enumMemberValues ?? {}));

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
      let tagged = 0;
      const shapeOf = createExprShape(localTypes, tables);
      const boolReturn = node.returnType.kind === NodeKind.BuiltinType
        && (node.returnType as BuiltinType).name === 'bool' && (node.returnType as BuiltinType).modifiers.length === 0;
      const inner = createTransformer({
        visitReturnStmt(rs: ReturnStmt): ASTNode | undefined {
          if (!boolReturn || !rs.value) return undefined;
          const out = setReturn(rs.value, tied, shapeOf);
          if (!out) return undefined;
          rewritten++;
          return updateNode(rs, { value: out } as Partial<ReturnStmt>);
        },
        visitBinaryExpr(be: BinaryExpr): ASTNode | undefined {
          if ((be.operator === '&&' || be.operator === '||') && o.nullGetters) {
            const out = getterChain(be, tied, o.nullGetters, localTypes);
            if (out) rewritten++;
            return out ?? undefined;
          }
          const key = keyOf(be);
          const d = key ? tied.get(key) : undefined;
          if (!d) {
            const z = signedZeroForm(be, shapeOf);
            if (z) rewritten++;
            return z ?? undefined;
          }
          let out: BinaryExpr | null = null;
          if (d.keep) out = byteCompareWithOne(be, d);
          else if (d.op) out = rewrite(be, d, sizeOf(d.ord), shapeOf, enumStep, zeroEnum);
          if (out) rewritten++;
          const facts = withMachineFacts(out ?? be, d);
          if (facts !== (out ?? be)) tagged++;
          return facts === be ? undefined : facts;
        },
      });
      const body = inner(node.body);
      o.onCensus?.({ tied: tied.size, rewritten, untied: decisions.length - tied.size, zipped });
      return rewritten > 0 || tagged > 0 ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

/** The operands of a chain of one logical operator, through parentheses. */
/**
 * `-1 < X` (or `X > -1`) that no CMP was tied to: `X >= 0`. Ghidra prints a signed `X >= 0`
 * that way; the tied decisions take every compare the instructions make against -1, so an
 * untied one is a sign test whose flags come from a TEST or an earlier compare against 0
 * (OnMouseWheel 004bc050: `jge` on the flags of the `> 0` test before it). Written `-1 < X`,
 * VC8 compares again (`cmp ax, 0xffff`). Value-preserving for a signed X: `-1 < X` holds for
 * exactly the X that are not negative. An X of any other type (unsigned, a pointer, unknown)
 * keeps its spelling.
 */
function signedZeroForm(be: BinaryExpr, shapeOf: ExprShape): BinaryExpr | null {
  let x: Expression | null = null;
  const minusOne = (e: Expression) => {
    const c = literalOf(e);
    return !!c && c.value === -1n && !c.char && !c.lit.suffix;
  };
  if (be.operator === '<' && minusOne(be.left)) x = be.right;
  else if (be.operator === '>' && minusOne(be.right)) x = be.left;
  if (!x || operandSignedness(x, shapeOf) !== 'signed') return null;
  const zero = Expr.intLiteral(0);
  zero.location = (be.operator === '<' ? be.left : be.right).location;
  const info = { ...(be.ghidraInfo ?? {}), signedCompareWidth: 4 };
  return updateNode(be, { operator: '>=' as BinaryOperator, left: x, right: zero, ghidraInfo: info } as Partial<BinaryExpr>);
}

function logicalOperands(e: Expression, op: '&&' | '||'): Expression[] {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === op) {
    return [...logicalOperands((u as BinaryExpr).left, op), ...logicalOperands((u as BinaryExpr).right, op)];
  }
  return [e];
}

/**
 * `p && p->f == K` (or `!p || p->f != K`), where the instructions load the field into a
 * register before the CMP, as the getter the source called: `(p ? p->f : D) == K`, D the
 * field's null default from the original's own getters (`null-getter.ts`). VC8 compares the
 * `&&` form against memory (`CMP [p+d],K`); the getter's value goes through a register, and
 * its null arm, a constant other than K, folds into the test of p. The value is the same
 * exactly when D != K, so a field without a known default, or whose default is K, is left.
 * Null when nothing in the chain is that shape.
 */
function getterChain(be: BinaryExpr, tied: Map<string, CompareFormDecision>, table: NullGetterTable,
  localTypes: Map<string, TypeNode>): Expression | null {
  const op = be.operator as '&&' | '||';
  const cmpOp = op === '&&' ? '==' : '!=';
  const list = logicalOperands(be, op);
  const out: Expression[] = [];
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const next = i + 1 < list.length ? unwrapParens(list[i + 1]) : null;
    const t = next ? nullTest(list[i]) : null;
    if (t && next && t.nullWhenTrue === (op === '||') && next.kind === NodeKind.BinaryExpr && (next as BinaryExpr).operator === cmpOp) {
      const c = next as BinaryExpr;
      const key = keyOf(c);
      const d = key ? tied.get(key) : undefined;
      const r = fieldRead(c.left);
      const struct = pointeeName(localTypes.get(t.p.name));
      const def = struct && r ? table[`${struct}|${r.path.join('.')}`] : undefined;
      if (d?.keep && d.load && d.k !== undefined && d.fp[1].startsWith('c:') && r && r.p.name === t.p.name && def) {
        const bits = BigInt(8 * d.width);
        const dv = Number(((BigInt(def.value) % (1n << bits)) + (1n << bits)) % (1n << bits));
        if (dv !== d.k) {
          const dflt = def.name ? Expr.identifier(def.name)
            : def.value < 0 ? Expr.unary('-', Expr.intLiteral(-def.value)) : Expr.intLiteral(def.value);
          const pick = Expr.paren({
            ...Expr.conditional({ ...t.p, leadingTrivia: [], trailingTrivia: [] }, c.left, dflt),
            ghidraInfo: { nullGetter: true },
          } as Expression);
          const cmp = updateNode(c, { left: pick, ghidraInfo: { ...(c.ghidraInfo ?? {}), originalAddress: `0x${d.address}` } } as Partial<BinaryExpr>);
          out.push(Expr.paren(cmp));
          i++;
          changed = true;
          continue;
        }
      }
    }
    out.push(list[i]);
  }
  if (!changed) return null;
  if (out.length === 1) return { ...out[0], leadingTrivia: be.leadingTrivia, trailingTrivia: be.trailingTrivia } as Expression;
  let acc = out[0];
  for (let k = 1; k < out.length; k++) acc = Expr.binary(acc, op, out[k]);
  return { ...acc, leadingTrivia: be.leadingTrivia, trailingTrivia: be.trailingTrivia } as Expression;
}

/**
 * `return x != 0;` in a function returning `bool`, where the instructions set the result
 * with `TEST x,x; SETNE`: the source returned `x` and let the conversion to bool test it
 * (CheckModule 00480020). Written `x != 0`, VC8 computes the 0/1 with NEG/SBB/NEG instead.
 * `bool(x)` is `x != 0` for an integer or a pointer, so the value is the same; a floating
 * operand, or one whose type is unknown, is left alone.
 */
function setReturn(value: Expression, tied: Map<string, CompareFormDecision>, shapeOf: ExprShape): Expression | null {
  const be = unwrapParens(value);
  if (be.kind !== NodeKind.BinaryExpr) return null;
  const b = be as BinaryExpr;
  const key = keyOf(b);
  const d = key ? tied.get(key) : undefined;
  if (!d || !d.keep || !d.set || d.k !== 0 || b.operator !== '!=') return null;
  const lit = literalOf(b.right);
  if (!lit || lit.value !== 0n || lit.char) return null;
  const shape = shapeOf(unwrapParens(b.left));
  if (!shape) return null;
  if (shape.stars === 0 && !/^(?:u?int(?:8|16|32)_t|BOOL|BYTE|WORD|DWORD|UINT|uint|int|char|short|long|bool|unsigned|unsigned int|unsigned char|unsigned short|ushort|uchar|ulong|byte|word|dword|LONG|SHORT|USHORT|UCHAR|ULONG)$/.test(shape.base)) return null;
  return { ...b.left, leadingTrivia: value.leadingTrivia, trailingTrivia: value.trailingTrivia } as Expression;
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

/**
 * The comparison with what its instructions say about it recorded on the node: the CMP's
 * width (`compareWidth`) and, where a JL/JLE/JG/JGE reads the flags, the width of that
 * signed compare (`signedJccWidth`). Later passes judge them against the final types:
 * `compare-signedness` keeps a signed compare signed, `narrow-local-widen` widens a local
 * the original compared at a width its declaration does not have. Nothing else changes.
 */
function withMachineFacts(be: BinaryExpr, d: CompareFormDecision): BinaryExpr {
  const info = be.ghidraInfo ?? {};
  const signed = d.signed ? d.width : undefined;
  if (info.compareWidth === d.width && info.signedJccWidth === signed) return be;
  const next = { ...info, compareWidth: d.width } as NonNullable<BinaryExpr['ghidraInfo']>;
  if (signed !== undefined) next.signedJccWidth = signed;
  return updateNode(be, { ghidraInfo: next } as Partial<BinaryExpr>);
}

/** The rewritten comparison, or null when a check fails. */
/**
 * `(uint)a + (uint)b` with a and b of 8- or 16-bit unsigned types, as `a + b`: the sum then
 * is an int in 0..0x1fffe, the same value, so a signed compare of it with a constant in
 * 0..0x7fffffff is the unsigned one. Null for anything else.
 */
function narrowZextSum(e: Expression, shapeOf: ExprShape): Expression | null {
  const s = unwrapParens(e);
  if (s.kind !== NodeKind.BinaryExpr || (s as BinaryExpr).operator !== '+') return null;
  const NARROW = /^(?:uint8_t|uint16_t|BYTE|WORD|byte|word|uchar|ushort|USHORT|UCHAR|unsigned char|unsigned short)$/;
  const strip = (x: Expression): Expression | null => {
    const c = unwrapParens(x);
    if (c.kind !== NodeKind.CStyleCastExpr) return null;
    const inner = (c as CStyleCastExpr).expression;
    const shape = shapeOf(unwrapParens(inner));
    if (!shape || shape.stars !== 0 || !NARROW.test(shape.base)) return null;
    return inner;
  };
  const a = strip((s as BinaryExpr).left), b = strip((s as BinaryExpr).right);
  if (!a || !b) return null;
  return Expr.binary(a, '+', b);
}

/**
 * Whether `e` is a bare enum member worth 0 in every enum that declares the name, so that
 * whichever one the name binds to it is 0 (`ELEMENTAL_NONE`, which two enums declare).
 */
function zeroEnumConstant(isZero: (name: string) => boolean): (e: Expression) => boolean {
  return e => {
    const x = unwrapParens(e);
    return x.kind === NodeKind.Identifier && isZero((x as Identifier).name);
  };
}

/** Whether every enum in `memberValues` that declares the name gives it 0. */
function memberIsZeroEverywhere(memberValues: Record<string, Record<string, number>>): (name: string) => boolean {
  let values: Map<string, Set<number>> | undefined;
  return name => {
    if (!values) {
      values = new Map();
      for (const members of Object.values(memberValues)) {
        for (const [n, v] of Object.entries(members)) {
          let set = values.get(n);
          if (!set) values.set(n, set = new Set());
          set.add(v);
        }
      }
    }
    const set = values.get(name);
    return !!set && set.size === 1 && set.has(0);
  };
}

/** An enum constant's neighbour: the member of its enum worth `value + delta`. */
type EnumStep = (e: Expression, k: number, size: number, delta: number) => Expression | null;

function enumStepper(constantTypes: Record<string, string>, memberValues: Record<string, Record<string, number>>): EnumStep {
  return (e, k, size, delta) => {
    const x = unwrapParens(e);
    if (x.kind !== NodeKind.Identifier) return null;
    const name = (x as Identifier).name;
    const owner = constantTypes[name];
    const members = owner ? memberValues[owner] : undefined;
    const value = members?.[name];
    if (value === undefined) return null;
    const bits = BigInt(8 * size);
    const mod = ((BigInt(value) % (1n << bits)) + (1n << bits)) % (1n << bits);
    if (mod !== BigInt(k)) return null;
    const next = value + delta;
    if (value < 0 || next < 0 || value > 0x7fffffff || next > 0x7fffffff) return null;
    const names = Object.entries(members!).filter(([, v]) => v === next).map(([n]) => n);
    if (names.length !== 1 || constantTypes[names[0]] !== owner) return null;
    return { ...(x as Identifier), name: names[0], location: e.location, leadingTrivia: [], trailingTrivia: [] } as Identifier;
  };
}

function rewrite(be: BinaryExpr, d: CompareFormDecision, size: number, shapeOf: ExprShape, enumStep?: EnumStep,
  zeroEnum?: (e: Expression) => boolean): BinaryExpr | null {
  let left = d.swap ? be.right : be.left;
  let right = d.swap ? be.left : be.right;
  if (d.zextSum) {
    const sum = narrowZextSum(left, shapeOf);
    const c = literalOf(right);
    if (!sum || !c || c.value < 0n || c.value > 0x7fffffffn || c.lit.suffix) return null;
    left = sum;
  }
  const delta = d.delta ?? 0;
  let crossed = false;
  if (d.k !== undefined && (delta !== 0 || d.unsigned)) {
    // The constant is the written right operand; it must be a bare literal the
    // instructions agree with, or an enum member stepping to its neighbour.
    const c = literalOf(right);
    if (!c && d.unsigned && delta === 0 && d.k === 0 && zeroEnum?.(right)) {
      // `X <= 0` / `X > 0` against an enum member worth 0 keeps the member.
    } else if (!c) {
      // `X <= 0` / `X < 1` need the literal they write.
      const stepped = delta !== 0 && !d.unsigned && enumStep ? enumStep(right, d.k, size, delta) : null;
      if (!stepped) return null;
      right = stepped;
    } else {
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
        if (c.char) {
          if (next < 0n || next > 0x7fn) return null;
          right = spellCharValue(next, right);
        } else {
          right = spellLiteral(c.lit, next, right);
        }
      }
    }
  }
  const info = { ...(be.ghidraInfo ?? {}), originalAddress: `0x${d.address}` };
  if (crossed) info.signedCompareWidth = d.width;
  if (d.unsigned) {
    const s = operandSignedness(left, shapeOf);
    if (s === 'pointer') return null;
    if (delta === 0) {
      // `X <= 0` / `X > 0`.
      if (literalOf(right)?.value !== 0n && !zeroEnum?.(right)) return null;
      if (s !== 'unsigned') left = compareCast(left, d.width);
    } else {
      // `X < 1` / `X >= 1`: the operand must already be unsigned.
      if (delta !== 1 || literalOf(right)?.value !== 1n || s !== 'unsigned') return null;
    }
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

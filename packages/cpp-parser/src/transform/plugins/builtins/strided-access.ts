/**
 * Strided Access Plugin
 *
 * MSVC strength-reduces `T[i].f` in a loop into a byte-offset register that
 * steps by `sizeof(T)`, and folds `n * sizeof(T)` into a three-term address with
 * an interior constant. Neither form is something a Ghidra type can say, so the
 * decompiler prints the address as integer arithmetic, parks the offset inside
 * the nearest array field, and loses the field's type:
 *
 *   do {                                           // LoadDataForGame 0044d9f0
 *     if (*(code **)((int)ClientInitFunctions + initIndex)) ...
 *     initIndex = initIndex + 4;
 *   } while (initIndex < 0xd0);
 *
 *   *(code **)(pCurrentTable->szSubImage1Path + nMouseX + -0x10)   // DRAW_EscMenu 0047e3d0,
 *   ... nMouseX = nMouseX + 0x550; nItemIndex = nItemIndex + 1;    // sizeof == 0x550
 *
 *   *(code **)(nMenuEntryByteOffset + 0x726c5a + nOptionIdx * 4)   // NPCMENU_ConfigureMenuOption
 *                                    // nMenuEntryByteOffset = nNpcMenuOptionId * 0x27
 *
 * This pass recovers the access path the source wrote - `ClientInitFunctions[i]`,
 * `gpEscMenuCurrentTable[nItemIndex].fpDrawCallback`,
 * `D2NpcMenuOptions[n].nOptionCallback[i]` - and only where the rewrite is the
 * same address, proven:
 *
 *  1. Every address is evaluated as `base + K + sum(c_i * t_i)` in bytes, mod 2^32:
 *     one base object (a pointer, or a global array or object), a constant, and
 *     integer terms. Pointer arithmetic is scaled by the pointee's size.
 *  2. An integer local `v` that steps by `a` beside a counter `idx` that steps by
 *     `b` is related to it by `v == (a/b) * idx + d`. The relation is a must-
 *     dataflow fact over the CFG (each of `v`, `idx` and `v - m*idx` is a known
 *     constant or unknown, joined per edge); it is used only at a node where the
 *     fact holds with a known `d`. A POINTER local stepped the same way is related
 *     to an invariant base: `p == B + m*idx + d`. With no counter, an integer
 *     `v` whose every def and every read can be rewritten is RESCALED to the
 *     index itself (`v += 4` -> `v++`, `v < 0xd0` -> `v < 52`).
 *  3. A local whose only reaching definition is `v = n * S`, with `n` unchanged
 *     on every path to the use, is that product.
 *  4. The byte form is resolved against the base's element type, using the
 *     struct layouts: a term whose coefficient is a multiple of the element size
 *     is an index at that level, the constant selects the field, and the
 *     remaining terms must be consumed exactly by an array field's element size
 *     further down. Anything left over, a union, a bitfield, or an offset inside a
 *     scalar field, and the expression is left as it is.
 *
 * The access type is then checked against the field's: the same type, or a
 * function pointer read as Ghidra's `code *` (the field's funcdef replaces it), is
 * the path itself; an integer of the same width read as an rvalue is a converting
 * cast; anything else keeps the reinterpretation as `*(T *)&path`.
 *
 * A def of a rewritten offset or pointer that no read is left to reach is dead and
 * goes, and so does a `v = n * S` temporary.
 *
 * Inner subscripts are written as the source would write them (`F[i]`): the index
 * is the one the machine used, which is in range for the shipped data (verified
 * for D2NpcMenuOptions); the pass does not prove bounds.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CaseStmt, CompoundStmt, DeclStmt, DefaultStmt,
  DoWhileStmt, Expression, ExprStmt, ForStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr,
  LabelStmt, MemberExpr, ParameterDecl, ParenExpr, PostfixExpr, QualifiedId, ReturnStmt, Statement,
  SubscriptExpr, SwitchStmt, TypeNode, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { Expr } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/index.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import {
  calleeName, bareName, canonicalBase, shapeOfNode, shapeOfSpelling, typeFromSpelling, unwrapParens,
  type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

/** One field of an aggregate, as Ghidra lays it out. */
export interface StructLayoutField {
  name: string;
  offset: number;
  size: number;
  /** Ghidra's spelling of the field type (`DC6 *[4]`, `pfnEscMenuItemAction *`). */
  type: string;
  /** Present on a bitfield member; such a member is never an access target. */
  bitSize?: number;
}

export interface StridedAccessOptions extends PluginOptions {
  /** Aggregate name → its fields in offset order. */
  structLayouts?: Record<string, StructLayoutField[]>;
  /** Aggregate name → size in bytes. */
  aggregateSizes?: Record<string, number>;
  /** Aggregate name → every member name its emitted declaration carries. */
  aggregateMembers?: Record<string, readonly string[]>;
  /** The aggregates that are unions. */
  unionNames?: readonly string[];
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** Aggregate name → member name → member spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, where unambiguous. */
  fieldTypes?: Record<string, string>;
  /** Function name → return spelling. */
  functionReturnTypes?: Record<string, string>;
  /** Typedef name → what it stands for. */
  typedefTargets?: Record<string, string>;
  /** Names of FUNCTION_DEFINITION typedefs. */
  funcdefNames?: readonly string[];
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
}

// ============================================
// ARITHMETIC MOD 2^32
// ============================================

const TRACE = typeof process !== 'undefined' && process.env?.STRIDED_TRACE === '1';
const trace = (msg: string, extra?: unknown) => { if (TRACE) (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(`${msg}${extra !== undefined ? ' ' + String((extra as Error)?.stack ?? extra) : ''}\n`); };
const MOD = 1n << 32n;
const norm = (v: bigint): bigint => ((v % MOD) + MOD) % MOD;
/** The signed reading of a 32-bit value. */
const signed = (v: bigint): bigint => { const n = norm(v); return n >= (1n << 31n) ? n - MOD : n; };
const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
};

const INTEGER_WIDTH: Record<string, number> = {
  'char': 1, 'signed char': 1, 'unsigned char': 1, 'bool': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2,
  'int': 4, 'unsigned int': 4, 'long': 4, 'unsigned long': 4,
  'long long': 8, 'unsigned long long': 8,
};
const FLOAT_WIDTH: Record<string, number> = { 'float': 4, 'double': 8 };
/** Casts that carry an address through unchanged: integers as wide as a pointer, and byte pointers. */
const ADDRESS_INT_BASES = new Set(['int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t']);
const BYTE_POINTEE = new Set(['char', 'signed char', 'unsigned char', 'void']);

function literal(e: Expression): bigint | null {
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = literal((x as UnaryExpr).operand);
    return v === null ? null : -v;
  }
  return null;
}

// ============================================
// LINEAR ADDRESS FORMS
// ============================================

/** What the address is relative to: the first byte of `expr`'s object (or pointee). */
interface Base {
  /** The expression naming the object: a pointer value, or the array/object itself. */
  expr: Expression;
  /** `ptr`: expr is a pointer to the first element. `array`: expr is an array. `object`: one object. */
  kind: 'ptr' | 'array' | 'object';
  /** The element type spelling, Ghidra style. */
  elem: string;
  /** Root identifier text, for invariance checks and keys. */
  key: string;
}

interface Term {
  key: string;
  /** The expression the term stands for, as written (null for a synthetic index variable). */
  expr: Expression;
  coef: bigint;
  /** Stands for an induction: a counter in a proven relation, or a rescaled offset. */
  rel?: 'idx' | 'rescale';
}

interface Lin {
  base: Base | null;
  k: bigint;
  terms: Term[];
  /** A relation or a product substitution was used: the form says more than the text. */
  derived: boolean;
  /** Identifier nodes of rescaled variables this form consumed. */
  consumed: Identifier[];
}

const linConst = (k: bigint): Lin => ({ base: null, k, terms: [], derived: false, consumed: [] });

function addTerm(terms: Term[], t: Term): Term[] {
  const out = terms.map(x => ({ ...x }));
  const hit = out.find(x => x.key === t.key);
  if (hit) hit.coef = signed(hit.coef + t.coef);
  else out.push({ ...t, coef: signed(t.coef) });
  return out.filter(x => x.coef !== 0n);
}

function linAdd(a: Lin, b: Lin, sign: bigint): Lin | null {
  if (a.base && b.base) return null;
  if (b.base && sign < 0n) return null;
  let terms = a.terms;
  for (const t of b.terms) terms = addTerm(terms, { ...t, coef: t.coef * sign });
  return {
    base: a.base ?? b.base, k: signed(a.k + sign * b.k), terms,
    derived: a.derived || b.derived, consumed: [...a.consumed, ...b.consumed],
  };
}

function linScale(a: Lin, c: bigint): Lin | null {
  if (a.base) return null;
  return {
    base: null, k: signed(a.k * c),
    terms: a.terms.map(t => ({ ...t, coef: signed(t.coef * c) })).filter(t => t.coef !== 0n),
    derived: a.derived, consumed: a.consumed,
  };
}

// ============================================
// INDUCTION RELATIONS
// ============================================

type DefKind =
  | { kind: 'set'; c: bigint }
  | { kind: 'setBase'; lin: Lin }
  | { kind: 'add'; a: bigint }
  | { kind: 'other' };

/** v == base + m * idx + d (bytes for a pointer v, plain value for an integer v). */
interface Relation {
  idx: string;
  m: bigint;
  d: bigint;
  base: Base | null;
  /** Rescaled: v itself becomes the index; `m` is the old step. */
  rescale?: boolean;
}

type AbsVal = bigint | null;  // null = unknown
interface PairState { v: AbsVal; i: AbsVal; d: AbsVal }
const TOP: PairState = { v: null, i: null, d: null };

// ============================================
// TYPE DESCRIPTIONS
// ============================================

interface Ctx {
  layouts: Record<string, StructLayoutField[]>;
  sizes: Record<string, number>;
  members: Record<string, readonly string[]>;
  unions: Set<string>;
  funcdefs: Set<string>;
  resolve: TypedefResolver;
  globalTypes: Record<string, string>;
}

/** Split `T[N]` → {elem: T, count: N}; `T *[N]` → {elem: `T *`, count: N}. */
function arraySpelling(s: string): { elem: string; count: number } | null {
  const m = /^(.*?)\s*\[(\d+)\]\s*((?:\[\d+\]\s*)*)$/.exec(s.trim());
  if (!m) return null;
  return { elem: `${m[1].trim()}${m[3] ? m[3].trim() : ''}`, count: Number(m[2]) };
}

function isPointerSpelling(s: string): boolean {
  return /\*\s*$/.test(s.trim());
}

/** The bare aggregate/typedef name a spelling names, or undefined. */
function nameOf(s: string): string {
  return s.replace(/\b(const|volatile|struct|union|enum)\b/g, '').replace(/^::/, '').trim();
}

/** Follow a typedef to an aggregate or array name, bounded. */
function resolvedName(ctx: Ctx, s: string): string {
  let cur = nameOf(s);
  for (let i = 0; i < 8; i++) {
    if (ctx.layouts[cur] || ctx.sizes[cur] !== undefined) return cur;
    const t = ctx.resolve(cur);
    if (!t || /[*[]/.test(t)) return cur;
    const next = nameOf(t);
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function sizeOf(ctx: Ctx, spelling: string): number | null {
  const s = spelling.trim();
  const arr = arraySpelling(s);
  if (arr) {
    const e = sizeOf(ctx, arr.elem);
    return e === null ? null : e * arr.count;
  }
  if (isPointerSpelling(s)) return 4;
  const name = resolvedName(ctx, s);
  if (ctx.funcdefs.has(name)) return null;  // a function type itself has no size
  if (ctx.sizes[name] !== undefined) return ctx.sizes[name];
  const base = canonicalBase(name);
  if (INTEGER_WIDTH[base] !== undefined) return INTEGER_WIDTH[base];
  if (FLOAT_WIDTH[base] !== undefined) return FLOAT_WIDTH[base];
  const t = ctx.resolve(name);
  if (t && t !== name && /[*]\s*$/.test(t)) return 4;
  return null;
}

/** The spelling a TypeShape stands for, Ghidra style. */
function spellingOfShape(s: TypeShape): string {
  return `${s.base}${s.stars > 0 ? ' ' + '*'.repeat(s.stars) : ''}`;
}

// ============================================
// THE PASS
// ============================================

type Step = { kind: 'field'; name: string } | { kind: 'index'; terms: Term[]; k: bigint };

interface Resolved {
  base: Base;
  index0: { terms: Term[]; k: bigint };
  steps: Step[];
  /** Spelling of the type the path ends at. */
  type: string;
}

function resolvePath(ctx: Ctx, lin: Lin, fits?: (type: string) => boolean): Resolved | null {
  const base = lin.base;
  if (!base) return null;
  const elemSize = sizeOf(ctx, base.elem);
  if (!elemSize || elemSize <= 0) return null;
  const S = BigInt(elemSize);
  const idx: Term[] = [];
  let rest: Term[] = [];
  for (const t of lin.terms) {
    if (t.coef % S === 0n) idx.push({ ...t, coef: t.coef / S });
    else rest.push(t);
  }
  const k0 = floorDiv(lin.k, S);
  let r = lin.k - k0 * S;
  if (base.kind === 'object' && (idx.length > 0 || k0 !== 0n)) return null;
  const steps: Step[] = [];
  let type = base.elem;
  for (let depth = 0; depth < 8; depth++) {
    if (rest.length === 0 && r === 0n) {
      // The access may be of the FIRST member rather than the whole aggregate
      // (`*(uint *)&item` is item.nMenuItemType at +0): descend through offset 0
      // while the type does not fit. An array's first element, a struct's member
      // at 0 - never a union, whose members all sit there.
      if (!fits || fits(type)) return { base, index0: { terms: idx, k: k0 }, steps, type };
      const arr0 = arraySpelling(type);
      if (arr0) {
        steps.push({ kind: 'index', terms: [], k: 0n });
        type = arr0.elem;
        continue;
      }
      const n0 = resolvedName(ctx, type);
      const f0 = ctx.unions.has(n0) ? undefined
        : ctx.layouts[n0]?.filter(f => f.offset === 0 && f.bitSize === undefined && f.size > 0);
      if (!f0 || f0.length !== 1 || !f0[0].name || !(ctx.members[n0]?.includes(f0[0].name) ?? false)) {
        return { base, index0: { terms: idx, k: k0 }, steps, type };
      }
      steps.push({ kind: 'field', name: f0[0].name });
      type = f0[0].type;
      continue;
    }
    const arr = arraySpelling(type);
    if (arr) {
      const w = sizeOf(ctx, arr.elem);
      if (!w) return null;
      const W = BigInt(w);
      const inner: Term[] = [];
      const deeper: Term[] = [];
      for (const t of rest) {
        if (t.coef % W === 0n) inner.push({ ...t, coef: t.coef / W });
        else deeper.push(t);
      }
      const k = floorDiv(r, W);
      steps.push({ kind: 'index', terms: inner, k });
      r -= k * W;
      rest = deeper;
      type = arr.elem;
      continue;
    }
    if (isPointerSpelling(type)) return null;
    const name = resolvedName(ctx, type);
    if (ctx.unions.has(name)) return null;
    const fields = ctx.layouts[name];
    if (!fields) return null;
    const hits = fields.filter(f => f.bitSize === undefined && BigInt(f.offset) <= r && r < BigInt(f.offset + f.size));
    if (hits.length !== 1) return null;
    const f = hits[0];
    if (!f.name || !(ctx.members[name]?.includes(f.name) ?? false)) return null;
    steps.push({ kind: 'field', name: f.name });
    r -= BigInt(f.offset);
    type = f.type;
  }
  return null;
}

/** Spell `sum(coef * expr) + k` as an index expression. */
function indexExpr(terms: Term[], k: bigint, rewrite: (e: Expression) => Expression): Expression {
  let out: Expression | null = null;
  const push = (e: Expression, negative: boolean) => {
    if (!out) { out = negative ? Expr.neg(e) : e; return; }
    out = Expr.binary(out, negative ? '-' : '+', e);
  };
  for (const t of terms) {
    const c = t.coef < 0n ? -t.coef : t.coef;
    const base = rewrite(t.expr);
    const operand = needsParens(base) ? Expr.paren(base) : base;
    push(c === 1n ? base : Expr.binary(operand, '*', Expr.intLiteral(c)), t.coef < 0n);
  }
  if (!out) return k < 0n ? Expr.neg(Expr.intLiteral(-k)) : Expr.intLiteral(k);
  if (k !== 0n) push(Expr.intLiteral(k < 0n ? -k : k), k < 0n);
  return out;
}

function needsParens(e: Expression): boolean {
  return e.kind === NodeKind.BinaryExpr || e.kind === NodeKind.ConditionalExpr || e.kind === NodeKind.AssignExpr;
}

function renderPath(res: Resolved, rewrite: (e: Expression) => Expression): Expression {
  let cur: Expression;
  const b = res.base;
  const baseExpr = rewrite(b.expr);
  const zero = res.index0.terms.length === 0 && res.index0.k === 0n;
  if (b.kind === 'object') {
    cur = baseExpr;
  } else if (b.kind === 'ptr' && zero && res.steps.length > 0 && res.steps[0].kind === 'field') {
    // `p->f` - the element at index 0 through a pointer.
    const first = res.steps[0];
    cur = Expr.member(needsParens(baseExpr) ? Expr.paren(baseExpr) : baseExpr, first.name, true);
    return renderSteps(cur, res.steps.slice(1), rewrite);
  } else {
    cur = Expr.subscript(needsParens(baseExpr) ? Expr.paren(baseExpr) : baseExpr, indexExpr(res.index0.terms, res.index0.k, rewrite));
  }
  return renderSteps(cur, res.steps, rewrite);
}

function renderSteps(start: Expression, steps: Step[], rewrite: (e: Expression) => Expression): Expression {
  let cur = start;
  for (const s of steps) {
    if (s.kind === 'field') cur = Expr.member(cur, s.name, false);
    else cur = Expr.subscript(cur, indexExpr(s.terms, s.k, rewrite));
  }
  return cur;
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

function exprKey(e: Expression): string {
  try { return emit(e as never).replace(/\s+/g, ' ').trim(); } catch { return `#${Math.random()}`; }
}

/** Every Identifier object named `name` in `root`. */
function identifiersNamed(root: unknown, name: string): Identifier[] {
  const out: Identifier[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.Identifier && (n as Identifier).name === name) out.push(n as Identifier);
    if (n.kind === NodeKind.VariableDecl) {
      // The declarator is not a read.
      const v = n as VariableDecl;
      walk(v.initializer);
      return;
    }
    if (n.kind === NodeKind.MemberExpr) {
      walk((n as MemberExpr).object);
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(root);
  return out;
}

class FunctionPass {
  private flow: FunctionFlow;
  private shape: ExprShape;
  private relCache = new Map<string, Array<PairState | undefined>>();
  private defCache = new Map<string, Map<number, DefKind>>();
  private exprNode = new Map<object, number>();
  private relationsUsed = new Set<string>();
  private productsUsed = new Set<string>();
  /** Rescale candidates still allowed. */
  private rescalable: Set<string>;
  private consumed = new Map<string, Set<Identifier>>();
  private changed = false;

  constructor(
    private ctx: Ctx,
    private body: Statement[],
    private localTypes: Map<string, TypeNode>,
    private o: StridedAccessOptions,
    rescalable: Set<string>,
  ) {
    this.rescalable = rescalable;
    this.flow = buildFunctionFlow(body, new Set(localTypes.keys()));
    this.shape = createExprShape(localTypes, {
      globalTypes: o.globalTypes, enclosingVarTypes: o.enclosingVarTypes, structFields: o.structFields,
      fieldTypes: o.fieldTypes, returnTypes: o.functionReturnTypes, resolve: ctx.resolve,
    });
    for (const n of this.flow.cfg.nodes) if (n.expr) this.exprNode.set(n.expr, n.id);
  }

  // ---------------- types of locals ----------------

  private localShape(name: string): TypeShape | null {
    const t = this.localTypes.get(name);
    return t ? shapeOfNode(t, 0, this.ctx.resolve) : null;
  }

  private isIntLocal(name: string): boolean {
    if (this.flow.isEscaped(name)) return false;
    const s = this.localShape(name);
    return !!s && s.stars === 0 && INTEGER_WIDTH[canonicalBase(s.base)] === 4;
  }

  private isPtrLocal(name: string): boolean {
    if (this.flow.isEscaped(name)) return false;
    const s = this.localShape(name);
    return !!s && s.stars > 0;
  }

  // ---------------- definitions ----------------

  private defsOf(v: string): Map<number, DefKind> {
    const hit = this.defCache.get(v);
    if (hit) return hit;
    const out = new Map<number, DefKind>();
    // Registered before classifying: a def's right-hand side may name `v` itself.
    this.defCache.set(v, out);
    for (const n of this.flow.cfg.nodes) {
      if (!this.flow.writes(n.id).has(v)) continue;
      // The dataflow counts `p[i] = x` as a partial write of `p`, which is right for
      // a local array and wrong for a pointer: the pointer's value is unchanged.
      if (this.isPtrLocal(v) && !this.directlyWrites(n.id, v)) continue;
      out.set(n.id, this.classify(n.id, v));
    }
    this.defCache.set(v, out);
    return out;
  }

  /** Does the node assign `v` itself (not through it)? */
  private directlyWrites(node: number, v: string): boolean {
    const n = this.flow.cfg.nodes[node];
    if (!n.stmt && !n.expr) return true;
    const isV = (e: Expression) => { const x = unwrapParens(e); return x.kind === NodeKind.Identifier && (x as Identifier).name === v; };
    let hit = false;
    const walk = (x: unknown): void => {
      if (hit) return;
      if (Array.isArray(x)) { for (const i of x) walk(i); return; }
      if (!x || typeof x !== 'object') return;
      const a = x as ASTNode;
      if (a.kind === NodeKind.AssignExpr && isV((a as AssignExpr).left)) { hit = true; return; }
      if ((a.kind === NodeKind.PostfixExpr || (a.kind === NodeKind.UnaryExpr && ['++', '--', '&'].includes((a as UnaryExpr).operator)))
          && isV((a as PostfixExpr).operand)) { hit = true; return; }
      if (a.kind === NodeKind.VariableDecl && (a as VariableDecl).name.name === v) { hit = true; return; }
      // Bodies of nested statements belong to their own nodes.
      if (a !== n.stmt && (a.kind === NodeKind.CompoundStmt || a.kind === NodeKind.IfStmt || a.kind === NodeKind.WhileStmt
          || a.kind === NodeKind.DoWhileStmt || a.kind === NodeKind.ForStmt || a.kind === NodeKind.SwitchStmt)) return;
      for (const [k, val] of Object.entries(a)) {
        if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
        if (k === 'thenBranch' || k === 'elseBranch' || k === 'body') continue;
        if (val && typeof val === 'object') walk(val);
      }
    };
    if (n.stmt) {
      const st = innerStmt(n.stmt);
      if (st.kind === NodeKind.ExprStmt || st.kind === NodeKind.DeclStmt || st.kind === NodeKind.ReturnStmt) walk(st);
      else for (const e of this.flow.ownExprs(node)) walk(e);
      // A statement kind the dataflow does not model may do anything.
      if (st.kind === NodeKind.TryStmt || st.kind === NodeKind.ForRangeStmt) return true;
    } else if (n.expr) walk(n.expr);
    return hit;
  }

  private classify(node: number, v: string): DefKind {
    const n = this.flow.cfg.nodes[node];
    const s = n.stmt ? innerStmt(n.stmt) : null;
    const isV = (e: Expression) => { const x = unwrapParens(e); return x.kind === NodeKind.Identifier && (x as Identifier).name === v; };
    const ptrUnit = (): bigint | null => {
      const sh = this.localShape(v);
      if (!sh || sh.stars === 0) return 1n;
      const size = sizeOf(this.ctx, spellingOfShape({ ...sh, stars: sh.stars - 1 }));
      return size ? BigInt(size) : null;
    };
    const fromRhs = (rhs: Expression | null): DefKind => {
      if (!rhs) return { kind: 'other' };
      const c = literal(rhs);
      if (c !== null && this.isIntLocal(v)) return { kind: 'set', c: signed(c) };
      // v = v + c / v = c + v / v = v - c
      const r = unwrapParens(rhs);
      if (r.kind === NodeKind.BinaryExpr) {
        const b = r as BinaryExpr;
        const unit = ptrUnit();
        if (unit === null) return { kind: 'other' };
        if ((b.operator === '+' || b.operator === '-') && isV(b.left)) {
          const c2 = literal(b.right);
          if (c2 !== null) return { kind: 'add', a: signed((b.operator === '-' ? -c2 : c2) * unit) };
        }
        if (b.operator === '+' && isV(b.right)) {
          const c2 = literal(b.left);
          if (c2 !== null) return { kind: 'add', a: signed(c2 * unit) };
        }
      }
      if (this.isPtrLocal(v)) {
        const lin = this.lin(rhs, -1);
        if (lin && lin.base && lin.terms.length === 0 && !lin.derived) return { kind: 'setBase', lin };
      }
      return { kind: 'other' };
    };
    if (!s) return { kind: 'other' };
    if (s.kind === NodeKind.ExprStmt) {
      const e = unwrapParens((s as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && isV((e as AssignExpr).left)) {
        const a = e as AssignExpr;
        if (a.operator === '=') return fromRhs(a.right);
        if (a.operator === '+=' || a.operator === '-=') {
          const c = literal(a.right);
          const unit = ptrUnit();
          if (c !== null && unit !== null) return { kind: 'add', a: signed((a.operator === '-=' ? -c : c) * unit) };
        }
        return { kind: 'other' };
      }
      if ((e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.UnaryExpr) && isV((e as PostfixExpr).operand)) {
        const op = (e as PostfixExpr).operator;
        const unit = ptrUnit();
        if ((op === '++' || op === '--') && unit !== null) return { kind: 'add', a: op === '++' ? unit : -unit };
      }
      return { kind: 'other' };
    }
    if (s.kind === NodeKind.DeclStmt) {
      for (const d of (s as DeclStmt).declarations) {
        if (d.kind !== NodeKind.VariableDecl || (d as VariableDecl).name.name !== v) continue;
        const init = (d as VariableDecl).initializer;
        if (!init || init.kind === NodeKind.InitListExpr) return { kind: 'other' };
        return fromRhs(init as Expression);
      }
    }
    return { kind: 'other' };
  }

  /** The single step of a candidate's adds, or null. */
  private step(v: string): bigint | null {
    let a: bigint | null = null;
    for (const d of this.defsOf(v).values()) {
      if (d.kind !== 'add') continue;
      if (a === null) a = d.a; else if (a !== d.a) return null;
    }
    return a;
  }

  /** Counters: integer locals that step by a single constant. */
  private counters(): string[] {
    const out: string[] = [];
    for (const name of this.localTypes.keys()) {
      if (!this.isIntLocal(name)) continue;
      const b = this.step(name);
      if (b !== null && b !== 0n) out.push(name);
    }
    // A unit step first: that is the source's loop counter.
    return out.sort((x, y) => Number((this.step(x) === 1n ? 0 : 1) - (this.step(y) === 1n ? 0 : 1)));
  }

  private pairStates(v: string, idx: string, m: bigint, baseKey: string | null): Array<PairState | undefined> {
    const key = `${v}|${idx}|${m}|${baseKey}`;
    const hit = this.relCache.get(key);
    if (hit) return hit;
    const nodes = this.flow.cfg.nodes;
    const IN: Array<PairState | undefined> = nodes.map(() => undefined);
    const OUT: Array<PairState | undefined> = nodes.map(() => undefined);
    const preds: number[][] = nodes.map(() => []);
    for (const n of nodes) for (const s of n.succ) preds[s].push(n.id);
    const vDefs = this.defsOf(v);
    const iDefs = this.defsOf(idx);
    const meet = (a: PairState | undefined, b: PairState | undefined): PairState | undefined => {
      if (!a) return b;
      if (!b) return a;
      return { v: a.v === b.v ? a.v : null, i: a.i === b.i ? a.i : null, d: a.d === b.d ? a.d : null };
    };
    const transfer = (id: number, s: PairState): PairState => {
      const dv = vDefs.get(id);
      const di = iDefs.get(id);
      if (dv && di) return TOP;
      let st = s;
      if (dv) {
        if (dv.kind === 'set') st = { v: dv.c, i: st.i, d: st.i !== null ? norm(dv.c - m * st.i) : null };
        else if (dv.kind === 'setBase' && baseKey !== null && dv.lin.base?.key === baseKey) {
          st = { v: dv.lin.k, i: st.i, d: st.i !== null ? norm(dv.lin.k - m * st.i) : null };
        } else if (dv.kind === 'add') {
          st = { v: st.v !== null ? norm(st.v + dv.a) : null, i: st.i, d: st.d !== null ? norm(st.d + dv.a) : null };
        } else st = TOP;
      }
      if (di) {
        if (di.kind === 'set') st = { v: st.v, i: di.c, d: st.v !== null ? norm(st.v - m * di.c) : null };
        else if (di.kind === 'add') st = { v: st.v, i: st.i !== null ? norm(st.i + di.a) : null, d: st.d !== null ? norm(st.d - m * di.a) : null };
        else st = { v: st.v, i: null, d: null };
      }
      return st;
    };
    const work: number[] = nodes.map(n => n.id);
    const queued = new Set(work);
    IN[this.flow.cfg.entry] = TOP;
    for (const e of this.flow.cfg.extraEntries) IN[e] = TOP;
    let guard = 0;
    while (work.length && guard++ < 200000) {
      const id = work.shift()!;
      queued.delete(id);
      let inn: PairState | undefined = (id === this.flow.cfg.entry || this.flow.cfg.extraEntries.includes(id)) ? TOP : undefined;
      for (const p of preds[id]) inn = meet(inn, OUT[p]);
      IN[id] = inn;
      if (!inn) continue;
      const out = transfer(id, inn);
      const prev = OUT[id];
      if (!prev || prev.v !== out.v || prev.i !== out.i || prev.d !== out.d) {
        OUT[id] = out;
        for (const s of nodes[id].succ) if (!queued.has(s)) { queued.add(s); work.push(s); }
      }
    }
    this.relCache.set(key, IN);
    return IN;
  }

  /** The relation `v` stands in at `node`, if one is proven. */
  private relationAt(v: string, node: number): Relation | null {
    if (node < 0) return null;
    const r = this.relationAt0(v, node);
    trace(`[strided] rel ${v}@${node} -> ${r ? `${r.idx}*${r.m}+${r.d}${r.base ? ' base ' + r.base.key : ''}${r.rescale ? ' rescale' : ''}` : 'none'} step=${this.step(v)} int=${this.isIntLocal(v)} ptr=${this.isPtrLocal(v)} defs=${JSON.stringify([...this.defsOf(v)].map(([n, d]) => [n, d.kind]))}`);
    return r;
  }

  private relationAt0(v: string, node: number): Relation | null {
    if (node < 0) return null;
    if (this.defsOf(v).has(node)) return null;
    const intV = this.isIntLocal(v);
    const ptrV = !intV && this.isPtrLocal(v);
    if (!intV && !ptrV) return null;
    const a = this.step(v);
    if (a === null || a === 0n) return null;
    let base: Base | null = null;
    if (ptrV) {
      const sets = [...this.defsOf(v).values()].filter(d => d.kind === 'setBase') as Array<{ kind: 'setBase'; lin: Lin }>;
      if (sets.length === 0) return null;
      base = sets[0].lin.base!;
      if (sets.some(s => s.lin.base!.key !== base!.key)) return null;
      if (!this.invariantBase(base)) return null;
    }
    for (const idx of this.counters()) {
      if (idx === v || this.defsOf(idx).has(node)) continue;
      const b = this.step(idx)!;
      if (a % b !== 0n) continue;
      const m = a / b;
      const st = this.pairStates(v, idx, m, base ? base.key : null)[node];
      if (!st || st.d === null) continue;
      return { idx, m, d: signed(st.d), base };
    }
    // Rescale only a real stride: a unit step IS the index already.
    if (intV && this.rescalable.has(v) && (a > 1n || a < -1n)) return { idx: v, m: a, d: 0n, base: null, rescale: true };
    return null;
  }

  /** A base whose value cannot change: a global array/object, or a pointer local nothing writes. */
  private invariantBase(b: Base): boolean {
    if (b.kind !== 'ptr') return true;
    const root = unwrapParens(b.expr);
    if (root.kind !== NodeKind.Identifier) return false;
    const name = (root as Identifier).name;
    if (!this.localTypes.has(name) || this.flow.isEscaped(name)) return false;
    return this.flow.cfg.nodes.every(n => !this.flow.writes(n.id).has(name));
  }

  /** `v = n * S` reaching `node` alone, with n unchanged since: the product. */
  private productAt(v: string, node: number): Lin | null {
    if (node < 0 || !this.isIntLocal(v)) return null;
    const reach = [...this.flow.reaching(node, v)];
    if (reach.length !== 1 || reach[0] < 0) return null;
    const def = this.flow.definition(reach[0], v);
    if (!def || !def.killing || !def.rhs) return null;
    const r = unwrapParens(def.rhs);
    if (r.kind !== NodeKind.BinaryExpr || (r as BinaryExpr).operator !== '*') return null;
    const b = r as BinaryExpr;
    const c = literal(b.right) ?? literal(b.left);
    const other = literal(b.right) !== null ? b.left : b.right;
    const o = unwrapParens(other);
    if (c === null || o.kind !== NodeKind.Identifier) return null;
    const n = (o as Identifier).name;
    if (!this.isIntLocal(n)) return null;
    if (this.flow.writtenBetween(reach[0], node, [n]) || this.flow.writes(reach[0]).has(n)) return null;
    this.productsUsed.add(v);
    return { base: null, k: 0n, terms: [{ key: n, expr: o, coef: signed(c) }], derived: true, consumed: [] };
  }

  // ---------------- linearization ----------------

  private pointeeSize(e: Expression): bigint | null {
    const s = this.shape(e);
    if (!s || s.stars === 0) return null;
    if (BYTE_POINTEE.has(canonicalBase(s.base)) && s.stars === 1) return 1n;
    const size = sizeOf(this.ctx, spellingOfShape({ ...s, stars: s.stars - 1 }));
    return size ? BigInt(size) : null;
  }

  private isPointer(e: Expression): boolean {
    const s = this.shape(e);
    return !!s && s.stars > 0;
  }

  private globalArrayElem(name: string): string | null {
    const g = this.o.globalTypes?.[name];
    if (!g) return null;
    const arr = arraySpelling(g);
    return arr ? arr.elem : null;
  }

  /** The address of an lvalue, or null. */
  private laddr(e: Expression, node: number): Lin | null {
    const x = unwrapParens(e);
    switch (x.kind) {
      case NodeKind.Identifier:
      case NodeKind.QualifiedId: {
        const name = x.kind === NodeKind.Identifier ? (x as Identifier).name : bareName(calleeName(x) ?? '');
        if (this.localTypes.has(name)) return null;
        const g = this.o.globalTypes?.[name] ?? (x.kind === NodeKind.QualifiedId ? this.o.globalTypes?.[calleeName(x) ?? ''] : undefined);
        if (!g) return null;
        const arr = arraySpelling(g);
        const key = exprKey(x);
        return {
          base: arr ? { expr: x, kind: 'array', elem: arr.elem, key } : { expr: x, kind: 'object', elem: g, key },
          k: 0n, terms: [], derived: false, consumed: [],
        };
      }
      case NodeKind.SubscriptExpr: {
        const s = x as SubscriptExpr;
        const a = this.lin(s.array, node);
        const w = this.pointeeSize(s.array);
        const i = this.lin(s.index, node);
        if (!a || !w || !i || i.base) return null;
        const scaled = linScale(i, w);
        return scaled ? linAdd(a, scaled, 1n) : null;
      }
      case NodeKind.MemberExpr: {
        const m = x as MemberExpr;
        const field = (m.member as { name?: string }).name;
        if (typeof field !== 'string') return null;
        const objLin = m.isArrow ? this.lin(m.object, node) : this.laddr(m.object, node);
        if (!objLin || !objLin.base) return null;
        const objShape = this.shape(m.object);
        if (!objShape) return null;
        const agg = resolvedName(this.ctx, objShape.base);
        if (objShape.stars !== (m.isArrow ? 1 : 0)) return null;
        const f = this.ctx.layouts[agg]?.find(ff => ff.name === field);
        if (!f || f.bitSize !== undefined) return null;
        return linAdd(objLin, linConst(BigInt(f.offset)), 1n);
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '*') return this.lin(u.operand, node);
        return null;
      }
      default:
        return null;
    }
  }

  /** The linear form of a value (an integer, or an address for a pointer). */
  lin(e: Expression, node: number): Lin | null {
    const x = unwrapParens(e);
    switch (x.kind) {
      case NodeKind.IntegerLiteral:
        return linConst(signed((x as IntegerLiteralExpr).value));
      case NodeKind.CStyleCastExpr: {
        const c = x as CStyleCastExpr;
        const t = shapeOfNode(c.type as TypeNode, 0, this.ctx.resolve);
        if (!t) return null;
        if (t.stars === 0) {
          if (!ADDRESS_INT_BASES.has(canonicalBase(t.base))) return null;
          return this.lin(c.expression, node);
        }
        // A cast to a pointer type keeps the address. Arithmetic on the RESULT is
        // scaled by the new pointee - which the caller asks `pointeeSize` about.
        return this.lin(c.expression, node);
      }
      case NodeKind.BinaryExpr: {
        const b = x as BinaryExpr;
        if (b.operator === '+' || b.operator === '-') {
          const lp = this.isPointer(b.left);
          const rp = this.isPointer(b.right);
          const L = this.lin(b.left, node);
          const R = this.lin(b.right, node);
          if (!L || !R) return null;
          if (lp && rp) return null;
          if (lp) {
            const w = this.pointeeSize(b.left);
            if (!w) return null;
            const s = linScale(R, w);
            return s ? linAdd(L, s, b.operator === '-' ? -1n : 1n) : null;
          }
          if (rp) {
            if (b.operator === '-') return null;
            const w = this.pointeeSize(b.right);
            if (!w) return null;
            const s = linScale(L, w);
            return s ? linAdd(R, s, 1n) : null;
          }
          return linAdd(L, R, b.operator === '-' ? -1n : 1n);
        }
        if (b.operator === '*') {
          const lc = literal(b.left);
          const rc = literal(b.right);
          if (rc !== null) { const L = this.lin(b.left, node); return L ? linScale(L, rc) : null; }
          if (lc !== null) { const R = this.lin(b.right, node); return R ? linScale(R, lc) : null; }
          return this.opaque(x);
        }
        if (b.operator === '<<') {
          const rc = literal(b.right);
          if (rc === null || rc < 0n || rc > 31n) return this.opaque(x);
          const L = this.lin(b.left, node);
          return L ? linScale(L, 1n << rc) : null;
        }
        return this.opaque(x);
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '&') return this.laddr(u.operand, node);
        if (u.operator === '-') {
          const L = this.lin(u.operand, node);
          return L ? linScale(L, -1n) : null;
        }
        return this.opaque(x);
      }
      case NodeKind.Identifier: {
        const name = (x as Identifier).name;
        if (this.localTypes.has(name)) {
          const rel = this.relationAt(name, node);
          if (rel) {
            if (rel.rescale) {
              return { base: null, k: 0n, terms: [{ key: `#idx:${name}`, expr: x, coef: rel.m, rel: 'rescale' }], derived: true, consumed: [x as Identifier] };
            }
            this.relationsUsed.add(name);
            const idxExpr = Expr.identifier(rel.idx);
            const out: Lin = {
              base: rel.base, k: rel.d,
              terms: [{ key: rel.idx, expr: idxExpr, coef: rel.m, rel: 'idx' }], derived: true, consumed: [],
            };
            if (rel.base) {
              const baseLin = rel.base;
              out.base = baseLin;
            }
            return out;
          }
          const product = this.productAt(name, node);
          if (product) return product;
          const s = this.localShape(name);
          if (!s) return null;
          if (s.stars > 0) {
            return { base: { expr: x, kind: 'ptr', elem: spellingOfShape({ ...s, stars: s.stars - 1 }), key: name }, k: 0n, terms: [], derived: false, consumed: [] };
          }
          if (INTEGER_WIDTH[canonicalBase(s.base)] === 4) return { base: null, k: 0n, terms: [{ key: name, expr: x, coef: 1n }], derived: false, consumed: [] };
          return null;
        }
        return this.globalLin(x, name);
      }
      case NodeKind.QualifiedId: {
        const q = calleeName(x) ?? '';
        return this.globalLin(x, this.o.globalTypes?.[q] !== undefined ? q : bareName(q));
      }
      case NodeKind.MemberExpr: {
        const m = x as MemberExpr;
        const s = this.shape(x);
        const objShape = this.shape(m.object);
        const field = (m.member as { name?: string }).name;
        if (objShape && typeof field === 'string') {
          const agg = resolvedName(this.ctx, objShape.base);
          const f = this.ctx.layouts[agg]?.find(ff => ff.name === field);
          if (f && arraySpelling(f.type)) return this.laddr(x, node);  // an array field decays
        }
        if (s && s.stars === 0) return this.opaque(x);
        if (s && s.stars > 0) {
          return { base: { expr: x, kind: 'ptr', elem: spellingOfShape({ ...s, stars: s.stars - 1 }), key: exprKey(x) }, k: 0n, terms: [], derived: false, consumed: [] };
        }
        return null;
      }
      default:
        return this.opaque(x);
    }
  }

  private globalLin(x: Expression, name: string): Lin | null {
    const g = this.o.globalTypes?.[name];
    if (!g) return null;
    const arr = arraySpelling(g);
    if (arr) return { base: { expr: x, kind: 'array', elem: arr.elem, key: exprKey(x) }, k: 0n, terms: [], derived: false, consumed: [] };
    const s = shapeOfSpelling(g, this.ctx.resolve);
    if (!s) return null;
    if (s.stars > 0) return { base: { expr: x, kind: 'ptr', elem: spellingOfShape({ ...s, stars: s.stars - 1 }), key: exprKey(x) }, k: 0n, terms: [], derived: false, consumed: [] };
    if (INTEGER_WIDTH[canonicalBase(s.base)] === 4) return this.opaque(x);
    return null;
  }

  /** An integer-valued expression this form does not see into. */
  private opaque(x: Expression): Lin | null {
    const s = this.shape(x);
    if (!s || s.stars !== 0 || INTEGER_WIDTH[canonicalBase(s.base)] === undefined) return null;
    return { base: null, k: 0n, terms: [{ key: exprKey(x), expr: x, coef: 1n }], derived: false, consumed: [] };
  }

  private recordConsumed(v: string, id: Identifier): void {
    let set = this.consumed.get(v);
    if (!set) { set = new Set(); this.consumed.set(v, set); }
    set.add(id);
  }

  // ---------------- the rewrite ----------------

  /** Rewrite a term's expression with what the pass did inside it. */
  private rewriteTerm = (e: Expression): Expression => {
    if (e.kind === NodeKind.Identifier && this.consumedIds.has(e as Identifier)) return e;
    return this.processExpr(e, this.currentNode);
  };

  private consumedIds = new Set<Identifier>();
  private lastStorePun: { result: Expression; path: Expression; fieldType: string } | null = null;
  /** The path of a function-pointer slot the last store folded to, for its right-hand side. */
  private lastStoreFnSlot: Expression | null = null;
  private currentNode = -1;

  /** The resolved path for an address, gated on the form saying more than the text. */
  /**
   * The resolved path for an address, gated on the rewrite being the one the source
   * wrote: the form must say more than the text (an induction or a product), an
   * induction must index the BASE's elements one at a time (`T[i]`, never `T[i * 5]`
   * or a walker inside a field's array), and the path must name a member - or, with
   * `fnSlot`, be a function-pointer element whose call this makes typed.
   */
  private tryResolve(
    addr: Expression, node: number, fits?: (type: string) => boolean, fnSlot = false, wholeElement?: (type: string) => boolean,
  ): { res: Resolved; lin: Lin } | null {
    const lin = this.lin(addr, node);
    if (!lin || !lin.base || !lin.derived) return null;
    const res = resolvePath(this.ctx, lin, fits);
    if (!res) return null;
    for (const t of res.index0.terms) {
      if (t.rel === 'rescale' && t.coef !== 1n) return null;
      if (t.rel === 'idx' && t.coef !== 1n && t.coef !== -1n) return null;
    }
    for (const st of res.steps) {
      if (st.kind === 'index' && st.terms.some(t => t.rel)) return null;
    }
    const named = res.steps.some(st => st.kind === 'field');
    // A whole element: only the strength-reduced walk itself (a rescaled byte offset,
    // one element per step) of a table of more than bytes, or a function slot.
    const elementWalk = res.steps.length === 0 && (sizeOf(this.ctx, res.base.elem) ?? 0) > 1
      && res.index0.terms.some(t => t.rel === 'rescale');
    // `&T[i]` as a `T *`: the element itself, which is what the callbacks are handed.
    const element = res.steps.length === 0 && !!wholeElement?.(res.type);
    if (!named && !elementWalk && !element && !(fnSlot && res.steps.length === 0)) return null;
    return { res, lin };
  }

  /** The pointee names the aggregate `type` is (an element pointer `T *` for a `T`). */
  private aggregateFits(pointee: TypeShape, type: string): boolean {
    if (pointee.stars !== 0 || arraySpelling(type) || isPointerSpelling(type)) return false;
    const a = resolvedName(this.ctx, canonicalBase(pointee.base).replace(/^::/, ''));
    return !!this.ctx.layouts[a] && a === resolvedName(this.ctx, type);
  }

  /** A function pointer as Ghidra loads one: `code *`, a funcdef pointer, an override type. */
  private isFunctionPointer(s: TypeShape): boolean {
    const b = canonicalBase(s.base).replace(/^::/, '');
    return s.stars === 1 && (b === 'code' || this.ctx.funcdefs.has(b) || /^dt_[0-9a-f]+$/.test(b));
  }

  private markConsumed(lin: Lin): void {
    for (const id of lin.consumed) {
      this.consumedIds.add(id);
      this.recordConsumed(id.name, id);
    }
  }

  /** Is the slot type compatible with the path's type as an access of `access`? */
  private accessFits(access: TypeShape, fieldType: string): 'same' | 'int' | 'word' | 'no' {
    // An array is reached through its elements, never accessed as a whole.
    if (arraySpelling(fieldType)) return 'no';
    const f = shapeOfSpelling(fieldType, this.ctx.resolve);
    if (!f) return 'no';
    const ab = canonicalBase(access.base).replace(/^::/, '');
    const fb = canonicalBase(f.base).replace(/^::/, '');
    if (access.stars === f.stars && ab === fb) return 'same';
    // A function pointer loaded as Ghidra's `code *` (or an anonymous override type):
    // the field's funcdef says what it is.
    const isFnPtr = (base: string, stars: number) => stars === 1 && (base === 'code' || this.ctx.funcdefs.has(base) || /^dt_[0-9a-f]+$/.test(base));
    if (isFnPtr(ab, access.stars) && this.ctx.funcdefs.has(fb) && f.stars === 1) return 'same';
    if (access.stars === 0 && f.stars === 0 && INTEGER_WIDTH[ab] !== undefined && INTEGER_WIDTH[ab] === INTEGER_WIDTH[fb]) return 'int';
    if (access.stars > 0 && f.stars > 0 && access.stars === f.stars && (ab === 'void' || fb === 'void')) return 'int';
    // A pointer field read as a pointer-wide integer: the conversion carries the
    // address on this 32-bit target. Read-only; a store keeps the pun.
    if (access.stars === 0 && f.stars > 0 && ADDRESS_INT_BASES.has(ab)) return 'word';
    return 'no';
  }

  /** `*(T *)&path` - the access kept as the reinterpretation it is. */
  private punned(path: Expression, pointerType: TypeNode): Expression {
    return Expr.deref(Expr.paren(Expr.cast(pointerType, Expr.addressOf(path))));
  }

  /**
   * The pointer type node of an address expression: its outermost cast, its
   * variable's declaration, or - for arithmetic - spelled from its shape. `shape`
   * is the pointee (`extraStars` 1) or the pointer itself (0) when the caller
   * knows it.
   */
  private pointerTypeOf(addr: Expression, shape?: TypeShape, extraStars = 0): TypeNode | null {
    const x = unwrapParens(addr);
    if (x.kind === NodeKind.CStyleCastExpr) {
      const t = (x as CStyleCastExpr).type as TypeNode;
      if (t.kind === NodeKind.PointerType) return t;
      return null;
    }
    if (x.kind === NodeKind.Identifier) {
      const t = this.localTypes.get((x as Identifier).name);
      if (t && t.kind === NodeKind.PointerType) return t;
    }
    const s = shape ? { ...shape, stars: shape.stars + extraStars } : this.shape(x);
    if (!s || s.stars === 0) return null;
    const t = typeFromSpelling(spellingOfShape(s));
    return t && t.kind === NodeKind.PointerType ? t : null;
  }

  /**
   * Fold an access `*addr` whose value type is `access`; `role` is how the
   * access is used.
   */
  private foldAccess(
    addr: Expression, access: TypeShape, role: 'read' | 'store' | 'modify', node: number, typeSrc: Expression = addr,
  ): Expression | null {
    const r = this.tryResolve(addr, node, type => this.accessFits(access, type) !== 'no', this.isFunctionPointer(access));
    if (!r) return null;
    const fits = this.accessFits(access, r.res.type);
    let path: Expression;
    if (fits === 'same' || (fits === 'int' && role === 'store')) {
      path = renderPath(r.res, this.rewriteTerm);
      if (role === 'store' && fits === 'same' && this.isFunctionPointer(access)) this.lastStoreFnSlot = path;
    } else if ((fits === 'int' || fits === 'word') && role === 'read') {
      const t = this.pointerTypeOf(typeSrc, access, 1);
      if (!t) return null;
      path = Expr.paren(Expr.cast((t as unknown as { pointee: TypeNode }).pointee, renderPath(r.res, this.rewriteTerm)));
    } else {
      const t = this.pointerTypeOf(typeSrc, access, 1);
      if (!t) return null;
      const plain = renderPath(r.res, this.rewriteTerm);
      path = this.punned(plain, t);
      if (role === 'store') this.lastStorePun = { result: path, path: plain, fieldType: r.res.type };
    }
    this.markConsumed(r.lin);
    this.changed = true;
    return path;
  }

  /** Fold an address VALUE `addr` of pointer type. */
  private foldAddress(addr: Expression, node: number): Expression | null {
    const s = this.shape(addr);
    if (!s || s.stars === 0) return null;
    const pointee = { ...s, stars: s.stars - 1 };
    const fitsPointee = (type: string) => {
      const arr = arraySpelling(type);
      return this.accessFits(pointee, type) === 'same' || (!!arr && this.accessFits(pointee, arr.elem) === 'same')
        || this.aggregateFits(pointee, type);
    };
    const r = this.tryResolve(addr, node, fitsPointee, false, type => this.aggregateFits(pointee, type));
    if (!r) return null;
    const path = renderPath(r.res, this.rewriteTerm);
    const arr = arraySpelling(r.res.type);
    let out: Expression;
    if (arr && this.accessFits(pointee, arr.elem) === 'same') {
      out = path;  // an array decays to a pointer to its first element
    } else if (this.accessFits(pointee, r.res.type) === 'same' || this.aggregateFits(pointee, r.res.type)) {
      out = Expr.addressOf(path);
    } else {
      const t = this.pointerTypeOf(addr, s);
      if (!t) return null;
      out = Expr.paren(Expr.cast(t, Expr.addressOf(path)));
    }
    this.markConsumed(r.lin);
    this.changed = true;
    return out;
  }

  processExpr(e: Expression, node: number): Expression {
    const saved = this.currentNode;
    this.currentNode = node;
    try {
      return this.processInner(e, node, 'read');
    } finally {
      this.currentNode = saved;
    }
  }

  private processInner(e: Expression, node: number, role: 'read' | 'store' | 'modify' | 'addr'): Expression {
    const x = e;
    switch (x.kind) {
      case NodeKind.ParenExpr: {
        const inner = this.processInner((x as ParenExpr).expression, node, role);
        return inner === (x as ParenExpr).expression ? x : { ...(x as ParenExpr), expression: inner } as Expression;
      }
      case NodeKind.UnaryExpr: {
        const u = x as UnaryExpr;
        if (u.operator === '*' && role !== 'addr') {
          const s = this.shape(u.operand);
          if (s && s.stars > 0) {
            const folded = this.foldAccess(u.operand, { ...s, stars: s.stars - 1 }, role === 'store' ? 'store' : role === 'modify' ? 'modify' : 'read', node);
            if (folded) return withTrivia(folded, x);
          }
        }
        if (u.operator === '&') {
          const operand = this.processInner(u.operand, node, 'addr');
          return operand === u.operand ? x : { ...u, operand } as Expression;
        }
        if (u.operator === '++' || u.operator === '--') {
          const operand = this.processInner(u.operand, node, 'modify');
          return operand === u.operand ? x : { ...u, operand } as Expression;
        }
        const operand = this.processInner(u.operand, node, 'read');
        return operand === u.operand ? x : { ...u, operand } as Expression;
      }
      case NodeKind.PostfixExpr: {
        const p = x as PostfixExpr;
        const operand = this.processInner(p.operand, node, 'modify');
        return operand === p.operand ? x : { ...p, operand } as Expression;
      }
      case NodeKind.SubscriptExpr: {
        const sub = x as SubscriptExpr;
        const s = this.shape(x);
        if (s && role !== 'addr') {
          const addr = Expr.binary(sub.array, '+', sub.index);
          const folded = this.foldAccess(addr, s, role === 'store' ? 'store' : role === 'modify' ? 'modify' : 'read', node, sub.array);
          if (folded) return withTrivia(folded, x);
        }
        const array = this.processInner(sub.array, node, 'read');
        const index = this.processInner(sub.index, node, 'read');
        return array === sub.array && index === sub.index ? x : { ...sub, array, index } as Expression;
      }
      case NodeKind.MemberExpr: {
        const m = x as MemberExpr;
        if (m.isArrow) {
          // `((T *)addr)->f` - the object is an address.
          const folded = this.foldAddress(m.object, node);
          if (folded) {
            const obj = unwrapParens(folded);
            if (obj.kind === NodeKind.UnaryExpr && (obj as UnaryExpr).operator === '&') {
              return withTrivia(Expr.member((obj as UnaryExpr).operand, m.member as Identifier, false), x);
            }
            return withTrivia({ ...m, object: needsParens(folded) ? Expr.paren(folded) : folded } as Expression, x);
          }
        }
        const object = this.processInner(m.object, node, m.isArrow ? 'read' : role);
        return object === m.object ? x : { ...m, object } as Expression;
      }
      case NodeKind.AssignExpr: {
        const a = x as AssignExpr;
        this.lastStorePun = null;
        this.lastStoreFnSlot = null;
        const left0 = this.processInner(a.left, node, a.operator === '=' ? 'store' : 'modify');
        const pun = this.lastStorePun as { result: Expression; path: Expression; fieldType: string } | null;
        const fnSlot = this.lastStoreFnSlot as Expression | null;
        this.lastStorePun = null;
        this.lastStoreFnSlot = null;
        let left = left0;
        let rightIn = a.right;
        // `= (code *)F` into what is now a funcdef-typed slot: Ghidra's untyped cast
        // says nothing the slot's type does not; the function converts as itself.
        if (fnSlot && a.operator === '=' && withTriviaIs(left0, fnSlot)) {
          const r = unwrapParens(a.right);
          if (r.kind === NodeKind.CStyleCastExpr) {
            const ct = shapeOfNode((r as CStyleCastExpr).type as TypeNode, 0, this.ctx.resolve);
            const inner = unwrapParens((r as CStyleCastExpr).expression);
            if (ct && ct.stars === 1 && canonicalBase(ct.base) === 'code'
                && (inner.kind === NodeKind.Identifier || inner.kind === NodeKind.QualifiedId)) {
              rightIn = (r as CStyleCastExpr).expression;
            }
          }
        }
        // `*(int *)&item.pDC6Main = (int)pLoadedDC6` stores the pointer it converts:
        // the same four bytes as `item.pDC6Main = pLoadedDC6`.
        if (pun && withTriviaIs(left0, pun.result) && a.operator === '=') {
          const r = unwrapParens(a.right);
          if (r.kind === NodeKind.CStyleCastExpr) {
            const ct = shapeOfNode((r as CStyleCastExpr).type as TypeNode, 0, this.ctx.resolve);
            const inner = (r as CStyleCastExpr).expression;
            const is = this.shape(inner);
            if (ct && ct.stars === 0 && ADDRESS_INT_BASES.has(canonicalBase(ct.base)) && is
                && this.accessFits(is, pun.fieldType) === 'same') {
              left = withTrivia(pun.path, left0);
              rightIn = inner;
            }
          }
        }
        const right = this.processInner(rightIn, node, 'read');
        return left === a.left && right === a.right ? x : { ...a, left, right } as Expression;
      }
      case NodeKind.CStyleCastExpr: {
        // `(pfnX *)pItem[-2]` - a pointer-wide integer read and converted to the
        // field's own pointer type is the field read as itself.
        const c = x as CStyleCastExpr;
        const target = shapeOfNode(c.type as TypeNode, 0, this.ctx.resolve);
        const inner = unwrapParens(c.expression);
        if (role !== 'addr' && target && target.stars > 0
            && (inner.kind === NodeKind.SubscriptExpr || (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '*'))) {
          const is = this.shape(inner);
          if (is && is.stars === 0 && ADDRESS_INT_BASES.has(canonicalBase(is.base))) {
            const addr = inner.kind === NodeKind.SubscriptExpr
              ? Expr.binary((inner as SubscriptExpr).array, '+', (inner as SubscriptExpr).index)
              : (inner as UnaryExpr).operand;
            const r = this.tryResolve(addr, node, type => this.accessFits(target, type) === 'same');
            if (r && this.accessFits(target, r.res.type) === 'same') {
              this.markConsumed(r.lin);
              this.changed = true;
              return withTrivia(renderPath(r.res, this.rewriteTerm), x);
            }
          }
        }
        if (role !== 'addr') {
          const s = this.shape(x);
          if (s && s.stars > 0) {
            const folded = this.foldAddress(x, node);
            if (folded) return withTrivia(folded, x);
          }
        }
        break;
      }
      case NodeKind.BinaryExpr: {
        if (role !== 'addr') {
          const s = this.shape(x);
          if (s && s.stars > 0) {
            const folded = this.foldAddress(x, node);
            if (folded) return withTrivia(folded, x);
          }
        }
        break;
      }
      case NodeKind.Identifier: {
        if (role === 'read' && this.isPtrLocal((x as Identifier).name)) {
          const folded = this.foldAddress(x, node);
          if (folded) return withTrivia(folded, x);
        }
        return x;
      }
      default:
        break;
    }
    // Generic descent.
    let copy: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      if (Array.isArray(v)) {
        let ch = false;
        const out = v.map(i => {
          if (i && typeof i === 'object' && 'kind' in i && isExpressionKind((i as ASTNode).kind)) {
            const r = this.processInner(i as Expression, node, 'read');
            if (r !== i) ch = true;
            return r;
          }
          return i;
        });
        if (ch) { copy = copy ?? { ...(x as object) } as Record<string, unknown>; copy[k] = out; }
      } else if (v && typeof v === 'object' && 'kind' in (v as object) && isExpressionKind((v as ASTNode).kind)) {
        const r = this.processInner(v as Expression, node, x.kind === NodeKind.CStyleCastExpr ? role : 'read');
        if (r !== v) { copy = copy ?? { ...(x as object) } as Record<string, unknown>; copy[k] = r; }
      }
    }
    return (copy ?? x) as Expression;
  }

  processStmt(s: Statement): Statement {
    const node = this.flow.nodeOf(s) ?? -1;
    switch (s.kind) {
      case NodeKind.CompoundStmt: {
        const c = s as CompoundStmt;
        let ch = false;
        const statements = c.statements.map(st => { const r = this.processStmt(st as Statement); if (r !== st) ch = true; return r; });
        return ch ? { ...c, statements } as Statement : s;
      }
      case NodeKind.ExprStmt: {
        const e = (s as ExprStmt).expression;
        const r = this.processExpr(e, node);
        return r === e ? s : { ...s, expression: r } as Statement;
      }
      case NodeKind.DeclStmt: {
        const d = s as DeclStmt;
        let ch = false;
        const declarations = d.declarations.map(decl => {
          if (decl.kind !== NodeKind.VariableDecl) return decl;
          const v = decl as VariableDecl;
          if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr) return decl;
          const r = this.processExpr(v.initializer as Expression, node);
          if (r === v.initializer) return decl;
          ch = true;
          return { ...v, initializer: r };
        });
        return ch ? { ...d, declarations } as Statement : s;
      }
      case NodeKind.IfStmt: {
        const i = s as IfStmt;
        const condition = this.processExpr(i.condition, node);
        const thenBranch = this.processStmt(i.thenBranch);
        const elseBranch = i.elseBranch ? this.processStmt(i.elseBranch) : i.elseBranch;
        return condition === i.condition && thenBranch === i.thenBranch && elseBranch === i.elseBranch
          ? s : { ...i, condition, thenBranch, elseBranch } as Statement;
      }
      case NodeKind.WhileStmt: {
        const w = s as WhileStmt;
        const condition = this.processExpr(w.condition, node);
        const body = this.processStmt(w.body);
        return condition === w.condition && body === w.body ? s : { ...w, condition, body } as Statement;
      }
      case NodeKind.DoWhileStmt: {
        const w = s as DoWhileStmt;
        const body = this.processStmt(w.body);
        const condition = this.processExpr(w.condition, node);
        return condition === w.condition && body === w.body ? s : { ...w, condition, body } as Statement;
      }
      case NodeKind.SwitchStmt: {
        const w = s as SwitchStmt;
        const condition = this.processExpr(w.condition, node);
        const body = this.processStmt(w.body);
        return condition === w.condition && body === w.body ? s : { ...w, condition, body } as Statement;
      }
      case NodeKind.ForStmt: {
        const f = s as ForStmt;
        const init = f.init ? this.processStmt(f.init) : f.init;
        const condition = f.condition ? this.processExpr(f.condition, node) : f.condition;
        const incNode = f.increment ? this.exprNode.get(f.increment) ?? -1 : -1;
        const increment = f.increment ? this.processExpr(f.increment, incNode) : f.increment;
        const body = this.processStmt(f.body);
        return init === f.init && condition === f.condition && increment === f.increment && body === f.body
          ? s : { ...f, init, condition, increment, body } as Statement;
      }
      case NodeKind.ReturnStmt: {
        const r = s as ReturnStmt;
        if (!r.value) return s;
        const value = this.processExpr(r.value, node);
        return value === r.value ? s : { ...r, value } as Statement;
      }
      case NodeKind.LabelStmt:
      case NodeKind.CaseStmt:
      case NodeKind.DefaultStmt: {
        const w = s as LabelStmt | CaseStmt | DefaultStmt;
        const inner = this.processStmt(w.statement);
        return inner === w.statement ? s : { ...w, statement: inner } as Statement;
      }
      default:
        return s;
    }
  }

  get didChange(): boolean { return this.changed; }
  get rescaledConsumed(): Map<string, Set<Identifier>> { return this.consumed; }
  get relationVars(): Set<string> { return this.relationsUsed; }
  get productVars(): Set<string> { return this.productsUsed; }
  get functionFlow(): FunctionFlow { return this.flow; }
  defKinds(v: string): Map<number, DefKind> { return this.defsOf(v); }
}

function innerStmt(st: Statement): Statement {
  let x = st as ASTNode;
  while (x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt || x.kind === NodeKind.LabelStmt) {
    x = (x as unknown as { statement: ASTNode }).statement;
  }
  return x as Statement;
}

const EXPRESSION_KINDS = new Set<string>([
  NodeKind.Identifier, NodeKind.QualifiedId, NodeKind.IntegerLiteral, NodeKind.BinaryExpr, NodeKind.UnaryExpr,
  NodeKind.PostfixExpr, NodeKind.ConditionalExpr, NodeKind.AssignExpr, NodeKind.CallExpr, NodeKind.MemberExpr,
  NodeKind.SubscriptExpr, NodeKind.CStyleCastExpr, NodeKind.ParenExpr, NodeKind.CommaExpr,
  NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr,
]);
function isExpressionKind(k: string): boolean { return EXPRESSION_KINDS.has(k); }

/** `a` is `b`, or `b` re-wrapped by `withTrivia`. */
function withTriviaIs(a: Expression, b: Expression): boolean {
  if (a === b) return true;
  const { leadingTrivia: _l1, trailingTrivia: _t1, ...ra } = a as unknown as Record<string, unknown>;
  const { leadingTrivia: _l2, trailingTrivia: _t2, ...rb } = b as unknown as Record<string, unknown>;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every(k => ra[k] === rb[k]);
}

function withTrivia<T extends object>(e: T, from: ASTNode): T {
  return { ...e, leadingTrivia: from.leadingTrivia, trailingTrivia: from.trailingTrivia } as T;
}

// ============================================
// DEFINITION REWRITES
// ============================================

/** Rescaled variable `v` (old step `a`): its defs and compares in index units. */
function rescaleDefsAndCompares(body: Statement[], v: string, a: bigint): Statement[] | null {
  let ok = true;
  const div = (c: bigint): bigint | null => (c % a === 0n ? c / a : null);
  const isV = (e: Expression) => { const x = unwrapParens(e); return x.kind === NodeKind.Identifier && (x as Identifier).name === v; };
  const out = rebuild(body, n => {
    if (!ok) return undefined;
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === v) {
      const init = (n as VariableDecl).initializer;
      if (!init) return undefined;
      const c = literal(init as Expression);
      const q = c === null ? null : div(c);
      if (q === null) { ok = false; return undefined; }
      return { ...n, initializer: Expr.intLiteral(q) } as ASTNode;
    }
    if (n.kind === NodeKind.AssignExpr && isV((n as AssignExpr).left)) {
      const as = n as AssignExpr;
      const rhs = as.right;
      if (as.operator === '+=' || as.operator === '-=') {
        const c = literal(rhs);
        const q = c === null ? null : div(c);
        if (q === null) { ok = false; return undefined; }
        const step = as.operator === '-=' ? -q : q;
        if (step === 1n) return { ...Expr.postfix(as.left, '++'), leadingTrivia: n.leadingTrivia, trailingTrivia: n.trailingTrivia } as ASTNode;
        if (step === -1n) return { ...Expr.postfix(as.left, '--'), leadingTrivia: n.leadingTrivia, trailingTrivia: n.trailingTrivia } as ASTNode;
        return { ...as, right: Expr.intLiteral(q) } as ASTNode;
      }
      if (as.operator !== '=') { ok = false; return undefined; }
      const c = literal(rhs);
      if (c !== null) {
        const q = div(c);
        if (q === null) { ok = false; return undefined; }
        return { ...as, right: Expr.intLiteral(q) } as ASTNode;
      }
      const r = unwrapParens(rhs);
      if (r.kind === NodeKind.BinaryExpr && (r as BinaryExpr).operator === '+' || r.kind === NodeKind.BinaryExpr && (r as BinaryExpr).operator === '-') {
        const b = r as BinaryExpr;
        const c2 = isV(b.left) ? literal(b.right) : (b.operator === '+' && isV(b.right) ? literal(b.left) : null);
        const q = c2 === null ? null : div(c2);
        if (q === null) { ok = false; return undefined; }
        const step = b.operator === '-' ? -q : q;
        if (step === 1n) return { ...Expr.postfix(as.left, '++'), leadingTrivia: n.leadingTrivia, trailingTrivia: n.trailingTrivia } as ASTNode;
        if (step === -1n) return { ...Expr.postfix(as.left, '--'), leadingTrivia: n.leadingTrivia, trailingTrivia: n.trailingTrivia } as ASTNode;
        return { ...as, operator: '+=', right: Expr.intLiteral(step) } as ASTNode;
      }
      ok = false;
      return undefined;
    }
    if (n.kind === NodeKind.BinaryExpr) {
      const b = n as BinaryExpr;
      if (!['<', '<=', '>', '>=', '==', '!='].includes(b.operator)) return undefined;
      if (isV(b.left)) {
        const c = literal(b.right);
        if (c === null) return undefined;  // a non-literal compare is a read the caller counts
        const q = div(c);
        if (q === null) { ok = false; return undefined; }
        return { ...b, right: Expr.intLiteral(q) } as ASTNode;
      }
      if (isV(b.right)) {
        const c = literal(b.left);
        if (c === null) return undefined;
        const q = div(c);
        if (q === null) { ok = false; return undefined; }
        return { ...b, left: Expr.intLiteral(q) } as ASTNode;
      }
    }
    return undefined;
  });
  return ok ? out : null;
}

/** Every read of `v` the rescale has an answer for: own defs and literal compares. */
function rescaleAccountedReads(body: Statement[], v: string): Set<Identifier> {
  const out = new Set<Identifier>();
  const isV = (e: Expression) => { const x = unwrapParens(e); return x.kind === NodeKind.Identifier && (x as Identifier).name === v ? x as Identifier : null; };
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.AssignExpr) { const id = isV((n as AssignExpr).left); if (id) out.add(id); }
    if (n.kind === NodeKind.PostfixExpr || (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator))) {
      const id = isV((n as PostfixExpr).operand); if (id) out.add(id);
    }
    if (n.kind === NodeKind.AssignExpr && ['=', '+=', '-='].includes((n as AssignExpr).operator)) {
      const r = unwrapParens((n as AssignExpr).right);
      if (r.kind === NodeKind.BinaryExpr) {
        const b = r as BinaryExpr;
        const l = isV(b.left); if (l && literal(b.right) !== null) out.add(l);
        const rr = isV(b.right); if (rr && literal(b.left) !== null) out.add(rr);
      }
    }
    if (n.kind === NodeKind.BinaryExpr && ['<', '<=', '>', '>=', '==', '!='].includes((n as BinaryExpr).operator)) {
      const b = n as BinaryExpr;
      const l = isV(b.left); if (l && literal(b.right) !== null) out.add(l);
      const r = isV(b.right); if (r && literal(b.left) !== null) out.add(r);
    }
    for (const [k, val] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      if (val && typeof val === 'object') walk(val);
    }
  };
  walk(body);
  return out;
}

/**
 * Drop defs of `v` no read is left to reach: statements that only assign or
 * step it, with a pure right-hand side. A declaration loses its initializer, and
 * goes entirely once nothing names it.
 */
function dropDeadDefs(body: Statement[], v: string, locals: ReadonlySet<string>): Statement[] {
  const flow = buildFunctionFlow(body, locals);
  // The candidate dead defs: plain stores of a pure value, and self-steps.
  const D = new Set<number>();
  for (const n of flow.cfg.nodes) {
    if (!flow.writes(n.id).has(v) || !n.stmt) continue;
    const inner = innerStmt(n.stmt);
    if (inner.kind === NodeKind.ExprStmt && isPureDef(inner, v)) D.add(n.id);
    else if (inner.kind === NodeKind.DeclStmt && declInitIsPure(inner as DeclStmt, v)) D.add(n.id);
  }
  if (D.size === 0) return body;
  // A def is live when a read outside the self-steps can see it.
  for (const d of D) {
    for (const u of flow.usesOf(d, v)) {
      const st = flow.cfg.nodes[u].stmt;
      if (!D.has(u) || !st || !isSelfStep(innerStmt(st), v)) return body;
    }
  }
  const dead = new Set<object>();
  const deadDecls = new Set<object>();
  for (const d of D) {
    const inner = innerStmt(flow.cfg.nodes[d].stmt!);
    if (inner.kind === NodeKind.ExprStmt) dead.add(inner);
    else deadDecls.add(inner);
  }
  let out = rebuild(body, n => {
    if (dead.has(n)) return { kind: NodeKind.NullStmt, location: n.location, leadingTrivia: n.leadingTrivia, trailingTrivia: [] } as unknown as ASTNode;
    if (deadDecls.has(n)) {
      const d = n as DeclStmt;
      return {
        ...d,
        declarations: d.declarations.map(x => (x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === v)
          ? { ...(x as VariableDecl), initializer: null } : x),
      } as unknown as ASTNode;
    }
    return undefined;
  });
  out = dropNullStmts(out);
  if (identifiersNamed(out, v).length === 0) {
    out = rebuild(out, n => {
      if (n.kind !== NodeKind.DeclStmt) return undefined;
      const d = n as DeclStmt;
      const keep = d.declarations.filter(x => !(x.kind === NodeKind.VariableDecl && (x as VariableDecl).name.name === v));
      if (keep.length === d.declarations.length) return undefined;
      if (keep.length === 0) return { kind: NodeKind.NullStmt, location: n.location, leadingTrivia: n.leadingTrivia, trailingTrivia: [] } as unknown as ASTNode;
      return { ...d, declarations: keep } as ASTNode;
    });
    out = dropNullStmts(out);
  }
  return out;
}

function declInitIsPure(d: DeclStmt, v: string): boolean {
  for (const x of d.declarations) {
    if (x.kind !== NodeKind.VariableDecl || (x as VariableDecl).name.name !== v) continue;
    const init = (x as VariableDecl).initializer;
    return !!init && init.kind !== NodeKind.InitListExpr && pureExpr(init);
  }
  return false;
}

function isSelfStep(st: Statement, v: string): boolean {
  if (st.kind !== NodeKind.ExprStmt) return false;
  const e = unwrapParens((st as ExprStmt).expression);
  const isV = (x: Expression) => { const y = unwrapParens(x); return y.kind === NodeKind.Identifier && (y as Identifier).name === v; };
  if ((e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.UnaryExpr) && isV((e as PostfixExpr).operand)) return true;
  if (e.kind === NodeKind.AssignExpr && isV((e as AssignExpr).left)) {
    const a = e as AssignExpr;
    if ((a.operator === '+=' || a.operator === '-=') && literal(a.right) !== null) return true;
    const r = unwrapParens(a.right);
    if (a.operator === '=' && r.kind === NodeKind.BinaryExpr) {
      const b = r as BinaryExpr;
      return (isV(b.left) && literal(b.right) !== null) || (isV(b.right) && literal(b.left) !== null);
    }
  }
  return false;
}

function isPureDef(st: Statement, v: string): boolean {
  const e = unwrapParens((st as ExprStmt).expression);
  if (isSelfStep(st, v)) return true;
  if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') {
    const l = unwrapParens((e as AssignExpr).left);
    return l.kind === NodeKind.Identifier && (l as Identifier).name === v && pureExpr((e as AssignExpr).right);
  }
  return false;
}

/** No call and no write: an expression whose evaluation can be dropped. */
function pureExpr(e: unknown): boolean {
  if (Array.isArray(e)) return e.every(pureExpr);
  if (!e || typeof e !== 'object') return true;
  const n = e as ASTNode;
  if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr) return false;
  if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) return false;
  for (const [k, v] of Object.entries(n)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
    if (v && typeof v === 'object' && !pureExpr(v)) return false;
  }
  return true;
}

function dropNullStmts<T>(root: T): T {
  const isMade = (s: ASTNode) => s.kind === NodeKind.NullStmt
    && !(s.leadingTrivia ?? []).some(t => /comment/i.test(String((t as { kind?: string }).kind)));
  if (Array.isArray(root)) {
    const kept = (root as ASTNode[]).filter(s => !isMade(s)).map(s => dropNullStmts(s));
    return kept as unknown as T;
  }
  return rebuild(root, n => {
    if (n.kind !== NodeKind.CompoundStmt) return undefined;
    const c = n as CompoundStmt;
    // A null statement this pass made goes; one carrying a comment keeps the comment.
    const keep = c.statements.filter(s => !(s.kind === NodeKind.NullStmt
      && !(s.leadingTrivia ?? []).some(t => /comment/i.test(String((t as { kind?: string }).kind)))));
    const inner = keep.map(s => dropNullStmts(s));
    return keep.length === c.statements.length && inner.every((s, i) => s === keep[i]) ? undefined : { ...c, statements: inner } as ASTNode;
  });
}

// ============================================
// DRIVER
// ============================================

export function rewriteStridedAccesses(
  fn: FunctionDecl, o: StridedAccessOptions, ctx: Ctx,
): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body) return null;
  const localTypes = new Map<string, TypeNode>();
  for (const p of fn.parameters) {
    const pd = p as ParameterDecl;
    if (pd.name) localTypes.set(pd.name.name, pd.type);
  }
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
  }
  let statements = body.statements as Statement[];
  // Rescale candidates: every integer local; whittled down until each one left has
  // every read accounted for.
  let rescalable = new Set<string>([...localTypes.keys()]);
  for (let round = 0; round < 8; round++) {
    const pass = new FunctionPass(ctx, statements, localTypes, o, rescalable);
    const out = statements.map(s => pass.processStmt(s));
    if (!pass.didChange) return null;
    // A rescaled variable must have had every read consumed by a fold or be a
    // def/compare the rescale rewrites; otherwise drop it and redo.
    const bad = new Set<string>();
    for (const [v, ids] of pass.rescaledConsumed) {
      const accounted = rescaleAccountedReads(statements, v);
      for (const id of identifiersNamed(statements, v)) {
        if (!ids.has(id) && !accounted.has(id)) { bad.add(v); break; }
      }
    }
    if (bad.size > 0) {
      for (const v of bad) rescalable.delete(v);
      continue;
    }
    let next: Statement[] | null = out;
    for (const [v] of pass.rescaledConsumed) {
      const a = [...pass.defKinds(v).values()].find(d => d.kind === 'add') as { kind: 'add'; a: bigint } | undefined;
      if (!a || !next) { next = null; break; }
      next = rescaleDefsAndCompares(next, v, a.a);
    }
    if (!next) {
      for (const [v] of pass.rescaledConsumed) rescalable.delete(v);
      continue;
    }
    const locals = new Set(localTypes.keys());
    for (const v of [...pass.relationVars, ...pass.productVars]) next = dropDeadDefs(next, v, locals);
    // A pointer-induction base no longer read either (`pMenuItemData`).
    return next;
  }
  return null;
}

function createStridedAccessTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as StridedAccessOptions;
  const layouts = o.structLayouts ?? {};
  if (Object.keys(layouts).length === 0) return (n: ASTNode) => n;
  const typedefTargets = o.typedefTargets ?? {};
  const ctx: Ctx = {
    layouts,
    sizes: o.aggregateSizes ?? {},
    members: o.aggregateMembers ?? {},
    unions: new Set(o.unionNames ?? []),
    funcdefs: new Set(o.funcdefNames ?? []),
    resolve: (name: string) => typedefTargets[name],
    globalTypes: o.globalTypes ?? {},
  };
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      trace('[strided] fn', (fn.name as { name?: string })?.name);
      if (!fn.body) return undefined;
      let statements: Statement[] | null;
      try {
        statements = rewriteStridedAccesses(fn, o, ctx);
      } catch (err) {
        trace('[strided] threw', err);
        return undefined;
      }
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const stridedAccessPlugin: TransformPlugin = {
  id: 'strided-access',
  name: 'Strided Access',
  description:
    'A strength-reduced byte-offset induction or an n*sizeof(T) interior-constant address -> the T[i].field access it computes',
  version: '1.0.0',
  defaultEnabled: true,
  // After global-address-literal (68) has named the interior constants and
  // address-run-bound (69) the loop bounds; before funcdef-cast-collapse (70) and
  // the cast passes, which then see the field types.
  priority: 69.5,
  tags: ['correctness', 'structs', 'type'],
  createTransformer: createStridedAccessTransformer,
};

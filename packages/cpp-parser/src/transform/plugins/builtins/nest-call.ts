/**
 * Nest Call Plugin
 *
 * VC8 evaluates stack arguments right to left. A call nested in an argument list,
 *
 *     HasQuestItem(GetGamePointer(pUnit), pUnit, 'bks ');
 *
 * pushes the arguments to the right of the inner call first and calls it after them
 * (Q04_ActiveFilter, 00592fb0: `push 0x20736b62; mov ecx, edi; call GetGamePointer`).
 * The decompiler hands the result back through a temporary,
 *
 *     pGame = GetGamePointer(pUnit);
 *     HasQuestItem(pGame, pUnit, 'bks ');
 *
 * which VC8 compiles as written: the call first, every push after it. The original's
 * instructions tell the forms apart (extraction: reconstruct extract/call-order.ts): the
 * PUSHes between the inner CALL and the outer one are those of the arguments left of the
 * temporary and the temporary itself in the nested form, all of the outer call's stack
 * arguments in the temporary form.
 *
 * A run of temporaries right above the call goes back in together when each is used once
 * in it (AUTOMAP_DrawGamePassword, 00459e90: `bMultiLineCenter = 0; dwColor = 4; nY =
 * AUTOMAP_TextHeightOffset; nTextWidth = DRAW_text0(wsz); DRAW_text(wsz, WindowSizeX -
 * nTextWidth - 0x10, nY, dwColor, bMultiLineCenter);`). The rewrite is made only when:
 *
 *   - each temporary is a local assigned one value, named exactly once in the statement,
 *     inside an argument of its top call, as a value (not an lvalue, not its address);
 *   - it is dead after the statement: no other mention, or (outside any loop or switch,
 *     in a function without labels) the next mention is a plain assignment that every
 *     path from the statement reaches;
 *   - a temporary holding a call or a memory read stands where VC8 evaluates it: the
 *     earliest in the argument furthest right; one holding a constant or a local whose
 *     address is never taken may stand anywhere;
 *   - exactly one temporary holds a call, and no other argument calls anything (the
 *     statement assigns nothing inside the argument list): VC8 evaluates arguments right
 *     to left, GCC in an unspecified order, and two calls side by side could run in
 *     either (`SOUND_PlayEnvironmentSound(n, RollBetweenMinAndMax(pSeed, ..),
 *     RollBetweenMinAndMax(pSeed, ..), 0)` would swap its rolls). A run of two call
 *     temporaries nests the later one only (DRAW_UI_HelpXpac, 00495410: `pStr =
 *     CMD_GetKeyNameForCommand(..); pFormat = GetLocaleString(..);
 *     UNICODE_FormatWideString(100, wszBuf4, pFormat, pStr);`);
 *   - nothing beside the call, nor the statement's target, reads what the call could
 *     write: every other argument and temporary is a constant, an enumerator, an
 *     address, a local whose address is never taken, or arithmetic on those. A global
 *     or a field read beside the call could be read before it under GCC and after it
 *     under VC8;
 *   - a constant held in a narrow temporary fits it, and the temporary is the whole
 *     argument (casts aside), so the constant reaches the parameter with the same value;
 *   - each call temporary's value has the temporary's type (its callee's return type, or
 *     an explicit cast), so nesting it converts nothing - or the two differ only in the
 *     sign of a 32-bit integer and the temporary is the whole argument of a parameter
 *     declared as an integer no wider than 32 bits: `int` to `eD2Sounds` (`uint32_t`) to
 *     the parameter leaves the same bits as `int` straight to it
 *     (UNITSND_GetSkillCastSound's `int` into SOUND_PlaySound's `eD2Sounds`);
 *   - the original shows the nested evaluation: before each inner CALL, the pushes of its
 *     own arguments and of the outer arguments right of it (up to the previous inner
 *     call's argument, which must hold at least one stack slot: otherwise both forms
 *     push alike); each inner CALL straight after the previous one; the outer CALL
 *     straight after the last, with exactly the pushes of the arguments up to it.
 *
 * A varargs callee has no stack slots in the facts; its arguments then count one slot
 * each when each is a 32-bit-or-narrower integer or a pointer, and the push counts below
 * confirm it.
 *
 * Liveness after the statement is followed through ifs and blocks: the temporary is dead
 * when every path writes it or returns before reading it.
 *
 * An assertion halt is left to halt-site-fold, which folds its temporaries itself. When in
 * doubt, nothing changes; without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl, CStyleCastExpr, ParameterDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import {
  calleeName, bareName, scopedLookup, shapeOfNode, shapeOfSpelling, sameShape, isWordIntegerShape,
  type TypedefResolver, type TypeShape,
} from './call-arg-cast.js';
import { isHaltStmt } from './assert-order.js';
import type { WriteEffect } from './write-effects.js';

/** One direct call the decompile prints on a line (extract/call-order.ts). */
export interface CallSiteFact {
  name: string;
  at: number;
  prev: number | null;
  pushes: number;
  slots: readonly number[] | null;
}

export interface CallOrderEvidence {
  /** Parsed-text line -> the direct calls printed on it, in print order. */
  lines: ReadonlyMap<number, readonly CallSiteFact[]>;
}

export interface NestCallOptions extends PluginOptions {
  /** The original's call order, keyed by line of the parsed text; absent: nothing changes. */
  callOrder?: CallOrderEvidence | null;
  /** Callable name (bare and qualified) -> declared return type spelling. */
  functionReturnTypes?: Record<string, string>;
  /** Callable name (bare and qualified) -> declared parameter type spellings. */
  functionParamTypes?: Record<string, string[]>;
  /** Global name -> declared type spelling. */
  globalTypes?: Record<string, string>;
  /** Callable names (bare and qualified) declared with a `...` tail. */
  varArgFunctions?: readonly string[];
  /** Enumerator names (bare and qualified): constants, whatever a call does. */
  enumConstants?: readonly string[];
  /** Callable spelling -> what a call to it may write (write-effects.ts); absent: anything. */
  writeEffects?: Record<string, WriteEffect>;
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** The enclosing function's namespace, innermost last, for unqualified callee lookup. */
  enclosingSegments?: string[];
  /** Called once per rewritten statement, with the number of temporaries nested. */
  onSite?: (e: { line: number; temps: number }) => void;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function unwrapCasts(e: Expression): Expression {
  e = unwrap(e);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrap((e as CStyleCastExpr).expression);
  return e;
}

function placed(n: ASTNode): boolean {
  return !!n.location && n.location.file !== '<generated>' && n.location.start.line > 0;
}

/** Calls, assignments, increments anywhere in `e`. */
function effects(e: ASTNode): { calls: boolean; writes: boolean } {
  let calls = false, writes = false;
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.CallExpr) {
      const name = calleeName((n as CallExpr).callee);
      if (name !== 'sizeof') calls = true;
    } else if (n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr
      || n.kind === NodeKind.NewExpr || n.kind === NodeKind.DeleteExpr) {
      writes = true;
    } else if (n.kind === NodeKind.UnaryExpr) {
      const op = (n as UnaryExpr).operator;
      if (op === '++' || op === '--') writes = true;
    }
  }
  return { calls, writes };
}

/** `nullptr` or `NULL` as the parser leaves them: a plain name. */
function isNullName(e: Expression): boolean {
  return e.kind === NodeKind.Identifier && ((e as Identifier).name === 'nullptr' || (e as Identifier).name === 'NULL');
}

function isConstant(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral
    || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.BoolLiteral || isNullName(u)) return true;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
    return unwrap((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral;
  }
  return false;
}

/** The statement's top call and the expression slot that holds it. */
function topCall(s: Statement): CallExpr | null {
  let e: Expression | null = null;
  if (s.kind === NodeKind.ExprStmt) {
    e = (s as ExprStmt).expression;
    const u = unwrap(e);
    if (u.kind === NodeKind.AssignExpr && (u as AssignExpr).operator === '=') {
      const a = u as AssignExpr;
      if (effects(a.left).calls || effects(a.left).writes) return null;
      e = a.right;
    }
  } else if (s.kind === NodeKind.ReturnStmt) {
    e = (s as ReturnStmt).value ?? null;
  }
  if (!e) return null;
  const c = unwrapCasts(e);
  return c.kind === NodeKind.CallExpr ? c as CallExpr : null;
}

interface Local { decl: VariableDecl; shape: TypeShape | null; addressed: boolean; param: boolean; array: boolean }

interface Temp {
  stmt: ExprStmt;
  name: string;
  value: Expression;
  /** The identifier the statement names it with. */
  use: Identifier;
  arg: number;
  kind: 'call' | 'read' | 'pure';
  call?: CallExpr;
}

interface Ctx {
  locals: Map<string, Local>;
  /** Every identifier of the body, in source order. */
  idents: Identifier[];
  identIndex: Map<Identifier, number>;
  labels: boolean;
  varArgs: Record<string, true>;
  enums: Record<string, true>;
  /** Start line -> statements starting there that print code. */
  lineOwners: Map<number, number>;
  ev: CallOrderEvidence;
  resolve: TypedefResolver;
  opts: NestCallOptions;
}

function collectLocals(fn: FunctionDecl): Map<string, Local> | null {
  const out = new Map<string, Local>();
  const dup = new Set<string>();
  const add = (name: string, decl: VariableDecl, shape: TypeShape | null, param: boolean) => {
    if (out.has(name)) dup.add(name);
    out.set(name, { decl, shape, addressed: false, param, array: decl.type?.kind === NodeKind.ArrayType });
  };
  for (const p of fn.parameters as ParameterDecl[]) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && n.kind === NodeKind.Identifier) add(n.name, p as unknown as VariableDecl, null, true);
  }
  if (!fn.body) return null;
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      add(v.name.name, v, null, false);
    }
  }
  for (const d of dup) out.delete(d);
  for (const n of traverseAST(fn.body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) {
        if (m.kind === NodeKind.Identifier) {
          const l = out.get((m as Identifier).name);
          if (l) l.addressed = true;
        }
      }
    }
  }
  return out;
}

/** The facts for a call named `name` printed on `s`'s lines; null unless exactly one. */
function factFor(s: Statement, name: string, ctx: Ctx): CallSiteFact | null {
  if (!placed(s)) return null;
  const bare = bareName(name);
  let found: CallSiteFact | null = null;
  for (let l = s.location.start.line; l <= s.location.end.line; l++) {
    if ((ctx.lineOwners.get(l) ?? 0) > 1) return null;
    for (const f of ctx.ev.lines.get(l) ?? []) {
      if (bareName(f.name) !== bare) continue;
      if (found) return null;
      found = f;
    }
  }
  return found;
}

function argSlots(f: CallSiteFact, from: number, to: number): number {
  let n = 0;
  for (let i = from; i <= to; i++) n += f.slots![i];
  return n;
}

/** The argument of `call` holding `id` as a value; -1 when none does, or it is an lvalue. */
function argumentOf(call: CallExpr, id: Identifier): number {
  for (let i = 0; i < call.arguments.length; i++) {
    let found: 'value' | 'lvalue' | null = null;
    const visit = (n: ASTNode, lvalue: boolean): void => {
      if (found) return;
      if (n === id) { found = lvalue ? 'lvalue' : 'value'; return; }
      if (n.kind === NodeKind.UnaryExpr) {
        const op = (n as UnaryExpr).operator;
        visit((n as UnaryExpr).operand, op === '&' || op === '++' || op === '--');
        return;
      }
      const writes = n.kind === NodeKind.PostfixExpr || n.kind === NodeKind.AssignExpr;
      for (const k of getChildren(n)) visit(k, writes);
    };
    visit(call.arguments[i], false);
    if (found === 'value') return i;
    if (found === 'lvalue') return -1;
  }
  return -1;
}

function returnShape(call: CallExpr, ctx: Ctx): TypeShape | null {
  const name = calleeName(call.callee);
  if (!name) return null;
  const spelling = scopedLookup(ctx.opts.functionReturnTypes ?? {}, name, ctx.opts.enclosingSegments ?? []);
  return spelling ? shapeOfSpelling(spelling, ctx.resolve) : null;
}

/** `x = value;` with x a local whose value the statement can take over; else null. */
function tempOf(s: Statement, ctx: Ctx): { stmt: ExprStmt; name: string; value: Expression; local: Local } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const a = e as AssignExpr;
  if (a.left.kind !== NodeKind.Identifier) return null;
  const name = (a.left as Identifier).name;
  const local = ctx.locals.get(name);
  if (!local || local.param || local.addressed || local.array) return null;
  if (effects(a.right).writes) return null;
  return { stmt: s as ExprStmt, name, value: a.right, local };
}

function declShape(l: Local, ctx: Ctx): TypeShape | null {
  return shapeOfNode(l.decl.type, 0, ctx.resolve);
}

/** The 32-bit integers of this target, which differ from each other in sign only. */
const WORD_INTEGERS = new Set(['int', 'unsigned int', 'long', 'unsigned long']);

/** Integers no wider than 32 bits: a conversion into one keeps only the low bits. */
const NARROW_INTEGERS = new Set([
  'char', 'signed char', 'unsigned char', 'short', 'unsigned short', 'wchar_t', 'bool',
  ...WORD_INTEGERS,
]);

/**
 * Whether a call returning `from` may stand in an argument where the decompile stored it
 * in a temporary of type `to` first: the two are 32-bit integers that differ in sign
 * only, the temporary is the argument itself, and the parameter takes at most 32 bits,
 * so `from` -> `to` -> parameter and `from` -> parameter store the same bits.
 */
function signOnlyIntoNarrowParam(from: TypeShape, to: TypeShape, site: { call: CallExpr; arg: number; use: Identifier }, ctx: Ctx): boolean {
  if (from.stars !== 0 || to.stars !== 0) return false;
  if (!WORD_INTEGERS.has(from.base) || !WORD_INTEGERS.has(to.base)) return false;
  if (unwrap(site.call.arguments[site.arg]) !== site.use) return false;
  const name = calleeName(site.call.callee);
  if (!name) return false;
  const params = scopedLookup(ctx.opts.functionParamTypes ?? {}, name, ctx.opts.enclosingSegments ?? []);
  const spelling = params?.[site.arg];
  if (!spelling || params!.length !== site.call.arguments.length) return false;
  const p = shapeOfSpelling(spelling, ctx.resolve);
  return !!p && p.stars === 0 && NARROW_INTEGERS.has(p.base);
}

/** The value class of a temporary, or null when nesting it could convert or reorder it. */
function classify(
  t: { value: Expression; local: Local }, ctx: Ctx,
  site: { call: CallExpr; arg: number; use: Identifier },
): { kind: Temp['kind']; call?: CallExpr } | null {
  const shape = declShape(t.local, ctx);
  if (!shape) return null;
  const v = unwrap(t.value);
  const fx = effects(v);
  const inner = unwrapCasts(v);
  if (inner.kind === NodeKind.CallExpr) {
    const call = inner as CallExpr;
    // A cast in front carries the conversion; without one the callee returns the type.
    if (v.kind === NodeKind.CStyleCastExpr) {
      const to = shapeOfNode((v as CStyleCastExpr).type, 0, ctx.resolve);
      if (!to || !sameShape(to, shape)) return null;
    } else {
      const r = returnShape(call, ctx);
      if (!r || !(sameShape(r, shape) || signOnlyIntoNarrowParam(r, shape, site, ctx))) return null;
    }
    if (!calleeName(call.callee)) return null;
    return { kind: 'call', call };
  }
  if (fx.calls) return null;
  const word = isWordIntegerShape(shape) || shape.stars > 0;
  if (isConstant(v)) return word || fitsNarrow(v, shape, site) ? { kind: 'pure' } : null;
  if (v.kind === NodeKind.Identifier) {
    const name = (v as Identifier).name;
    const l = ctx.locals.get(name);
    if (l) {
      if (l.addressed) return null;
      const s = l.param ? null : declShape(l, ctx);
      return s && sameShape(s, shape) ? { kind: 'pure' } : null;
    }
    const g = ctx.opts.globalTypes?.[name];
    const gs = g ? shapeOfSpelling(g, ctx.resolve) : null;
    return gs && sameShape(gs, shape) ? { kind: 'read' } : null;
  }
  return null;
}

/** Value range of the integers narrower than 32 bits. */
const NARROW_RANGES: Record<string, [bigint, bigint]> = {
  'bool': [0n, 1n],
  'char': [-128n, 127n], 'signed char': [-128n, 127n], 'unsigned char': [0n, 255n],
  'short': [-32768n, 32767n], 'unsigned short': [0n, 65535n], 'wchar_t': [0n, 65535n],
};

function constantValue(e: Expression): bigint | null {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.IntegerLiteral: return (u as unknown as { value: bigint }).value;
    case NodeKind.CharLiteral: return BigInt((u as unknown as { value: number }).value);
    case NodeKind.BoolLiteral: return (u as unknown as { value: boolean }).value ? 1n : 0n;
    case NodeKind.UnaryExpr: {
      const x = (u as UnaryExpr).operator === '-' ? constantValue((u as UnaryExpr).operand) : null;
      return x === null ? null : -x;
    }
    default: return null;
  }
}

/**
 * A constant in a narrow temporary that the temporary holds unchanged, standing as the
 * whole argument (casts aside): the parameter then receives the same value either way.
 */
function fitsNarrow(v: Expression, shape: TypeShape, site: { call: CallExpr; arg: number; use: Identifier }): boolean {
  if (shape.stars !== 0) return false;
  const range = NARROW_RANGES[shape.base];
  const x = constantValue(v);
  if (!range || x === null || x < range[0] || x > range[1]) return false;
  return unwrapCasts(site.call.arguments[site.arg]) === site.use;
}

function globalSpelling(name: string, ctx: Ctx): string | undefined {
  return scopedLookup(ctx.opts.globalTypes ?? {}, name, ctx.opts.enclosingSegments ?? []);
}

/** A name as an expression: a qualified name's spelling, or null. */
function nameOf(e: Expression): string | null {
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) return calleeName(e) ?? null;
  return null;
}

/**
 * Whether evaluating `e` reads nothing a call could change and changes nothing: constants,
 * locals whose address is never taken, addresses, and arithmetic on them. `free` names
 * the identifiers that stand for the temporaries being nested.
 */
function orderFree(e: ASTNode, ctx: Ctx, free: ReadonlySet<ASTNode>): boolean {
  if (free.has(e)) return true;
  switch (e.kind) {
    case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral:
    case NodeKind.NullptrLiteral: case NodeKind.FloatingLiteral: case NodeKind.StringLiteral:
    case NodeKind.SizeofExpr: case NodeKind.AlignofExpr:
      return true;
    case NodeKind.Identifier: case NodeKind.QualifiedId: {
      const name = nameOf(e as Expression);
      if (!name) return false;
      if (isNullName(e as Expression)) return true;
      const l = e.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
      if (l) return l.array || !l.addressed;
      // A global array is its address; any other global is memory a call may write.
      const g = globalSpelling(name, ctx);
      if (g !== undefined) return g.includes('[');
      // An enumerator is a constant and a function designates its address; anything else
      // unknown is not trusted.
      const segs = ctx.opts.enclosingSegments ?? [];
      return scopedLookup(ctx.enums, name, segs) !== undefined
        || scopedLookup(ctx.opts.functionReturnTypes ?? {}, name, segs) !== undefined;
    }
    case NodeKind.ParenExpr:
      return orderFree((e as ParenExpr).expression, ctx, free);
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
    case NodeKind.ConstCastExpr:
      return orderFree((e as unknown as { expression: Expression }).expression, ctx, free);
    case NodeKind.FunctionalCastExpr:
      return (e as unknown as { arguments: Expression[] }).arguments.every(a => orderFree(a, ctx, free));
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator === '&') return addressFree(u.operand, ctx, free);
      if (u.operator === '*' || u.operator === '++' || u.operator === '--') return false;
      return orderFree(u.operand, ctx, free);
    }
    case NodeKind.BinaryExpr: {
      const b = e as unknown as { left: Expression; right: Expression };
      return orderFree(b.left, ctx, free) && orderFree(b.right, ctx, free);
    }
    case NodeKind.ConditionalExpr: {
      const c = e as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
      return orderFree(c.condition, ctx, free) && orderFree(c.thenExpr, ctx, free) && orderFree(c.elseExpr, ctx, free);
    }
    case NodeKind.MemberExpr: {
      // A field of a local struct nothing else can reach.
      const m = e as unknown as { object: Expression; isArrow: boolean };
      if (m.isArrow) return false;
      const o = unwrap(m.object);
      if (o.kind !== NodeKind.Identifier) return false;
      const l = ctx.locals.get((o as Identifier).name);
      return !!l && !l.addressed && !l.array;
    }
    default:
      return false;
  }
}

/** Whether computing the address of the lvalue `e` reads nothing a call could change. */
function addressFree(e: Expression, ctx: Ctx, free: ReadonlySet<ASTNode>): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId:
      return true;
    case NodeKind.MemberExpr: {
      const m = u as unknown as { object: Expression; isArrow: boolean };
      return m.isArrow ? orderFree(m.object, ctx, free) : addressFree(m.object, ctx, free);
    }
    case NodeKind.SubscriptExpr: {
      const s = u as unknown as { array: Expression; index: Expression };
      const base = unwrap(s.array);
      const name = nameOf(base);
      const arrayBase = !!name && (ctx.locals.get(name)?.array || (globalSpelling(name, ctx) ?? '').includes('['));
      return (arrayBase || orderFree(s.array, ctx, free)) && orderFree(s.index, ctx, free);
    }
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '*' && orderFree((u as UnaryExpr).operand, ctx, free);
    default:
      return false;
  }
}

/** What a call may write, as the arguments beside it see it. */
interface Writes { unknown: boolean; memory: boolean; globals: Set<string> }

/**
 * What evaluating `call` may write: its callee's summary and those of the calls in its
 * arguments. A write through a pointer argument is memory.
 */
function callWrites(call: CallExpr, ctx: Ctx): Writes {
  const w: Writes = { unknown: false, memory: false, globals: new Set() };
  for (const n of traverseAST(call)) {
    if (n.kind !== NodeKind.CallExpr) continue;
    const name = calleeName((n as CallExpr).callee);
    if (name === 'sizeof') continue;
    const e = name ? scopedLookup(ctx.opts.writeEffects ?? {}, name, ctx.opts.enclosingSegments ?? []) : undefined;
    if (!e || e.unknown) { w.unknown = true; return w; }
    if (e.memory || e.params?.length) w.memory = true;
    for (const g of e.globals ?? []) w.globals.add(g);
  }
  return w;
}

/**
 * Whether the call may write the global spelled `name` here. The summary names globals as
 * the database does; the emitter splits a table into pieces named after it
 * (`gaAct5SceneryPresetTable_0_0__1_`), so a name that extends a written one, or that a
 * written one extends, counts as written.
 */
function writesGlobal(w: Writes, name: string): boolean {
  const leaf = bareName(name);
  for (const g of w.globals) if (g === leaf || leaf.startsWith(g + '_') || g.startsWith(leaf + '_')) return true;
  return false;
}

/**
 * Whether `e` reads the same beside a call that writes `w`, in any order: it calls and
 * changes nothing, and reads no global the call writes, no memory behind a pointer when
 * the call writes memory or any global (a pointer may hold a global's address), and no
 * local whose address escaped when the call writes memory. Without the call's summary,
 * only what nothing can write (orderFree).
 */
function beside(e: ASTNode, w: Writes, ctx: Ctx, free: ReadonlySet<ASTNode>): boolean {
  if (w.unknown) return orderFree(e, ctx, free);
  if (free.has(e)) return true;
  const throughPointer = !w.memory && w.globals.size === 0;
  switch (e.kind) {
    case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral:
    case NodeKind.NullptrLiteral: case NodeKind.FloatingLiteral: case NodeKind.StringLiteral:
    case NodeKind.SizeofExpr: case NodeKind.AlignofExpr:
      return true;
    case NodeKind.Identifier: case NodeKind.QualifiedId: {
      const name = nameOf(e as Expression);
      if (!name) return false;
      if (isNullName(e as Expression)) return true;
      const l = e.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
      if (l) return l.array || !l.addressed || !w.memory;
      const g = globalSpelling(name, ctx);
      if (g !== undefined) return g.includes('[') || (!w.memory && !writesGlobal(w, name));
      return orderFree(e, ctx, free);
    }
    case NodeKind.ParenExpr:
      return beside((e as ParenExpr).expression, w, ctx, free);
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr:
    case NodeKind.ConstCastExpr:
      return beside((e as unknown as { expression: Expression }).expression, w, ctx, free);
    case NodeKind.FunctionalCastExpr:
      return (e as unknown as { arguments: Expression[] }).arguments.every(a => beside(a, w, ctx, free));
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator === '&') return besideAddress(u.operand, w, ctx, free);
      if (u.operator === '++' || u.operator === '--') return false;
      if (u.operator === '*') return throughPointer && beside(u.operand, w, ctx, free);
      return beside(u.operand, w, ctx, free);
    }
    case NodeKind.BinaryExpr: {
      const b = e as unknown as { left: Expression; right: Expression };
      return beside(b.left, w, ctx, free) && beside(b.right, w, ctx, free);
    }
    case NodeKind.ConditionalExpr: {
      const c = e as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
      return beside(c.condition, w, ctx, free) && beside(c.thenExpr, w, ctx, free) && beside(c.elseExpr, w, ctx, free);
    }
    case NodeKind.MemberExpr: {
      const m = e as unknown as { object: Expression; isArrow: boolean };
      if (m.isArrow) return throughPointer && beside(m.object, w, ctx, free);
      return besideObject(m.object, w, ctx, free);
    }
    case NodeKind.SubscriptExpr: {
      const s = e as unknown as { array: Expression; index: Expression };
      if (!beside(s.index, w, ctx, free)) return false;
      const base = unwrap(s.array);
      const name = nameOf(base);
      const local = name && base.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
      if (local?.array) return !w.memory;
      if (name && !local && (globalSpelling(name, ctx) ?? '').includes('[')) return !w.memory && !writesGlobal(w, name);
      return throughPointer && beside(s.array, w, ctx, free);
    }
    default:
      return false;
  }
}

/** Whether the object `e` (an lvalue whose field is read) holds the same value beside the call. */
function besideObject(e: Expression, w: Writes, ctx: Ctx, free: ReadonlySet<ASTNode>): boolean {
  const u = unwrap(e);
  const name = nameOf(u);
  if (name) {
    const l = u.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
    if (l) return !w.memory || (!l.addressed && !l.array);
    if (globalSpelling(name, ctx) !== undefined) return !w.memory && !writesGlobal(w, name);
    return false;
  }
  return beside(u, w, ctx, free);
}

/** Whether computing the address of the lvalue `e` reads the same beside the call. */
function besideAddress(e: Expression, w: Writes, ctx: Ctx, free: ReadonlySet<ASTNode>): boolean {
  if (w.unknown) return addressFree(e, ctx, free);
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId:
      return true;
    case NodeKind.MemberExpr: {
      const m = u as unknown as { object: Expression; isArrow: boolean };
      return m.isArrow ? beside(m.object, w, ctx, free) : besideAddress(m.object, w, ctx, free);
    }
    case NodeKind.SubscriptExpr: {
      const s = u as unknown as { array: Expression; index: Expression };
      const base = unwrap(s.array);
      const name = nameOf(base);
      const arrayBase = !!name && (ctx.locals.get(name)?.array || (globalSpelling(name, ctx) ?? '').includes('['));
      return (arrayBase || beside(s.array, w, ctx, free)) && beside(s.index, w, ctx, free);
    }
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '*' && beside((u as UnaryExpr).operand, w, ctx, free);
    default:
      return false;
  }
}

/** Stack slots of a value of shape `s` passed as an argument: 32 bits or narrower, or a pointer. */
function slotOfShape(s: TypeShape | null): number | null {
  if (!s) return null;
  if (s.stars > 0) return 1;
  return NARROW_INTEGERS.has(s.base) ? 1 : null;
}

/** Stack slots of an argument expression, where its type can be told; else null. */
function slotOfArg(e: Expression, temps: ReadonlyMap<ASTNode, Local>, ctx: Ctx): number | null {
  const u = unwrap(e);
  const t = temps.get(u);
  if (t) return slotOfShape(declShape(t, ctx));
  switch (u.kind) {
    case NodeKind.IntegerLiteral:
      return /ll/i.test((u as unknown as { suffix: string }).suffix ?? '') ? null : 1;
    case NodeKind.CharLiteral: case NodeKind.StringLiteral: case NodeKind.NullptrLiteral: case NodeKind.BoolLiteral:
      return 1;
    case NodeKind.UnaryExpr:
      return (u as UnaryExpr).operator === '&' ? 1 : null;
    case NodeKind.CStyleCastExpr:
      return slotOfShape(shapeOfNode((u as CStyleCastExpr).type, 0, ctx.resolve));
    case NodeKind.CallExpr:
      return slotOfShape(returnShape(u as CallExpr, ctx));
    case NodeKind.Identifier: {
      const name = (u as Identifier).name;
      const l = ctx.locals.get(name);
      if (l) return l.param ? null : slotOfShape(declShape(l, ctx));
      const g = globalSpelling(name, ctx);
      return g ? slotOfShape(shapeOfSpelling(g, ctx.resolve)) : null;
    }
    default:
      return null;
  }
}

/**
 * The facts' stack slots for `call`, or for a varargs callee (which the facts leave
 * without) one slot per argument whose width can be told; null otherwise.
 */
function outerSlots(fact: CallSiteFact, call: CallExpr, temps: ReadonlyMap<ASTNode, Local>, ctx: Ctx): readonly number[] | null {
  if (fact.slots) return fact.slots.length === call.arguments.length ? fact.slots : null;
  const name = calleeName(call.callee);
  if (!name || !scopedLookup(ctx.varArgs, name, ctx.opts.enclosingSegments ?? [])) return null;
  const fixed = scopedLookup(ctx.opts.functionParamTypes ?? {}, name, ctx.opts.enclosingSegments ?? []);
  if (!fixed || fixed.length > call.arguments.length) return null;
  const out: number[] = [];
  for (let i = 0; i < call.arguments.length; i++) {
    const n = i < fixed.length ? slotOfShape(shapeOfSpelling(fixed[i], ctx.resolve)) : slotOfArg(call.arguments[i], temps, ctx);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** Statement-list path of a statement: [block, index] from the body down. */
type Path = { block: CompoundStmt; index: number }[];

/**
 * Whether `name` is dead after `s` (path `path`): no mention outside `allowed`, or the
 * next one in source order is `name = <no name>;` on a later sibling of `s` or of a block
 * holding it, with no loop or switch around `s` and no label in the function.
 */
function deadAfter(name: string, allowed: Set<Identifier>, path: Path, guarded: boolean, ctx: Ctx): boolean {
  const mentions = ctx.idents.filter(i => i.name === name && !allowed.has(i));
  if (mentions.length === 0) return true;
  if (guarded || ctx.labels) return false;
  const last = Math.max(...[...allowed].map(i => ctx.identIndex.get(i) ?? -1));
  if (!mentions.some(i => (ctx.identIndex.get(i) ?? -1) > last)) return true;
  for (let d = path.length - 1; d >= 0; d--) {
    const { block, index } = path[d];
    for (let j = index + 1; j < block.statements.length; j++) {
      const r = flowOf(block.statements[j], name);
      if (r === 'read') return false;
      if (r === 'kill') return true;
    }
  }
  return true;
}

const mentionsName = (n: ASTNode, name: string) =>
  [...traverseAST(n)].some(m => m.kind === NodeKind.Identifier && (m as Identifier).name === name);

/**
 * What running `s` does to `name`: 'read' when some path may read it before writing it,
 * 'kill' when every path writes it (or returns) first, 'pass' otherwise. Anything but an
 * expression, a return, an if or a block counts as a read when it names it.
 */
function flowOf(s: Statement, name: string): 'read' | 'kill' | 'pass' {
  switch (s.kind) {
    case NodeKind.ExprStmt: {
      const e = unwrap((s as ExprStmt).expression);
      if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '='
        && (e as AssignExpr).left.kind === NodeKind.Identifier && ((e as AssignExpr).left as Identifier).name === name) {
        return mentionsName((e as AssignExpr).right, name) ? 'read' : 'kill';
      }
      return mentionsName(s, name) ? 'read' : 'pass';
    }
    case NodeKind.ReturnStmt:
      return mentionsName(s, name) ? 'read' : 'kill';
    case NodeKind.CompoundStmt:
      for (const k of (s as CompoundStmt).statements) {
        const r = flowOf(k, name);
        if (r !== 'pass') return r;
      }
      return 'pass';
    case NodeKind.IfStmt: {
      const i = s as IfStmt;
      if (i.init || mentionsName(i.condition, name)) return 'read';
      const a = flowOf(i.thenBranch, name);
      const b = i.elseBranch ? flowOf(i.elseBranch, name) : 'pass';
      if (a === 'read' || b === 'read') return 'read';
      return a === 'kill' && b === 'kill' ? 'kill' : 'pass';
    }
    default:
      return mentionsName(s, name) ? 'read' : 'pass';
  }
}

/**
 * The run of temporaries right above `stmts[b]` that goes into its top call, or null.
 * Temporaries are dropped from the front (the earliest) until the rest qualifies.
 */
/** `path` ends with this statement's own block and index. */
function siteAt(stmts: Statement[], b: number, path: Path, guarded: boolean, ctx: Ctx): { temps: Temp[]; call: CallExpr } | null {
  const s = stmts[b];
  // An assertion's temporaries are halt-site-fold's: it folds the same ones, later.
  if (isHaltStmt(s)) return null;
  const call = topCall(s);
  if (!call) return null;
  const outerName = calleeName(call.callee);
  if (!outerName) return null;
  for (const a of call.arguments) if (effects(a).writes) return null;

  const collected: Temp[] = [];
  const names = new Set<string>();
  for (let j = b - 1; j >= 0; j--) {
    const t = tempOf(stmts[j], ctx);
    if (!t || names.has(t.name)) break;
    // A later temporary's value must not read this one, nor assign anything it reads.
    if (collected.some(u => [...traverseAST(u.value)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === t.name))) break;
    if (collected.some(u => [...traverseAST(t.value)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === u.name))) break;
    const uses = [...traverseAST(s)].filter(n => n.kind === NodeKind.Identifier && (n as Identifier).name === t.name) as Identifier[];
    if (uses.length !== 1) break;
    const arg = argumentOf(call, uses[0]);
    if (arg < 0) break;
    const c = classify(t, ctx, { call, arg, use: uses[0] });
    if (!c) break;
    names.add(t.name);
    collected.push({ stmt: t.stmt, name: t.name, value: t.value, use: uses[0], arg, kind: c.kind, call: c.call });
  }
  collected.reverse();

  const fact = factFor(s, outerName, ctx);
  if (!fact) return null;
  const tempLocals = new Map<ASTNode, Local>(collected.map(t => [t.use, ctx.locals.get(t.name)!]));
  const slots = outerSlots(fact, call, tempLocals, ctx);
  if (!slots) return null;
  const outer: CallSiteFact = { ...fact, slots };
  // The statement's target is evaluated beside the arguments as well.
  const target = s.kind === NodeKind.ExprStmt && unwrap((s as ExprStmt).expression).kind === NodeKind.AssignExpr
    ? (unwrap((s as ExprStmt).expression) as AssignExpr).left : null;

  for (let first = 0; first < collected.length; first++) {
    const temps = collected.slice(first);
    if (validRun(temps, call, outer, target, path, guarded, ctx)) return { temps, call };
  }
  return null;
}

function validRun(temps: Temp[], call: CallExpr, outer: CallSiteFact, target: Expression | null, path: Path, guarded: boolean, ctx: Ctx): boolean {
  const calls = temps.filter(t => t.kind === 'call');
  // One call, beside arguments that call and change nothing: VC8 evaluates them right to
  // left, GCC in an order of its own, and either order runs the same side effects.
  if (calls.length !== 1) return false;
  // Calls and reads in VC8's order: the earliest in the argument furthest right.
  const ordered = temps.filter(t => t.kind !== 'pure');
  for (let i = 0; i + 1 < ordered.length; i++) if (ordered[i].arg <= ordered[i + 1].arg) return false;
  // Nor may anything beside it read what the call could write: a global, a field, memory
  // behind a pointer, a local whose address escaped. GCC may read it before the call
  // where VC8 reads it after.
  const writes = callWrites(calls[0].call!, ctx);
  if (temps.some(t => t.kind === 'read' && !beside(t.value, writes, ctx, new Set()))) return false;
  const free = new Set<ASTNode>(temps.map(t => t.use));
  for (const a of call.arguments) if (!beside(a, writes, ctx, free)) return false;
  if (target && !besideAddress(target, writes, ctx, new Set())) return false;
  // Evidence, call by call in evaluation order: before each inner CALL the pushes of the
  // arguments right of it (up to the previous inner call's) and its own; the outer CALL
  // right after the last with the pushes of the arguments up to it.
  const facts: CallSiteFact[] = [];
  const n = call.arguments.length;
  for (let j = 0; j < calls.length; j++) {
    const c = calls[j];
    const f = factFor(c.stmt, calleeName(c.call!.callee)!, ctx);
    if (!f || !f.slots || f.slots.length !== c.call!.arguments.length) return false;
    const between = argSlots(outer, c.arg + 1, j === 0 ? n - 1 : calls[j - 1].arg);
    if (between === 0) return false;
    if (f.pushes !== between + argSlots(f, 0, f.slots.length - 1)) return false;
    if (j > 0 && f.prev !== facts[j - 1].at) return false;
    facts.push(f);
  }
  const last = calls[calls.length - 1];
  if (outer.prev !== facts[facts.length - 1].at) return false;
  if (outer.pushes !== argSlots(outer, 0, last.arg)) return false;
  // Each temporary dead after the statement.
  for (const t of temps) {
    const allowed = new Set<Identifier>([t.use, (unwrap(t.stmt.expression) as AssignExpr).left as Identifier,
      ctx.locals.get(t.name)!.decl.name]);
    if (!deadAfter(t.name, allowed, path, guarded, ctx)) return false;
  }
  return true;
}

function rewriteFunction(fn: FunctionDecl, ev: CallOrderEvidence, opts: NestCallOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const typedefTargets = opts.typedefTargets ?? {};
  const body = cloneNode(fn.body);
  const work: FunctionDecl = { ...fn, body };
  const locals = collectLocals(work);
  if (!locals) return undefined;
  const lineOwners = new Map<number, number>();
  let labels = false;
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) labels = true;
    if ((n.kind === NodeKind.ExprStmt || n.kind === NodeKind.ReturnStmt || n.kind === NodeKind.DeclStmt) && placed(n)) {
      const l = n.location.start.line;
      lineOwners.set(l, (lineOwners.get(l) ?? 0) + 1);
    }
  }
  const varArgs: Record<string, true> = {};
  for (const n of opts.varArgFunctions ?? []) varArgs[n] = true;
  const enums: Record<string, true> = {};
  for (const n of opts.enumConstants ?? []) enums[n] = true;
  const ctx: Ctx = {
    locals, idents: [], identIndex: new Map(), labels, varArgs, enums, lineOwners, ev,
    resolve: name => typedefTargets[name], opts,
  };
  const reindex = () => {
    ctx.idents = [...traverseAST(body)].filter(n => n.kind === NodeKind.Identifier) as Identifier[];
    ctx.identIndex = new Map(ctx.idents.map((n, i) => [n, i]));
  };
  reindex();

  let changed = 0;
  const removedDecls = new Set<string>();
  const visit = (n: ASTNode, path: Path, guarded: boolean): void => {
    if (n.kind === NodeKind.CompoundStmt) {
      const block = n as CompoundStmt;
      for (let b = block.statements.length - 1; b >= 0; b--) {
        const here: Path = [...path, { block, index: b }];
        visit(block.statements[b], here, guarded);
        const site = siteAt(block.statements, b, here, guarded, ctx);
        if (!site) continue;
        const { temps } = site;
        const s = block.statements[b];
        const holders = temps.map(t => parentOf(s, t.use));
        if (holders.some(h => !h)) continue;
        temps.forEach((t, i) => replaceChild(holders[i]!, t.use, wrapIfNeeded(t.value, holders[i]!)));
        const start = b - temps.length;
        // Comments on the temporaries' lines stay, above the statement.
        s.leadingTrivia = [...temps.flatMap(t => t.stmt.leadingTrivia ?? []), ...(s.leadingTrivia ?? [])];
        block.statements.splice(start, temps.length);
        b = start;
        for (const t of temps) removedDecls.add(t.name);
        changed++;
        opts.onSite?.({ line: s.location?.start.line ?? 0, temps: temps.length });
        reindex();
      }
      return;
    }
    const inner = guarded || LOOPS.has(n.kind) || n.kind === NodeKind.SwitchStmt;
    for (const k of getChildren(n)) visit(k, path, inner);
  };
  visit(body, [], false);
  if (!changed) return undefined;

  // Drop a declaration nothing names any more.
  for (const name of removedDecls) {
    const decl = ctx.locals.get(name)!.decl;
    if (ctx.idents.some(i => i.name === name && i !== decl.name)) continue;
    // A declaration whose initializer calls or assigns stays: only its name is unused.
    if (decl.initializer && (effects(decl.initializer).calls || effects(decl.initializer).writes)) continue;
    dropDecl(body, decl);
  }
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

function parentOf(root: ASTNode, target: ASTNode): ASTNode | null {
  for (const n of traverseAST(root)) {
    if (getChildren(n).includes(target)) return n;
  }
  return null;
}

/** Replace `from` by `to` among `parent`'s own fields (one level, arrays included). */
function replaceChild(parent: ASTNode, from: ASTNode, to: ASTNode): void {
  const rec = parent as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (v === from) { rec[key] = to; return; }
    if (Array.isArray(v)) {
      const i = v.indexOf(from);
      if (i >= 0) { v[i] = to; return; }
    }
  }
}

/** The value as it replaces a name: parenthesised unless a call, a name or a literal. */
function wrapIfNeeded(value: Expression, parent: ASTNode): Expression {
  const v = unwrap(value);
  const primary = v.kind === NodeKind.CallExpr || v.kind === NodeKind.Identifier || v.kind === NodeKind.IntegerLiteral
    || v.kind === NodeKind.CharLiteral || v.kind === NodeKind.NullptrLiteral || v.kind === NodeKind.BoolLiteral
    || v.kind === NodeKind.QualifiedId;
  if (primary || parent.kind === NodeKind.CallExpr) return value;
  if (value.kind === NodeKind.ParenExpr) return value;
  return { kind: NodeKind.ParenExpr, expression: value, location: value.location } as ParenExpr;
}

function dropDecl(body: CompoundStmt, decl: VariableDecl): void {
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const block = n as CompoundStmt;
    for (let i = 0; i < block.statements.length; i++) {
      const st = block.statements[i];
      if (st.kind !== NodeKind.DeclStmt) continue;
      const ds = st as DeclStmt;
      const k = ds.declarations.indexOf(decl);
      if (k < 0) continue;
      if (ds.declarations.length === 1) block.statements.splice(i, 1);
      else ds.declarations.splice(k, 1);
      return;
    }
  }
}

export function nestCall_forTest(fn: FunctionDecl, opts: NestCallOptions): FunctionDecl {
  return opts.callOrder ? rewriteFunction(fn, opts.callOrder, opts) ?? fn : fn;
}

function createNestCallTransformer(options: NestCallOptions = {}): Transformer {
  const ev = options.callOrder;
  if (!ev) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev, options);
    },
  });
}

export const nestCallPlugin: TransformPlugin = {
  id: 'nest-call',
  name: 'Nest Call',
  description:
    'Puts a call the decompiler handed back through a temporary into the argument list it was nested in, where the original evaluated the arguments right of it first',
  version: '1.0.0',
  defaultEnabled: true,
  // After goto structuring and the late comma expansion (59), so the statement lists are
  // final; before decl-init-merge (60) folds a first assignment into its declaration.
  priority: 59.5,
  tags: ['matching', 'cleanup'],
  createTransformer: createNestCallTransformer,
};


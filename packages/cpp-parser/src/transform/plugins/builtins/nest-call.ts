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
 *   - each temporary is a local assigned one value (`x = v;`, or declared with it, `T x =
 *     v;`, which leaves `T x;` when x is written again later), named exactly once in the
 *     statement, inside an argument of its top call, as a value (not an lvalue, not its
 *     address); a member named like it (`p->x`) is no mention;
 *   - it is dead after the statement: on the function's control flow (loops, switches and
 *     gotos included, cfg/dataflow.ts) its value reaches that one read and no other, and
 *     no other value of it reaches the statement;
 *   - a temporary holding a call or a memory read stands where VC8 evaluates it: the
 *     earliest in the argument furthest right; one holding a constant or a local whose
 *     address is never taken may stand anywhere;
 *   - the nested calls, the other temporaries and the other arguments (and the statement's
 *     target) give the same result in any order: VC8 evaluates arguments right to left,
 *     GCC in an order of its own, so none may write what another reads or writes, by the
 *     callees' summaries (write-effects.ts). Two getters that write nothing nest side by
 *     side; two rolls of one seed (`SOUND_PlayEnvironmentSound(n,
 *     RollBetweenMinAndMax(pSeed, ..), RollBetweenMinAndMax(pSeed, ..), 0)`) do not, nor
 *     does a global read beside a call that writes it. A run of temporaries that may not
 *     all nest nests its later ones (DRAW_UI_HelpXpac, 00495410). Memory reached through
 *     typed pointers is apart when the regions are (memory-regions.ts): RollRandomNumerUp-
 *     ToArgument stores only a D2SeedStrc, so `pMonSoundsLine->Flee` beside it reads the
 *     same either way (UNITSND_PlayFleeSound);
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
 * A temporary whose one read is in a later temporary's call goes in with it, as a chain
 * (Skills_CltDoFunc_Bar_DoubleSwing_Sound, 004c7d50: `nHitClass = GetHitClass(pUnit);
 * nSound = UNITSND_GetSkillCastSound(pUnit, nHitClass); SOUND_PlaySound(nSound, pUnit, 4, 0,
 * 0);`, where the original pushes 0, 0, 4 before the GetHitClass call). The nested
 * evaluation is then followed call by call, right to left with each argument's calls before
 * its push, and every CALL of the statement must have the PUSHes and the predecessor it
 * predicts, and some CALL other PUSHes than the printed order gives it. A chain moves as one
 * against the other arguments, which it must not write or read what they write.
 *
 * The statement's target may be the temporary itself (`pRoom = GetRoom(pUnit); pRoom =
 * FindBetterNearbyRoom(pRoom, nX, nY);`, 005cbe00); a temporary may hold 32-bit integer
 * arithmetic on names and constants (`nX = gnPanelOffsetX + 0x24;`, UI_DrawPartyMemberClass
 * 0049a3d0) when its type is the expression's, or differs in sign only into a narrow integer
 * parameter, and it reads a global like a global read does.
 *
 * A varargs callee has no stack slots in the facts; its arguments then count one slot
 * each when each is a 32-bit-or-narrower integer or a pointer, and the push counts below
 * confirm it.
 *
 * Where the control flow is not modelled in full (a try, a range for), liveness is followed
 * through ifs and blocks only, outside loops and switches in a function without labels: the
 * temporary is dead when every path writes it or returns before reading it.
 *
 * An assertion halt is left to halt-site-fold, which folds its temporaries itself. When in
 * doubt, nothing changes; without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
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
import { Regions, regionOf, typeOf, type AggregateModel, type TypingEnv } from './memory-regions.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';

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
  /** The aggregates, for the regions an access through a typed pointer reaches. */
  aggregates?: AggregateModel;
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

/** The identifiers in `n` that name variables: a member's name after `.` or `->` does not. */
function namesIn(n: ASTNode): Identifier[] {
  const members = new Set<ASTNode>();
  const out: Identifier[] = [];
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as unknown as { member: ASTNode }).member);
    else if (m.kind === NodeKind.Identifier && !members.has(m)) out.push(m as Identifier);
  }
  return out;
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

interface Local {
  decl: VariableDecl; shape: TypeShape | null; addressed: boolean; param: boolean; array: boolean;
  /** No assignment converts a value into it with a cast, and its address is not taken. */
  trusted: boolean;
}

interface Temp {
  /** `x = value;`, or `T x = value;` declaring it. */
  stmt: ExprStmt | DeclStmt;
  /** The identifier the statement writes it with. */
  def: Identifier;
  name: string;
  value: Expression;
  /** The identifier the statement names it with. */
  use: Identifier;
  arg: number;
  kind: 'call' | 'read' | 'pure';
  call?: CallExpr;
  /** The later temporary whose call takes this one as an argument (a chain), if any. */
  host?: Temp;
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
  regions: Regions | null;
  typing: TypingEnv;
  body: CompoundStmt;
  /** The body's dataflow, built when first asked for and dropped on every rewrite. */
  flow?: FunctionFlow | null;
}

function collectLocals(fn: FunctionDecl): Map<string, Local> | null {
  const out = new Map<string, Local>();
  const dup = new Set<string>();
  const add = (name: string, decl: VariableDecl, shape: TypeShape | null, param: boolean) => {
    if (out.has(name)) dup.add(name);
    out.set(name, { decl, shape, addressed: false, param, array: decl.type?.kind === NodeKind.ArrayType, trusted: true });
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
          if (l) { l.addressed = true; l.trusted = false; }
        }
      }
    }
    if (n.kind === NodeKind.AssignExpr && (n as AssignExpr).operator === '=') {
      const left = unwrap((n as AssignExpr).left);
      const l = left.kind === NodeKind.Identifier ? out.get((left as Identifier).name) : undefined;
      if (l && convertsByCast((n as AssignExpr).right)) l.trusted = false;
    }
  }
  for (const l of out.values()) if (l.decl.initializer && convertsByCast(l.decl.initializer as Expression)) l.trusted = false;
  return out;
}

/** Whether a value is converted into its variable by a cast (a null constant aside). */
function convertsByCast(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind !== NodeKind.CStyleCastExpr) return false;
  const inner = unwrapCasts(u);
  return !(inner.kind === NodeKind.IntegerLiteral && (inner as unknown as { value: bigint }).value === 0n) && !isNullName(inner);
}

/** The typing the region rules read: trusted locals and parameters, globals, fields. */
function typingOf(ctx: Ctx): TypingEnv {
  return {
    nameType(e: Expression): TypeShape | null {
      const name = nameOf(e);
      if (!name) return null;
      const l = e.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
      if (l) return l.trusted && !l.array ? declShape(l, ctx) : null;
      const g = globalSpelling(name, ctx);
      return g ? shapeOfSpelling(g, ctx.resolve) : null;
    },
    pointerHeld: id => pointerHeld(id, ctx),
  };
}

/**
 * For an integer local the body assigns once, `x = (int)p;` at its top level before any
 * other mention, in a function without labels: `p`. Every read of `x` then holds the
 * address `p` held.
 */
function pointerHeld(id: Identifier, ctx: Ctx): Expression | null {
  const l = ctx.locals.get(id.name);
  if (!l || l.param || l.addressed || l.array || ctx.labels || !ctx.regions) return null;
  const shape = declShape(l, ctx);
  if (!shape || !isWordIntegerShape(shape)) return null;
  let value: Expression | null = null;
  let at: Identifier | null = null;
  if (l.decl.initializer) {
    const d = ctx.body.statements.find(st => st.kind === NodeKind.DeclStmt && (st as DeclStmt).declarations.includes(l.decl));
    if (!d) return null;
    value = l.decl.initializer as Expression;
    at = l.decl.name;
  }
  for (const n of traverseAST(ctx.body)) {
    const writes = n.kind === NodeKind.AssignExpr ? (n as AssignExpr).left
      : n.kind === NodeKind.PostfixExpr || (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator))
        ? (n as unknown as { operand: Expression }).operand : null;
    if (!writes || unwrap(writes).kind !== NodeKind.Identifier || (unwrap(writes) as Identifier).name !== id.name) continue;
    if (value || n.kind !== NodeKind.AssignExpr || (n as AssignExpr).operator !== '=') return null;
    if (!ctx.body.statements.some(st => st.kind === NodeKind.ExprStmt && unwrap((st as ExprStmt).expression) === n)) return null;
    value = (n as AssignExpr).right;
    at = unwrap((n as AssignExpr).left) as Identifier;
  }
  if (!value || !at) return null;
  const from = ctx.identIndex.get(at);
  if (from === undefined) return null;
  // Every other mention comes after the assignment and outside its value.
  const inValue = new Set([...traverseAST(value)]);
  for (const m of ctx.idents) {
    if (m.name !== id.name || m === at || m === l.decl.name) continue;
    if ((ctx.identIndex.get(m) ?? -1) <= from || inValue.has(m)) return null;
  }
  const v = unwrap(value);
  if (v.kind !== NodeKind.CStyleCastExpr) return null;
  const to = shapeOfNode((v as CStyleCastExpr).type, 0, ctx.resolve);
  if (!to || !isWordIntegerShape(to)) return null;
  const p = (v as CStyleCastExpr).expression;
  return ctx.regions.pointee(typeOf(p, ctx.typing, ctx.regions)) ? p : null;
}

/** The facts for a call named `name` printed on `s`'s lines; null unless exactly one. */
function factFor(s: Statement, name: string, ctx: Ctx): CallSiteFact | null {
  if (!placed(s)) return null;
  const bare = bareName(name);
  let found: CallSiteFact | null = null;
  // A copy of a call the original makes once carries its fact (ghidraInfo.callSite).
  for (const n of traverseAST(s)) {
    if (n.kind !== NodeKind.CallExpr || !n.ghidraInfo?.callSite || bareName(calleeName((n as CallExpr).callee) ?? '') !== bare) continue;
    if (found) return null;
    found = n.ghidraInfo.callSite;
  }
  if (found) return found;
  for (let l = s.location.start.line, end = lastLine(s); l <= end; l++) {
    if ((ctx.lineOwners.get(l) ?? 0) > 1) return null;
    for (const f of ctx.ev.lines.get(l) ?? []) {
      if (bareName(f.name) !== bare) continue;
      if (found) return null;
      found = f;
    }
  }
  return found;
}

/**
 * The last line `s` prints on. A statement's own location can end on its first line when
 * the expression continues on the next (`sDamage.wResultFlags =` above the call), so the
 * furthest line any of its nodes reaches is taken.
 */
function lastLine(s: Statement): number {
  let end = s.location.end.line;
  for (const n of traverseAST(s)) if (placed(n) && n.location.end.line > end) end = n.location.end.line;
  return end;
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

/** Whether a declared type is const, volatile or a reference at its top: its declaration then cannot lose the initializer. */
function boundAtDeclaration(t: ASTNode): boolean {
  switch (t.kind) {
    case NodeKind.ReferenceType: case NodeKind.RValueReferenceType: return true;
    case NodeKind.QualifiedType: return (t as unknown as { qualifiers: string[] }).qualifiers.some(q => q === 'const' || q === 'volatile');
    case NodeKind.PointerType: return (t as unknown as { qualifiers: string[] }).qualifiers.some(q => q === 'const' || q === 'volatile');
    case NodeKind.BuiltinType: return (t as unknown as { modifiers: string[] }).modifiers.some(q => q === 'const' || q === 'volatile');
    default: return false;
  }
}

/**
 * `x = value;` or `T x = value;` (one plain local, copy-initialised with an expression)
 * with x a local whose value the statement can take over; else null.
 */
function tempOf(s: Statement, ctx: Ctx): { stmt: ExprStmt | DeclStmt; def: Identifier; name: string; value: Expression; local: Local } | null {
  if (s.kind === NodeKind.DeclStmt) {
    const ds = s as DeclStmt;
    if (ds.declarations.length !== 1 || ds.declarations[0].kind !== NodeKind.VariableDecl) return null;
    const v = ds.declarations[0] as VariableDecl;
    const init = v.initializer;
    if (!init || v.directInit || v.copyListInit || v.bitWidth || v.specifiers.length
      || init.kind === NodeKind.InitListExpr || boundAtDeclaration(v.type)) return null;
    const local = ctx.locals.get(v.name.name);
    if (!local || local.decl !== v || local.addressed || local.array) return null;
    if (effects(init as Expression).writes) return null;
    return { stmt: ds, def: v.name, name: v.name.name, value: init as Expression, local };
  }
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const a = e as AssignExpr;
  if (a.left.kind !== NodeKind.Identifier) return null;
  const name = (a.left as Identifier).name;
  const local = ctx.locals.get(name);
  if (!local || local.param || local.addressed || local.array) return null;
  if (effects(a.right).writes) return null;
  return { stmt: s as ExprStmt, def: a.left as Identifier, name, value: a.right, local };
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
  // `x = G + 0x24;`, `y = a - G;`: 32-bit integer arithmetic on names and constants.
  if (!fx.writes && shape.stars === 0 && WORD_INTEGERS.has(shape.base)) {
    const ar = wordArithmetic(v, ctx);
    if (ar && (sameShape(ar.shape, shape) || signOnlyIntoNarrowParam(ar.shape, shape, site, ctx))) {
      return { kind: ar.global ? 'read' : 'pure' };
    }
  }
  return null;
}

const WORD_ARITH = new Set(['+', '-', '|', '&', '^']);

/**
 * The type of `e` when it is `+ - | & ^` over 32-bit integer names (locals whose address
 * is never taken, globals) and constants below 2^31, which C types as int or unsigned int;
 * and whether it reads a global.
 */
function wordArithmetic(e: Expression, ctx: Ctx): { shape: TypeShape; global: boolean } | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) {
    const lit = u as unknown as { value: bigint; suffix?: string };
    if (lit.suffix || lit.value >= 0x80000000n) return null;
    return { shape: { base: 'int', stars: 0, isConst: false }, global: false };
  }
  if (u.kind === NodeKind.Identifier) {
    const name = (u as Identifier).name;
    const l = ctx.locals.get(name);
    let sh: TypeShape | null;
    let global = false;
    if (l) {
      if (l.addressed || l.array) return null;
      sh = declShape(l, ctx);
    } else {
      const g = ctx.opts.globalTypes?.[name];
      sh = g ? shapeOfSpelling(g, ctx.resolve) : null;
      global = true;
    }
    if (!sh || sh.stars !== 0 || !WORD_INTEGERS.has(sh.base)) return null;
    return { shape: { base: sh.base.startsWith('unsigned') ? 'unsigned int' : 'int', stars: 0, isConst: false }, global };
  }
  if (u.kind === NodeKind.BinaryExpr && WORD_ARITH.has((u as BinaryExpr).operator)) {
    const a = wordArithmetic((u as BinaryExpr).left, ctx);
    const b = a && wordArithmetic((u as BinaryExpr).right, ctx);
    if (!a || !b) return null;
    const uns = a.shape.base === 'unsigned int' || b.shape.base === 'unsigned int';
    return { shape: { base: uns ? 'unsigned int' : 'int', stars: 0, isConst: false }, global: a.global || b.global };
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
 * What evaluating an expression may read or write, beyond the caller's private locals.
 * With `memory`, `regions` are the only typed regions it reaches; null: anything.
 */
interface Eff { unknown: boolean; memory: boolean; regions: Set<string> | null; globals: Set<string> }

const noEff = (): Eff => ({ unknown: false, memory: false, regions: new Set(), globals: new Set() });

function addMemory(into: Eff, r: Set<string> | null): void {
  if (!into.memory) into.regions = r === null ? null : new Set(r);
  else if (into.regions !== null) {
    if (r === null) into.regions = null;
    else for (const x of r) into.regions.add(x);
  }
  into.memory = true;
}

function addEff(into: Eff, e: Omit<WriteEffect, 'reads'> | undefined): void {
  if (!e || e.unknown) { into.unknown = true; return; }
  if (e.memory) addMemory(into, e.regions ? new Set(e.regions) : null);
  // A write or read through a pointer argument is memory, as the caller sees it.
  for (const p of e.params ?? []) {
    const r = e.paramRegions?.[String(p)];
    addMemory(into, r ? new Set(r) : null);
  }
  for (const g of e.globals ?? []) into.globals.add(g);
}

const isEmpty = (e: Eff) => !e.unknown && !e.memory && e.globals.size === 0;

/**
 * Whether a global the effect names is `name`. The summary names globals as the database
 * does; the emitter splits a table into pieces named after it
 * (`gaAct5SceneryPresetTable_0_0__1_`), so a name that extends one, or that one extends,
 * is the same storage.
 */
function sameGlobal(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '_') || b.startsWith(a + '_');
}

/** Whether something `w` writes may be what `x` reads or writes. */
function interferes(w: Eff, x: Eff, regions: Regions | null): boolean {
  if (isEmpty(w) || isEmpty(x)) return false;
  if (w.unknown || x.unknown) return true;
  // Memory behind a pointer may be any global.
  if ((w.memory && x.globals.size) || (x.memory && w.globals.size)) return true;
  // Two typed accesses are apart when their regions are.
  if (w.memory && x.memory && (!regions || regions.overlapAny(w.regions, x.regions))) return true;
  for (const g of w.globals) for (const h of x.globals) if (sameGlobal(g, h)) return true;
  return false;
}

/** One unit evaluated in an order the compilers do not agree on: what it writes and reads. */
interface Unit { w: Eff; r: Eff }

/** Reads and writes of evaluating `e`; the identifiers in `free` are units of their own. */
function unitOf(e: ASTNode, ctx: Ctx, free: ReadonlySet<ASTNode>): Unit {
  const u: Unit = { w: noEff(), r: noEff() };
  const effects = ctx.opts.writeEffects ?? {};
  const segs = ctx.opts.enclosingSegments ?? [];
  const readGlobal = (name: string) => {
    const g = globalSpelling(name, ctx);
    if (g === undefined) {
      if (scopedLookup(ctx.enums, name, segs) === undefined
        && scopedLookup(ctx.opts.functionReturnTypes ?? {}, name, segs) === undefined) u.r.unknown = true;
    } else if (!g.includes('[')) {
      u.r.globals.add(bareName(name));
    }
  };
  /** A read through a pointer, of the region the access reaches where it can be told. */
  const through = (n: ASTNode): void => {
    const at = ctx.regions ? regionOf(n as Expression, ctx.typing, ctx.regions) : null;
    addMemory(u.r, at === null ? null : new Set([at]));
  };
  /** An object's storage read or reached: `local`, `global`, or through a pointer. */
  const object = (o: Expression): void => {
    const x = unwrap(o);
    const name = nameOf(x);
    if (name) {
      if (isNullName(x)) return;
      const l = x.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
      if (l) { if (l.addressed || l.array) addMemory(u.r, null); return; }
      const g = globalSpelling(name, ctx);
      if (g !== undefined) { u.r.globals.add(bareName(name)); return; }
      u.r.unknown = true;
      return;
    }
    value(x);
  };
  const address = (o: Expression): void => {
    const x = unwrap(o);
    switch (x.kind) {
      case NodeKind.Identifier: case NodeKind.QualifiedId: return;
      case NodeKind.MemberExpr: {
        const m = x as unknown as { object: Expression; isArrow: boolean };
        if (m.isArrow) value(m.object); else address(m.object);
        return;
      }
      case NodeKind.SubscriptExpr: {
        const sub = x as unknown as { array: Expression; index: Expression };
        const base = unwrap(sub.array);
        const name = nameOf(base);
        const arrayBase = !!name && (ctx.locals.get(name)?.array || (globalSpelling(name, ctx) ?? '').includes('['));
        if (!arrayBase) value(sub.array);
        value(sub.index);
        return;
      }
      case NodeKind.UnaryExpr:
        if ((x as UnaryExpr).operator === '*') { value((x as UnaryExpr).operand); return; }
        u.r.unknown = true;
        return;
      default:
        value(x);
    }
  };
  const value = (n: ASTNode): void => {
    if (free.has(n)) return;
    switch (n.kind) {
      case NodeKind.IntegerLiteral: case NodeKind.CharLiteral: case NodeKind.BoolLiteral:
      case NodeKind.NullptrLiteral: case NodeKind.FloatingLiteral: case NodeKind.StringLiteral:
      case NodeKind.SizeofExpr: case NodeKind.AlignofExpr:
        return;
      case NodeKind.Identifier: case NodeKind.QualifiedId: {
        const name = nameOf(n as Expression);
        if (!name) { u.r.unknown = true; return; }
        if (isNullName(n as Expression)) return;
        const l = n.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
        if (l) { if (l.addressed && !l.array) addMemory(u.r, null); return; }
        readGlobal(name);
        return;
      }
      case NodeKind.UnaryExpr: {
        const x = n as UnaryExpr;
        if (x.operator === '&') { address(x.operand); return; }
        if (x.operator === '++' || x.operator === '--') { u.w.unknown = true; return; }
        if (x.operator === '*') through(n);
        value(x.operand);
        return;
      }
      case NodeKind.MemberExpr: {
        const m = n as unknown as { object: Expression; isArrow: boolean };
        if (m.isArrow) { through(n); value(m.object); } else object(m.object);
        return;
      }
      case NodeKind.SubscriptExpr: {
        const sub = n as unknown as { array: Expression; index: Expression };
        value(sub.index);
        const base = unwrap(sub.array);
        const name = nameOf(base);
        const local = name && base.kind === NodeKind.Identifier ? ctx.locals.get(name) : undefined;
        if (local?.array) { addMemory(u.r, null); return; }
        if (name && !local && (globalSpelling(name, ctx) ?? '').includes('[')) { u.r.globals.add(bareName(name)); return; }
        through(n);
        value(sub.array);
        return;
      }
      case NodeKind.CallExpr: {
        const c = n as CallExpr;
        const name = calleeName(c.callee);
        if (name === 'sizeof') return;
        const e = name ? scopedLookup(effects, name, segs) : undefined;
        addEff(u.w, e);
        addEff(u.r, e?.reads);
        if (!name) value(c.callee);
        for (const a of c.arguments) value(a);
        return;
      }
      case NodeKind.AssignExpr: case NodeKind.PostfixExpr: case NodeKind.NewExpr: case NodeKind.DeleteExpr:
        u.w.unknown = true;
        return;
      default:
        for (const k of getChildren(n)) value(k);
    }
  };
  value(e);
  return u;
}

/**
 * Whether the units give the same result in any order: none writes what another reads or
 * writes. Two calls that write nothing are independent whatever they read.
 */
function independent(units: Unit[], regions: Regions | null): boolean {
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i], b = units[j];
      if (interferes(a.w, b.r, regions) || interferes(a.w, b.w, regions) || interferes(b.w, a.r, regions)) return false;
    }
  }
  return true;
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

/** Statements the dataflow models in full: anything else may read what it does not report. */
const MODELLED = new Set<string>([
  NodeKind.CompoundStmt, NodeKind.ExprStmt, NodeKind.DeclStmt, NodeKind.IfStmt, NodeKind.SwitchStmt,
  NodeKind.CaseStmt, NodeKind.DefaultStmt, NodeKind.LabelStmt, NodeKind.GotoStmt, NodeKind.ReturnStmt,
  NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt,
  NodeKind.NullStmt,
]);

function flowOfBody(ctx: Ctx): FunctionFlow | null {
  if (ctx.flow !== undefined) return ctx.flow;
  const names = new Set<string>();
  let modelled = true;
  for (const n of traverseAST(ctx.body)) {
    if (n.kind === NodeKind.VariableDecl) names.add((n as VariableDecl).name.name);
    else if (n.kind.endsWith('Stmt') && !MODELLED.has(n.kind)) modelled = false;
  }
  for (const l of ctx.locals.values()) if (l.param) names.add(l.decl.name.name);
  ctx.flow = modelled ? buildFunctionFlow(ctx.body.statements, names) : null;
  return ctx.flow;
}

/**
 * Whether, on the function's control flow, the temporary's value reaches no read but the
 * statement's, and the statement reads no other value of it: loops, switches and gotos
 * included. Taking the write and the read away then leaves every other read with the
 * value it had, since each path from the write to one passes another write first.
 */
function onlyUseFlows(t: Temp, at: { block: CompoundStmt; index: number }, ctx: Ctx): boolean {
  const flow = flowOfBody(ctx);
  if (!flow) return false;
  const def = flow.nodeOf(t.stmt);
  const use = flow.nodeOf(at.block.statements[at.index]);
  if (def === undefined || use === undefined) return false;
  if (!flow.definition(def, t.name)?.killing) return false;
  const reaching = flow.reaching(use, t.name);
  if (reaching.size !== 1 || !reaching.has(def)) return false;
  const uses = flow.usesOf(def, t.name);
  return uses.length === 1 && uses[0] === use;
}

const mentionsName = (n: ASTNode, name: string) =>
  namesIn(n).some(m => m.name === name);

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
  const sx = s.kind === NodeKind.ExprStmt ? unwrap((s as ExprStmt).expression) : null;
  const targetName = sx && sx.kind === NodeKind.AssignExpr && unwrap((sx as AssignExpr).left).kind === NodeKind.Identifier
    ? unwrap((sx as AssignExpr).left) as Identifier : null;
  for (let j = b - 1; j >= 0; j--) {
    const t = tempOf(stmts[j], ctx);
    if (!t || names.has(t.name)) break;
    // A later temporary's value must not assign anything this one reads.
    if (collected.some(u => namesIn(t.value).some(n => n.name === u.name))) break;
    // The statement's target, when it is this temporary, is a write of it, not a use.
    const uses = namesIn(s).filter(n => n.name === t.name && n !== targetName);
    const inLater = collected.flatMap(u => namesIn(u.value).filter(n => n.name === t.name).map(n => ({ u, n })));
    let host: Temp | undefined;
    let use: Identifier;
    let site: { call: CallExpr; arg: number; use: Identifier };
    let arg: number;
    if (uses.length === 1 && inLater.length === 0) {
      use = uses[0];
      arg = argumentOf(call, use);
      if (arg < 0) break;
      site = { call, arg, use };
    } else if (uses.length === 0 && inLater.length === 1 && inLater[0].u.kind === 'call') {
      // A chain: the one read is in a later temporary's call, which goes into the call too.
      host = inLater[0].u;
      use = inLater[0].n;
      const inner = argumentOf(host.call!, use);
      if (inner < 0 || namesIn(host.value).filter(n => n.name === t.name).length !== 1) break;
      arg = host.arg;
      site = { call: host.call!, arg: inner, use };
    } else break;
    const c = classify(t, ctx, site);
    if (!c) break;
    if (host && c.kind === 'read') break;
    names.add(t.name);
    collected.push({ stmt: t.stmt, def: t.def, name: t.name, value: t.value, use, arg, kind: c.kind, call: c.call, host });
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

/**
 * Whether the original's instructions show the nested evaluation of `calls` (the
 * temporaries holding calls, in textual order) in `call`. Call by call in evaluation order: before each inner CALL the pushes of the arguments
 * right of it (up to the previous inner call's) and its own; the outer CALL right after
 * the last with the pushes of the arguments up to it.
 */
function evidenceShows(calls: Temp[], call: CallExpr, outer: CallSiteFact, ctx: Ctx): boolean {
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
  return true;
}

function mergeEff(into: Eff, from: Eff): void {
  if (from.unknown) into.unknown = true;
  if (from.memory) addMemory(into, from.regions);
  for (const g of from.globals) into.globals.add(g);
}

/** The temporary at the root of `t`'s chain. */
function rootOf(t: Temp): Temp {
  while (t.host) t = t.host;
  return t;
}

/**
 * The calls of `call` nested with `temps` in VC8's evaluation order (the arguments right
 * to left, each argument's calls before its push), each with the PUSHes made since the
 * call before it; null when an argument holds more than one call of the chain.
 */
function nestedEvents(call: CallExpr, fact: CallSiteFact, temps: Temp[], ctx: Ctx): { fact: CallSiteFact; pushes: number }[] | null {
  const byUse = new Map<ASTNode, Temp>(temps.filter(t => t.kind === 'call').map(t => [t.use, t]));
  const out: { fact: CallSiteFact; pushes: number }[] = [];
  let pending = 0;
  const visitCall = (c: CallExpr, f: CallSiteFact): boolean => {
    if (!f.slots || f.slots.length !== c.arguments.length) return false;
    for (let i = c.arguments.length - 1; i >= 0; i--) {
      const inner = namesIn(c.arguments[i]).map(n => byUse.get(n)).filter((t): t is Temp => !!t);
      if (inner.length > 1) return false;
      if (inner.length === 1) {
        const t = inner[0];
        const tf = factFor(t.stmt, calleeName(t.call!.callee)!, ctx);
        if (!tf || !visitCall(t.call!, tf)) return false;
      }
      pending += f.slots[i];
    }
    out.push({ fact: f, pushes: pending });
    pending = 0;
    return true;
  };
  return visitCall(call, fact) ? out : null;
}

/**
 * A run holding a chain: a temporary whose one read is in a later temporary's call
 * (`h = Get(p); s = Snd(p, h); Play(s, p, 4, 0, 0);`). Nested, the original evaluates the
 * outer call's arguments right of the chain, then the innermost call, and each host after
 * the call it takes: the PUSHes before each CALL say whether it did.
 */
function validChain(temps: Temp[], call: CallExpr, outer: CallSiteFact, target: Expression | null, path: Path, guarded: boolean, ctx: Ctx): boolean {
  const calls = temps.filter(t => t.kind === 'call');
  if (calls.length < 2) return false;
  // No call but the chain's: the facts below then account for every CALL of the statement.
  if (call.arguments.some(a => effects(a).calls)) return false;
  for (const t of calls) for (const a of t.call!.arguments) if (effects(a).calls) return false;
  // The chains' roots in VC8's order: the earliest in the argument furthest right.
  const roots = temps.filter(t => !t.host && t.kind !== 'pure');
  for (let i = 0; i + 1 < roots.length; i++) if (roots[i].arg <= roots[i + 1].arg) return false;
  // Each chain is evaluated in its own order either way; chains and the other arguments
  // move against each other, so none may write what another reads or writes.
  const free = new Set<ASTNode>(temps.map(t => t.use));
  const units: Unit[] = [];
  for (const r of roots) {
    const u = unitOf(r.value, ctx, free);
    for (const t of temps) {
      if (t === r || t.kind === 'pure' || rootOf(t) !== r) continue;
      const v = unitOf(t.value, ctx, free);
      mergeEff(u.w, v.w);
      mergeEff(u.r, v.r);
    }
    units.push(u);
  }
  for (const a of call.arguments) units.push(unitOf(a, ctx, free));
  if (target) {
    const t: Unit = { w: noEff(), r: noEff() };
    t.r = unitOf({ kind: NodeKind.UnaryExpr, operator: '&', operand: target } as unknown as ASTNode, ctx, new Set()).r;
    units.push(t);
  }
  if (!independent(units, ctx.regions)) return false;
  // The original's PUSHes match the nested evaluation, and not the printed one.
  const events = nestedEvents(call, outer, temps, ctx);
  if (!events || events.length !== calls.length + 1) return false;
  let differs = false;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.fact.pushes !== e.pushes) return false;
    if (k > 0 && e.fact.prev !== events[k - 1].fact.at) return false;
    if (e.pushes !== argSlots(e.fact, 0, e.fact.slots!.length - 1)) differs = true;
  }
  if (!differs) return false;
  for (const t of temps) {
    const allowed = new Set<Identifier>([t.use, t.def, ctx.locals.get(t.name)!.decl.name]);
    if (!deadAfter(t.name, allowed, path, guarded, ctx) && (t.host || !onlyUseFlows(t, path[path.length - 1], ctx))) return false;
  }
  return true;
}


function validRun(temps: Temp[], call: CallExpr, outer: CallSiteFact, target: Expression | null, path: Path, guarded: boolean, ctx: Ctx): boolean {
  // A run whose host is left out is no run.
  if (temps.some(t => t.host && !temps.includes(t.host))) return false;
  if (temps.some(t => t.host)) return validChain(temps, call, outer, target, path, guarded, ctx);
  const calls = temps.filter(t => t.kind === 'call');
  if (calls.length === 0) return false;
  // Calls and reads in VC8's order: the earliest in the argument furthest right.
  const ordered = temps.filter(t => t.kind !== 'pure');
  for (let i = 0; i + 1 < ordered.length; i++) if (ordered[i].arg <= ordered[i + 1].arg) return false;
  const leftmost = ordered[ordered.length - 1].arg;
  const tempArgs = new Set(temps.map(t => t.arg));
  for (let i = leftmost; i < call.arguments.length; i++) {
    // Nothing else in an argument holding a temporary, nor right of the leftmost, calls.
    if ((i > leftmost || tempArgs.has(i)) && effects(call.arguments[i]).calls) return false;
  }
  // VC8 evaluates the arguments right to left, GCC in an order of its own. Nested, the
  // temporaries' values and the other arguments are evaluated in either order, so none
  // may write what another reads or writes (write-effects.ts says what each call may).
  const free = new Set<ASTNode>(temps.map(t => t.use));
  const units: Unit[] = temps.filter(t => t.kind !== 'pure').map(t => unitOf(t.value, ctx, new Set()));
  for (const a of call.arguments) units.push(unitOf(a, ctx, free));
  if (target) {
    const t: Unit = { w: noEff(), r: noEff() };
    const tu = unitOf({ kind: NodeKind.UnaryExpr, operator: '&', operand: target } as unknown as ASTNode, ctx, new Set());
    t.r = tu.r;
    units.push(t);
  }
  if (!independent(units, ctx.regions)) return false;
  if (!evidenceShows(calls, call, outer, ctx)) return false;
  // Each temporary dead after the statement.
  for (const t of temps) {
    const allowed = new Set<Identifier>([t.use, t.def, ctx.locals.get(t.name)!.decl.name]);
    if (!deadAfter(t.name, allowed, path, guarded, ctx) && !onlyUseFlows(t, path[path.length - 1], ctx)) return false;
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
    resolve: name => typedefTargets[name], opts, regions: regionsFor(opts), typing: { nameType: () => null }, body,
  };
  ctx.typing = typingOf(ctx);
  const reindex = () => {
    ctx.idents = namesIn(body);
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
        if (temps.some(t => !parentOf(t.host ? t.host.value : s, t.use))) continue;
        // Later temporaries first: a chain's host carries its inner temporary into the statement.
        let placedAll = true;
        for (let i = temps.length - 1; i >= 0 && placedAll; i--) {
          const t = temps[i];
          const holder = parentOf(s, t.use);
          if (!holder) { placedAll = false; break; }
          replaceChild(holder, t.use, wrapIfNeeded(t.value, holder));
        }
        if (!placedAll) continue;
        const start = b - temps.length;
        // Comments on the temporaries' lines stay, above the statement.
        s.leadingTrivia = [...temps.flatMap(t => t.stmt.leadingTrivia ?? []), ...(s.leadingTrivia ?? [])];
        // A temporary declared with its value keeps a bare declaration, which the sweep
        // below drops when nothing else names it.
        const kept = temps.filter(t => t.stmt.kind === NodeKind.DeclStmt).map(t => {
          const v = (t.stmt as DeclStmt).declarations[0] as VariableDecl;
          v.initializer = null;
          t.stmt.leadingTrivia = [];
          return t.stmt;
        });
        block.statements.splice(start, temps.length, ...kept);
        b = start;
        for (const t of temps) removedDecls.add(t.name);
        changed++;
        opts.onSite?.({ line: s.location?.start.line ?? 0, temps: temps.length });
        reindex();
        ctx.flow = undefined;
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

const regionModels = new WeakMap<AggregateModel, Regions>();

function regionsFor(opts: NestCallOptions): Regions | null {
  const m = opts.aggregates;
  if (!m) return null;
  let r = regionModels.get(m);
  if (!r) regionModels.set(m, r = new Regions(m));
  return r;
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


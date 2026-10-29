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
 *   - the arguments right of the leftmost such temporary call and change nothing, and
 *     the statement assigns nothing inside the argument list;
 *   - each call temporary's value has the temporary's type (its callee's return type, or
 *     an explicit cast), so nesting it converts nothing;
 *   - the original shows the nested evaluation: before each inner CALL, the pushes of its
 *     own arguments and of the outer arguments right of it (up to the previous inner
 *     call's argument, which must hold at least one stack slot: otherwise both forms
 *     push alike); each inner CALL straight after the previous one; the outer CALL
 *     straight after the last, with exactly the pushes of the arguments up to it.
 *
 * An assertion halt is left to halt-site-fold, which folds its temporaries itself. When in
 * doubt, nothing changes; without the facts nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl, CStyleCastExpr, ParameterDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import {
  calleeName, bareName, scopedLookup, shapeOfNode, shapeOfSpelling, sameShape, isWordIntegerShape,
  type TypedefResolver, type TypeShape,
} from './call-arg-cast.js';
import { isHaltStmt } from './assert-order.js';

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
  /** Global name -> declared type spelling. */
  globalTypes?: Record<string, string>;
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

function isConstant(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral
    || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.BoolLiteral) return true;
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

interface Local { decl: VariableDecl; shape: TypeShape | null; addressed: boolean; param: boolean }

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
    out.set(name, { decl, shape, addressed: false, param });
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
  if (!local || local.param || local.addressed || local.decl.initializer) return null;
  if (effects(a.right).writes) return null;
  return { stmt: s as ExprStmt, name, value: a.right, local };
}

function declShape(l: Local, ctx: Ctx): TypeShape | null {
  return shapeOfNode(l.decl.type, 0, ctx.resolve);
}

/** The value class of a temporary, or null when nesting it could convert or reorder it. */
function classify(t: { value: Expression; local: Local }, ctx: Ctx): { kind: Temp['kind']; call?: CallExpr } | null {
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
      if (!r || !sameShape(r, shape)) return null;
    }
    if (!calleeName(call.callee)) return null;
    return { kind: 'call', call };
  }
  if (fx.calls) return null;
  const word = isWordIntegerShape(shape) || shape.stars > 0;
  if (isConstant(v)) return word ? { kind: 'pure' } : null;
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
  const next = mentions.find(i => (ctx.identIndex.get(i) ?? -1) > last);
  if (!next) return true;
  for (let d = path.length - 1; d >= 0; d--) {
    const { block, index } = path[d];
    for (let j = index + 1; j < block.statements.length; j++) {
      const w = block.statements[j];
      const has = [...traverseAST(w)].some(n => n === next);
      if (!has) {
        if ([...traverseAST(w)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === name)) return false;
        continue;
      }
      if (w.kind !== NodeKind.ExprStmt) return false;
      const e = unwrap((w as ExprStmt).expression);
      if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return false;
      const a = e as AssignExpr;
      if (a.left !== next) return false;
      return ![...traverseAST(a.right)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === name);
    }
  }
  return false;
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
    const c = classify(t, ctx);
    if (!c) break;
    names.add(t.name);
    collected.push({ stmt: t.stmt, name: t.name, value: t.value, use: uses[0], arg, kind: c.kind, call: c.call });
  }
  collected.reverse();

  const outer = factFor(s, outerName, ctx);
  if (!outer || !outer.slots || outer.slots.length !== call.arguments.length) return null;

  for (let first = 0; first < collected.length; first++) {
    const temps = collected.slice(first);
    if (validRun(temps, call, outer, path, guarded, ctx)) return { temps, call };
  }
  return null;
}

function validRun(temps: Temp[], call: CallExpr, outer: CallSiteFact, path: Path, guarded: boolean, ctx: Ctx): boolean {
  const calls = temps.filter(t => t.kind === 'call');
  if (calls.length === 0) return false;
  // Calls and reads in VC8's order: the earliest in the argument furthest right.
  const ordered = temps.filter(t => t.kind !== 'pure');
  for (let i = 0; i + 1 < ordered.length; i++) if (ordered[i].arg <= ordered[i + 1].arg) return false;
  const leftmost = ordered[ordered.length - 1].arg;
  const tempArgs = new Set(temps.map(t => t.arg));
  for (let i = leftmost; i < call.arguments.length; i++) {
    const a = call.arguments[i];
    // Nothing else in an argument holding a temporary, nor right of the leftmost, calls.
    if ((i > leftmost || tempArgs.has(i)) && effects(a).calls) return false;
  }
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
  const ctx: Ctx = {
    locals, idents: [], identIndex: new Map(), labels, lineOwners, ev,
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


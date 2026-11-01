/**
 * Guarded Call Restore Plugin
 *
 * The guarded form of `inlined-call-restore`. A static helper the original called
 * and VC8 inlined is often a getter behind an assertion,
 *
 *     int ARENA_GetArenaTxtRecord(SGAMEDATA *pGame) {      // 0053f600, pGame in EAX
 *       if (!pGame->pArenaCtrl) { Halt("", GetInstructionPointer(), 0x6c); exit(-1); }
 *       return pGame->pArenaCtrl->nArenaTxtRecord;
 *     }
 *
 * and its inlined copies are the same assertion, with the same `__LINE__`, right in
 * front of the statement that reads the value:
 *
 *     if (!pGame->pArenaCtrl) { Halt("", GetInstructionPointer(), 0x6c); exit(-1); }
 *     pArenaTxt = GetArenaTxtRecord(pGame->pArenaCtrl->nArenaTxtRecord);
 *
 * The decompiler prints those copies in shapes of its own (the guard inverted around
 * the use, the line in a reused local), so the copies only look like the body once
 * `halt-site-fold` and `assert-order` have run. This pass runs after both, on the
 * callee as the pipeline has it at the same point, and writes the call back:
 *
 *     pArenaTxt = GetArenaTxtRecord(ARENA_GetArenaTxtRecord(pGame));
 *
 * A callee is `G1; ...; Gk; return E;` where each Gi is `if (C) { Halt(.., L); exit(-1); }`.
 * A site is the same guards, consecutive in one block, followed by a statement S whose
 * first-evaluated value is E with each parameter bound to one expression. The call
 * evaluates the guards where the site did, so the halt fires for the same condition
 * with the same line, and then yields E:
 *
 *  - S is `x = V;` with x a local, `T x = V;`, `return V;`, `if (V)`, `switch (V)`, or
 *    `V;`; inside V the use is V itself or what V evaluates first: the operand of a
 *    cast, `!`, `*` or `->`, the left of `&&`/`||`, the condition of `?:`, the one
 *    operand of a binary operator or call whose others have no effect and cannot
 *    fault. A loop condition is never one: it is evaluated again on every iteration.
 *  - The value is E exactly, of the return type's shape; or E with an integral
 *    widening cast left off where only its truth is tested; or E with a pointer
 *    cast the site spells differently, cast back to the site's pointer type.
 *  - E spelled as raw offset arithmetic, `(void **)((uintptr_t)&p->u + 0x14)`
 *    (UNITSND_GetSfxDataListHead, 004ca870), matches the site's spelling of the same
 *    field, `&p->u.c.pList` or a read of it, only where the declarations put that
 *    field at exactly that offset; a read is taken only for a pointer field, which
 *    `*F(args)` reads whole.
 *
 * Arguments are bound as in `inlined-call-restore`: no call, no write, the
 * parameter's type. A statement under a label is never a site: a jump to it skips
 * the guards, which the call would then run.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CallExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ReturnStmt, Statement, SubscriptExpr,
  SwitchStmt, TypeNode, UnaryExpr, VariableDecl, AssignExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { calleeName, sameShape, shapeOfNode, unwrapParens, type TypeShape, type TypedefResolver } from './call-arg-cast.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { effectsOf } from './access-order-evidence.js';
import { intTypeOf } from './inlined-call-fold.js';
import {
  argumentsFor, callOf, onlyStatement, paramName, realStatements, same, signNeutral, unify,
  type Bindings, type InlinedCallTables, type PatternParam, type UnifyEnv,
} from './inlined-call-restore.js';

/** A guarded helper, as the pipeline has it where this pass runs. */
export interface GuardedCallee {
  /** The name a call to it is spelled with, `::`-separated. */
  callName: string;
  /** Its definition, parsed and transformed up to this pass. */
  fn: FunctionDecl;
}

export interface GuardedCallTables extends InlinedCallTables {
  /** Aggregate name -> member name -> byte offset, for the members the declarations place. */
  fieldOffsets?: Record<string, Record<string, number>>;
}

export interface GuardedCallRestoreOptions extends PluginOptions, GuardedCallTables {
  callees?: GuardedCallee[];
  /** Receives the function as it stands where this pass runs, before anything is rewritten. */
  capture?: (fn: FunctionDecl) => void;
  /**
   * Spells the restored call as the function's other references are spelled where this
   * pass runs (`enclosing-namespace-strip` has shortened them by then).
   */
  spellCall?: (call: CallExpr) => Expression;
  onSite?: (e: GuardedCallSite) => void;
}

export type GuardedCallForm = 'value' | 'truth' | 'pointer-cast' | 'field-address' | 'field-read';

export interface GuardedCallSite { callee: string; line: number; form: GuardedCallForm }

interface GuardedPattern {
  callee: GuardedCallee;
  params: PatternParam[];
  /** The guards, in order. */
  guards: IfStmt[];
  /** The halt line of each guard. */
  lines: number[];
  value: Expression;
  returnShape: TypeShape;
}

const HALT = 'ERROR_UnrecoverableInternalError_Halt';

/** The line `if (C) { Halt(.., L); exit(-1); }` halts with, or undefined when `s` is not one. */
export function haltGuardLine(s: Statement): number | undefined {
  if (s.kind !== NodeKind.IfStmt) return undefined;
  const i = s as IfStmt;
  if (i.init || i.elseBranch) return undefined;
  const then = i.thenBranch.kind === NodeKind.CompoundStmt ? realStatements(i.thenBranch as CompoundStmt) : [i.thenBranch];
  if (then.length !== 2 || then.some(t => t.kind !== NodeKind.ExprStmt)) return undefined;
  const [halt, exit] = then.map(t => unwrapParens((t as ExprStmt).expression));
  if (halt.kind !== NodeKind.CallExpr || exit.kind !== NodeKind.CallExpr) return undefined;
  const h = halt as CallExpr, x = exit as CallExpr;
  if (calleeName(h.callee)?.split('::').pop() !== HALT || h.arguments.length !== 3) return undefined;
  if (calleeName(x.callee)?.split('::').pop() !== 'exit' || x.arguments.length !== 1) return undefined;
  const line = unwrapParens(h.arguments[2]);
  return line.kind === NodeKind.IntegerLiteral ? Number((line as IntegerLiteralExpr).value) : undefined;
}

/** The pattern a guarded callee gives, or null when it is not `G1; ...; Gk; return E;`. */
export function compileGuardedCallee(callee: GuardedCallee, resolve?: TypedefResolver): GuardedPattern | null {
  const fn = callee.fn;
  if (!fn.body) return null;
  for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt) return null;
  const params: PatternParam[] = [];
  for (const p of fn.parameters) {
    const name = paramName(p);
    if (!name) return null;
    params.push({ name, type: (p as unknown as VariableDecl).type, neutral: false });
  }
  if (params.length === 0) return null;
  const stmts = realStatements(fn.body);
  const guards: IfStmt[] = [];
  const lines: number[] = [];
  let k = 0;
  for (; k < stmts.length; k++) {
    const line = haltGuardLine(stmts[k]);
    if (line === undefined) break;
    guards.push(stmts[k] as IfStmt);
    lines.push(line);
  }
  // What follows the first return is never reached.
  const ret = stmts[k];
  if (guards.length === 0 || !ret || ret.kind !== NodeKind.ReturnStmt || !(ret as ReturnStmt).value) return null;
  const value = (ret as ReturnStmt).value!;
  for (const e of [value, ...guards.map(g => g.condition)]) {
    const fx = effectsOf(e);
    if (fx.calls > 0 || fx.writes > 0) return null;
  }
  const returnShape = shapeOfNode(fn.returnType, 0, resolve);
  if (!returnShape) return null;
  const names = new Set(params.map(p => p.name));
  const used = new Set<string>();
  for (const r of [value, ...guards.map(g => g.condition)]) for (const n of traverseAST(r)) if (n.kind === NodeKind.Identifier) used.add((n as Identifier).name);
  if ([...names].some(n => !used.has(n))) return null;
  const types = new Map(params.map(p => [p.name, p.type] as const));
  for (const p of params) p.neutral = signNeutral([value, ...guards.map(g => g.condition)], p.name, types);
  return { callee, params, guards, lines, value, returnShape };
}

/** Whether evaluating `e` has no effect and cannot fault: names, constants, and arithmetic on them. */
function pure(e: Expression): boolean {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
    case NodeKind.IntegerLiteral:
    case NodeKind.CharLiteral:
    case NodeKind.StringLiteral:
      return true;
    case NodeKind.CStyleCastExpr:
      return pure((u as CStyleCastExpr).expression);
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      if (x.operator === '&') {
        const o = unwrapParens(x.operand);
        return o.kind === NodeKind.Identifier || o.kind === NodeKind.QualifiedId;
      }
      return ['-', '~', '!', '+'].includes(x.operator) && pure(x.operand);
    }
    case NodeKind.BinaryExpr: {
      const b = u as BinaryExpr;
      return b.operator !== '/' && b.operator !== '%' && pure(b.left) && pure(b.right);
    }
    default:
      return false;
  }
}

/** One expression position: `holder[key]` (or `holder[key][index]`), and whether only its truth is read. */
interface Slot { holder: Record<string, unknown>; key: string; index?: number; expr: Expression; truth: boolean }

/** The positions of `S` that are evaluated before anything else in it, outermost first. */
function firstEvaluated(s: Statement, isLocal: (name: string) => boolean): Slot[] {
  const slots: Slot[] = [];
  const holder = (n: ASTNode) => n as unknown as Record<string, unknown>;
  const visit = (h: Record<string, unknown>, key: string, e: Expression, truth: boolean, index?: number): void => {
    slots.push({ holder: h, key, index, expr: e, truth });
    switch (e.kind) {
      case NodeKind.ParenExpr:
        visit(holder(e), 'expression', (e as unknown as { expression: Expression }).expression, truth);
        return;
      case NodeKind.CStyleCastExpr:
        visit(holder(e), 'expression', (e as CStyleCastExpr).expression, false);
        return;
      case NodeKind.UnaryExpr: {
        const u = e as UnaryExpr;
        if (u.operator === '!') visit(holder(e), 'operand', u.operand, true);
        else if (u.operator === '*') visit(holder(e), 'operand', u.operand, false);
        return;
      }
      case NodeKind.MemberExpr:
        if ((e as MemberExpr).isArrow) visit(holder(e), 'object', (e as MemberExpr).object, false);
        return;
      case NodeKind.SubscriptExpr:
        if (pure((e as SubscriptExpr).index)) visit(holder(e), 'array', (e as SubscriptExpr).array, false);
        return;
      case NodeKind.BinaryExpr: {
        const b = e as BinaryExpr;
        if (b.operator === '&&' || b.operator === '||') { visit(holder(e), 'left', b.left, true); return; }
        if (pure(b.right)) visit(holder(e), 'left', b.left, false);
        else if (pure(b.left)) visit(holder(e), 'right', b.right, false);
        return;
      }
      case NodeKind.ConditionalExpr:
        visit(holder(e), 'condition', (e as ConditionalExpr).condition, true);
        return;
      case NodeKind.CallExpr: {
        const c = e as CallExpr;
        const callee = unwrapParens(c.callee);
        if (callee.kind !== NodeKind.Identifier && callee.kind !== NodeKind.QualifiedId) return;
        c.arguments.forEach((a, i) => {
          if (c.arguments.every((o, j) => j === i || pure(o))) visit(holder(e), 'arguments', a, false, i);
        });
        return;
      }
      default:
        return;
    }
  };
  switch (s.kind) {
    case NodeKind.ExprStmt: {
      const e = (s as ExprStmt).expression;
      const u = unwrapParens(e);
      if (u.kind === NodeKind.AssignExpr) {
        const a = u as AssignExpr;
        const l = unwrapParens(a.left);
        if (a.operator === '=' && l.kind === NodeKind.Identifier && isLocal((l as Identifier).name)) visit(holder(a), 'right', a.right, false);
        return slots;
      }
      visit(holder(s), 'expression', e, false);
      return slots;
    }
    case NodeKind.DeclStmt: {
      const d = s as DeclStmt;
      if (d.declarations.length !== 1 || d.declarations[0].kind !== NodeKind.VariableDecl) return slots;
      const v = d.declarations[0] as VariableDecl;
      if (!v.initializer || v.directInit || v.copyListInit || v.initializer.kind === NodeKind.InitListExpr) return slots;
      visit(holder(v), 'initializer', v.initializer as Expression, false);
      return slots;
    }
    case NodeKind.ReturnStmt:
      if ((s as ReturnStmt).value) visit(holder(s), 'value', (s as ReturnStmt).value!, false);
      return slots;
    case NodeKind.IfStmt:
      if (!(s as IfStmt).init) visit(holder(s), 'condition', (s as IfStmt).condition, true);
      return slots;
    case NodeKind.SwitchStmt:
      if (!(s as SwitchStmt).init) visit(holder(s), 'condition', (s as SwitchStmt).condition, false);
      return slots;
    default:
      return slots;
  }
}

/** `p->a.b` as the object pointer it starts from and the byte offset it ends at. */
interface Address { root: Expression; offset: number }

const VOIDISH = /^(?:void|char|signed char|unsigned char|u?int(?:8|16|32)_t|uint|uchar|byte|BYTE|undefined[124]?|int|unsigned int|short|unsigned short|long|unsigned long)$/;

/**
 * A pointer conversion that keeps the address: between two pointers neither of which
 * is to an aggregate (a C-style cast between related class pointers adjusts it).
 */
function plainPointers(a: TypeShape, b: TypeShape): boolean {
  if (a.stars === 0 || b.stars === 0) return false;
  if (sameShape(a, b)) return true;
  const plain = (s: TypeShape) => s.stars >= 2 || VOIDISH.test(s.base.replace(/^::/, ''));
  return plain(a) || plain(b);
}

/**
 * Restore the calls in one function. Returns the rewritten function, or undefined
 * when nothing matched, and the sites it rewrote.
 */
export function restoreGuardedCalls(
  fn: FunctionDecl,
  callees: ReadonlyArray<GuardedCallee>,
  tables: GuardedCallTables = {},
  spellCall?: (call: CallExpr) => Expression,
): { fn: FunctionDecl | undefined; sites: GuardedCallSite[] } {
  const sites: GuardedCallSite[] = [];
  if (!fn.body) return { fn: undefined, sites };
  const typedefTargets = tables.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const patterns = callees.map(c => compileGuardedCallee(c, resolve)).filter((p): p is GuardedPattern => p !== null);
  if (patterns.length === 0) return { fn: undefined, sites };

  const body = cloneNode(fn.body);
  const env: UnifyEnv = { enumValues: tables.enumValues ?? {}, resolve };
  const localTypes = new Map<string, TypeNode>();
  for (const p of fn.parameters) {
    const n = paramName(p);
    if (n) localTypes.set(n, (p as unknown as VariableDecl).type);
  }
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) localTypes.set((n as VariableDecl).name.name, (n as VariableDecl).type);
  }
  const shapeOf: ExprShape = createExprShape(localTypes, {
    globalTypes: tables.globalTypes, structFields: tables.structFields, fieldTypes: tables.fieldTypes, resolve,
  });
  const offsets = tables.fieldOffsets ?? {};
  const fieldOffset = (aggregate: string, member: string): number | undefined =>
    offsets[aggregate]?.[member] ?? offsets[aggregate.replace(/^::/, '')]?.[member];
  const bits = (s: TypeShape | null): number | undefined => {
    if (s && s.stars === 0 && s.base.replace(/^::/, '') === 'bool') return 1;
    return intTypeOf(s, resolve)?.bits;
  };

  /** Where the member chain `m` lies: its root object pointer and its offset in it. */
  const lvalueAddress = (m: Expression): Address | undefined => {
    const u = unwrapParens(m);
    if (u.kind !== NodeKind.MemberExpr) return undefined;
    const me = u as MemberExpr;
    const name = (me.member as { name?: string }).name;
    if (typeof name !== 'string') return undefined;
    const obj = shapeOf(me.object);
    if (!obj || obj.stars !== (me.isArrow ? 1 : 0)) return undefined;
    const off = fieldOffset(obj.base, name);
    if (off === undefined) return undefined;
    if (me.isArrow) return { root: unwrapParens(me.object), offset: off };
    const inner = lvalueAddress(me.object);
    return inner && { root: inner.root, offset: inner.offset + off };
  };
  /** `&m`, or `(uintptr_t)&m + c` (or a byte pointer's `+ c`): the address it computes. */
  const addressOf = (e: Expression): Address | undefined => {
    const u = unwrapParens(e);
    if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') return lvalueAddress((u as UnaryExpr).operand);
    if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '+') return undefined;
    const b = u as BinaryExpr;
    const c = unwrapParens(b.right);
    const l = unwrapParens(b.left);
    if (c.kind !== NodeKind.IntegerLiteral || l.kind !== NodeKind.CStyleCastExpr) return undefined;
    const cast = shapeOfNode((l as CStyleCastExpr).type, 0, resolve);
    // An address-sized integer steps in bytes: uintptr_t, or a 32-bit int in this build.
    const byteStep = !!cast && ((cast.stars === 0 && (/^(?:::)?u?intptr_t$/.test(cast.base) || intTypeOf(cast, resolve)?.bits === 32))
      || (cast.stars === 1 && intTypeOf({ ...cast, stars: 0 }, resolve)?.bits === 8));
    if (!byteStep) return undefined;
    const inner = unwrapParens((l as CStyleCastExpr).expression);
    if (inner.kind !== NodeKind.UnaryExpr || (inner as UnaryExpr).operator !== '&') return undefined;
    const a = lvalueAddress((inner as UnaryExpr).operand);
    return a && { root: a.root, offset: a.offset + Number((c as IntegerLiteralExpr).value) };
  };
  /** `e` with each bound parameter replaced by its binding. */
  const bindIn = (e: Expression, bound: Bindings): Expression => {
    const copy = cloneNode(e);
    const rec = (n: ASTNode): void => {
      const o = n as unknown as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        const v = o[key];
        const swap = (c: unknown): unknown => {
          if (!c || typeof c !== 'object' || !('kind' in (c as object))) return c;
          const node = c as ASTNode;
          if (node.kind === NodeKind.Identifier && bound.has((node as Identifier).name)) return Expr.paren(cloneNode(bound.get((node as Identifier).name)!));
          rec(node);
          return node;
        };
        if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
        if (Array.isArray(v)) for (let i = 0; i < v.length; i++) v[i] = swap(v[i]);
        else o[key] = swap(v);
      }
    };
    if (copy.kind === NodeKind.Identifier && bound.has((copy as Identifier).name)) return Expr.paren(cloneNode(bound.get((copy as Identifier).name)!));
    rec(copy);
    return copy;
  };

  /** The value the call stands in for at `x`, or undefined when `x` is not provably E. */
  const matchUse = (pat: GuardedPattern, x: Expression, truth: boolean, bound: Bindings):
    { bound: Bindings; build: (call: Expression) => Expression; form: GuardedCallForm } | undefined => {
    const vars = new Set(pat.params.map(p => p.name));
    const r = pat.returnShape;
    const site = unwrapParens(x);
    const castOf = (e: Expression) => { const u = unwrapParens(e); return u.kind === NodeKind.CStyleCastExpr ? u as CStyleCastExpr : undefined; };
    // E itself.
    let b: Bindings = new Map(bound);
    if (unify(pat.value, site, vars, b, env)) {
      const have = shapeOf(site);
      if (have && sameShape(have, r)) return { bound: b, build: c => c, form: 'value' };
      const hb = bits(have), rb = bits(r);
      if (truth && hb !== undefined && rb !== undefined && (rb === 1 || rb >= hb)) return { bound: b, build: c => c, form: 'truth' };
      const sc = castOf(site);
      if (sc && have && plainPointers(r, have)) return { bound: b, build: c => Expr.cast(cloneNode(sc.type), c), form: 'pointer-cast' };
      return undefined;
    }
    const ec = castOf(pat.value);
    if (!ec) return undefined;
    const cs = shapeOfNode(ec.type, 0, resolve);
    if (!cs) return undefined;
    // E is `(C)Y` and the site reads Y for its truth: C and the return type widen it.
    b = new Map(bound);
    if (truth && cs.stars === 0 && unify(ec.expression, site, vars, b, env)) {
      const yb = bits(shapeOf(site)), cb = bits(cs), rb = bits(r);
      if (yb !== undefined && cb !== undefined && rb !== undefined && cb >= yb && (rb === 1 || rb >= cb)) {
        return { bound: b, build: c => c, form: 'truth' };
      }
      return undefined;
    }
    if (cs.stars === 0 || r.stars === 0) return undefined;
    const sc = castOf(site);
    const q = sc ? shapeOfNode(sc.type, 0, resolve) : null;
    if (sc && (!q || q.stars === 0)) return undefined;
    // E is `(C)Y` and the site `(Q)Y`, both pointers.
    b = new Map(bound);
    if (sc && q && unify(ec.expression, sc.expression, vars, b, env)) {
      if (!plainPointers(r, q) || !plainPointers(cs, r)) return undefined;
      return { bound: b, build: c => Expr.cast(cloneNode(sc.type), c), form: 'pointer-cast' };
    }
    // E is `(C)A` with A an address the declarations place; every parameter it names
    // is bound by the guards already, so it is resolved in the site's terms. The site
    // names the same field, under a pointer cast of its own or as it is.
    const named = new Set<string>();
    for (const n of traverseAST(ec.expression)) if (n.kind === NodeKind.Identifier && vars.has((n as Identifier).name)) named.add((n as Identifier).name);
    if ([...named].some(n => !bound.has(n))) return undefined;
    const want = addressOf(bindIn(ec.expression, bound));
    if (!want || !plainPointers(cs, r)) return undefined;
    const sameAddress = (a: Address | undefined) => !!a && a.offset === want.offset && same(a.root, want.root, env);
    const inner = unwrapParens(sc ? sc.expression : site);
    const recast = (e: Expression) => (sc ? Expr.cast(cloneNode(sc.type), e) : e);
    if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&') {
      if (!sameAddress(lvalueAddress((inner as UnaryExpr).operand))) return undefined;
      const have = shapeOf(inner);
      if (q ? !plainPointers(r, q) : !have || !sameShape(have, r)) return undefined;
      return { bound: new Map(bound), build: recast, form: 'field-address' };
    }
    if (inner.kind === NodeKind.MemberExpr) {
      // A read of the pointer field: `*F(args)` reads the same four bytes.
      const field = shapeOf(inner);
      if (!field || field.stars === 0 || cs.stars < 2 || r.stars < 2 || !sameAddress(lvalueAddress(inner))) return undefined;
      const pointee: TypeShape = { ...r, stars: r.stars - 1 };
      if (q ? !plainPointers(pointee, q) || !plainPointers(field, q) : !sameShape(field, pointee)) return undefined;
      return { bound: new Map(bound), build: c => recast(Expr.deref(c)), form: 'field-read' };
    }
    return undefined;
  };

  const isLocal = (name: string) => localTypes.has(name);
  const blocks: CompoundStmt[] = [];
  for (const n of traverseAST(body)) if (n.kind === NodeKind.CompoundStmt) blocks.push(n as CompoundStmt);
  for (const block of blocks) {
    const stmts = block.statements;
    for (let i = 0; i < stmts.length; i++) {
      if (haltGuardLine(stmts[i]) === undefined) continue;
      for (const pat of patterns) {
        const k = pat.guards.length;
        // The guards and the statement, with nothing but empty statements between.
        const idx: number[] = [];
        for (let j = i; j < stmts.length && idx.length <= k; j++) if (stmts[j].kind !== NodeKind.NullStmt) idx.push(j);
        if (idx.length <= k || idx[0] !== i) continue;
        const vars = new Set(pat.params.map(p => p.name));
        const bound: Bindings = new Map();
        if (!pat.guards.every((g, j) => unify(g, stmts[idx[j]], vars, bound, env))) continue;
        const s = onlyStatement(stmts[idx[k]]);
        if (s !== stmts[idx[k]]) continue;
        let done = false;
        for (const slot of firstEvaluated(s, isLocal)) {
          const m = matchUse(pat, slot.expr, slot.truth, bound);
          if (!m) continue;
          const args = argumentsFor(pat, m.bound, shapeOf, env);
          if (!args) continue;
          const spelled = spellCall ? spellCall(callOf(pat, args)) : callOf(pat, args);
          if (spelled.kind !== NodeKind.CallExpr) continue;
          const call = spelled as CallExpr;
          // A local of the callee's name would take the call.
          const head = unwrapParens(call.callee);
          if (head.kind === NodeKind.Identifier && localTypes.has((head as Identifier).name)) continue;
          (call as { location: unknown }).location = slot.expr.location;
          const value = m.build(call);
          if (slot.index !== undefined) (slot.holder[slot.key] as Expression[])[slot.index] = value;
          else slot.holder[slot.key] = value;
          sites.push({ callee: pat.callee.callName, line: s.location?.start.line ?? 0, form: m.form });
          stmts.splice(i, idx[k] - i);
          done = true;
          break;
        }
        if (done) break;
      }
    }
  }
  if (sites.length === 0) return { fn: undefined, sites };
  return { fn: updateNode(fn, { body } as Partial<FunctionDecl>), sites };
}

function createGuardedCallRestoreTransformer(options: GuardedCallRestoreOptions = {}): Transformer {
  const callees = options.callees ?? [];
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      options.capture?.(cloneNode(node));
      if (callees.length === 0) return undefined;
      const { fn, sites } = restoreGuardedCalls(node, callees, options, options.spellCall);
      for (const s of sites) options.onSite?.(s);
      return fn;
    },
  });
}

export const guardedCallRestorePlugin: TransformPlugin = {
  id: 'guarded-call-restore',
  name: 'Guarded Call Restore',
  description:
    'Writes a call where a helper the original called and VC8 inlined left its assertion and its value in the caller',
  version: '1.0.0',
  defaultEnabled: true,
  // After halt-site-fold (930) and assert-order (987), which give the guards the shape
  // the callee's own has; before branch-layout (988) reads the statements' positions.
  priority: 987.5,
  tags: ['core', 'matching'],
  createTransformer: createGuardedCallRestoreTransformer,
};

/**
 * Select Argument Plugin
 *
 * A call argument the source wrote as a select between two constants,
 *
 *     Printf(pReport, "<Process.UserIsAdmin> %s\n", bIsAdmin ? "TRUE" : "FALSE");
 *
 * comes back from the decompiler as a local set on two paths and read once by the call
 * (WriteCrashReportProcessInfo, 00407a80):
 *
 *     szProcessName = "TRUE";
 *     if (!bIsAdmin) {
 *       szProcessName = "FALSE";
 *     }
 *     Printf(pReport, "<Process.UserIsAdmin> %s\n", szProcessName);
 *
 * Compiled as printed, VC8 stores the local before the test and keeps it in another
 * register; written as the select it matches byte for byte. The select's condition is the
 * printed test with its sense taken from the store it guards: `v = A; if (!c) v = B;` is
 * `c ? A : B`, and `v = A; if (c) v = B;` is `c ? B : A`.
 *
 * Made only when:
 *   - the three statements follow each other in one block: `v = A;`, an if with no else
 *     whose arm is the one statement `v = B;`, and a statement naming v once, as a whole
 *     argument of its top call (`f(.., v, ..);` or `x = f(.., v, ..);`);
 *   - v is a local whose address is never taken, and on the function's control flow the
 *     two stores reach that read and no other, and no other value of v reaches it
 *     (cfg/dataflow.ts); where the flow is not modelled, v is named nowhere else;
 *   - A and B are constants that hold their value through v's type: integer literals within
 *     its range for an integer of at most 32 bits; string literals, null, a global's address
 *     or a function for a pointer;
 *   - the condition, the callee, the other arguments and the assignment's target are pure
 *     (no call, no store).
 *
 * Value-preserving: nothing between the test's old place and the read can write (the
 * statement's other parts are pure), so the condition gives the same answer at the read;
 * the select then yields the constant v held, and each constant has the same value as an
 * int literal as it had in v, so the argument converts to the parameter the same way.
 *
 * The same select over values that are not constants, and over several arguments, comes
 * back as one if/else storing each local on both paths, then the call reading each once
 * (ITEMMODE_CheckAutoStack 0055d370, a unit's GUID and type with a sentinel when there is
 * none):
 *
 *     if (!pUnit) { nGuid = -1; eType = UNIT_COUNT; }
 *     else { nGuid = pUnit->nUnitGUID; eType = pUnit->eUnitType; }
 *     pStats = AllocStatList(pPool, 2, nFrame, eType, nGuid);
 *
 * VC8 merges the tests of `!pUnit ? UNIT_COUNT : pUnit->eUnitType, !pUnit ? -1 :
 * pUnit->nUnitGUID` into one branch, as it does the if/else, but gives the values the
 * registers of the arguments (the last argument's in ECX); compiled as printed the first
 * store takes EAX. As often the source wrote the if/else, and the shape alone cannot tell:
 * written everywhere it applies, it gained one function and lost four. So it is a form a
 * function's `vc8form` tag names, `tsel(C[,i])`, applied by `selectPairedArguments`. Each
 * read becomes `C ? A : B`, the condition and arms as printed, where both arms are nothing
 * but plain stores of the same locals, each local is read once, as a whole argument of the
 * statement's top call, and only there (dataflow as above), and every value is pure, reads
 * none of those locals, and has the local's type or is a constant it holds (a literal,
 * or an enumerator, whose value every enum declaring the name agrees on): the select then
 * has the local's type, so the argument converts as the local did. A value read at the call reads what it read at the if: the callee and
 * the call's other arguments are pure.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ParenExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { isPure } from './pseudo-op-lower.js';
import { shapeOfNode, type TypeShape } from './call-arg-cast.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';
import { createExprShape } from './expr-shape.js';
import { sameShape } from './call-arg-cast.js';
import { localTypesOf } from './compare-form.js';
import { emit } from '../../../emit/index.js';

export interface SelectArgumentOptions extends PluginOptions {
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
  /** Tables the values of a tagged if/else are typed from (expr-shape.ts). */
  globalTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  /** Enumerator -> its value, where every enum declaring the name agrees on it. */
  enumValues?: Record<string, number>;
  onSite?: (e: { variable: string; line: number }) => void;
}

const RANGES: Record<string, [bigint, bigint]> = {
  'int': [-0x80000000n, 0x7fffffffn], 'signed int': [-0x80000000n, 0x7fffffffn], 'int32_t': [-0x80000000n, 0x7fffffffn],
  'long': [-0x80000000n, 0x7fffffffn], 'BOOL': [-0x80000000n, 0x7fffffffn], 'INT': [-0x80000000n, 0x7fffffffn], 'LONG': [-0x80000000n, 0x7fffffffn],
  'unsigned int': [0n, 0xffffffffn], 'unsigned': [0n, 0xffffffffn], 'uint32_t': [0n, 0xffffffffn], 'DWORD': [0n, 0xffffffffn],
  'UINT': [0n, 0xffffffffn], 'unsigned long': [0n, 0xffffffffn], 'ULONG': [0n, 0xffffffffn], 'uint': [0n, 0xffffffffn],
  'short': [-0x8000n, 0x7fffn], 'short int': [-0x8000n, 0x7fffn], 'int16_t': [-0x8000n, 0x7fffn], 'SHORT': [-0x8000n, 0x7fffn],
  'unsigned short': [0n, 0xffffn], 'uint16_t': [0n, 0xffffn], 'WORD': [0n, 0xffffn], 'USHORT': [0n, 0xffffn], 'ushort': [0n, 0xffffn],
  'signed char': [-0x80n, 0x7fn], 'int8_t': [-0x80n, 0x7fn],
  'unsigned char': [0n, 0xffn], 'uint8_t': [0n, 0xffn], 'BYTE': [0n, 0xffn], 'UCHAR': [0n, 0xffn], 'uchar': [0n, 0xffn],
};

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function unwrapCasts(e: Expression): Expression {
  let x = unwrap(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrap((x as CStyleCastExpr).expression);
  return x;
}

function integerValue(e: Expression): bigint | null {
  const x = unwrap(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).suffix ? null : (x as IntegerLiteralExpr).value;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const o = unwrap((x as UnaryExpr).operand);
    if (o.kind === NodeKind.IntegerLiteral && !(o as IntegerLiteralExpr).suffix) return -(o as IntegerLiteralExpr).value;
  }
  return null;
}

/** `v = e;` with v a plain identifier: [v, e]. */
function storeOf(s: Statement): { name: string; value: Expression; id: Identifier } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrap((e as AssignExpr).left);
  if (l.kind !== NodeKind.Identifier) return null;
  return { name: (l as Identifier).name, value: (e as AssignExpr).right, id: l as Identifier };
}

function soleStatement(s: Statement): Statement | null {
  if (s.kind !== NodeKind.CompoundStmt) return s;
  const list = (s as CompoundStmt).statements;
  return list.length === 1 ? list[0] : null;
}

function mentions(n: ASTNode, name: string): Identifier[] {
  const out: Identifier[] = [];
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) out.push(m as Identifier);
  return out;
}

interface Local { decl: VariableDecl; shape: TypeShape | null; addressed: boolean }

/** Whether `e` is a constant that `v` of shape `t` holds unchanged; `globals` names no local. */
function holdsConstant(e: Expression, t: TypeShape, isLocal: (n: string) => boolean): boolean {
  const x = unwrapCasts(e);
  if (t.stars > 0) {
    if (x.kind === NodeKind.StringLiteral || x.kind === NodeKind.NullptrLiteral) return true;
    if (x.kind === NodeKind.Identifier) {
      const n = (x as Identifier).name;
      return n === 'NULL' || !isLocal(n);
    }
    if (x.kind === NodeKind.QualifiedId) return true;
    if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value === 0n;
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') {
      for (const m of traverseAST((x as UnaryExpr).operand)) {
        if (m.kind === NodeKind.Identifier && isLocal((m as Identifier).name)) return false;
        if (m.kind === NodeKind.CallExpr || (m.kind === NodeKind.MemberExpr && (m as unknown as { isArrow: boolean }).isArrow)) return false;
        if (m.kind === NodeKind.UnaryExpr && (m as UnaryExpr).operator === '*') return false;
      }
      return isPure(x);
    }
    return false;
  }
  if (e !== x && unwrap(e).kind === NodeKind.CStyleCastExpr) return false;
  const range = RANGES[t.base.replace(/^const\s+/, '')];
  const v = integerValue(e);
  return !!range && v !== null && v >= range[0] && v <= range[1];
}

/** The negation of a condition printed `!x`: x; null for any other condition. */
function negated(c: Expression): Expression | null {
  const u = unwrap(c);
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!' ? (u as UnaryExpr).operand : null;
}

function select(c: Expression, x: Expression, y: Expression): Expression {
  return {
    kind: NodeKind.ConditionalExpr, condition: cloneNode(c), thenExpr: cloneNode(x), elseExpr: cloneNode(y),
    leadingTrivia: [], trailingTrivia: [],
  } as unknown as ConditionalExpr;
}

/** The call the statement makes at its top, and the assignment target if any. */
function topCall(s: Statement): { call: CallExpr; target: Expression | null } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  let e = unwrap((s as ExprStmt).expression);
  let target: Expression | null = null;
  if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=') {
    target = (e as AssignExpr).left;
    e = unwrapCasts((e as AssignExpr).right);
  }
  return e.kind === NodeKind.CallExpr ? { call: e as CallExpr, target } : null;
}

function rewriteFunction(fn: FunctionDecl, options: SelectArgumentOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const resolve = (n: string) => options.typedefTargets?.[n];
  const body = cloneNode(fn.body) as CompoundStmt;
  const locals = new Map<string, Local>();
  let duplicate = false;
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const v = n as VariableDecl;
    if (locals.has(v.name.name)) duplicate = true;
    locals.set(v.name.name, { decl: v, shape: shapeOfNode(v.type as TypeNode, 0, resolve), addressed: false });
  }
  if (duplicate || !locals.size) return undefined;
  const paramNames = new Set(fn.parameters.map(p => (p as unknown as { name?: Identifier }).name?.name).filter(Boolean) as string[]);
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      const o = unwrap((n as UnaryExpr).operand);
      for (const m of traverseAST(o)) if (m.kind === NodeKind.Identifier && locals.has((m as Identifier).name)) locals.get((m as Identifier).name)!.addressed = true;
    }
  }
  const isLocal = (n: string) => locals.has(n) || paramNames.has(n);
  let flow: FunctionFlow | null | undefined;
  const flowOf = (): FunctionFlow | null => {
    if (flow === undefined) {
      try { flow = buildFunctionFlow(body.statements, new Set([...locals.keys(), ...paramNames])); } catch { flow = null; }
    }
    return flow;
  };

  let changed = false;
  const removed = new Set<string>();
  const visit = (n: ASTNode): void => {
    for (const k of getChildren(n)) visit(k);
    if (n.kind !== NodeKind.CompoundStmt) return;
    const list = (n as CompoundStmt).statements;
    for (let i = list.length - 3; i >= 0; i--) {
      const first = storeOf(list[i]);
      if (!first) continue;
      const local = locals.get(first.name);
      if (!local || local.addressed || !local.shape || paramNames.has(first.name)) continue;
      const ifs = list[i + 1];
      if (ifs.kind !== NodeKind.IfStmt || (ifs as IfStmt).elseBranch || (ifs as IfStmt).init || (ifs as IfStmt).isConstexpr) continue;
      const armStmt = soleStatement((ifs as IfStmt).thenBranch);
      const second = armStmt ? storeOf(armStmt) : null;
      if (!second || second.name !== first.name) continue;
      const cond = (ifs as IfStmt).condition;
      if (!isPure(cond) || mentions(cond, first.name).length) continue;
      if (!holdsConstant(first.value, local.shape, isLocal) || !holdsConstant(second.value, local.shape, isLocal)) continue;
      const use = list[i + 2];
      const top = topCall(use);
      if (!top) continue;
      const named = mentions(use, first.name);
      if (named.length !== 1) continue;
      const arg = top.call.arguments.findIndex(a => unwrapCasts(a) === named[0]);
      if (arg < 0 || unwrap(top.call.arguments[arg]) !== named[0]) continue;
      if (!isPure(top.call.callee) || (top.target && (!isPure(top.target) || mentions(top.target, first.name).length))) continue;
      if (!top.call.arguments.every((a, j) => j === arg || isPure(a))) continue;
      // The two stores reach the read and nothing else; nothing else reaches it.
      const f = flowOf();
      if (f) {
        const a = f.nodeOf(list[i]), b = f.nodeOf(armStmt!), u = f.nodeOf(use);
        if (a === undefined || b === undefined || u === undefined) continue;
        if (!f.definition(a, first.name)?.killing || !f.definition(b, first.name)?.killing) continue;
        const reaching = f.reaching(u, first.name);
        if (reaching.size !== 2 || !reaching.has(a) || !reaching.has(b)) continue;
        const ua = f.usesOf(a, first.name), ub = f.usesOf(b, first.name);
        if (ua.length !== 1 || ua[0] !== u || ub.length !== 1 || ub[0] !== u) continue;
      } else {
        const all = mentions(body, first.name).filter(m => m !== local.decl.name);
        if (all.length !== 3) continue;
      }
      // A string literal stored in a `char *` converts implicitly only on its own: in a
      // select it is `const char *`, so each such arm is cast to the local's type.
      const arm = (e: Expression): Expression => local.shape!.stars > 0 && !local.shape!.isConst && unwrap(e).kind === NodeKind.StringLiteral
        ? { kind: NodeKind.CStyleCastExpr, type: cloneNode(local.decl.type), expression: cloneNode(e), leadingTrivia: [], trailingTrivia: [] } as unknown as CStyleCastExpr
        : e;
      const inner = negated(cond);
      const value = inner ? select(inner, arm(first.value), arm(second.value)) : select(cond, arm(second.value), arm(first.value));
      const args = top.call.arguments.map((x, j) => (j === arg ? value : x));
      const call = top.call;
      (call as { arguments: Expression[] }).arguments = args;
      use.leadingTrivia = [...(list[i].leadingTrivia ?? []), ...(ifs.leadingTrivia ?? []), ...(use.leadingTrivia ?? [])];
      list.splice(i, 2);
      removed.add(first.name);
      changed = true;
      flow = undefined;
      options.onSite?.({ variable: first.name, line: use.location?.start.line ?? 0 });
    }
  };
  visit(body);
  if (!changed) return undefined;
  // A declaration nothing names any more goes, unless its initializer does something.
  for (const name of removed) {
    const decl = locals.get(name)!.decl;
    if (mentions(body, name).some(m => m !== decl.name)) continue;
    if (decl.initializer && !isPure(decl.initializer as Expression)) continue;
    dropDecl(body, decl);
  }
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

/** The identifiers naming `name` in n; a member's name after `.`/`->` is not one. */
function reads(n: ASTNode, name: string): Identifier[] {
  const members = new Set<ASTNode>();
  for (const m of traverseAST(n)) if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
  return mentions(n, name).filter(m => !members.has(m));
}

/** topCall, and the declaration `T x = f(..);` (its one variable is new: no target). */
function callStatement(s: Statement): { call: CallExpr; target: Expression | null } | null {
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const d = ds[0] as VariableDecl;
    if (!d.initializer || d.initializer.kind === NodeKind.InitListExpr || d.directInit) return null;
    const e = unwrapCasts(d.initializer as Expression);
    return e.kind === NodeKind.CallExpr ? { call: e as CallExpr, target: null } : null;
  }
  return topCall(s);
}

/** Why a tagged if/else was not written as selects. */
export class SelectRefused extends Error {}

/**
 * Write the `index`-th if/else (1-based, in pre-order) whose condition prints `cond` and
 * whose arms store the same locals as selects in the call statement after it, in place
 * (the class comment above). Throws SelectRefused when there is none, or it does not hold.
 */
export function selectPairedArguments(fn: FunctionDecl, cond: string, index: number, options: SelectArgumentOptions = {}): void {
  const refuse = (why: string): never => { throw new SelectRefused(why); };
  if (!fn.body) refuse('no body');
  const body = fn.body!;
  const resolve = (n: string) => options.typedefTargets?.[n];
  const locals = new Map<string, Local>();
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.VariableDecl) continue;
    const v = n as VariableDecl;
    if (locals.has(v.name.name)) refuse(`${v.name.name} is declared twice`);
    locals.set(v.name.name, { decl: v, shape: shapeOfNode(v.type as TypeNode, 0, resolve), addressed: false });
  }
  const paramNames = new Set(fn.parameters.map(p => (p as unknown as { name?: Identifier }).name?.name).filter(Boolean) as string[]);
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST(unwrap((n as UnaryExpr).operand))) {
        if (m.kind === NodeKind.Identifier && locals.has((m as Identifier).name)) locals.get((m as Identifier).name)!.addressed = true;
      }
    }
  }
  const isLocal = (n: string) => locals.has(n) || paramNames.has(n);
  const shapeOf = createExprShape(localTypesOf(fn), {
    globalTypes: options.globalTypes ?? {},
    enclosingVarTypes: options.enclosingVarTypes ?? {},
    structFields: options.structFields ?? {},
    fieldTypes: options.fieldTypes ?? {},
    returnTypes: options.functionReturnTypes ?? {},
    resolve,
  });
  /** A value the local of shape t holds unchanged: one of its type, or a constant. */
  const fits = (e: Expression, t: TypeShape): 'typed' | 'constant' | null => {
    const x = unwrap(e);
    const have = shapeOf(e);
    if (have && sameShape(have, t) && !(have.isConst && !t.isConst && t.stars > 0)) return 'typed';
    if (holdsConstant(e, t, isLocal)) return 'constant';
    let range: [bigint, bigint] | undefined;
    for (let b = t.base.replace(/^const\s+/, ''), k = 0; !range && b && k < 8; b = resolve(b) ?? '', k++) range = RANGES[b];
    // An enumerator is the constant it names: one the local's integer type holds.
    if (x.kind === NodeKind.Identifier && !isLocal((x as Identifier).name) && options.enumValues?.[(x as Identifier).name] !== undefined) {
      const n = BigInt(options.enumValues[(x as Identifier).name]);
      return t.stars === 0 && range && n >= range[0] && n <= range[1] ? 'constant' : null;
    }
    // A negative literal for a 32-bit unsigned local: the select is unsigned too, the same value.
    const v = integerValue(e);
    if (t.stars === 0 && v !== null && range && range[1] === 0xffffffffn && v >= -0x80000000n && v < 0n) return 'constant';
    return null;
  };
  const arm = (s: Statement): Map<string, { value: Expression; stmt: Statement }> | null => {
    const stmts = s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];
    const out = new Map<string, { value: Expression; stmt: Statement }>();
    for (const x of stmts) {
      const st = storeOf(x);
      if (!st || out.has(st.name)) return null;
      out.set(st.name, { value: st.value, stmt: x });
    }
    return out.size ? out : null;
  };
  const want = cond.replace(/\s+/g, '');
  let seen = 0;
  let at: { list: Statement[]; i: number; a: NonNullable<ReturnType<typeof arm>>; b: NonNullable<ReturnType<typeof arm>> } | null = null;
  for (const n of traverseAST(body)) {
    if (at || n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let i = 0; i < list.length && !at; i++) {
      const s = list[i];
      if (s.kind !== NodeKind.IfStmt) continue;
      const ifs = s as IfStmt;
      if (ifs.init || ifs.isConstexpr || !ifs.elseBranch || emit(ifs.condition as never).replace(/\s+/g, '') !== want) continue;
      const a = arm(ifs.thenBranch), b = arm(ifs.elseBranch);
      if (!a || !b || a.size !== b.size || [...a.keys()].some(v => !b.has(v))) continue;
      if (++seen === index) at = { list, i, a, b };
    }
  }
  if (!at) return refuse(`no if/else #${index} on ${cond} storing the same locals in both arms`);
  const { list, i, a, b } = at;
  const ifs = list[i] as IfStmt;
  const names = [...a.keys()];
  const c = ifs.condition;
  if (!isPure(c)) refuse(`${cond} is not pure`);
  if (names.some(v => reads(c, v).length)) refuse(`${cond} reads a local it stores`);
  const use = list[i + 1];
  const top = use ? callStatement(use) : null;
  if (!top) return refuse('no call statement after the if');
  if (!isPure(top.call.callee)) refuse('the callee is not pure');
  if (top.target && (!isPure(top.target) || names.some(v => reads(top.target!, v).length))) refuse('the store target is not pure');
  const argOf = new Map<string, number>();
  for (const v of names) {
    const local = locals.get(v);
    if (!local || !local.shape || paramNames.has(v)) refuse(`${v} is not a local of known type`);
    if (local!.addressed) refuse(`&${v} is taken`);
    const named = reads(use, v);
    if (named.length !== 1) refuse(`${v} is read ${named.length} times in the call statement`);
    const k = top.call.arguments.findIndex(x => unwrap(x) === named[0]);
    if (k < 0) refuse(`${v} is not a whole argument`);
    argOf.set(v, k);
    for (const x of [a.get(v)!.value, b.get(v)!.value]) {
      if (!isPure(x)) refuse(`a value of ${v} is not pure`);
      if (names.some(w => reads(x, w).length)) refuse(`a value of ${v} reads a local the if stores`);
    }
    const ta = fits(a.get(v)!.value, local!.shape!), tb = fits(b.get(v)!.value, local!.shape!);
    if (!ta || !tb) refuse(`a value of ${v} is not of its type`);
    if (ta === 'constant' && tb === 'constant'
      && !(holdsConstant(a.get(v)!.value, local!.shape!, isLocal) && holdsConstant(b.get(v)!.value, local!.shape!, isLocal))) {
      refuse(`a constant of ${v} does not hold its value`);
    }
  }
  const taken = new Set(argOf.values());
  if (!top.call.arguments.every((x, j) => taken.has(j) || isPure(x))) refuse('another argument is not pure');
  let flow: FunctionFlow | null;
  try { flow = buildFunctionFlow(body.statements, new Set([...locals.keys(), ...paramNames])); } catch { flow = null; }
  if (flow) {
    const u = flow.nodeOf(use);
    if (u === undefined) refuse('the call statement is not in the flow');
    for (const v of names) {
      const sa = flow.nodeOf(a.get(v)!.stmt), sb = flow.nodeOf(b.get(v)!.stmt);
      if (sa === undefined || sb === undefined) refuse(`a store of ${v} is not in the flow`);
      if (!flow.definition(sa!, v)?.killing || !flow.definition(sb!, v)?.killing) refuse(`a store of ${v} is partial`);
      const reaching = flow.reaching(u!, v);
      if (reaching.size !== 2 || !reaching.has(sa!) || !reaching.has(sb!)) refuse(`another value of ${v} reaches the call`);
      const ua = flow.usesOf(sa!, v), ub = flow.usesOf(sb!, v);
      if (ua.length !== 1 || ua[0] !== u || ub.length !== 1 || ub[0] !== u) refuse(`${v} is read elsewhere`);
    }
  } else {
    for (const v of names) if (reads(body, v).filter(m => m !== locals.get(v)!.decl.name).length !== 3) refuse(`${v} is named elsewhere`);
  }
  (top.call as { arguments: Expression[] }).arguments = top.call.arguments.map((x, j) => {
    const v = names.find(w => argOf.get(w) === j);
    return v ? select(c, a.get(v)!.value, b.get(v)!.value) : x;
  });
  use.leadingTrivia = [...(ifs.leadingTrivia ?? []), ...(use.leadingTrivia ?? [])];
  list.splice(i, 1);
  for (const v of names) {
    const decl = locals.get(v)!.decl;
    if (reads(body, v).some(m => m !== decl.name)) continue;
    if (decl.initializer && !isPure(decl.initializer as Expression)) continue;
    dropDecl(body, decl);
  }
}

function dropDecl(root: ASTNode, decl: VariableDecl): void {
  for (const n of traverseAST(root)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== NodeKind.DeclStmt) continue;
      const ds = list[i] as DeclStmt;
      const k = ds.declarations.indexOf(decl);
      if (k < 0) continue;
      if (ds.declarations.length === 1) list.splice(i, 1);
      else ds.declarations.splice(k, 1);
      return;
    }
  }
}

function createSelectArgumentTransformer(options: SelectArgumentOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  });
}

export const selectArgumentPlugin: TransformPlugin = {
  id: 'select-argument',
  name: 'Select Argument',
  description: 'A local set to one of two constants and read once as a call argument becomes the select in the argument',
  version: '1.0.0',
  defaultEnabled: true,
  // After shared-tail-join (989.981) and branch-layout (988), whose arm order the printed
  // condition then carries.
  priority: 989.983,
  tags: ['matching'],
  createTransformer: (options: SelectArgumentOptions = {}) => createSelectArgumentTransformer(options),
};

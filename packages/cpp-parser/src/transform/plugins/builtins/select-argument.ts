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
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CallExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, ParenExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { isPure } from './pseudo-op-lower.js';
import { shapeOfNode, type TypeShape } from './call-arg-cast.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';

export interface SelectArgumentOptions extends PluginOptions {
  /** Typedef name -> the spelling it stands for. */
  typedefTargets?: Record<string, string>;
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

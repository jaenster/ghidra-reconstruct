/**
 * Join Constant Return Plugin
 *
 * VC8 tail-duplicates a short join into the paths that reach it, and the decompiler then
 * folds the value each copy returns to the constant it is on that path. A copy of the
 * original that returns zero by moving a register into EAX (`mov eax, esi`, `mov al, bl`)
 * rather than zeroing it (`xor eax, eax`) is such a copy: the source returned a variable
 * there, one return after a join. Two shapes are written back as that join.
 *
 *   tested value  `if (!V) { S...; return 0; } R...; return V;`, the copy of the `return 0`
 *                 moving into EAX (QSERVER_FindAndLockGame 0052e860, `mov eax, esi` with esi
 *                 the null game): `if (!V) { S... } else { R... } return V;`.
 *   result flag   `if (A) { v = E; if (v) { S...; return K1; } } S...; return K2;`, K1 and K2
 *                 distinct integer constants, one of them zero whose copy moves into EAX/AL
 *                 (GetModuleFileNameForProcess 00407a20, `mov al, bl` in both copies, bl
 *                 loaded 1 or 0 before the duplicated CloseHandle):
 *                 `T r; if (A && E) { r = K1; } else { r = K2; } S...; return r;`.
 *
 * Value-preserving. Tested value: the arm runs only with V zero, so `return V` returns the
 * zero it returned; R... holds no return or jump and does not write V, so it reaches the
 * final return as before. Result flag: E runs exactly when A holds, as in the nest; v is
 * named nowhere else; the paths that reached `S...; return K2` (A false, or v zero) now set
 * r to K2 and run the same S....
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, IfStmt,
  ReturnStmt, Statement, TypeNode, UnaryExpr, VariableDecl, IntegerLiteralExpr, ParenExpr, BinaryExpr,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { sameExpr } from './rotated-for-loop.js';
import { LayoutReader, type BranchLayoutEvidence, type ReturnCopy } from './branch-layout/evidence.js';
import { isHaltStmt, isExitStmt } from './assert-order.js';

export interface JoinConstantReturnOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number; form: 'tested' | 'flag' }) => void;
}

const unparen = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};

function intValue(e: Expression | null | undefined): bigint | null {
  if (!e) return null;
  const u = unparen(e);
  if (u.kind === NodeKind.NullptrLiteral) return 0n;
  if (u.kind === NodeKind.IntegerLiteral && typeof (u as IntegerLiteralExpr).value === 'bigint') return (u as IntegerLiteralExpr).value as bigint;
  if (u.kind === NodeKind.CStyleCastExpr) return intValue((u as unknown as { expression: Expression }).expression);
  return null;
}

function bodyOf(s: Statement): Statement[] {
  return s.kind === NodeKind.CompoundStmt ? [...(s as CompoundStmt).statements] : [s];
}

/** The copy a return's lines place it in, or null. */
function copyOf(reader: LayoutReader, ev: BranchLayoutEvidence, ret: ReturnStmt): ReturnCopy | null {
  const lo = reader.returnCopy(ret);
  if (lo === null || !ev.returns) return null;
  return ev.returns.find(c => c.start <= lo && lo <= c.ret) ?? null;
}

/** The copy returns its value by moving a register into EAX/AL, never zeroing it. */
function movesIntoEax(c: ReturnCopy): boolean {
  if (c.insns.some(m => /^(XOR|SUB)\/(EAX|AX|AL)$/.test(m))) return false;
  return c.insns.some(m => /^MOV\/(EAX|AL)$/.test(m));
}

function names(roots: readonly ASTNode[], name: string): number {
  let n = 0;
  for (const r of roots) for (const x of traverseAST(r)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name) n++;
  return n;
}

function writes(roots: readonly ASTNode[], name: string): boolean {
  for (const r of roots) for (const x of traverseAST(r)) {
    if (x.kind === NodeKind.AssignExpr) {
      const l = unparen((x as AssignExpr).left);
      if (l.kind === NodeKind.Identifier && (l as Identifier).name === name) return true;
    }
    if (x.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((x as UnaryExpr).operator)) {
      const o = unparen((x as UnaryExpr).operand);
      if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
    }
    if (x.kind === NodeKind.PostfixExpr) {
      const o = unparen((x as unknown as { operand: Expression }).operand);
      if (o.kind === NodeKind.Identifier && (o as Identifier).name === name) return true;
    }
  }
  return false;
}

/** Holds a return, jump or label (a halt's `exit` is a call, not a jump). */
function leavesOtherwise(roots: readonly ASTNode[]): boolean {
  for (const r of roots) for (const x of traverseAST(r)) {
    if (x.kind === NodeKind.ReturnStmt || x.kind === NodeKind.GotoStmt || x.kind === NodeKind.LabelStmt
      || x.kind === NodeKind.BreakStmt || x.kind === NodeKind.ContinueStmt || x.kind === NodeKind.CaseStmt || x.kind === NodeKind.DefaultStmt) return true;
  }
  return false;
}

/** `!V` / `V == 0`: V, else null. */
function zeroTest(e: Expression): string | null {
  const u = unparen(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const o = unparen((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==' && intValue((u as BinaryExpr).right) === 0n) {
    const l = unparen((u as BinaryExpr).left);
    return l.kind === NodeKind.Identifier ? (l as Identifier).name : null;
  }
  return null;
}

/** `v = e;` / `T v = e;`. */
function storeOf(s: Statement): { v: string; e: Expression; decl: boolean } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unparen((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const l = unparen((e as AssignExpr).left);
    return l.kind === NodeKind.Identifier ? { v: (l as Identifier).name, e: (e as AssignExpr).right, decl: false } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const ds = (s as DeclStmt).declarations;
    if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
    const d = ds[0] as VariableDecl;
    if (!d.initializer || d.initializer.kind === NodeKind.InitListExpr) return null;
    return { v: d.name.name, e: d.initializer as Expression, decl: true };
  }
  return null;
}

function bareDeclOf(s: Statement): string | null {
  if (s.kind !== NodeKind.DeclStmt) return null;
  const ds = (s as DeclStmt).declarations;
  return ds.length === 1 && ds[0].kind === NodeKind.VariableDecl && !(ds[0] as VariableDecl).initializer ? (ds[0] as VariableDecl).name.name : null;
}

function tested(list: Statement[], reader: LayoutReader, ev: BranchLayoutEvidence, opts: JoinConstantReturnOptions): Statement[] | null {
  const n = list.length;
  const last = list[n - 1];
  if (last.kind !== NodeKind.ReturnStmt || !(last as ReturnStmt).value) return null;
  const rv = unparen((last as ReturnStmt).value!);
  if (rv.kind !== NodeKind.Identifier) return null;
  const v = (rv as Identifier).name;
  for (let i = 0; i < n - 1; i++) {
    const s = list[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const g = s as IfStmt;
    if (g.elseBranch || g.init || zeroTest(g.condition) !== v) continue;
    const arm = bodyOf(g.thenBranch);
    const ret = arm[arm.length - 1];
    if (!ret || ret.kind !== NodeKind.ReturnStmt || intValue((ret as ReturnStmt).value) !== 0n) continue;
    const rest = list.slice(i + 1, n - 1);
    if (rest.length === 0 || leavesOtherwise(rest) || writes(rest, v) || writes(arm, v) || leavesOtherwise(arm.slice(0, -1))) continue;
    const copy = copyOf(reader, ev, ret as ReturnStmt);
    if (!copy || !movesIntoEax(copy)) continue;
    opts.onSite?.({ line: g.location?.start.line ?? 0, form: 'tested' });
    const ifs = updateNode(g, {
      thenBranch: Stmt.compound(arm.slice(0, -1)),
      elseBranch: Stmt.compound(rest),
    } as Partial<IfStmt>);
    return [...list.slice(0, i), ifs, last];
  }
  return null;
}

function flag(fn: FunctionDecl, list: Statement[], reader: LayoutReader, ev: BranchLayoutEvidence, opts: JoinConstantReturnOptions): Statement[] | null {
  const n = list.length;
  const last = list[n - 1];
  if (last.kind !== NodeKind.ReturnStmt) return null;
  const k2 = intValue((last as ReturnStmt).value);
  if (k2 === null) return null;
  for (let i = n - 2; i >= 0; i--) {
    const s = list[i];
    if (s.kind !== NodeKind.IfStmt) continue;
    const outer = s as IfStmt;
    if (outer.elseBranch || outer.init) return null;
    const tail = list.slice(i + 1, n - 1);
    const arm = bodyOf(outer.thenBranch);
    // [T v;] v = E; if (v) { S...; return K1; }
    let k = 0;
    const declared = arm.length === 3 ? bareDeclOf(arm[0]) : null;
    if (declared) k = 1;
    if (arm.length !== k + 2) return null;
    const st = storeOf(arm[k]);
    const inner = arm[k + 1];
    if (!st || inner.kind !== NodeKind.IfStmt || (declared && (st.v !== declared || st.decl))) return null;
    const ifIn = inner as IfStmt;
    const t = unparen(ifIn.condition);
    if (ifIn.elseBranch || t.kind !== NodeKind.Identifier || (t as Identifier).name !== st.v) return null;
    const body = bodyOf(ifIn.thenBranch);
    const r1 = body[body.length - 1];
    if (!r1 || r1.kind !== NodeKind.ReturnStmt) return null;
    const k1 = intValue((r1 as ReturnStmt).value);
    if (k1 === null || k1 === k2 || (k1 !== 0n && k2 !== 0n)) return null;
    const s1 = body.slice(0, -1);
    if (s1.length !== tail.length || !s1.every((x, j) => sameExpr(x, tail[j])) || leavesOtherwise(tail)) return null;
    // v is named only in its store, its test and its declaration.
    if (uses(fn.body!, st.v) !== 2) return null;
    // The evidence: the copy returning zero moves into EAX/AL.
    const zeroRet = (k1 === 0n ? r1 : last) as ReturnStmt;
    const copy = copyOf(reader, ev, zeroRet);
    if (!copy || !movesIntoEax(copy)) return null;
    const used = new Set<string>();
    for (const x of traverseAST(fn.body!)) if (x.kind === NodeKind.Identifier) used.add((x as Identifier).name);
    let r = 'bResult';
    for (let j = 2; used.has(r); j++) r = `bResult${j}`;
    const type = cloneNode(fn.returnType) as TypeNode;
    const lit = (x: Expression | null | undefined) => cloneNode(unparen(x!)) as Expression;
    const cond = Expr.binary(cloneNode(outer.condition) as Expression, '&&', cloneNode(st.e) as Expression);
    const ifs = updateNode(outer, {
      condition: cond,
      thenBranch: Stmt.compound([Stmt.expr(Expr.assign(Expr.identifier(r), lit((r1 as ReturnStmt).value)))]),
      elseBranch: Stmt.compound([Stmt.expr(Expr.assign(Expr.identifier(r), lit((last as ReturnStmt).value)))]),
    } as Partial<IfStmt>);
    opts.onSite?.({ line: outer.location?.start.line ?? 0, form: 'flag' });
    const ret = updateNode(last as ReturnStmt, { value: Expr.identifier(r) } as Partial<ReturnStmt>);
    const head = list.slice(0, i).filter(x => !(declared === null && bareDeclOf(x) === st.v));
    return [Stmt.declStmt([Decl.variable(r, type)]), ...head, ifs, ...tail, ret];
  }
  return null;
}

/** Identifiers naming `name`, a declaration's own name not counted. */
function uses(root: ASTNode, name: string): number {
  const own = new Set<ASTNode>();
  for (const x of traverseAST(root)) if (x.kind === NodeKind.VariableDecl) own.add((x as VariableDecl).name);
  let n = 0;
  for (const x of traverseAST(root)) if (x.kind === NodeKind.Identifier && (x as Identifier).name === name && !own.has(x)) n++;
  return n;
}

function createJoinConstantReturnTransformer(options: JoinConstantReturnOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      const ev = options.branchLayout;
      if (!fn.body || !ev?.returns) return undefined;
      const reader = new LayoutReader(ev, fn.body);
      const list = [...fn.body.statements];
      if (list.length < 2) return undefined;
      const out = tested(list, reader, ev, options) ?? flag(fn, list, reader, ev, options);
      if (!out) return undefined;
      return updateNode(fn, { body: updateNode(fn.body, { statements: out } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
    },
  });
}

export const joinConstantReturnPlugin: TransformPlugin = {
  id: 'join-constant-return',
  name: 'Join Constant Return',
  description: 'A zero return whose copy moves a register into EAX goes back to the join VC8 tail-duplicated',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.988,
  tags: ['matching'],
  createTransformer: (options: JoinConstantReturnOptions = {}) => createJoinConstantReturnTransformer(options),
};

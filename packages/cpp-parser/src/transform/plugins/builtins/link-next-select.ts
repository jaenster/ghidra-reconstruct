/**
 * Link Next Select Plugin
 *
 * A Storm list link ends in a terminator whose address is stored negated, so the getter of
 * the next node is "the link if it is positive, else null": `(int)m_next > 0 ? m_next : 0`.
 * Inlined into a loop that runs while there is a next node, VC8 threads the select's null
 * into the loop test, and the decompiler prints the two as one sign test
 * (TSList_HANDLER_UnlinkAll 0041c770, RemoveAllListNodes 0040fd00):
 *
 *     while (true) {
 *       pNode = (int*)pList->pNext;
 *       if ((int)pNode <= 0) {
 *         break;
 *       }
 *       ...
 *     }
 *
 * Compiled as printed, VC8 rotates the loop (the sign test copied above it and at its
 * bottom, the callee-saved pushes sunk past the first copy); the original keeps one test at
 * the top and jumps back to it, with the pushes in the prologue. Written with the select,
 * the loop compiles as the original:
 *
 *     while (true) {
 *       pNode = (int)(int*)pList->pNext > 0 ? (int*)pList->pNext : 0;
 *       if (!pNode) {
 *         break;
 *       }
 *       ...
 *     }
 *
 * Checked with the oracle's compiler: TSList_HANDLER_UnlinkAll matches byte for byte.
 *
 * Shape: the first two statements of a `while (true)` / `for (;;)` body, after declarations
 * without a value, are `p = E;` (or `T p = E;`) and `if ((T2)p <= 0) { break; }` (also `< 1`, and a bare `p <= 0`), the if
 * without else. E reads only: no call, assignment or increment, and it does not name p.
 * p is a local or parameter whose address is not taken and that nothing outside the loop
 * names.
 *
 * Value-preserving: E is read twice instead of once with nothing in between. When (T2)E > 0,
 * p is E and nonzero (`!p` is false), as before; otherwise p is 0 and the loop is left, as
 * before. The value p is left with differs only on that exit, and nothing after the loop
 * reads p.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, AssignExpr, BinaryExpr, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, ExprStmt,
  ForStmt, FunctionDecl, Identifier, IfStmt, ParenExpr, Statement, UnaryExpr, VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface LinkNextSelectOptions extends PluginOptions {
  onSite?: (e: { function: string; name: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function intValue(e: Expression): bigint | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) {
    const v = (u as unknown as { value: bigint | number }).value;
    return typeof v === 'bigint' ? v : BigInt(v);
  }
  return null;
}

function isTrue(e: Expression | null | undefined): boolean {
  if (!e) return true;
  const u = unwrap(e);
  if (u.kind === NodeKind.BoolLiteral) return (u as unknown as { value: boolean }).value;
  if (u.kind === NodeKind.Identifier) return (u as Identifier).name === 'true';
  const v = intValue(u);
  return v !== null && v !== 0n;
}

/** The body of an endless loop, or null. */
function endlessBody(s: Statement): CompoundStmt | null {
  if (s.kind === NodeKind.WhileStmt) {
    const w = s as WhileStmt;
    return isTrue(w.condition as Expression) && w.body.kind === NodeKind.CompoundStmt ? w.body as CompoundStmt : null;
  }
  if (s.kind === NodeKind.ForStmt) {
    const f = s as ForStmt & { init?: unknown; condition?: Expression | null; increment?: Expression | null };
    if (f.init || f.increment || !isTrue(f.condition)) return null;
    return f.body.kind === NodeKind.CompoundStmt ? f.body as CompoundStmt : null;
  }
  return null;
}

/** `p = E;` or `T p = E;`. */
function definition(s: Statement | undefined): { name: string; value: Expression } | null {
  if (!s) return null;
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit || v.copyListInit || v.specifiers.length > 0) return null;
    return { name: v.name.name, value: v.initializer as Expression };
  }
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrap((e as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? { name: (l as Identifier).name, value: (e as AssignExpr).right } : null;
}

/** `if ((T)p <= 0) { break; }`: the cast (or null for a bare p). */
function signTest(s: Statement | undefined, p: string): { cast: CStyleCastExpr | null } | null {
  if (!s || s.kind !== NodeKind.IfStmt) return null;
  const i = s as IfStmt;
  if (i.elseBranch || i.init || i.isConstexpr) return null;
  const then = i.thenBranch.kind === NodeKind.CompoundStmt ? (i.thenBranch as CompoundStmt).statements : [i.thenBranch];
  if (then.length !== 1 || then[0].kind !== NodeKind.BreakStmt) return null;
  const c = unwrap(i.condition);
  if (c.kind !== NodeKind.BinaryExpr) return null;
  const b = c as BinaryExpr;
  const k = intValue(b.right);
  if (!((b.operator === '<=' && k === 0n) || (b.operator === '<' && k === 1n))) return null;
  let l = unwrap(b.left);
  let cast: CStyleCastExpr | null = null;
  if (l.kind === NodeKind.CStyleCastExpr) {
    cast = l as CStyleCastExpr;
    const t = emit(cast.type as unknown as AnyNode).trim();
    if (!/^(int|long|int32_t|INT|LONG)$/.test(t)) return null;
    l = unwrap(cast.expression);
  }
  return l.kind === NodeKind.Identifier && (l as Identifier).name === p ? { cast } : null;
}

/** E only reads: no call, assignment or increment. */
function readsOnly(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr: case NodeKind.NewExpr:
      case NodeKind.DeleteExpr: case NodeKind.CommaExpr: case NodeKind.ConditionalExpr:
        return false;
      case NodeKind.UnaryExpr:
        if (['++', '--'].includes((n as UnaryExpr).operator)) return false;
        break;
      default:
    }
  }
  return true;
}

function names(n: ASTNode, p: string): boolean {
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === p) return true;
  return false;
}

function addressed(n: ASTNode, p: string): boolean {
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.UnaryExpr && (m as UnaryExpr).operator === '&' && names((m as UnaryExpr).operand, p)) return true;
  }
  return false;
}

/** Whether p is named in `root` outside `loop` (its declaration aside). */
function namedOutside(root: ASTNode, loop: ASTNode, p: string): boolean {
  const inside = new Set<ASTNode>(traverseAST(loop));
  for (const m of traverseAST(root)) if (m.kind === NodeKind.VariableDecl) inside.add((m as VariableDecl).name);
  for (const m of traverseAST(root)) {
    if (inside.has(m)) continue;
    if (m.kind === NodeKind.Identifier && (m as Identifier).name === p) return true;
  }
  return false;
}

function rewriteFunction(fn: FunctionDecl, opts: LinkNextSelectOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = false;
  for (const n of [...traverseAST(body)]) {
    const loopBody = endlessBody(n as Statement);
    if (!loopBody) continue;
    const l = loopBody.statements as Statement[];
    // Declarations without a value may come first.
    let k = 0;
    while (k < l.length && l[k].kind === NodeKind.DeclStmt
      && (l[k] as DeclStmt).declarations.every(d => d.kind === NodeKind.VariableDecl && !(d as VariableDecl).initializer)) k++;
    const def = definition(l[k]);
    if (!def) continue;
    const test = signTest(l[k + 1], def.name);
    if (!test) continue;
    if (!readsOnly(def.value) || names(def.value, def.name)) continue;
    if (addressed(body, def.name) || namedOutside(body, n, def.name)) continue;
    const castType = test.cast ? cloneNode(test.cast.type) : null;
    const sign = castType ? Expr.cast(castType, Expr.paren(cloneNode(def.value))) : Expr.paren(cloneNode(def.value));
    const select = Expr.conditional(Expr.gt(sign, Expr.intLiteral(0)), cloneNode(def.value), Expr.intLiteral(0));
    if (l[k].kind === NodeKind.DeclStmt) {
      const d = l[k] as DeclStmt;
      l[k] = { ...d, declarations: [{ ...(d.declarations[0] as VariableDecl), initializer: select }] } as DeclStmt;
    } else {
      l[k] = Stmt.expr(Expr.assign(Expr.identifier(def.name), select));
    }
    l[k + 1] = { ...(l[k + 1] as IfStmt), condition: Expr.not(Expr.identifier(def.name)) } as IfStmt;
    changed = true;
    opts.onSite?.({ function: fname, name: def.name });
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

export const linkNextSelectPlugin: TransformPlugin = {
  id: 'link-next-select',
  name: 'Link Next Select',
  description: 'A loop-leaving sign test of a list link is written as the inlined next-node select and a null test',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.993,
  tags: ['matching'],
  createTransformer: (options: LinkNextSelectOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};

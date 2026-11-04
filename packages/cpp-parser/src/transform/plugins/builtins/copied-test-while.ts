/**
 * Copied Test While Plugin
 *
 * A loop that tests a value computed from x and then gives x that value, `while (x & x - 1)
 * x &= x - 1;` (BNNEWS_RoundToPowerOfTwo 0051d2f0, TSGrowableArray::CalcChunkSize
 * 0044df30), comes out of the decompiler with the value carried in two copies:
 *
 *     c = x - 1 & x;                          while (x & x - 1) {
 *     while (true) {                            x &= x - 1;
 *       t = c;                          ->    }
 *       if (!t) break;
 *       x = t;
 *       c = t - 1 & t;
 *     }
 *
 * Compiled as printed, VC8 keeps c and t in registers of their own; the original computes
 * the value from x at the test (`mov eax, ecx; lea ecx, [eax-1]; and ecx, eax; jnz`).
 *
 * `c = E(x); while (true) { t = c; if (!t) break; x = t; c = E(t); }` becomes
 * `while (E(x)) { x = E(x); }` when
 *   - x, c and t are distinct plain names, c and t locals whose address is never taken and
 *     which are named nowhere else in the function but in declarations without a value
 *     (dropped with them);
 *   - E(t) is E(x) with t for x, and E calls, assigns and increments nothing;
 *   - the `if` is the whole exit test, its arm a lone `break`.
 * E = `x - 1 & x` (either operand order) is written `x & x - 1`, and the store `x &= x - 1`.
 *
 * Value-preserving: at every test c holds E of the current x (first from the statement
 * before the loop, then from `c = E(t)` right after `x = t`), and t is c; so the loop runs
 * while E(x) is non-zero and gives x the value E(x) each turn. E is pure, so computing it
 * again in the body gives the tested value. After the loop c and t are never read.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BoolLiteralExpr, CompoundStmt, DeclStmt, Expression, ExprStmt,
  FunctionDecl, Identifier, IfStmt, MemberExpr, ParameterDecl, ParenExpr, Statement, UnaryExpr,
  VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, cloneNode, nodesEqual, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface CopiedTestWhileOptions extends PluginOptions {
  onSite?: (e: { variable: string; copies: [string, string] }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function name(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

function assignment(s: Statement): { x: string; e: Expression } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const x = name((e as AssignExpr).left);
  return x ? { x, e: unwrap((e as AssignExpr).right) } : null;
}

function isTrue(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.BoolLiteral) return (u as BoolLiteralExpr as unknown as { value: boolean }).value === true;
  return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 1n;
}

function isPure(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.AssignExpr || n.kind === NodeKind.CallExpr || n.kind === NodeKind.PostfixExpr ||
        n.kind === NodeKind.CommaExpr) return false;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) return false;
  }
  return true;
}

/** Names of x in n, not counting member names (`p->x`). */
function names(n: ASTNode, x: string): number {
  const members = new Set<ASTNode>();
  let c = 0;
  for (const m of traverseAST(n)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) c++;
  }
  return c;
}

/** `if (!t) break;` (or `t == 0`): t. */
function breakTest(s: Statement): string | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const g = s as IfStmt;
  if (g.elseBranch || g.init) return null;
  const arm = g.thenBranch.kind === NodeKind.CompoundStmt ? (g.thenBranch as CompoundStmt).statements : [g.thenBranch];
  if (arm.length !== 1 || arm[0].kind !== NodeKind.BreakStmt) return null;
  const c = unwrap(g.condition);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return name((c as UnaryExpr).operand);
  if (c.kind === NodeKind.BinaryExpr && (c as BinaryExpr).operator === '==') {
    const r = unwrap((c as BinaryExpr).right);
    if (r.kind === NodeKind.IntegerLiteral && (r as unknown as { value: bigint }).value === 0n) return name((c as BinaryExpr).left);
  }
  return null;
}

/** E with every name `from` replaced by `to`. */
function rename(e: Expression, from: string, to: string): Expression {
  const c = cloneNode(e) as Expression;
  for (const m of traverseAST(c)) {
    if (m.kind === NodeKind.Identifier && (m as Identifier).name === from) (m as unknown as { name: string }).name = to;
  }
  return c;
}

function bareDecl(s: Statement): string | null {
  if (s.kind !== NodeKind.DeclStmt) return null;
  const ds = (s as DeclStmt).declarations;
  if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return null;
  const v = ds[0] as VariableDecl;
  return v.initializer || v.specifiers.includes('static') ? null : v.name.name;
}

/** `x - 1 & x` or `x & x - 1`. */
function clearsLowBit(e: Expression, x: string): boolean {
  const u = unwrap(e);
  if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '&') return false;
  const dec = (d: Expression): boolean => {
    const v = unwrap(d);
    if (v.kind !== NodeKind.BinaryExpr || (v as BinaryExpr).operator !== '-' || name((v as BinaryExpr).left) !== x) return false;
    const r = unwrap((v as BinaryExpr).right);
    return r.kind === NodeKind.IntegerLiteral && (r as unknown as { value: bigint }).value === 1n;
  };
  const b = u as BinaryExpr;
  return (dec(b.left) && name(b.right) === x) || (name(b.left) === x && dec(b.right));
}

function createCopiedTestWhileTransformer(options: CopiedTestWhileOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const all = [...traverseAST(fn.body)];
      const params = new Set((fn.parameters as ParameterDecl[]).map(p => p.name?.name).filter(Boolean) as string[]);
      const declCount = new Map<string, number>();
      for (const n of all) if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
      }
      const addressed = new Set<string>();
      for (const n of all) if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = name((n as UnaryExpr).operand);
        if (o) addressed.add(o);
      }
      const ownLocal = (v: string) => !params.has(v) && !addressed.has(v) && declCount.get(v) === 1;
      const body = cloneNode(fn.body) as CompoundStmt;
      const found: Array<{ list: Statement[]; i: number; x: string; c: string; t: string; e: Expression }> = [];
      const visit = (n: ASTNode): void => {
        for (const k of getChildren(n)) visit(k);
        if (n.kind !== NodeKind.CompoundStmt) return;
        const list = (n as CompoundStmt).statements;
        for (let i = 0; i + 1 < list.length; i++) {
          const init = assignment(list[i]);
          if (!init || list[i + 1].kind !== NodeKind.WhileStmt) continue;
          const w = list[i + 1] as WhileStmt;
          if (!isTrue(w.condition) || w.body.kind !== NodeKind.CompoundStmt) continue;
          const bs = (w.body as CompoundStmt).statements;
          if (bs.length !== 4) continue;
          const copy = assignment(bs[0]); const t = breakTest(bs[1]); const step = assignment(bs[2]); const next = assignment(bs[3]);
          if (!copy || !t || !step || !next) continue;
          const c = init.x;
          if (copy.x !== t || name(copy.e) !== c || name(step.e) !== t || next.x !== c) continue;
          const x = step.x;
          if (new Set([x, c, t]).size !== 3 || !ownLocal(c) || !ownLocal(t)) continue;
          if (!isPure(init.e) || names(init.e, x) === 0 || names(init.e, c) + names(init.e, t) > 0) continue;
          if (!nodesEqual(rename(init.e, x, t), next.e)) continue;
          found.push({ list, i, x, c, t, e: init.e });
        }
      };
      visit(body);
      let changed = false;
      for (const f of found) {
        // c and t named only here (and in bare declarations, dropped).
        const bare = (v: string) => {
          let k = 0;
          for (const m of traverseAST(body)) if (m.kind === NodeKind.CompoundStmt) k += (m as CompoundStmt).statements.filter(s => bareDecl(s) === v).length;
          return k;
        };
        const here = { kind: NodeKind.CompoundStmt, statements: [f.list[f.i], f.list[f.i + 1]] } as unknown as ASTNode;
        if (names(body, f.c) !== names(here, f.c) + bare(f.c) || names(body, f.t) !== names(here, f.t) + bare(f.t)) continue;
        const w = f.list[f.i + 1] as WhileStmt;
        const lowBit = clearsLowBit(f.e, f.x);
        const dec = Expr.binary(Expr.identifier(f.x), '-', Expr.intLiteral(1));
        const test = lowBit ? Expr.binary(Expr.identifier(f.x), '&', dec) : cloneNode(f.e) as Expression;
        const store = Stmt.expr(lowBit
          ? Expr.assign(Expr.identifier(f.x), cloneNode(dec) as Expression, '&=')
          : Expr.assign(Expr.identifier(f.x), cloneNode(f.e) as Expression));
        const loop = {
          ...w,
          leadingTrivia: f.list[f.i].leadingTrivia,
          condition: test,
          body: { ...(w.body as CompoundStmt), statements: [store] },
        } as WhileStmt;
        f.list.splice(f.i, 2, loop);
        for (const v of [f.c, f.t]) {
          for (const m of traverseAST(body)) {
            if (m.kind !== NodeKind.CompoundStmt) continue;
            const l = (m as CompoundStmt).statements;
            for (let j = l.length - 1; j >= 0; j--) if (bareDecl(l[j]) === v) l.splice(j, 1);
          }
        }
        changed = true;
        options.onSite?.({ variable: f.x, copies: [f.c, f.t] });
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const copiedTestWhilePlugin: TransformPlugin = {
  id: 'copied-test-while',
  name: 'Copied Test While',
  description: 'A loop testing a value of x through two copies before giving x that value tests and stores the value itself',
  version: '1.0.0',
  defaultEnabled: true,
  // With the other late matching shapes, after rotated-step-while (989.865).
  priority: 989.866,
  tags: ['matching'],
  createTransformer: (options: CopiedTestWhileOptions = {}) => createCopiedTestWhileTransformer(options),
};

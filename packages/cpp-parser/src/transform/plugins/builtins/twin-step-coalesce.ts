/**
 * Twin Step Coalesce Plugin
 *
 * A pointer stepped past a field comes out of the decompiler as two variables given the same
 * value, one after the other (Name, BNGatewayAccess, 005180a0):
 *
 *     szZoneField = pEntry + nFirstFieldLen + 1;
 *     pEntry = pEntry + nFirstFieldLen + 1;
 *     if (*szZoneField != '\0') { ... SStrLen(pEntry) ... }
 *
 * The decompiler split one register's value into two names: the step writes it, and the
 * reads that follow read it under either name. The source had one variable, `pEntry +=
 * SStrLen(pEntry) + 1; if (*pEntry) ..`; compiled with two, VC8 keeps the value twice.
 *
 * `X = E; P = E;` with E the same expression, reading P and nothing X, with no call, no
 * assignment and no increment in it, is first written `P = E; X = P;` - the same two values,
 * E evaluated once on the same inputs. Then, by the function's dataflow, every read of X
 * that the copy reaches must be reached by it alone, with no write of P on any path from the
 * copy to the read nor in the read's own node: each such read reads P instead, and the copy,
 * read nowhere, goes. X may live other lives elsewhere (Ghidra reuses one name for unrelated
 * values, TRANSTBL_UnicodeToSingleByte 006c77f0); those are untouched. A site with any read
 * the proof does not cover is left as printed.
 *
 * Value-preserving: E reads only P and names that neither statement writes, so the first
 * statement and the second compute the same value; after the swap X holds P's new value, as
 * before; at each rewritten read X and P hold that same value.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, MemberExpr, ParameterDecl, ParenExpr,
  Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, cloneNode, nodesEqual, updateNode, type Transformer } from '../../transformer.js';
import { buildFunctionFlow } from '../../cfg/dataflow.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface TwinStepCoalesceOptions extends PluginOptions {
  onSite?: (e: { variable: string; into: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function assignOf(s: Statement): { x: string; e: Expression } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const a = unwrap((s as ExprStmt).expression);
  if (a.kind !== NodeKind.AssignExpr || (a as AssignExpr).operator !== '=') return null;
  const l = unwrap((a as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? { x: (l as Identifier).name, e: (a as AssignExpr).right } : null;
}

/** E has no effect: no call, assignment, increment or comma. */
function pure(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    switch (n.kind) {
      case NodeKind.CallExpr: case NodeKind.AssignExpr: case NodeKind.PostfixExpr: case NodeKind.CommaExpr:
        return false;
      case NodeKind.UnaryExpr: {
        const op = (n as unknown as { operator: string }).operator;
        if (op === '++' || op === '--') return false;
      }
    }
  }
  return true;
}

function names(e: ASTNode): Set<string> {
  const members = new Set<ASTNode>();
  const out = new Set<string>();
  for (const m of traverseAST(e)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && !members.has(m)) out.add((m as Identifier).name);
  }
  return out;
}

function copyStmt(x: string, p: string, like: Statement): Statement {
  return {
    ...(like as ExprStmt),
    leadingTrivia: undefined,
    expression: {
      kind: NodeKind.AssignExpr, operator: '=',
      left: { kind: NodeKind.Identifier, name: x } as Identifier,
      right: { kind: NodeKind.Identifier, name: p } as Identifier,
    } as AssignExpr,
  } as unknown as Statement;
}

/** The twin sites of the body, as (list, index of the X statement, X, P). */
function twins(body: CompoundStmt): Array<{ list: Statement[]; i: number; x: string; p: string }> {
  const out: Array<{ list: Statement[]; i: number; x: string; p: string }> = [];
  for (const n of traverseAST(body)) {
    if (n.kind !== NodeKind.CompoundStmt) continue;
    const list = (n as CompoundStmt).statements;
    for (let i = 0; i + 1 < list.length; i++) {
      const a = assignOf(list[i]), b = assignOf(list[i + 1]);
      if (!a || !b || a.x === b.x || !nodesEqual(unwrap(a.e), unwrap(b.e)) || !pure(a.e)) continue;
      const used = names(a.e);
      if (!used.has(b.x) || used.has(a.x)) continue;
      out.push({ list, i, x: a.x, p: b.x });
    }
  }
  return out;
}

function createTwinStepCoalesceTransformer(options: TwinStepCoalesceOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      let body = cloneNode(fn.body) as CompoundStmt;
      if ([...traverseAST(body)].some(n => n.kind === NodeKind.TryStmt || n.kind === NodeKind.SehTryStmt ||
        n.kind === NodeKind.ForRangeStmt || n.kind === NodeKind.AsmDecl)) return undefined;
      const declared = new Set<string>();
      for (const p of fn.parameters as ParameterDecl[]) if (p.name) declared.add(p.name.name);
      const dup = new Set<string>();
      for (const n of traverseAST(body)) if (n.kind === NodeKind.VariableDecl) {
        const v = n as VariableDecl;
        if (declared.has(v.name.name)) dup.add(v.name.name);
        declared.add(v.name.name);
      }
      const addressed = new Set<string>();
      for (const n of traverseAST(body)) if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = unwrap((n as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier) addressed.add((o as Identifier).name);
      }
      const plain = (v: string) => declared.has(v) && !dup.has(v) && !addressed.has(v);
      let changed = false;
      const tried = new Set<string>();
      for (let round = 0; round < 32; round++) {
        const site = twins(body).find(s => plain(s.x) && plain(s.p) && !tried.has(key(s)));
        if (!site) break;
        tried.add(key(site));
        const trial = cloneNode(body) as CompoundStmt;
        const t = twins(trial).find(s => key(s) === key(site))!;
        const first = t.list[t.i];
        const step = t.list[t.i + 1];
        const copy = copyStmt(t.x, t.p, first);
        t.list.splice(t.i, 2, { ...step, leadingTrivia: (first as { leadingTrivia?: unknown }).leadingTrivia } as Statement, copy);
        const flow = buildFunctionFlow(trial.statements, declared);
        const c = flow.nodeOf(copy);
        if (c === undefined) continue;
        const uses = flow.usesOf(c, t.x);
        if (!uses.length) continue;
        // Every read of X sees this copy alone, and P is not written on the way to it nor by it.
        const ok = uses.every(u => {
          const r = flow.reaching(u, t.x);
          return r.size === 1 && r.has(c) && !flow.writtenBetween(c, u, [t.p]) && !flow.writes(u).has(t.p) && !flow.writes(u).has(t.x);
        });
        if (!ok) continue;
        for (const u of uses) for (const e of flow.ownExprs(u)) renameIn(e, t.x, t.p);
        // The copy is read nowhere now.
        const at = t.list.indexOf(copy);
        if (at >= 0) t.list.splice(at, 1);
        dropBareDecl(trial, t.x);
        body = trial;
        changed = true;
        options.onSite?.({ variable: t.x, into: t.p });
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

function key(s: { list: Statement[]; i: number; x: string; p: string }): string {
  return `${s.x}\u0000${s.p}\u0000${nodeText(s.list[s.i])}`;
}

function nodeText(n: ASTNode): string {
  const l = (n as { location?: { start?: { offset?: number } } }).location?.start?.offset;
  return l === undefined ? JSON.stringify(n, (k, v) => (k === 'location' || k === 'leadingTrivia' ? undefined : v)) : String(l);
}

/** A bare `T X;` of a name the body no longer mentions goes. */
function dropBareDecl(body: CompoundStmt, x: string): void {
  const members = new Set<ASTNode>();
  for (const m of traverseAST(body)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.VariableDecl) members.add((m as VariableDecl).name as unknown as ASTNode);
  }
  for (const m of traverseAST(body)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) return;
  for (const m of traverseAST(body)) {
    if (m.kind !== NodeKind.CompoundStmt) continue;
    const list = (m as CompoundStmt).statements;
    const j = list.findIndex(st => st.kind === NodeKind.DeclStmt && (st as DeclStmt).declarations.length === 1 &&
      (st as DeclStmt).declarations[0].kind === NodeKind.VariableDecl &&
      ((st as DeclStmt).declarations[0] as VariableDecl).name.name === x && !((st as DeclStmt).declarations[0] as VariableDecl).initializer);
    if (j >= 0) { list.splice(j, 1); return; }
  }
}

/** Rename identifier x to p inside e (not member names), in place. */
function renameIn(e: ASTNode, x: string, p: string): void {
  const members = new Set<ASTNode>();
  for (const m of traverseAST(e)) {
    if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
    else if (m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)) (m as unknown as { name: string }).name = p;
  }
}

export const twinStepCoalescePlugin: TransformPlugin = {
  id: 'twin-step-coalesce',
  name: 'Twin Step Coalesce',
  description: 'Two variables given one stepped value back to back are one variable, on a dataflow proof',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.8645,
  tags: ['matching'],
  createTransformer: (options: TwinStepCoalesceOptions = {}) => createTwinStepCoalesceTransformer(options),
};

/**
 * Accumulate Sum Plugin
 *
 * `n = A; n += B; use(n)` keeps the sum in the register that held A. The decompiler gives
 * the second value its own variable (SendMercPackets, 005726c0):
 *
 *     int32_t nStatTmp = SERVER_GetUnitStat(pMerc, UNITSTAT_secondary_mindamage, 0);
 *     int32_t nSecondaryStatVal = SERVER_GetUnitStat(pMerc, UNITSTAT_mindamage, 0);
 *     UnitQueuePacket0x9E(pMerc, 0x15, nStatTmp + nSecondaryStatVal);
 *   =>
 *     int32_t nStatTmp = SERVER_GetUnitStat(pMerc, UNITSTAT_secondary_mindamage, 0);
 *     nStatTmp += SERVER_GetUnitStat(pMerc, UNITSTAT_mindamage, 0);
 *     UnitQueuePacket0x9E(pMerc, 0x15, nStatTmp);
 *
 * VC8 adds the two variables into the second one's register (`add eax, edi; push eax`); the
 * original adds into the first (`add edi, eax; push edi`), which is what the compound
 * assignment compiles to.
 *
 * Value-preserving. Three consecutive statements: `x = A;` (or `T x = A;`), `y = B;` (or
 * `T y = B;`), and a statement that reads `x + y` (or `y + x`). Required:
 *   - x and y are locals of one 32-bit integer type whose address is never taken;
 *   - by the function's dataflow (cfg/dataflow.ts) the value the first statement gives x and
 *     the value the second gives y reach the third statement and no other, and the third
 *     names each exactly once, in the sum, and does not write x;
 *   - B does not name x.
 * Then `x += (T)B` leaves x + y in x, B runs where it ran, and y is never read. A
 * declaration of y that a later statement still needs stays, without its initialiser.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, ParameterDecl, ParenExpr, QualifiedType, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName } from './call-arg-cast.js';
import { buildFunctionFlow, type FunctionFlow } from '../../cfg/dataflow.js';

export interface AccumulateSumOptions extends PluginOptions {
  onSite?: (e: { function: string; target: string; operand: string }) => void;
}

const WORD_INTS = new Set(['int', 'unsigned int', 'signed int', 'int32_t', 'uint32_t', 'INT', 'UINT', 'DWORD', 'LONG', 'ULONG', 'BOOL']);

function strip(t: TypeNode): TypeNode {
  while (t.kind === NodeKind.QualifiedType) t = (t as QualifiedType).type;
  return t;
}

function spelling(t: TypeNode | undefined): string | undefined {
  if (!t) return undefined;
  t = strip(t);
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as unknown as { name: string; modifiers?: string[] };
    return [...(b.modifiers ?? []), b.name].join(' ');
  }
  if (t.kind === NodeKind.TypedefType) return typeNodeName((t as unknown as { name: unknown }).name);
  return undefined;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function identName(e: Expression | null | undefined): string | null {
  if (!e) return null;
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

/** `x = v;` or a declaration of x alone with `= v`: x, v. */
function definitionOf(s: Statement): { name: string; value: Expression } | null {
  if (s.kind === NodeKind.ExprStmt) {
    const e = unwrap((s as ExprStmt).expression);
    if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
    const n = identName((e as AssignExpr).left);
    return n ? { name: n, value: (e as AssignExpr).right } : null;
  }
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit) return null;
    return { name: v.name.name, value: v.initializer as Expression };
  }
  return null;
}

function mentions(n: ASTNode, name: string): Identifier[] {
  const out: Identifier[] = [];
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && (m as Identifier).name === name) out.push(m as Identifier);
  return out;
}

interface Facts {
  types: Map<string, TypeNode>;
  addressed: Set<string>;
  count: Map<string, number>;
}

function factsOf(fn: FunctionDecl, body: CompoundStmt): Facts {
  const types = new Map<string, TypeNode>();
  const dup = new Set<string>();
  const add = (n: string, t: TypeNode) => { if (types.has(n)) dup.add(n); types.set(n, t); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  const addressed = new Set<string>();
  const count = new Map<string, number>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) {
      const v = n as VariableDecl;
      add(v.name.name, v.type);
      if (v.type?.kind === NodeKind.ArrayType) addressed.add(v.name.name);
    }
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
    if (n.kind === NodeKind.Identifier) count.set((n as Identifier).name, (count.get((n as Identifier).name) ?? 0) + 1);
  }
  for (const d of dup) types.delete(d);
  return { types, addressed, count };
}

/** The `x + y` / `y + x` node of the statement, the only mention of either. */
function sumIn(s: Statement, x: string, y: string): BinaryExpr | null {
  const mx = mentions(s, x), my = mentions(s, y);
  if (mx.length !== 1 || my.length !== 1) return null;
  for (const n of traverseAST(s)) {
    if (n.kind !== NodeKind.BinaryExpr || (n as BinaryExpr).operator !== '+') continue;
    const b = n as BinaryExpr;
    const l = identName(b.left), r = identName(b.right);
    if ((l === x && r === y) || (l === y && r === x)) return b;
  }
  return null;
}

function writesName(s: Statement, x: string): boolean {
  for (const n of traverseAST(s)) {
    if (n.kind === NodeKind.AssignExpr && identName((n as AssignExpr).left) === x) return true;
    if ((n.kind === NodeKind.PostfixExpr || (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)))
      && identName((n as unknown as { operand: Expression }).operand) === x) return true;
  }
  return false;
}

/** Replace `target` (one node, by identity) under `root` with `by`. */
function substitute<N extends ASTNode>(root: N, target: ASTNode, by: Expression): N {
  const walk = (n: unknown): unknown => {
    if (n === target) return by;
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== 'object') return n;
    if (!('kind' in (n as object))) return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n as object)) {
      out[k] = k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' ? v : walk(v);
    }
    return out;
  };
  return walk(root) as N;
}

function rewriteBlock(block: CompoundStmt, facts: Facts, flow: FunctionFlow, report: (x: string, y: string) => void): boolean {
  const list = block.statements;
  for (let i = 0; i + 2 < list.length; i++) {
    const dx = definitionOf(list[i]);
    const dy = definitionOf(list[i + 1]);
    if (!dx || !dy || dx.name === dy.name) continue;
    const x = dx.name, y = dy.name;
    const tx = facts.types.get(x), ty = facts.types.get(y);
    const sx = spelling(tx), sy = spelling(ty);
    if (!sx || sx !== sy || !WORD_INTS.has(sx)) continue;
    if (facts.addressed.has(x) || facts.addressed.has(y) || flow.isEscaped(x) || flow.isEscaped(y)) continue;
    if (mentions(dy.value, x).length > 0) continue;
    const use = list[i + 2];
    const sum = sumIn(use, x, y);
    if (!sum || writesName(use, x)) continue;
    const nx = flow.nodeOf(list[i]), ny = flow.nodeOf(list[i + 1]), nu = flow.nodeOf(use);
    if (nx === undefined || ny === undefined || nu === undefined) continue;
    const ux = flow.usesOf(nx, x), uy = flow.usesOf(ny, y);
    if (ux.length !== 1 || ux[0] !== nu || uy.length !== 1 || uy[0] !== nu) continue;
    if (flow.reaching(nu, x).size !== 1 || flow.reaching(nu, y).size !== 1) continue;

    const value = identName(dy.value) && spelling(facts.types.get(identName(dy.value)!)) === sx
      ? dy.value : Expr.cast(cloneNode(tx!), parenthesised(dy.value));
    const acc = Stmt.expr(Expr.assign(Expr.identifier(x), value, '+='));
    (acc as unknown as { leadingTrivia: unknown }).leadingTrivia = list[i + 1].leadingTrivia;
    const repl: Statement[] = [];
    // The declaration of y stays when anything but these two statements names y.
    if (list[i + 1].kind === NodeKind.DeclStmt && (facts.count.get(y) ?? 0) > 2) {
      const v = (list[i + 1] as DeclStmt).declarations[0] as VariableDecl;
      repl.push({ ...(list[i + 1] as DeclStmt), declarations: [{ ...v, initializer: null }] } as DeclStmt);
    }
    repl.push(acc);
    const newUse = substitute(use, sum, Expr.identifier(x));
    list.splice(i + 1, 2, ...repl, newUse);
    report(x, y);
    return true;
  }
  return false;
}

function parenthesised(e: Expression): Expression {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier || u.kind === NodeKind.CallExpr || u.kind === NodeKind.IntegerLiteral
    || u.kind === NodeKind.MemberExpr ? e : Expr.paren(e);
}

function rewriteFunction(fn: FunctionDecl, onSite?: AccumulateSumOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  if ([...traverseAST(body)].some(n => n.kind === NodeKind.TryStmt || n.kind === NodeKind.ForRangeStmt)) return undefined;
  let changed = false;
  for (let round = 0; round < 64; round++) {
    const facts = factsOf(fn, body);
    const flow = buildFunctionFlow(body.statements, new Set(facts.types.keys()));
    let done = false;
    for (const n of traverseAST(body)) {
      if (n.kind !== NodeKind.CompoundStmt) continue;
      if (rewriteBlock(n as CompoundStmt, facts, flow, (x, y) => onSite?.({ function: fname, target: x, operand: y }))) { done = true; break; }
    }
    if (!done) break;
    changed = true;
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createAccumulateSumTransformer(options: AccumulateSumOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options.onSite);
    },
  });
}

export const accumulateSumPlugin: TransformPlugin = {
  id: 'accumulate-sum',
  name: 'Accumulate Sum',
  description: 'A sum of two single-use values is accumulated into the first variable with +=',
  version: '1.0.0',
  defaultEnabled: true,
  // On the final statements, before the WARNING strip (990), which runs last.
  priority: 989.95,
  tags: ['matching'],
  createTransformer: createAccumulateSumTransformer,
};

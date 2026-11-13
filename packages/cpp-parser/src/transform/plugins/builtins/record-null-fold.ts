/**
 * Record Null Fold Plugin
 *
 * A record looked up through a pointer that is tested for null first. The decompiler prints
 * the null test and the getter's range tests as one condition, and the generator gives the
 * null test an early return of its own (record-getter-split writes the rest back):
 *
 *     if (!pUnit) return 1;
 *     int nMissileClassId = pUnit->nClassId;
 *     D2MissilesTxt *pMissileTxt = nMissileClassId >= 0 && nMissileClassId < N ? B + nMissileClassId : nullptr;
 *     if (!pMissileTxt) return 1;
 *
 * VC8 compiles that guard as an exit ahead of the register saves the lookup needs. The
 * original leaves a null pointer through the lookup's own exit, with the saves already done
 * (Missiles_SrvHitFunc_AreaElementalDamageExplosion 005a9a70: `test esi, esi; push edi;
 * ... je 005a9be2`, the target of the range tests' `jl`/`jge` too): the null test is part of
 * the getter's condition. Written so, it compiles as the original:
 *
 *     int nMissileClassId;
 *     D2MissilesTxt *pMissileTxt = pUnit && (nMissileClassId = pUnit->nClassId) >= 0 && nMissileClassId < N ? B + nMissileClassId : nullptr;
 *     if (!pMissileTxt) return 1;
 *
 * Shape: four consecutive statements, `if (!P) return R;`, `V = P->F;` (or its declaration),
 * `X = C ? E : <null>;` whose condition's leftmost test reads V as one operand, and
 * `if (!X) return R;` with the same R, which neither calls nor writes and reads none of P, V
 * and X. P, V and X are three different names. The record's guard may test more after X:
 * `if (!X || ...)` or `if (!(X && ...))` (Missiles_SrvHitFunc_SpawnSubMissileAtWallHit
 * 005abf70, `!(pMissileTxt && pMissileTxt->HitSubMissile1 >= 0)`); with X null its first
 * test decides it, and the rest runs only with X, and so P, not null - as before.
 *
 * Gate (`branchLayout`): the null test, the range tests and X's null test leave through one
 * exit of the original: they lie in one decompiled `if`, or every return lies in one return
 * copy each test jumps to, and no return copy lies before the last test. Without the facts
 * nothing changes.
 *
 * Value-preserving: with P null the old code returns R at once; the new stores null in X
 * without reading V and returns R at X's test. With P not null V is assigned P->F before its
 * first read, as before, and every test then runs as it did.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression, FunctionDecl,
  Identifier, MemberExpr, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { effectsOf } from './access-order-evidence.js';
import type { BranchLayoutEvidence } from './branch-layout/evidence.js';
import { Gate, returnGuard, recordStore, sameReturn, placedLine, conjuncts } from './record-getter-split.js';

export interface RecordNullFoldOptions extends PluginOptions {
  branchLayout?: BranchLayoutEvidence | null;
  onSite?: (e: { line: number; pointer: string; record: string }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function uncast(e: Expression): Expression {
  e = unwrap(e);
  while (e.kind === NodeKind.CStyleCastExpr) e = unwrap((e as CStyleCastExpr).expression);
  return e;
}

function pure(e: ASTNode): boolean {
  const f = effectsOf(e);
  return f.calls === 0 && f.writes === 0;
}

/** Whether `e` reads the variable `name`; a member named alike (`gT->pTxt`) is not it. */
function mentions(e: ASTNode, name: string): boolean {
  const members = new Set<ASTNode>();
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.MemberExpr) members.add((n as MemberExpr).member);
    else if (n.kind === NodeKind.Identifier && !members.has(n) && (n as Identifier).name === name) return true;
  }
  return false;
}

function isZero(e: Expression): boolean {
  const u = uncast(e);
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.IntegerLiteral && BigInt((u as unknown as { value: bigint | number }).value) === 0n;
}

function isName(e: Expression, name: string): boolean {
  const u = uncast(e);
  return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
}

/** The name `!P` tests for null. */
function nullTested(c: Expression): string | null {
  const u = unwrap(c);
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '!') return null;
  const o = unwrap((u as UnaryExpr).operand);
  return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
}

/**
 * The name the guard's first test checks for null: `!X` itself, the first operand of an
 * `||` chain led by `!X`, or `!(X && ...)`. With X null that test alone decides the guard,
 * and the tests after it run only with X not null. Null for any other condition.
 */
function nullTestedFirst(c: Expression): string | null {
  const whole = nullTested(c);
  if (whole) return whole;
  let u = unwrap(c);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '||') {
    while (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '||') u = unwrap((u as BinaryExpr).left);
    return nullTested(u);
  }
  if (u.kind !== NodeKind.UnaryExpr || (u as UnaryExpr).operator !== '!') return null;
  const inner = unwrap((u as UnaryExpr).operand);
  if (inner.kind !== NodeKind.BinaryExpr || (inner as BinaryExpr).operator !== '&&') return null;
  const first = leftmost(inner);
  return first.kind === NodeKind.Identifier ? (first as Identifier).name : null;
}

/** How many tests of the guard leave for its return: the operands of its `||` chain, or of `!(&&)`. */
function exitTests(c: Expression): number {
  let u = unwrap(c);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const inner = unwrap((u as UnaryExpr).operand);
    if (inner.kind === NodeKind.BinaryExpr && (inner as BinaryExpr).operator === '&&') return conjuncts(inner).length;
    return 1;
  }
  let n = 1;
  while (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '||') { n++; u = unwrap((u as BinaryExpr).left); }
  return n;
}

/** The leftmost test of an `&&` chain. */
function leftmost(c: Expression): Expression {
  let u = unwrap(c);
  while (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') u = unwrap((u as BinaryExpr).left);
  return u;
}

const COMPARE = new Set(['<', '<=', '>', '>=', '==', '!=']);

/** `c` with V in its leftmost comparison replaced by `(V = value)`; null when V is not an operand there. */
function foldInto(c: Expression, v: string, value: Expression): Expression | null {
  const u = unwrap(c);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') {
    const l = foldInto((u as BinaryExpr).left, v, value);
    return l ? Expr.binary(l, '&&', cloneNode((u as BinaryExpr).right)) : null;
  }
  if (u.kind !== NodeKind.BinaryExpr || !COMPARE.has((u as BinaryExpr).operator)) return null;
  const b = u as BinaryExpr;
  const set = Expr.paren(Expr.assign(Expr.identifier(v), cloneNode(value)));
  if (isName(b.left, v) && unwrap(b.left).kind === NodeKind.Identifier && !mentions(b.right, v)) {
    return Expr.binary(set, b.operator, cloneNode(b.right));
  }
  if (isName(b.right, v) && unwrap(b.right).kind === NodeKind.Identifier && !mentions(b.left, v)) {
    return Expr.binary(cloneNode(b.left), b.operator, set);
  }
  return null;
}

function rewriteFunction(fn: FunctionDecl, opts: RecordNullFoldOptions): FunctionDecl | undefined {
  if (!fn.body || !opts.branchLayout) return undefined;
  const gate = new Gate(opts.branchLayout);
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = 0;
  const visitBlock = (block: CompoundStmt): void => {
    for (const s of block.statements) visitAll(s);
    const st = block.statements;
    for (let i = 0; i + 3 < st.length; i++) {
      const g0 = returnGuard(st[i]);
      if (!g0) continue;
      const p = nullTested(g0.cond);
      if (!p) continue;
      const def = recordStore(st[i + 1]);
      if (!def || def.name === p) continue;
      const fv = unwrap(def.value);
      if (fv.kind !== NodeKind.MemberExpr || !(fv as MemberExpr).isArrow || !isName((fv as MemberExpr).object, p)
          || unwrap((fv as MemberExpr).object).kind !== NodeKind.Identifier || !pure(fv)) continue;
      const rec = recordStore(st[i + 2]);
      if (!rec || rec.name === p || rec.name === def.name) continue;
      const tern = unwrap(rec.value);
      if (tern.kind !== NodeKind.ConditionalExpr || !isZero((tern as ConditionalExpr).elseExpr)) continue;
      const test = (tern as ConditionalExpr).condition;
      if (!pure(test) || !pure((tern as ConditionalExpr).thenExpr) || mentions(tern, rec.name)) continue;
      const g3 = returnGuard(st[i + 3]);
      if (!g3 || nullTestedFirst(g3.cond) !== rec.name || !sameReturn(g0.ret, g3.ret)) continue;
      const rv = g0.ret.value;
      if (rv && (!pure(rv) || mentions(rv, p) || mentions(rv, def.name) || mentions(rv, rec.name))) continue;
      const lm = leftmost(test);
      if (lm.kind !== NodeKind.BinaryExpr || !mentions(lm, def.name)) continue;
      const folded = foldInto(test, def.name, fv);
      if (!folded) continue;
      // The original's one exit for the null test, the range tests and the record's null test.
      const rets: ReturnStmt[] = [g0.ret, g3.ret];
      // The select is the getter's split tests written back, placed on the store's line.
      // record-getter-guard writes the record's test `!X` new, with no line of its own: it
      // is the getter's last test, printed on the store's line (MISSILE_CltHitFn54_VinesTrail
      // 004d0ff0).
      const tests: ASTNode[] = [g0.cond, st[i + 2], placedLine(g3.cond) === null ? st[i + 2] : g3.cond];
      const lines = [placedLine(st[i]), placedLine(st[i + 2]), placedLine(st[i + 3])];
      const oneIf = lines.every(l => l !== null) && gate.oneCondition(lines as number[]);
      if (!oneIf && !gate.sharedExit(rets, tests, conjuncts(test).length + 1 + exitTests(g3.cond), true)) continue;
      if (!gate.copyAfterTests(rets, tests)) continue;
      const cond = Expr.binary(Expr.identifier(p), '&&', folded);
      const value = Expr.conditional(cond, cloneNode((tern as ConditionalExpr).thenExpr), cloneNode((tern as ConditionalExpr).elseExpr));
      let ns: Statement;
      if (rec.decl) {
        const d = cloneNode(st[i + 2]) as DeclStmt;
        (d.declarations[0] as VariableDecl).initializer = value;
        ns = d;
      } else {
        ns = Stmt.expr(Expr.assign(Expr.identifier(rec.name), value));
      }
      ns.location = st[i + 2].location;
      const repl: Statement[] = [];
      if (def.decl) {
        const d = cloneNode(st[i + 1]) as DeclStmt;
        (d.declarations[0] as VariableDecl).initializer = undefined;
        d.leadingTrivia = st[i].leadingTrivia;
        repl.push(d);
      } else ns.leadingTrivia = st[i].leadingTrivia;
      repl.push(ns);
      st.splice(i, 3, ...repl);
      changed++;
      opts.onSite?.({ line: lines[0] ?? 0, pointer: p, record: rec.name });
    }
  };
  const visitAll = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) { visitBlock(n as CompoundStmt); return; }
    for (const k of getChildren(n)) visitAll(k);
  };
  visitAll(body);
  if (!changed) return undefined;
  return updateNode(fn, { body } as Partial<FunctionDecl>);
}

export const recordNullFoldPlugin: TransformPlugin = {
  id: 'record-null-fold',
  name: 'Record Null Fold',
  description: 'A null test before a record lookup through the pointer goes into the lookup condition where the original leaves both through one exit',
  version: '1.0.0',
  defaultEnabled: true,
  // Right after record-getter-split (60.55) has written the lookup's select; before decl-order-fix (61).
  priority: 60.56,
  tags: ['matching'],
  createTransformer: (options: RecordNullFoldOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};

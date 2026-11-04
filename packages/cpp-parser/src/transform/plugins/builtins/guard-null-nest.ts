/**
 * Guard Null Nest Plugin
 *
 * A guard on a compound condition followed by a null test of a value set after it, both
 * returning the same constant (GetAiCmd, 0058ee80):
 *
 *     if (!(pUnit && pUnit->eUnitType == UNIT_MONSTER && pUnit->pUnitData.pUnitDataMonster)) {
 *       return nullptr;
 *     }
 *     D2AiGeneralStrc* pAiGeneral = pUnit->pUnitData.pUnitDataMonster->pAiGeneral;
 *     if (!pAiGeneral) {
 *       return nullptr;
 *     }
 *
 * The original's tests all jump forward into one copy of the return, inline after the last
 * test (`test eax, eax; jne body; xor eax, eax; ret`). That is VC8 threading a known value:
 * the source set the tested variable to null on the failing path and tested it once,
 * the usual shape of an inlined record getter (`p = c ? &tbl[i] : nullptr; if (!p) ...`).
 * Written as two guards, the first one's `||`-shaped test sends the shared copy to the end.
 * This writes the source shape back:
 *
 *     D2AiGeneralStrc* pAiGeneral = nullptr;
 *     if (pUnit && pUnit->eUnitType == UNIT_MONSTER && pUnit->pUnitData.pUnitDataMonster) {
 *       pAiGeneral = pUnit->pUnitData.pUnitDataMonster->pAiGeneral;
 *     }
 *     if (!pAiGeneral) {
 *       return nullptr;
 *     }
 *
 * Checked with the oracle's compiler: GetAiCmd, MONSTERAI_HasSkillInSlots (005dd2d0) and
 * GetSomeMonsterStatFlag (0046c140, a range test and a nested record getter) match byte for
 * byte.
 *
 * Shape, in one block: `if (G) return K;`, then statements S... that run straight through
 * (no return, goto, break, continue, label or case, nothing that never returns), the last
 * of them `T p = E;` or `p = E;`, then `if (!p) return K;` (or `p == 0`/`p == nullptr`), K the
 * same constant. G is not itself a null test of a variable (that chain is branch-layout's
 * `propagate`, which the original's jumps decide). p is a pointer or a built-in integer local
 * whose address is not taken. Three conditions keep the rule to the getter shape (swept over
 * every TU: without them 8 gains against 13 losses):
 *   - G short-circuits or holds a ternary: the guard whose copy VC8 sends to the end;
 *   - E calls nothing: a call result the original tested on its own (NPCMENU_CanItemBeRepaired,
 *     CorpseConsumedCheck keep their guards);
 *   - after the null test no other `return K` but the block's last statement and further null
 *     tests, and no switch: another way into K places the copy itself (TXT_ItemTypes_GetClass,
 *     GetAiArgument).
 *
 * Value-preserving: when G holds the original returns K; now p keeps the null it was set to
 * and `!p` returns K. Otherwise S... and E run as before. Names S... declares stay inside the
 * new block, so none may be named after it.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl, Identifier, IfStmt,
  ParameterDecl, ParenExpr, ReturnStmt, Statement, TypeNode, UnaryExpr, VariableDecl, BinaryExpr, CStyleCastExpr,
} from '../../../ast/nodes.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { negate } from './branch-layout/index.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './goto-cleanup/types.js';

export interface GuardNullNestOptions extends PluginOptions {
  noreturnFunctions?: string[];
  /** One rewrite per function (no chaining onto the test a rewrite made). */
  once?: boolean;
  onSite?: (e: { function: string; name: string; line: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isConstant(e: Expression | null): boolean {
  if (!e) return false;
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') return isConstant((u as UnaryExpr).operand);
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.BoolLiteral || u.kind === NodeKind.CharLiteral
    || u.kind === NodeKind.NullptrLiteral || u.kind === NodeKind.QualifiedId
    || (u.kind === NodeKind.Identifier && /^([A-Z][A-Z0-9_]*|nullptr|true|false)$/.test((u as Identifier).name));
}

/** The constant `return K` an if without else consists of. */
function guardReturn(s: Statement): ReturnStmt | null {
  if (s.kind !== NodeKind.IfStmt) return null;
  const i = s as IfStmt;
  if (i.elseBranch || i.init || i.isConstexpr) return null;
  let t = i.thenBranch;
  if (t.kind === NodeKind.CompoundStmt) {
    const l = (t as CompoundStmt).statements;
    if (l.length !== 1) return null;
    t = l[0];
  }
  if (t.kind !== NodeKind.ReturnStmt) return null;
  return isConstant((t as ReturnStmt).value) ? t as ReturnStmt : null;
}

const key = (r: ReturnStmt) => emit(r.value as unknown as AnyNode).replace(/\s+/g, '');

function isZero(e: Expression): boolean {
  let u = unwrap(e);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrap((u as CStyleCastExpr).expression);
  if (u.kind === NodeKind.NullptrLiteral) return true;
  return u.kind === NodeKind.IntegerLiteral && BigInt((u as unknown as { value: bigint | number }).value) === 0n;
}

/** The variable `!x` / `x == 0` / `x == nullptr` tests for null. */
function nullTested(cond: Expression): string | null {
  const u = unwrap(cond);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    const o = unwrap((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '==') {
    const b = u as BinaryExpr;
    for (const [x, k] of [[b.left, b.right], [b.right, b.left]] as const) {
      const ux = unwrap(x);
      if (ux.kind === NodeKind.Identifier && isZero(k)) return (ux as Identifier).name;
    }
  }
  return null;
}

/** `T p = E;` or `p = E;`. */
function definition(s: Statement): { name: string; value: Expression; decl: VariableDecl | null } | null {
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return null;
    const v = d[0] as VariableDecl;
    if (!v.initializer || v.initializer.kind === NodeKind.InitListExpr || v.directInit || v.copyListInit || v.specifiers.length > 0) return null;
    return { name: v.name.name, value: v.initializer as Expression, decl: v };
  }
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const l = unwrap((e as AssignExpr).left);
  return l.kind === NodeKind.Identifier ? { name: (l as Identifier).name, value: (e as AssignExpr).right, decl: null } : null;
}

function calledName(n: ASTNode): string | null {
  if (n.kind !== NodeKind.CallExpr) return null;
  const c = (n as unknown as { callee: Expression }).callee;
  const t = emit(c as unknown as AnyNode).trim();
  return t.split('::').pop() ?? null;
}

/** Runs straight through: nothing in it leaves or is jumped to. */
function straight(s: Statement, noreturn: ReadonlySet<string>): boolean {
  for (const n of traverseAST(s)) {
    switch (n.kind) {
      case NodeKind.ReturnStmt: case NodeKind.GotoStmt: case NodeKind.BreakStmt: case NodeKind.ContinueStmt:
      case NodeKind.LabelStmt: case NodeKind.CaseStmt: case NodeKind.DefaultStmt: case NodeKind.ThrowExpr:
        return false;
      default: {
        const c = calledName(n);
        if (c && noreturn.has(c)) return false;
      }
    }
  }
  return true;
}

/** Whether `n` reads a variable of `set` (a member named like one, `q->p`, is not a read). */
function reads(n: ASTNode, set: ReadonlySet<string>): boolean {
  const members = new Set<ASTNode>();
  for (const m of traverseAST(n)) if (m.kind === NodeKind.MemberExpr) members.add((m as unknown as { member: ASTNode }).member);
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && !members.has(m) && set.has((m as Identifier).name)) return true;
  return false;
}

function names(n: ASTNode, set: ReadonlySet<string>): boolean {
  for (const m of traverseAST(n)) if (m.kind === NodeKind.Identifier && set.has((m as Identifier).name)) return true;
  return false;
}

interface Facts { types: Map<string, TypeNode>; addressed: Set<string> }

function factsOf(fn: FunctionDecl, body: CompoundStmt): Facts {
  const types = new Map<string, TypeNode>();
  const dup = new Set<string>();
  const add = (n: string, t: TypeNode) => { if (types.has(n)) dup.add(n); types.set(n, t); };
  for (const p of fn.parameters as ParameterDecl[]) if (p.name) add(p.name.name, p.type);
  const addressed = new Set<string>();
  for (const n of traverseAST(body)) {
    if (n.kind === NodeKind.VariableDecl) add((n as VariableDecl).name.name, (n as VariableDecl).type);
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      for (const m of traverseAST((n as UnaryExpr).operand)) if (m.kind === NodeKind.Identifier) addressed.add((m as Identifier).name);
    }
  }
  for (const d of dup) types.delete(d);
  return { types, addressed };
}

const INTEGERS = /^(int|unsigned|signed|short|long|char|bool|BOOL|DWORD|WORD|BYTE|UINT|INT|LONG|ULONG|u?int(8|16|32)_t)\b/;

/** The null of p's type: nullptr for a pointer, 0 for a built-in or typedef'd integer. */
function nullOf(t: TypeNode | undefined): Expression | null {
  if (!t) return null;
  if (t.kind === NodeKind.PointerType) return Expr.nullptr();
  if (t.kind === NodeKind.BuiltinType) return Expr.intLiteral(0);
  if (t.kind === NodeKind.TypedefType && INTEGERS.test(emit(t as unknown as AnyNode).trim())) return Expr.intLiteral(0);
  return null;
}

function branches(e: Expression): boolean {
  for (const n of traverseAST(e)) {
    if (n.kind === NodeKind.ConditionalExpr) return true;
    if (n.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((n as BinaryExpr).operator)) return true;
  }
  return false;
}

/** A `return K` after the guard at `j`, other than the block's last statement or a null-test guard's. */
function otherCopies(l: readonly Statement[], j: number, k: string): boolean {
  const allowed = new Set<ASTNode>();
  const last = l[l.length - 1];
  if (last.kind === NodeKind.ReturnStmt) allowed.add(last);
  for (const s of l.slice(j + 1)) {
    const r = guardReturn(s);
    if (r && nullTested((s as IfStmt).condition)) allowed.add(r);
  }
  for (const s of l.slice(j + 1)) {
    for (const n of traverseAST(s)) {
      // A switch's unmatched value runs into the final return, which then is a copy of its
      // own that the guards jump to (GetAiArgument, 0058ec50).
      if (n.kind === NodeKind.SwitchStmt) return true;
      if (n.kind !== NodeKind.ReturnStmt || allowed.has(n)) continue;
      const v = (n as ReturnStmt).value;
      if (v && emit(v as unknown as AnyNode).replace(/\s+/g, '') === k) return true;
    }
  }
  return false;
}

function rewriteBlock(block: CompoundStmt, facts: Facts, noreturn: ReadonlySet<string>): { name: string; line: number } | null {
  const l = block.statements;
  for (let i = 0; i < l.length; i++) {
    const r1 = guardReturn(l[i]);
    if (!r1) continue;
    const g = l[i] as IfStmt;
    // A null test of a variable heads branch-layout's own propagate chain.
    if (nullTested(g.condition)) continue;
    // Only a guard VC8 lays out with its copy at the end: a short-circuit or a ternary test.
    if (!branches(g.condition)) continue;
    for (let j = i + 2; j < l.length; j++) {
      const r2 = guardReturn(l[j]);
      if (!r2) { if (!straight(l[j], noreturn)) break; continue; }
      if (key(r2) !== key(r1)) break;
      const p = nullTested((l[j] as IfStmt).condition);
      const def = definition(l[j - 1]);
      if (!p || !def || def.name !== p) break;
      const s = l.slice(i + 1, j);
      if (!s.every(x => straight(x, noreturn))) break;
      if (facts.addressed.has(p) || names(g.condition, new Set([p]))) break;
      // p is null from the head on: nothing before its new value may read the old one.
      if (reads(def.value, new Set([p])) || s.slice(0, -1).some(x => reads(x, new Set([p])))) break;
      const nul = nullOf(def.decl ? def.decl.type : facts.types.get(p));
      if (!nul) break;
      // E reads, it calls nothing: the inlined record getter (a call result is tested on its own).
      if ([...traverseAST(def.value)].some(x => x.kind === NodeKind.CallExpr)) break;
      // No other copy of K after the test, but the block's last return and further null tests
      // of a variable: another guard of K (a range test, a switch default) places the copy itself.
      if (otherCopies(l, j, key(r1))) break;
      // Names S... declares (p aside) must not be named after the new block.
      const declared = new Set<string>();
      for (const x of s.slice(0, -1)) {
        if (x.kind !== NodeKind.DeclStmt) continue;
        for (const d of (x as DeclStmt).declarations) {
          if (d.kind === NodeKind.VariableDecl) declared.add((d as VariableDecl).name.name); else declared.add('\0');
        }
      }
      if (declared.has('\0') || l.slice(j).some(x => names(x, declared))) break;
      const head: Statement = def.decl
        ? { ...(l[j - 1] as DeclStmt), declarations: [{ ...def.decl, initializer: nul }] } as DeclStmt
        : Stmt.expr(Expr.assign(Expr.identifier(p), nul));
      const set = Stmt.expr(Expr.assign(Expr.identifier(p), cloneNode(def.value)));
      const inner = Stmt.compound([...s.slice(0, -1).map(x => cloneNode(x)), set]);
      const nest = Stmt.if_(negate(g.condition), inner, null);
      l.splice(i, j - i, head, nest);
      return { name: p, line: g.location?.start.line ?? 0 };
    }
  }
  return null;
}

function rewriteFunction(fn: FunctionDecl, opts: GuardNullNestOptions): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...(opts.noreturnFunctions ?? [])]);
  const fname = (fn as unknown as { name?: { name?: string } }).name?.name ?? '';
  const body = cloneNode(fn.body) as CompoundStmt;
  let changed = false;
  for (let round = 0; round < 16; round++) {
    const facts = factsOf(fn, body);
    let hit: { name: string; line: number } | null = null;
    for (const n of traverseAST(body)) {
      if (n.kind !== NodeKind.CompoundStmt) continue;
      hit = rewriteBlock(n as CompoundStmt, facts, noreturn);
      if (hit) break;
    }
    if (!hit) break;
    changed = true;
    opts.onSite?.({ function: fname, ...hit });
    if (opts.once) break;
  }
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

export const guardNullNestPlugin: TransformPlugin = {
  id: 'guard-null-nest',
  name: 'Guard Null Nest',
  description: 'A compound guard and a later null test returning the same constant become one null-initialised test',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 989.97,
  tags: ['matching'],
  createTransformer: (options: GuardNullNestOptions = {}): Transformer => createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, options);
    },
  }),
};

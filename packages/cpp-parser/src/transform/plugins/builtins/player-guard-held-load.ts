/**
 * Player Guard Held Load Plugin
 *
 * The D2Common player-data setters open with a player guard and a halting null check of the
 * player data:
 *
 *     if (!(pUnit && pUnit->eUnitType == UNIT_PLAYER)) return;
 *     pPlayerData = pUnit->pUnitData.pUnitDataPlayer;
 *     if (!pPlayerData) { ERROR_UnrecoverableInternalError_Halt(...); exit(-1); }
 *
 * The original loads the unit type into a register and tests that (InitRightSkill 00622ea0):
 *
 *     mov ecx, dword ptr [eax] ; test ecx, ecx ; jne leave
 *
 * where VC8 compiles a plain field read to `cmp dword ptr [eax], 0`. No getter, local,
 * switch or inline form makes VC8 keep the load apart from the compare; a volatile read does,
 * and with it InitRightSkill, InitLeftSkill, InitSwitchRightSkill and InitSwitchLeftSkill
 * compile to the original bytes. This pass writes the type read of such a guard as
 * `D2_HELD_LOAD(eD2UnitType, pUnit->eUnitType)` (HELD_LOAD_SUPPORT_LINES): a volatile read under
 * VC8, the plain read elsewhere. The value is the same either way.
 *
 * Gated on the whole shape, not on the guard alone: a player guard without the halting
 * null check compiles to the memory compare in the original as well (PLRMODES_StartModeID
 * 00580a70 matches that way and loses with the held load). Shapes, with P a plain name:
 *
 *   if (!(P && P->eUnitType == UNIT_PLAYER)) return;   followed by the load and the check
 *   if (!P || P->eUnitType != UNIT_PLAYER) return;      followed by the load and the check
 *   if (P && P->eUnitType == UNIT_PLAYER) { load; check; ... }
 *
 * where the load is `[T* ]X = P->pUnitData.pUnitDataPlayer;` and the check is `if (!X) { ...;
 * exit(-1); }`, with or without an else.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl, Identifier,
  IfStmt, MemberExpr, ParenExpr, ReturnStmt, Statement, UnaryExpr, VariableDecl, AssignExpr,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export const HELD_LOAD = 'D2_HELD_LOAD';

/** The macro's text; the platform header includes it verbatim. */
export const HELD_LOAD_SUPPORT_LINES: readonly string[] = [
  '// `D2_HELD_LOAD(T, lv)`: the original loads lv into a register and tests the register where',
  '// VC8 would fold a plain read into a memory compare (player-guard-held-load.ts). A volatile',
  '// read keeps the load apart under VC8; other compilers read lv as it is. Same value.',
  '#ifdef _MSC_VER',
  `#  define ${HELD_LOAD}(T, lv) (*(volatile T*)&(lv))`,
  '#else',
  `#  define ${HELD_LOAD}(T, lv) (lv)`,
  '#endif',
];

export interface PlayerGuardHeldLoadOptions extends PluginOptions {
  /** Called once per rewritten guard, with the guarded name. */
  onSite?: (site: { name: string }) => void;
}

const strip = (e: Expression): Expression => {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
};
const isName = (e: Expression, name?: string): e is Identifier =>
  e.kind === NodeKind.Identifier && (name === undefined || (e as Identifier).name === name);
const memberName = (m: MemberExpr): string | undefined =>
  m.member.kind === NodeKind.Identifier ? (m.member as Identifier).name : undefined;

/** `P->eUnitType <op> UNIT_PLAYER` with P the given name: the member expression, else undefined. */
function typeTest(e: Expression, name: string, op: '==' | '!='): MemberExpr | undefined {
  e = strip(e);
  if (e.kind !== NodeKind.BinaryExpr) return undefined;
  const b = e as BinaryExpr;
  if (b.operator !== op || !isName(strip(b.right), 'UNIT_PLAYER')) return undefined;
  const l = strip(b.left);
  if (l.kind !== NodeKind.MemberExpr) return undefined;
  const m = l as MemberExpr;
  if (!m.isArrow || memberName(m) !== 'eUnitType' || !isName(strip(m.object), name)) return undefined;
  return m;
}

/** `P && P->eUnitType == UNIT_PLAYER`: P and the type member. */
function playerGuard(e: Expression): { name: string; member: MemberExpr } | undefined {
  e = strip(e);
  if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '&&') return undefined;
  const b = e as BinaryExpr;
  const p = strip(b.left);
  if (!isName(p)) return undefined;
  const member = typeTest(b.right, p.name, '==');
  return member ? { name: p.name, member } : undefined;
}

/** The negation of a player guard: `!(P && P->eUnitType == UNIT_PLAYER)` or `!P || P->eUnitType != UNIT_PLAYER`. */
function notPlayerGuard(e: Expression): { name: string; member: MemberExpr } | undefined {
  e = strip(e);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!') return playerGuard((e as UnaryExpr).operand);
  if (e.kind !== NodeKind.BinaryExpr || (e as BinaryExpr).operator !== '||') return undefined;
  const b = e as BinaryExpr;
  const l = strip(b.left);
  if (l.kind !== NodeKind.UnaryExpr || (l as UnaryExpr).operator !== '!') return undefined;
  const p = strip((l as UnaryExpr).operand);
  if (!isName(p)) return undefined;
  const member = typeTest(b.right, p.name, '!=');
  return member ? { name: p.name, member } : undefined;
}

const bodyOf = (s: Statement): Statement[] =>
  s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s];

/** `return;` alone (in braces or not). */
const isBareReturn = (s: Statement): boolean => {
  const b = bodyOf(s);
  return b.length === 1 && b[0].kind === NodeKind.ReturnStmt && (b[0] as ReturnStmt).value === null;
};

/** `[T* ]X = P->pUnitData.pUnitDataPlayer;`: X, else undefined. */
function playerDataLoad(s: Statement | undefined, name: string): string | undefined {
  if (!s) return undefined;
  const isLoad = (e: Expression | null | undefined): boolean => {
    if (!e) return false;
    e = strip(e);
    if (e.kind !== NodeKind.MemberExpr) return false;
    const m = e as MemberExpr;
    if (m.isArrow || memberName(m) !== 'pUnitDataPlayer') return false;
    const o = strip(m.object);
    if (o.kind !== NodeKind.MemberExpr) return false;
    const u = o as MemberExpr;
    return u.isArrow && memberName(u) === 'pUnitData' && isName(strip(u.object), name);
  };
  if (s.kind === NodeKind.DeclStmt) {
    const d = (s as DeclStmt).declarations;
    if (d.length !== 1 || d[0].kind !== NodeKind.VariableDecl) return undefined;
    const v = d[0] as VariableDecl;
    return v.initializer && v.initializer.kind !== NodeKind.InitListExpr && isLoad(v.initializer as Expression)
      ? v.name.name : undefined;
  }
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = strip((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return undefined;
  const a = e as AssignExpr;
  return a.operator === '=' && isName(strip(a.left)) && isLoad(a.right) ? (strip(a.left) as Identifier).name : undefined;
}

/** `if (!X) { ...; exit(-1); }`, with or without an else (the arm never falls through). */
function haltingNullCheck(s: Statement | undefined, x: string): boolean {
  if (!s || s.kind !== NodeKind.IfStmt) return false;
  const i = s as IfStmt;
  if (i.init) return false;
  const c = strip(i.condition);
  if (c.kind !== NodeKind.UnaryExpr || (c as UnaryExpr).operator !== '!' || !isName(strip((c as UnaryExpr).operand), x)) return false;
  const b = bodyOf(i.thenBranch);
  const last = b[b.length - 1];
  if (!last || last.kind !== NodeKind.ExprStmt) return false;
  const call = strip((last as ExprStmt).expression);
  return call.kind === NodeKind.CallExpr && isName(strip((call as CallExpr).callee), 'exit');
}

function heldLoad(m: MemberExpr): CallExpr {
  return Expr.call(HELD_LOAD, [Expr.identifier('eD2UnitType'), m]);
}

/** Replace each `P->eUnitType` inside `e` (the guard names it once). */
function replaceIn(e: Expression, name: string): Expression {
  const t = createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.MemberExpr) return undefined;
      const m = n as MemberExpr;
      return m.isArrow && memberName(m) === 'eUnitType' && isName(strip(m.object), name) ? heldLoad(m) : undefined;
    },
  });
  return t(e) as Expression;
}

function createPlayerGuardHeldLoadTransformer(options: PlayerGuardHeldLoadOptions = {}): Transformer {
  const rewriteList = (stmts: Statement[]): Statement[] | undefined => {
    let changed = false;
    const out = stmts.map((s, k) => {
      if (s.kind !== NodeKind.IfStmt) return s;
      const i = s as IfStmt;
      if (i.init) return s;
      let hit: { name: string; member: MemberExpr } | undefined;
      const neg = notPlayerGuard(i.condition);
      if (neg && !i.elseBranch && isBareReturn(i.thenBranch)) {
        const x = playerDataLoad(stmts[k + 1], neg.name);
        if (x && haltingNullCheck(stmts[k + 2], x)) hit = neg;
      }
      const pos = hit ? undefined : playerGuard(i.condition);
      if (pos) {
        const b = bodyOf(i.thenBranch);
        const x = playerDataLoad(b[0], pos.name);
        if (x && haltingNullCheck(b[1], x)) hit = pos;
      }
      if (!hit) return s;
      changed = true;
      options.onSite?.({ name: hit.name });
      return updateNode(i, { condition: replaceIn(i.condition, hit.name) } as Partial<IfStmt>);
    });
    return changed ? out : undefined;
  };
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      let changed = false;
      // Bottom-up: each block's statements are final when the block is visited.
      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.CompoundStmt) return undefined;
          const c = n as CompoundStmt;
          const out = rewriteList(c.statements);
          if (!out) return undefined;
          changed = true;
          return updateNode(c, { statements: out } as Partial<CompoundStmt>);
        },
      });
      const body = sub(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const playerGuardHeldLoadPlugin: TransformPlugin = {
  id: 'player-guard-held-load',
  name: 'Player Guard Held Load',
  description: 'The unit-type read of a player guard before a halting player-data check, held in a register as the original does',
  version: '1.0.0',
  defaultEnabled: true,
  // Late, after names and casts are final, beside the other VC8 form passes.
  priority: 989.5,
  tags: ['game', 'diablo', 'matching'],
  createTransformer: createPlayerGuardHeldLoadTransformer,
};

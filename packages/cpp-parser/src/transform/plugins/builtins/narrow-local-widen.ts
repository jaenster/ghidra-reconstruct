/**
 * Narrow Local Widen Plugin
 *
 * Ghidra types a local by the width it was loaded at: `MOVSX EAX, word ptr [ESI+0x2e]`
 * gives a two-byte variable even where every later use reads the 32-bit register. Declared
 * `short`, VC8 loads it with MOVZX and compares the word (`CMP AX,0x43`); the original's int
 * local was compared as the register (`CMP EAX,0x43`). PLRSKILLS_CheckSkillWhipAndLeap
 * (004d8520) matches once `short sSrvDoFunc = pSkillsTxt->srvdofunc;` declares an int.
 *
 * `compare-form` records the width of the CMP behind every comparison it ties to its
 * instructions (`compareWidth`). A local declared one or two bytes wide that the original
 * compares at four bytes against a constant held an int there, and is declared `int32_t`.
 * VC8 compares a narrow local at its own width (`CMP AL,K`, `CMP AX,K`), so a four-byte
 * compare of the same local with a constant comes from a wider declaration.
 *
 * The value never changes. A local is widened only when
 *  - every comparison of it that is tied to its instructions compares four bytes - one that
 *    compares at its own width shows the source kept it narrow there - and at least one of
 *    them compares it with a constant or with another one- or two-byte value (VC8 compares
 *    two narrow values at their width: CLIENT_UpdateUnitLightRadius 00460930 compares a byte
 *    local with a byte field as `CMP EAX,ECX`);
 *  - every value assigned to it, its initialiser included, already fits its type: a field,
 *    a call or a cast of its type or a narrower one, a literal in its range, a mask with a
 *    constant in its range - so the wider local holds what the narrow one held;
 *  - nothing modifies it in place (`++`, `--`, `op=`) and nothing takes its address;
 *  - it is declared alone, not static, in this function only.
 * Every other read promotes a narrow value to int anyway, so no expression changes value.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CharLiteralExpr, ConditionalExpr, DeclStmt, Expression, FunctionDecl, Identifier,
  IntegerLiteralExpr, PostfixExpr, TypedefType, TypeNode, UnaryExpr, VariableDecl, CStyleCastExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Expr } from '../../../ast/factory.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { shapeOfNode, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { localTypesOf } from './compare-form.js';

export interface NarrowLocalWidenOptions extends PluginOptions {
  enumTypes?: string[];
  /** Every enum constant name: a constant operand, like a literal. */
  enumConstantNames?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const COMPARISON = new Set(['<', '<=', '>', '>=', '==', '!=']);

/** Canonical integer bases (`call-arg-cast`'s spelling) by width and signedness. */
const INTEGERS: Record<string, { width: number; unsigned: boolean }> = {
  'char': { width: 1, unsigned: false },
  'signed char': { width: 1, unsigned: false },
  'unsigned char': { width: 1, unsigned: true },
  'short': { width: 2, unsigned: false },
  'unsigned short': { width: 2, unsigned: true },
  'int': { width: 4, unsigned: false },
  'unsigned int': { width: 4, unsigned: true },
  'long': { width: 4, unsigned: false },
  'unsigned long': { width: 4, unsigned: true },
};

interface IntType { width: number; unsigned: boolean }

const range = (t: IntType): [bigint, bigint] => {
  const bits = BigInt(8 * t.width);
  return t.unsigned ? [0n, (1n << bits) - 1n] : [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
};

/** Whether every value of `from` is a value of `to`. */
function within(from: IntType, to: IntType): boolean {
  const [a, b] = range(from), [c, d] = range(to);
  return a >= c && b <= d;
}

/** A literal's value: `5`, `'\x02'`, `-1`; null otherwise. */
function constantValue(e: Expression): bigint | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.IntegerLiteral) return (u as IntegerLiteralExpr).value;
  if (u.kind === NodeKind.CharLiteral) return BigInt((u as CharLiteralExpr).value);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') {
    const inner = constantValue((u as UnaryExpr).operand);
    return inner === null ? null : -inner;
  }
  return null;
}

/** The identifier `x` stands for, through parentheses and casts; null for anything else. */
function nameOf(x: Expression): string | null {
  let u = unwrapParens(x);
  while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
  return u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
}

export function createNarrowLocalWidenTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as NarrowLocalWidenOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const enumConstants = new Set(o.enumConstantNames ?? []);
  const resolve: TypedefResolver = name => typedefTargets[name];
  const intOf = (t: TypeNode): IntType | null => {
    const s = shapeOfNode(t, 0, resolve);
    return s && s.stars === 0 ? INTEGERS[s.base] ?? null : null;
  };

  /** Whether `e`, assigned to a local of type `to`, is a value `to` holds unchanged. */
  const fits = (e: Expression, to: IntType, shapeOf: ExprShape): boolean => {
    const u = unwrapParens(e);
    const k = constantValue(u);
    if (k !== null) {
      const [lo, hi] = range(to);
      return k >= lo && k <= hi;
    }
    if (u.kind === NodeKind.ConditionalExpr) {
      const c = u as ConditionalExpr;
      return fits(c.thenExpr, to, shapeOf) && fits(c.elseExpr, to, shapeOf);
    }
    if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&') {
      // A mask with a constant in range: the result lies in 0..K whatever is masked.
      const b = u as BinaryExpr;
      const m = constantValue(b.right) ?? constantValue(b.left);
      if (m !== null && m >= 0n && m <= range(to)[1]) return true;
    }
    const s = shapeOf(u);
    if (!s || s.stars !== 0) return false;
    const from = INTEGERS[s.base];
    return !!from && from.width <= to.width && within(from, to);
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const body = node.body;
      const params = new Set(node.parameters.map(p => p.name?.name).filter((n): n is string => !!n));

      // Candidates: one narrow integer local per name, declared alone and not static.
      const declCount = new Map<string, number>();
      for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
        const n = (d as VariableDecl).name.name;
        declCount.set(n, (declCount.get(n) ?? 0) + 1);
      }
      const candidates = new Map<string, { decl: VariableDecl; type: IntType }>();
      for (const ds of findNodesByKind(body, NodeKind.DeclStmt)) {
        const decls = (ds as DeclStmt).declarations;
        if (decls.length !== 1 || decls[0].kind !== NodeKind.VariableDecl) continue;
        const v = decls[0] as VariableDecl;
        const name = v.name.name;
        if (params.has(name) || declCount.get(name) !== 1 || v.specifiers.includes('static') || v.bitWidth) continue;
        const t = intOf(v.type);
        if (!t || t.width > 2) continue;
        candidates.set(name, { decl: v, type: t });
      }
      if (candidates.size === 0) return undefined;

      const shapeOf = createExprShape(localTypesOf(node), {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const evidence = new Set<string>();
      const vetoed = new Set<string>();
      const comparedNarrow = new Set<string>();
      const isConstant = (x: Expression) => {
        if (constantValue(x) !== null) return true;
        const n = nameOf(x);
        return !!n && enumConstants.has(n) && !candidates.has(n);
      };

      // An operand one or two bytes wide below its casts: VC8 compares two narrow values at
      // their own width (`CMP AL,DL`), so a four-byte compare had a wider local on this side.
      const isNarrow = (x: Expression): boolean => {
        let u = unwrapParens(x);
        while (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
        const n = u.kind === NodeKind.Identifier ? (u as Identifier).name : null;
        if (n && candidates.has(n)) return false;
        const s = shapeOf(u);
        const t = s && s.stars === 0 ? INTEGERS[s.base] : undefined;
        return !!t && t.width <= 2;
      };
      for (const be of findNodesByKind(body, NodeKind.BinaryExpr) as BinaryExpr[]) {
        if (!COMPARISON.has(be.operator)) continue;
        const width = be.ghidraInfo?.compareWidth;
        if (width === undefined) continue;
        for (const [side, other] of [[be.left, be.right], [be.right, be.left]] as const) {
          const n = nameOf(side);
          if (!n || !candidates.has(n)) continue;
          if (width < 4) { vetoed.add(n); comparedNarrow.add(n); }
          else if (isConstant(other) || isNarrow(other)) evidence.add(n);
        }
      }
      for (const a of findNodesByKind(body, NodeKind.AssignExpr) as AssignExpr[]) {
        const n = a.left.kind === NodeKind.Identifier ? (a.left as Identifier).name : null;
        if (!n || !candidates.has(n)) continue;
        if (a.operator !== '=' || !fits(a.right, candidates.get(n)!.type, shapeOf)) vetoed.add(n);
      }
      for (const u of findNodesByKind(body, NodeKind.UnaryExpr) as UnaryExpr[]) {
        if (u.operator !== '++' && u.operator !== '--' && u.operator !== '&') continue;
        const n = nameOf(u.operand);
        if (n) vetoed.add(n);
      }
      for (const p of findNodesByKind(body, NodeKind.PostfixExpr) as PostfixExpr[]) {
        const n = nameOf(p.operand);
        if (n) vetoed.add(n);
      }
      for (const [n, c] of candidates) {
        const init = c.decl.initializer;
        if (init && (init.kind === NodeKind.InitListExpr || !fits(init as Expression, c.type, shapeOf))) vetoed.add(n);
      }

      const widen = [...evidence].filter(n => !vetoed.has(n));
      const whole = loadedWhole(body, candidates, new Set(widen), shapeOf, isConstant);
      const computed = computedWhole(body, candidates, new Set([...widen, ...whole.keys()]), comparedNarrow, shapeOf, params);
      if (widen.length === 0 && whole.size === 0 && computed.size === 0) return undefined;
      const targets = new Set([...widen, ...whole.keys(), ...computed.keys()]);
      const inner = createTransformer({
        visitVariableDecl(v: VariableDecl): ASTNode | undefined {
          // The name is declared once in this function (a candidate's condition).
          if (!targets.has(v.name.name)) return undefined;
          const int32: TypedefType = {
            kind: NodeKind.TypedefType,
            name: { ...Expr.identifier('int32_t'), location: v.type.location, leadingTrivia: [], trailingTrivia: [] },
            location: v.type.location, leadingTrivia: v.type.leadingTrivia, trailingTrivia: v.type.trailingTrivia,
          } as TypedefType;
          return updateNode(v, { type: int32 } as Partial<VariableDecl>);
        },
      });
      // The casts and compares are found by identity in the body as it was read.
      let narrowed = whole.size > 0 ? narrowAtCompares(body, whole) as typeof body : body;
      if (computed.size > 0) narrowed = dropValueCasts(narrowed, computed) as typeof body;
      return updateNode(node, { body: inner(narrowed) } as Partial<FunctionDecl>);
    },
  });
}

/** One local `loadedWhole` widens: its narrow type, the casts to drop, the compares to narrow. */
interface LoadedWhole { type: TypeNode; casts: Set<ASTNode>; compared: Set<ASTNode> }

/**
 * The narrow locals the original loaded whole and compared narrow (the five quest callbacks
 * `*_Callback02_NpcDeactivate`, e.g. Q33 00588f80): `short n = !p ? -1 : (short)p->nClassId;
 * if (n != 0x201)` for `MOV EAX,[EAX+4] .. CMP AX,0x201`. The int field is loaded as a
 * dword, so the source's local was an int and the compare narrowed it; declared `short`, VC8
 * loads the word (`MOVZX EAX,word ptr`). Such a local is declared int, the narrowing casts on
 * its values go, and each compare narrows it again: `(short)n != 0x201`. The same values
 * compare: `(short)n` is what the narrow local held.
 *
 * Taken only where every value stored to it is a constant in its range or a cast to its
 * width of a four-byte integer field (through a conditional's arms), at least one is such a cast,
 * and every other mention is one side of a comparison with a constant that the instructions
 * make at its own width.
 */
function loadedWhole(
  body: ASTNode,
  candidates: ReadonlyMap<string, { decl: VariableDecl; type: IntType }>,
  taken: ReadonlySet<string>,
  shapeOf: ExprShape,
  isConstant: (x: Expression) => boolean,
): Map<string, LoadedWhole> {
  const out = new Map<string, LoadedWhole>();
  for (const [name, c] of candidates) {
    if (taken.has(name) || c.decl.specifiers.includes('static')) continue;
    const casts = new Set<ASTNode>();
    let ok = true;
    const value = (e: Expression): void => {
      const u = unwrapParens(e);
      const k = constantValue(u);
      if (k !== null) {
        const [lo, hi] = range(c.type);
        if (k < lo || k > hi) ok = false;
        return;
      }
      if (u.kind === NodeKind.ConditionalExpr) {
        value((u as ConditionalExpr).thenExpr);
        value((u as ConditionalExpr).elseExpr);
        return;
      }
      if (u.kind === NodeKind.CStyleCastExpr) {
        const to = shapeOf(u);
        const operand = unwrapParens((u as CStyleCastExpr).expression);
        const from = shapeOf(operand);
        const t = to && to.stars === 0 ? INTEGERS[to.base] : undefined;
        const f = from && from.stars === 0 ? INTEGERS[from.base] : undefined;
        // A field: the load is the dword the instructions read whole.
        if (t && f && t.width === c.type.width && f.width === 4 && operand.kind === NodeKind.MemberExpr) { casts.add(u); return; }
      }
      ok = false;
    };
    if (c.decl.initializer) {
      if (c.decl.initializer.kind === NodeKind.InitListExpr) continue;
      value(c.decl.initializer as Expression);
    }
    const compared = new Set<ASTNode>();
    const allowed = new Set<ASTNode>([c.decl.name]);
    for (const a of findNodesByKind(body, NodeKind.AssignExpr) as AssignExpr[]) {
      if (a.left.kind !== NodeKind.Identifier || (a.left as Identifier).name !== name) continue;
      if (a.operator !== '=') { ok = false; break; }
      allowed.add(a.left);
      value(a.right);
    }
    for (const be of findNodesByKind(body, NodeKind.BinaryExpr) as BinaryExpr[]) {
      if (!COMPARISON.has(be.operator) || be.ghidraInfo?.compareWidth !== c.type.width) continue;
      for (const [side, other] of [[be.left, be.right], [be.right, be.left]] as const) {
        const u = unwrapParens(side);
        if (u.kind === NodeKind.Identifier && (u as Identifier).name === name && isConstant(other)) {
          allowed.add(u);
          compared.add(u);
        }
      }
    }
    if (!ok || casts.size === 0 || compared.size === 0) continue;
    for (const id of findNodesByKind(body, NodeKind.Identifier) as Identifier[]) {
      if (id.name === name && !allowed.has(id)) { ok = false; break; }
    }
    if (ok) out.set(name, { type: c.decl.type, casts, compared });
  }
  return out;
}

/**
 * The narrow locals the original computed in a full register (#159):
 *
 *   uint8_t byBitPos = (uint8_t)nBitIndex & 0x1f;        // NET_SID_CLIENT_SetCDKeyBit 005225a0
 *   int8_t nNibbleShift = ((uint8_t)nNibbleIndex & 7) * '\x04';   // 00522500
 *   if (!(nShiftBits - 1U <= 0x1e)) return ..; uint8_t byShift = (uint8_t)nShiftBits;  // 0057e350
 *
 * for `MOV ECX,EDX; AND ECX,0x1f`: declared a byte, VC8 computes the value in a byte
 * register (`MOV AL,DL; AND AL,0x1f`) and widens it at each use. Declared int with the
 * narrowing cast gone the value is the same: a mask with a constant in range keeps the low
 * bits the cast kept, a multiple of it by a constant stays in range, and a value a guard
 * before it holds in range is unchanged by the cast. A char literal operand is the integer it
 * promotes to.
 *
 * Taken only where every value stored to it is one of those shapes (its proven range within
 * its type), it is never modified in place, its address and size are never taken, and no
 * comparison of it is tied to a compare at its own width. Every read promotes the narrow
 * value to int, so no read changes.
 */
function computedWhole(
  body: CompoundStmtLike,
  candidates: ReadonlyMap<string, { decl: VariableDecl; type: IntType }>,
  taken: ReadonlySet<string>,
  vetoed: ReadonlySet<string>,
  shapeOf: ExprShape,
  params: ReadonlySet<string>,
): Map<string, Set<unknown>> {
  const out = new Map<string, Set<unknown>>();
  const sized = new Set<string>();
  for (const z of findNodesByKind(body, NodeKind.SizeofExpr)) {
    for (const id of findNodesByKind(z, NodeKind.Identifier) as Identifier[]) sized.add(id.name);
  }
  // Names stored anywhere other than their declaration: a guard on one proves nothing.
  const stored = new Set<string>();
  for (const a of findNodesByKind(body, NodeKind.AssignExpr) as AssignExpr[]) {
    const l = unwrapParens(a.left);
    if (l.kind === NodeKind.Identifier) stored.add((l as Identifier).name);
  }
  for (const u of [...findNodesByKind(body, NodeKind.UnaryExpr), ...findNodesByKind(body, NodeKind.PostfixExpr)] as UnaryExpr[]) {
    const x = unwrapParens(u.operand);
    if (x.kind === NodeKind.Identifier && ['++', '--', '&'].includes(u.operator)) stored.add((x as Identifier).name);
  }
  const wide = (e: Expression): boolean => {
    const sh = shapeOf(unwrapParens(e));
    const t = sh && sh.stars === 0 ? INTEGERS[sh.base] : undefined;
    return !!t && t.width === 4;
  };
  for (const [name, c] of candidates) {
    if (taken.has(name) || vetoed.has(name) || sized.has(name) || stored.has(name) || params.has(name)) continue;
    const init = c.decl.initializer;
    if (!init || init.kind === NodeKind.InitListExpr) continue;
    const drop = new Set<unknown>();
    const [lo, hi] = range(c.type);
    // The value's range, with the casts to drop recorded; null when it is not one of the shapes.
    const valueRange = (e: Expression): [bigint, bigint] | null => {
      const u = unwrapParens(e);
      const k = constantValue(u);
      if (k !== null) return [k, k];
      if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&') {
        const b = u as BinaryExpr;
        const m = constantValue(b.right);
        if (m === null || m < 0n || m > hi) return null;
        const x = unwrapParens(b.left);
        // `(narrow)E & K`: the cast keeps bits the mask drops anyway.
        if (x.kind === NodeKind.CStyleCastExpr && wide((x as CStyleCastExpr).expression)) {
          const to = shapeOf(x);
          const t = to && to.stars === 0 ? INTEGERS[to.base] : undefined;
          if (!t || t.width !== c.type.width || !x.location) return null;
          drop.add(x.location);
          return [0n, m];
        }
        return wide(x) ? [0n, m] : null;
      }
      if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '*') {
        const b = u as BinaryExpr;
        const m = constantValue(b.right);
        const r = m === null ? null : valueRange(b.left);
        if (!r || m === null || m < 0n) return null;
        return [r[0] * m, r[1] * m];
      }
      if (u.kind === NodeKind.CStyleCastExpr) {
        const x = unwrapParens((u as CStyleCastExpr).expression);
        const to = shapeOf(u);
        const t = to && to.stars === 0 ? INTEGERS[to.base] : undefined;
        if (!t || t.width !== c.type.width || x.kind !== NodeKind.Identifier || !u.location) return null;
        const g = guardedRange(body, c.decl, (x as Identifier).name, stored);
        if (!g) return null;
        drop.add(u.location);
        return g;
      }
      return null;
    };
    const r = valueRange(init as Expression);
    if (!r || drop.size === 0 || r[0] < lo || r[1] > hi) continue;
    out.set(name, drop);
  }
  return out;
}

type CompoundStmtLike = ASTNode;

/**
 * The range of `name` at the declaration `decl` that an early-return guard right before it
 * in the same block proves: `if (!(name - A <= B)) return ..;` or `if (name - A > B) return ..;`
 * with an unsigned compare, so `name` lies in A..A+B. Null without one.
 */
function guardedRange(body: ASTNode, decl: VariableDecl, name: string, stored: ReadonlySet<string>): [bigint, bigint] | null {
  if (stored.has(name)) return null;
  for (const b of findNodesByKind(body, NodeKind.CompoundStmt) as unknown as { statements: ASTNode[] }[]) {
    const k = b.statements.findIndex(s => s.kind === NodeKind.DeclStmt
      && (s as DeclStmt).declarations.some(d => d.location !== undefined && d.location === decl.location));
    if (k < 0) continue;
    for (let j = k - 1; j >= 0; j--) {
      const s = b.statements[j];
      if (s.kind !== NodeKind.IfStmt) continue;
      const i = s as unknown as { condition: Expression; thenBranch: ASTNode; elseBranch?: ASTNode | null };
      if (i.elseBranch) continue;
      const then = i.thenBranch.kind === NodeKind.CompoundStmt ? (i.thenBranch as unknown as { statements: ASTNode[] }).statements : [i.thenBranch];
      if (then.length !== 1 || then[0].kind !== NodeKind.ReturnStmt) continue;
      let cond = unwrapParens(i.condition);
      let rel: string | null = null;
      if (cond.kind === NodeKind.UnaryExpr && (cond as UnaryExpr).operator === '!') {
        cond = unwrapParens((cond as UnaryExpr).operand);
        rel = cond.kind === NodeKind.BinaryExpr && (cond as BinaryExpr).operator === '<=' ? '<=' : null;
      } else if (cond.kind === NodeKind.BinaryExpr && (cond as BinaryExpr).operator === '>') rel = '<=';
      if (!rel) continue;
      const be = cond as BinaryExpr;
      const bound = unwrapParens(be.right);
      const diff = unwrapParens(be.left);
      if (bound.kind !== NodeKind.IntegerLiteral || diff.kind !== NodeKind.BinaryExpr || (diff as BinaryExpr).operator !== '-') continue;
      const d = diff as BinaryExpr;
      const v = unwrapParens(d.left);
      const a = unwrapParens(d.right);
      if (v.kind !== NodeKind.Identifier || (v as Identifier).name !== name || a.kind !== NodeKind.IntegerLiteral) continue;
      // The compare is unsigned: the subtraction's literal carries the U, or the bound does.
      const unsignedCompare = /u/i.test((a as IntegerLiteralExpr).suffix ?? '') || /u/i.test((bound as IntegerLiteralExpr).suffix ?? '');
      if (!unsignedCompare) continue;
      const A = (a as IntegerLiteralExpr).value, B = (bound as IntegerLiteralExpr).value;
      if (A < 0n || B < 0n || A + B > 0x7fffffffn) continue;
      return [A, A + B];
    }
  }
  return null;
}

/** Drops the casts `computedWhole` found and spells a char literal operand of the value as an integer. */
function dropValueCasts(body: ASTNode, computed: ReadonlyMap<string, Set<unknown>>): ASTNode {
  const casts = new Set<unknown>();
  for (const d of computed.values()) d.forEach(x => casts.add(x));
  const names = new Set(computed.keys());
  const charsToInt = createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.CharLiteral) return undefined;
      const value = BigInt((n as CharLiteralExpr).value);
      return { kind: NodeKind.IntegerLiteral, value, raw: value.toString(10), base: 10, suffix: '',
        location: n.location, leadingTrivia: n.leadingTrivia ?? [], trailingTrivia: n.trailingTrivia ?? [] } as unknown as ASTNode;
    },
  });
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind === NodeKind.CStyleCastExpr && n.location && casts.has(n.location)) return (n as CStyleCastExpr).expression;
      if (n.kind === NodeKind.VariableDecl && names.has((n as VariableDecl).name.name) && (n as VariableDecl).initializer) {
        return updateNode(n as VariableDecl, { initializer: charsToInt((n as VariableDecl).initializer as ASTNode) } as Partial<VariableDecl>);
      }
      return undefined;
    },
  })(body);
}

/** Drops the casts `loadedWhole` found and narrows the local at each of its compares. */
function narrowAtCompares(body: ASTNode, whole: ReadonlyMap<string, LoadedWhole>): ASTNode {
  // The transform copies every node it passes; a node keeps its location object, so the
  // nodes are found again by that (a node without one is not touched).
  const casts = new Set<unknown>();
  const compared = new Map<unknown, TypeNode>();
  for (const w of whole.values()) {
    w.casts.forEach(x => { if (x.location) casts.add(x.location); });
    w.compared.forEach(x => { if (x.location) compared.set(x.location, w.type); });
  }
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (!n.location) return undefined;
      if (n.kind === NodeKind.CStyleCastExpr && casts.has(n.location)) return (n as CStyleCastExpr).expression;
      const t = n.kind === NodeKind.Identifier ? compared.get(n.location) : undefined;
      if (t) return Expr.cast(t, n as Expression);
      return undefined;
    },
  })(body);
}

export const narrowLocalWidenPlugin: TransformPlugin = createPlugin(
  'narrow-local-widen',
  'Narrow Local Widen',
  'A one- or two-byte local the original compares at four bytes against a constant is an int',
  (options?: PluginOptions) => createNarrowLocalWidenTransformer(options),
  {
    priority: 618, // after unsigned-range-compare (617), before compare-signedness (619): final types
    defaultEnabled: true,
    tags: ['fidelity'],
    version: '1.0.0',
  },
);

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
 *    them compares it with a constant;
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
      const isConstant = (x: Expression) => {
        if (constantValue(x) !== null) return true;
        const n = nameOf(x);
        return !!n && enumConstants.has(n) && !candidates.has(n);
      };

      for (const be of findNodesByKind(body, NodeKind.BinaryExpr) as BinaryExpr[]) {
        if (!COMPARISON.has(be.operator)) continue;
        const width = be.ghidraInfo?.compareWidth;
        if (width === undefined) continue;
        for (const [side, other] of [[be.left, be.right], [be.right, be.left]] as const) {
          const n = nameOf(side);
          if (!n || !candidates.has(n)) continue;
          if (width < 4) vetoed.add(n);
          else if (isConstant(other)) evidence.add(n);
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
      if (widen.length === 0) return undefined;
      const targets = new Set(widen.map(n => candidates.get(n)!.decl));
      const inner = createTransformer({
        visitVariableDecl(v: VariableDecl): ASTNode | undefined {
          // The name is declared once in this function (a candidate's condition).
          const c = candidates.get(v.name.name);
          if (!c || !targets.has(c.decl)) return undefined;
          const int32: TypedefType = {
            kind: NodeKind.TypedefType,
            name: { ...Expr.identifier('int32_t'), location: v.type.location, leadingTrivia: [], trailingTrivia: [] },
            location: v.type.location, leadingTrivia: v.type.leadingTrivia, trailingTrivia: v.type.trailingTrivia,
          } as TypedefType;
          return updateNode(v, { type: int32 } as Partial<VariableDecl>);
        },
      });
      return updateNode(node, { body: inner(body) } as Partial<FunctionDecl>);
    },
  });
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

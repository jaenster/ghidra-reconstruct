/**
 * Union Value Member Plugin
 *
 * When a stack slot is typed as a union of a pointer and an integer, Ghidra reads
 * a member of the union out of a VALUE that never sat in memory by casting the
 * value to the union's first member type and applying `.`:
 *
 *     uSlotC.nInitPosZ = nTmp + nInitPosZ;
 *     nZStepPerFrame = ((D2UnitStrc *)(nTmp + nInitPosZ)).nInitPosZ * -2;
 *
 * (Skills_CltDoFunc_EMon_FallingMissileWithZ 004efdf0, union
 * `..._Slotmc { D2UnitStrc* pTargetUnit; int32_t nInitPosZ; }`.) That is no C++: `.`
 * on a pointer. What it means is the value's bits read as the member, and for a
 * member that is a 32-bit integer or pointer, as the value is, that is a plain
 * conversion of the value to the member's type:
 *
 *     nZStepPerFrame = (int32_t)(nTmp + nInitPosZ) * -2;
 *
 * Only where the function declares a local of a union type that has both the cast's
 * pointer type and the member, and only when the member and the value are both
 * 32-bit integers or pointers (a float member would need the bits, not a
 * conversion, and is left as it is).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, MemberExpr, CStyleCastExpr,
  TypeNode, Identifier, BinaryExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import {
  shapeOfNode, shapeOfSpelling, typeFromSpelling, unwrapParens, type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

export interface UnionValueMemberOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

/** Integer bases exactly 32 bits wide on the target. */
const WORDS = new Set(['int', 'unsigned int', 'long', 'unsigned long', 'intptr_t', 'uintptr_t', 'size_t']);
const ARITH = new Set(['+', '-', '*', '&', '|', '^', '<<', '>>']);
const isWord = (s: TypeShape | null): boolean => !!s && (s.stars > 0 || WORDS.has(s.base));
const sameShape = (a: TypeShape | null, b: TypeShape | null) => !!a && !!b && a.base === b.base && a.stars === b.stars;

let siteCount = 0;
export function getUnionValueMemberCount(): number { return siteCount; }

export function createUnionValueMemberTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as UnionValueMemberOptions;
  const structFields = o.structFields ?? {};
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const members = findNodesByKind(node.body, NodeKind.MemberExpr) as MemberExpr[];
      const castMember = (m: MemberExpr) => !m.isArrow && unwrapParens(m.object).kind === NodeKind.CStyleCastExpr;
      if (!members.some(castMember)) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      // The aggregates this function's own locals are declared with, by value.
      const localAggregates = new Set<string>();
      for (const t of localTypes.values()) {
        const s = shapeOfNode(t, 0);
        if (s && s.stars === 0 && structFields[s.base]) localAggregates.add(s.base);
      }
      if (localAggregates.size === 0) return undefined;
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields,
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      /** A 32-bit integer or pointer value: by its type, or arithmetic over such values and literals. */
      const isWordValue = (e: Expression): boolean => {
        const u = unwrapParens(e);
        if (isWord(shapeOf(u))) return true;
        if (u.kind === NodeKind.IntegerLiteral) return true;
        if (u.kind === NodeKind.BinaryExpr) {
          const b = u as BinaryExpr;
          return ARITH.has(b.operator) && isWordValue(b.left) && isWordValue(b.right);
        }
        return false;
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.MemberExpr) return undefined;
          const m = n as MemberExpr;
          if (!castMember(m) || m.member.kind !== NodeKind.Identifier) return undefined;
          const name = (m.member as Identifier).name;
          const cast = unwrapParens(m.object) as CStyleCastExpr;
          const target = shapeOfNode(cast.type, 0, resolve);
          if (!target || target.stars === 0) return undefined;
          // The union local whose members are the cast's type and the member read.
          const spellings = new Set<string>();
          for (const u of localAggregates) {
            const fields = structFields[u];
            const memberType = fields[name];
            if (!memberType) continue;
            if (!Object.entries(fields).some(([f, t]) => f !== name && sameShape(shapeOfSpelling(t, resolve), target))) continue;
            spellings.add(memberType);
          }
          if (spellings.size !== 1) return undefined;
          const [spelling] = spellings;
          if (!isWord(shapeOfSpelling(spelling, resolve)) || !isWordValue(cast.expression)) return undefined;
          const type = typeFromSpelling(spelling);
          if (!type) return undefined;
          changed = true;
          siteCount++;
          return Expr.paren(Expr.cast(type, cast.expression));
        },
      });
      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const unionValueMemberPlugin: TransformPlugin = {
  id: 'union-value-member',
  name: 'Union Value Member',
  description:
    "Reads Ghidra's `((T *)value).member` of a slot union as the value converted to the member's type",
  version: '1.0.0',
  // Early: it makes the body C++ before the passes that type expressions read it.
  priority: 6,
  defaultEnabled: true,
  tags: ['cleanup', 'type'],
  createTransformer: createUnionValueMemberTransformer,
};

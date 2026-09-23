/**
 * Union-Arrow Member Plugin
 *
 * A local declared as a union of pointers, read through one of its members,
 * sometimes comes out of Ghidra's printer without the member:
 *
 *   D2MonStatsExTxtSlot uMonTxt;          // union { D2MonPropTxt *pMonPropTxt;
 *                                         //         D2MonStats2Txt *pMonStats2Txt; }
 *   if (uMonTxt->isAtt != 0) { ... }      // MONSTER_InitStats, 00574146
 *
 * The decompiler resolved the union to `pMonStats2Txt` there (a forced union
 * facet), and its bitfield printer then writes the high variable's name and
 * the bitfield, dropping the field token in between. `->` on a union held by
 * value is not C++, and the only reading that type-checks is the one the facet
 * chose: the single pointer member whose pointee declares the member named.
 *
 *   U->f   →   U.m->f     when U is a union by value and exactly one pointer
 *                         member m points at an aggregate that declares f
 *
 * Nothing happens when the object is not a union by value, when no member
 * fits, or when more than one does - a guess would read the wrong struct.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, MemberExpr, ParameterDecl, VariableDecl, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { Expr } from '../../../ast/factory.js';
import { createExprShape } from './expr-shape.js';
import { shapeOfSpelling, type TypedefResolver } from './call-arg-cast.js';

export interface UnionArrowMemberOptions extends PluginOptions {
  /** Names of the aggregates that are unions. */
  unionNames?: readonly string[];
  /** Aggregate name → every member name its emitted declaration carries. */
  aggregateMembers?: Record<string, readonly string[]>;
  /** Aggregate name → member name → member spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
  /** Typedef name → what it stands for. */
  typedefTargets?: Record<string, string>;
}

function createUnionArrowMemberTransformer(options: UnionArrowMemberOptions = {}): Transformer {
  const unions = new Set(options.unionNames ?? []);
  const aggregateMembers = options.aggregateMembers ?? {};
  const structFields = options.structFields ?? {};
  if (unions.size === 0) return createTransformer({});
  const typedefTargets = options.typedefTargets;
  const resolve: TypedefResolver | undefined = typedefTargets
    ? (name: string) => typedefTargets[name]
    : undefined;
  const tables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields,
    resolve,
  };

  /** The one pointer member of `union` whose pointee declares `field`, if exactly one. */
  const memberFor = (union: string, field: string): string | undefined => {
    const fields = structFields[union];
    if (!fields) return undefined;
    const hits: string[] = [];
    for (const [name, spelling] of Object.entries(fields)) {
      const s = shapeOfSpelling(spelling, resolve);
      if (!s || s.stars !== 1) continue;
      if (aggregateMembers[s.base]?.includes(field)) hits.push(name);
    }
    return hits.length === 1 ? hits[0] : undefined;
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shape = createExprShape(localTypes, tables);

      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.MemberExpr) return undefined;
          const m = n as MemberExpr;
          if (!m.isArrow) return undefined;
          const field = (m.member as { name?: string })?.name;
          if (typeof field !== 'string') return undefined;
          const obj = shape(m.object);
          if (!obj || obj.stars !== 0 || !unions.has(obj.base)) return undefined;
          const via = memberFor(obj.base, field);
          if (!via) return undefined;
          const rewritten: MemberExpr = { ...m, object: Expr.member(m.object, via, false) };
          return rewritten;
        },
      });

      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const unionArrowMemberPlugin: TransformPlugin = {
  id: 'union-arrow-member',
  name: 'Union-Arrow Member',
  description:
    'Restore the union member Ghidra drops when it prints `U->f` on a union of pointers held by value',
  version: '1.0.0',
  defaultEnabled: true,
  // After struct-field (50), before bitfield-alias-lower (55), so the passes
  // that ask for the object's type see the member access it really is.
  priority: 52,
  tags: ['cleanup', 'structs', 'type'],
  createTransformer: createUnionArrowMemberTransformer,
};

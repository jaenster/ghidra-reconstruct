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
 *
 * The same missing member shows up on the other side of an assignment. A
 * union-typed field is stored from a scalar whose declared type is not the
 * union - `SMsgDispatchMessage` (00420b00) builds a `D2UIMouseMsgStrc` with
 *
 *   hMsgWnd.uLParam = dwLParam;           // uLParam: union { int32_t nLParam;
 *                                         //   D2UIMsgMousePosStrc sMousePos; }
 *                                         // dwLParam: uint32_t (the prototype)
 *
 * The decompiler typed its own copy of the parameter as the union, so it
 * printed a whole-union copy; the emitted prototype is the database's
 * `undefined4`, and C++ has no conversion from `uint32_t` to the union. The
 * store the machine did is four bytes into the union's storage, so the faithful
 * spelling names the one member that holds those four bytes as that kind of
 * value:
 *
 *   U = E   →   U.m = E   when U is a union by value and E is not, and m is
 *                         the one member of E's exact type, else the one
 *                         integer member exactly as wide as an integer E
 *
 * Integer to integer of one width (signedness aside) carries every bit; nothing
 * crosses between integer, floating and aggregate members, and two candidates
 * leave the store alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, FunctionDecl, MemberExpr, ParameterDecl, VariableDecl, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { Expr } from '../../../ast/factory.js';
import { createExprShape } from './expr-shape.js';
import { shapeOfSpelling, type TypeShape, type TypedefResolver } from './call-arg-cast.js';

/** Byte width of each canonical integer base (`canonicalBase` spellings). */
const INTEGER_WIDTH: Record<string, number> = {
  'char': 1, 'signed char': 1, 'unsigned char': 1,
  'short': 2, 'unsigned short': 2, 'wchar_t': 2,
  'int': 4, 'unsigned int': 4, 'long': 4, 'unsigned long': 4,
  'long long': 8, 'unsigned long long': 8,
};

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

  /**
   * The member of `union` a store of a `value`-shaped scalar lands in, if the
   * answer is unique: the exact type first, then a same-width integer.
   */
  const memberForStore = (union: string, value: TypeShape): string | undefined => {
    const fields = structFields[union];
    if (!fields) return undefined;
    const members = Object.entries(fields)
      .map(([name, spelling]) => ({ name, shape: shapeOfSpelling(spelling, resolve) }))
      .filter((m): m is { name: string; shape: TypeShape } => !!m.shape);
    const exact = members.filter(m => m.shape.base === value.base && m.shape.stars === value.stars);
    if (exact.length === 1) return exact[0].name;
    if (exact.length > 1) return undefined;
    if (value.stars !== 0) return undefined;
    const width = INTEGER_WIDTH[value.base];
    if (width === undefined) return undefined;
    const sameWidth = members.filter(m => m.shape.stars === 0 && INTEGER_WIDTH[m.shape.base] === width);
    return sameWidth.length === 1 ? sameWidth[0].name : undefined;
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
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=') return undefined;
            const target = shape(a.left);
            if (!target || target.stars !== 0 || !unions.has(target.base)) return undefined;
            const value = shape(a.right);
            if (!value || (value.stars === 0 && (unions.has(value.base) || aggregateMembers[value.base]))) {
              return undefined;
            }
            const via = memberForStore(target.base, value);
            if (!via) return undefined;
            const rewritten: AssignExpr = { ...a, left: Expr.member(a.left, via, false) };
            return rewritten;
          }
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
    'Restore the union member Ghidra drops: `U->f` on a union of pointers held by value, and a scalar stored into a union',
  version: '1.0.0',
  defaultEnabled: true,
  // After struct-field (50), before bitfield-alias-lower (55), so the passes
  // that ask for the object's type see the member access it really is.
  priority: 52,
  tags: ['cleanup', 'structs', 'type'],
  createTransformer: createUnionArrowMemberTransformer,
};

/**
 * Unsigned Range Compare Plugin
 *
 * MSVC tests `lo <= x && x < lo + n` as one unsigned compare, `(unsigned)(x - lo) < n`.
 * Ghidra prints that as
 *
 *   if (nMouseY - 0x18 < 0x21)                      // INPUT_HelpCloseButtonDown, ushort nMouseY
 *   if (eLevelId - LEVEL_RiverOfFlame < 2)          // ROOM_GetLevelLightColor, enum eD2LevelId
 *
 * with no cast, because in Ghidra's type system the difference is unsigned: a `ushort` or
 * `byte` is zero-extended to an unsigned 32-bit value, and an enum with no negative member
 * is an unsigned type. C++ disagrees. A `uint16_t`/`uint8_t` operand promotes to `int`, and
 * the tree spells every 4-byte enum as `int`, so the difference is signed: for x below `lo`
 * it is negative, the compare is TRUE, and the range check accepts what the machine rejects.
 * Fourteen hand patches in project.json (`(uint)(x - lo) < n`) papered over the sites someone
 * had noticed.
 *
 * The compare is restored where the machine had it: a relational compare of a constant
 * against `A - B` (or `A + -c`) whose left operand A is an unsigned narrow integer or an
 * unsigned enum, and whose right operand is a constant, gets `(uint32_t)(A - B)`. The bits
 * of the difference are the machine's in both languages; only the compare's signedness
 * changes, back to the machine's.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CStyleCastExpr, Expression, FunctionDecl, Identifier, IntegerLiteralExpr,
  ParameterDecl, ParenExpr, TypeNode, TypedefType, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { Expr } from '../../../ast/factory.js';

export interface UnsignedRangeCompareOptions extends PluginOptions {
  /** Enum types Ghidra treats as unsigned: no negative member. */
  unsignedEnums?: string[];
  /** Every enum type name (never resolved through the typedef table). */
  enumTypes?: string[];
  /** Enum constant names, which count as constants. */
  enumConstants?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const NARROW_UNSIGNED = new Set([
  'uint8_t', 'uint16_t', 'unsigned char', 'unsigned short', 'byte', 'ushort', 'uchar', 'BYTE', 'WORD', 'UCHAR', 'USHORT',
]);
const RELATIONAL = new Set(['<', '<=', '>', '>=']);

const sets = new WeakMap<readonly string[], Set<string>>();
const NONE: readonly string[] = [];
function setOf(names: readonly string[] | undefined): Set<string> {
  const k = names ?? NONE;
  let s = sets.get(k);
  if (!s) { s = new Set(k); sets.set(k, s); }
  return s;
}

export function createUnsignedRangeCompareTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as UnsignedRangeCompareOptions;
  const unsignedEnums = setOf(o.unsignedEnums);
  const enumTypes = setOf(o.enumTypes);
  const enumConstants = setOf(o.enumConstants);
  const typedefTargets = o.typedefTargets ?? {};
  // An enum must be seen as itself, not as the `int` it is spelled with.
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  const isConstant = (e: Expression): boolean => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value >= 0n;
    if (x.kind === NodeKind.Identifier) return enumConstants.has((x as Identifier).name);
    if (x.kind === NodeKind.QualifiedId) {
      const n = (x as unknown as { name: { name?: string } }).name.name;
      return !!n && enumConstants.has(n);
    }
    return false;
  };
  /** `B` of `A + -c`, as a subtrahend; or the right operand of `A - B`. */
  const difference = (e: Expression): { a: Expression; b: Expression } | null => {
    const x = unwrapParens(e);
    if (x.kind !== NodeKind.BinaryExpr) return null;
    const be = x as BinaryExpr;
    if (be.operator === '-') return { a: be.left, b: be.right };
    if (be.operator === '+') {
      const r = unwrapParens(be.right);
      if (r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '-') return { a: be.left, b: (r as UnaryExpr).operand };
      if (r.kind === NodeKind.IntegerLiteral && (r as IntegerLiteralExpr).value < 0n) return { a: be.left, b: r };
    }
    return null;
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
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const unsignedOperand = (e: Expression): boolean => {
        const s = shapeOf(e);
        return !!s && s.stars === 0 && (NARROW_UNSIGNED.has(s.base) || unsignedEnums.has(s.base));
      };
      const isAlreadyUnsignedCast = (e: Expression): boolean => {
        const x = unwrapParens(e);
        if (x.kind !== NodeKind.CStyleCastExpr) return false;
        const t = (x as CStyleCastExpr).type as ASTNode;
        if (t.kind !== NodeKind.TypedefType) return false;
        const n = (t as TypedefType).name;
        return n.kind === NodeKind.Identifier && ['uint32_t', 'uint', 'unsigned int', 'DWORD'].includes((n as Identifier).name);
      };
      const wrap = (side: Expression): Expression => {
        const cast: CStyleCastExpr = {
          kind: NodeKind.CStyleCastExpr,
          type: { kind: NodeKind.TypedefType, name: { ...Expr.identifier('uint32_t'), location: side.location, leadingTrivia: [], trailingTrivia: [] },
            location: side.location, leadingTrivia: [], trailingTrivia: [] } as TypedefType,
          expression: { kind: NodeKind.ParenExpr, expression: unwrapParens(side), location: side.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr,
          location: side.location, leadingTrivia: [], trailingTrivia: [],
        };
        return cast;
      };

      let changed = false;
      const inner = createTransformer({
        visitBinaryExpr(be: BinaryExpr): ASTNode | undefined {
          if (!RELATIONAL.has(be.operator)) return undefined;
          for (const [side, other, key] of [[be.left, be.right, 'left'], [be.right, be.left, 'right']] as const) {
            if (!isConstant(other) || isAlreadyUnsignedCast(side)) continue;
            const d = difference(side);
            if (!d || !isConstant(d.b) || !unsignedOperand(d.a)) continue;
            changed = true;
            return updateNode(be, { [key]: wrap(side) } as Partial<BinaryExpr>);
          }
          return undefined;
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const unsignedRangeComparePlugin: TransformPlugin = createPlugin(
  'unsigned-range-compare',
  'Unsigned Range Compare',
  'A range check (x - lo) < n on an unsigned narrow integer or unsigned enum stays an unsigned compare',
  (options?: PluginOptions) => createUnsignedRangeCompareTransformer(options),
  {
    priority: 617, // with the other late cast passes: needs the final local and global types
    defaultEnabled: true,
    tags: ['correctness'],
    version: '1.0.0',
  },
);

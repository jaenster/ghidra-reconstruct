/**
 * Pointer-Comparison Cast-Insertion Plugin
 *
 * The machine compares two addresses. Ghidra's C reaches that with `pbScan <
 * pszEnd` across two differently-typed pointers, because the decompiler recovers
 * a pointee type per variable and the same register is often reused as `byte *`
 * in one place and `short *` in another. C++ rejects the comparison outright -
 * "comparison between distinct pointer types ... lacks a cast" - so the original
 * MSVC source carried a cast, and writing it back is transcription.
 *
 * A comparison is the safe operator to do this on. `==`, `!=`, `<`, `<=`, `>`
 * and `>=` compare the addresses themselves, so casting either operand to the
 * other's type cannot change the answer. Pointer SUBTRACTION is deliberately not
 * touched: `(T*)a - (T*)b` divides by `sizeof(T)`, and picking a side there would
 * change the value.
 *
 * The same argument settles a pointer compared against an INTEGER, which C++
 * also rejects. There the pointer side goes through `uintptr_t`: that is the
 * machine's own operation - a `cmp` of two 32-bit words - it is width-exact,
 * and `uintptr_t` is spellable everywhere, where the pointee type may not be.
 * Only a MACHINE-WORD integer qualifies; a narrower one would mean the model
 * disagrees about the width somewhere else, and that stays visible.
 *
 * The cast is always spelled with a BUILTIN type - `(unsigned char*)`,
 * `(short*)`, `(void*)`. One of the two sides in this shape is essentially always
 * a raw byte/word walk, and confining the emitted spelling to a builtin means
 * the cast can never name a type that is out of scope at the comparison, or a
 * typedef that resolves differently in the header the comparison is emitted
 * into. Where neither side reduces to a builtin pointer - two function pointers,
 * two unrelated structs - nothing is written and the disagreement stays visible.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, BinaryExpr, TypeNode,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import {
  SCALAR_BASES, sameShape, unwrapParens, type TypeShape, type TypedefResolver,
} from './call-arg-cast.js';

export interface PointerCompareCastOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

/** The comparisons that read only the addresses, never the pointee size. */
const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** A shape that can be written as a cast with nothing but a builtin type name. */
const isBuiltinPointer = (s: TypeShape): boolean => s.stars > 0 && SCALAR_BASES.has(s.base);

/**
 * The integer widths a pointer's value fits in exactly. A narrower slot would
 * truncate the address, which the machine never did, so it is left visible.
 */
const WORD_INTEGER_BASES = new Set([
  'int', 'unsigned int', 'long', 'unsigned long', 'uintptr_t', 'intptr_t',
  'size_t', 'ssize_t', 'pointer32',
]);

const isWordInteger = (s: TypeShape) => s.stars === 0 && WORD_INTEGER_BASES.has(s.base);

/**
 * An integer LITERAL compared against a pointer. `expr-shape` deliberately has
 * no shape for a literal - it is not an object with a declared type - but
 * `3 < pnOddPart` is the same machine comparison as any other, and the literal
 * side needs no cast at all.
 */
const isIntegerLiteral = (e: Expression): boolean => {
  const u = unwrapParens(e);
  if (u.kind !== NodeKind.IntegerLiteral) return false;
  // `p == 0` is a null-pointer comparison and already legal; `nullptr-cleanup`
  // owns how it is spelled.
  return (u as IntegerLiteralExpr).value !== 0n;
};

function spell(s: TypeShape): TypeNode {
  let node: TypeNode = Type.builtin(s.base);
  for (let i = 0; i < s.stars; i++) node = Type.pointer(node);
  return node;
}

export function createPointerCompareCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as PointerCompareCastOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];

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

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.BinaryExpr) return undefined;
          const b = n as BinaryExpr;
          if (!COMPARISONS.has(b.operator)) return undefined;
          const left = shapeOf(b.left as Expression);
          const right = shapeOf(b.right as Expression);
          // A pointer against a machine word: the `cmp` reads both as words, so
          // the pointer goes through `uintptr_t` and the integer stays as it is.
          const wordCompare = (
            ptr: TypeShape | null, other: TypeShape | null, otherExpr: Expression,
          ) => !!ptr && ptr.stars > 0
            && (isIntegerLiteral(otherExpr) ? true : !!other && isWordInteger(other));
          if (wordCompare(left, right, b.right as Expression)) {
            changed = true;
            return updateNode(b, {
              left: Expr.cast(Type.typedef('uintptr_t'), b.left as Expression),
            } as Partial<BinaryExpr>);
          }
          if (wordCompare(right, left, b.left as Expression)) {
            changed = true;
            return updateNode(b, {
              right: Expr.cast(Type.typedef('uintptr_t'), b.right as Expression),
            } as Partial<BinaryExpr>);
          }
          if (!left || !right) return undefined;
          if (left.stars === 0 || right.stars === 0) return undefined;
          if (sameShape(left, right)) return undefined;
          // Prefer to move the side that is NOT already a builtin pointer, so a
          // named struct is the one that gets reinterpreted and the surviving
          // spelling is the raw walk the machine actually performs.
          if (isBuiltinPointer(left)) {
            changed = true;
            return updateNode(b, {
              right: Expr.cast(spell(left), b.right as Expression),
            } as Partial<BinaryExpr>);
          }
          if (isBuiltinPointer(right)) {
            changed = true;
            return updateNode(b, {
              left: Expr.cast(spell(right), b.left as Expression),
            } as Partial<BinaryExpr>);
          }
          return undefined;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const pointerCompareCastPlugin: TransformPlugin = {
  id: 'pointer-compare-cast',
  name: 'Pointer Comparison Cast Insertion',
  description:
    'Casts one side of a comparison between distinct pointer types, which C++ rejects and the machine performs on the addresses',
  version: '1.0.0',
  defaultEnabled: true,
  // After call-arg-cast (610), so an argument's final form is already settled.
  priority: 615,
  tags: ['cleanup', 'type'],
  createTransformer: createPointerCompareCastTransformer,
};

/**
 * Array Block-Assign Plugin
 *
 * Ghidra assigns to a whole array when the original code copied or cleared a
 * fixed-size slot:
 *
 *   local_10_unused = *(char (*) [4])(pPacket + 5);   // a 4-byte copy
 *   wszClanTag      = (WCHAR  [2])0x0;                // a 4-byte clear
 *
 * An array is not assignable in C++, so both are errors. Neither is fixed by a
 * cast: a cast on the right-hand side leaves the assignment itself illegal, and
 * casting the LEFT side to a scalar pointer changes how many bytes move. What
 * the decompiler wrote is a block operation, and that is what it has to become:
 *
 *   memcpy(local_10_unused, pPacket + 5, sizeof(local_10_unused));
 *   memset(wszClanTag, 0, sizeof(wszClanTag));
 *
 * `sizeof` keeps the width tied to the declaration rather than to a number
 * written here, so a later retype of the local moves the copy with it.
 *
 * The width matters and it was being lost. `*(char (*) [4])(pPacket + 5)` is a
 * FOUR-byte read; with the array cast stripped and the deref turned into a
 * subscript it became `pPacket[5]`, a ONE-byte read of the same address that
 * compiles the moment anything makes the assignment legal. So this runs ahead of
 * `array-cast-strip` (17), which is where the pointer-to-array cast is dropped.
 *
 * The same holds for an array-typed GLOBAL, which is why the set of array names
 * is seeded from the emitted global declarations and not only from the body's.
 *
 * Anything else assigned to an array local is left alone and left loud. In
 * particular `arr = (char [4])someScalar` with a non-zero right-hand side is
 * Ghidra typing a REGISTER as an array: the variable holds a pointer, and no
 * block operation expresses that. Those belong to the local's type in the
 * database, not here.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, ArrayType, AssignExpr, CStyleCastExpr, Expression, FunctionDecl,
  Identifier, IntegerLiteralExpr, PointerType, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface ArrayBlockAssignOptions extends PluginOptions {
  /** Global name → its emitted declaration type spelling. */
  globalTypes?: Record<string, string>;
}

/** A declaration spelling that ends in one or more array extents, and is not a pointer. */
const isArraySpelling = (t: string): boolean => /(?:\[\d+\])+$/.test(t.trim());

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as { expression: Expression }).expression;
  return e;
}

function isZeroLiteral(e: Expression): boolean {
  const u = unwrapParens(e);
  return u.kind === NodeKind.IntegerLiteral && (u as IntegerLiteralExpr).value === 0n;
}

function createArrayBlockAssignTransformer(options: PluginOptions = {}): Transformer {
  const o = options as ArrayBlockAssignOptions;
  // A GLOBAL declared as an array is assignable no more than a local one is, and
  // the block operation is the same. `gnQuestScrollLine = *(ushort (*)[2])(p+3)`
  // is the four-byte packet field copy; it reached here only because the array
  // names this pass knew came from body declarations alone.
  const arrayGlobals = new Set<string>();
  for (const [name, spelling] of Object.entries(o.globalTypes ?? {})) {
    if (isArraySpelling(spelling)) arrayGlobals.add(name);
  }
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // Array-typed locals this body declares. A parameter spelled `T p[N]` is a
      // pointer, not an array, and assigning to it is legal — so only body
      // declarations count.
      const arrayLocals = new Set<string>(arrayGlobals);
      // A body-declared name of the same spelling shadows the global, so a local
      // that is NOT an array takes the name back out of the set.
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (v.type.kind === NodeKind.ArrayType) arrayLocals.add(v.name.name);
        else arrayLocals.delete(v.name.name);
      }
      if (arrayLocals.size === 0) return undefined;

      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.AssignExpr) return undefined;
          const a = n as AssignExpr;
          if (a.operator !== '=') return undefined;
          if (a.left.kind !== NodeKind.Identifier) return undefined;
          const name = (a.left as Identifier).name;
          if (!arrayLocals.has(name)) return undefined;

          const size = Expr.sizeof(Expr.identifier(name));
          const rhs = unwrapParens(a.right);

          // A copy: `arr = *(T (*)[N])src`.
          if (rhs.kind === NodeKind.UnaryExpr && (rhs as UnaryExpr).operator === '*') {
            const operand = unwrapParens((rhs as UnaryExpr).operand);
            if (operand.kind !== NodeKind.CStyleCastExpr) return undefined;
            const castType = (operand as CStyleCastExpr).type;
            if (castType.kind !== NodeKind.PointerType) return undefined;
            if ((castType as PointerType).pointee.kind !== NodeKind.ArrayType) return undefined;
            const src = unwrapParens((operand as CStyleCastExpr).expression);
            return {
              ...Expr.call('memcpy', [Expr.identifier(name), src, size]),
              leadingTrivia: n.leadingTrivia,
              trailingTrivia: n.trailingTrivia,
            };
          }

          // A clear: `arr = (T [N])0`.
          if (rhs.kind === NodeKind.CStyleCastExpr) {
            const c = rhs as CStyleCastExpr;
            if (c.type.kind !== NodeKind.ArrayType) return undefined;
            void (c.type as ArrayType);
            if (!isZeroLiteral(c.expression)) return undefined;
            return {
              ...Expr.call('memset', [Expr.identifier(name), Expr.intLiteral(0), size]),
              leadingTrivia: n.leadingTrivia,
              trailingTrivia: n.trailingTrivia,
            };
          }

          return undefined;
        },
      });

      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const arrayBlockAssignPlugin: TransformPlugin = {
  id: 'array-block-assign',
  name: 'Array Block-Assign',
  description:
    'Rewrite a whole-array assignment to the block copy or clear it stands for '
    + '(`arr = *(T(*)[N])src` → memcpy, `arr = (T[N])0` → memset)',
  version: '1.0.0',
  defaultEnabled: true,
  // Before array-cast-strip (17), which drops the pointer-to-array cast that
  // says how many bytes move.
  priority: 15,
  tags: ['core', 'cleanup', 'ghidra'],
  createTransformer: createArrayBlockAssignTransformer,
};

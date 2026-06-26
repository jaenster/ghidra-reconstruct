/**
 * Char-Array Dword-Assign Plugin
 *
 * D2 stores 4-char codes ("tsc ", item codes) in a `char[4]` but the decompiler
 * reads/writes the slot as a 32-bit word, so Ghidra emits `acCode = dwordExpr;`
 * with `acCode` a `char[4]` — C++ rejects "incompatible types in assignment of
 * uint32_t to char[4]".
 *
 * Rewrite `<charArray> = <scalar>` → `*(uint32_t*)<charArray> = <scalar>`, which
 * stores the 4 bytes into the buffer — the actual intent. Only plain `=` to a
 * char-array LOCAL with a non-aggregate RHS (never a string/brace initializer).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, AssignExpr, VariableDecl, ArrayType, BuiltinType, Identifier,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface CharArrayDwordAssignOptions extends PluginOptions {}

function createCharArrayDwordAssignTransformer(_options: CharArrayDwordAssignOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      // char[]-typed locals declared in the body.
      const charArrays = new Set<string>();
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (v.type.kind !== NodeKind.ArrayType) continue;
        const el = (v.type as ArrayType).elementType;
        if (el.kind === NodeKind.BuiltinType && /^(char|uchar|unsigned char)$/.test((el as BuiltinType).name)) {
          charArrays.add(v.name.name);
        }
      }
      if (charArrays.size === 0) return undefined;

      const sub = createTransformer({
        visitNode(n) {
          if (n.kind !== NodeKind.AssignExpr) return undefined;
          const a = n as AssignExpr;
          if (a.operator !== '=') return undefined;
          if (a.left.kind !== NodeKind.Identifier) return undefined;
          if (!charArrays.has((a.left as Identifier).name)) return undefined;
          // Don't touch a genuine aggregate init (`buf = "abc"` / `{...}`).
          if (a.right.kind === NodeKind.StringLiteral || a.right.kind === NodeKind.InitListExpr) return undefined;
          const newLeft = Expr.deref(Expr.cast(Type.pointer(Type.builtin('uint32_t')), a.left));
          return updateNode(a, { left: newLeft } as Partial<AssignExpr>);
        },
      });
      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const charArrayDwordAssignPlugin: TransformPlugin = {
  id: 'char-array-dword-assign',
  name: 'Char-Array Dword Assign',
  description: 'Rewrites `charArray = scalar` to `*(uint32_t*)charArray = scalar` (4-char code stores)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 75,
  tags: ['cleanup', 'type'],
  createTransformer: createCharArrayDwordAssignTransformer,
};

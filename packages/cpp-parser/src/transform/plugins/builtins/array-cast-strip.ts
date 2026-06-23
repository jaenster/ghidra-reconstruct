/**
 * Array-Cast Strip Plugin
 *
 * Ghidra emits casts to an ARRAY type to express "reinterpret this scalar as N
 * bytes", e.g.
 *
 *   (char[4])pItemTxt->dwBetterGem != (char[4])0x206e6f6e
 *   _aPacketBuf = 0xc << 24 | (byte[3])(0 << 16 | ...)
 *
 * C++ forbids casting to an array type ("ISO C++ forbids casting to an array
 * type 'char [4]'"). The cast is value-preserving for the scalar operations that
 * surround it (comparison, bitwise-or, assignment), so we simply drop it and keep
 * the inner expression — which compiles and yields the same scalar value.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Expression, CStyleCastExpr } from '../../../ast/nodes.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';
import { createPlugin } from '../registry.js';

function createArrayCastStripTransformer(): Transformer {
  return createKindTransformer(NodeKind.CStyleCastExpr, (node) => {
    const cast = node as CStyleCastExpr;
    if (cast.type.kind !== NodeKind.ArrayType) return undefined;
    const inner = cast.expression as Expression & ASTNode;
    return {
      ...inner,
      leadingTrivia: cast.leadingTrivia,
      trailingTrivia: cast.trailingTrivia,
    };
  });
}

export const arrayCastStripPlugin: TransformPlugin = createPlugin(
  'array-cast-strip',
  'Array-Cast Strip',
  'Drop casts to an array type (Ghidra scalar-as-bytes reinterpret); C++ forbids them and the value is preserved',
  () => createArrayCastStripTransformer(),
  {
    priority: 17, // alongside pointer-cast-normalize (16)
    defaultEnabled: true,
    tags: ['core', 'cleanup', 'ghidra'],
    version: '1.0.0',
  },
);

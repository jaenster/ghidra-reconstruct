/**
 * Char-Literal-Escape Plugin
 *
 * Ghidra prints a byte above 0x7f in char context as the raw Unicode character
 * (`'²'`), which is not portable source — the file's encoding then decides the
 * value. The literal is re-spelled as the hex escape for the byte Ghidra meant
 * (`'\xb2'`).
 *
 * The predecessor regex (`'([^'\\])'`) matched any two quotes one character
 * apart, so it also fired inside string literals — `"a'²'b"` would be rewritten
 * mid-string. A CharLiteral node is a char literal by construction.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, CharLiteralExpr } from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

function createCharLiteralEscapeTransformer(): Transformer {
  return createTransformer({
    visitNode(n: ASTNode): ASTNode | undefined {
      if (n.kind !== NodeKind.CharLiteral) return undefined;
      const lit = n as CharLiteralExpr;
      // Wide/UTF literals carry their own encoding — only plain char is remapped.
      if (lit.prefix) return undefined;
      if (lit.value <= 0x7f || lit.value > 0xff) return undefined;

      const raw = `'\\x${lit.value.toString(16)}'`;
      if (raw === lit.raw) return undefined;
      return updateNode(lit, { raw } as Partial<CharLiteralExpr>);
    },
  });
}

import { createPlugin } from '../registry.js';

export const charLiteralEscapePlugin: TransformPlugin = createPlugin(
  'char-literal-escape',
  'Char Literal Escape',
  "Re-spells a non-ASCII char literal as its hex escape ('²' → '\\xb2')",
  () => createCharLiteralEscapeTransformer(),
  {
    priority: 46,
    defaultEnabled: true,
    tags: ['cleanup', 'cpp'],
    version: '1.0.0',
  }
);

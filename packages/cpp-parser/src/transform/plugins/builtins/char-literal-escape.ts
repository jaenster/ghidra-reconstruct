/**
 * Char-Literal-Escape Plugin
 *
 * Ghidra prints a byte above 0x7f in char context as the raw Unicode character
 * (`'²'`), which is not portable source — the file's encoding then decides the
 * value. The literal is re-spelled as the hex escape for the byte Ghidra meant
 * (`'\xb2'`).
 *
 * Wide literals (`L'þ'`) get the same treatment with their prefix kept (`L'\xfe'`).
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
      if (lit.value <= 0x7f) return undefined;
      // A wide literal is as encoding-dependent as a plain one: a compiler reading the
      // file in its ANSI codepage sees L'þ' as the UTF-8 bytes c3 be, worth 0xc3.
      // Its escape carries the code unit itself. u8 is a single UTF-8 code unit.
      if (lit.prefix === 'u8') return undefined;
      if (!lit.prefix && lit.value > 0xff) return undefined;
      if (lit.prefix === 'L' || lit.prefix === 'u') { if (lit.value > 0xffff) return undefined; }
      else if (lit.prefix && lit.prefix !== 'U') return undefined;

      const raw = `${lit.prefix}'\\x${lit.value.toString(16)}'`;
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

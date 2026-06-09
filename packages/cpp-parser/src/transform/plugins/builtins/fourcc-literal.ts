/**
 * FourCC (Four Character Code) Literal Simplification Plugin
 *
 * Transforms Ghidra's wide character literal representation of 4-byte character
 * codes (like Diablo 2 item codes) to readable string literals.
 *
 * Transforms:
 * - (char [4])L'\x20736831'  →  "1hs "   (little-endian decode)
 * - (char (*)[4])L'\x20687468'  →  "hth " (item code)
 *
 * These patterns commonly appear in game code where item/type codes are
 * compared as 32-bit integers for efficiency.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  CStyleCastExpr,
  ArrayType,
  CharLiteralExpr,
  StringLiteralExpr,
  TypeNode,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { emit } from '../../../emit/index.js';

// ============================================
// HELPERS
// ============================================

/**
 * Check if a type is a 4-byte char array
 * Examples: char[4], char(*)[4]
 */
function isChar4ArrayType(type: TypeNode): boolean {
  // Check if it's an array type
  if (type.kind === NodeKind.ArrayType) {
    const arrType = type as ArrayType;
    // Check if element is char
    if (arrType.elementType.kind === NodeKind.BuiltinType) {
      const typeStr = emit(arrType.elementType).trim();
      if (typeStr === 'char') {
        // Check size is 4
        if (arrType.size) {
          const sizeStr = emit(arrType.size).trim();
          return sizeStr === '4';
        }
      }
    }
  }

  // Fallback: emit and check string representation
  try {
    const typeStr = emit(type).replace(/\s+/g, '');
    return (
      typeStr.includes('char[4]') ||
      typeStr.includes('char(*)[4]') ||
      typeStr.includes('char*[4]')
    );
  } catch {
    return false;
  }
}

/**
 * Extract hex value from wide char literal like L'\x20736831'
 * Returns the numeric value or null if not a hex literal
 */
function extractHexValue(literal: string): number | null {
  // Match patterns like L'\x20736831' or L'\x00687468'
  const match = literal.match(/^L'\\x([0-9a-fA-F]+)'$/);
  if (match) {
    return parseInt(match[1], 16);
  }
  return null;
}

/**
 * Convert a 32-bit little-endian value to a 4-character string
 */
function leU32ToString(value: number): string {
  const bytes = [
    (value) & 0xFF,
    (value >> 8) & 0xFF,
    (value >> 16) & 0xFF,
    (value >> 24) & 0xFF,
  ];

  // Convert bytes to characters, handling non-printable as escape
  return bytes.map(b => {
    if (b >= 32 && b < 127) {
      return String.fromCharCode(b);
    }
    return `\\x${b.toString(16).padStart(2, '0')}`;
  }).join('');
}

/**
 * Check if all characters in a string are printable ASCII or space
 */
function isPrintableAscii(str: string): boolean {
  for (const char of str) {
    const code = char.charCodeAt(0);
    if (code < 32 || code >= 127) {
      return false;
    }
  }
  return true;
}

/**
 * Create a string literal expression
 */
function createStringLiteral(
  value: string,
  original: ASTNode
): StringLiteralExpr {
  return {
    kind: NodeKind.StringLiteral,
    value,
    prefix: '',
    isRaw: false,
    raw: `"${value}"`,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

export interface FourCCOptions extends PluginOptions {
  /**
   * Only convert if all 4 characters are printable ASCII
   * Default: true
   */
  requirePrintable?: boolean;

  /**
   * Use FOURCC("str") macro instead of raw string literal
   * Default: false
   */
  useMacro?: boolean;
}

/**
 * Create the transformer
 */
function createFourCCTransformer(options: FourCCOptions = {}): Transformer {
  const { requirePrintable = true } = options;

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Look for C-style cast expressions
      if (node.kind !== NodeKind.CStyleCastExpr) {
        return undefined;
      }

      const cast = node as CStyleCastExpr;

      // Check if casting to char[4] or similar
      if (!isChar4ArrayType(cast.type)) {
        return undefined;
      }

      // Check if the operand is a wide char literal (L'...')
      if (cast.expression.kind !== NodeKind.CharLiteral) {
        return undefined;
      }

      const charLit = cast.expression as CharLiteralExpr;

      // Must have L prefix (wide char)
      if (charLit.prefix !== 'L') {
        return undefined;
      }

      // Get the numeric value - either from parsed value or raw hex
      let hexValue: number | null = null;

      // If the value is already a number (parsed from hex), use it directly
      if (typeof charLit.value === 'number' && charLit.value > 0x7F) {
        hexValue = charLit.value;
      } else if (charLit.raw) {
        // Try to extract from raw representation
        hexValue = extractHexValue(charLit.raw);
      }

      if (hexValue === null) {
        return undefined;
      }

      // Convert to string
      const str = leU32ToString(hexValue);

      // Check if printable
      if (requirePrintable && !isPrintableAscii(str)) {
        return undefined;
      }

      // Replace with string literal
      return createStringLiteral(str, node);
    },
  });
}

// ============================================
// PLUGIN EXPORT
// ============================================

export const fourccLiteralPlugin: TransformPlugin = {
  id: 'fourcc-literal',
  name: 'FourCC Literal Simplification',
  description: 'Transforms (char[4])L\'\\xABCD\' to readable "abcd" strings',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 25, // Early in pipeline, before other cleanups
  tags: ['cleanup', 'readability', 'literals', 'game'],

  createTransformer: createFourCCTransformer,
};

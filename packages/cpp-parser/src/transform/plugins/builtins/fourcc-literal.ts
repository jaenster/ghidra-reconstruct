/**
 * FourCC (Four Character Code) Literal Simplification Plugin
 *
 * Ghidra spells a 32-bit character code as a WIDE character literal:
 * `L'\x20646c67'` for `'gld '`. That is not a wide character. `wchar_t` is 16
 * bits on this target, so the literal holds one code unit and the top half is
 * dropped: GCC evaluates `L'\x20736831'` as 26673, not 544434225, and says so
 * only in a warning that `-w` erases. clang rejects it outright.
 *
 * Silent truncation is worse than a wrong number here, because it is not
 * injective: `'g33'`/`'g34'`, `'qf1'`/`'qf2'`, `'1hs'`/`'1ht'` and
 * `'bkd'`/`'bks'` all collapse onto the same 16 bits, so a multi-way test on
 * item codes degenerates into fewer branches against the wrong values.
 *
 * Transforms:
 * - L'\x20646c67'            →  0x20646c67   (the value the machine had)
 * - (char [4])L'\x20736831'  →  "1hs "       (little-endian decode)
 * - (char (*)[4])L'\x20687468'  →  "hth "    (item code)
 *
 * A genuine wide character — one that fits a code unit — is left exactly as it
 * is: `L'\0'` and `L'A'` are what they say.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  CStyleCastExpr,
  ArrayType,
  CharLiteralExpr,
  IntegerLiteralExpr,
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
 * The largest value one code unit of an encoding-prefixed character literal can
 * hold on the target. `wchar_t` and `char16_t` are both 16 bits under
 * i686-w64-mingw32; `char32_t` is 32 and never truncates.
 */
const CODE_UNIT_MAX: Record<string, number> = {
  L: 0xffff,
  u: 0xffff,
  U: 0xffffffff,
};

/** Does this literal hold more than one code unit of its own encoding? */
function overflowsCodeUnit(lit: CharLiteralExpr): boolean {
  const max = CODE_UNIT_MAX[lit.prefix];
  return max !== undefined && lit.value > max;
}

/** The same 32-bit value, spelled as the integer constant it actually is. */
function asIntegerLiteral(lit: CharLiteralExpr): IntegerLiteralExpr {
  return {
    kind: NodeKind.IntegerLiteral,
    value: BigInt(lit.value),
    suffix: '',
    base: 16,
    raw: '0x' + lit.value.toString(16),
    location: lit.location,
    leadingTrivia: lit.leadingTrivia || [],
    trailingTrivia: lit.trailingTrivia || [],
  };
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
      // A prefixed character literal too wide for one code unit is not a
      // character at all — it is Ghidra's spelling of a multi-character
      // constant, and left alone the compiler keeps only its bottom half.
      if (node.kind === NodeKind.CharLiteral) {
        const lit = node as CharLiteralExpr;
        return overflowsCodeUnit(lit) ? asIntegerLiteral(lit) : undefined;
      }

      // Look for C-style cast expressions
      if (node.kind !== NodeKind.CStyleCastExpr) {
        return undefined;
      }

      const cast = node as CStyleCastExpr;

      // Check if casting to char[4] or similar
      if (!isChar4ArrayType(cast.type)) {
        return undefined;
      }

      // The operand is the wide char literal Ghidra wrote — or, since children
      // are visited first, the integer the rule above has already made of it.
      let hexValue: number | null = null;

      if (cast.expression.kind === NodeKind.IntegerLiteral) {
        const int = cast.expression as IntegerLiteralExpr;
        if (int.value > 0x7Fn) hexValue = Number(int.value);
      } else if (cast.expression.kind === NodeKind.CharLiteral) {
        const charLit = cast.expression as CharLiteralExpr;
        // Must have L prefix (wide char)
        if (charLit.prefix !== 'L') {
          return undefined;
        }
        // If the value is already a number (parsed from hex), use it directly
        if (typeof charLit.value === 'number' && charLit.value > 0x7F) {
          hexValue = charLit.value;
        } else if (charLit.raw) {
          // Try to extract from raw representation
          hexValue = extractHexValue(charLit.raw);
        }
      } else {
        return undefined;
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
  description:
    'Spells a >16-bit `L\'\\xABCD\'` as the integer it is, and decodes a char[4] cast of one to "abcd"',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 25, // Early in pipeline, before other cleanups
  tags: ['cleanup', 'readability', 'literals', 'game'],

  createTransformer: createFourCCTransformer,
};

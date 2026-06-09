/**
 * Signed Literal Cleanup Plugin
 *
 * Converts hex literals that represent negative numbers to their signed form.
 *
 * Transforms:
 * - 0xffffffff  →  -1   (32-bit)
 * - 0xfffffffe  →  -2   (32-bit)
 * - 0xffffffffffffffff  →  -1  (64-bit)
 * - 0x80000000  →  -2147483648 or INT32_MIN
 *
 * This makes the code more readable when the original source used negative values.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  IntegerLiteralExpr,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// CONSTANTS
// ============================================

// Common negative values for 32-bit
const NEGATIVE_32: Map<bigint, bigint> = new Map([
  [0xffffffffn, -1n],
  [0xfffffffen, -2n],
  [0xfffffffdn, -3n],
  [0xfffffffcn, -4n],
  [0xfffffffbn, -5n],
  [0xfffffffan, -6n],
  [0xfffffff9n, -7n],
  [0xfffffff8n, -8n],
  [0xfffffff7n, -9n],
  [0xfffffff6n, -10n],
  [0xfffffff0n, -16n],
  [0xffffffe0n, -32n],
  [0xffffffc0n, -64n],
  [0xffffff80n, -128n],
  [0xffffff00n, -256n],
  [0xfffffe00n, -512n],
  [0xfffffc00n, -1024n],
  [0x80000000n, -2147483648n], // INT32_MIN
]);

// Common negative values for 64-bit
const NEGATIVE_64: Map<bigint, bigint> = new Map([
  [0xffffffffffffffffn, -1n],
  [0xfffffffffffffffen, -2n],
]);

// Threshold for conversion - only convert "obvious" negative values
// Values in the top 1/16th of the range are likely negative
const THRESHOLD_32 = 0xf0000000n;
const THRESHOLD_64 = 0xf000000000000000n;

// ============================================
// HELPERS
// ============================================

/**
 * Check if a value looks like a negative number
 */
function looksNegative(value: bigint): { signed: bigint; bits: 32 | 64 } | null {
  // Check known 32-bit values first (allows INT_MIN even below threshold)
  const known32 = NEGATIVE_32.get(value);
  if (known32 !== undefined) {
    return { signed: known32, bits: 32 };
  }

  // Check known 64-bit values
  const known64 = NEGATIVE_64.get(value);
  if (known64 !== undefined) {
    return { signed: known64, bits: 64 };
  }

  // Check 32-bit range for dynamic conversion
  if (value >= THRESHOLD_32 && value <= 0xffffffffn) {
    // Two's complement conversion
    const signed = value - 0x100000000n;
    return { signed, bits: 32 };
  }

  // Check 64-bit range for dynamic conversion
  if (value >= THRESHOLD_64 && value <= 0xffffffffffffffffn) {
    const signed = value - 0x10000000000000000n;
    return { signed, bits: 64 };
  }

  return null;
}

/**
 * Create a negative integer literal
 */
function createNegativeLiteral(
  value: bigint,
  original: ASTNode
): UnaryExpr {
  const absValue = value < 0n ? -value : value;

  const literal: IntegerLiteralExpr = {
    kind: NodeKind.IntegerLiteral,
    value: absValue,
    suffix: '',
    base: 10,
    raw: absValue.toString(),
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };

  return {
    kind: NodeKind.UnaryExpr,
    operator: '-',
    operand: literal,
    location: original.location,
    leadingTrivia: original.leadingTrivia || [],
    trailingTrivia: original.trailingTrivia || [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

/**
 * Create the signed literal cleanup transformer
 */
function createSignedLiteralCleanup(options: SignedLiteralOptions): Transformer {
  const threshold = options.conversionThreshold ?? 0xf0000000n;
  const onlyKnown = options.onlyKnownValues ?? false;

  return createTransformer({
    visitNode(node) {
      // Only handle integer literals
      if (node.kind !== NodeKind.IntegerLiteral) {
        return undefined;
      }

      const literal = node as IntegerLiteralExpr;
      const value = literal.value;

      // Check known values first (they bypass threshold)
      const known32 = NEGATIVE_32.get(value);
      const known64 = NEGATIVE_64.get(value);
      const isKnown = known32 !== undefined || known64 !== undefined;

      // Skip small values unless they're known
      if (!isKnown && value < threshold) {
        return undefined;
      }

      // If onlyKnown is set, only convert known values
      if (onlyKnown && !isKnown) {
        return undefined;
      }

      const result = looksNegative(value);

      if (!result) {
        return undefined;
      }

      return createNegativeLiteral(result.signed, literal);
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface SignedLiteralOptions extends PluginOptions {
  /**
   * Only convert values above this threshold (default: 0xf0000000)
   * Set higher to be more conservative
   */
  conversionThreshold?: bigint;

  /**
   * Only convert known common values like 0xffffffff → -1
   * (default: false - will convert any value that looks negative)
   */
  onlyKnownValues?: boolean;
}

/**
 * Signed Literal Cleanup Plugin
 *
 * Converts hex literals that represent negative numbers to their
 * signed decimal form (e.g., 0xffffffff → -1).
 */
export const signedLiteralPlugin: TransformPlugin = {
  id: 'signed-literal',
  name: 'Signed Literal Cleanup',
  description:
    'Convert hex literals representing negative numbers (0xffffffff → -1)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 30, // Early in pipeline, after nullptr
  tags: ['core', 'cleanup', 'readability'],

  createTransformer(options?: SignedLiteralOptions) {
    return createSignedLiteralCleanup(options ?? {});
  },
};

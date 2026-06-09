/**
 * Magic Division Plugin
 *
 * Transforms compiler-generated magic number multiplication patterns
 * back to division operations.
 *
 * Compilers replace division by constants with multiply-shift sequences
 * for performance. This makes decompiled code hard to read.
 *
 * Transforms:
 * - (x * 0xAAAAAAAB) >> 33  →  x / 3
 * - (x * 0xCCCCCCCD) >> 34  →  x / 5
 * - (x * 0x92492493) >> 34  →  x / 7
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  IntegerLiteralExpr,
  Identifier,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  updateNode,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// MAGIC NUMBER DATABASE
// ============================================

/**
 * Known magic multiplier patterns for unsigned division
 * Key: magic number (as hex string), Value: { divisor, shift }
 */
const UNSIGNED_MAGIC_32: Map<bigint, { divisor: number; shift: number }> = new Map([
  // Division by 3
  [0xAAAAAAABn, { divisor: 3, shift: 33 }],
  // Division by 5
  [0xCCCCCCCDn, { divisor: 5, shift: 34 }],
  // Division by 6
  [0xAAAAAAABn, { divisor: 6, shift: 34 }],
  // Division by 7
  [0x24924925n, { divisor: 7, shift: 33 }],
  // Division by 9
  [0x38E38E39n, { divisor: 9, shift: 33 }],
  // Division by 10
  [0xCCCCCCCDn, { divisor: 10, shift: 35 }],
  // Division by 11
  [0xBA2E8BA3n, { divisor: 11, shift: 35 }],
  // Division by 12
  [0xAAAAAAABn, { divisor: 12, shift: 35 }],
  // Division by 100
  [0x51EB851Fn, { divisor: 100, shift: 37 }],
  // Division by 1000
  [0x10624DD3n, { divisor: 1000, shift: 38 }],
]);

/**
 * 64-bit magic multipliers
 */
const UNSIGNED_MAGIC_64: Map<bigint, { divisor: number; shift: number }> = new Map([
  // Division by 3
  [0xAAAAAAAAAAAAAAABn, { divisor: 3, shift: 65 }],
  // Division by 5
  [0xCCCCCCCCCCCCCCCDn, { divisor: 5, shift: 66 }],
  // Division by 10
  [0xCCCCCCCCCCCCCCCDn, { divisor: 10, shift: 67 }],
]);

/**
 * Compute magic number for division by d (for verification)
 * Based on: https://gmplib.org/~tege/divcnst-pldi94.pdf
 */
function computeMagic(divisor: number, bits: number): { magic: bigint; shift: number } | null {
  if (divisor <= 1) return null;

  const n = BigInt(bits);
  const d = BigInt(divisor);

  // Find smallest l such that 2^(n+l) > d * (2^n - 1 - (2^(n+l) mod d))
  for (let l = 0; l < 64; l++) {
    const twoNPlusL = 1n << (n + BigInt(l));
    const magic = (twoNPlusL + d - 1n) / d;

    // Verify: magic * d is close to 2^(n+l)
    if (magic < (1n << n)) {
      return { magic, shift: Number(n) + l };
    }
  }

  return null;
}

// ============================================
// PATTERN DETECTION
// ============================================

/**
 * Check if an expression is a magic multiplication pattern
 */
function detectMagicDivision(expr: Expression): {
  variable: Expression;
  divisor: number;
} | null {
  // Pattern 1: (x * MAGIC) >> SHIFT
  // Pattern 2: ((long)(x * MAGIC)) >> SHIFT
  // Pattern 3: (x * MAGIC) / POWER_OF_TWO (after high bits extraction)

  if (expr.kind !== NodeKind.BinaryExpr) return null;

  const binary = expr as BinaryExpr;

  // Must be right shift
  if (binary.operator !== '>>') return null;

  // Right side must be shift amount
  if (binary.right.kind !== NodeKind.IntegerLiteral) return null;
  const shift = Number((binary.right as IntegerLiteralExpr).value);

  // Left side should be multiplication or cast of multiplication
  let mulExpr: BinaryExpr | null = null;

  if (binary.left.kind === NodeKind.BinaryExpr) {
    const leftBin = binary.left as BinaryExpr;
    if (leftBin.operator === '*') {
      mulExpr = leftBin;
    }
  } else if (binary.left.kind === NodeKind.CStyleCastExpr) {
    // Cast then check inner
    const inner = (binary.left as any).expression;
    if (inner?.kind === NodeKind.BinaryExpr) {
      const innerBin = inner as BinaryExpr;
      if (innerBin.operator === '*') {
        mulExpr = innerBin;
      }
    }
  }

  if (!mulExpr) return null;

  // One side of multiplication should be the magic constant
  let magicValue: bigint | null = null;
  let variable: Expression | null = null;

  if (mulExpr.right.kind === NodeKind.IntegerLiteral) {
    magicValue = (mulExpr.right as IntegerLiteralExpr).value;
    variable = mulExpr.left;
  } else if (mulExpr.left.kind === NodeKind.IntegerLiteral) {
    magicValue = (mulExpr.left as IntegerLiteralExpr).value;
    variable = mulExpr.right;
  }

  if (magicValue === null || variable === null) return null;

  // Look up in our database
  const entry32 = UNSIGNED_MAGIC_32.get(magicValue);
  if (entry32 && entry32.shift === shift) {
    return { variable, divisor: entry32.divisor };
  }

  const entry64 = UNSIGNED_MAGIC_64.get(magicValue);
  if (entry64 && entry64.shift === shift) {
    return { variable, divisor: entry64.divisor };
  }

  // Try to reverse-engineer the divisor
  // Magic ≈ 2^shift / divisor, so divisor ≈ 2^shift / magic
  if (magicValue > 0n && shift > 0) {
    const twoToShift = 1n << BigInt(shift);
    const estimatedDivisor = Number(twoToShift / magicValue);

    // Check common divisors
    for (const d of [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 100, 1000]) {
      if (Math.abs(estimatedDivisor - d) <= 1) {
        // Verify by computing what magic should be
        const computed = computeMagic(d, 32);
        if (computed && computed.magic === magicValue && computed.shift === shift) {
          return { variable, divisor: d };
        }
      }
    }
  }

  return null;
}

// ============================================
// TRANSFORMER
// ============================================

function createMagicDivisionTransformer(): Transformer {
  return createTransformer({
    visitBinaryExpr(binary) {
      const result = detectMagicDivision(binary);
      if (!result) return undefined;

      // Create division expression
      const divisorLiteral: IntegerLiteralExpr = {
        kind: NodeKind.IntegerLiteral,
        value: BigInt(result.divisor),
        suffix: '',
        base: 10,
        raw: String(result.divisor),
        location: binary.location,
        leadingTrivia: [],
        trailingTrivia: [],
      };

      return updateNode(binary, {
        operator: '/',
        left: result.variable,
        right: divisorLiteral,
      });
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface MagicDivisionOptions extends PluginOptions {
  /** Enable 32-bit pattern detection (default: true) */
  detect32bit?: boolean;

  /** Enable 64-bit pattern detection (default: true) */
  detect64bit?: boolean;

  /** Add comment showing original pattern (default: false) */
  addComment?: boolean;
}

/**
 * Magic Division Plugin
 *
 * Transforms compiler-generated magic multiplication patterns
 * back to readable division operations.
 */
export const magicDivisionPlugin: TransformPlugin = {
  id: 'magic-division',
  name: 'Magic Division',
  description:
    'Transform magic number multiplication patterns to division (e.g., x * 0xAAAAAAAB >> 33 → x / 3)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 35, // Before loop canonicalization
  tags: ['core', 'cleanup', 'optimization'],

  createTransformer(_options?: MagicDivisionOptions) {
    return createMagicDivisionTransformer();
  },
};

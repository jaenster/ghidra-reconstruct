/**
 * CONCAT Macro Transform Plugin
 *
 * Converts Ghidra's CONCAT macros to explicit bit operations.
 *
 * Transforms:
 * - CONCAT31(high, low) → (high << 8) | low    (3 high bytes, 1 low byte)
 * - CONCAT22(high, low) → (high << 16) | low   (2 high bytes, 2 low bytes)
 * - CONCAT44(high, low) → (high << 32) | low   (4 high bytes, 4 low bytes)
 * - CONCAT11(high, low) → (high << 8) | low    (1 high byte, 1 low byte)
 * - etc.
 *
 * The pattern CONCATxy means x high bytes and y low bytes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  CallExpr,
  Identifier,
  BinaryExpr,
  BinaryOperator,
  IntegerLiteralExpr,
  ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions, InjectionTransformer, InjectionContext } from '../types.js';
import { createInlineFunction } from '../injection.js';

// ============================================
// HELPERS
// ============================================

/**
 * Create an integer literal node
 */
function createIntLiteral(value: bigint, original: ASTNode): IntegerLiteralExpr {
  return {
    kind: NodeKind.IntegerLiteral,
    value,
    raw: value.toString(),
    suffix: '',
    base: 10,
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

/**
 * Create a binary expression node
 */
function createBinaryExpr(
  left: Expression,
  operator: BinaryOperator,
  right: Expression,
  original: ASTNode
): BinaryExpr {
  return {
    kind: NodeKind.BinaryExpr,
    left,
    operator,
    right,
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

/**
 * Create a parenthesized expression
 */
function createParenExpr(expression: Expression, original: ASTNode): ParenExpr {
  return {
    kind: NodeKind.ParenExpr,
    expression,
    location: original.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

// ============================================
// TRANSFORMER
// ============================================

export interface ConcatTransformOptions extends PluginOptions {
  /**
   * Whether to wrap the result in parentheses (default: true)
   * Parentheses help ensure correct precedence
   */
  wrapInParens?: boolean;
}

/**
 * Create the CONCAT transform transformer
 */
function createConcatTransformer(options: ConcatTransformOptions = {}): Transformer {
  const { wrapInParens = true } = options;

  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Only process call expressions
      if (node.kind !== NodeKind.CallExpr) {
        return undefined;
      }

      const call = node as CallExpr;

      // Check if callee is an identifier
      if (call.callee.kind !== NodeKind.Identifier) {
        return undefined;
      }

      const callee = call.callee as Identifier;
      if (typeof callee.name !== 'string') return undefined;

      // Check for CONCAT pattern: CONCAT followed by two digits
      const match = callee.name.match(/^CONCAT(\d)(\d)$/);
      if (!match) {
        return undefined;
      }

      // Must have exactly 2 arguments
      if (!call.arguments || call.arguments.length !== 2) {
        return undefined;
      }

      const highBytes = parseInt(match[1], 10);
      const lowBytes = parseInt(match[2], 10);
      const [highArg, lowArg] = call.arguments;

      // Calculate shift amount: low bytes * 8 bits per byte
      const shiftAmount = BigInt(lowBytes * 8);

      // Build: (high << shift) | low
      const shiftLiteral = createIntLiteral(shiftAmount, node);
      const shifted = createBinaryExpr(highArg, '<<', shiftLiteral, node);
      const result = createBinaryExpr(shifted, '|', lowArg, node);

      // Optionally wrap in parentheses for precedence safety
      if (wrapInParens) {
        const parenExpr = createParenExpr(result, node);
        // Preserve trivia from original node
        parenExpr.leadingTrivia = node.leadingTrivia || [];
        parenExpr.trailingTrivia = node.trailingTrivia || [];
        return parenExpr;
      }

      // Preserve trivia from original node
      result.leadingTrivia = node.leadingTrivia || [];
      result.trailingTrivia = node.trailingTrivia || [];
      return result;
    },
  });
}

// ============================================
// INJECTION TRANSFORMER
// ============================================

/**
 * Map from total byte count to C type name
 */
function cTypeForBytes(bytes: number): string {
  switch (bytes) {
    case 1: return 'uint8_t';
    case 2: return 'uint16_t';
    case 3: return 'uint32_t'; // 3 bytes → promoted to uint32_t
    case 4: return 'uint32_t';
    case 5:
    case 6:
    case 7:
    case 8: return 'uint64_t';
    default: return 'uint64_t';
  }
}

/**
 * Generate a static inline helper for a specific CONCATxy variant
 */
function generateConcatHelper(highBytes: number, lowBytes: number): string {
  const totalBytes = highBytes + lowBytes;
  const returnType = cTypeForBytes(totalBytes);
  const highType = cTypeForBytes(highBytes);
  const lowType = cTypeForBytes(lowBytes);
  const shiftBits = lowBytes * 8;
  const name = `CONCAT${highBytes}${lowBytes}`;

  return `#ifndef ${name}\n` +
    `static inline ${returnType} ${name}(${highType} high, ${lowType} low) {\n` +
    `    return ((${returnType})high << ${shiftBits}) | (${returnType})low;\n` +
    `}\n` +
    `#endif`;
}

/**
 * Create an injection-aware CONCAT transformer.
 * Instead of expanding CONCAT calls inline, this leaves the calls intact
 * and injects static inline helper definitions into the preamble.
 */
function createConcatInjectionTransformer(
  options: ConcatTransformOptions = {}
): InjectionTransformer {
  return (node: ASTNode, context: InjectionContext): ASTNode => {
    // Walk the AST looking for CONCAT calls and inject helpers for each variant
    const visitor = createTransformer({
      visitNode(n: ASTNode): ASTNode | undefined {
        if (n.kind !== NodeKind.CallExpr) return undefined;

        const call = n as CallExpr;
        if (call.callee.kind !== NodeKind.Identifier) return undefined;

        const callee = call.callee as Identifier;
        if (typeof callee.name !== 'string') return undefined;
        const match = callee.name.match(/^CONCAT(\d)(\d)$/);
        if (!match) return undefined;
        if (!call.arguments || call.arguments.length !== 2) return undefined;

        const highBytes = parseInt(match[1], 10);
        const lowBytes = parseInt(match[2], 10);
        const name = `CONCAT${highBytes}${lowBytes}`;

        // Inject the helper function (deduplicated by ID)
        if (!context.has(`function:${name}`)) {
          context.inject(
            createInlineFunction(name, generateConcatHelper(highBytes, lowBytes), [])
          );
        }

        // Leave the call expression untouched — the helper makes it compilable
        return undefined;
      },
    });

    return visitor(node);
  };
}

// ============================================
// PLUGIN EXPORT
// ============================================

/**
 * CONCAT Macro Transform Plugin
 *
 * Converts Ghidra's CONCAT macros (CONCAT31, CONCAT22, etc.) to explicit
 * bit shift and OR operations for better readability.
 */
export const concatTransformPlugin: TransformPlugin = {
  id: 'concat-transform',
  name: 'CONCAT Macro Transform',
  description: 'Converts CONCAT macros to explicit bit shift/or operations (or injects static inline helpers when injection pipeline is active)',
  version: '2.0.0',
  defaultEnabled: true,
  priority: 20, // Early, before other transforms might modify the pattern
  tags: ['cleanup', 'ghidra', 'macros'],

  createTransformer: createConcatTransformer,
  // NOTE: Injection transformer removed — CONCAT macros are now defined in d2_platform.h.
  // The inline expansion (createTransformer) is preferred because it produces cleaner output
  // and avoids conflicts between injected static-inline helpers and platform header macros.
};

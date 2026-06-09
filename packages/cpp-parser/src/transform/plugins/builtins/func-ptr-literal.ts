/**
 * Function Pointer Literal Resolution Plugin
 *
 * Resolves hex integer literals that match known function addresses
 * to their function name identifiers.
 *
 * Transforms:
 * - 0x5011f0  →  D2WINBUTTON_HandleFormMouseEvent  (when address is in the map)
 * - _Dst->fpKey = param_7 ? 0x5011f0 : nullptr
 *   →  _Dst->fpKey = param_7 ? D2WINBUTTON_HandleFormMouseEvent : nullptr
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, BinaryExpr, Identifier, IntegerLiteralExpr } from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// Operators where an integer literal is a numeric operand, not a function pointer
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

// ============================================
// TRANSFORMER
// ============================================

function createFuncPtrLiteralTransformer(options: FuncPtrLiteralOptions): Transformer {
  const addressMap = options.functionAddressMap;
  if (!addressMap || addressMap.size === 0) {
    return createTransformer({});
  }

  // Build reverse map: function name -> original literal info
  const reverseMap = new Map<string, bigint>();
  for (const [addr, name] of addressMap) {
    reverseMap.set(name, addr);
  }

  // Track original literals by location key so we can restore them
  const replacedLiterals = new Map<string, IntegerLiteralExpr>();

  function locationKey(node: ASTNode): string {
    if (node.location) {
      return `${node.location.start.line}:${node.location.start.column}`;
    }
    return '';
  }

  function revertToLiteral(node: ASTNode): ASTNode | undefined {
    if (node.kind !== NodeKind.Identifier) return undefined;
    const ident = node as Identifier;
    const addr = reverseMap.get(ident.name);
    if (addr === undefined) return undefined;

    // This identifier was a func-ptr replacement — restore the original literal
    const key = locationKey(node);
    const cached = key ? replacedLiterals.get(key) : undefined;
    if (cached) return cached;

    // Reconstruct the literal
    const raw = '0x' + addr.toString(16);
    const literal: IntegerLiteralExpr = {
      kind: NodeKind.IntegerLiteral,
      value: addr,
      suffix: '',
      base: 16,
      raw,
      location: ident.location,
      leadingTrivia: ident.leadingTrivia ?? [],
      trailingTrivia: ident.trailingTrivia ?? [],
    };
    return literal;
  }

  return createTransformer({
    // Bottom-up: children are transformed before parents.
    // IntegerLiterals matching addresses get replaced with Identifiers first.
    visitNode(node: ASTNode) {
      if (node.kind !== NodeKind.IntegerLiteral) return undefined;

      const literal = node as IntegerLiteralExpr;
      const funcName = addressMap.get(literal.value);
      if (!funcName) return undefined;

      // Cache the original literal for potential revert
      const key = locationKey(literal);
      if (key) replacedLiterals.set(key, literal);

      const ident: Identifier = {
        kind: NodeKind.Identifier,
        name: funcName,
        location: literal.location,
        leadingTrivia: literal.leadingTrivia ?? [],
        trailingTrivia: literal.trailingTrivia ?? [],
      };

      return ident;
    },

    // After children are replaced, check if this is an arithmetic expression.
    // If so, revert any func-ptr replacements — the literal is a numeric operand.
    visitBinaryExpr(node: BinaryExpr) {
      if (!ARITHMETIC_OPS.has(node.operator)) return undefined;

      const revertedLeft = revertToLiteral(node.left);
      const revertedRight = revertToLiteral(node.right);

      if (!revertedLeft && !revertedRight) return undefined;

      return {
        ...node,
        left: (revertedLeft ?? node.left) as any,
        right: (revertedRight ?? node.right) as any,
      };
    },
  });
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface FuncPtrLiteralOptions extends PluginOptions {
  /** Map from function address (as bigint) to function name */
  functionAddressMap?: Map<bigint, string>;
}

export const funcPtrLiteralPlugin: TransformPlugin = {
  id: 'func-ptr-literal',
  name: 'Function Pointer Literal Resolution',
  description:
    'Resolve hex literals matching known function addresses to identifier references',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 95, // Late: after sbb-branchless (42) and signed-literal (30)
  tags: ['core', 'cleanup', 'readability'],

  createTransformer(options?: FuncPtrLiteralOptions) {
    return createFuncPtrLiteralTransformer(options ?? {});
  },
};

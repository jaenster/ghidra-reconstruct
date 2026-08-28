/**
 * Function Pointer Literal Resolution Plugin
 *
 * Resolves hex integer literals that match known function addresses to a
 * reference to that function.
 *
 * Transforms:
 * - 0x5011f0  →  D2Win::Button::D2WINBUTTON_HandleFormMouseEvent
 * - _Dst->fpKey = param_7 ? 0x5011f0 : nullptr
 *   →  _Dst->fpKey = param_7 ? D2Win::Button::D2WINBUTTON_HandleFormMouseEvent : nullptr
 *
 * The reference carries the namespace the function is DEFINED in, because a
 * function's address is taken from anywhere — a dispatch table in one module
 * naming a handler in another — and a bare name only resolves where the
 * definition happens to be in scope. The namespace arrives already resolved, as
 * segments: this pass renders a qualifier, it never decides one.
 *
 * A reference in the function's own namespace is not left over-qualified either:
 * `enclosing-namespace-strip` runs after this and drops whatever prefix the
 * enclosing block already opens, so a same-namespace slot still reads as the
 * bare name it always did.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  BinaryExpr,
  Identifier,
  IntegerLiteralExpr,
  QualifiedId,
  TemplateType,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// Operators where an integer literal is a numeric operand, not a function pointer
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/**
 * The function at an address, and the scope a reference to it has to name.
 *
 * `namespaceSegments` is the emitted namespace of the DEFINITION, resolved by
 * the caller and handed over already split. Empty (or absent) means the function
 * is defined at root scope and the reference is the bare name.
 */
export interface FuncPtrTarget {
  name: string;
  namespaceSegments?: readonly string[];
}

// ============================================
// TRANSFORMER
// ============================================

function createFuncPtrLiteralTransformer(options: FuncPtrLiteralOptions): Transformer {
  const addressMap = options.functionAddressMap;
  if (!addressMap || addressMap.size === 0) {
    return createTransformer({});
  }

  /**
   * Every reference this pass produced, against the literal it came from.
   * Keyed on the node itself: `transformAST` hands the visitor's own object to
   * the parent, so a parent that turns out to be arithmetic is looking at the
   * identical node and needs no positional bookkeeping to recognise it.
   */
  const produced = new Map<ASTNode, IntegerLiteralExpr>();

  function reference(literal: IntegerLiteralExpr, target: FuncPtrTarget): ASTNode {
    const name: Identifier = {
      kind: NodeKind.Identifier,
      name: target.name,
      location: literal.location,
      leadingTrivia: [],
      trailingTrivia: [],
    };

    const segments = target.namespaceSegments ?? [];
    if (segments.length === 0) {
      return {
        ...name,
        leadingTrivia: literal.leadingTrivia ?? [],
        trailingTrivia: literal.trailingTrivia ?? [],
      } as Identifier;
    }

    const qualifier: (Identifier | TemplateType)[] = segments.map(segment => ({
      kind: NodeKind.Identifier,
      name: segment,
      location: literal.location,
      leadingTrivia: [],
      trailingTrivia: [],
    } as Identifier));

    return {
      kind: NodeKind.QualifiedId,
      qualifier,
      name,
      isGlobal: false,
      location: literal.location,
      leadingTrivia: literal.leadingTrivia ?? [],
      trailingTrivia: literal.trailingTrivia ?? [],
    } as QualifiedId;
  }

  /** Undo a replacement this pass made, when the parent proves it was a number. */
  function revertToLiteral(node: ASTNode): ASTNode | undefined {
    return produced.get(node);
  }

  return createTransformer({
    // Bottom-up: children are transformed before parents.
    // IntegerLiterals matching addresses become references first.
    visitNode(node: ASTNode) {
      if (node.kind !== NodeKind.IntegerLiteral) return undefined;

      const literal = node as IntegerLiteralExpr;
      const target = addressMap.get(literal.value);
      if (!target) return undefined;

      const ref = reference(literal, target);
      produced.set(ref, literal);
      return ref;
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
  /** Map from function address (as bigint) to the function there and its scope */
  functionAddressMap?: Map<bigint, FuncPtrTarget>;
}

export const funcPtrLiteralPlugin: TransformPlugin = {
  id: 'func-ptr-literal',
  name: 'Function Pointer Literal Resolution',
  description:
    'Resolve hex literals matching known function addresses to a reference qualified by the namespace the function is defined in',
  version: '2.0.0',
  defaultEnabled: true,
  priority: 95, // Late: after sbb-branchless (42) and signed-literal (30)
  tags: ['core', 'cleanup', 'readability'],

  createTransformer(options?: FuncPtrLiteralOptions) {
    return createFuncPtrLiteralTransformer(options ?? {});
  },
};

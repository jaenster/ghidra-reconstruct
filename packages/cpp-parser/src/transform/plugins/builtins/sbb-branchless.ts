/**
 * SBB Branchless Conditional Plugin
 *
 * Transforms compiler-generated branchless conditional patterns (SBB/AND trick)
 * back to readable ternary expressions.
 *
 * x86 compilers emit `SBB reg, reg` + `AND reg, addr` to branchlessly select
 * between a value and zero. Ghidra decompiles this as:
 *
 *   -(uint32_t)(condition) & function_address
 *
 * which was originally written as:
 *
 *   condition ? function_address : nullptr
 *
 * Transforms:
 * - -(uint32_t)(x) & addr         →  x ? addr : nullptr
 * - -(uint32_t)(x != 0) & addr    →  x != 0 ? addr : nullptr
 * - (cast)(-(uint32_t)(x) & addr) →  x ? addr : nullptr  (stripping outer cast)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  UnaryExpr,
  ConditionalExpr,
  NullptrLiteralExpr,
  CStyleCastExpr,
  IntegerLiteralExpr,
  ParenExpr,
  PointerType,
} from '../../../ast/nodes.js';
import {
  createTransformer,
  type Transformer,
} from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

// ============================================
// PATTERN DETECTION
// ============================================

/**
 * Unwrap C-style casts and parentheses from expression
 */
function unwrapCastAndParens(expr: Expression): Expression {
  for (;;) {
    if (expr.kind === NodeKind.CStyleCastExpr) {
      expr = (expr as CStyleCastExpr).expression;
    } else if (expr.kind === NodeKind.ParenExpr) {
      expr = (expr as ParenExpr).expression;
    } else {
      return expr;
    }
  }
}

/**
 * Unwrap parentheses only
 */
function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

/**
 * Detect: -(uint32_t)(condition) & addr
 *
 * Returns { condition, addr } if matched, null otherwise.
 *
 * The pattern is:
 *   BinaryExpr('&',
 *     UnaryExpr('-', CStyleCastExpr(condition)),  // or just UnaryExpr('-', condition)
 *     addr_expr
 *   )
 */
function detectSbbPattern(expr: Expression): {
  condition: Expression;
  addr: Expression;
  /**
   * The masked operand with its own cast still on it. `-(uint)(c) & (uint)p`
   * has type `uint` BECAUSE of that cast; a ternary built from the stripped
   * operand has type `char *` and no longer fits where the mask did.
   */
  addrTyped: Expression;
} | null {
  // Unwrap outer parens (e.g. (uint8_t*)(expr) → the expr may be ParenExpr wrapped)
  const unwrapped = unwrapParens(expr);

  // Must be bitwise AND
  if (unwrapped.kind !== NodeKind.BinaryExpr) return null;
  const binary = unwrapped as BinaryExpr;
  if (binary.operator !== '&') return null;

  // Left side must be unary minus (possibly paren-wrapped)
  const left = unwrapParens(binary.left);
  if (left.kind !== NodeKind.UnaryExpr) return null;
  const unary = left as UnaryExpr;
  if (unary.operator !== '-') return null;

  // Right side is the address/function pointer — strip any numeric casts ((uint32_t)ptr)
  const addr = unwrapCastAndParens(binary.right);
  if (addr.kind === NodeKind.IntegerLiteral) {
    const lit = addr as IntegerLiteralExpr;
    if (lit.value === 0n) return null;
  }
  // ... but remember the spelling WITH the cast. Stripping is right for an
  // address literal — `(uint32_t)0x4fc3f0` is the same address either way, and
  // `func-ptr-literal` needs the bare literal to recognise it — and right when
  // the cast is itself a pointer cast, which the ternary reproduces. It is
  // wrong for an integer cast over a POINTER: that cast is what gave the whole
  // `&` expression its integer type, and the value flows on into an integer
  // slot that a bare pointer cannot reach.
  const rhs = unwrapParens(binary.right);
  const castIsIntegral =
    rhs.kind === NodeKind.CStyleCastExpr &&
    (rhs as CStyleCastExpr).type.kind !== NodeKind.PointerType;
  const addrTyped =
    castIsIntegral && addr.kind !== NodeKind.IntegerLiteral ? rhs : addr;

  // Extract condition from inside the negation (strip casts and parens)
  const condition = unwrapCastAndParens(unary.operand);

  // Reject trivial cases: -(0) & x or -(1) & x are not this pattern
  if (condition.kind === NodeKind.IntegerLiteral) {
    const lit = condition as IntegerLiteralExpr;
    if (lit.value === 0n || lit.value === 1n) return null;
  }

  return { condition, addr, addrTyped };
}

// ============================================
// TRANSFORMER
// ============================================

function createSbbBranchlessTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      // Case 1: Raw BinaryExpr — -(uint32_t)(x) & value
      // No pointer cast context, so false branch is 0 (not nullptr)
      if (node.kind === NodeKind.BinaryExpr) {
        const binary = node as BinaryExpr;

        // Case 1a: SBB pattern itself
        const match = detectSbbPattern(binary);
        if (match) {
          return makeTernary(node, match.condition, match.addrTyped, false);
        }

        // Case 1b: Constant folding — (cond ? offset : 0) + base → cond ? (base+offset) : base
        // This recovers the two explicit function addresses that SBB selects between.
        if (binary.operator === '+' || binary.operator === '-') {
          const lhs = unwrapParens(binary.left);
          const rhs = binary.right;
          if (
            lhs.kind === NodeKind.ConditionalExpr &&
            rhs.kind === NodeKind.IntegerLiteral
          ) {
            const ternary = lhs as ConditionalExpr;
            const base = rhs as IntegerLiteralExpr;
            const isZeroElse =
              ternary.elseExpr.kind === NodeKind.IntegerLiteral &&
              (ternary.elseExpr as IntegerLiteralExpr).value === 0n;
            if (isZeroElse && ternary.thenExpr.kind === NodeKind.IntegerLiteral) {
              const offset = ternary.thenExpr as IntegerLiteralExpr;
              const trueVal = binary.operator === '+' ? base.value + offset.value : base.value - offset.value;
              const falseVal = base.value;
              // The subtraction branch can go negative, and `BigInt.toString(16)`
              // puts the sign on the digits — `0x-1` is not a literal at all.
              const makeLit = (v: bigint): IntegerLiteralExpr => ({
                kind: NodeKind.IntegerLiteral,
                value: v,
                suffix: '',
                base: 16,
                raw: v < 0n ? '-0x' + (-v).toString(16) : '0x' + v.toString(16),
                location: node.location,
                leadingTrivia: [],
                trailingTrivia: [],
              });
              return {
                ...ternary,
                thenExpr: makeLit(trueVal),
                elseExpr: makeLit(falseVal),
                leadingTrivia: node.leadingTrivia || [],
                trailingTrivia: node.trailingTrivia || [],
              } as ConditionalExpr;
            }
          }
        }

        return undefined;
      }

      // Case 2: CStyleCastExpr wrapping the pattern — only strip and use nullptr for pointer casts.
      // Two sub-cases due to bottom-up traversal:
      //   a) The inner BinaryExpr was already transformed to a ConditionalExpr with 0 else
      //      → if cast is to pointer type: convert 0 to nullptr and strip the outer cast
      //      → otherwise: leave as-is (non-pointer cast, keep original cast and 0)
      //   b) The inner BinaryExpr is still raw → only transform if cast is to pointer type
      if (node.kind === NodeKind.CStyleCastExpr) {
        const cast = node as CStyleCastExpr;
        const castIsPointer = cast.type.kind === NodeKind.PointerType;
        // Unwrap parens: (uint8_t*)(expr) — the (expr) is a ParenExpr wrapping the real content
        const inner = unwrapParens(cast.expression);

        // Sub-case (a): inner already transformed to ternary with 0 else
        if (inner.kind === NodeKind.ConditionalExpr) {
          const ternary = inner as ConditionalExpr;
          const isZeroElse =
            ternary.elseExpr.kind === NodeKind.IntegerLiteral &&
            (ternary.elseExpr as IntegerLiteralExpr).value === 0n;
          const isNullptrElse = ternary.elseExpr.kind === NodeKind.NullptrLiteral;

          if ((isZeroElse || isNullptrElse) && castIsPointer) {
            const nullptrNode: NullptrLiteralExpr = {
              kind: NodeKind.NullptrLiteral,
              location: node.location,
              leadingTrivia: [],
              trailingTrivia: [],
            };
            // The whole expression is a POINTER here, so the integer cast the
            // inner rewrite kept — `(uint32_t)p`, which existed to give the
            // mask its width — has to come back off, or the arms disagree.
            const thenInner = unwrapParens(ternary.thenExpr);
            const thenExpr =
              thenInner.kind === NodeKind.CStyleCastExpr &&
              (thenInner as CStyleCastExpr).type.kind !== NodeKind.PointerType
                ? (thenInner as CStyleCastExpr).expression
                : ternary.thenExpr;
            return {
              ...ternary,
              thenExpr,
              elseExpr: nullptrNode,
              leadingTrivia: node.leadingTrivia || [],
              trailingTrivia: node.trailingTrivia || [],
            } as ConditionalExpr;
          }
        }

        // Sub-case (b): inner is still the raw BinaryExpr pattern — only in pointer context
        if (castIsPointer) {
          const match = detectSbbPattern(inner);
          if (!match) return undefined;
          return makeTernary(node, match.condition, match.addr, true);
        }

        return undefined;
      }

      return undefined;
    },
  });
}

function makeTernary(
  sourceNode: ASTNode,
  condition: Expression,
  addr: Expression,
  useNullptr: boolean
): ConditionalExpr {
  const falseExpr: Expression = useNullptr
    ? ({
        kind: NodeKind.NullptrLiteral,
        location: sourceNode.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as NullptrLiteralExpr)
    : ({
        kind: NodeKind.IntegerLiteral,
        value: 0n,
        suffix: '',
        base: 10,
        raw: '0',
        location: sourceNode.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as IntegerLiteralExpr);

  return {
    kind: NodeKind.ConditionalExpr,
    condition,
    thenExpr: addr,
    elseExpr: falseExpr,
    location: sourceNode.location,
    leadingTrivia: sourceNode.leadingTrivia || [],
    trailingTrivia: sourceNode.trailingTrivia || [],
  };
}

// ============================================
// PLUGIN DEFINITION
// ============================================

export interface SbbBranchlessOptions extends PluginOptions {
  // Reserved for future options
}

/**
 * SBB Branchless Conditional Plugin
 *
 * Detects the x86 SBB+AND branchless conditional pattern that Ghidra
 * decompiles as `-(uint32_t)(cond) & addr` and rewrites it as `cond ? addr : nullptr`.
 */
export const sbbBranchlessPlugin: TransformPlugin = {
  id: 'sbb-branchless',
  name: 'SBB Branchless Conditional',
  description:
    'Transform -(uint32_t)(cond) & addr → cond ? addr : nullptr (x86 SBB+AND branchless pattern)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 42, // After redundant-negation (40), before ternary-simplify (55)
  tags: ['core', 'cleanup', 'x86', 'branchless'],

  createTransformer(_options?: SbbBranchlessOptions) {
    return createSbbBranchlessTransformer();
  },
};

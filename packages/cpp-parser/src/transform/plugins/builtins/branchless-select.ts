/**
 * Branchless Select Plugin
 *
 * Transforms the compiler/decompiler "(cond - 1) & mask" branchless select
 * idiom back into a readable ternary. This is the dual of the SBB pattern
 * handled by sbb-branchless (`-(cond) & x`).
 *
 * x86 compilers materialize a boolean (0/1), do `dec` (→ 0 or -1 all-bits),
 * `and mask`, optionally `add offset`. Ghidra decompiles this as:
 *
 *   (cond - 1 & mask)            // cond ? 0 : mask
 *   (cond - 1 & mask) + offset   // cond ? offset : offset+mask
 *
 * Transforms:
 * - (C) - 1 & M          →  C ? 0 : M
 * - (C) - 1U & M         →  C ? 0 : M
 * - ((C) - 1 & M) + V    →  C ? V : (V + M)
 *   e.g. ((0x14 < n) - 1 & -21) + 0x14  →  0x14 < n ? 0x14 : -1
 *
 * `C` must be a comparison (< > <= >= == !=) or `!expr` so we never rewrite a
 * genuine bitmask on a non-boolean value.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  BinaryExpr,
  UnaryExpr,
  ConditionalExpr,
  IntegerLiteralExpr,
  ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const CMP_OPS = new Set(['<', '>', '<=', '>=', '==', '!=']);

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) {
    expr = (expr as ParenExpr).expression;
  }
  return expr;
}

/** Integer value of a literal or +/- unary-wrapped literal, else null. */
function intVal(expr: Expression): bigint | null {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.IntegerLiteral) return (e as IntegerLiteralExpr).value;
  if (e.kind === NodeKind.UnaryExpr) {
    const u = e as UnaryExpr;
    if (u.operator === '-') {
      const v = intVal(u.operand);
      return v === null ? null : -v;
    }
    if (u.operator === '+') return intVal(u.operand);
  }
  return null;
}

/** True if `expr` is a boolean-valued comparison (so the idiom is a select). */
function isComparison(expr: Expression): boolean {
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.BinaryExpr) return CMP_OPS.has((e as BinaryExpr).operator);
  if (e.kind === NodeKind.UnaryExpr) return (e as UnaryExpr).operator === '!';
  return false;
}

/** Match `(C) - 1` where C is a comparison; return C. */
function matchCondMinusOne(expr: Expression): Expression | null {
  const e = unwrapParens(expr);
  if (e.kind !== NodeKind.BinaryExpr) return null;
  const sub = e as BinaryExpr;
  if (sub.operator !== '-') return null;
  if (intVal(sub.right) !== 1n) return null;
  const cond = unwrapParens(sub.left);
  return isComparison(cond) ? cond : null;
}

/**
 * Match `(C) - 1 & M` (either operand order). Returns { cond, mask }.
 */
function matchSelect(node: BinaryExpr): { cond: Expression; mask: bigint } | null {
  if (node.operator !== '&') return null;
  // try left = (C-1), right = M
  let cond = matchCondMinusOne(node.left);
  let mask = intVal(node.right);
  if (cond !== null && mask !== null) return { cond, mask };
  // try commuted: left = M, right = (C-1)
  cond = matchCondMinusOne(node.right);
  mask = intVal(node.left);
  if (cond !== null && mask !== null) return { cond, mask };
  return null;
}

function makeLit(src: ASTNode, value: bigint): IntegerLiteralExpr {
  // 0 → "0"; negatives → decimal (-1); else hex (0x1f)
  const decimal = value <= 0n;
  return {
    kind: NodeKind.IntegerLiteral,
    value,
    suffix: '',
    base: decimal ? 10 : 16,
    raw: decimal ? value.toString(10) : '0x' + value.toString(16),
    location: src.location,
    leadingTrivia: [],
    trailingTrivia: [],
  };
}

function makeConditional(
  src: ASTNode,
  condition: Expression,
  thenExpr: Expression,
  elseExpr: Expression
): ConditionalExpr {
  return {
    kind: NodeKind.ConditionalExpr,
    condition,
    thenExpr,
    elseExpr,
    location: src.location,
    leadingTrivia: src.leadingTrivia || [],
    trailingTrivia: src.trailingTrivia || [],
  };
}

function createBranchlessSelectTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.BinaryExpr) return undefined;
      const bin = node as BinaryExpr;

      // Core: (C) - 1 & M  →  C ? 0 : M
      if (bin.operator === '&') {
        const m = matchSelect(bin);
        if (m) {
          return makeConditional(node, m.cond, makeLit(node, 0n), makeLit(node, m.mask));
        }
        return undefined;
      }

      // Offset fold (bottom-up: the & was already rewritten to `C ? 0 : M`):
      // (C ? 0 : M) + V  →  C ? V : (V + M)   (and the commuted V + (...))
      if (bin.operator === '+') {
        const tryFold = (ternSide: Expression, vSide: Expression): ConditionalExpr | undefined => {
          const tern = unwrapParens(ternSide);
          if (tern.kind !== NodeKind.ConditionalExpr) return undefined;
          const t = tern as ConditionalExpr;
          if (intVal(t.thenExpr) !== 0n) return undefined; // only our select shape (then == 0)
          const mask = intVal(t.elseExpr);
          const v = intVal(vSide);
          if (mask === null || v === null) return undefined;
          return makeConditional(node, t.condition, vSide, makeLit(node, v + mask));
        };
        return tryFold(bin.left, bin.right) ?? tryFold(bin.right, bin.left);
      }

      return undefined;
    },
  });
}

export interface BranchlessSelectOptions extends PluginOptions {
  // Reserved for future options
}

/**
 * Branchless Select Plugin
 *
 * Detects the `(cond - 1) & mask (+ offset)?` branchless-select idiom and
 * rewrites it as `cond ? offset : offset+mask` (offset defaults to 0).
 */
export const branchlessSelectPlugin: TransformPlugin = {
  id: 'branchless-select',
  name: 'Branchless Select',
  description:
    'Transform (cond - 1 & mask) + offset → cond ? offset : offset+mask (compiler branchless select)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 43, // after sbb-branchless (42), before ternary-simplify (55)
  tags: ['core', 'cleanup', 'x86', 'branchless'],

  createTransformer(_options?: BranchlessSelectOptions) {
    return createBranchlessSelectTransformer();
  },
};

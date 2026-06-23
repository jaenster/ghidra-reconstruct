/**
 * Array-Fill Collapse Plugin
 *
 * The decompiler unrolls `memset(arr, 0, n)` into a run of element assignments:
 *
 *   gObjModeTokens[0] = 0;
 *   gObjModeTokens[1] = 0;
 *   ...
 *   gObjModeTokens[7] = 0;
 *
 * (and the char variant `name[0] = '\0'; name[1] = '\0'; ...`). This collapses a
 * run of >= THRESHOLD consecutive zero-assignments to the same base, with
 * consecutive integer indices, back into a single memset:
 *
 *   memset(gObjModeTokens, 0, 8 * sizeof(gObjModeTokens[0]));
 *
 * Only zero fills (0 / '\0' / nullptr) are collapsed — those are the byte-fill
 * cases memset can represent. The base must be side-effect-free (an lvalue, no
 * calls) so evaluating it once is equivalent to N times. Partial runs
 * (`arr[3]..arr[9]`) become `memset(arr + 3, 0, 7 * sizeof(arr[0]))`.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  ExprStmt,
  AssignExpr,
  SubscriptExpr,
  ParenExpr,
  UnaryExpr,
  MemberExpr,
  IntegerLiteralExpr,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, nodesEqual, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const THRESHOLD = 4;

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** A zero-valued RHS: integer 0, char '\0', or nullptr. */
function isZero(e: Expression): boolean {
  const u = unwrap(e);
  if (u.kind === NodeKind.IntegerLiteral) return (u as IntegerLiteralExpr).value === 0n;
  if (u.kind === NodeKind.NullptrLiteral) return true;
  if (u.kind === NodeKind.CharLiteral) {
    const v = (u as { value?: unknown }).value;
    if (typeof v === 'number') return v === 0;
    if (typeof v === 'string') return v === '\0' || v === '\\0' || v === '\\x00' || v.charCodeAt(0) === 0;
  }
  return false;
}

/** Side-effect-free lvalue base (so evaluating it once == N times). No calls. */
function isSafeBase(e: Expression): boolean {
  const u = unwrap(e);
  switch (u.kind) {
    case NodeKind.Identifier:
      return true;
    case NodeKind.MemberExpr:
      return isSafeBase((u as MemberExpr).object);
    case NodeKind.UnaryExpr: {
      const un = u as UnaryExpr;
      return (un.operator === '*' || un.operator === '&') && isSafeBase(un.operand);
    }
    case NodeKind.SubscriptExpr: {
      const s = u as SubscriptExpr;
      return isSafeBase(s.array) && (s.index.kind === NodeKind.IntegerLiteral || s.index.kind === NodeKind.Identifier);
    }
    default:
      return false;
  }
}

/** Match `base[<int>] = <zero>;` → { base, idx } or null. */
function matchZeroFill(s: Statement): { base: Expression; idx: number } | null {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr) return null;
  const a = e as AssignExpr;
  if (a.operator !== '=' || !isZero(a.right)) return null;
  const lhs = unwrap(a.left);
  if (lhs.kind !== NodeKind.SubscriptExpr) return null;
  const sub = lhs as SubscriptExpr;
  const idxNode = unwrap(sub.index);
  if (idxNode.kind !== NodeKind.IntegerLiteral) return null;
  if (!isSafeBase(sub.array)) return null;
  return { base: sub.array, idx: Number((idxNode as IntegerLiteralExpr).value) };
}

/** memset(<base>[+start], 0, count * sizeof(<base>[0])); */
function makeMemset(base: Expression, startIdx: number, count: number, model: Statement): ExprStmt {
  const dest =
    startIdx === 0
      ? cloneNode(base)
      : Expr.binary(cloneNode(base), '+', Expr.intLiteral(startIdx));
  const size = Expr.binary(
    Expr.intLiteral(count),
    '*',
    Expr.sizeof(Expr.subscript(cloneNode(base), Expr.intLiteral(0)), false),
  );
  const call = Expr.call('memset', [dest, Expr.intLiteral(0), size]);
  return {
    kind: NodeKind.ExprStmt,
    expression: call,
    location: model.location,
    leadingTrivia: model.leadingTrivia || [],
    trailingTrivia: [],
  };
}

function collapseBlock(block: CompoundStmt): CompoundStmt | null {
  const s = block.statements;
  const out: Statement[] = [];
  let changed = false;
  let i = 0;
  while (i < s.length) {
    const m = matchZeroFill(s[i]);
    if (m) {
      // Extend the run: same base, consecutive ascending indices.
      let j = i + 1;
      let lastIdx = m.idx;
      while (j < s.length) {
        const m2 = matchZeroFill(s[j]);
        if (!m2 || m2.idx !== lastIdx + 1 || !nodesEqual(m2.base, m.base)) break;
        lastIdx = m2.idx;
        j++;
      }
      const count = j - i;
      if (count >= THRESHOLD) {
        out.push(makeMemset(m.base, m.idx, count, s[i]));
        changed = true;
        i = j;
        continue;
      }
    }
    out.push(s[i]);
    i++;
  }
  return changed ? updateNode(block, { statements: out }) : null;
}

function createArrayFillTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind === NodeKind.CompoundStmt) {
        return collapseBlock(node as CompoundStmt) ?? undefined;
      }
      return undefined;
    },
  });
}

export interface ArrayFillCollapseOptions extends PluginOptions {
  // Reserved for future options
}

/**
 * Array-Fill Collapse Plugin
 *
 * Collapse unrolled zero-fill assignment runs back into a single memset.
 */
export const arrayFillCollapsePlugin: TransformPlugin = {
  id: 'array-fill-collapse',
  name: 'Array-Fill Collapse',
  description: 'Collapse runs of arr[i] = 0; into a single memset(arr, 0, n * sizeof(arr[0]))',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 50,
  tags: ['core', 'readability', 'cleanup'],

  createTransformer(_options?: ArrayFillCollapseOptions) {
    return createArrayFillTransformer();
  },
};

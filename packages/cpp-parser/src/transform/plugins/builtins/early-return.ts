/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens deeply nested `if (cond) { ... } return X;` chains into early-exit
 * guard clauses, which is far more readable than the decompiler's nested style.
 *
 * Rule (applied to a block, repeatedly on its tail):
 *   {
 *     ...prefix
 *     if (C) { BODY }   // no else
 *     return X;         // immediately follows the if (the block's terminator)
 *   }
 * becomes
 *   {
 *     ...prefix
 *     if (!C) return X;
 *     BODY
 *     return X;         // only re-added if BODY can fall through
 *   }
 *
 * Applied to the user's quest-sync example this collapses a 4-deep nest into a
 * flat sequence of `if (state) return 0;` guards. Conservative: only no-`else`
 * ifs whose then-branch is a block, immediately before the terminal return, and
 * the same return value is reused — so it is semantics-preserving. Runs late so
 * it operates on already-cleaned conditions.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  Expression,
  Statement,
  CompoundStmt,
  IfStmt,
  ReturnStmt,
  BinaryExpr,
  UnaryExpr,
  ParenExpr,
} from '../../../ast/nodes.js';
import { createTransformer, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

const FLIP: Record<string, BinaryExpr['operator']> = {
  '==': '!=', '!=': '==', '<': '>=', '>': '<=', '<=': '>', '>=': '<',
};

function unwrapParens(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** Logical negation, simplified: flip relational ops, drop a leading `!`, else wrap `!(...)`. */
function invert(e: Expression): Expression {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.BinaryExpr) {
    const b = u as BinaryExpr;
    const flipped = FLIP[b.operator];
    if (flipped) return { ...b, operator: flipped, leadingTrivia: [], trailingTrivia: [] };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return (u as UnaryExpr).operand;
  }
  // wrap !(...); parenthesize binary/conditional/assignment to preserve precedence
  const needsParen =
    u.kind === NodeKind.BinaryExpr ||
    u.kind === NodeKind.ConditionalExpr ||
    u.kind === NodeKind.AssignExpr;
  const operand: Expression = needsParen
    ? ({ kind: NodeKind.ParenExpr, expression: u, location: e.location, leadingTrivia: [], trailingTrivia: [] } as ParenExpr)
    : u;
  return { kind: NodeKind.UnaryExpr, operator: '!', operand, location: e.location, leadingTrivia: [], trailingTrivia: [] } as UnaryExpr;
}

function isTerminator(s: Statement): boolean {
  return s.kind === NodeKind.ReturnStmt || s.kind === NodeKind.BreakStmt || s.kind === NodeKind.ContinueStmt;
}

/** Flatten one trailing `if (C) { BODY } return X;` into a guard + spliced body. */
function flattenOnce(block: CompoundStmt): CompoundStmt | null {
  const s = block.statements;
  const n = s.length;
  if (n < 2) return null;
  const last = s[n - 1];
  const prev = s[n - 2];
  if (last.kind !== NodeKind.ReturnStmt) return null;
  if (prev.kind !== NodeKind.IfStmt) return null;
  const ifs = prev as IfStmt;
  if (ifs.elseBranch !== null || ifs.init) return null;
  if (ifs.thenBranch.kind !== NodeKind.CompoundStmt) return null;
  const body = (ifs.thenBranch as CompoundStmt).statements;
  if (body.length === 0) return null;
  const ret = last as ReturnStmt;

  const guard: IfStmt = {
    kind: NodeKind.IfStmt,
    condition: invert(ifs.condition),
    thenBranch: cloneNode(ret),
    elseBranch: null,
    isConstexpr: false,
    location: ifs.location,
    leadingTrivia: ifs.leadingTrivia || [],
    trailingTrivia: [],
  };

  // Re-add the terminal return only if BODY can fall through to it.
  const bodyFallsThrough = !isTerminator(body[body.length - 1]);
  const tail: Statement[] = bodyFallsThrough ? [cloneNode(ret)] : [];

  return { ...block, statements: [...s.slice(0, n - 2), guard, ...body, ...tail] };
}

function createEarlyReturnTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.CompoundStmt) return undefined;
      let block = node as CompoundStmt;
      let changed = false;
      for (let i = 0; i < 128; i++) {
        const next = flattenOnce(block);
        if (!next) break;
        block = next;
        changed = true;
      }
      return changed ? block : undefined;
    },
  });
}

export interface EarlyReturnOptions extends PluginOptions {
  // Reserved for future options
}

/**
 * Early-Return (Guard Clause) Plugin
 *
 * Flattens nested `if (C) { ... } return X;` into `if (!C) return X; ...`.
 */
export const earlyReturnPlugin: TransformPlugin = {
  id: 'early-return',
  name: 'Early Return (Guard Clauses)',
  description:
    'Flatten nested if (C) { ... } return X; chains into early-exit guard clauses (if (!C) return X; ...)',
  version: '1.0.0',
  defaultEnabled: true,
  priority: 60, // late: after structural cleanups (goto-cleanup, loop passes) so conditions are clean
  tags: ['core', 'readability', 'control-flow'],

  createTransformer(_options?: EarlyReturnOptions) {
    return createEarlyReturnTransformer();
  },
};

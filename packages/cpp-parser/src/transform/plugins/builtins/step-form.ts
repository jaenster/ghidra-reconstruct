/**
 * Step forms: `x = x + 1` as `++x` / `x++`.
 *
 * An assignment's value is the new value, so the one rewrite that keeps it in every context is
 * the PREFIX form: `(n = n - 1) >= 0` is `--n >= 0`, never `n-- >= 0` (that tests the old
 * value; GenDecodeTabs read pBitsTable[-1] through it). The postfix form is the same program
 * only where the value is thrown away: an expression statement, a for-increment, the left
 * operand of a comma, a `(void)` cast, an arm of a conditional whose value is thrown away.
 *
 * A rewriter calls `stepExpr` for each step it makes (a prefix node, remembered), and runs its
 * result through `settleSteps`, which turns the remembered steps whose value is discarded into
 * the postfix form the tree prints for a plain `i++;`. Steps it did not make are left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CommaExpr, ConditionalExpr, CStyleCastExpr, Expression, ExprStmt, ForStmt, ParenExpr, UnaryExpr,
} from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import type { Transformer } from '../../transformer.js';

export type StepSet = WeakSet<ASTNode>;

/** `++operand` / `--operand`, remembered in `made`, carrying the trivia and location of `like`. */
export function stepExpr(operand: Expression, operator: '++' | '--', like: ASTNode, made: StepSet): UnaryExpr {
  const u: UnaryExpr = {
    kind: NodeKind.UnaryExpr,
    operator,
    operand,
    location: like.location,
    leadingTrivia: like.leadingTrivia || [],
    trailingTrivia: like.trailingTrivia || [],
  };
  made.add(u);
  return u;
}

/** `a, b`: the parser's comma is a binary `,`. */
function isComma(e: Expression): boolean {
  return e.kind === NodeKind.BinaryExpr && ((e as BinaryExpr).operator as string) === ',';
}

function isVoidCast(e: Expression): boolean {
  if (e.kind !== NodeKind.CStyleCastExpr) return false;
  const t = (e as CStyleCastExpr).type as { kind?: NodeKind; name?: string } | undefined;
  return t?.kind === NodeKind.BuiltinType && t.name === 'void';
}

/**
 * Turn the steps in `made` whose value is discarded into postfix steps (in place: the nodes are
 * the rewriter's own). Everything else keeps the prefix form, which reads the new value.
 */
export function settleSteps(root: ASTNode, made: StepSet): void {
  const seen = new Set<ASTNode>();
  const expr = (e: Expression | null | undefined, discarded: boolean): void => {
    if (!e) return;
    if (discarded) {
      if (made.has(e)) {
        (e as unknown as { kind: NodeKind }).kind = NodeKind.PostfixExpr;
        visit((e as UnaryExpr).operand);
        return;
      }
      switch (e.kind) {
        case NodeKind.ParenExpr:
          expr((e as ParenExpr).expression, true);
          return;
        case NodeKind.CommaExpr:
          (e as CommaExpr).expressions.forEach((x) => expr(x, true));
          return;
        case NodeKind.BinaryExpr:
          if (isComma(e)) {
            expr((e as BinaryExpr).left, true);
            expr((e as BinaryExpr).right, true);
            return;
          }
          break;
        case NodeKind.ConditionalExpr: {
          const c = e as ConditionalExpr;
          expr(c.condition, false);
          expr(c.thenExpr, true);
          expr(c.elseExpr, true);
          return;
        }
        default:
          if (isVoidCast(e)) {
            expr((e as CStyleCastExpr).expression, true);
            return;
          }
      }
    } else if (e.kind === NodeKind.CommaExpr) {
      // Every operand but the last is discarded; the last is the comma's value.
      const xs = (e as CommaExpr).expressions;
      xs.forEach((x, i) => expr(x, i < xs.length - 1));
      return;
    } else if (isComma(e)) {
      expr((e as BinaryExpr).left, true);
      expr((e as BinaryExpr).right, false);
      return;
    }
    visit(e);
  };
  const visit = (n: ASTNode): void => {
    if (seen.has(n)) return;
    seen.add(n);
    if (n.kind === NodeKind.ExprStmt) {
      expr((n as ExprStmt).expression, true);
      return;
    }
    if (n.kind === NodeKind.ForStmt) {
      const f = n as ForStmt;
      if (f.init) visit(f.init);
      expr(f.condition, false);
      expr(f.increment, true);
      visit(f.body);
      return;
    }
    for (const k of getChildren(n)) {
      if (k.kind === NodeKind.CommaExpr || isComma(k as Expression)) expr(k as Expression, false);
      else visit(k);
    }
  };
  visit(root);
}

/** A transformer whose steps (made through `stepExpr` into `made`) are settled after it runs. */
export function settlingSteps(made: StepSet, inner: Transformer): Transformer {
  return (node: ASTNode) => {
    const out = inner(node);
    settleSteps(out, made);
    return out;
  };
}

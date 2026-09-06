/**
 * Entry points of a region: the two ways control gets in without falling through.
 *
 * A `goto` target and a `case` label are the same thing to the machine, and any pass that
 * proposes deleting a span has to treat them the same. They are not the same in the tree,
 * which is why every hand-written "is anything jumping in here?" predicate so far has
 * checked labels and forgotten cases.
 */

import { NodeKind } from '../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, DoWhileStmt, ForRangeStmt, ForStmt, GotoStmt, IfStmt,
  LabelStmt, Statement, TryStmt, WhileStmt,
} from '../../ast/nodes.js';
import { traverseAST } from '../../ast/visitor.js';

/** Every label name defined anywhere in these statements, at any depth. */
export function collectLabelNames(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const s of stmts) {
    for (const n of traverseAST(s as ASTNode)) {
      if (n.kind === NodeKind.LabelStmt) names.add((n as LabelStmt).label.name);
    }
  }
  return names;
}

/** How many `goto`s these statements contain, per target label. */
export function countGotoTargets(stmts: Statement[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of stmts) {
    for (const n of traverseAST(s as ASTNode)) {
      if (n.kind === NodeKind.GotoStmt) {
        const name = (n as GotoStmt).label.name;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * True when these statements contain a `case`/`default` whose `switch` is NOT among them.
 *
 * Such a label is dispatched to from outside, so the span is reachable however
 * unreachable it looks by fallthrough. A whole switch sitting inside the span is fine —
 * its own cases belong to it.
 */
export function containsForeignCaseLabel(stmts: Statement[]): boolean {
  for (const s of stmts) if (scanForForeignCase(s)) return true;
  return false;
}

function scanForForeignCase(s: Statement): boolean {
  if (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) return true;
  // A switch owns every case below it, so stop: those belong to it, not to us.
  if (s.kind === NodeKind.SwitchStmt) return false;
  for (const kid of statementChildren(s)) {
    if (scanForForeignCase(kid)) return true;
  }
  return false;
}

/**
 * Statement children of `s`, in source order.
 *
 * Expressions are not descended into: a `case` label cannot appear inside one. Spelled
 * out per kind rather than by probing field names, so a node shape that changes breaks
 * the build instead of quietly making a case label invisible to the scan.
 */
function statementChildren(s: Statement): Statement[] {
  switch (s.kind) {
    case NodeKind.CompoundStmt:
      return (s as CompoundStmt).statements;
    case NodeKind.IfStmt: {
      const n = s as IfStmt;
      const kids = n.init ? [n.init, n.thenBranch] : [n.thenBranch];
      return n.elseBranch ? [...kids, n.elseBranch] : kids;
    }
    case NodeKind.LabelStmt:
      return [(s as LabelStmt).statement];
    case NodeKind.WhileStmt:
      return [(s as WhileStmt).body];
    case NodeKind.DoWhileStmt:
      return [(s as DoWhileStmt).body];
    case NodeKind.ForStmt: {
      const n = s as ForStmt;
      return n.init ? [n.init, n.body] : [n.body];
    }
    case NodeKind.ForRangeStmt:
      return [(s as ForRangeStmt).body];
    case NodeKind.TryStmt: {
      const n = s as TryStmt;
      return [n.body, ...n.handlers.map(h => h.body as Statement)];
    }
    default:
      return [];
  }
}

/**
 * True when control can enter `span` other than by falling into its first statement.
 *
 * `outerGotoCounts` are the whole-function goto counts; without them any label at all
 * counts as entered, which is the safe answer.
 */
export function spanIsEnterable(
  span: Statement[],
  outerGotoCounts: Map<string, number> | null,
): boolean {
  if (containsForeignCaseLabel(span)) return true;

  const defined = collectLabelNames(span);
  if (defined.size === 0) return false;
  if (!outerGotoCounts) return true;

  const inside = countGotoTargets(span);
  for (const name of defined) {
    if ((outerGotoCounts.get(name) ?? 0) > (inside.get(name) ?? 0)) return true;
  }
  return false;
}

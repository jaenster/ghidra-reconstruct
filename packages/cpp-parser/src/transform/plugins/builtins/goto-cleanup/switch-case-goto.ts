/**
 * Switch case-to-case goto inlining.
 *
 * Handles `goto switchD_xxx_caseD_N` inside switch cases where the
 * label is in another case of the same switch. Extracts the target
 * case's tail and inlines it at each goto site.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  GotoStmt,
  LabelStmt,
  Statement,
  SwitchStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import { traverseAST } from '../../../../ast/visitor.js';
import { MAX_INLINE_TAIL_SIZE } from './types.js';
import { deepCloneStatements, isSimpleLabelName } from './helpers.js';
import { countGotosToLabel } from './cross-scope.js';
import { inlineGotoInNestedStmt } from './tail-inline.js';

/**
 * Check if a label name is a switch-case label (switchD_xxx_caseD_N).
 */
function isSwitchCaseLabel(name: string): boolean {
  return name.startsWith('switchD_') && name.includes('_caseD_');
}

/**
 * Extract the tail starting from a label in a switch body compound,
 * up to (and including) the next break/return at the compound level.
 */
function extractSwitchCaseTail(
  stmts: Statement[],
  labelIndex: number,
): { tail: Statement[]; endsWithBreak: boolean; endsWithReturn: boolean } | null {
  const labelStmt = stmts[labelIndex] as LabelStmt;
  const tail: Statement[] = [labelStmt.statement];

  for (let i = labelIndex + 1; i < stmts.length; i++) {
    const stmt = stmts[i];
    // Stop before next case/default
    if (stmt.kind === NodeKind.CaseStmt || stmt.kind === NodeKind.DefaultStmt) {
      break;
    }
    tail.push(stmt);
    // Stop after break or return (inclusive)
    if (stmt.kind === NodeKind.BreakStmt) {
      return { tail, endsWithBreak: true, endsWithReturn: false };
    }
    if (stmt.kind === NodeKind.ReturnStmt) {
      return { tail, endsWithBreak: false, endsWithReturn: true };
    }
  }

  // Tail doesn't end with break/return — check if it ends in a compound
  // whose last statement is a break/return
  if (tail.length > 0) {
    const last = tail[tail.length - 1];
    if (last.kind === NodeKind.CompoundStmt) {
      const body = (last as CompoundStmt).statements;
      if (body.length > 0) {
        const lastInner = body[body.length - 1];
        if (lastInner.kind === NodeKind.BreakStmt) {
          return { tail, endsWithBreak: true, endsWithReturn: false };
        }
        if (lastInner.kind === NodeKind.ReturnStmt) {
          return { tail, endsWithBreak: false, endsWithReturn: true };
        }
      }
    }
  }

  return null; // No clean terminator found
}

/**
 * Strip a label wrapper from within a switch body compound's statements.
 */
function stripLabelFromSwitchBody(stmts: Statement[], labelName: string): Statement[] {
  const result: Statement[] = [];
  for (const stmt of stmts) {
    if (stmt.kind === NodeKind.LabelStmt && (stmt as LabelStmt).label.name === labelName) {
      // Replace label with its inner statement
      result.push((stmt as LabelStmt).statement);
    } else if (stmt.kind === NodeKind.CaseStmt) {
      const cs = stmt as CaseStmt;
      if (cs.statement.kind === NodeKind.LabelStmt
          && (cs.statement as LabelStmt).label.name === labelName) {
        result.push(updateNode(cs, { statement: (cs.statement as LabelStmt).statement }));
      } else {
        result.push(stmt);
      }
    } else if (stmt.kind === NodeKind.DefaultStmt) {
      const ds = stmt as DefaultStmt;
      if (ds.statement.kind === NodeKind.LabelStmt
          && (ds.statement as LabelStmt).label.name === labelName) {
        result.push(updateNode(ds, { statement: (ds.statement as LabelStmt).statement }));
      } else {
        result.push(stmt);
      }
    } else {
      result.push(stmt);
    }
  }
  return result;
}

/**
 * Count all gotos to a label within an array of statements (recursive).
 */
function countGotosInArray(stmts: Statement[], labelName: string): number {
  let count = 0;
  for (const stmt of stmts) {
    for (const node of traverseAST(stmt as ASTNode)) {
      if (node.kind === NodeKind.GotoStmt && (node as GotoStmt).label.name === labelName) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Process a single switch statement for case-to-case goto inlining.
 * Returns modified switch or null if no changes.
 */
function processSingleSwitch(sw: SwitchStmt): SwitchStmt | null {
  if (sw.body.kind !== NodeKind.CompoundStmt) return null;
  const bodyStmts = (sw.body as CompoundStmt).statements;

  // Find all switchD_*_caseD_* labels in the switch body
  for (let i = 0; i < bodyStmts.length; i++) {
    let labelName: string | null = null;
    let labelIndex = i;

    // Label directly in switch body compound
    if (bodyStmts[i].kind === NodeKind.LabelStmt) {
      const ls = bodyStmts[i] as LabelStmt;
      if (isSwitchCaseLabel(ls.label.name)) {
        labelName = ls.label.name;
      }
    }
    // Label as first statement of a case/default
    if (bodyStmts[i].kind === NodeKind.CaseStmt) {
      const cs = bodyStmts[i] as CaseStmt;
      if (cs.statement.kind === NodeKind.LabelStmt) {
        const ls = cs.statement as LabelStmt;
        if (isSwitchCaseLabel(ls.label.name)) {
          labelName = ls.label.name;
        }
      }
    }
    if (bodyStmts[i].kind === NodeKind.DefaultStmt) {
      const ds = bodyStmts[i] as DefaultStmt;
      if (ds.statement.kind === NodeKind.LabelStmt) {
        const ls = ds.statement as LabelStmt;
        if (isSwitchCaseLabel(ls.label.name)) {
          labelName = ls.label.name;
        }
      }
    }

    if (!labelName) continue;

    // Count gotos to this label inside the switch
    const switchGotoCount = countGotosInArray(bodyStmts, labelName);
    if (switchGotoCount === 0) continue;

    // Extract the tail at the target label
    const extracted = extractSwitchCaseTail(bodyStmts, labelIndex);
    if (!extracted) continue;

    const { tail, endsWithBreak, endsWithReturn } = extracted;
    if (tail.length === 0 || tail.length > MAX_INLINE_TAIL_SIZE) continue;

    // Check tail doesn't contain escaping gotos
    const tailLabels = new Set<string>();
    const tailGotos = new Set<string>();
    for (const s of tail) {
      for (const node of traverseAST(s as ASTNode)) {
        if (node.kind === NodeKind.LabelStmt) tailLabels.add((node as LabelStmt).label.name);
        if (node.kind === NodeKind.GotoStmt) tailGotos.add((node as GotoStmt).label.name);
      }
    }
    const hasEscapingGoto = [...tailGotos].some(g => !tailLabels.has(g));
    if (hasEscapingGoto) continue;

    // Inline all gotos to this label in the switch body
    let newStmts: Statement[] = [];
    let inlined = false;

    for (const stmt of bodyStmts) {
      // Direct goto at switch body level
      if (stmt.kind === NodeKind.GotoStmt && (stmt as GotoStmt).label.name === labelName) {
        newStmts.push(...deepCloneStatements(tail));
        inlined = true;
        continue;
      }
      // Recursively inline in nested scopes (case bodies, if branches, etc.)
      const replaced = inlineGotoInNestedStmt(stmt, labelName, tail);
      if (replaced !== stmt) {
        newStmts.push(replaced);
        inlined = true;
      } else {
        newStmts.push(stmt);
      }
    }

    if (!inlined) continue;

    // Verify all gotos were inlined
    const remaining = countGotosInArray(newStmts, labelName);
    if (remaining > 0) continue;

    // Strip the label wrapper
    newStmts = stripLabelFromSwitchBody(newStmts, labelName);

    const newBody = updateNode(sw.body as CompoundStmt, { statements: newStmts });
    return updateNode(sw, { body: newBody });
  }

  return null;
}

/**
 * Process switch case-to-case gotos in a compound statement.
 * Finds switch statements containing case-to-case gotos and inlines the target tails.
 * Returns modified statements or null if no changes.
 */
export function handleSwitchCaseGoto(
  stmts: Statement[],
  gotoCounts: Map<string, number>,
): Statement[] | null {
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    if (stmt.kind !== NodeKind.SwitchStmt) continue;

    const sw = stmt as SwitchStmt;
    const result = processSingleSwitch(sw);
    if (result) {
      // Verify no gotos from outside the switch target these labels
      // (the labels should only be referenced from within the same switch)
      const newStmts = [...stmts];
      newStmts[i] = result;
      return newStmts;
    }
  }

  return null;
}

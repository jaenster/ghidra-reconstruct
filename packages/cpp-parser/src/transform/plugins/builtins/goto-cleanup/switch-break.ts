/**
 * Switch goto-to-break recovery.
 *
 * Detects `goto LAB_xxx` inside switch cases where the label is right
 * after the switch, and replaces them with `break`.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  GotoStmt,
  LabelStmt,
  Statement,
  SwitchStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import type { LabelInfo } from './types.js';
import { isSimpleLabelName, createBreakStmt } from './helpers.js';
import { countGotosToLabel } from './cross-scope.js';

/**
 * Detect and replace switch gotos targeting a post-switch label with break.
 * Returns modified statements or null if no changes.
 */
export function handleSwitchGotoToBreak(
  stmts: Statement[],
  labels: Map<string, LabelInfo>,
  gotoCounts: Map<string, number>,
): Statement[] | null {
  let current = stmts;
  let modified = false;

  for (let i = 0; i < current.length; i++) {
    const stmt = current[i];
    if (stmt.kind !== NodeKind.SwitchStmt) continue;
    const sw = stmt as SwitchStmt;

    // Look for a label right after the switch
    for (let j = i + 1; j < current.length; j++) {
      if (current[j].kind !== NodeKind.LabelStmt) break;
      const labelStmt = current[j] as LabelStmt;
      const labelName = labelStmt.label.name;
      if (!isSimpleLabelName(labelName)) continue;

      // Count gotos to this label inside the switch
      const switchGotoCount = countGotosToLabel(sw, labelName);
      if (switchGotoCount === 0) continue;

      // Only transform if ALL gotos to this label are inside the switch
      const totalGotos = gotoCounts.get(labelName) ?? 0;
      if (switchGotoCount !== totalGotos) continue;

      // Replace gotos with break in the switch body
      const newSwitch = replaceSwitchGotosWithBreak(sw, labelName);
      if (newSwitch === sw) continue; // nothing changed

      // Remove the label (inline its statement)
      const newStmts = [...current];
      newStmts[i] = newSwitch;
      // Replace label with its tail statements
      newStmts.splice(j, 1, labelStmt.statement);
      current = newStmts;
      modified = true;
      break;
    }
  }

  return modified ? current : null;
}

/**
 * Replace all `goto L` with `break` inside a switch body.
 * Handles gotos both inside case/default statements AND as direct children
 * of the switch compound (due to parser representing `case N: stmt; goto L;`
 * as CaseStmt{stmt} followed by a bare GotoStmt in the compound).
 */
function replaceSwitchGotosWithBreak(sw: SwitchStmt, label: string): SwitchStmt {
  const body = sw.body;
  if (body.kind !== NodeKind.CompoundStmt) return sw;
  const stmts = (body as CompoundStmt).statements;
  let changed = false;

  const newStmts = stmts.map(s => {
    // Handle gotos directly in the switch compound body (fall-through style)
    if (s.kind === NodeKind.GotoStmt && (s as GotoStmt).label.name === label) {
      changed = true;
      return createBreakStmt(s);
    }
    if (s.kind === NodeKind.CaseStmt) {
      const cs = s as CaseStmt;
      const newBody = replaceGotoWithBreakInStmt(cs.statement, label);
      if (newBody !== cs.statement) {
        changed = true;
        return updateNode(cs, { statement: newBody });
      }
    }
    if (s.kind === NodeKind.DefaultStmt) {
      const ds = s as DefaultStmt;
      const newBody = replaceGotoWithBreakInStmt(ds.statement, label);
      if (newBody !== ds.statement) {
        changed = true;
        return updateNode(ds, { statement: newBody });
      }
    }
    return s;
  });

  if (!changed) return sw;
  const newBody = updateNode(body as CompoundStmt, { statements: newStmts });
  return updateNode(sw, { body: newBody });
}

/**
 * Replace terminal `goto L` with `break` in a statement.
 */
function replaceGotoWithBreakInStmt(stmt: Statement, label: string): Statement {
  if (stmt.kind === NodeKind.GotoStmt) {
    if ((stmt as GotoStmt).label.name === label) {
      return createBreakStmt(stmt);
    }
    return stmt;
  }

  if (stmt.kind === NodeKind.CompoundStmt) {
    const compound = stmt as CompoundStmt;
    if (compound.statements.length === 0) return stmt;
    const last = compound.statements[compound.statements.length - 1];
    const replaced = replaceGotoWithBreakInStmt(last, label);
    if (replaced === last) return stmt;
    return updateNode(compound, {
      statements: [...compound.statements.slice(0, -1), replaced],
    });
  }

  return stmt;
}

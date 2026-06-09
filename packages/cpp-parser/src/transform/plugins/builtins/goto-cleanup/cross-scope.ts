/**
 * Cross-scope terminal goto detection and stripping.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  GotoStmt,
  IfStmt,
  Statement,
  SwitchStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import { traverseAST } from '../../../../ast/visitor.js';
import { createNullStmt } from './helpers.js';

/**
 * Count how many goto nodes targeting a specific label exist within a statement tree.
 */
export function countGotosToLabel(stmt: Statement, label: string): number {
  let count = 0;
  for (const node of traverseAST(stmt as ASTNode)) {
    if (node.kind === NodeKind.GotoStmt && (node as GotoStmt).label.name === label) {
      count++;
    }
  }
  return count;
}

/**
 * Check if ALL execution paths through a statement end with `goto label`.
 */
export function alwaysTerminatesWithGoto(stmt: Statement, label: string): boolean {
  if (stmt.kind === NodeKind.GotoStmt) {
    return (stmt as GotoStmt).label.name === label;
  }

  if (stmt.kind === NodeKind.CompoundStmt) {
    const body = (stmt as CompoundStmt).statements;
    if (body.length === 0) return false;
    return alwaysTerminatesWithGoto(body[body.length - 1], label);
  }

  if (stmt.kind === NodeKind.IfStmt) {
    const ifStmt = stmt as IfStmt;
    if (!ifStmt.elseBranch) return false;
    return alwaysTerminatesWithGoto(ifStmt.thenBranch, label) &&
           alwaysTerminatesWithGoto(ifStmt.elseBranch, label);
  }

  if (stmt.kind === NodeKind.SwitchStmt) {
    return switchAlwaysTerminatesWithGoto(stmt as SwitchStmt, label);
  }

  return false;
}

/**
 * Check if a switch statement always terminates with goto to `label`.
 * Requires: default case exists, and every case/default terminates with goto L.
 */
function switchAlwaysTerminatesWithGoto(sw: SwitchStmt, label: string): boolean {
  const body = sw.body;
  if (body.kind !== NodeKind.CompoundStmt) return false;
  const stmts = (body as CompoundStmt).statements;

  let hasDefault = false;
  for (const s of stmts) {
    if (s.kind === NodeKind.DefaultStmt) hasDefault = true;
    if (s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt) {
      const caseBody = s.kind === NodeKind.CaseStmt
        ? (s as CaseStmt).statement
        : (s as DefaultStmt).statement;
      if (!alwaysTerminatesWithGoto(caseBody, label)) return false;
    }
  }
  return hasDefault;
}

/**
 * Strip terminal `goto label` from a statement, returning modified statement or null if empty.
 */
export function stripTerminalGoto(stmt: Statement, label: string): Statement | null {
  if (stmt.kind === NodeKind.GotoStmt) {
    if ((stmt as GotoStmt).label.name === label) return null;
    return stmt;
  }

  if (stmt.kind === NodeKind.CompoundStmt) {
    const body = (stmt as CompoundStmt).statements;
    if (body.length === 0) return stmt;
    const lastStripped = stripTerminalGoto(body[body.length - 1], label);
    const newStmts = lastStripped
      ? [...body.slice(0, -1), lastStripped]
      : body.slice(0, -1);
    if (newStmts.length === 0) return null;
    return updateNode(stmt as CompoundStmt, { statements: newStmts });
  }

  if (stmt.kind === NodeKind.IfStmt) {
    const ifStmt = stmt as IfStmt;
    if (!ifStmt.elseBranch) return stmt;
    const strippedThen = stripTerminalGoto(ifStmt.thenBranch, label);
    const strippedElse = stripTerminalGoto(ifStmt.elseBranch, label);
    return updateNode(ifStmt, {
      thenBranch: strippedThen ?? createNullStmt(ifStmt),
      elseBranch: strippedElse ?? createNullStmt(ifStmt),
    });
  }

  if (stmt.kind === NodeKind.SwitchStmt) {
    return stripGotosFromSwitch(stmt as SwitchStmt, label);
  }

  return stmt;
}

/**
 * Strip gotos from all cases/default in a switch, replacing with break.
 */
function stripGotosFromSwitch(sw: SwitchStmt, label: string): Statement {
  const body = sw.body;
  if (body.kind !== NodeKind.CompoundStmt) return sw;
  const stmts = (body as CompoundStmt).statements;

  const newStmts = stmts.map(s => {
    if (s.kind === NodeKind.CaseStmt) {
      const cs = s as CaseStmt;
      const stripped = stripTerminalGoto(cs.statement, label);
      return updateNode(cs, { statement: stripped ?? createNullStmt(cs) });
    }
    if (s.kind === NodeKind.DefaultStmt) {
      const ds = s as DefaultStmt;
      const stripped = stripTerminalGoto(ds.statement, label);
      return updateNode(ds, { statement: stripped ?? createNullStmt(ds) });
    }
    return s;
  });

  const newBody = updateNode(body as CompoundStmt, { statements: newStmts });
  return updateNode(sw, { body: newBody });
}

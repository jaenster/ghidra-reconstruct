/**
 * Cleanup tail inlining.
 *
 * Inlines short cleanup/error tails at every goto site,
 * handling the common pattern where multiple gotos jump to a shared
 * error handler or cleanup label near the end of the function.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  DoWhileStmt,
  ForStmt,
  GotoStmt,
  IfStmt,
  LabelStmt,
  Statement,
  SwitchStmt,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import { traverseAST } from '../../../../ast/visitor.js';
import type { LabelInfo, LabelKind, RequiredGotoCleanupOptions } from './types.js';
import { MAX_INLINE_TAIL_SIZE } from './types.js';
import { deepCloneStatement, deepCloneStatements } from './helpers.js';
import { countGotosInStatements } from './analysis.js';

/**
 * Check if a statement can fall through to the next one
 * (i.e., does NOT always terminate via return/break/continue/goto).
 */
function canFallThrough(stmt: Statement): boolean {
  switch (stmt.kind) {
    case NodeKind.ReturnStmt:
    case NodeKind.BreakStmt:
    case NodeKind.ContinueStmt:
    case NodeKind.GotoStmt:
      return false;
    case NodeKind.CompoundStmt: {
      const body = (stmt as CompoundStmt).statements;
      if (body.length === 0) return true;
      return canFallThrough(body[body.length - 1]);
    }
    case NodeKind.IfStmt: {
      const ifStmt = stmt as IfStmt;
      if (!ifStmt.elseBranch) return true;
      return canFallThrough(ifStmt.thenBranch) || canFallThrough(ifStmt.elseBranch);
    }
    default:
      return true;
  }
}

export function createReturnStmt(anchor: Statement): Statement {
  return {
    kind: NodeKind.ReturnStmt,
    value: null,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as Statement;
}

/**
 * Inline short cleanup/error tails at every goto site.
 *
 * Only inlines when:
 * - Tail is short (≤ MAX_INLINE_TAIL_SIZE statements)
 * - Tail ends with return or noreturn call
 * - Tail contains no gotos or labels itself
 */
export function processCleanupTailInlining(
  stmts: Statement[],
  labels: Map<string, LabelInfo>,
  gotoCounts: Map<string, number>,
  options: RequiredGotoCleanupOptions,
): Statement[] | null {
  // Process labels from last to first (so removal doesn't shift earlier indices)
  const labelEntries = [...labels.values()].sort((a, b) => b.index - a.index);

  for (const labelInfo of labelEntries) {
    const totalGotos = gotoCounts.get(labelInfo.name) ?? 0;
    if (totalGotos === 0) continue;

    const tail = labelInfo.tailStatements;

    // Check tail is inlineable: short and ends with return/noreturn
    if (tail.length === 0 || tail.length > MAX_INLINE_TAIL_SIZE) continue;
    if (labelInfo.kind !== 'exit-return' && labelInfo.kind !== 'cleanup-return'
        && labelInfo.kind !== 'exit-noreturn' && labelInfo.kind !== 'cleanup-fallthrough') continue;

    // Check tail doesn't contain gotos/labels that escape the tail.
    // Self-contained tails (all gotos target labels within the tail) are allowed.
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

    // Try to inline all gotos to this label
    const result = inlineAllGotosToLabel(stmts, labelInfo.name, tail, labelInfo.index, labelInfo.kind);
    if (result) return result;
  }

  return null;
}

/**
 * Replace every `goto L` in the compound with the inlined tail,
 * and remove the label + tail from the compound.
 */
function inlineAllGotosToLabel(
  stmts: Statement[],
  labelName: string,
  tail: Statement[],
  labelIndex: number,
  kind: LabelKind,
): Statement[] | null {
  // For cleanup-fallthrough, build a tail with explicit return appended
  // for use in nested contexts (where fallthrough doesn't mean "end of function")
  const tailWithReturn = kind === 'cleanup-fallthrough'
    ? [...tail, createReturnStmt(tail[tail.length - 1])]
    : tail;
  const newStmts: Statement[] = [];
  let modified = false;

  for (let i = 0; i < stmts.length; i++) {
    // At the label position: remove the label itself, but keep the tail
    // if code can fall through to it from the preceding statement.
    if (i === labelIndex) {
      modified = true;
      if (newStmts.length > 0 && canFallThrough(newStmts[newStmts.length - 1])) {
        newStmts.push(...deepCloneStatements(tail));
      }
      break;
    }

    const stmt = stmts[i];

    // Direct goto at compound level → expand to tail statements
    if (stmt.kind === NodeKind.GotoStmt && (stmt as GotoStmt).label.name === labelName) {
      newStmts.push(...deepCloneStatements(tail));
      modified = true;
      continue;
    }

    // Recursively process nested statements (use tailWithReturn for nested scopes)
    const replaced = inlineGotoInNestedStmt(stmt, labelName, tailWithReturn);
    if (replaced !== stmt) {
      newStmts.push(replaced);
      modified = true;
    } else {
      newStmts.push(stmt);
    }
  }

  if (!modified) return null;

  // Safety: verify all gotos to this label were actually inlined.
  // If any remain (e.g., inside node types we don't recurse into), bail out.
  const remainingGotos = countGotosInStatements(newStmts).get(labelName) ?? 0;
  if (remainingGotos > 0) return null;

  return newStmts;
}

/**
 * Recursively replace `goto L` with inline tail in nested statements.
 * For gotos that are a direct child (not in a compound), wraps tail in a CompoundStmt.
 * For gotos inside compounds, expands inline.
 */
export function inlineGotoInNestedStmt(stmt: Statement, labelName: string, tail: Statement[]): Statement {
  // Direct goto → wrap tail in compound (since we're replacing one statement)
  if (stmt.kind === NodeKind.GotoStmt && (stmt as GotoStmt).label.name === labelName) {
    if (tail.length === 1) return deepCloneStatement(tail[0]);
    return {
      kind: NodeKind.CompoundStmt,
      statements: deepCloneStatements(tail),
      location: stmt.location,
      leadingTrivia: stmt.leadingTrivia ?? [],
      trailingTrivia: stmt.trailingTrivia ?? [],
    } as CompoundStmt;
  }

  // Compound: expand gotos inline
  if (stmt.kind === NodeKind.CompoundStmt) {
    const compound = stmt as CompoundStmt;
    const newBody: Statement[] = [];
    let changed = false;
    for (const s of compound.statements) {
      if (s.kind === NodeKind.GotoStmt && (s as GotoStmt).label.name === labelName) {
        newBody.push(...deepCloneStatements(tail));
        changed = true;
      } else {
        const r = inlineGotoInNestedStmt(s, labelName, tail);
        if (r !== s) changed = true;
        newBody.push(r !== s ? r : s);
      }
    }
    if (!changed) return stmt;
    return updateNode(compound, { statements: newBody });
  }

  // IfStmt: process both branches
  if (stmt.kind === NodeKind.IfStmt) {
    const ifStmt = stmt as IfStmt;
    const newThen = inlineGotoInNestedStmt(ifStmt.thenBranch, labelName, tail);
    const newElse = ifStmt.elseBranch ? inlineGotoInNestedStmt(ifStmt.elseBranch, labelName, tail) : null;
    if (newThen === ifStmt.thenBranch && newElse === ifStmt.elseBranch) return stmt;
    const updates: Record<string, unknown> = { thenBranch: newThen };
    if (newElse !== ifStmt.elseBranch) updates.elseBranch = newElse;
    return updateNode(ifStmt, updates);
  }

  // Loop bodies
  if (stmt.kind === NodeKind.DoWhileStmt) {
    const dw = stmt as DoWhileStmt;
    const newBody = inlineGotoInNestedStmt(dw.body, labelName, tail);
    if (newBody === dw.body) return stmt;
    return updateNode(dw, { body: newBody });
  }
  if (stmt.kind === NodeKind.WhileStmt) {
    const ws = stmt as WhileStmt;
    const newBody = inlineGotoInNestedStmt(ws.body, labelName, tail);
    if (newBody === ws.body) return stmt;
    return updateNode(ws, { body: newBody });
  }
  if (stmt.kind === NodeKind.ForStmt) {
    const fs = stmt as ForStmt;
    const newBody = inlineGotoInNestedStmt(fs.body, labelName, tail);
    if (newBody === fs.body) return stmt;
    return updateNode(fs, { body: newBody });
  }

  // LabelStmt: recurse into the inner statement
  if (stmt.kind === NodeKind.LabelStmt) {
    const ls = stmt as LabelStmt;
    const newInner = inlineGotoInNestedStmt(ls.statement, labelName, tail);
    if (newInner === ls.statement) return stmt;
    return updateNode(ls, { statement: newInner });
  }

  // Switch and cases
  if (stmt.kind === NodeKind.SwitchStmt) {
    const sw = stmt as SwitchStmt;
    const newBody = inlineGotoInNestedStmt(sw.body, labelName, tail);
    if (newBody === sw.body) return stmt;
    return updateNode(sw, { body: newBody });
  }
  if (stmt.kind === NodeKind.CaseStmt) {
    const cs = stmt as CaseStmt;
    const newInner = inlineGotoInNestedStmt(cs.statement, labelName, tail);
    if (newInner === cs.statement) return stmt;
    return updateNode(cs, { statement: newInner });
  }
  if (stmt.kind === NodeKind.DefaultStmt) {
    const ds = stmt as DefaultStmt;
    const newInner = inlineGotoInNestedStmt(ds.statement, labelName, tail);
    if (newInner === ds.statement) return stmt;
    return updateNode(ds, { statement: newInner });
  }

  return stmt;
}

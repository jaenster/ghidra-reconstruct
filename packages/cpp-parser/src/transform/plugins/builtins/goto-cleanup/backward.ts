/**
 * Backward goto → loop conversion.
 *
 * Converts backward gotos (targeting a label that appears before the goto)
 * into structured loop constructs:
 *   - bare `goto L;` → `while(true) { body }`
 *   - `if (cond) goto L;` → `do { body } while(cond)`
 *
 * Searches nested scopes (if/else, switch, compounds) for backward gotos
 * in addition to direct children.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CaseStmt,
  CompoundStmt,
  ContinueStmt,
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
import type { BackwardGotoEntry, LabelInfo } from './types.js';
import { createBoolLiteral, createBreakStmt, getGotoLabel } from './helpers.js';

/**
 * Find backward gotos (goto targeting a label that appears BEFORE the goto)
 * at the compound statement level, including inside nested scopes.
 */
function findBackwardGotos(
  stmts: Statement[],
  labels: Map<string, LabelInfo>,
): Map<string, BackwardGotoEntry[]> {
  const result = new Map<string, BackwardGotoEntry[]>();

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Bare backward goto: goto L; where L is before
    if (stmt.kind === NodeKind.GotoStmt) {
      const label = (stmt as GotoStmt).label.name;
      if (label && labels.has(label) && i > labels.get(label)!.index) {
        const arr = result.get(label) ?? [];
        arr.push({ index: i, kind: 'bare' });
        result.set(label, arr);
        continue;
      }
    }

    // Simple conditional backward goto: if (cond) goto L; where L is before
    if (stmt.kind === NodeKind.IfStmt) {
      const ifStmt = stmt as IfStmt;
      if (!ifStmt.elseBranch) {
        const label = getGotoLabel(ifStmt.thenBranch);
        if (label && labels.has(label) && i > labels.get(label)!.index) {
          const arr = result.get(label) ?? [];
          arr.push({ index: i, kind: 'simple-conditional', ifStmt });
          result.set(label, arr);
          continue;
        }
      }
    }

    // Nested backward gotos: recursively search inside if/else, switch, compounds
    // Skip loops — gotos inside loops would become ambiguous (continue for which loop?)
    for (const [labelName, labelInfo] of labels) {
      if (i <= labelInfo.index) continue;
      const count = countBackwardGotosInStmt(stmt, labelName);
      if (count > 0) {
        // Only add if not already found at this index for this label
        const arr = result.get(labelName) ?? [];
        const alreadyAtIndex = arr.some(e => e.index === i);
        if (!alreadyAtIndex) {
          arr.push({ index: i, kind: 'nested', nestedCount: count });
          result.set(labelName, arr);
        }
      }
    }
  }

  return result;
}

/**
 * Count backward gotos to a specific label inside a statement tree,
 * but NOT descending into loop bodies (those gotos can't safely become continue).
 */
function countBackwardGotosInStmt(stmt: Statement, labelName: string): number {
  let count = 0;

  function walk(s: Statement): void {
    if (s.kind === NodeKind.GotoStmt && (s as GotoStmt).label.name === labelName) {
      count++;
      return;
    }
    if (s.kind === NodeKind.CompoundStmt) {
      for (const child of (s as CompoundStmt).statements) walk(child);
      return;
    }
    if (s.kind === NodeKind.IfStmt) {
      const ifStmt = s as IfStmt;
      walk(ifStmt.thenBranch);
      if (ifStmt.elseBranch) walk(ifStmt.elseBranch);
      return;
    }
    if (s.kind === NodeKind.SwitchStmt) {
      walk((s as SwitchStmt).body);
      return;
    }
    if (s.kind === NodeKind.CaseStmt) {
      walk((s as CaseStmt).statement);
      return;
    }
    if (s.kind === NodeKind.DefaultStmt) {
      walk((s as DefaultStmt).statement);
      return;
    }
    if (s.kind === NodeKind.LabelStmt) {
      walk((s as LabelStmt).statement);
      return;
    }
    // Do NOT descend into loops — their gotos would be ambiguous with the new loop's continue
  }

  walk(stmt);
  return count;
}

/**
 * Replace all `goto labelName` with `continue` in a statement tree (recursively).
 * Does NOT descend into loops (matching the search restriction).
 */
function replaceGotoWithContinueInStmt(stmt: Statement, labelName: string): Statement {
  if (stmt.kind === NodeKind.GotoStmt && (stmt as GotoStmt).label.name === labelName) {
    return createContinueStmt(stmt);
  }

  if (stmt.kind === NodeKind.CompoundStmt) {
    const compound = stmt as CompoundStmt;
    let changed = false;
    const newStmts = compound.statements.map(s => {
      const r = replaceGotoWithContinueInStmt(s, labelName);
      if (r !== s) changed = true;
      return r;
    });
    if (!changed) return stmt;
    return updateNode(compound, { statements: newStmts });
  }

  if (stmt.kind === NodeKind.IfStmt) {
    const ifStmt = stmt as IfStmt;
    const newThen = replaceGotoWithContinueInStmt(ifStmt.thenBranch, labelName);
    const newElse = ifStmt.elseBranch
      ? replaceGotoWithContinueInStmt(ifStmt.elseBranch, labelName)
      : null;
    if (newThen === ifStmt.thenBranch && newElse === ifStmt.elseBranch) return stmt;
    const updates: Record<string, unknown> = {};
    if (newThen !== ifStmt.thenBranch) updates.thenBranch = newThen;
    if (newElse !== ifStmt.elseBranch) updates.elseBranch = newElse;
    return updateNode(ifStmt, updates);
  }

  if (stmt.kind === NodeKind.SwitchStmt) {
    const sw = stmt as SwitchStmt;
    const newBody = replaceGotoWithContinueInStmt(sw.body, labelName);
    if (newBody === sw.body) return stmt;
    return updateNode(sw, { body: newBody });
  }

  if (stmt.kind === NodeKind.CaseStmt) {
    const cs = stmt as CaseStmt;
    const newInner = replaceGotoWithContinueInStmt(cs.statement, labelName);
    if (newInner === cs.statement) return stmt;
    return updateNode(cs, { statement: newInner });
  }

  if (stmt.kind === NodeKind.DefaultStmt) {
    const ds = stmt as DefaultStmt;
    const newInner = replaceGotoWithContinueInStmt(ds.statement, labelName);
    if (newInner === ds.statement) return stmt;
    return updateNode(ds, { statement: newInner });
  }

  if (stmt.kind === NodeKind.LabelStmt) {
    const ls = stmt as LabelStmt;
    const newInner = replaceGotoWithContinueInStmt(ls.statement, labelName);
    if (newInner === ls.statement) return stmt;
    return updateNode(ls, { statement: newInner });
  }

  // Do NOT descend into loops
  return stmt;
}

/**
 * Create a continue statement.
 */
function createContinueStmt(anchor: Statement): ContinueStmt {
  return {
    kind: NodeKind.ContinueStmt,
    location: anchor.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as ContinueStmt;
}

/**
 * Replace a backward goto entry with a continue statement.
 * - bare goto → continue;
 * - if (cond) goto → if (cond) continue;
 */
function replaceGotoWithContinue(entry: BackwardGotoEntry, stmt: Statement): Statement {
  if (entry.kind === 'bare') {
    return createContinueStmt(stmt);
  }
  if (entry.kind === 'simple-conditional') {
    const ifStmt = entry.ifStmt!;
    return {
      kind: NodeKind.IfStmt,
      condition: ifStmt.condition,
      thenBranch: createContinueStmt(ifStmt.thenBranch),
      elseBranch: null,
      isConstexpr: false,
      location: ifStmt.location,
      leadingTrivia: ifStmt.leadingTrivia ?? [],
      trailingTrivia: ifStmt.trailingTrivia ?? [],
    } as IfStmt;
  }
  // 'nested': need recursive replacement
  return replaceGotoWithContinueInStmt(stmt, '');
}

/**
 * Convert backward gotos to loop constructs.
 * - Single backward goto: bare → while(true), if(cond) → do/while(cond)
 * - Multiple backward gotos (all to same label): last becomes loop back-edge,
 *   earlier ones become continue statements
 * - Nested backward gotos: wrapped in while(true), replaced with continue
 */
export function processBackwardGotos(
  stmts: Statement[],
  labels: Map<string, LabelInfo>,
  gotoCounts: Map<string, number>,
): Statement[] | null {
  const backwardGotos = findBackwardGotos(stmts, labels);

  for (const [labelName, gotos] of backwardGotos) {
    if (gotos.length === 0) continue;

    // ALL gotos to this label must be backward gotos at this compound level
    const totalGotos = gotoCounts.get(labelName) ?? 0;
    // Count total gotos from our entries (nested entries may account for multiple gotos)
    const accountedGotos = gotos.reduce((sum, e) => sum + (e.nestedCount ?? 1), 0);
    if (totalGotos !== accountedGotos) continue;

    const labelInfo = labels.get(labelName)!;
    const labelIndex = labelInfo.index;
    const labelStmt = stmts[labelIndex] as LabelStmt;

    // Sort by index so we process in order
    const sorted = [...gotos].sort((a, b) => a.index - b.index);
    const lastEntry = sorted[sorted.length - 1];
    const gotoIndex = lastEntry.index;

    // Guard: don't wrap case/default statements into a loop — this would pull
    // switch case labels out of the switch body, making them unreachable.
    const loopEndIndex = lastEntry.kind === 'nested' ? stmts.length : gotoIndex;
    const hasCaseInRange = stmts.slice(labelIndex + 1, loopEndIndex).some(
      s => s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt
    );
    if (hasCaseInRange) continue;

    // Build loop body: [labelStmt.statement, stmts between label and last goto]
    // For earlier gotos, replace them with continue statements
    const bodyStmts: Statement[] = [labelStmt.statement];

    // Set of indices that are earlier backward gotos (to be replaced with continue)
    const earlierGotoIndices = new Map<number, BackwardGotoEntry>();
    for (let g = 0; g < sorted.length - 1; g++) {
      earlierGotoIndices.set(sorted[g].index, sorted[g]);
    }

    for (let i = labelIndex + 1; i < gotoIndex; i++) {
      const entry = earlierGotoIndices.get(i);
      if (entry) {
        if (entry.kind === 'nested') {
          bodyStmts.push(replaceGotoWithContinueInStmt(stmts[i], labelName));
        } else {
          bodyStmts.push(replaceGotoWithContinue(entry, stmts[i]));
        }
      } else {
        bodyStmts.push(stmts[i]);
      }
    }

    // Handle the last entry: if top-level, it defines the loop condition
    // If nested, wrap in while(true) and replace with continue
    let loopStmt: Statement;

    if (lastEntry.kind === 'simple-conditional') {
      // do { body } while (cond);
      const body: CompoundStmt = {
        kind: NodeKind.CompoundStmt,
        statements: bodyStmts,
        location: labelStmt.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as CompoundStmt;

      loopStmt = {
        kind: NodeKind.DoWhileStmt,
        body,
        condition: lastEntry.ifStmt!.condition,
        location: labelStmt.location,
        leadingTrivia: labelStmt.leadingTrivia ?? [],
        trailingTrivia: [],
      } as DoWhileStmt;
    } else if (lastEntry.kind === 'nested') {
      // Last goto is nested — include the containing statement AND all remaining
      // statements in the body (they execute on the non-goto path), plus a break
      // at the end to exit the loop when the goto doesn't fire.
      const lastStmtReplaced = replaceGotoWithContinueInStmt(stmts[gotoIndex], labelName);
      bodyStmts.push(lastStmtReplaced);

      // Include statements after the containing statement until end of compound
      for (let i = gotoIndex + 1; i < stmts.length; i++) {
        bodyStmts.push(stmts[i]);
      }
      bodyStmts.push(createBreakStmt(labelStmt));

      const body: CompoundStmt = {
        kind: NodeKind.CompoundStmt,
        statements: bodyStmts,
        location: labelStmt.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as CompoundStmt;

      loopStmt = {
        kind: NodeKind.WhileStmt,
        condition: createBoolLiteral(true, labelStmt),
        body,
        location: labelStmt.location,
        leadingTrivia: labelStmt.leadingTrivia ?? [],
        trailingTrivia: [],
      } as WhileStmt;
    } else {
      // bare top-level goto → while(true) { body }
      const body: CompoundStmt = {
        kind: NodeKind.CompoundStmt,
        statements: bodyStmts,
        location: labelStmt.location,
        leadingTrivia: [],
        trailingTrivia: [],
      } as CompoundStmt;

      loopStmt = {
        kind: NodeKind.WhileStmt,
        condition: createBoolLiteral(true, labelStmt),
        body,
        location: labelStmt.location,
        leadingTrivia: labelStmt.leadingTrivia ?? [],
        trailingTrivia: [],
      } as WhileStmt;
    }

    const prefix = stmts.slice(0, labelIndex);
    // For nested last-goto, all remaining statements are inside the loop body
    const suffix = lastEntry.kind === 'nested' ? [] : stmts.slice(gotoIndex + 1);

    return [...prefix, loopStmt, ...suffix];
  }

  return null;
}

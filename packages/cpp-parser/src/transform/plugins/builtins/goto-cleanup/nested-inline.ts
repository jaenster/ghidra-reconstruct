/**
 * Nested label tail inlining.
 *
 * Discovers labels inside if/else branches, loop bodies, switch cases,
 * and inlines their tails at goto sites. Handles return, noreturn, and
 * cleanup-fallthrough tails (fallthrough gets an explicit return appended).
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
import type { LabelInfo, RequiredGotoCleanupOptions } from './types.js';
import { MAX_INLINE_TAIL_SIZE } from './types.js';
import { discoverNestedLabels, countGotosInStatements } from './analysis.js';
import { deepCloneStatements } from './helpers.js';
import { inlineGotoInNestedStmt, createReturnStmt } from './tail-inline.js';

// ============================================
// Global goto counts — set once per function body by the visitor,
// used by inner compounds to verify they can see ALL gotos.
// ============================================

const GLOBAL_GOTO_KEY = Symbol.for('ghidra-mcp:goto-cleanup-global-gotos');

export function setGlobalGotoCounts(counts: Map<string, number>): void {
  (globalThis as any)[GLOBAL_GOTO_KEY] = counts;
}

export function getGlobalGotoCounts(): Map<string, number> | null {
  return (globalThis as any)[GLOBAL_GOTO_KEY] ?? null;
}

export function clearGlobalGotoCounts(): void {
  delete (globalThis as any)[GLOBAL_GOTO_KEY];
}

/**
 * Strip the LabelStmt wrapper for a specific label, leaving the inner statement in place.
 * Recursively descends into nested scopes to find the label.
 */
function stripNestedLabelWrapper(stmt: Statement, labelName: string): { stmt: Statement; changed: boolean } {
  // Direct match: LabelStmt with our name → return the inner statement
  if (stmt.kind === NodeKind.LabelStmt) {
    const ls = stmt as LabelStmt;
    if (ls.label.name === labelName) {
      return { stmt: ls.statement, changed: true };
    }
    // Could be nested inside another label's statement
    const inner = stripNestedLabelWrapper(ls.statement, labelName);
    if (inner.changed) {
      return { stmt: updateNode(ls, { statement: inner.stmt }), changed: true };
    }
    return { stmt, changed: false };
  }

  if (stmt.kind === NodeKind.CompoundStmt) {
    const compound = stmt as CompoundStmt;
    let changed = false;
    const newStmts: Statement[] = [];
    for (const s of compound.statements) {
      const result = stripNestedLabelWrapper(s, labelName);
      if (result.changed) changed = true;
      newStmts.push(result.stmt);
    }
    if (!changed) return { stmt, changed: false };
    return { stmt: updateNode(compound, { statements: newStmts }), changed: true };
  }

  if (stmt.kind === NodeKind.IfStmt) {
    const ifStmt = stmt as IfStmt;
    const thenResult = stripNestedLabelWrapper(ifStmt.thenBranch, labelName);
    const elseResult = ifStmt.elseBranch
      ? stripNestedLabelWrapper(ifStmt.elseBranch, labelName)
      : { stmt: null, changed: false };
    if (!thenResult.changed && !elseResult.changed) return { stmt, changed: false };
    const updates: Record<string, unknown> = {};
    if (thenResult.changed) updates.thenBranch = thenResult.stmt;
    if (elseResult.changed) updates.elseBranch = elseResult.stmt;
    return { stmt: updateNode(ifStmt, updates), changed: true };
  }

  if (stmt.kind === NodeKind.ForStmt) {
    const fs = stmt as ForStmt;
    const bodyResult = stripNestedLabelWrapper(fs.body, labelName);
    if (!bodyResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(fs, { body: bodyResult.stmt }), changed: true };
  }

  if (stmt.kind === NodeKind.WhileStmt) {
    const ws = stmt as WhileStmt;
    const bodyResult = stripNestedLabelWrapper(ws.body, labelName);
    if (!bodyResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(ws, { body: bodyResult.stmt }), changed: true };
  }

  if (stmt.kind === NodeKind.DoWhileStmt) {
    const dw = stmt as DoWhileStmt;
    const bodyResult = stripNestedLabelWrapper(dw.body, labelName);
    if (!bodyResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(dw, { body: bodyResult.stmt }), changed: true };
  }

  if (stmt.kind === NodeKind.SwitchStmt) {
    const sw = stmt as SwitchStmt;
    const bodyResult = stripNestedLabelWrapper(sw.body, labelName);
    if (!bodyResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(sw, { body: bodyResult.stmt }), changed: true };
  }

  if (stmt.kind === NodeKind.CaseStmt) {
    const cs = stmt as CaseStmt;
    const innerResult = stripNestedLabelWrapper(cs.statement, labelName);
    if (!innerResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(cs, { statement: innerResult.stmt }), changed: true };
  }

  if (stmt.kind === NodeKind.DefaultStmt) {
    const ds = stmt as DefaultStmt;
    const innerResult = stripNestedLabelWrapper(ds.statement, labelName);
    if (!innerResult.changed) return { stmt, changed: false };
    return { stmt: updateNode(ds, { statement: innerResult.stmt }), changed: true };
  }

  return { stmt, changed: false };
}

/**
 * Nested label tail inlining.
 *
 * Finds labels inside nested scopes (if branches, loops, switch cases),
 * inlines their tails at each goto site, and strips the label wrapper.
 *
 * Only processes one label per call (returns on first success) to allow
 * the fixpoint loop to re-analyze after each change.
 */
export function processNestedTailInlining(
  stmts: Statement[],
  topLevelLabels: Map<string, LabelInfo>,
  gotoCounts: Map<string, number>,
  options: RequiredGotoCleanupOptions,
): Statement[] | null {
  const nestedLabels = discoverNestedLabels(stmts, topLevelLabels, options);
  if (nestedLabels.size === 0) return null;

  // Use global goto counts (set by the visitor at function body level) to verify
  // we can see ALL gotos from this scope. If the global total exceeds our local
  // total, there are gotos in ancestor scopes we can't handle — defer to them.
  const globalGotos = getGlobalGotoCounts();

  for (const [name, info] of nestedLabels) {
    const localGotos = gotoCounts.get(name) ?? 0;
    if (localGotos === 0) continue;

    // If global counts are available and show more gotos than we can see locally,
    // defer to a higher-level compound that can see all of them.
    if (globalGotos) {
      const globalTotal = globalGotos.get(name) ?? 0;
      if (globalTotal > localGotos) continue;
    }

    const tail = info.tailStatements;
    if (tail.length === 0 || tail.length > MAX_INLINE_TAIL_SIZE) continue;

    // Safety: only return/noreturn/cleanup-fallthrough tails for nested labels
    if (info.kind !== 'exit-return' && info.kind !== 'cleanup-return'
        && info.kind !== 'exit-noreturn' && info.kind !== 'cleanup-fallthrough') continue;

    // For cleanup-fallthrough, build tail with explicit return appended
    // (the goto would have jumped to code that falls off the function end)
    const effectiveTail = info.kind === 'cleanup-fallthrough'
      ? [...tail, createReturnStmt(tail[tail.length - 1])]
      : tail;

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

    // Inline all gotos to this label across all scopes.
    // When the return is fabricated for a cleanup-fallthrough label, pass the flag so
    // loop bodies are not entered: inlining a fabricated return inside a loop would
    // exit the function early instead of continuing the loop.
    const tailReturnIsFabricated = info.kind === 'cleanup-fallthrough';
    let inlined = false;
    const newStmts: Statement[] = [];
    for (const stmt of stmts) {
      // Direct goto at compound level
      if (stmt.kind === NodeKind.GotoStmt && (stmt as GotoStmt).label.name === name) {
        newStmts.push(...deepCloneStatements(effectiveTail));
        inlined = true;
        continue;
      }
      const replaced = inlineGotoInNestedStmt(stmt, name, effectiveTail, tailReturnIsFabricated);
      if (replaced !== stmt) {
        newStmts.push(replaced);
        inlined = true;
      } else {
        newStmts.push(stmt);
      }
    }

    if (!inlined) continue;

    // Verify ALL gotos to this label were inlined.
    const remainingGotos = countGotosInStatements(newStmts).get(name) ?? 0;
    if (remainingGotos > 0) continue;

    // Strip the label wrapper (leave the tail code for fall-through)
    const finalStmts: Statement[] = [];
    for (const stmt of newStmts) {
      const result = stripNestedLabelWrapper(stmt, name);
      finalStmts.push(result.stmt);
    }

    return finalStmts;
  }

  return null;
}

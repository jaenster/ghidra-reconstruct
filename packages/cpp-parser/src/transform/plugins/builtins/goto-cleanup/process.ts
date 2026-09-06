/**
 * Main processCompound orchestrator for goto cleanup.
 *
 * Runs transforms in order:
 *   - Switch goto-to-break recovery
 *   - Switch case-to-case goto inlining
 *   - Backward goto → loop conversion (recursive nested search)
 *   - Forward goto analysis and cascading
 *   - Cleanup tail inlining (top-level labels, fallback)
 *   - Nested label tail inlining (cross-scope labels in if/else/loop/switch)
 *
 * ## Every candidate is checked before it is accepted
 *
 * These are peephole rewrites, so each one decides on its own whether the span it is
 * about to drop is dead. That question has been answered wrongly three times, each time
 * by deleting live code, and each fix taught ONE pass to ask ONE more thing. So the
 * answer is no longer left to the pass: whatever a handler returns is put through
 * `preservesReachableWork` against what it was given, and is only accepted if every
 * reachable statement is still reachable and every reachable edge still exists.
 *
 * A rejected candidate is not an error. `processCompound` moves on to the next handler,
 * and if none survives the compound keeps its gotos — which is the right default when
 * the deliverable is a program that runs.
 */

import type { Statement } from '../../../../ast/nodes.js';
import type { RequiredGotoCleanupOptions } from './types.js';
import { recordStat } from './stats.js';
import { collectIdentifierNames } from './helpers.js';
import { analyzeLabels, analyzeGotos, countGotosInStatements } from './analysis.js';
import { handleSwitchGotoToBreak } from './switch-break.js';
import { handleSwitchCaseGoto } from './switch-case-goto.js';
import { processBackwardGotos } from './backward.js';
import { buildGeneralizedCascade, handleUnconditionalGoto, handleLoopBodyGoto } from './forward.js';
import { processCleanupTailInlining } from './tail-inline.js';
import { processNestedTailInlining, getGlobalGotoCounts } from './nested-inline.js';
import { preservesReachableWork } from '../../../cfg/index.js';

/** Set by the caller to see which handlers are being vetoed and why. */
let onVeto: ((handler: string, lost: string[]) => void) | null = null;

export function setGotoCleanupVetoReporter(fn: ((handler: string, lost: string[]) => void) | null): void {
  onVeto = fn;
}

/**
 * Accept `candidate` only if it still reaches everything `before` reached.
 *
 * The whole-function goto counts decide which labels are entry points of this region, so
 * both graphs are built with the same ones.
 */
function accept(
  before: Statement[],
  candidate: Statement[] | null,
  handler: string,
): Statement[] | null {
  if (!candidate) return null;
  const opts = { externalGotoCounts: getGlobalGotoCounts() };
  const check = preservesReachableWork(before, candidate, opts);
  if (check.ok) return candidate;
  recordStat('vetoedUnsafe');
  onVeto?.(handler, [...check.lostKeys, ...check.lostEdges]);
  return null;
}

/**
 * Process a compound statement's statements array once.
 * Returns the modified array or null if no changes.
 */
export function processCompound(
  stmts: Statement[],
  options: RequiredGotoCleanupOptions,
  // True only when falling off the end of this compound reaches the function's implicit
  // `return;` — i.e. it is the tail of a void function body. Everywhere else a
  // cleanup-fallthrough label's fallthrough continues into code that may still return a
  // value, so no return may be fabricated. Defaults to the safe answer.
  fallthroughMeansReturn = false,
): Statement[] | null {
  const labels = analyzeLabels(stmts, options);
  const gotoCounts = countGotosInStatements(stmts);

  if (labels.size > 0) {
    // Switch goto-to-break: replace goto-to-label-after-switch with break
    const switchResult = accept(stmts, handleSwitchGotoToBreak(stmts, labels, gotoCounts), 'switchGotoToBreak');
    if (switchResult) { recordStat('switchGotoToBreak'); return switchResult; }
  }

  // Switch case-to-case: inline goto switchD_xxx_caseD_N within the same switch
  const switchCaseResult = accept(stmts, handleSwitchCaseGoto(stmts, gotoCounts), 'switchCaseGoto');
  if (switchCaseResult) { recordStat('switchCaseGoto'); return switchCaseResult; }

  if (labels.size > 0) {
    // Backward goto → loop: converts backward gotos (including nested) to loops
    const backwardResult = accept(stmts, processBackwardGotos(stmts, labels, gotoCounts), 'backwardToLoop');
    if (backwardResult) { recordStat('backwardToLoop'); return backwardResult; }

    // Forward goto analysis and cascading
    const gotoMap = analyzeGotos(stmts, labels);

    // Process labels from LAST to FIRST (bottom-up for chained labels)
    const labelEntries = [...labels.values()].sort((a, b) => b.index - a.index);

    let current = stmts;
    let modified = false;

    for (const labelInfo of labelEntries) {
      const gotoInfos = gotoMap.get(labelInfo.name);
      if (!gotoInfos || gotoInfos.length === 0) continue;

      // Check that ALL gotos to this label are accounted for at this level
      const totalGotos = gotoCounts.get(labelInfo.name) ?? 0;
      const accountedGotos = gotoInfos.reduce((sum, g) => sum + (g.gotoCount ?? 1), 0);

      if (totalGotos !== accountedGotos) continue;

      // Depth limit
      if (gotoInfos.length > options.maxNestingDepth) continue;

      // Re-analyze for current state (labels may have shifted due to prior transforms)
      const freshLabels = analyzeLabels(current, options);
      const freshLabel = freshLabels.get(labelInfo.name);
      if (!freshLabel) continue;

      const freshGotoCounts = countGotosInStatements(current);
      const freshGotoMap = analyzeGotos(current, freshLabels);
      const freshGotos = freshGotoMap.get(labelInfo.name);
      if (!freshGotos || freshGotos.length === 0) continue;

      // Re-check accounting with fresh data
      const freshTotal = freshGotoCounts.get(labelInfo.name) ?? 0;
      const freshAccounted = freshGotos.reduce((sum, g) => sum + (g.gotoCount ?? 1), 0);
      if (freshTotal !== freshAccounted) continue;

      const freshContexts = new Set(freshGotos.map(g => g.context));
      const usedNames = collectIdentifierNames(current);

      let result: Statement[] | null = null;

      // Single context type
      if (freshContexts.size === 1) {
        const ctx = freshGotos[0].context;

        if (ctx === 'top-level-if') {
          const sorted = [...freshGotos].sort((a, b) => a.index - b.index);
          result = buildGeneralizedCascade(current, sorted, freshLabel.index, freshLabel.tailStatements);
        } else if (ctx === 'unconditional') {
          if (freshGotos.length === 1) {
            result = handleUnconditionalGoto(current, freshGotos[0], freshLabel, options.eliminateDeadCode);
          }
        } else if (ctx === 'end-of-if-then' || ctx === 'cross-scope-terminal') {
          const sorted = [...freshGotos].sort((a, b) => a.index - b.index);
          result = buildGeneralizedCascade(current, sorted, freshLabel.index, freshLabel.tailStatements);
        } else if (ctx === 'loop-body') {
          result = handleLoopBodyGoto(current, freshGotos, freshLabel, usedNames);
        }
      }

      // Mixed contexts: allow mixing top-level-if, end-of-if-then, and cross-scope-terminal
      if (freshContexts.size > 1) {
        const cascadeContexts = new Set(['top-level-if', 'end-of-if-then', 'cross-scope-terminal']);
        const allCascadable = freshGotos.every(g => cascadeContexts.has(g.context));
        if (allCascadable) {
          const sorted = [...freshGotos].sort((a, b) => a.index - b.index);
          result = buildGeneralizedCascade(current, sorted, freshLabel.index, freshLabel.tailStatements);
        }
      }

      const ctx = freshGotos[0].context;
      const checked = accept(current, result, ctx);
      if (checked) {
        if (ctx === 'unconditional') recordStat('unconditionalGoto');
        else if (ctx === 'loop-body') recordStat('loopBodyGoto');
        else recordStat('forwardCascade');
        current = checked;
        modified = true;
      }
    }

    if (modified) return current;

    // Cleanup tail inlining: handles gotos at any nesting depth to top-level labels
    const inlineResult = accept(
      stmts,
      processCleanupTailInlining(stmts, labels, gotoCounts, options, fallthroughMeansReturn),
      'cleanupTailInline',
    );
    if (inlineResult) { recordStat('cleanupTailInline'); return inlineResult; }
  }

  // Nested label tail inlining: cross-scope labels in if/else/loop/switch
  // Runs even when no top-level labels exist — discovers labels inside nested scopes
  const nestedResult = accept(
    stmts,
    processNestedTailInlining(stmts, labels, gotoCounts, options, fallthroughMeansReturn),
    'nestedTailInline',
  );
  if (nestedResult) { recordStat('nestedTailInline'); return nestedResult; }

  return null;
}

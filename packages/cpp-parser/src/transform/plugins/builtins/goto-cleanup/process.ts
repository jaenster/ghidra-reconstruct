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
import { processNestedTailInlining } from './nested-inline.js';

/**
 * Process a compound statement's statements array once.
 * Returns the modified array or null if no changes.
 */
export function processCompound(
  stmts: Statement[],
  options: RequiredGotoCleanupOptions,
  // True only when this compound is the function body. False for loop/switch bodies,
  // where a cleanup-fallthrough label's fallthrough continues the loop / next case
  // rather than reaching the function's implicit return — so no return may be fabricated.
  fallthroughMeansReturn = true,
): Statement[] | null {
  const labels = analyzeLabels(stmts, options);
  const gotoCounts = countGotosInStatements(stmts);

  if (labels.size > 0) {
    // Switch goto-to-break: replace goto-to-label-after-switch with break
    const switchResult = handleSwitchGotoToBreak(stmts, labels, gotoCounts);
    if (switchResult) { recordStat('switchGotoToBreak'); return switchResult; }
  }

  // Switch case-to-case: inline goto switchD_xxx_caseD_N within the same switch
  const switchCaseResult = handleSwitchCaseGoto(stmts, gotoCounts);
  if (switchCaseResult) { recordStat('switchCaseGoto'); return switchCaseResult; }

  if (labels.size > 0) {
    // Backward goto → loop: converts backward gotos (including nested) to loops
    const backwardResult = processBackwardGotos(stmts, labels, gotoCounts);
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

      if (result) {
        const ctx = freshGotos[0].context;
        if (ctx === 'unconditional') recordStat('unconditionalGoto');
        else if (ctx === 'loop-body') recordStat('loopBodyGoto');
        else recordStat('forwardCascade');
        current = result;
        modified = true;
      }
    }

    if (modified) return current;

    // Cleanup tail inlining: handles gotos at any nesting depth to top-level labels
    const inlineResult = processCleanupTailInlining(stmts, labels, gotoCounts, options, fallthroughMeansReturn);
    if (inlineResult) { recordStat('cleanupTailInline'); return inlineResult; }
  }

  // Nested label tail inlining: cross-scope labels in if/else/loop/switch
  // Runs even when no top-level labels exist — discovers labels inside nested scopes
  const nestedResult = processNestedTailInlining(stmts, labels, gotoCounts, options, fallthroughMeansReturn);
  if (nestedResult) { recordStat('nestedTailInline'); return nestedResult; }

  return null;
}

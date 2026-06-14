/**
 * Goto Cleanup Plugin — CFG-Based Control Flow De-optimization
 *
 * Replaces Ghidra's goto-heavy decompiler output with structured
 * if/else, break, and dead-code-elimination patterns.
 *
 * Handles:
 *  1. Cascading forward gotos to a shared exit/cleanup label
 *  2. Goto to bare return / return-with-value
 *  3. Unconditional goto + dead code elimination
 *  4. End-of-if-then goto → if/else recovery
 *  5. Loop exit gotos (for/while/do-while → break)
 *  6. Chained labels (bottom-up resolution)
 *  7. Noreturn-aware paths (WARNING comment or known functions)
 *  8. Cross-scope terminal gotos (goto inside nested if/switch)
 *  9. Switch goto-to-break recovery
 * 10. Backward goto → loop conversion (do/while, while(true))
 * 11. Cleanup tail inlining (inline short tails at each goto site)
 * 12. Nested label tail inlining (cross-scope labels in if/else/loop/switch)
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type {
  ASTNode,
  CompoundStmt,
  DoWhileStmt,
  ForStmt,
  FunctionDecl,
  GotoStmt,
  LabelStmt,
  SwitchStmt,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import { createTransformer } from '../../../transformer.js';
import { traverseAST } from '../../../../ast/visitor.js';
import type { TransformPlugin } from '../../types.js';
import type { GotoCleanupOptions } from './types.js';
import { DEFAULT_MAX_NESTING, MAX_FIXPOINT_PASSES } from './types.js';
import { processCompound } from './process.js';
import { countGotosInStatements } from './analysis.js';
import {
  setGlobalGotoCounts,
  clearGlobalGotoCounts,
  markCompoundAsLoopOrSwitchBody,
  isLoopOrSwitchBodyCompound,
} from './nested-inline.js';

// Re-export public API
export type { GotoCleanupStats } from './types.js';
export type { GotoCleanupOptions } from './types.js';
export { getGotoCleanupStats, resetGotoCleanupStats } from './stats.js';

/**
 * Pre-compute global goto counts for every function body in the AST.
 * Must run BEFORE the bottom-up transformer so inner compounds can
 * check whether they see all gotos or should defer to a parent scope.
 */
function preComputeGlobalGotoCounts(root: ASTNode): void {
  // Walk the original (untransformed) AST to find function bodies.
  // For each FunctionDecl with a CompoundStmt body, count all gotos
  // recursively and store per-label counts.
  //
  // We accumulate into a single map — labels are unique addresses so
  // collisions across functions don't happen in practice.
  const allCounts = new Map<string, number>();

  for (const node of traverseAST(root)) {
    if (node.kind === NodeKind.FunctionDecl) {
      const fn = node as FunctionDecl;
      if (fn.body && fn.body.kind === NodeKind.CompoundStmt) {
        const body = fn.body as CompoundStmt;
        const counts = countGotosInStatements(body.statements);
        for (const [label, count] of counts) {
          allCounts.set(label, (allCounts.get(label) ?? 0) + count);
        }
      }
    }

    // Mark loop/switch body compounds. A cleanup-fallthrough label inside such a
    // body must NOT get a fabricated return — fallthrough there means continue the
    // loop / fall to the next case, not the function's implicit return.
    //
    // The mark must apply TRANSITIVELY: a label nested any number of if/else/switch
    // (or inner-loop) levels deep inside a loop/switch body still continues the loop
    // on fallthrough. The bottom-up transformer inlines at whichever compound can see
    // both the goto and the label — that compound may be a deep descendant of the body.
    // So mark the body AND every descendant CompoundStmt within it. traverseAST visits
    // the whole subtree (including nested loops), so every compound anywhere inside a
    // loop/switch gets marked and reads fallthroughMeansReturn=false.
    let body: ASTNode | undefined;
    switch (node.kind) {
      case NodeKind.ForStmt: body = (node as ForStmt).body; break;
      case NodeKind.WhileStmt: body = (node as WhileStmt).body; break;
      case NodeKind.DoWhileStmt: body = (node as DoWhileStmt).body; break;
      case NodeKind.SwitchStmt: body = (node as SwitchStmt).body; break;
    }
    if (body && body.kind === NodeKind.CompoundStmt) {
      for (const inner of traverseAST(body)) {
        if (inner.kind === NodeKind.CompoundStmt) {
          markCompoundAsLoopOrSwitchBody(inner as CompoundStmt);
        }
      }
    }
  }

  setGlobalGotoCounts(allCounts);
}

function createGotoCleanupTransformer(pluginOptions?: Record<string, unknown>) {
  const options: Required<GotoCleanupOptions> = {
    maxNestingDepth: (pluginOptions?.maxNestingDepth as number) ?? DEFAULT_MAX_NESTING,
    noreturnFunctions: (pluginOptions?.noreturnFunctions as string[]) ?? [],
    detectGhidraNoreturn: (pluginOptions?.detectGhidraNoreturn as boolean) ?? true,
    eliminateDeadCode: (pluginOptions?.eliminateDeadCode as boolean) ?? true,
  };

  const baseTransformer = createTransformer({
    visitCompoundStmt(compound) {
      const stmts = compound.statements;
      if (stmts.length < 2) return undefined;

      // A cleanup-fallthrough label's tail falls through to the function's implicit
      // return ONLY when this compound is the function body. In a loop/switch body,
      // fallthrough continues the loop / next case, so fabricating a return is wrong.
      const fallthroughMeansReturn = !isLoopOrSwitchBodyCompound(compound);

      let current = stmts;
      let modified = false;

      // Fixpoint iteration: keep processing until no more changes
      for (let pass = 0; pass < MAX_FIXPOINT_PASSES; pass++) {
        const result = processCompound(current, options, fallthroughMeansReturn);
        if (!result) break;
        current = result;
        modified = true;
      }

      if (!modified) return undefined;
      return updateNode(compound, { statements: current });
    },
  });

  // Wrap the transformer: pre-compute global goto counts from the
  // ORIGINAL AST before the bottom-up transform processes any compounds.
  // After the main transform, sweep each function body for orphaned gotos
  // (targeting labels that no longer exist) and remove them.
  return (node: ASTNode): ASTNode => {
    preComputeGlobalGotoCounts(node);
    let result: ASTNode;
    try {
      result = baseTransformer(node);
    } finally {
      clearGlobalGotoCounts();
    }
    const cleaned = removeOrphanedGotos(result);
    return cleaned;
  };
}

/**
 * Collect all label names defined in a statement tree.
 */
function collectLabels(root: ASTNode): Set<string> {
  const labels = new Set<string>();
  for (const node of traverseAST(root)) {
    if (node.kind === NodeKind.LabelStmt) {
      labels.add((node as LabelStmt).label.name);
    }
  }
  return labels;
}

/**
 * Check if a goto label name is an orphaned switchD_*_caseD_* artifact.
 */
function isOrphanedSwitchCaseGoto(name: string, labels: Set<string>): boolean {
  return !labels.has(name) && name.startsWith('switchD_') && name.includes('_caseD_');
}

/**
 * Post-processing pass: remove orphaned gotos from all function bodies.
 * These gotos target switchD_*_caseD_* labels that were consumed by earlier
 * transforms but the goto in a deeply-nested scope was missed.
 */
function removeOrphanedGotos(root: ASTNode): ASTNode {
  const transformer = createTransformer({
    visitFunctionDecl(fn) {
      if (!fn.body || fn.body.kind !== NodeKind.CompoundStmt) return undefined;
      const labels = collectLabels(fn.body);

      // Fast bail-out: check if any orphaned gotos exist
      let hasOrphaned = false;
      for (const node of traverseAST(fn.body)) {
        if (node.kind === NodeKind.GotoStmt && isOrphanedSwitchCaseGoto((node as GotoStmt).label.name, labels)) {
          hasOrphaned = true;
          break;
        }
      }
      if (!hasOrphaned) return undefined;

      // Bottom-up transform that:
      // 1. Replaces orphaned gotos with NullStmt (handles gotos inside case/if/etc.)
      // 2. Strips orphaned gotos from compound statement arrays (cleaner output)
      const cleaner = createTransformer({
        visitNode(node) {
          // Replace goto→NullStmt when it's a statement field (e.g., CaseStmt.statement)
          if (node.kind === NodeKind.GotoStmt && isOrphanedSwitchCaseGoto((node as GotoStmt).label.name, labels)) {
            return { kind: NodeKind.NullStmt, location: node.location, leadingTrivia: [], trailingTrivia: [] } as ASTNode;
          }
          return undefined;
        },
        visitCompoundStmt(compound) {
          // After visitNode replaced gotos with NullStmt, filter them out
          const stmts = compound.statements;
          const filtered = stmts.filter(s => s.kind !== NodeKind.NullStmt);
          if (filtered.length === stmts.length) return undefined;
          return updateNode(compound, { statements: filtered });
        },
      });

      const newBody = cleaner(fn.body);
      if (newBody === fn.body) return undefined;
      return updateNode(fn, { body: newBody as CompoundStmt });
    },
  });
  return transformer(root);
}

export const gotoCleanupPlugin: TransformPlugin = {
  id: 'goto-cleanup',
  name: 'Goto Cleanup',
  description: 'Simplify Ghidra goto patterns into structured if/else, break, and dead code elimination',
  version: '6.1.0',
  defaultEnabled: true,
  priority: 55,
  tags: ['cleanup', 'ghidra', 'control-flow'],

  createTransformer: createGotoCleanupTransformer,
};

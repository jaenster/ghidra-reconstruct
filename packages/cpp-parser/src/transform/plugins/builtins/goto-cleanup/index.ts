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
  BuiltinType,
  CaseStmt,
  CompoundStmt,
  DefaultStmt,
  DoWhileStmt,
  ForStmt,
  FunctionDecl,
  GotoStmt,
  IfStmt,
  LabelStmt,
  Statement,
  SwitchStmt,
  TypeNode,
  WhileStmt,
} from '../../../../ast/nodes.js';
import { updateNode } from '../../../transformer.js';
import { createTransformer } from '../../../transformer.js';
import { traverseAST } from '../../../../ast/visitor.js';
import type { TransformPlugin } from '../../types.js';
import type { RequiredGotoCleanupOptions } from './types.js';
import { DEFAULT_MAX_NESTING, MAX_FIXPOINT_PASSES, MAX_WHOLE_AST_PASSES } from './types.js';
import { processCompound } from './process.js';
import { countGotosInStatements } from './analysis.js';
import {
  setGlobalGotoCounts,
  clearGlobalGotoCounts,
  markCompoundFallthroughReturns,
  compoundFallthroughReturns,
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
function preComputeGlobalGotoCounts(root: ASTNode, enclosingReturnsVoid: boolean | undefined): void {
  // Walk the original (untransformed) AST to find function bodies.
  // For each FunctionDecl with a CompoundStmt body, count all gotos
  // recursively and store per-label counts.
  //
  // We accumulate into a single map — labels are unique addresses so
  // collisions across functions don't happen in practice.
  const allCounts = new Map<string, number>();

  for (const node of traverseAST(root)) {
    if (node.kind !== NodeKind.FunctionDecl) continue;
    const fn = node as FunctionDecl;
    if (!fn.body || fn.body.kind !== NodeKind.CompoundStmt) continue;

    const body = fn.body as CompoundStmt;
    const counts = countGotosInStatements(body.statements);
    for (const [label, count] of counts) {
      allCounts.set(label, (allCounts.get(label) ?? 0) + count);
    }

    // Mark where a fallthrough reaches the function's implicit `return;`.
    // That is only true at the tail of the body of a function returning void — a
    // fabricated bare `return;` anywhere else drops code the fallthrough would have
    // run, and in a non-void function drops the returned value as well.
    // `enclosingReturnsVoid` overrides the AST when the caller parsed a bare body
    // inside a synthetic `void dummy()` wrapper, whose `void` means nothing.
    markFallthroughReturns(body, enclosingReturnsVoid ?? returnsVoid(fn.returnType));
  }

  setGlobalGotoCounts(allCounts);
}

/** True for `void` (and only `void` — not `void*`, not a typedef of unknown shape). */
function returnsVoid(type: TypeNode | undefined | null): boolean {
  if (!type) return false;
  if (type.kind === NodeKind.QualifiedType) {
    return returnsVoid((type as { type: TypeNode }).type);
  }
  return type.kind === NodeKind.BuiltinType && (type as BuiltinType).name === 'void';
}

/**
 * Mark every CompoundStmt reachable from a function body with whether falling off its
 * end reaches the function's implicit `return;`.
 *
 * `reachesEnd` starts as "the function returns void" at the body, and is narrowed on the
 * way down: only the LAST statement of a compound inherits it, both branches of an `if`
 * inherit their `if`'s value, and loop/switch/case bodies reset it to false (falling off
 * them continues the loop / the next case). Compounds that are never visited — anything
 * outside a function body — read false, the safe default.
 */
function markFallthroughReturns(stmt: Statement, reachesEnd: boolean): void {
  switch (stmt.kind) {
    case NodeKind.CompoundStmt: {
      const compound = stmt as CompoundStmt;
      markCompoundFallthroughReturns(compound, reachesEnd);
      const last = compound.statements.length - 1;
      for (let i = 0; i <= last; i++) {
        markFallthroughReturns(compound.statements[i], reachesEnd && i === last);
      }
      return;
    }
    case NodeKind.IfStmt: {
      const ifStmt = stmt as IfStmt;
      markFallthroughReturns(ifStmt.thenBranch, reachesEnd);
      if (ifStmt.elseBranch) markFallthroughReturns(ifStmt.elseBranch, reachesEnd);
      return;
    }
    case NodeKind.LabelStmt:
      markFallthroughReturns((stmt as LabelStmt).statement, reachesEnd);
      return;
    case NodeKind.ForStmt:
      markFallthroughReturns((stmt as ForStmt).body, false);
      return;
    case NodeKind.WhileStmt:
      markFallthroughReturns((stmt as WhileStmt).body, false);
      return;
    case NodeKind.DoWhileStmt:
      markFallthroughReturns((stmt as DoWhileStmt).body, false);
      return;
    case NodeKind.SwitchStmt:
      markFallthroughReturns((stmt as SwitchStmt).body, false);
      return;
    case NodeKind.CaseStmt:
      markFallthroughReturns((stmt as CaseStmt).statement, false);
      return;
    case NodeKind.DefaultStmt:
      markFallthroughReturns((stmt as DefaultStmt).statement, false);
      return;
    default:
      // Any other statement kind (try/catch, an expression holding a lambda body, ...):
      // mark every compound inside it false rather than guess at its control flow.
      for (const inner of traverseAST(stmt as ASTNode)) {
        if (inner.kind === NodeKind.CompoundStmt) {
          markCompoundFallthroughReturns(inner as CompoundStmt, false);
        }
      }
      return;
  }
}

function createGotoCleanupTransformer(pluginOptions?: Record<string, unknown>) {
  const enclosingReturnsVoid = pluginOptions?.enclosingReturnsVoid as boolean | undefined;
  const options: RequiredGotoCleanupOptions = {
    maxNestingDepth: (pluginOptions?.maxNestingDepth as number) ?? DEFAULT_MAX_NESTING,
    noreturnFunctions: (pluginOptions?.noreturnFunctions as string[]) ?? [],
    detectGhidraNoreturn: (pluginOptions?.detectGhidraNoreturn as boolean) ?? true,
    eliminateDeadCode: (pluginOptions?.eliminateDeadCode as boolean) ?? true,
  };

  const baseTransformer = createTransformer({
    visitCompoundStmt(compound) {
      const stmts = compound.statements;
      if (stmts.length < 2) return undefined;

      // A cleanup-fallthrough label's tail reaches the function's implicit return ONLY
      // when falling off this compound's end does — see markFallthroughReturns.
      const fallthroughMeansReturn = compoundFallthroughReturns(compound);

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

  // Wrap the transformer: pre-compute global goto counts and fallthrough marks from the
  // current AST before each bottom-up walk. Repeat until the walk stops changing anything
  // — a restructured compound can contain a fresh nested compound the walk already passed,
  // and the re-analysis both re-marks it and gives it its turn.
  // Finally sweep each function body for orphaned gotos (targeting labels that no longer
  // exist) and remove them.
  return (node: ASTNode): ASTNode => {
    let result = node;
    for (let round = 0; round < MAX_WHOLE_AST_PASSES; round++) {
      preComputeGlobalGotoCounts(result, enclosingReturnsVoid);
      let next: ASTNode;
      try {
        next = baseTransformer(result);
      } finally {
        clearGlobalGotoCounts();
      }
      if (next === result) break;
      result = next;
    }
    return removeOrphanedGotos(result);
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

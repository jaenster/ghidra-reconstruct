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
import { processCompound, accept } from './process.js';
import { structureBody } from './structure.js';
import { DEFAULT_NORETURN_FUNCTIONS } from './types.js';
import { setExactGotoCounts } from './validate.js';
import { setCurrentGotoFunction, gotoReport } from './report.js';
import { recordStat } from './stats.js';
import { isSimpleLabelName } from './helpers.js';
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
// Diagnostics for a non-zero `vetoedUnsafe`: which handler produced an unsafe candidate,
// and which reachable keys or edges it would have dropped.
export { setGotoCleanupVetoReporter } from './process.js';
export { setGotoValidatorMode, gotoValidatorMode, type GotoValidatorMode } from './validate.js';
export { setCurrentGotoFunction } from './report.js';

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
  setExactGotoCounts(new Map(allCounts));
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
  // Only for attributing reported events (report.ts); never changes the output.
  const functionAddress = (pluginOptions?.functionAddress as string | undefined) ?? null;
  const options: RequiredGotoCleanupOptions = {
    maxNestingDepth: (pluginOptions?.maxNestingDepth as number) ?? DEFAULT_MAX_NESTING,
    noreturnFunctions: (pluginOptions?.noreturnFunctions as string[]) ?? [],
    detectGhidraNoreturn: (pluginOptions?.detectGhidraNoreturn as boolean) ?? true,
    eliminateDeadCode: (pluginOptions?.eliminateDeadCode as boolean) ?? true,
  };

  // Whether the current round rewrote anything. The transformer rebuilds every node it
  // walks, so `next === result` is never true and cannot be the convergence test - with it,
  // every function ran all MAX_WHOLE_AST_PASSES rounds.
  let roundChanged = false;
  const baseTransformer = createTransformer({
    visitCompoundStmt(compound) {
      const stmts = compound.statements;
      // A one-statement compound is a region too: a loop body or a switch body can be
      // the only statement of its parent, and the exact rewrites need to see it.
      if (stmts.length === 0) return undefined;

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
      roundChanged = true;
      return updateNode(compound, { statements: current });
    },
  });

  // Rounds run per FUNCTION: the goto counts every handler reads are that function's own,
  // never a sum over every function in the tree (a label name like `ERROR_lbl` or a
  // `__dupN` copy is not unique across functions). Each round pre-computes the counts and
  // fallthrough marks from the current AST and walks it bottom-up; rounds repeat until a
  // walk changes nothing - a restructured compound can contain a fresh nested compound the
  // walk already passed. A function still changing when the round limit is reached is
  // reported, never silently cut off.
  const runRounds = (fn: ASTNode): ASTNode => {
    let result = fn;
    for (let round = 0; round < MAX_WHOLE_AST_PASSES; round++) {
      preComputeGlobalGotoCounts(result, enclosingReturnsVoid);
      let next: ASTNode;
      roundChanged = false;
      try {
        next = baseTransformer(result);
      } finally {
        clearGlobalGotoCounts();
        setExactGotoCounts(null);
      }
      result = next;
      if (!roundChanged) return result;
    }
    recordStat('passLimitHit');
    gotoReport({ event: 'pass-limit', rounds: MAX_WHOLE_AST_PASSES });
    return result;
  };
  // The structurer (structure.ts) runs on what the handlers leave, on the whole body, and
  // the handlers run again on what it produced - a structured arm can expose a shape they
  // know. Each pass of it strictly lowers the goto count, so this converges; the bound is
  // reported like the round limit.
  const noreturn = new Set([...DEFAULT_NORETURN_FUNCTIONS, ...options.noreturnFunctions]);
  const structureFn = (fn: FunctionDecl): FunctionDecl | null => {
    if (!fn.body || fn.body.kind !== NodeKind.CompoundStmt) return null;
    const body = fn.body as CompoundStmt;
    if (!hasGoto(body)) return null;
    const voidFn = enclosingReturnsVoid ?? returnsVoid(fn.returnType);
    const vctx = { followIsExit: true, noreturn };
    const next = structureBody(body, {
      noreturn, voidFn,
      accept: (before, after, handler) => accept(before, after, handler, vctx),
    });
    return next ? updateNode(fn, { body: next }) : null;
  };
  const perFunction = createTransformer({
    visitFunctionDecl(fn) {
      let r = runRounds(fn) as FunctionDecl;
      for (let pass = 0; ; pass++) {
        if (pass === MAX_WHOLE_AST_PASSES) {
          recordStat('passLimitHit');
          gotoReport({ event: 'pass-limit', stage: 'structure' });
          break;
        }
        const s = structureFn(r);
        if (!s) break;
        r = runRounds(s) as FunctionDecl;
      }
      return r === fn ? undefined : r;
    },
  });

  return (node: ASTNode): ASTNode => {
    setCurrentGotoFunction(functionAddress);
    let hasFunction = false;
    for (const n of traverseAST(node)) if (n.kind === NodeKind.FunctionDecl) { hasFunction = true; break; }
    const result = hasFunction ? perFunction(node) : runRounds(node);
    return reportOrphanedGotos(result);
  };
}

/**
 * Collect all label names defined in a statement tree.
 */
function hasGoto(root: ASTNode): boolean {
  for (const n of traverseAST(root)) if (n.kind === NodeKind.GotoStmt) return true;
  return false;
}

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
 * A goto whose label no longer exists means a handler deleted the block it jumped to.
 *
 * This used to be "fixed" by deleting the goto - turning a jump into a fallthrough, which
 * is the three-strikes bug in one more form (ITEMS_CalcTransactionCost 0062efb0 lost its
 * `goto switchD_0062f3a0_caseD_2` that way). Every candidate is now proven before it is
 * kept, so this should never fire. If it does, the goto is LEFT IN PLACE, counted and
 * reported with its function: `undefined-goto-label` will still have to stub it, and the
 * census reports that stub as a defect.
 */
function reportOrphanedGotos(root: ASTNode): ASTNode {
  for (const node of traverseAST(root)) {
    if (node.kind !== NodeKind.FunctionDecl) continue;
    const fn = node as FunctionDecl;
    if (!fn.body || fn.body.kind !== NodeKind.CompoundStmt) continue;
    const labels = collectLabels(fn.body);
    for (const n of traverseAST(fn.body)) {
      if (n.kind !== NodeKind.GotoStmt) continue;
      const name = (n as GotoStmt).label.name;
      if (labels.has(name) || !isSimpleLabelName(name)) continue;
      recordStat('orphanGoto');
      gotoReport({ event: 'orphan-goto', label: name });
    }
  }
  return root;
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

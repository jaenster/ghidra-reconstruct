/**
 * Control-flow graph over the statement tree.
 *
 * The transform passes are peephole rewrites over Ghidra's already-structured
 * statement list, and every one of them that DELETES a span has to answer the same
 * question: "can control still get in there?". Answered ad hoc, that question has now
 * been got wrong three times, each time by silently deleting live code:
 *
 *   1. `handleUnconditionalGoto` deleted a span holding a goto target.
 *   2. `dead-branch-cleanup` deleted an `if (false)` arm holding a goto target.
 *   3. `handleUnconditionalGoto` again — this time the span held a `case` label, and a
 *      `case` label is an entry point the switch dispatch jumps to. 170 switch arms
 *      across 29 files were deleted that way and restored by hand.
 *
 * A graph answers it by construction: an entry point is an entry point whether it is
 * spelled `LAB_0064d748:` or `case '\f':`, and reachability is one traversal rather than
 * one bespoke predicate per pass.
 */

import type { Statement } from '../../ast/nodes.js';

/** What a node stands for. Only `Stmt` nodes carry a statement. */
export type CfgNodeRole = 'entry' | 'exit' | 'external' | 'stmt';

export interface CfgNode {
  id: number;
  role: CfgNodeRole;
  stmt: Statement | null;
  /**
   * Canonical spelling of the observable work this node performs, or null when the node
   * is pure control-flow scaffolding (a goto, a label, a compound, a break).
   *
   * Conditions are deliberately NOT work: a cascade legitimately rewrites `if (c) goto L`
   * into `if (!c) { ... }`, so keying on a condition's text would report every correct
   * cascade as a loss. What must survive is the statements the condition guards.
   */
  key: string | null;
  succ: number[];
}

export interface Cfg {
  nodes: CfgNode[];
  /** Fallthrough entry: control arriving from before the region. */
  entry: number;
  /** Where `return` goes. */
  exit: number;
  /** Where control leaving the region goes — a goto to a label outside it, a break out of it. */
  external: number;
  /**
   * Entry points other than `entry`: labels targeted from outside the region, and every
   * `case`/`default` whose switch statement is itself outside the region. Control reaches
   * these without passing through `entry`, so anything they dominate is live.
   */
  extraEntries: number[];
}

export interface BuildCfgOptions {
  /**
   * Whole-function goto counts, label name -> number of `goto`s anywhere in the function.
   * A label whose count exceeds the number of gotos inside the region is targeted from
   * outside it and therefore an entry point. Without this map every label defined in the
   * region is treated as externally targeted, which is the safe answer.
   */
  externalGotoCounts?: Map<string, number> | null;
}

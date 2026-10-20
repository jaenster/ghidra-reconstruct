/**
 * Types for the goto cleanup plugin.
 */

import type {
  DoWhileStmt,
  Expression,
  ForStmt,
  IfStmt,
  Statement,
  WhileStmt,
} from '../../../../ast/nodes.js';

// ============================================
// STATS
// ============================================

export interface GotoCleanupStats {
  switchGotoToBreak: number;
  /** Exact rewrites (exact.ts): no code copied. */
  latchContinue: number;
  nextCase: number;
  stackCase: number;
  rotatedEntry: number;
  ifFalseArm: number;
  /** Gotos the structurer (structure.ts) replaced by the block they jumped to. */
  structureArm: number;
  /** Gotos that only skipped the rest of their block, now `if (!c) { rest }` (structure.ts). */
  structureSkip: number;
  /** Loop rewrites (loops.ts): gotos that were a loop's own control, by rewrite. */
  headContinue: number;
  topContinue: number;
  latchFor: number;
  /** latchFor rewrites that needed the entry lemma (C true before the first iteration). */
  latchForLemma: number;
  exitSwap: number;
  exitMove: number;
  exitHoist: number;
  rotateEntry: number;
  /** Gotos that finished a condition, folded into it (conds.ts). */
  dagFold: number;
  /** Gotos that were a compare tree's default edges, now a switch (switchtree.ts). */
  switchTree: number;
  switchCaseGoto: number;
  backwardToLoop: number;
  forwardCascade: number;
  cleanupTailInline: number;
  nestedTailInline: number;
  loopBodyGoto: number;
  unconditionalGoto: number;
  /**
   * Candidates a handler produced and the preservation check refused, because they would
   * have made reachable work unreachable. Not an error - the compound keeps its gotos.
   * A number that climbs after a generator change is the signal that the change is
   * deleting live code somewhere.
   */
  vetoedUnsafe: number;
  /** Candidates the translation validator proved equivalent (validate.ts). */
  cfVerified: number;
  /**
   * Candidates the validator could NOT prove. In log mode they are still applied - each one
   * is a rewrite whose correctness nothing has established, reported with its function.
   * In enforce mode they are dropped and the goto stays.
   */
  cfVerifyFail: number;
  /** Functions still changing when MAX_WHOLE_AST_PASSES ran out (reported, not hidden). */
  passLimitHit: number;
  /** Gotos left pointing at a label no handler kept. Must be 0. */
  orphanGoto: number;
  /** Copies kept, per evidence class (copy-policy.ts); copyNone only in log mode. */
  copyE3: number;
  copyE4: number;
  copyE6: number;
  /** E6 copies with instruction or join evidence (A1-A3), and those without (terminating tails only). */
  copyE6Evidenced: number;
  copyE6Unproven: number;
  copyNone: number;
  /** Work nodes those copies added. */
  copiedWorkNodes: number;
  /** Blocks moved to their only goto site (no copy: nothing else reached them). */
  movedBlocks: number;
  total: number;
}

// ============================================
// ANALYSIS TYPES
// ============================================

export type LabelKind = 'exit-return' | 'exit-noreturn' | 'cleanup-return' | 'cleanup-fallthrough' | 'fallthrough';

export type GotoContext = 'top-level-if' | 'unconditional' | 'end-of-if-then' | 'loop-body' | 'cross-scope-terminal';

export interface LabelInfo {
  name: string;
  index: number;
  /** The label's own statement + everything after the label to end of compound */
  tailStatements: Statement[];
  kind: LabelKind;
}

export interface NestedLabelInfo {
  name: string;
  tailStatements: Statement[];
  kind: LabelKind;
  /**
   * True when falling off the end of this label's tail reaches the function's implicit
   * `return;` — i.e. the tail is at the tail of a void function body. False everywhere
   * else (end of an if/else branch, loop body, switch case), where fallthrough continues
   * into code that may still compute and return a value.
   */
  fallthroughReturns: boolean;
}

export interface GotoInfo {
  index: number;
  context: GotoContext;
  label: string;
  /** The wrapping IfStmt (for top-level-if, end-of-if-then, cross-scope-terminal) */
  ifStmt?: IfStmt;
  /** The wrapping loop statement (for loop-body) */
  loopStmt?: ForStmt | WhileStmt | DoWhileStmt;
  /** Index of the goto within the loop body (for loop-body) */
  loopGotoIndex?: number;
  /** Number of raw goto nodes accounted for by this entry */
  gotoCount?: number;
}

export interface BackwardGotoEntry {
  index: number;
  /** 'bare' = goto L; | 'simple-conditional' = if (cond) goto L; | 'nested' = goto inside nested scope */
  kind: 'bare' | 'simple-conditional' | 'nested';
  ifStmt?: IfStmt;
  /** Number of gotos accounted for by this entry (>1 for nested with multiple gotos) */
  nestedCount?: number;
}

export interface GotoCleanupOptions {
  /**
   * Whether the function whose body is being transformed returns void. Callers that
   * parse a bare body inside a synthetic `void dummy()` wrapper MUST set this — the
   * wrapper's own `void` says nothing about the real function, and a fabricated bare
   * `return;` in a non-void function drops the returned value.
   */
  enclosingReturnsVoid?: boolean;
  maxNestingDepth?: number;
  noreturnFunctions?: string[];
  detectGhidraNoreturn?: boolean;
  eliminateDeadCode?: boolean;
}

export type RequiredGotoCleanupOptions = Required<Omit<GotoCleanupOptions, 'enclosingReturnsVoid'>>;

// ============================================
// CONSTANTS
// ============================================

export const DEFAULT_MAX_NESTING = 8;
export const MAX_FIXPOINT_PASSES = 50;
/**
 * Whole-AST rounds. Restructuring a compound can create NEW nested compounds (an if/else
 * body built from a goto cascade) that the bottom-up walk has already passed. Re-running
 * the walk lets those be structured too, instead of leaving a goto behind.
 */
export const MAX_WHOLE_AST_PASSES = 4;

export const DEFAULT_NORETURN_FUNCTIONS = new Set([
  'exit', '_exit', '_Exit', 'abort', '__halt', 'halt_baddata',
  'quick_exit', 'ExitProcess', 'TerminateProcess',
  'ERROR_UnrecoverableInternalError_Halt',
]);

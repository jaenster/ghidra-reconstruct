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
  switchCaseGoto: number;
  backwardToLoop: number;
  forwardCascade: number;
  cleanupTailInline: number;
  nestedTailInline: number;
  loopBodyGoto: number;
  unconditionalGoto: number;
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
  maxNestingDepth?: number;
  noreturnFunctions?: string[];
  detectGhidraNoreturn?: boolean;
  eliminateDeadCode?: boolean;
}

export type RequiredGotoCleanupOptions = Required<GotoCleanupOptions>;

// ============================================
// CONSTANTS
// ============================================

export const DEFAULT_MAX_NESTING = 8;
export const MAX_FIXPOINT_PASSES = 50;
export const MAX_INLINE_TAIL_SIZE = 20;

export const DEFAULT_NORETURN_FUNCTIONS = new Set([
  'exit', '_exit', '_Exit', 'abort', '__halt', 'halt_baddata',
  'quick_exit', 'ExitProcess', 'TerminateProcess',
  'ERROR_UnrecoverableInternalError_Halt',
]);

/**
 * Stats tracking for goto cleanup transforms.
 *
 * Uses Symbol.for to create a process-global singleton so stats are shared
 * across multiple module instances (e.g. when tsx loads both dist/ and source paths).
 */

import type { GotoCleanupStats } from './types.js';

const emptyStats = (): GotoCleanupStats => ({
  switchGotoToBreak: 0,
  latchContinue: 0,
  nextCase: 0,
  stackCase: 0,
  rotatedEntry: 0,
  ifFalseArm: 0,
  structureArm: 0,
  structureSkip: 0,
  headContinue: 0,
  topContinue: 0,
  latchFor: 0,
  latchForLemma: 0,
  exitSwap: 0,
  exitMove: 0,
  exitHoist: 0,
  rotateEntry: 0,
  dagFold: 0,
  switchTree: 0,
  switchCaseGoto: 0,
  backwardToLoop: 0,
  forwardCascade: 0,
  cleanupTailInline: 0,
  nestedTailInline: 0,
  loopBodyGoto: 0,
  unconditionalGoto: 0,
  vetoedUnsafe: 0,
  cfVerified: 0,
  cfVerifyFail: 0,
  passLimitHit: 0,
  orphanGoto: 0,
  copyE1: 0,
  rebindBreak: 0,
  rethread: 0,
  copyE3: 0,
  copyE4: 0,
  copyE6: 0,
  copyE6Evidenced: 0,
  copyE6Unproven: 0,
  copyNone: 0,
  copiedWorkNodes: 0,
  movedBlocks: 0,
  total: 0,
});

const STATS_KEY = Symbol.for('ghidra-mcp:goto-cleanup-stats');

function getStats(): GotoCleanupStats {
  if (!(globalThis as any)[STATS_KEY]) {
    (globalThis as any)[STATS_KEY] = emptyStats();
  }
  return (globalThis as any)[STATS_KEY];
}

export function getGotoCleanupStats(): GotoCleanupStats { return { ...getStats() }; }
export function resetGotoCleanupStats(): void { (globalThis as any)[STATS_KEY] = emptyStats(); }

export function recordStat(kind: keyof Omit<GotoCleanupStats, 'total'>, count: number = 1): void {
  const s = getStats();
  s[kind] += count;
  // `total` counts transforms APPLIED. A vetoed candidate was not applied.
  // Neither does a proof outcome: it is a verdict on a candidate, not a transform.
  if (kind !== 'vetoedUnsafe' && kind !== 'cfVerified' && kind !== 'cfVerifyFail'
    && kind !== 'passLimitHit' && kind !== 'orphanGoto' && kind !== 'rebindBreak' && !kind.startsWith('cop') && kind !== 'movedBlocks') s.total += count;
}

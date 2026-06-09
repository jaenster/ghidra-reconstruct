/**
 * Stats tracking for goto cleanup transforms.
 *
 * Uses Symbol.for to create a process-global singleton so stats are shared
 * across multiple module instances (e.g. when tsx loads both dist/ and source paths).
 */

import type { GotoCleanupStats } from './types.js';

const emptyStats = (): GotoCleanupStats => ({
  switchGotoToBreak: 0,
  switchCaseGoto: 0,
  backwardToLoop: 0,
  forwardCascade: 0,
  cleanupTailInline: 0,
  nestedTailInline: 0,
  loopBodyGoto: 0,
  unconditionalGoto: 0,
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
  s.total += count;
}

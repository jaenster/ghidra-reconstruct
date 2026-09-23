/**
 * The defect lint: runtime-defect classes that compile cleanly, asked of the emitted tree's AST.
 *
 * Every check encodes a class that already cost a debug cycle - a global Ghidra sized one
 * byte that the code memcpy's 0x30000 into, a stack buffer split by a phantom local, a loop
 * bound that is another symbol's address. The compiler accepts all of them. These checks
 * report CANDIDATES against an accepted baseline; a new one needs a human judgement.
 */

import type { Check, Finding } from './context.js';
import { LintContext } from './context.js';
import { loadTree, type Tree } from './tree.js';
import { loadSnapshot, type Snapshot } from './snapshot.js';
import { addressRunBound, constantShapedAddress, indexedScalarGlobal, oversizedGlobalWrite, truncatedStringGlobal } from './checks/globals.js';
import { oobLocalAccess, oversizedFormattedWrite, oversizedFrameWrite, undersizedStackBuffer } from './checks/buffers.js';
import { unassignedLocalRead, uninitialisedSendBuffer } from './checks/locals.js';
import { arglessIndirectCall } from './checks/calls.js';
import { structPackingMismatch } from './checks/layout.js';

export type { Check, Finding } from './context.js';
export { LintContext } from './context.js';
export * from './baseline.js';
export { loadTree, treeFromFiles, parseSource } from './tree.js';
export { loadSnapshot, buildSnapshot } from './snapshot.js';

/** In the order lint.py reported them. */
export const ALL_CHECKS: Check[] = [
  indexedScalarGlobal,
  oversizedGlobalWrite,
  undersizedStackBuffer,
  truncatedStringGlobal,
  structPackingMismatch,
  constantShapedAddress,
  addressRunBound,
  oversizedFrameWrite,
  unassignedLocalRead,
  arglessIndirectCall,
  uninitialisedSendBuffer,
  oversizedFormattedWrite,
  oobLocalAccess,
];

export interface RunResult {
  findings: Finding[];
  errors: Array<{ check: string; error: string }>;
  tree: Tree;
}

export function runChecks(tree: Tree, snapshot: Snapshot | null, checks: Check[] = ALL_CHECKS): RunResult {
  const ctx = new LintContext(tree, snapshot);
  const findings: Finding[] = [];
  const errors: Array<{ check: string; error: string }> = [];
  for (const c of checks) {
    try {
      findings.push(...c.run(ctx));
    } catch (e: any) {
      // A broken check must not hide the others.
      errors.push({ check: c.id, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}` });
    }
  }
  return { findings, errors, tree };
}

export function lintTree(root: string, opts: { snapshotDir?: string; checks?: Check[] } = {}): RunResult {
  return runChecks(loadTree(root), loadSnapshot(opts.snapshotDir), opts.checks);
}

/**
 * Per-function event log for the goto passes.
 *
 * A stat counter says HOW MANY rewrites the validator could not prove; triage needs WHICH -
 * the function address, the handler, the reason, and the region before and after. When
 * `GHIDRA_GOTO_REPORT_DIR` is set every event is appended as one JSON line to
 * `<dir>/events-<pid>-<thread>.ndjson` (generation runs in worker threads, so each writes
 * its own file). With `GHIDRA_GOTO_REPORT_PAIRS=1` the region text before and after is
 * included, for the offline skeleton run (scripts/goto-skeleton-check.ts).
 *
 * Unset, this is a no-op: the generator's output does not depend on it.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';

const FN_KEY = Symbol.for('ghidra-mcp:goto-cleanup-current-function');

/** The function whose body is being transformed, for attributing events. */
export function setCurrentGotoFunction(address: string | null): void {
  (globalThis as Record<symbol, unknown>)[FN_KEY] = address;
}

export function currentGotoFunction(): string | null {
  return ((globalThis as Record<symbol, unknown>)[FN_KEY] as string | null | undefined) ?? null;
}

let dirReady: string | null = null;

export function gotoReportEnabled(): boolean {
  return !!process.env.GHIDRA_GOTO_REPORT_DIR;
}

export function gotoReportPairs(): boolean {
  return gotoReportEnabled() && process.env.GHIDRA_GOTO_REPORT_PAIRS === '1';
}

export function gotoReport(event: Record<string, unknown>): void {
  const dir = process.env.GHIDRA_GOTO_REPORT_DIR;
  if (!dir) return;
  if (dirReady !== dir) { mkdirSync(dir, { recursive: true }); dirReady = dir; }
  const line = JSON.stringify({ fn: currentGotoFunction(), ...event });
  appendFileSync(join(dir, `events-${process.pid}-${threadId}.ndjson`), line + '\n');
}

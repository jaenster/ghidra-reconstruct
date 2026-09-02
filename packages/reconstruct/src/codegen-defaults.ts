/**
 * Process-wide emitter configuration.
 *
 * These are settings an ENTRY POINT applies, not settings that travel in
 * `ReconstructOptions`: which transform plugins are enabled, where parse errors
 * are logged. A generation worker is a separate module graph with its own
 * registries, so it has to apply exactly the same ones — a worker that skipped
 * them emits different bodies from the coordinator and the two halves of the
 * tree disagree, silently.
 *
 * It lives in the package rather than beside run.ts so the worker can reach it
 * from its own build without importing the entry point.
 */

import { setParseErrorLogPath } from './codegen/index.js';
import { resetGotoCleanupStats, defaultRegistry } from '@ghidra-mcp/cpp-parser';

export function configureCodegen(parseErrorLogPath?: string): void {
  if (parseErrorLogPath) {
    try { setParseErrorLogPath(parseErrorLogPath); } catch { /* a log is optional */ }
  }
  resetGotoCleanupStats();
  defaultRegistry.setEnabled('goto-cleanup', true);
}

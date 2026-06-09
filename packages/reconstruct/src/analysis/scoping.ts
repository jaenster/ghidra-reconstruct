/**
 * Variable scoping analysis
 *
 * Analyzes which global variables should be converted to static file-local
 * or function-local variables based on their usage patterns.
 */

import type { ExtractedGlobal, ExtractedFunction, ScopingAnalysis } from '../types.js';

export interface ScopingResult {
  analyses: ScopingAnalysis[];
  stats: {
    totalGlobals: number;
    shouldBeStatic: number;
    usedByMultipleFunctions: number;
    unused: number;
  };
}

/**
 * Analyze scoping of global variables
 *
 * Determines which globals are only used by a single function and could
 * be promoted to static local variables.
 */
export function analyzeScoping(
  globals: ExtractedGlobal[],
  functions: ExtractedFunction[]
): ScopingAnalysis[] {
  const results: ScopingAnalysis[] = [];

  // Build a map of which functions reference which globals
  // This is a simplified analysis based on name matching in decompiled code
  const globalUsage = new Map<string, Set<string>>();

  for (const global of globals) {
    globalUsage.set(global.address, new Set());
  }

  // Analyze function decompilations for global references
  for (const func of functions) {
    if (!func.decompiled) continue;

    for (const global of globals) {
      // Check if the global name appears in the decompiled code
      // This is a heuristic - ideally we'd use xref data
      if (func.decompiled.includes(global.name)) {
        globalUsage.get(global.address)?.add(func.address);
      }
    }
  }

  // Also use xref counts for globals that we have
  for (const global of globals) {
    const usage = globalUsage.get(global.address) || new Set();

    const analysis: ScopingAnalysis = {
      globalId: global.address,
      globalName: global.name,
      address: global.address,
      usedInFunctions: Array.from(usage),
      shouldBeStatic: false,
    };

    // Determine if this should be static
    if (usage.size === 0) {
      // Unused global - might be dead code or accessed indirectly
      analysis.shouldBeStatic = false;
    } else if (usage.size === 1) {
      // Used by exactly one function - promote to static local
      analysis.shouldBeStatic = true;
      analysis.suggestedLocation = Array.from(usage)[0];
    } else {
      // Used by multiple functions - keep as global
      analysis.shouldBeStatic = false;
    }

    results.push(analysis);
  }

  return results;
}

/**
 * Get statistics about scoping analysis
 */
export function getScopingStats(analyses: ScopingAnalysis[]): ScopingResult['stats'] {
  let shouldBeStatic = 0;
  let usedByMultipleFunctions = 0;
  let unused = 0;

  for (const analysis of analyses) {
    if (analysis.shouldBeStatic) {
      shouldBeStatic++;
    } else if (analysis.usedInFunctions.length === 0) {
      unused++;
    } else if (analysis.usedInFunctions.length > 1) {
      usedByMultipleFunctions++;
    }
  }

  return {
    totalGlobals: analyses.length,
    shouldBeStatic,
    usedByMultipleFunctions,
    unused,
  };
}

/**
 * Group globals by suggested location (function where they should be static)
 */
export function groupByLocation(
  analyses: ScopingAnalysis[]
): Map<string, ScopingAnalysis[]> {
  const groups = new Map<string, ScopingAnalysis[]>();

  for (const analysis of analyses) {
    if (analysis.shouldBeStatic && analysis.suggestedLocation) {
      if (!groups.has(analysis.suggestedLocation)) {
        groups.set(analysis.suggestedLocation, []);
      }
      groups.get(analysis.suggestedLocation)!.push(analysis);
    }
  }

  return groups;
}

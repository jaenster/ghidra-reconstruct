/**
 * Static promotion analysis
 *
 * Analyzes which globals and functions should be marked as static
 * (file-local) based on their usage patterns.
 */

import type { ExtractedGlobal, ExtractedFunction, ScopingAnalysis } from '../types.js';
import { analyzeScoping } from './scoping.js';

export interface StaticPromotionResult {
  /** Globals that should be promoted to static */
  staticGlobals: StaticGlobalPromotion[];

  /** Functions that could be marked as static */
  staticFunctions: StaticFunctionPromotion[];

  /** Statistics */
  stats: {
    globalsAnalyzed: number;
    globalsPromoted: number;
    functionsAnalyzed: number;
    functionsPromoted: number;
  };
}

export interface StaticGlobalPromotion {
  /** Original global name */
  name: string;

  /** Global address */
  address: string;

  /** The function where this should become a static local */
  targetFunction: string;

  /** Suggested new name (prefixed with s_ for static) */
  suggestedName: string;

  /** The data type */
  dataType: string;
}

export interface StaticFunctionPromotion {
  /** Function name */
  name: string;

  /** Function address */
  address: string;

  /** Why this function can be static */
  reason: string;
}

/**
 * Analyze static promotion opportunities
 */
export function analyzeStaticPromotion(
  globals: ExtractedGlobal[],
  functions: ExtractedFunction[]
): StaticPromotionResult {
  // Analyze global scoping
  const scopingResults = analyzeScoping(globals, functions);

  // Determine globals that should be static
  const staticGlobals: StaticGlobalPromotion[] = [];
  for (const analysis of scopingResults) {
    if (analysis.shouldBeStatic && analysis.suggestedLocation) {
      const global = globals.find(g => g.address === analysis.globalId);
      if (!global) continue;

      staticGlobals.push({
        name: global.name,
        address: global.address,
        targetFunction: analysis.suggestedLocation,
        suggestedName: `s_${global.name}`,
        dataType: global.dataType,
      });
    }
  }

  // Analyze functions that could be static
  const staticFunctions = analyzeStaticFunctions(functions);

  return {
    staticGlobals,
    staticFunctions,
    stats: {
      globalsAnalyzed: globals.length,
      globalsPromoted: staticGlobals.length,
      functionsAnalyzed: functions.length,
      functionsPromoted: staticFunctions.length,
    },
  };
}

/**
 * Analyze which functions could be marked as static
 */
function analyzeStaticFunctions(
  functions: ExtractedFunction[]
): StaticFunctionPromotion[] {
  const staticFunctions: StaticFunctionPromotion[] = [];

  // Build a set of all called functions
  const calledFunctions = new Set<string>();
  for (const func of functions) {
    if (!func.decompiled) continue;

    // Extract function calls from decompiled code
    for (const otherFunc of functions) {
      if (func.decompiled.includes(otherFunc.name + '(')) {
        calledFunctions.add(otherFunc.address);
      }
    }
  }

  // Find functions that are only called from within the same file/namespace
  const namespaceCallMap = new Map<string, Set<string>>();

  for (const func of functions) {
    if (!func.decompiled) continue;

    const namespace = func.namespace || '__global__';
    if (!namespaceCallMap.has(namespace)) {
      namespaceCallMap.set(namespace, new Set());
    }

    // Find calls from this function
    for (const otherFunc of functions) {
      if (func.decompiled.includes(otherFunc.name + '(')) {
        namespaceCallMap.get(namespace)?.add(otherFunc.address);
      }
    }
  }

  // A function can be static if:
  // 1. It's not external
  // 2. It's not exported
  // 3. All callers are in the same namespace
  for (const func of functions) {
    if (func.isExternal || func.isThunk) continue;

    // Check if all callers are in the same namespace
    const namespace = func.namespace || '__global__';
    let allCallersInSameNamespace = true;

    for (const [ns, calls] of namespaceCallMap) {
      if (ns !== namespace && calls.has(func.address)) {
        allCallersInSameNamespace = false;
        break;
      }
    }

    // Check if this function is only used internally
    if (allCallersInSameNamespace && !isLikelyExported(func)) {
      staticFunctions.push({
        name: func.name,
        address: func.address,
        reason: 'Only called from within same namespace',
      });
    }
  }

  return staticFunctions;
}

/**
 * Check if a function is likely exported/public API
 */
function isLikelyExported(func: ExtractedFunction): boolean {
  // Check naming patterns that suggest public API
  const publicPatterns = [
    /^[A-Z][a-z]+[A-Z]/, // CamelCase like CreateWindow
    /^[a-z]+_[a-z]+/,    // snake_case like create_window
    /^init_/,
    /^main$/,
    /^_start$/,
    /^entry$/,
  ];

  for (const pattern of publicPatterns) {
    if (pattern.test(func.name)) {
      return true;
    }
  }

  // Auto-generated names are less likely to be intentionally exported
  if (func.name.startsWith('FUN_') || func.name.startsWith('sub_')) {
    return false;
  }

  return false;
}

/**
 * Apply static promotions to get suggested code changes
 */
export function getStaticPromotionChanges(
  result: StaticPromotionResult
): Map<string, string[]> {
  const changes = new Map<string, string[]>();

  // Group globals by target function
  for (const promotion of result.staticGlobals) {
    const functionId = promotion.targetFunction;
    if (!changes.has(functionId)) {
      changes.set(functionId, []);
    }

    changes.get(functionId)!.push(
      `static ${promotion.dataType} ${promotion.suggestedName}; // was global: ${promotion.name}`
    );
  }

  return changes;
}

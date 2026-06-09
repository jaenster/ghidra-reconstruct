/**
 * Incremental extraction — re-extract only dirty symbols from Ghidra.
 *
 * Uses the DirtyTracker on the Java worker side to determine what changed
 * since the last clean mark, then extracts only those items.
 */

import type {
  GhidraConnection,
  ExtractedFunction,
  ExtractedDataType,
  AnalyzedDataSymbol,
} from '../types.js';
import type { BuildInfo } from '../modules/buildinfo.js';

export interface IncrementalResult {
  /** Whether anything changed since last clean */
  changed: boolean;
  /** Previous buildinfo (passthrough if unchanged) */
  buildInfo: BuildInfo;
  /** Newly extracted functions (only dirty ones) */
  functions?: ExtractedFunction[];
  /** Newly extracted data types (only dirty ones) */
  dataTypes?: ExtractedDataType[];
  /** Newly extracted globals (only dirty ones) */
  globals?: AnalyzedDataSymbol[];
  /** Affected module IDs that need re-emission */
  affectedModules?: string[];
}

/**
 * Query the worker for dirty symbols and extract only what changed.
 *
 * Returns an IncrementalResult with the changed items, or { changed: false }
 * if nothing was modified.
 */
export async function extractIncremental(
  connection: GhidraConnection,
  previousBuildInfo: BuildInfo,
): Promise<IncrementalResult> {
  // 1. Query what's dirty
  const dirty = await connection.sendCommand('get_dirty_symbols', {}) as {
    functions: string[];
    dataTypes: string[];
    globals: string[];
    lastCleanVersion: number;
  };

  if (dirty.functions.length === 0 && dirty.dataTypes.length === 0 && dirty.globals.length === 0) {
    return { changed: false, buildInfo: previousBuildInfo };
  }

  // 2. Re-extract only dirty items
  const functions: ExtractedFunction[] = [];
  if (dirty.functions.length > 0) {
    // Extract each dirty function individually
    for (const addr of dirty.functions) {
      try {
        const result = await connection.sendCommand('decompile', { address: addr }) as any;
        if (result) {
          functions.push({
            name: result.name ?? `FUN_${addr.replace(/^0x/, '')}`,
            address: addr,
            signature: result.signature ?? '',
            returnType: result.returnType ?? 'void',
            parameters: result.parameters ?? [],
            localVariables: result.localVariables ?? [],
            callingConvention: result.callingConvention ?? '__cdecl',
            size: result.size ?? 0,
            isThunk: result.isThunk ?? false,
            isExternal: result.isExternal ?? false,
            hasVarArgs: result.hasVarArgs ?? false,
            namespace: result.namespace,
            calledFunctions: result.calledFunctions ?? [],
            decompiled: result.pseudocode,
          });
        }
      } catch {
        // Skip functions that fail to decompile
      }
    }
  }

  const dataTypes: ExtractedDataType[] = [];
  if (dirty.dataTypes.length > 0) {
    // Re-extract all data types (cheaper than selective)
    const allTypes = await connection.sendCommand('list_data_types', {}) as any;
    if (Array.isArray(allTypes?.types)) {
      for (const dt of allTypes.types) {
        if (dirty.dataTypes.some(d => d.includes(dt.name))) {
          dataTypes.push(dt);
        }
      }
    }
  }

  // 3. Determine affected modules from buildinfo
  const affectedModules = new Set<string>();
  for (const func of functions) {
    const moduleId = previousBuildInfo.symbolIndex[func.name];
    if (moduleId) affectedModules.add(moduleId);
  }
  for (const dt of dataTypes) {
    const moduleId = previousBuildInfo.symbolIndex[dt.name];
    if (moduleId) affectedModules.add(moduleId);
  }
  // Also mark modules that include affected modules
  for (const modId of [...affectedModules]) {
    for (const [id, resolved] of Object.entries(previousBuildInfo.resolved)) {
      if (resolved.headerIncludes.includes(modId) || resolved.implIncludes.includes(modId)) {
        affectedModules.add(id);
      }
    }
  }

  // 4. Mark clean
  await connection.sendCommand('mark_clean', {});

  return {
    changed: true,
    buildInfo: previousBuildInfo,
    functions,
    dataTypes,
    globals: [],
    affectedModules: [...affectedModules],
  };
}

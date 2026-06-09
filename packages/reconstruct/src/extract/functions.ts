/**
 * Function extraction from Ghidra
 */

import type {
  GhidraConnection,
  ExtractedFunction,
  ExtractedParameter,
  ExtractedVariable,
} from '../types.js';
import { FunctionCache, type CacheOptions } from '../cache.js';

/**
 * Options for function extraction
 */
export interface FunctionExtractionOptions {
  /** Filter function names by regex pattern */
  filter?: string;

  /** Filter by namespace */
  namespace?: string;

  /** Maximum number of functions to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Include decompiled code */
  decompile?: boolean;

  /** Decompilation timeout in seconds */
  decompileTimeout?: number;

  /** Progress callback */
  onProgress?: (current: number, total: number) => void;

  /** Cache options for decompiled results */
  cache?: FunctionCache | CacheOptions | boolean;

  /** Exclude functions matching these patterns (common library code) */
  excludePatterns?: (string | RegExp)[];

  /** Use default exclusions for C runtime and Visual Studio code */
  excludeLibraryCode?: boolean;
}

/**
 * Default patterns to exclude common C runtime and Visual Studio library functions
 */
export const DEFAULT_LIBRARY_EXCLUSION_PATTERNS: RegExp[] = [
  // C runtime library
  /^_?_CRT/,           // CRT initialization
  /^_?_RTC/,           // Runtime checks
  /^_?_security/,      // Security cookies
  /^_?_guard/,         // Control flow guard
  /^_?_SEH/,           // Structured exception handling
  /^_?_except/,        // Exception handling
  /^__GSHandler/,      // GS buffer security
  /^__report_/,        // Runtime reporting
  /^_?_Init/,          // Initialization routines
  /^_?_onexit/,        // Exit handlers
  /^_?_atexit/,        // Exit handlers
  /^_?_cexit/,         // Exit handlers
  /^_?_c_exit/,        // Exit handlers
  /^_?_amsg_exit/,     // Exit handlers
  /^__dyn_tls/,        // Thread local storage
  /^__tls/,            // Thread local storage
  /^_?_matherr/,       // Math error handling
  /^_?_ftol/,          // Float to long conversion
  /^_?_fltused/,       // Float used flag
  /^_?_alldiv/,        // 64-bit division helpers
  /^_?_allmul/,        // 64-bit multiplication helpers
  /^_?_allrem/,        // 64-bit remainder helpers
  /^_?_allshl/,        // 64-bit shift helpers
  /^_?_aullshr/,       // 64-bit shift helpers
  /^_?_chkstk/,        // Stack checking
  /^_?_alloca/,        // Stack allocation
  /^__local_/,         // Local variables
  /^__imp_/,           // Import thunks
  /^__imp__/,          // Import thunks

  // Visual Studio specific
  /^_?_vcrt/,          // Visual C runtime
  /^_?_NMSG_/,         // Error messages
  /^_?_crt_/,          // CRT functions
  /^_?__crt/,          // CRT functions
  /^_?_o_/,            // CRT internal
  /^_?_ismbblead/,     // Multi-byte character
  /^_?_ismbslead/,     // Multi-byte string
  /^_?_mbschr/,        // Multi-byte string
  /^__scrt_/,          // Static CRT
  /^__acrt_/,          // App CRT
  /^__vcrt_/,          // Visual C runtime
  /^__std_/,           // Standard library internals

  // Standard library internals
  /^std::_/,           // STL implementation details
  /^`/,                // MSVC mangled internal names (start with backtick)

  // Compiler-generated
  /^\?\?/,             // MSVC mangled operators
  /^__ehhandler/,      // Exception handlers
  /^__unwind/,         // Unwinding helpers

  // Common thunks and wrappers
  /^thunk/i,           // Thunk functions
  /^Ordinal_/,         // Ordinal imports
  /^@ILT\+/,           // Incremental link table
];

/**
 * Check if a function should be excluded based on patterns
 */
export function shouldExcludeFunction(
  func: { name: string; namespace?: string; isExternal?: boolean; isThunk?: boolean },
  patterns: (string | RegExp)[]
): boolean {
  // Always exclude external and thunk functions
  if (func.isExternal || func.isThunk) {
    return true;
  }

  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (func.name.includes(pattern)) return true;
      if (func.namespace && func.namespace.includes(pattern)) return true;
    } else {
      if (pattern.test(func.name)) return true;
      if (func.namespace && pattern.test(func.namespace)) return true;
    }
  }

  return false;
}

interface GhidraFunctionInfo {
  name: string;
  address: string;
  entryPoint?: string;
  signature: string;
  returnType: string;
  parameterCount?: number;
  parameters?: Array<{
    name: string;
    dataType: string;
    size: number;
    ordinal: number;
    storage?: string;
  }>;
  localVariables?: Array<{
    name: string;
    dataType: string;
    size: number;
    storage: string;
    stackOffset?: number;
    register?: string;
  }>;
  callingConvention: string;
  size: number;
  isThunk: boolean;
  isExternal: boolean;
  hasVarArgs: boolean;
  namespace?: string;
  comment?: string;
  sourceFile?: string;
  sourceLine?: number;
  tags?: Array<{ type: string; data?: string }>;
}

interface GhidraDecompileResult {
  functionName: string;
  address: string;
  signature: string;
  pseudocode: string;
  warnings?: string[];
}

interface BatchDecompileResult {
  results: Array<{ functionName: string; address: string; signature: string; pseudocode: string; warnings?: string[] }>;
  failed: Array<{ address: string; name: string; error: string }>;
  total: number;
  decompiled: number;
}

/**
 * Extract functions from Ghidra with pagination
 */
export async function extractFunctions(
  connection: GhidraConnection,
  options: FunctionExtractionOptions = {}
): Promise<{
  functions: ExtractedFunction[];
  total: number;
}> {
  const { filter, namespace, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
  };

  if (filter) params.filter = filter;
  if (namespace) {
    params.namespace = namespace;
    params.includeChildren = true;
  }

  params._commandTimeout = 300000; // 5 minutes — 13K+ functions in large binaries

  const result = await connection.sendCommand<{
    functions: GhidraFunctionInfo[];
    total: number;
  }>('list_functions', params);

  return {
    functions: result.functions.map(mapFunctionInfo),
    total: result.total,
  };
}

/**
 * Extract all functions from Ghidra (handles pagination)
 */
export async function extractAllFunctions(
  connection: GhidraConnection,
  options: FunctionExtractionOptions = {}
): Promise<ExtractedFunction[]> {
  const {
    filter,
    namespace,
    decompile = false,
    decompileTimeout = 30,
    onProgress,
    cache: cacheOption,
    excludePatterns,
    excludeLibraryCode = false,
  } = options;

  // Build exclusion patterns list
  const patterns: (string | RegExp)[] = [];
  if (excludeLibraryCode) {
    patterns.push(...DEFAULT_LIBRARY_EXCLUSION_PATTERNS);
  }
  if (excludePatterns) {
    patterns.push(...excludePatterns);
  }

  // Set up cache
  const cache = resolveCache(cacheOption);

  let allFunctions: ExtractedFunction[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = 0;

  // First pass: get all function info
  do {
    const result = await extractFunctions(connection, {
      filter,
      namespace,
      limit: pageSize,
      offset,
    });

    allFunctions.push(...result.functions);
    total = result.total;
    offset += pageSize;

    onProgress?.(Math.min(offset, total), total);
  } while (offset < total);

  // Filter out excluded functions
  if (patterns.length > 0) {
    const beforeCount = allFunctions.length;
    allFunctions = allFunctions.filter(func => !shouldExcludeFunction(func, patterns));
    const excludedCount = beforeCount - allFunctions.length;
    if (excludedCount > 0) {
      // Progress callback can be used to report exclusions if needed
    }
  }

  // Second pass: decompile if requested — use batch_decompile for speed
  if (decompile) {
    let cacheHits = 0;

    // Collect addresses that need decompilation
    const needsDecompile: { idx: number; address: string }[] = [];

    for (let i = 0; i < allFunctions.length; i++) {
      const func = allFunctions[i];
      if (func.isExternal || func.isThunk) continue;

      // Check cache first
      if (cache) {
        const cached = await cache.getByAddress(func.address);
        if (cached) {
          func.decompiled = cached;
          cacheHits++;
          continue;
        }
      }
      needsDecompile.push({ idx: i, address: func.address });
    }

    if (cacheHits > 0) {
      console.log(`  Cache hits: ${cacheHits}, need decompile: ${needsDecompile.length}`);
    }

    // Batch decompile in chunks (Java uses DecompilerPool for parallel decompilation)
    const BATCH_SIZE = 50;
    let decompiled = 0;

    for (let i = 0; i < needsDecompile.length; i += BATCH_SIZE) {
      const batch = needsDecompile.slice(i, i + BATCH_SIZE);
      const addresses = batch.map(b => b.address);

      try {
        const result = await connection.sendCommand<BatchDecompileResult>(
          'batch_decompile',
          {
            addresses,
            limit: addresses.length,
            decompileTimeout,
            _commandTimeout: Math.max(300000, (decompileTimeout + 5) * addresses.length * 1000),
          }
        );

        // Map results back by address
        const resultByAddr = new Map(result.results.map(r => [r.address, r]));
        for (const { idx, address } of batch) {
          const decomp = resultByAddr.get(address);
          if (decomp) {
            allFunctions[idx].decompiled = decomp.pseudocode;
            if (cache) await cache.setByAddress(address, decomp.pseudocode);
            decompiled++;
          }
        }

        if (result.failed.length > 0) {
          console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.failed.length} failures`);
        }
      } catch (err) {
        console.error(`  Batch decompile failed for addresses ${i}-${i + batch.length}: ${err}`);
        // Fall back to cached results if available
        if (cache) {
          for (const { idx, address } of batch) {
            const cached = await cache.getByAddress(address);
            if (cached) allFunctions[idx].decompiled = cached;
          }
        }
      }

      onProgress?.(Math.min(i + BATCH_SIZE, needsDecompile.length), needsDecompile.length);
    }

    console.log(`  Decompiled: ${decompiled}/${needsDecompile.length}`);
  }

  return allFunctions;
}

/**
 * Resolve cache option to a FunctionCache instance
 */
function resolveCache(option?: FunctionCache | CacheOptions | boolean): FunctionCache | null {
  if (option === undefined || option === null || option === false) return null;
  if (option === true) return new FunctionCache();
  if (option instanceof FunctionCache) return option;
  // Must be CacheOptions
  return new FunctionCache(option as CacheOptions);
}

/**
 * Decompile with cache support
 */
async function decompileFunctionWithCache(
  connection: GhidraConnection,
  address: string,
  timeout: number,
  cache: FunctionCache | null
): Promise<{ code: string; fromCache: boolean }> {
  // Without cache, just decompile directly
  if (!cache) {
    const code = await decompileFunction(connection, address, timeout);
    return { code, fromCache: false };
  }

  // Get the raw pseudocode from Ghidra
  const rawCode = await decompileFunction(connection, address, timeout);
  await cache.setByAddress(address, rawCode);

  // Check if we have a cached transform for this exact pseudocode
  const cached = await cache.get(rawCode);
  if (cached) {
    return { code: cached.transformedCode, fromCache: true };
  }

  // No cache hit - store the raw code for now
  // The actual transform caching happens at a higher level when transforms are applied
  // For now, we just cache the raw decompiled output keyed by itself
  // This is useful if the same function is requested multiple times in a session
  await cache.set(rawCode, rawCode);

  return { code: rawCode, fromCache: false };
}

/**
 * Decompile a single function
 */
export async function decompileFunction(
  connection: GhidraConnection,
  address: string,
  decompileTimeout: number = 30
): Promise<string> {
  const result = await connection.sendCommand<GhidraDecompileResult>('decompile', {
    address,
    // Java handler reads 'timeout' in seconds for Ghidra decompiler timeout
    timeout: decompileTimeout,
    // sendCommand reads '_commandTimeout' (ms) for the command-level timeout
    _commandTimeout: (decompileTimeout + 10) * 1000,
  });

  return result.pseudocode;
}

/**
 * Get detailed info for a single function
 */
export async function getFunctionInfo(
  connection: GhidraConnection,
  address?: string,
  name?: string
): Promise<ExtractedFunction | null> {
  const params: Record<string, unknown> = {};
  if (address) params.address = address;
  if (name) params.name = name;

  try {
    const result = await connection.sendCommand<GhidraFunctionInfo>(
      'get_function_info',
      params
    );
    return mapFunctionInfo(result);
  } catch {
    return null;
  }
}

/**
 * Map Ghidra function info to our type
 */
function mapFunctionInfo(info: GhidraFunctionInfo): ExtractedFunction {
  return {
    name: info.name,
    address: info.address,
    signature: info.signature,
    returnType: info.returnType,
    parameters: (info.parameters ?? []).map(mapParameter),
    localVariables: (info.localVariables ?? []).map(mapVariable),
    namespace: info.namespace,
    callingConvention: info.callingConvention,
    size: info.size,
    isThunk: info.isThunk,
    isExternal: info.isExternal,
    hasVarArgs: info.hasVarArgs,
    comment: info.comment,
    sourceFile: info.sourceFile,
    sourceLine: info.sourceLine,
    tags: info.tags,
  };
}

function mapParameter(param: NonNullable<GhidraFunctionInfo['parameters']>[0]): ExtractedParameter {
  return {
    name: param.name,
    dataType: param.dataType,
    size: param.size,
    ordinal: param.ordinal,
    storage: param.storage,
  };
}

function mapVariable(variable: NonNullable<GhidraFunctionInfo['localVariables']>[0]): ExtractedVariable {
  return {
    name: variable.name,
    dataType: variable.dataType,
    size: variable.size,
    storage: variable.storage,
    stackOffset: variable.stackOffset,
    register: variable.register,
  };
}

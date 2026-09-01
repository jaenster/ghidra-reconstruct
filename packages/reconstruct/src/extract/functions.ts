/**
 * Function extraction from Ghidra
 */

import type {
  GhidraConnection,
  ExtractedFunction,
  ExtractedParameter,
  ExtractedVariable,
  ThunkTarget,
} from '../types.js';
import { FunctionCache, type CacheOptions } from '../cache.js';
import { timePhase } from '../timing.js';
import {
  indexCandidatesBySpelling, nextClosureFrontier, mayReferenceNamespaces,
} from '../codegen/exclusion-closure.js';

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

  /** Prefix for recorded phase names, e.g. "mac" -> "mac/extract/list-functions". */
  phaseLabel?: string;

  /**
   * Decompile only the functions this returns true for. Listing still covers
   * everything; only the BODIES are narrowed.
   *
   * The cross-check binary is the reason this exists: of its 11,379 bodies,
   * 8,221 were decompiled and then thrown away because the merge keeps only the
   * function's ADDRESS for anything the primary binary already has. The caller
   * knows which those are before a single body is fetched, so it says so.
   */
  decompileFilter?: (func: ExtractedFunction) => boolean;
}

/**
 * Default patterns to exclude common C runtime and Visual Studio library functions
 */
/**
 * How many function bodies one `batch_decompile` round-trip asks for. The Java
 * side fans the batch out over its DecompilerPool, so this trades round-trip
 * latency against pool ramp-down at each batch boundary.
 */
const DECOMPILE_BATCH_SIZE = Number(process.env.GHIDRA_DECOMPILE_BATCH_SIZE) || 50;

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
  // Always exclude external functions.
  if (func.isExternal) {
    return true;
  }
  // Thunks (isThunk) are forwarding stubs with no game body. Import/CRT/mangled
  // thunks stay excluded, but GAME thunks (e.g. PLRSKILLS_DrawChargeTrailIfPrimary,
  // NET_*) are referenced by their callers — keeping them lets the header DECLARE
  // them (the impl + decompile paths skip thunk bodies, so they're declaration-only)
  // so cross-module callers compile instead of erroring "not declared in this scope".
  if (func.isThunk && /^(_|Ordinal_|@|std::|`|\?\?|FUN_)/i.test(func.name)) {
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
    phaseLabel,
    decompileFilter,
  } = options;

  const label = phaseLabel ? `${phaseLabel}/` : '';

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
  let decompiledCount = 0;
  let needsDecompileCount = 0;
  let decompileBatches = 0;
  let closureAdmitted = 0;
  let closureRounds = 0;
  const pageSize = 100;
  let offset = 0;
  let total = 0;

  // First pass: get all function info
  let listPages = 0;
  await timePhase(
    `${label}extract/list-functions`,
    async () => {
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
        listPages++;

        onProgress?.(Math.min(offset, total), total);
      } while (offset < total);
    },
    () => `${total} functions in ${listPages} pages of ${pageSize}`
  );

  // Filter out excluded functions.
  //
  // Held, not discarded. An excluded namespace is dropped because it is library
  // code nobody calls, but some of it IS called: `compiler::PKWARE_explode` has
  // 373 bytes of body and a live call site in Storm. Dropping the list here is
  // what made those undefined at link, because a function never listed is a
  // function never decompiled, and codegen cannot emit a body it does not have.
  // The reserve is closed over after decompilation, below.
  const excludedReserve: ExtractedFunction[] = [];
  if (patterns.length > 0) {
    const kept: ExtractedFunction[] = [];
    for (const func of allFunctions) {
      if (shouldExcludeFunction(func, patterns)) excludedReserve.push(func);
      else kept.push(func);
    }
    allFunctions = kept;
  }

  // Where every thunk jumps. One call for the whole program, because the answer
  // exists nowhere else: `list_functions` reports `isThunk` and no target, and
  // decompiling a thunk returns the TARGET's body under the thunk's name.
  {
    const thunks = allFunctions.filter(f => f.isThunk);
    if (thunks.length > 0) {
      let resolved = 0;
      await timePhase(
        `${label}extract/thunk-targets`,
        async () => { resolved = await attachThunkTargets(connection, allFunctions); },
        () => `${resolved}/${thunks.length} thunk targets`
      );
    }
  }

  // Second pass: decompile if requested — use batch_decompile for speed
  if (decompile) {
    await timePhase(
      `${label}extract/decompile`,
      () => decompileAll(),
      () => `${decompiledCount}/${needsDecompileCount} bodies in ${decompileBatches} batches of ${DECOMPILE_BATCH_SIZE}`
    );

    // Third pass: put back the excluded-namespace functions the kept bodies
    // actually reach.
    if (excludedReserve.length > 0) {
      await timePhase(
        `${label}extract/exclusion-closure`,
        () => admitExclusionClosure(),
        () => `${closureAdmitted} reachable excluded-namespace function(s), ${closureRounds} round(s)`
      );
    }
  }

  return allFunctions;

  // ---------------------------------------------------------------------------
  // Decompilation, kept as a closure so the timing wrapper above reads as one
  // phase while the counters below stay in scope for its detail line.
  // ---------------------------------------------------------------------------
  async function decompileAll(): Promise<void> {
    let cacheHits = 0;

    // Collect addresses that need decompilation
    const needsDecompile: { idx: number; address: string }[] = [];

    for (let i = 0; i < allFunctions.length; i++) {
      const func = allFunctions[i];
      if (func.isExternal || func.isThunk) continue;
      if (decompileFilter && !decompileFilter(func)) continue;

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
    const BATCH_SIZE = DECOMPILE_BATCH_SIZE;
    let decompiled = 0;
    needsDecompileCount = needsDecompile.length;

    for (let i = 0; i < needsDecompile.length; i += BATCH_SIZE) {
      decompileBatches++;
      const batch = needsDecompile.slice(i, i + BATCH_SIZE);
      const addresses = batch.map(b => b.address);

      // Retry the batch on transient failures (e.g. "Worker exited" — the daemon
      // respawns the worker, so a retry succeeds). Without this, a single mid-run
      // worker crash silently drops a whole batch (~50 function bodies → "// TODO:
      // Decompilation not available"). On persistent failure, fall back to
      // per-function decompile so one bad function can't sink the batch.
      const MAX_BATCH_RETRIES = 4;
      let batchOk = false;
      for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
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
          batchOk = true;
          break;
        } catch (err) {
          if (attempt < MAX_BATCH_RETRIES) {
            const delay = Math.min(1000 * 2 ** attempt, 8000);
            console.warn(`  Batch decompile (addresses ${i}-${i + batch.length}) failed (attempt ${attempt + 1}/${MAX_BATCH_RETRIES + 1}): ${err} — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            console.error(`  Batch decompile exhausted retries for addresses ${i}-${i + batch.length}: ${err} — falling back to per-function decompile`);
          }
        }
      }

      // Per-function fallback for a batch that never succeeded as a unit.
      if (!batchOk) {
        for (const { idx, address } of batch) {
          try {
            const code = await decompileFunction(connection, address, decompileTimeout);
            if (code) {
              allFunctions[idx].decompiled = code;
              if (cache) await cache.setByAddress(address, code);
              decompiled++;
            }
          } catch {
            const cached = cache ? await cache.getByAddress(address) : null;
            if (cached) allFunctions[idx].decompiled = cached;
          }
        }
      }

      onProgress?.(Math.min(i + BATCH_SIZE, needsDecompile.length), needsDecompile.length);
    }

    decompiledCount = decompiled;
    console.log(`  Decompiled: ${decompiled}/${needsDecompile.length}`);
  }

  /**
   * Put back every held excluded-namespace function the kept bodies reach.
   *
   * A fixpoint, because an admitted body's own callees are reachable too. The
   * loop is here rather than in the pure closure module because closing the set
   * needs the NEXT round's bodies, and getting those means going back to the
   * decompiler.
   *
   * Deliberately over-approximate: everything reachable with a body is
   * decompiled, and whether a body is the right answer for a given name is
   * codegen's decision, made from the emitter's tables. Keeping it that way is
   * what lets a `--codegen-only` run change that decision without re-extracting.
   */
  async function admitExclusionClosure(): Promise<void> {
    const index = indexCandidatesBySpelling(excludedReserve);
    if (index.size === 0) return;

    const namespaces = new Set<string>();
    for (const key of index.keys()) namespaces.add(key.slice(0, key.indexOf('::')));

    const admitted = new Set<string>();
    let bodies = allFunctions
      .map(f => f.decompiled)
      .filter((b): b is string => !!b && mayReferenceNamespaces(b, namespaces));

    while (bodies.length > 0) {
      const frontier = nextClosureFrontier(bodies, index, admitted);
      if (frontier.length === 0) break;
      closureRounds++;
      for (const func of frontier) admitted.add(func.address);
      await decompileList(frontier);
      for (const func of frontier) {
        func.excludedNamespaceReachable = true;
        allFunctions.push(func);
      }
      closureAdmitted += frontier.length;
      bodies = frontier
        .map(f => f.decompiled)
        .filter((b): b is string => !!b && mayReferenceNamespaces(b, namespaces));
    }
  }

  /**
   * Decompile an explicit list of functions.
   *
   * Separate from `decompileAll`, which walks `allFunctions` by index and cannot
   * be pointed at a set that is not in it yet. A batch that fails falls back to
   * one call per function for the same reason the main pass does: one bad
   * function must not cost the whole batch its bodies.
   */
  async function decompileList(funcs: ExtractedFunction[]): Promise<void> {
    for (let i = 0; i < funcs.length; i += DECOMPILE_BATCH_SIZE) {
      const batch = funcs.slice(i, i + DECOMPILE_BATCH_SIZE);
      const pending: ExtractedFunction[] = [];
      for (const func of batch) {
        const cached = cache ? await cache.getByAddress(func.address) : null;
        if (cached) func.decompiled = cached;
        else pending.push(func);
      }
      if (pending.length === 0) continue;

      const addresses = pending.map(f => f.address);
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
        const byAddress = new Map(result.results.map(r => [r.address, r]));
        for (const func of pending) {
          const decomp = byAddress.get(func.address);
          if (!decomp) continue;
          func.decompiled = decomp.pseudocode;
          if (cache) await cache.setByAddress(func.address, decomp.pseudocode);
        }
      } catch (err) {
        console.warn(`  Exclusion-closure batch decompile failed (${err}) — falling back per function`);
        for (const func of pending) {
          try {
            const code = await decompileFunction(connection, func.address, decompileTimeout);
            if (code) {
              func.decompiled = code;
              if (cache) await cache.setByAddress(func.address, code);
            }
          } catch {
            // A body that will not decompile is one this closure cannot emit;
            // codegen drops it for want of a body rather than emitting a stub.
          }
        }
      }
    }
  }
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
 * The Ghidra-side half of thunk-target resolution.
 *
 * `Function.getThunkedFunction(true)` follows a chain of thunks to the function
 * that has the code, which is the only correct answer: `Fog::Src::Safesock::
 * WSACleanup` reaches the ws2_32 import through a second stub, and its name is
 * no evidence of that. Java only — Jython was removed in Ghidra 12.1 — and no
 * `import` statements, so every class is spelled out.
 */
const THUNK_TARGET_SCRIPT = `
ghidra.program.model.listing.FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
StringBuilder sb = new StringBuilder();
while (it.hasNext()) {
  ghidra.program.model.listing.Function f = it.next();
  if (!f.isThunk()) continue;
  ghidra.program.model.listing.Function t = f.getThunkedFunction(true);
  if (t == null) continue;
  ghidra.program.model.symbol.Namespace tns = t.getParentNamespace();
  sb.append(f.getEntryPoint()).append('\\t')
    .append(t.getEntryPoint()).append('\\t')
    .append(tns == null ? "" : tns.getName(true)).append('\\t')
    .append(t.getName()).append('\\t')
    .append(t.isExternal() ? "EXT" : "INT").append('\\n');
}
println(sb.toString());
`;

/** The hex tail of a Ghidra address ("Game.exe.ram:005011f0" -> "005011f0"). */
function addressKey(address: string): string {
  return address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
}

/**
 * Record each thunk's target on the thunk. Returns how many were resolved.
 *
 * A thunk whose target Ghidra cannot resolve keeps no `thunkTarget` and stays
 * body-less: the emitter has nothing to forward to and must not invent one.
 */
export async function attachThunkTargets(
  connection: GhidraConnection,
  functions: ExtractedFunction[]
): Promise<number> {
  let output: string;
  try {
    const result = await connection.sendCommand<{ success?: boolean; output?: string; error?: string }>(
      'execute_script',
      { language: 'java', code: THUNK_TARGET_SCRIPT, scriptTimeout: 120, _commandTimeout: 180000 }
    );
    if (result.success === false || typeof result.output !== 'string') {
      console.warn(`  Thunk targets unavailable: ${result.error ?? 'no output'}`);
      return 0;
    }
    output = result.output;
  } catch (err) {
    console.warn(`  Thunk targets unavailable: ${(err as Error).message}`);
    return 0;
  }

  const targets = new Map<string, ThunkTarget>();
  for (const line of output.split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const [thunkAddr, targetAddr, targetNs, targetName, kind] = cols;
    if (!thunkAddr || !targetName) continue;
    targets.set(addressKey(thunkAddr.trim()), {
      address: targetAddr,
      name: targetName,
      namespace: targetNs || undefined,
      isExternal: kind.trim() === 'EXT',
    });
  }

  let attached = 0;
  for (const func of functions) {
    if (!func.isThunk) continue;
    const target = targets.get(addressKey(func.address));
    if (!target) continue;
    func.thunkTarget = target;
    attached++;
  }
  return attached;
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

/**
 * A Ghidra data-type spelling with the decompiler's resolution folded in.
 *
 * The daemon can hand back `undefined4 /* resolvedType: int * *\/` — the raw
 * database field, plus the type the DECOMPILER resolved for that storage. Passed
 * through untouched it becomes a C++ parameter whose type is half comment; it
 * still compiles, but every type table downstream is keyed on the spelling, so
 * `undefined4 /* … *\/` matches nothing and the whole cast machinery goes blind
 * on exactly the slots the annotation was there to explain.
 *
 * The annotation only ever accompanies an `undefined` placeholder — a field
 * nobody curated — so the decompiler's answer is the better one and is taken.
 * (The same rule `decompiledReturnType` already applies to return types.) Where
 * the base is a real type the comment is dropped and the declaration stands.
 */
export function resolveAnnotatedType(dataType: string | undefined): string | undefined {
  if (!dataType || !dataType.includes('/*')) return dataType;
  const m = dataType.match(/^\s*(.*?)\s*\/\*\s*resolvedType:\s*(.*?)\s*\*\/\s*$/);
  if (!m) return dataType.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
  const [, base, resolved] = m;
  return /^undefined\d*(\[\d+\])?$/.test(base) && resolved !== '' ? resolved : base;
}

/**
 * Fold `resolvedType` annotations into every parameter and local of every
 * function, once, on the model both the live extraction and the snapshot replay
 * hand to codegen — so declaration and type table read the same spelling.
 */
export function applyResolvedTypes(functions: ExtractedFunction[]): number {
  let changed = 0;
  for (const fn of functions) {
    for (const p of fn.parameters ?? []) {
      const t = resolveAnnotatedType(p.dataType);
      if (t !== undefined && t !== p.dataType) { p.dataType = t; changed++; }
    }
    for (const v of fn.localVariables ?? []) {
      const t = resolveAnnotatedType(v.dataType);
      if (t !== undefined && t !== v.dataType) { v.dataType = t; changed++; }
    }
    const rt = resolveAnnotatedType(fn.returnType);
    if (rt !== undefined && rt !== fn.returnType) { fn.returnType = rt; changed++; }
  }
  return changed;
}

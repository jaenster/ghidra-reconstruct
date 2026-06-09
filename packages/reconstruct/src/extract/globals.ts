/**
 * Global variable / data symbol extraction from Ghidra
 *
 * This module extracts data symbols (DAT_*, data_*, etc.) from Ghidra,
 * including which functions reference them. This information is used to
 * determine if a symbol should be a true global or a static local.
 */

import type { GhidraConnection, ExtractedGlobal, AnalyzedDataSymbol, DataSymbolScope, DataValue } from '../types.js';

/**
 * Strip namespace prefix from a qualified function name.
 * e.g. "D2Client::QUEST_Foo" → "QUEST_Foo"
 */
function stripNamespacePrefix(name: string): string {
  const idx = name.lastIndexOf('::');
  return idx >= 0 ? name.slice(idx + 2) : name;
}

/**
 * Options for global extraction
 */
export interface GlobalExtractionOptions {
  /** Filter by name pattern (supports wildcards) */
  filter?: string;

  /** Filter by namespace */
  namespace?: string;

  /** Maximum number to extract */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Response from Ghidra get_global_variables command
 */
interface GhidraGlobalVariableInfo {
  name: string;
  address: string;
  dataType: string;
  size: number;
  namespace?: string;
  isInitialized: boolean;
  xrefCount: number;
  referencingFunctions?: string[];
  value?: string;
}

/**
 * Extract global variables / data symbols from Ghidra
 *
 * This uses the enhanced get_global_variables command which returns:
 * - LABEL type symbols that have data at their address
 * - List of functions that reference each symbol
 * - Data type, size, and value information
 */
export async function extractGlobals(
  connection: GhidraConnection,
  options: GlobalExtractionOptions = {}
): Promise<{
  globals: ExtractedGlobal[];
  total: number;
}> {
  const { filter, namespace, limit = 100, offset = 0 } = options;

  const params: Record<string, unknown> = {
    offset,
    limit,
    _commandTimeout: 300000, // 5 minutes — global extraction can be slow on large binaries
  };

  if (filter) params.filter = filter;

  const result = await connection.sendCommand<{
    globals: GhidraGlobalVariableInfo[];
    total: number;
  }>('list_data_symbols', params);

  // Convert to ExtractedGlobal format, filtering by namespace if needed
  const globals: ExtractedGlobal[] = [];

  for (const g of result.globals) {
    // Skip if namespace filter doesn't match
    if (namespace && g.namespace !== namespace) continue;

    globals.push({
      name: g.name,
      address: g.address,
      dataType: g.dataType,
      size: g.size,
      value: g.value,
      namespace: g.namespace,
      isInitialized: g.isInitialized,
      xrefCount: g.xrefCount,
      referencingFunctions: g.referencingFunctions || [],
    });
  }

  return {
    globals,
    total: result.total,
  };
}

/**
 * Extract all global variables (handles pagination)
 */
export async function extractAllGlobals(
  connection: GhidraConnection,
  options: Omit<GlobalExtractionOptions, 'limit' | 'offset'> = {},
  onProgress?: (fetched: number, total: number) => void
): Promise<ExtractedGlobal[]> {
  const allGlobals: ExtractedGlobal[] = [];
  const pageSize = 500; // Larger page size for efficiency
  let offset = 0;
  let total = 0;

  do {
    const result = await extractGlobals(connection, {
      ...options,
      limit: pageSize,
      offset,
    });

    allGlobals.push(...result.globals);
    total = result.total;
    offset += pageSize;

    if (onProgress) {
      onProgress(Math.min(offset, total), total);
    }
  } while (offset < total);

  return allGlobals;
}

/**
 * Check if a Ghidra data type represents a string literal.
 * These are dead declarations — the decompiler inlines string content directly.
 */
function isStringType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return lower === 'string' || lower === 'terminatedcstring' || lower === 'string-utf8'
    || lower.startsWith('string-');
}

/**
 * Map Ghidra data types to C/C++ types
 */
const TYPE_MAP: Record<string, string> = {
  'undefined': 'auto',
  'undefined1': 'uint8_t',
  'undefined2': 'uint16_t',
  'undefined4': 'uint32_t',
  'undefined8': 'uint64_t',
  'undefined3': 'uint8_t[3]',
  'byte': 'uint8_t',
  'word': 'uint16_t',
  'dword': 'uint32_t',
  'qword': 'uint64_t',
  'pointer': 'void*',
  'pointer32': 'void*',
  'pointer64': 'void*',
  'float': 'float',
  'double': 'double',
  'char': 'char',
  'uchar': 'unsigned char',
  'short': 'short',
  'ushort': 'unsigned short',
  'int': 'int',
  'uint': 'unsigned int',
  'long': 'long',
  'ulong': 'unsigned long',
  'longlong': 'long long',
  'ulonglong': 'unsigned long long',
  'string': 'const char*',
  'terminatedcstring': 'const char*',
  'string-utf8': 'const char*',
};

/**
 * Infer a better C type from Ghidra's type
 */
function inferType(dataType: string): string {
  const lower = dataType.toLowerCase();
  return TYPE_MAP[lower] || dataType;
}

/**
 * Determine scope based on usage patterns
 */
function determineScope(global: ExtractedGlobal): DataSymbolScope {
  const refs = global.referencingFunctions || [];

  // If only one function references it, it's a static local
  if (refs.length === 1) {
    return 'static-local';
  }

  // All other data is global (do NOT infer 'constant' — that requires
  // checking if the data is in a read-only segment, which we don't have here.
  // An initialized value does NOT mean the variable is immutable!)
  return 'global';
}

/**
 * Infer a better name based on usage
 */
function inferName(global: ExtractedGlobal): string | undefined {
  const name = global.name;

  // Keep original Ghidra names — don't rename DAT_/data_ prefixes
  return undefined;
}

/**
 * Analyze data symbols to determine scope and suggest improvements
 *
 * This is the main entry point for data symbol analysis. It:
 * 1. Extracts all data symbols from Ghidra
 * 2. Determines scope (global, static-local, constant)
 * 3. Suggests better names and types
 */
export async function analyzeDataSymbols(
  connection: GhidraConnection,
  options: Omit<GlobalExtractionOptions, 'limit' | 'offset'> = {},
  onProgress?: (fetched: number, total: number) => void
): Promise<AnalyzedDataSymbol[]> {
  const globals = await extractAllGlobals(connection, options, onProgress);

  return globals
    .filter(g => !isStringType(g.dataType))
    .map(global => ({
      ...global,
      scope: determineScope(global),
      suggestedName: inferName(global),
      suggestedType: inferType(global.dataType),
      ownerFunction: (global.referencingFunctions?.length === 1)
        ? stripNamespacePrefix(global.referencingFunctions[0])
        : undefined,
    }));
}

/**
 * Filter data symbols by scope
 */
export function filterByScope(
  symbols: AnalyzedDataSymbol[],
  scope: DataSymbolScope
): AnalyzedDataSymbol[] {
  return symbols.filter(s => s.scope === scope);
}

/**
 * Get data symbols used by a specific function
 */
export function getSymbolsForFunction(
  symbols: AnalyzedDataSymbol[],
  functionName: string
): AnalyzedDataSymbol[] {
  return symbols.filter(s =>
    s.referencingFunctions?.includes(functionName)
  );
}

/**
 * Get static-local symbols grouped by owner function
 */
export function getStaticLocalsByFunction(
  symbols: AnalyzedDataSymbol[]
): Map<string, AnalyzedDataSymbol[]> {
  const byFunction = new Map<string, AnalyzedDataSymbol[]>();

  for (const symbol of symbols) {
    if (symbol.scope === 'static-local' && symbol.ownerFunction) {
      const existing = byFunction.get(symbol.ownerFunction) || [];
      existing.push(symbol);
      byFunction.set(symbol.ownerFunction, existing);
    }
  }

  return byFunction;
}

/**
 * Fetch initialized data values for globals that have non-trivial data
 * (arrays, structs, tables). Calls read_data_value for each candidate.
 */
export async function fetchInitializedData(
  connection: GhidraConnection,
  globals: AnalyzedDataSymbol[],
  onProgress?: (fetched: number, total: number) => void
): Promise<void> {
  // Only fetch for initialized globals with reasonable size (skip tiny scalars, cap at 64KB)
  const candidates = globals.filter(g =>
    g.isInitialized && g.size > 4 && g.size <= 64 * 1024
  );

  if (candidates.length === 0) return;

  const BATCH_SIZE = 20;
  let fetched = 0;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(g =>
        connection.sendCommand<{ value?: DataValue; error?: string }>(
          'read_data_value',
          { address: g.address }
        ).catch(() => null)
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result?.value) {
        batch[j].initializedData = result.value;
      }
    }

    fetched += batch.length;
    onProgress?.(fetched, candidates.length);
  }
}

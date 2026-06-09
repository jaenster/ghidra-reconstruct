/**
 * Extraction orchestration
 *
 * Coordinates extraction of all data from Ghidra
 */

export {
  extractFunctions,
  extractAllFunctions,
  DEFAULT_LIBRARY_EXCLUSION_PATTERNS,
  shouldExcludeFunction,
  type FunctionExtractionOptions,
} from './functions.js';
export { extractDataTypes, extractDataType } from './types.js';
export {
  extractGlobals,
  extractAllGlobals,
  analyzeDataSymbols,
  filterByScope,
  getSymbolsForFunction,
  getStaticLocalsByFunction,
  fetchInitializedData,
  type GlobalExtractionOptions,
} from './globals.js';
export { extractStrings, extractAllStrings } from './strings.js';
export { extractNamespaces, extractAllNamespaces } from './namespaces.js';
export { extractIncremental, type IncrementalResult } from './incremental.js';

import type {
  GhidraConnection,
  ExtractedFunction,
  ExtractedDataType,
  ExtractedGlobal,
  ExtractedString,
  ExtractedNamespace,
  ProgressCallback,
} from '../types.js';
import { FunctionCache, type CacheOptions } from '../cache.js';

import { extractAllFunctions } from './functions.js';
import { extractDataTypes, extractDataType } from './types.js';
import { extractAllGlobals, analyzeDataSymbols, fetchInitializedData } from './globals.js';
import { extractAllStrings } from './strings.js';
import { extractAllNamespaces } from './namespaces.js';
import type { AnalyzedDataSymbol } from '../types.js';

/**
 * Complete extraction result from Ghidra
 */
export interface ExtractionResult {
  functions: ExtractedFunction[];
  dataTypes: ExtractedDataType[];
  /** Analyzed globals with scope info (global/static-local/constant) */
  globals: AnalyzedDataSymbol[];
  /** Raw globals (for backwards compatibility) */
  rawGlobals?: ExtractedGlobal[];
  strings: ExtractedString[];
  namespaces: ExtractedNamespace[];
  programInfo: ProgramInfo;
}

export interface ProgramInfo {
  name: string;
  path: string;
  format: string;
  architecture: string;
  compiler: string | null;
  imageBase: string;
  languageId: string;
  endianness: 'big' | 'little';
  pointerSize: number;
}

/**
 * Options for extraction
 */
export interface ExtractionOptions {
  /** Include decompiled code for each function */
  decompile?: boolean;

  /** Decompilation timeout in seconds */
  decompileTimeout?: number;

  /** Minimum string length to extract */
  minStringLength?: number;

  /** Filter namespaces by pattern */
  namespaceFilter?: string;

  /** Progress callback */
  onProgress?: ProgressCallback;

  /** Cache options for decompiled function results */
  cache?: FunctionCache | CacheOptions | boolean;

  /** Exclude common C runtime and Visual Studio library functions */
  excludeLibraryCode?: boolean;

  /** Additional patterns to exclude from functions */
  excludePatterns?: (string | RegExp)[];
}

/**
 * Extract all data from a Ghidra session
 */
export async function extractAll(
  connection: GhidraConnection,
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const {
    decompile = true,
    decompileTimeout = 30,
    minStringLength = 4,
    namespaceFilter,
    onProgress,
    cache,
    excludeLibraryCode = false,
    excludePatterns,
  } = options;

  // Get program info first
  const programInfo = await connection.sendCommand<ProgramInfo>('get_program_info');

  // Extract in parallel where possible
  const [namespaces, dataTypesList, analyzedGlobals, strings] = await Promise.all([
    extractAllNamespaces(connection, { filter: namespaceFilter }),
    extractDataTypes(connection, { limit: 10000 }),
    analyzeDataSymbols(connection), // Returns AnalyzedDataSymbol[] with scope info
    extractAllStrings(connection, { minLength: minStringLength }),
  ]);

  // Fetch detailed info (fields, values) for STRUCTURE/ENUM/UNION types
  const detailKinds = new Set(['STRUCTURE', 'ENUM', 'UNION', 'TYPEDEF', 'FUNCTION_DEFINITION']);
  const typesNeedingDetail = dataTypesList.filter(t => detailKinds.has(t.kind));
  const dataTypes = [...dataTypesList];

  // Batch fetch details in groups of 20 for performance
  const BATCH_SIZE = 20;
  for (let i = 0; i < typesNeedingDetail.length; i += BATCH_SIZE) {
    const batch = typesNeedingDetail.slice(i, i + BATCH_SIZE);
    const details = await Promise.all(
      batch.map(t => extractDataType(connection, t.name, t.category))
    );
    for (let j = 0; j < details.length; j++) {
      if (details[j]) {
        // Replace the listing entry with the detailed version
        const idx = dataTypes.findIndex(t => t.name === batch[j].name && t.category === batch[j].category);
        if (idx !== -1) {
          dataTypes[idx] = details[j]!;
        }
      }
    }
  }

  // Fetch initialized data values for non-trivial globals (arrays, structs, tables)
  await fetchInitializedData(connection, analyzedGlobals, (fetched, total) => {
    onProgress?.('initialized-data', fetched, total);
  });

  onProgress?.('extraction', 1, 5);

  // Extract functions (this is the slowest part)
  const functions = await extractAllFunctions(connection, {
    decompile,
    decompileTimeout,
    cache,
    excludeLibraryCode,
    excludePatterns,
    namespace: namespaceFilter,
    onProgress: (current, total) => {
      onProgress?.('functions', current, total);
    },
  });

  onProgress?.('extraction', 5, 5);

  return {
    functions,
    dataTypes,
    globals: analyzedGlobals,
    strings,
    namespaces,
    programInfo,
  };
}

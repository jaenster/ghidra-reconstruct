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
import { timePhase } from '../timing.js';

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

  /** Prefix for the recorded phase names, e.g. "mac" -> "mac/extract/decompile". */
  phaseLabel?: string;

  /**
   * Narrow WHICH functions get a body. Everything is still listed; only the
   * decompilation is restricted. Used for the cross-check binary, where most
   * bodies are discarded by the merge and only the address survives.
   */
  decompileFilter?: (func: ExtractedFunction) => boolean;
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

  const label = options.phaseLabel ? `${options.phaseLabel}/` : '';

  // Get program info first
  const programInfo = await connection.sendCommand<ProgramInfo>('get_program_info');

  // Extract in parallel where possible
  const [namespaces, dataTypesList, analyzedGlobals, strings] = await timePhase(
    `${label}extract/metadata`,
    () => Promise.all([
      extractAllNamespaces(connection, { filter: namespaceFilter }),
      extractDataTypes(connection, { limit: 10000 }),
      analyzeDataSymbols(connection), // Returns AnalyzedDataSymbol[] with scope info
      extractAllStrings(connection, { minLength: minStringLength }),
    ]),
    ([ns, dts, gl, st]) =>
      `${ns.length} namespaces, ${dts.length} types, ${gl.length} globals, ${st.length} strings`
  );

  // Fetch detailed info (fields, values) for STRUCTURE/ENUM/UNION types
  const detailKinds = new Set(['STRUCTURE', 'ENUM', 'UNION', 'TYPEDEF', 'FUNCTION_DEFINITION']);
  const typesNeedingDetail = dataTypesList.filter(t => detailKinds.has(t.kind));
  const dataTypes = [...dataTypesList];

  // Batch fetch details in groups of 20 for performance
  const BATCH_SIZE = 20;
  // Index by name+category ONCE — the previous findIndex per detail was a linear
  // scan of every type for every detailed type (O(n^2) over ~5k types).
  const dataTypeIndex = new Map<string, number>();
  for (let i = 0; i < dataTypes.length; i++) {
    dataTypeIndex.set(`${dataTypes[i].name}\u0000${dataTypes[i].category}`, i);
  }
  await timePhase(
    `${label}extract/type-details`,
    async () => {
      for (let i = 0; i < typesNeedingDetail.length; i += BATCH_SIZE) {
        const batch = typesNeedingDetail.slice(i, i + BATCH_SIZE);
        const details = await Promise.all(
          batch.map(t => extractDataType(connection, t.name, t.category))
        );
        for (let j = 0; j < details.length; j++) {
          if (details[j]) {
            // Replace the listing entry with the detailed version
            const idx = dataTypeIndex.get(`${batch[j].name}\u0000${batch[j].category}`);
            if (idx !== undefined) {
              dataTypes[idx] = details[j]!;
            }
          }
        }
      }
    },
    () => `${typesNeedingDetail.length} types in ${Math.ceil(typesNeedingDetail.length / BATCH_SIZE)} batches`
  );

  // Fetch initialized data values for non-trivial globals (arrays, structs, tables)
  let initializedDataCount = 0;
  await timePhase(
    `${label}extract/initialized-data`,
    () => fetchInitializedData(connection, analyzedGlobals, (fetched, total) => {
      initializedDataCount = total;
      onProgress?.('initialized-data', fetched, total);
    }),
    () => `${initializedDataCount} items`
  );

  onProgress?.('extraction', 1, 5);

  // Extract functions (this is the slowest part)
  const functions = await extractAllFunctions(connection, {
    decompile,
    decompileTimeout,
    cache,
    excludeLibraryCode,
    excludePatterns,
    namespace: namespaceFilter,
    phaseLabel: options.phaseLabel,
    decompileFilter: options.decompileFilter,
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

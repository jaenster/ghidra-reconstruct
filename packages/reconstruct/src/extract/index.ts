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
export {
  extractDataTypes,
  extractDataType,
  hydrateDataTypeDetails,
  DETAIL_KINDS,
  type TypeDetailHydration,
} from './types.js';
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

import { attachShiftedPointers } from './shifted-pointers.js';
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
import { extractDataTypes, hydrateDataTypeDetails } from './types.js';
import { extractAllGlobals, analyzeDataSymbols, fetchInitializedData } from './globals.js';
import { extractLabelFlow } from './label-flow.js';
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
  /**
   * The image's data blocks as [start, end) - readable, not executable, not the headers.
   * Where an integer in arithmetic can be an address at all; absent when the extraction
   * predates it or the server could not list memory blocks.
   */
  dataSections?: Array<[number, number]>;
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
  const dataSections = await extractDataSections(connection, programInfo.imageBase);
  if (dataSections) programInfo.dataSections = dataSections;

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

  // Fetch detailed info (fields, values) for STRUCTURE/ENUM/UNION types.
  // A detail that never lands leaves the shallow entry, whose empty member list
  // means "not known", not "none" — hydrateDataTypeDetails retries it and then
  // stops the run by name rather than let it through.
  const dataTypes = [...dataTypesList];
  await timePhase(
    `${label}extract/type-details`,
    () => hydrateDataTypeDetails(connection, dataTypes),
    r => `${r.fetched} details${r.recovered > 0 ? `, ${r.recovered} recovered on retry` : ''}`
  );

  // Pointer-typedefs with a component offset (shifted pointers): the container-of
  // accesses the decompiler prints as ADJ(p)->field. Read-only; a failure leaves none.
  {
    let attached = 0;
    await timePhase(
      `${label}extract/shifted-pointers`,
      async () => { attached = await attachShiftedPointers(connection, dataTypes); },
      () => `${attached} shifted pointer typedef(s)`
    );
  }

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

  // How control enters each label (read-only; see label-flow.ts). A failure leaves the field
  // unset, which is what an older snapshot looks like too.
  if (decompile) {
    try {
      await extractLabelFlow(connection, functions);
    } catch (err) {
      console.warn(`  Label flow unavailable: ${(err as Error).message}`);
    }
  }

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

interface MemoryBlockRecord {
  name?: string;
  start?: string;
  end?: string;
  permissions?: string;
  isVolatile?: boolean;
}

/**
 * The image's data blocks, [start, end): every memory block that is not executable, not
 * volatile and not the PE headers (the block the image base sits in), below the top of the
 * user address space. `.rdata`, `.data` and the uninitialised tail of `.data` qualify;
 * `.text` does not.
 *
 * Null when the server cannot list blocks: the passes that read this then do nothing.
 */
export async function extractDataSections(
  connection: GhidraConnection,
  imageBase: string | undefined,
): Promise<Array<[number, number]> | null> {
  let blocks: MemoryBlockRecord[];
  try {
    const listed = await connection.sendCommand<{ segments?: MemoryBlockRecord[] }>('list_segments', { limit: 1000 });
    blocks = listed?.segments ?? [];
  } catch {
    return null;
  }
  const hex = (text: string | undefined) =>
    text && /^\s*(0x)?[0-9a-f]+\s*$/i.test(text) ? Number.parseInt(text.trim().replace(/^0x/i, ''), 16) : NaN;
  const base = hex(imageBase);
  const out: Array<[number, number]> = [];
  for (const b of blocks) {
    const start = hex(b.start);
    const end = hex(b.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) continue;
    if (start >= 0x80000000) continue;
    if ((b.permissions ?? '').includes('x') || b.isVolatile) continue;
    if (Number.isSafeInteger(base) && start <= base && base <= end) continue;
    out.push([start, end + 1]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length > 0 ? out : null;
}

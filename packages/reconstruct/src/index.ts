/**
 * @ghidra-mcp/reconstruct
 *
 * Source code reconstruction from Ghidra projects
 */

// Re-export types
export * from './types.js';

// Re-export per-phase timing
export {
  resetTimings,
  getTimings,
  formatTimings,
  recordPhase,
  timePhase,
  type PhaseRecord,
} from './timing.js';

// Re-export config
export {
  loadProjectConfig,
  loadProjectConfigFromFile,
  normalizeAddress,
  type ProjectConfig,
  type OverrideEntry,
  type LibraryEntry,
  type TargetConfig,
  type MethodConversionEntry,
  type TypeOwnershipEntry,
  type AutoMethodConversionConfig,
  type AdditionalSource,
} from './config/index.js';

// Re-export extraction modules
export {
  extractAll,
  extractFunctions,
  extractAllFunctions,
  extractDataTypes,
  extractDataType,
  extractGlobals,
  extractAllGlobals,
  extractStrings,
  extractAllStrings,
  extractNamespaces,
  extractAllNamespaces,
  DEFAULT_LIBRARY_EXCLUSION_PATTERNS,
  shouldExcludeFunction,
  type ExtractionResult,
  type ExtractionOptions,
  type FunctionExtractionOptions,
} from './extract/index.js';

// Re-export analysis modules
export {
  analyzeAll,
  analyzeScoping,
  detectClasses,
  buildCallGraph,
  analyzeStaticPromotion,
  type AnalysisResult,
  type AnalysisOptions,
} from './analysis/index.js';

// Re-export code generation modules
export {
  generateProject,
  writeProject,
  generateHeader,
  generateImplementation,
  generateCMakeLists,
  generateTopLevelCMake,
  generateTargetCMake,
  generateSourceMap,
  organizeByNamespace,
  getFilePath,
  setParseErrorLogPath,
  getParseErrorCount,
  detectAutoMethods,
  stripCommonPrefix,
} from './codegen/index.js';

// Re-export override modules
export {
  OverrideRegistry,
  createOverrideRegistry,
  applyPatches,
} from './overrides/index.js';

// Re-export library modules
export {
  LibraryRegistry,
  createLibraryRegistry,
} from './library/index.js';

// Re-export method conversion modules
export {
  MethodConversionRegistry,
  createMethodConversionRegistry,
  applyMethodConversions,
  type ResolvedConversion,
  type MethodCallMapping,
} from './methods/index.js';
export {
  detectLibraryFunctions,
  detectionResultsToLibraryEntries,
  type DetectionResult,
} from './library/detector.js';

// Re-export target modules
export {
  resolveTargets,
  getTargetDirectory,
  type ResolvedTarget,
  type TargetResolution,
} from './targets/index.js';
export {
  generateStubsHeader,
} from './targets/stubs.js';

// Re-export connection utilities
export {
  createConnection,
  closeConnection,
  isDaemonAvailable,
  listSessions,
  exportAllC,
  getCacheVersion,
  isExportCacheValid,
  clearExportCache,
  type ExportAllCOptions,
} from './connection.js';

// Re-export cache utilities
export {
  FunctionCache,
  getDefaultCache,
  resetDefaultCache,
  computePipelineVersion,
  ExportAllCCache,
  getExportAllCCache,
  resetExportAllCCache,
  type CacheEntry,
  type CacheStats,
  type CacheOptions,
  type ExportAllCResult,
  type ExportedFunction,
  type ExportAllCCacheEntry,
} from './cache.js';

import type {
  ReconstructOptions,
  ReconstructResult,
  ReconstructedProject,
  ProgressCallback,
  GhidraConnection,
  DetectedClass,
  ScopingAnalysis,
  ExtractedFunction,
  ExtractedEnum,
  ExtractedDataType,
  AnalyzedDataSymbol,
  ExtractedNamespace,
  ExtractedString,
  ProgramInfo,
} from './types.js';
import { defaultOptions } from './types.js';
import { disambiguateVtableTypes } from './modules/vtable-types.js';
import { disambiguateCategoryDuplicates } from './modules/category-duplicate-types.js';
import { lintAutoProtoConventions, describeAutoProtoLint } from './modules/auto-proto-lint.js';

import { extractAll, type ExtractionResult } from './extract/index.js';
import { applyResolvedTypes } from './extract/functions.js';
import { analyzeAll, type AnalysisResult } from './analysis/index.js';
import { generateProject, writeProject, getParseErrorLogPath as parseErrorLogPath } from './codegen/index.js';
import { generateProjectParallel } from './codegen-parallel.js';
import { createConnection, closeConnection, getCacheVersion, summarizeRpcStats, resetRpcStats } from './connection.js';
import { timePhase, timePhaseSync, formatTimings, resetTimings, recordPhase, formatBytes } from './timing.js';
import {
  DEFAULT_SNAPSHOT_DIRNAME,
  SNAPSHOT_FORMAT_VERSION,
  assessStaleness,
  describeSnapshot,
  readSnapshot,
  writeSnapshot,
  type CodegenSnapshot,
  type SnapshotProvenance,
} from './snapshot.js';
import {
  DEFAULT_SOURCE_CACHE_DIRNAME,
  SOURCE_CACHE_FORMAT_VERSION,
  countBodies,
  describeSourceCacheHit,
  describeSourceCacheMiss,
  readSourceCache,
  readSourceCacheManifest,
  sourceCacheDir,
  verifySourceCache,
  writeSourceCache,
  type CachedSourceExtraction,
} from './source-cache.js';
import { FunctionCache, type CacheOptions } from './cache.js';
export {
  SNAPSHOT_FORMAT_VERSION,
  DEFAULT_SNAPSHOT_DIRNAME,
  writeSnapshot,
  readSnapshot,
  readSnapshotManifest,
  snapshotExists,
  describeSnapshot,
  assessStaleness,
  type CodegenSnapshot,
  type SnapshotManifest,
  type SnapshotProvenance,
  type SnapshotCounts,
  type StalenessVerdict,
} from './snapshot.js';
export {
  SOURCE_CACHE_FORMAT_VERSION,
  DEFAULT_SOURCE_CACHE_DIRNAME,
  sourceCacheDir,
  readSourceCache,
  readSourceCacheManifest,
  writeSourceCache,
  verifySourceCache,
  describeSourceCacheHit,
  describeSourceCacheMiss,
  type CachedSourceExtraction,
  type SourceCacheManifest,
  type SourceCacheProvenance,
  type SourceCacheCounts,
} from './source-cache.js';

import { join } from 'path';
import { loadProjectConfig as loadConfig } from './config/loader.js';
import type { AdditionalSource } from './config/schema.js';

/**
 * Options for reconstruction
 */
export interface ReconstructionOptions {
  /** URL of the ghidra-mcp daemon */
  daemonUrl?: string;

  /** Progress callback */
  onProgress?: ProgressCallback;

  /** Skip decompilation (faster but no function bodies) */
  skipDecompile?: boolean;

  /** Timeout for decompilation in seconds */
  decompileTimeout?: number;

  /** Cache options for decompiled function results */
  cache?: FunctionCache | CacheOptions | boolean;

  /** Exclude common C runtime and Visual Studio library functions */
  excludeLibraryCode?: boolean;

  /** Additional patterns to exclude from functions */
  excludePatterns?: (string | RegExp)[];

  /** For .gpr projects with multiple programs, specify which to open */
  programPath?: string;

  /**
   * Directory holding the extraction snapshot — everything `generateProject`
   * consumes, persisted at the seam right after analysis. Defaults to
   * `<projectDir>/.ghidra-mcp/codegen-snapshot`.
   */
  snapshotDir?: string;

  /** Persist a snapshot at the end of a full run. Default true. */
  writeSnapshotFile?: boolean;

  /**
   * Skip daemon, extraction and analysis entirely: load the snapshot and go
   * straight to codegen. Turns a ~20 minute round trip into seconds, at the
   * cost of reflecting Ghidra as of when the snapshot was taken.
   */
  codegenOnly?: boolean;

  /** Hours before a snapshot is refused outright in codegen-only mode. */
  snapshotMaxAgeHours?: number;

  /**
   * Root for the per-additional-source extraction caches. Defaults to
   * `<projectDir>/.ghidra-mcp/source-cache`.
   */
  sourceCacheDir?: string;

  /**
   * Use the additional-source extraction cache. Default true. False forces
   * every secondary binary to be re-extracted from Ghidra, and writes nothing.
   */
  useSourceCache?: boolean;

  /**
   * Generate across this many shards (worker threads), coordinator included.
   * 1 or absent keeps the single-threaded path, which stays the default because
   * it is the one a correctness-critical run should take.
   *
   * Every shard rebuilds the whole model from the extraction snapshot and emits
   * only its slice of the files, so this needs a snapshot on disk: with
   * `writeSnapshotFile: false` there is nothing to replay and the run falls back
   * to serial.
   */
  generationWorkers?: number;

  /**
   * Module each generation worker imports and calls `configureCodegen(logPath?)`
   * on. Process-wide emitter configuration applied by the ENTRY POINT — which
   * transform plugins are enabled, where parse errors are logged — is not part
   * of `ReconstructOptions`, and a worker that skipped it would emit different
   * bodies from the coordinator.
   */
  generationWorkerBootstrap?: string;

  /**
   * Decompile every function of an additional source, including the ~8k whose
   * bodies the merge throws away. Default false. Together with
   * `useSourceCache: false` this restores the secondary phase to exactly what
   * it did before either shortcut existed, which is what makes a difference
   * bisectable.
   */
  decompileAllSecondary?: boolean;
}

/** Everything codegen needs, whether it came from Ghidra or from a snapshot. */
interface CodegenInputs {
  projectName: string;
  functions: ExtractedFunction[];
  classes: DetectedClass[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  namespaces: ExtractedNamespace[];
  programInfo: ProgramInfo;
  /**
   * String literals with their addresses. Feeds `stats.stringsExtracted`, and
   * feeds the declaration closure the byte content behind Ghidra's string
   * labels — without it those labels are declared and never defined.
   */
  strings: ExtractedString[];
}

/**
 * The tail of the pipeline: generate the project in memory and write it out.
 *
 * A full run and a codegen-only run both land here with the same `CodegenInputs`,
 * which is what makes the two produce an identical tree.
 */
interface ParallelGenerationSettings {
  workers: number;
  snapshotDir: string;
  bootstrap?: string;
  parseErrorLogPath?: string;
}

async function generateAndWrite(
  inputs: CodegenInputs,
  options: ReconstructOptions,
  excludePatterns: (string | RegExp)[] | undefined,
  onProgress: ProgressCallback | undefined,
  warnings: string[],
  errors: string[],
  startTime: number,
  parallel?: ParallelGenerationSettings
): Promise<ReconstructResult> {
  // Promote the connection-level excludePatterns to codegen-level
  // excludeNamespaces so the SAME pattern list that drops library functions
  // during extraction ALSO drops every per-namespace file (compiler/*,
  // VisualStudio/*) and its CMake entry. Extraction-time excludePatterns only
  // filter primary-binary functions; mac-merged functions (secondary source)
  // and whole runtime namespaces with no pattern slip through and produce
  // files. Filtering by namespace at codegen closes both gaps in one place.
  onProgress?.('generation', 0, 1);
  if (excludePatterns && excludePatterns.length > 0 && !options.excludeNamespaces) {
    options.excludeNamespaces = excludePatterns;
  }
  // Both entry paths (live extraction and snapshot replay) meet here, so this is
  // the one place a `resolvedType` annotation can be folded in before anything
  // keys a type table on the spelling.
  const resolvedTypeCount = applyResolvedTypes(inputs.functions);
  if (resolvedTypeCount > 0) {
    console.log(`  Resolved types folded in: ${resolvedTypeCount}`);
  }
  const generationDetail = (p: ReconstructedProject) =>
    `${p.files.size} files, ${formatBytes([...p.files.values()].reduce((a, f) => a + f.content.length, 0))} of source` +
    (parallel && parallel.workers > 1 ? `, ${parallel.workers} shards` : '');
  const project = parallel && parallel.workers > 1
    ? await timePhase(
        'generation',
        () => generateProjectParallel(
          {
            projectName: inputs.projectName,
            functions: inputs.functions,
            classes: inputs.classes,
            dataTypes: inputs.dataTypes,
            globals: inputs.globals,
            namespaces: inputs.namespaces,
            options,
            programInfo: inputs.programInfo,
            strings: inputs.strings,
          },
          {
            workers: parallel.workers,
            snapshotDir: parallel.snapshotDir,
            bootstrap: parallel.bootstrap,
            parseErrorLogPath: parallel.parseErrorLogPath,
          }
        ),
        generationDetail
      )
    : timePhaseSync(
        'generation',
        () => generateProject(
          inputs.projectName,
          inputs.functions,
          inputs.classes,
          inputs.dataTypes,
          inputs.globals,
          inputs.namespaces,
          options,
          inputs.programInfo,
          inputs.strings
        ),
        generationDetail
      );
  onProgress?.('generation', 1, 1);

  onProgress?.('writing', 0, 1);
  const filesWritten = await timePhase(
    'writing',
    () => writeProject(project, options.outputDir, options),
    w => `${w.length} files written`
  );
  onProgress?.('writing', 1, 1);

  const totalMs = Date.now() - startTime;
  const summary = formatTimings(totalMs, summarizeRpcStats());
  if (summary) console.log('\n' + summary);

  return {
    success: true,
    project,
    outputDir: options.outputDir,
    filesWritten,
    warnings,
    errors,
    stats: {
      functionsProcessed: inputs.functions.length,
      classesDetected: inputs.classes.length,
      filesGenerated: filesWritten.length,
      dataTypesExtracted: inputs.dataTypes.length,
      globalsExtracted: inputs.globals.length,
      stringsExtracted: inputs.strings.length,
      timeMs: Date.now() - startTime,
    },
    buildInfo: project.buildInfo,
  };
}

/**
 * The Ghidra Server domain-file version of one program, read WITHOUT opening
 * it: `list_programs` on the containing folder is a directory listing, not a
 * load. That matters for the cross-check binary, whose whole point is to be
 * consulted cheaply.
 *
 * Failure is reported, never guessed at. Callers that use the number as a cache
 * key must treat a null as "cannot verify" and re-extract.
 */
async function fetchProgramVersion(
  connection: GhidraConnection,
  projectPath: string,
  programPath: string | undefined
): Promise<{ version: number | null; error?: string }> {
  if (!programPath) return { version: null, error: 'no programPath given' };
  try {
    // "ghidra://host:port/Diablo2Lod" → repo "Diablo2Lod";
    // "/windows/lod/1.14d/Game.exe"  → folder "/windows/lod/1.14d".
    const repo = projectPath.replace(/\/+$/, '').split('/').pop() || undefined;
    const folder = programPath.slice(0, programPath.lastIndexOf('/')) || '/';
    const listing = await connection.sendCommand<{
      programs?: { name: string; path: string; contentType: string; version: number }[];
    }>('list_programs', { repo, folder, recursive: false });
    const entry = (listing.programs ?? []).find(
      p => p.path === programPath || p.path.endsWith(programPath)
    );
    if (!entry) {
      return {
        version: null,
        error: `no entry for ${programPath} in ${repo ?? '(default repo)'}${folder}`,
      };
    }
    return { version: entry.version };
  } catch (e) {
    return { version: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask the daemon which Ghidra state this extraction came from.
 *
 * Two independent signals, because they go stale for different reasons: the
 * server's domain-file version moves on check-in, the worker's modification
 * number moves the instant anyone edits the open program. Neither is worth
 * failing a 20-minute run over, so both are best-effort and record their error.
 */
async function captureProvenance(
  connection: GhidraConnection,
  projectPath: string,
  programPath: string | undefined,
  programInfo: ProgramInfo
): Promise<SnapshotProvenance> {
  let programVersion: number | null = null;
  let programVersionError: string | undefined;
  let cacheVersion: number | null = null;
  let cacheVersionError: string | undefined;

  try {
    cacheVersion = await getCacheVersion(connection);
  } catch (e) {
    cacheVersionError = e instanceof Error ? e.message : String(e);
  }

  const looked = await fetchProgramVersion(connection, projectPath, programPath);
  programVersion = looked.version;
  programVersionError = looked.error;

  return {
    writtenAt: new Date().toISOString(),
    projectPath,
    programPath,
    programVersion,
    programVersionError,
    cacheVersion,
    cacheVersionError,
    programInfo,
  };
}

/**
 * Analyze a Ghidra project without generating code
 */
export async function analyze(
  projectPath: string,
  options: ReconstructionOptions = {}
): Promise<AnalysisResult & {
  extraction: ExtractionResult;
  classes: DetectedClass[];
  scopingAnalysis: ScopingAnalysis[];
  stats: {
    functionsProcessed: number;
    classesDetected: number;
    dataTypesExtracted: number;
    globalsExtracted: number;
    stringsExtracted: number;
  };
}> {
  const {
    daemonUrl = 'http://localhost:8432',
    onProgress,
    skipDecompile = false,
    decompileTimeout = 30,
    cache,
    excludeLibraryCode = false,
    excludePatterns,
  } = options;

  // Connect to daemon
  const connection = await createConnection(projectPath, daemonUrl);

  try {
    // Extract data from Ghidra
    onProgress?.('extraction', 0, 1);
    const extraction = await extractAll(connection, {
      decompile: !skipDecompile,
      decompileTimeout,
      cache,
      excludeLibraryCode,
      excludePatterns,
      onProgress,
    });

    // Run analysis
    onProgress?.('analysis', 0, 1);
    const analysis = await analyzeAll(
      extraction.functions,
      extraction.globals,
      extraction.dataTypes,
      extraction.namespaces,
      { connection }
    );
    onProgress?.('analysis', 1, 1);

    return {
      ...analysis,
      extraction,
      classes: analysis.classes,
      scopingAnalysis: analysis.scopingAnalysis,
      stats: {
        functionsProcessed: extraction.functions.length,
        classesDetected: analysis.classes.length,
        dataTypesExtracted: extraction.dataTypes.length,
        globalsExtracted: extraction.globals.length,
        stringsExtracted: extraction.strings.length,
      },
    };
  } finally {
    await closeConnection(connection);
  }
}

/**
 * Reconstruct source code from a Ghidra project
 *
 * Main entry point for the reconstruction pipeline.
 */
export async function reconstruct(
  projectPath: string,
  outputOptions: Partial<ReconstructOptions> = {},
  connectionOptions: ReconstructionOptions = {}
): Promise<ReconstructResult> {
  const startTime = Date.now();
  resetTimings();
  resetRpcStats();
  const options: ReconstructOptions = { ...defaultOptions, ...outputOptions };
  const warnings: string[] = [];
  const errors: string[] = [];

  // Auto-load project.json from projectDir/outputDir if not explicitly provided
  if (!options.projectConfig) {
    const configDir = options.projectDir ?? options.outputDir;
    const loaded = await loadConfig(configDir);
    if (loaded) {
      options.projectConfig = loaded;
    }
  }

  const {
    daemonUrl = 'http://localhost:8432',
    onProgress,
    skipDecompile = false,
    decompileTimeout = 30,
    cache,
    excludeLibraryCode = false,
    excludePatterns,
    programPath,
    writeSnapshotFile = true,
    codegenOnly = false,
    snapshotMaxAgeHours,
    useSourceCache = true,
    decompileAllSecondary = false,
    generationWorkers = 1,
    generationWorkerBootstrap,
  } = connectionOptions;

  const snapshotDir = connectionOptions.snapshotDir
    ?? join(options.projectDir ?? options.outputDir, DEFAULT_SNAPSHOT_DIRNAME);
  const sourceCacheBaseDir = connectionOptions.sourceCacheDir
    ?? join(options.projectDir ?? options.outputDir, DEFAULT_SOURCE_CACHE_DIRNAME);

  // Codegen-only: the daemon is never contacted. Everything downstream of
  // analysis is replayed from the snapshot, so a codegen change costs seconds
  // instead of a full re-extraction.
  if (codegenOnly) {
    try {
      const snapshot = await timePhase(
        'snapshot/read',
        () => readSnapshot(snapshotDir),
        snap => `${snap.functions.length} functions, ${snap.dataTypes.length} types, ${snap.globals.length} globals`
      );
      console.log(describeSnapshot(snapshotDir, snapshot.manifest));

      const staleness = assessStaleness(snapshot.manifest, {
        refuseAfterHours: snapshotMaxAgeHours,
      });
      if (staleness.refuse) {
        throw new Error(staleness.message);
      }
      if (staleness.warn && staleness.message) {
        console.warn(`WARNING: ${staleness.message}`);
        warnings.push(staleness.message);
      }

      warnings.push(...snapshot.warnings);
      return await generateAndWrite(
        {
          projectName: options.projectName || snapshot.manifest.projectName,
          functions: snapshot.functions,
          classes: snapshot.classes,
          dataTypes: snapshot.dataTypes,
          globals: snapshot.globals,
          namespaces: snapshot.namespaces,
          programInfo: snapshot.manifest.provenance.programInfo,
          strings: snapshot.strings,
        },
        options,
        excludePatterns,
        onProgress,
        warnings,
        errors,
        startTime,
        {
          workers: generationWorkers,
          snapshotDir,
          bootstrap: generationWorkerBootstrap,
          parseErrorLogPath: parseErrorLogPath(),
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(error instanceof Error ? (error.stack ?? message) : message);
      console.error(`Codegen-only run aborted: ${message}`);
      return {
        success: false,
        filesWritten: [],
        warnings,
        errors,
        stats: {
          functionsProcessed: 0,
          classesDetected: 0,
          filesGenerated: 0,
          dataTypesExtracted: 0,
          globalsExtracted: 0,
          stringsExtracted: 0,
          timeMs: Date.now() - startTime,
        },
      };
    }
  }

  let connection: GhidraConnection | null = null;

  try {
    // Connect to daemon
    onProgress?.('connecting', 0, 1);
    connection = await timePhase(
      'connecting',
      () => createConnection(projectPath, daemonUrl, programPath)
    );
    onProgress?.('connecting', 1, 1);

    // Preflight additional sources (e.g. the mac binary) BEFORE the expensive
    // win extraction. If a configured source can't be opened, abort early
    // instead of wasting the full extraction and silently emitting win-only
    // output with no cross-platform (mac:) anchors.
    // Hold every required additional source (e.g. the mac binary) OPEN for the
    // whole run: (a) fail fast HERE, before the expensive primary extraction, if
    // a source can't be opened; (b) keep the session warm so the later merge
    // REUSES it instead of re-creating+re-analyzing the binary from scratch —
    // re-analysis while the primary program is loaded OOM-crashes the shared
    // Ghidra worker and loses every session. (Do NOT closeConnection here — that
    // drops the session and reintroduces the crash.)
    const preflightConns: GhidraConnection[] = [];
    const requiredSources = options.projectConfig?.additionalSources;
    if (requiredSources && requiredSources.length > 0) {
      const preflightStart = Date.now();
      for (const src of requiredSources) {
        try {
          preflightConns.push(await createConnection(src.ghidra, daemonUrl, src.programPath));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Additional source ${src.platform} (${src.programPath ?? src.ghidra}) is not available: ${msg}. ` +
            `Aborting before extraction — open the ${src.platform} program in ghidra-mcp first so cross-platform anchors are emitted.`
          );
        }
      }
      recordPhase('preflight-sources', Date.now() - preflightStart,
        `${requiredSources.length} additional source(s) opened`);
    }

    // Extract data from Ghidra
    onProgress?.('extraction', 0, 1);
    const extraction = await timePhase(
      'extraction (total)',
      () => extractAll(connection!, {
        decompile: !skipDecompile,
        decompileTimeout,
        cache,
        excludeLibraryCode,
        excludePatterns,
        onProgress,
      }),
      e => `${e.functions.length} functions`,
      true
    );

    // Merge additional sources (secondary binaries) into the extraction
    const additionalSources = options.projectConfig?.additionalSources;
    if (additionalSources && additionalSources.length > 0) {
      await timePhase(
        'merge-additional (total)',
        () => mergeAdditionalSources(
          extraction,
          additionalSources,
          daemonUrl,
          {
            decompile: !skipDecompile,
            decompileTimeout,
            cache,
            onProgress,
            crossPlatformLinks: options.projectConfig?.crossPlatformLinks,
            sourceCacheBaseDir,
            useSourceCache,
            decompileAllSecondary,
          },
          warnings
        ),
        () => `${additionalSources.map(a => a.platform).join(', ')}`,
        true
      );
    }

    // Additional sources merged — now release the warm preflight connections.
    for (const c of preflightConns) { try { await closeConnection(c); } catch { /* best-effort */ } }

    // Filter excluded data types (CRT/MSVC structs etc.) using same patterns as functions
    let dataTypes = extraction.dataTypes;
    if (excludePatterns && excludePatterns.length > 0) {
      const beforeCount = dataTypes.length;
      dataTypes = dataTypes.filter(dt => {
        // Extract category segments for matching (e.g. "/VisualStudio/DName" → ["VisualStudio", "DName"])
        const categorySegments = dt.category ? dt.category.split('/').filter(Boolean) : [];
        for (const pattern of excludePatterns) {
          if (typeof pattern === 'string') {
            if (dt.name.includes(pattern)) return false;
            if (categorySegments.some(seg => seg.includes(pattern))) return false;
          } else {
            if (pattern.test(dt.name)) return false;
            if (categorySegments.some(seg => pattern.test(seg))) return false;
          }
        }
        return true;
      });
      const excludedCount = beforeCount - dataTypes.length;
      if (excludedCount > 0) {
        warnings.push(`Excluded ${excludedCount} data types matching exclude patterns`);
      }
    }

    // Call-site prototype overrides with no calling convention silently corrupt
    // every stack frame the decompiler reports for the functions that own them.
    for (const line of describeAutoProtoLint(lintAutoProtoConventions(dataTypes))) {
      warnings.push(line);
      // The warnings array is only counted, never printed; this one has to be
      // seen or the guard is worthless.
      console.warn(`[auto_proto] ${line}`);
    }

    // Ghidra names every class's virtual function table `vtable` and separates
    // them only by category. Give each the name of the class that owns it before
    // dedup-by-name runs, or thirty-five distinct layouts collapse onto one.
    {
      const vt = disambiguateVtableTypes(dataTypes);
      if (vt.renamed > 0) {
        warnings.push(
          `Named ${vt.renamed} per-class vtable structures after their owning class ` +
          `(${vt.fieldsRepointed} struct fields repointed)`
        );
      }
    }

    // The same collision, one level more general: any two DIFFERENT types that
    // share a bare name across categories. `fpDrawGroundTile` is a four-int stub
    // under /D2GfxHelperStrc and the renderer's real 9-parameter entry point
    // under /D2RenderCallbackStrc; the dedup below kept the stub and
    // `D2RendererFunctionsStrc.nfpDrawGroundTile` silently took its signature.
    {
      const cd = disambiguateCategoryDuplicates(dataTypes);
      if (cd.renamed > 0) {
        warnings.push(
          `Named ${cd.renamed} data types after the struct that owns their category, ` +
          `so a bare-name dedup cannot drop them (${cd.fieldsRepointed} struct fields repointed)`
        );
      }
      if (cd.unresolved.length > 0) {
        warnings.push(
          `${cd.unresolved.length} same-named data types have no identifiable owner and are ` +
          `still dropped by dedup: ${cd.unresolved.slice(0, 10).join(', ')}`
        );
      }
    }

    // Deduplicate data types by name (Ghidra may have the same type in multiple
    // categories, e.g. eD2UnitType in "/" and "/Diablo2/UNIT" — emit only one).
    // For ENUMS, MERGE the values of same-named entries rather than dropping the
    // rest: D2 ships two `eCollisionFlags` enums — /Diablo2/COLLISION (17 COLLIDE_*
    // primitives) and /_Source/Collision (34 values, adding the composite masks
    // COLLISION_LOS=0x805, MONSTER_COLLISION_DEFAULT, SPAWN_UNIT_COLLISION, ...).
    // Bodies use the composites, so dropping the richer one left them undeclared.
    {
      const kept = new Map<string, ExtractedDataType>();
      const beforeCount = dataTypes.length;
      const result: ExtractedDataType[] = [];
      let mergedValues = 0;
      for (const dt of dataTypes) {
        const existing = kept.get(dt.name);
        if (!existing) {
          kept.set(dt.name, dt);
          result.push(dt);
          continue;
        }
        if (dt.kind === 'ENUM' && existing.kind === 'ENUM') {
          const e = existing as ExtractedEnum;
          const have = new Set(e.values.map(v => v.name.trim()));
          for (const v of (dt as ExtractedEnum).values) {
            if (!have.has(v.name.trim())) { e.values.push(v); have.add(v.name.trim()); mergedValues++; }
          }
        }
        // non-enum duplicate (or enum already merged): drop.
      }
      dataTypes = result;
      const dedupCount = beforeCount - dataTypes.length;
      if (dedupCount > 0) {
        warnings.push(`Deduplicated ${dedupCount} data types with identical names across categories (merged ${mergedValues} enum values)`);
      }
    }

    // Run analysis
    onProgress?.('analysis', 0, 1);
    const analysis = await timePhase('analysis', () => analyzeAll(
      extraction.functions,
      extraction.globals,
      dataTypes,
      extraction.namespaces,
      // Emit FREE functions: skip auto class-detection so structs don't get member
      // method declarations (which make call sites render as obj->m() and not link
      // against the free definitions). Explicit project.json methodConversions still
      // build their own classes via applyMethodConversions. Structs + namespaces kept.
      { connection, detectClasses: false }
    ));
    onProgress?.('analysis', 1, 1);

    // Apply static promotion if enabled
    if (options.promoteStaticGlobals) {
      // Track which globals were promoted
      for (const [globalAddr, targetFunc] of analysis.staticPromotions) {
        warnings.push(`Promoting global at ${globalAddr} to static in ${targetFunc}`);
      }
    }

    const projectName = options.projectName || extractProjectName(projectPath);

    const codegenInputs: CodegenInputs = {
      projectName,
      functions: extraction.functions,
      classes: analysis.classes,
      dataTypes,
      globals: extraction.globals,
      namespaces: extraction.namespaces,
      programInfo: extraction.programInfo,
      strings: extraction.strings,
    };

    // Persist the extraction before codegen runs, so a codegen crash still
    // leaves behind a snapshot to iterate against.
    let snapshotWritten = false;
    if (writeSnapshotFile) {
      try {
        const provenance = await captureProvenance(
          connection,
          projectPath,
          programPath,
          extraction.programInfo
        );
        const snapshot: CodegenSnapshot = {
          manifest: {
            formatVersion: SNAPSHOT_FORMAT_VERSION,
            provenance,
            projectName,
            counts: {
              functions: codegenInputs.functions.length,
              dataTypes: codegenInputs.dataTypes.length,
              globals: codegenInputs.globals.length,
              namespaces: codegenInputs.namespaces.length,
              classes: codegenInputs.classes.length,
              strings: codegenInputs.strings.length,
            },
          },
          functions: codegenInputs.functions,
          dataTypes: codegenInputs.dataTypes,
          globals: codegenInputs.globals,
          namespaces: codegenInputs.namespaces,
          classes: codegenInputs.classes,
          strings: codegenInputs.strings,
          staticPromotions: [...analysis.staticPromotions],
          warnings: [...warnings],
        };
        await timePhase(
          'snapshot/write',
          () => writeSnapshot(snapshotDir, snapshot),
          () => `${snapshot.functions.length} functions to ${snapshotDir}`
        );
        snapshotWritten = true;
        console.log(
          `Snapshot written: ${snapshotDir} ` +
          `(Ghidra version ${provenance.programVersion ?? 'unknown'}, ` +
          `modification number ${provenance.cacheVersion ?? 'unknown'})`
        );
      } catch (e) {
        // A snapshot is an optimisation. Never lose a completed extraction over it.
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Failed to write extraction snapshot to ${snapshotDir}: ${msg}`);
        console.warn(`WARNING: could not write snapshot: ${msg}`);
      }
    }

    // Sharding replays the snapshot in each worker, so it is only available
    // when this run actually wrote one. Say so rather than silently halving the
    // expected speed.
    if (generationWorkers > 1 && !snapshotWritten) {
      console.warn(
        'WARNING: parallel generation needs an extraction snapshot to replay; ' +
        'none was written, so generation runs single-threaded.'
      );
    }
    return await generateAndWrite(
      codegenInputs,
      options,
      excludePatterns,
      onProgress,
      warnings,
      errors,
      startTime,
      {
        workers: snapshotWritten ? generationWorkers : 1,
        snapshotDir,
        bootstrap: generationWorkerBootstrap,
        parseErrorLogPath: parseErrorLogPath(),
      }
    );
  } catch (error) {
    // Capture the full stack (not just the message) so codegen crashes are
    // diagnosable from the result alone — the live regen is long and blind,
    // and a bare message rarely points at the failing pass.
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));

    return {
      success: false,
      filesWritten: [],
      warnings,
      errors,
      stats: {
        functionsProcessed: 0,
        classesDetected: 0,
        filesGenerated: 0,
        dataTypesExtracted: 0,
        globalsExtracted: 0,
        stringsExtracted: 0,
        timeMs: Date.now() - startTime,
      },
    };
  } finally {
    if (connection) {
      await closeConnection(connection);
    }
  }
}

/**
 * Extract project name from path
 */
function extractProjectName(projectPath: string): string {
  // Remove .gpr extension and get base name
  const baseName = projectPath
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.gpr$/, '');

  return baseName || 'reconstructed';
}

interface SecondarySourceOptions {
  decompile: boolean;
  decompileTimeout: number;
  cache?: FunctionCache | CacheOptions | boolean;
  onProgress?: ProgressCallback;
  crossPlatformLinks?: import('./config/schema.js').CrossPlatformLink[];
  /** Root under which each additional source keeps its extraction cache. */
  sourceCacheBaseDir?: string;
  /** Read/write that cache at all. False = always go to Ghidra. */
  useSourceCache: boolean;
  /** Fetch every body, including the ones the merge discards. Escape hatch. */
  decompileAllSecondary?: boolean;
}

/**
 * Merge functions and globals from additional (secondary) Ghidra projects
 * into the primary extraction result, tagging them with platform/ifdef.
 */
async function mergeAdditionalSources(
  extraction: ExtractionResult,
  sources: AdditionalSource[],
  daemonUrl: string,
  opts: SecondarySourceOptions,
  warnings: string[]
): Promise<void> {
  for (const source of sources) {
    const ifdef = source.ifdef ?? `D2_PLATFORM_${source.platform.toUpperCase()}`;
    const namespaces = source.namespaces;
    const allNamedMode = !namespaces || namespaces.length === 0 || (namespaces.length === 1 && namespaces[0] === '*');
    let secondaryConn: GhidraConnection | null = null;

    try {
      opts.onProgress?.('additional-source', 0, 1);
      secondaryConn = await createConnection(source.ghidra, daemonUrl, source.programPath);

      if (allNamedMode) {
        // Which secondary functions actually need a BODY is decided here, from
        // the primary extraction alone — before a single body is fetched. The
        // merge keeps only the ADDRESS of anything the primary already has, so
        // decompiling those was pure waste: 8,221 of the mac binary's 11,379
        // bodies were thrown away on every run.

        // Normalize address to bare hex (strip "Program.ram:" prefix and "0x" prefix)
        const bareAddr = (addr: string) => {
          const hex = addr.includes(':') ? addr.slice(addr.lastIndexOf(':') + 1) : addr;
          return hex.replace(/^0x/i, '').toLowerCase();
        };

        // Build qualified name → primary function lookup
        const primaryByQualified = new Map<string, ExtractedFunction>();
        for (const f of extraction.functions) {
          const qname = f.namespace ? `${f.namespace}::${f.name}` : f.name;
          primaryByQualified.set(qname, f);
        }

        // Also build address → primary function lookup for crossPlatformLinks
        const primaryByAddress = new Map<string, ExtractedFunction>();
        for (const f of extraction.functions) {
          primaryByAddress.set(bareAddr(f.address), f);
        }

        // Build bare name → primary functions lookup (for cross-namespace matching)
        const primaryByBareName = new Map<string, ExtractedFunction[]>();
        for (const f of extraction.functions) {
          if (!primaryByBareName.has(f.name)) primaryByBareName.set(f.name, []);
          primaryByBareName.get(f.name)!.push(f);
        }

        // Build mac address → win address from crossPlatformLinks
        const macToWinLink = new Map<string, string>();
        if (opts.crossPlatformLinks) {
          for (const link of opts.crossPlatformLinks) {
            macToWinLink.set(bareAddr(link.mac), bareAddr(link.win));
          }
        }

        /**
         * The primary function this secondary one is the same code as, or null
         * when the secondary binary is the only place it exists. Tried in order:
         * qualified name, unique bare name across namespaces, then an explicit
         * crossPlatformLinks entry (same function, renamed).
         */
        const matchPrimary = (func: ExtractedFunction): ExtractedFunction | null => {
          const qname = func.namespace ? `${func.namespace}::${func.name}` : func.name;
          const byQualified = primaryByQualified.get(qname);
          if (byQualified) return byQualified;

          const bareMatches = primaryByBareName.get(func.name);
          if (bareMatches && bareMatches.length === 1) return bareMatches[0];

          const linkedWinAddr = macToWinLink.get(bareAddr(func.address));
          return (linkedWinAddr ? primaryByAddress.get(linkedWinAddr) : undefined) ?? null;
        };

        /** Only a source-only function's body survives the merge. */
        const needsBody = (func: ExtractedFunction): boolean =>
          !func.name.startsWith('FUN_') && matchPrimary(func) === null;

        const secondary = await obtainSecondaryExtraction(
          secondaryConn,
          source,
          opts,
          needsBody,
          warnings
        );

        // Filter out unnamed FUN_ functions
        const namedFunctions = secondary.functions.filter(
          f => !f.name.startsWith('FUN_')
        );

        let macOnlyCount = 0;
        let sharedCount = 0;

        for (const func of namedFunctions) {
          const primaryMatch = matchPrimary(func);
          if (primaryMatch) {
            // Shared function: annotate primary with the secondary address
            // (no body duplication — this is the cross-platform anchor).
            primaryMatch.crossPlatformAddress = { address: func.address, platform: source.platform };
            sharedCount++;
          } else {
            // Source-only function: tag with ifdef and add to extraction
            func.platform = source.platform;
            func.ifdef = ifdef;
            extraction.functions.push(func);
            macOnlyCount++;
          }
        }

        // Merge mac-only globals
        const namedGlobals = secondary.globals.filter(
          g => !g.name.startsWith('DAT_')
        );
        const primaryGlobalNames = new Set(extraction.globals.map(g =>
          g.namespace ? `${g.namespace}::${g.name}` : g.name
        ));
        let macOnlyGlobals = 0;
        for (const global of namedGlobals) {
          const qname = global.namespace ? `${global.namespace}::${global.name}` : global.name;
          if (!primaryGlobalNames.has(qname)) {
            global.platform = source.platform;
            global.ifdef = ifdef;
            extraction.globals.push(global);
            macOnlyGlobals++;
          }
        }

        // Merge mac-only namespaces
        const primaryNsNames = new Set(extraction.namespaces.map(n => n.fullPath));
        for (const ns of secondary.namespaces) {
          if (!primaryNsNames.has(ns.fullPath)) {
            extraction.namespaces.push(ns);
          }
        }

        // Merge mac-only data types
        const existingTypes = new Set(
          extraction.dataTypes.map(dt => `${dt.category}::${dt.name}`)
        );
        for (const dt of secondary.dataTypes) {
          const key = `${dt.category}::${dt.name}`;
          if (!existingTypes.has(key)) {
            dt.platform = source.platform;
            dt.ifdef = ifdef;
            extraction.dataTypes.push(dt);
            existingTypes.add(key);
          }
        }

        warnings.push(
          `Merged ${macOnlyCount} mac-only functions, ${sharedCount} cross-ref annotations, ${macOnlyGlobals} mac-only globals from ${source.platform} (all-named mode)`
        );
      } else {
        // Legacy mode: extract specific namespaces
        for (const ns of namespaces!) {
          const secondaryExtraction = await extractAll(secondaryConn, {
            decompile: opts.decompile,
            decompileTimeout: opts.decompileTimeout,
            cache: opts.cache,
            namespaceFilter: ns,
            phaseLabel: source.platform,
          });

          const nsFunctions = secondaryExtraction.functions.filter(
            f => f.namespace && f.namespace.startsWith(ns)
          );

          for (const func of nsFunctions) {
            func.platform = source.platform;
            func.ifdef = ifdef;
          }

          const nsGlobals = secondaryExtraction.globals.filter(
            g => g.namespace && g.namespace.startsWith(ns)
          );

          for (const global of nsGlobals) {
            global.platform = source.platform;
            global.ifdef = ifdef;
          }

          const nsNamespaces = secondaryExtraction.namespaces.filter(
            n => n.fullPath.startsWith(ns)
          );

          extraction.functions.push(...nsFunctions);
          extraction.globals.push(...nsGlobals);
          extraction.namespaces.push(...nsNamespaces);

          const existingTypes = new Set(
            extraction.dataTypes.map(dt => `${dt.category}::${dt.name}`)
          );
          for (const dt of secondaryExtraction.dataTypes) {
            const key = `${dt.category}::${dt.name}`;
            if (!existingTypes.has(key)) {
              dt.platform = source.platform;
              dt.ifdef = ifdef;
              extraction.dataTypes.push(dt);
              existingTypes.add(key);
            }
          }

          warnings.push(
            `Merged ${nsFunctions.length} functions, ${nsGlobals.length} globals from ${source.platform}/${ns}`
          );
        }
      }

      opts.onProgress?.('additional-source', 1, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Hard-fail: a configured additional source (e.g. mac) failing mid-extract
      // must abort the whole run, not silently produce output without its
      // cross-platform anchors.
      throw new Error(
        `Failed to extract additional source ${source.platform} (${source.ghidra}): ${msg}. ` +
        `Aborting to avoid emitting output without ${source.platform} cross-platform anchors.`
      );
    } finally {
      if (secondaryConn) {
        await closeConnection(secondaryConn);
      }
    }
  }
}

/** The slice of a secondary extraction the merge consumes. */
interface SecondaryExtraction {
  functions: ExtractedFunction[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  namespaces: ExtractedNamespace[];
}

/**
 * Get the secondary binary's extraction — from its on-disk cache when the
 * program has not moved in Ghidra, otherwise from Ghidra.
 *
 * The cache is keyed on the SECONDARY program's Ghidra domain-file version, and
 * only on that: the mac build sits at version 5 while the windows build moves
 * several times a day, which is exactly why re-extracting it every run was 300s
 * of the same answer. A version that cannot be read is treated as a miss, never
 * as "probably fine".
 *
 * `needsBody` also makes the cache self-healing against the OTHER binary moving:
 * a function that was shared when the cache was written can be source-only now,
 * and its body is fetched on the spot instead of being emitted as a missing one.
 */
async function obtainSecondaryExtraction(
  connection: GhidraConnection,
  source: AdditionalSource,
  opts: SecondarySourceOptions,
  needsBody: (func: ExtractedFunction) => boolean,
  warnings: string[]
): Promise<SecondaryExtraction> {
  const platform = source.platform;
  const dir = opts.sourceCacheBaseDir
    ? sourceCacheDir(opts.sourceCacheBaseDir, platform)
    : null;

  const live = await timePhase(
    `${platform}/cache/version`,
    () => fetchProgramVersion(connection, source.ghidra, source.programPath),
    v => (v.version === null ? `UNAVAILABLE: ${v.error}` : `Ghidra version ${v.version}`)
  );

  let cached: CachedSourceExtraction | null = null;
  if (!opts.useSourceCache) {
    console.log(`${platform} source cache DISABLED — extracting from Ghidra`);
  } else if (!dir) {
    console.log(describeSourceCacheMiss('(none)', platform, 'no directory configured to cache into'));
  } else {
    try {
      const manifest = await readSourceCacheManifest(dir);
      if (!manifest) {
        console.log(describeSourceCacheMiss(dir, platform, 'no cache on disk yet'));
      } else {
        const verdict = verifySourceCache(manifest, {
          platform,
          programPath: source.programPath,
          liveVersion: live.version,
        });
        if (!verdict.ok) {
          console.log(describeSourceCacheMiss(dir, platform, verdict.reason ?? 'unusable'));
        } else {
          cached = await timePhase(
            `${platform}/cache/read`,
            () => readSourceCache(dir),
            c => `${c.functions.length} functions, ${countBodies(c.functions)} bodies`
          );
          // Loud, and BEFORE anything is consumed: a cache silently supplying a
          // stale answer is worse than the time it saves.
          console.log(describeSourceCacheHit(dir, cached.manifest));
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(describeSourceCacheMiss(dir, platform, msg));
      warnings.push(`${platform} source cache unusable, re-extracting: ${msg}`);
      cached = null;
    }
  }

  if (cached) {
    const missing = cached.functions.filter(
      f => !f.decompiled && !f.isExternal && !f.isThunk && needsBody(f)
    );
    if (missing.length === 0) {
      return cached;
    }
    try {
      const fetched = await timePhase(
        `${platform}/cache/top-up`,
        () => decompileBodies(connection, missing, opts.decompileTimeout),
        n => `${n}/${missing.length} bodies the primary binary now needs`
      );
      console.log(
        `  ${platform}: topped up ${fetched}/${missing.length} bodies that became ` +
        `${platform}-only since the cache was written`
      );
      if (dir) {
        await writeCacheQuietly(dir, {
          ...cached,
          manifest: {
            formatVersion: SOURCE_CACHE_FORMAT_VERSION,
            platform,
            provenance: { ...cached.manifest.provenance, writtenAt: new Date().toISOString() },
            counts: countsOf(cached),
          },
        }, platform, warnings);
      }
      return cached;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `  ${platform}: could not top up ${missing.length} missing bodies (${msg}) — ` +
        `falling back to a full extraction rather than emitting them empty`
      );
      warnings.push(`${platform} source cache top-up failed, re-extracted: ${msg}`);
    }
  }

  const extraction = await extractAll(connection, {
    decompile: opts.decompile,
    decompileTimeout: opts.decompileTimeout,
    cache: opts.cache,
    phaseLabel: platform,
    // Bodies only where the merge keeps one. Listing is still exhaustive — the
    // addresses of shared functions are the whole point of this source.
    decompileFilter: opts.decompileAllSecondary ? undefined : needsBody,
  });

  const slice: SecondaryExtraction = {
    functions: extraction.functions,
    dataTypes: extraction.dataTypes,
    globals: extraction.globals,
    namespaces: extraction.namespaces,
  };

  if (dir && opts.useSourceCache) {
    if (live.version === null) {
      const msg =
        `${platform} extraction NOT cached: its Ghidra version could not be read ` +
        `(${live.error}), so the cache could never be invalidated`;
      console.warn(`  ${msg}`);
      warnings.push(msg);
    } else {
      await writeCacheQuietly(dir, {
        ...slice,
        manifest: {
          formatVersion: SOURCE_CACHE_FORMAT_VERSION,
          platform,
          provenance: {
            writtenAt: new Date().toISOString(),
            ghidra: source.ghidra,
            programPath: source.programPath,
            programVersion: live.version,
            programInfo: extraction.programInfo,
          },
          counts: countsOf(slice),
        },
      }, platform, warnings);
    }
  }

  return slice;
}

function countsOf(e: SecondaryExtraction) {
  return {
    functions: e.functions.length,
    functionsWithBody: countBodies(e.functions),
    dataTypes: e.dataTypes.length,
    globals: e.globals.length,
    namespaces: e.namespaces.length,
  };
}

/** Failing to WRITE a cache must never fail the run that produced it. */
async function writeCacheQuietly(
  dir: string,
  cache: CachedSourceExtraction,
  platform: string,
  warnings: string[]
): Promise<void> {
  try {
    await timePhase(
      `${platform}/cache/write`,
      () => writeSourceCache(dir, cache),
      () => `${cache.functions.length} functions (${cache.manifest.counts.functionsWithBody} bodies) to ${dir}`
    );
    console.log(
      `${platform} source cache written: ${dir} ` +
      `(Ghidra version ${cache.manifest.provenance.programVersion})`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  Failed to write ${platform} source cache to ${dir}: ${msg}`);
    warnings.push(`Failed to write ${platform} source cache to ${dir}: ${msg}`);
  }
}

/**
 * Fill in `decompiled` for a handful of functions through the SAME
 * `batch_decompile` the bulk extractor uses, so a topped-up body is the same
 * bytes it would have been had the extraction fetched it.
 *
 * No retry on purpose: the caller's fallback is a full re-extraction, which is
 * a better answer than a half-filled cache.
 */
async function decompileBodies(
  connection: GhidraConnection,
  functions: ExtractedFunction[],
  decompileTimeout: number
): Promise<number> {
  const batchSize = Number(process.env.GHIDRA_DECOMPILE_BATCH_SIZE) || 50;
  let filled = 0;
  for (let i = 0; i < functions.length; i += batchSize) {
    const batch = functions.slice(i, i + batchSize);
    const addresses = batch.map(f => f.address);
    const result = await connection.sendCommand<{
      results: { address: string; pseudocode: string }[];
    }>('batch_decompile', {
      addresses,
      limit: addresses.length,
      decompileTimeout,
      _commandTimeout: Math.max(300000, (decompileTimeout + 5) * addresses.length * 1000),
    });
    const byAddress = new Map(result.results.map(r => [r.address, r]));
    for (const func of batch) {
      const decomp = byAddress.get(func.address);
      if (decomp) {
        func.decompiled = decomp.pseudocode;
        filled++;
      }
    }
  }
  return filled;
}

/**
 * Create a reconstruction pipeline for batch processing
 */
export function createPipeline(options: Partial<ReconstructOptions> = {}) {
  const resolvedOptions: ReconstructOptions = { ...defaultOptions, ...options };

  return {
    /**
     * Reconstruct a single project
     */
    async process(
      projectPath: string,
      connectionOptions?: ReconstructionOptions
    ): Promise<ReconstructResult> {
      return reconstruct(projectPath, resolvedOptions, connectionOptions);
    },

    /**
     * Reconstruct multiple projects
     */
    async processBatch(
      projectPaths: string[],
      connectionOptions?: ReconstructionOptions
    ): Promise<ReconstructResult[]> {
      const results: ReconstructResult[] = [];

      for (const projectPath of projectPaths) {
        const result = await reconstruct(projectPath, resolvedOptions, connectionOptions);
        results.push(result);
      }

      return results;
    },

    /**
     * Get current options
     */
    getOptions(): ReconstructOptions {
      return { ...resolvedOptions };
    },
  };
}

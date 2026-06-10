/**
 * @ghidra-mcp/reconstruct
 *
 * Source code reconstruction from Ghidra projects
 */

// Re-export types
export * from './types.js';

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
  ProgressCallback,
  GhidraConnection,
  DetectedClass,
  ScopingAnalysis,
  ExtractedFunction,
} from './types.js';
import { defaultOptions } from './types.js';

import { extractAll, type ExtractionResult } from './extract/index.js';
import { analyzeAll, type AnalysisResult } from './analysis/index.js';
import { generateProject, writeProject } from './codegen/index.js';
import { createConnection, closeConnection } from './connection.js';
import { FunctionCache, type CacheOptions } from './cache.js';
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
  } = connectionOptions;

  let connection: GhidraConnection | null = null;

  try {
    // Connect to daemon
    onProgress?.('connecting', 0, 1);
    connection = await createConnection(projectPath, daemonUrl, programPath);
    onProgress?.('connecting', 1, 1);

    // Preflight additional sources (e.g. the mac binary) BEFORE the expensive
    // win extraction. If a configured source can't be opened, abort early
    // instead of wasting the full extraction and silently emitting win-only
    // output with no cross-platform (mac:) anchors.
    const requiredSources = options.projectConfig?.additionalSources;
    if (requiredSources && requiredSources.length > 0) {
      for (const src of requiredSources) {
        let probe: GhidraConnection | null = null;
        try {
          probe = await createConnection(src.ghidra, daemonUrl, src.programPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Additional source ${src.platform} (${src.programPath ?? src.ghidra}) is not available: ${msg}. ` +
            `Aborting before extraction — open the ${src.platform} program in ghidra-mcp first so cross-platform anchors are emitted.`
          );
        } finally {
          if (probe) await closeConnection(probe);
        }
      }
    }

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

    // Merge additional sources (secondary binaries) into the extraction
    const additionalSources = options.projectConfig?.additionalSources;
    if (additionalSources && additionalSources.length > 0) {
      await mergeAdditionalSources(
        extraction,
        additionalSources,
        daemonUrl,
        {
          decompile: !skipDecompile,
          decompileTimeout,
          cache,
          onProgress,
          crossPlatformLinks: options.projectConfig?.crossPlatformLinks,
        },
        warnings
      );
    }

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

    // Deduplicate data types by name (Ghidra may have the same type in multiple
    // categories, e.g. eD2UnitType in "/" and "/Diablo2/UNIT" — emit only one)
    {
      const seen = new Set<string>();
      const beforeCount = dataTypes.length;
      dataTypes = dataTypes.filter(dt => {
        if (seen.has(dt.name)) return false;
        seen.add(dt.name);
        return true;
      });
      const dedupCount = beforeCount - dataTypes.length;
      if (dedupCount > 0) {
        warnings.push(`Deduplicated ${dedupCount} data types with identical names across categories`);
      }
    }

    // Run analysis
    onProgress?.('analysis', 0, 1);
    const analysis = await analyzeAll(
      extraction.functions,
      extraction.globals,
      dataTypes,
      extraction.namespaces,
      { connection }
    );
    onProgress?.('analysis', 1, 1);

    // Apply static promotion if enabled
    if (options.promoteStaticGlobals) {
      // Track which globals were promoted
      for (const [globalAddr, targetFunc] of analysis.staticPromotions) {
        warnings.push(`Promoting global at ${globalAddr} to static in ${targetFunc}`);
      }
    }

    // Generate project in memory
    onProgress?.('generation', 0, 1);
    const projectName = options.projectName || extractProjectName(projectPath);
    const project = generateProject(
      projectName,
      extraction.functions,
      analysis.classes,
      dataTypes,
      extraction.globals,
      extraction.namespaces,
      options,
      extraction.programInfo
    );
    onProgress?.('generation', 1, 1);

    // Write to disk
    onProgress?.('writing', 0, 1);
    const filesWritten = await writeProject(project, options.outputDir, options);
    onProgress?.('writing', 1, 1);

    const timeMs = Date.now() - startTime;

    return {
      success: true,
      project,
      outputDir: options.outputDir,
      filesWritten,
      warnings,
      errors,
      stats: {
        functionsProcessed: extraction.functions.length,
        classesDetected: analysis.classes.length,
        filesGenerated: filesWritten.length,
        dataTypesExtracted: dataTypes.length,
        globalsExtracted: extraction.globals.length,
        stringsExtracted: extraction.strings.length,
        timeMs,
      },
      buildInfo: project.buildInfo,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));

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

/**
 * Merge functions and globals from additional (secondary) Ghidra projects
 * into the primary extraction result, tagging them with platform/ifdef.
 */
async function mergeAdditionalSources(
  extraction: ExtractionResult,
  sources: AdditionalSource[],
  daemonUrl: string,
  opts: {
    decompile: boolean;
    decompileTimeout: number;
    cache?: FunctionCache | CacheOptions | boolean;
    onProgress?: ProgressCallback;
    crossPlatformLinks?: import('./config/schema.js').CrossPlatformLink[];
  },
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
        // Extract ALL named functions from secondary binary
        const secondaryExtraction = await extractAll(secondaryConn, {
          decompile: opts.decompile,
          decompileTimeout: opts.decompileTimeout,
          cache: opts.cache,
        });

        // Filter out unnamed FUN_ functions
        const namedFunctions = secondaryExtraction.functions.filter(
          f => !f.name.startsWith('FUN_')
        );

        // Build qualified name → primary function lookup
        const primaryByQualified = new Map<string, ExtractedFunction>();
        for (const f of extraction.functions) {
          const qname = f.namespace ? `${f.namespace}::${f.name}` : f.name;
          primaryByQualified.set(qname, f);
        }

        // Normalize address to bare hex (strip "Program.ram:" prefix and "0x" prefix)
        const bareAddr = (addr: string) => {
          const hex = addr.includes(':') ? addr.slice(addr.lastIndexOf(':') + 1) : addr;
          return hex.replace(/^0x/i, '').toLowerCase();
        };

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

        let macOnlyCount = 0;
        let sharedCount = 0;

        for (const func of namedFunctions) {
          const qname = func.namespace ? `${func.namespace}::${func.name}` : func.name;
          const primaryMatch = primaryByQualified.get(qname);

          if (primaryMatch) {
            // Shared function: annotate primary with mac address (no body duplication)
            primaryMatch.crossPlatformAddress = { address: func.address, platform: source.platform };
            sharedCount++;
          } else {
            // Bare-name fallback: match when namespaces differ but function name is unique
            const bareMatches = primaryByBareName.get(func.name);
            if (bareMatches && bareMatches.length === 1) {
              bareMatches[0].crossPlatformAddress = { address: func.address, platform: source.platform };
              sharedCount++;
            } else {
              // Check if linked via crossPlatformLinks (same function, different name)
              const linkedWinAddr = macToWinLink.get(bareAddr(func.address));
              const linkedPrimary = linkedWinAddr ? primaryByAddress.get(linkedWinAddr) : undefined;

              if (linkedPrimary) {
                // Linked via VT — annotate primary with mac address
                linkedPrimary.crossPlatformAddress = { address: func.address, platform: source.platform };
                sharedCount++;
              } else {
                // Mac-only function: tag with ifdef and add to extraction
                func.platform = source.platform;
                func.ifdef = ifdef;
                extraction.functions.push(func);
                macOnlyCount++;
              }
            }
          }
        }

        // Merge mac-only globals
        const namedGlobals = secondaryExtraction.globals.filter(
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
        for (const ns of secondaryExtraction.namespaces) {
          if (!primaryNsNames.has(ns.fullPath)) {
            extraction.namespaces.push(ns);
          }
        }

        // Merge mac-only data types
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

/**
 * Transform Plugin System Types
 *
 * Defines interfaces for the plugin system that allows extensible
 * transformations of Ghidra decompiler output.
 */

import type { Transformer } from '../transformer.js';
import type { ASTNode } from '../../ast/nodes.js';

// ============================================
// PLUGIN INTERFACE
// ============================================

/**
 * A transform plugin provides a named, versioned transformation
 * that can be enabled/disabled and composed into pipelines.
 */
export interface TransformPlugin {
  /** Unique plugin identifier (e.g., 'loop-canonicalize') */
  id: string;

  /** Human-readable name (e.g., 'Loop Canonicalization') */
  name: string;

  /** Description for LLMs/users explaining what this plugin does */
  description: string;

  /** Plugin version string for cache invalidation */
  version: string;

  /** Whether this plugin is enabled by default */
  defaultEnabled: boolean;

  /** Priority (lower = earlier in pipeline). Default: 100 */
  priority: number;

  /** Tags for categorization (e.g., 'cleanup', 'style', 'optimization') */
  tags?: string[];

  /** Create the transformer function (basic, no injection support) */
  createTransformer(options?: PluginOptions): Transformer;

  /**
   * Create a transformer that can inject code (includes, inline functions, etc.)
   * If not provided, falls back to createTransformer with no injection support.
   */
  createInjectionTransformer?(options?: PluginOptions): InjectionTransformer;

  /**
   * Static code injections that are always needed when this plugin is enabled
   * (e.g., helper function definitions)
   */
  staticInjections?: CodeInjection[];

  /** Optional: ASM pattern matchers for enhanced detection */
  asmPatterns?: AsmPatternMatcher[];

  /** Optional: IDs of plugins this plugin depends on */
  dependencies?: string[];

  /** Optional: IDs of plugins this is incompatible with */
  incompatibleWith?: string[];
}

/**
 * Options passed to a plugin when creating its transformer
 */
export interface PluginOptions {
  /** Plugin-specific options */
  [key: string]: unknown;
}

// ============================================
// ASM PATTERN MATCHING
// ============================================

/**
 * Information about an assembly instruction
 */
export interface InstructionInfo {
  /** Instruction address */
  address: string;

  /** Instruction mnemonic (e.g., 'mov', 'add', 'call') */
  mnemonic: string;

  /** Raw instruction text */
  text: string;

  /** Operands */
  operands: string[];
}

/**
 * Matcher for assembly patterns that can enhance transform detection
 */
export interface AsmPatternMatcher {
  /** Pattern name for debugging/logging */
  name: string;

  /** Mnemonic patterns to match (regex strings) */
  mnemonics: string[];

  /** Minimum number of matching instructions */
  minMatches?: number;

  /** Maximum distance between matched instructions */
  maxDistance?: number;

  /** Callback when pattern is found in ASM */
  onMatch: (
    instructions: InstructionInfo[],
    ast: ASTNode
  ) => ASTNode | undefined;
}

// ============================================
// PIPELINE CONFIGURATION
// ============================================

/**
 * Options for creating a transform pipeline from plugins
 */
export interface PipelineOptions {
  /** Preset configuration: 'quick', 'full', or 'custom' */
  preset?: 'quick' | 'full' | 'custom';

  /** Explicitly enable these plugins (by ID) */
  enablePlugins?: string[];

  /** Explicitly disable these plugins (by ID) */
  disablePlugins?: string[];

  /** Per-plugin options */
  pluginOptions?: Record<string, PluginOptions>;

  /** Enable caching of results */
  cacheEnabled?: boolean;

  /** Track step-by-step results */
  trackSteps?: boolean;
}

/**
 * Options for determining which plugins are enabled
 */
export interface EnabledOptions {
  /** Only include plugins with these tags */
  tags?: string[];

  /** Exclude plugins with these tags */
  excludeTags?: string[];

  /** Use this preset's defaults */
  preset?: 'quick' | 'full';
}

// ============================================
// REGISTRY TYPES
// ============================================

/**
 * Event emitted by the registry
 */
export interface PluginRegistryEvent {
  type: 'register' | 'unregister' | 'enable' | 'disable';
  pluginId: string;
  plugin?: TransformPlugin;
}

/**
 * Listener for registry events
 */
export type PluginRegistryListener = (event: PluginRegistryEvent) => void;

// ============================================
// CODE INJECTION TYPES
// ============================================

/**
 * Code that a plugin wants to inject into the output
 * (includes, inline functions, macros, type definitions)
 */
export interface CodeInjection {
  /** Unique ID for deduplication */
  id: string;

  /** Type of injection */
  type: 'include' | 'function' | 'macro' | 'typedef' | 'preamble';

  /** The actual code to inject */
  code: string;

  /** For includes: whether it's a system include (<>) vs local ("") */
  isSystemInclude?: boolean;

  /** For functions: attributes like always_inline, pure, const */
  attributes?: string[];

  /** Priority for ordering (lower = earlier in output) */
  priority?: number;

  /** Dependencies: other injection IDs that must come before this */
  dependsOn?: string[];
}

/**
 * Collector for code injections from plugins
 */
export interface InjectionContext {
  /** Add an injection */
  inject(injection: CodeInjection): void;

  /** Check if an injection with this ID already exists */
  has(id: string): boolean;

  /** Get all injections, sorted by priority/dependencies */
  getAll(): CodeInjection[];

  /** Generate the preamble code (includes + definitions) */
  generatePreamble(): string;
}

/**
 * Extended transformer that can also inject code
 */
export type InjectionTransformer = (
  node: ASTNode,
  context: InjectionContext
) => ASTNode;

// ============================================
// CACHE TYPES
// ============================================

/**
 * Cache key components for transform results
 */
export interface TransformCacheKey {
  /** Session identifier */
  sessionId: string;

  /** Function address */
  functionAddress: string;

  /** Hash of the function's bytes (for invalidation) */
  functionHash: string;

  /** Transform preset used */
  preset: string;

  /** Hash of enabled plugin versions */
  pluginsHash: string;
}

/**
 * Cached transform result
 */
export interface CachedTransformResult {
  /** Original pseudocode from Ghidra */
  rawPseudocode: string;

  /** Transformed code */
  transformedCode: string;

  /** Renamed identifiers */
  renamedIdentifiers?: Array<{ original: string; renamed: string }>;

  /** Any warnings from transformation */
  transformWarnings?: string[];

  /** Cached AST (JSON serialized) */
  astJson?: string;

  /** Cached analysis (JSON serialized) */
  analysisJson?: string;

  /** When this was cached */
  cachedAt: Date;

  /** Version of the transform system */
  transformVersion: string;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total number of cached entries */
  totalEntries: number;

  /** Number of cache hits */
  hits: number;

  /** Number of cache misses */
  misses: number;

  /** Cache hit rate (0-1) */
  hitRate: number;

  /** Total size in bytes (approximate) */
  sizeBytes: number;
}

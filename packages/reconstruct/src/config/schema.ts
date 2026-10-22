/**
 * Project config schema
 *
 * TypeScript interfaces for project.json configuration
 */

// =============================================================================
// Top-level Config
// =============================================================================

export interface ProjectConfig {
  version: number;
  project: string;
  ghidra?: string;

  overrides?: OverrideEntry[];
  libraries?: LibraryEntry[];
  libraryDetection?: LibraryDetectionConfig;
  targets?: Record<string, TargetConfig>;
  methodConversions?: MethodConversionEntry[];
  /** Path to external JSON file with additional MethodConversionEntry[] */
  methodConversionsFile?: string;
  typeOwnership?: TypeOwnershipEntry[];
  modules?: Record<string, ModuleConfig>;
  autoMethodConversion?: AutoMethodConversionConfig;
  /** Secondary Ghidra projects to merge into the reconstruction */
  additionalSources?: AdditionalSource[];
  /** Pre-computed address links between binaries (populated by sync-names.ts) */
  crossPlatformLinks?: CrossPlatformLink[];
  /** Class templates the tree defines for real instead of flattening their instantiations */
  templates?: TemplatesConfig;
  /**
   * The binary's address runs, each linked from one module (docs/data/runs-v2.tsv).
   * Template members are defined beside the module code of their own run.
   */
  moduleRuns?: ModuleRun[];
}

/** A half-open address run `[start, end)` the linker filled from one module. */
export interface ModuleRun {
  module: string;
  start: string;
  end: string;
}

// =============================================================================
// Class templates
// =============================================================================

export interface TemplatesConfig {
  /** The one header that defines every registered template and key class (`Storm/H/stpl.h`). */
  header: string;
  /** File-name prefix of the units that hold the member definitions (`stpl_`). */
  implPrefix?: string;
  /** Family name -> its parameters. The binary keeps no parameter names; these are ours. */
  families: Record<string, TemplateFamilyConfig>;
  /** Non-template classes the header defines beside the templates (stpl.h's hash keys), by name. */
  classes?: Record<string, TemplateClassConfig>;
  /**
   * Register only these instantiations (any spelling of each); absent means every
   * instantiation of a registered family. An instantiation's template-id arguments
   * must be listed too.
   */
  instantiations?: string[];
}

export interface TemplateClassConfig {
  /** The class key, as the RTTI descriptors that name the class say (`V` class, `U` struct). */
  key: 'class' | 'struct';
}

export interface TemplateFamilyConfig {
  /** The class key, as the RTTI descriptor's `.?AV`/`.?AU` says. */
  key: 'class' | 'struct';
  params: Array<{ name: string; kind: 'type' | 'int' }>;
  /** The base class, spelled over the family's own parameters (`TSHashTable<T, TKey>`). */
  base?: string;
}

// =============================================================================
// Additional Sources (secondary binaries)
// =============================================================================

export interface AdditionalSource {
  /** Path to secondary Ghidra .gpr project */
  ghidra: string;
  /** For multi-program .gpr projects, the program path within the project (e.g. "/macos/1.14d/DiabloII_macho") */
  programPath?: string;
  /** Platform identifier (e.g. "mac", "linux") */
  platform: string;
  /** Only extract these namespaces from the secondary binary. Omit or ["*"] for all named functions. */
  namespaces?: string[];
  /** #ifdef macro name — defaults to "D2_PLATFORM_" + platform.toUpperCase() */
  ifdef?: string;
  /**
   * true merges this source into the tree. Anything else, including absent,
   * leaves it out: no preflight, no extraction, no merge, no anchors, and its
   * records are stripped from a snapshot replay. A secondary binary is opt-in,
   * so a fresh checkout reconstructs the primary alone.
   */
  enabled?: boolean;
}

export interface CrossPlatformLink {
  /** Address in the windows binary */
  win: string;
  /** Address in the mac binary */
  mac: string;
}

// =============================================================================
// Method Conversions (flat function → C++ method)
// =============================================================================

export interface MethodConversionEntry {
  /** Address of the function to convert */
  address: string;
  /** Target class name (e.g. "D2DrlgStrc") */
  className: string;
  /** Method name — defaults to function name with prefix auto-stripped */
  methodName?: string;
  /** Index of the parameter that becomes `this` (default: 0) */
  thisParam?: number;
}

// =============================================================================
// Type Ownership (force type → header mapping)
// =============================================================================

export interface TypeOwnershipEntry {
  /** Type name to place (e.g. "D2UnitStrc") */
  type: string;
  /** Header path relative to output root (e.g. "d2common/units.h") */
  header: string;
}

// =============================================================================
// Function Overrides
// =============================================================================

export type OverrideAction = 'replace' | 'patch';

export interface OverrideEntry {
  address: string;
  name?: string;
  action: OverrideAction;
  /**
   * Why the body differs from the decompiler's: what the entry fixes, and one line of
   * the evidence (the asm it follows). Not emitted; it is the entry's justification.
   */
  reason?: string;
  /** For action: "replace" — path to .cpp file with the replacement body */
  sourceFile?: string;
  /** For action: "patch" — sequential find/replace patches, each find matching exactly once */
  patches?: PatchEntry[];
  /**
   * For action: "replace" — GCC function attributes the definition needs for the
   * body to mean what the binary does, spelled without `__attribute__((...))`:
   * `noinline` for a body that reads its own return address.
   */
  attributes?: string[];
}

export interface PatchEntry {
  find: string;
  replace: string;
  /** Tolerate whitespace differences when matching */
  fuzzy?: boolean;
}

// =============================================================================
// Library Function Mapping
// =============================================================================

export interface LibraryEntry {
  address: string;
  name?: string;
  symbol: string;
  header: string;
  category?: string;
}

export interface LibraryDetectionConfig {
  enabled: boolean;
  signatures?: string;
}

// =============================================================================
// Build Targets
// =============================================================================

export type TargetType = 'interface' | 'static_library' | 'shared_library' | 'executable';

export interface TargetConfig {
  type: TargetType;
  description?: string;
  cmakeName?: string;
  namespaces?: string[];
  functions?: string[];
  addressRanges?: AddressRange[];
  dependencies?: string[];
}

export interface AddressRange {
  start: string;
  end: string;
}

// =============================================================================
// Library Signature Database
// =============================================================================

export interface LibrarySignatureDatabase {
  version: number;
  name: string;
  functions: Record<string, LibrarySignature>;
}

export interface LibrarySignature {
  patterns?: string[];
  heuristics: SignatureHeuristics;
  header: string;
  category?: string;
}

export interface SignatureHeuristics {
  paramCount?: number;
  paramTypes?: string[];
  bodyPatterns?: string[];
  sizeRange?: [number, number];
  returnType?: string;
}

// =============================================================================
// Module Dependency Graph
// =============================================================================

export interface ModuleConfig {
  /** Namespace prefixes belonging to this module */
  namespaces: string[];
  /** Modules this module depends on (can include their headers) */
  dependencies?: string[];
}

// =============================================================================
// Auto Method Conversion
// =============================================================================

export interface AutoMethodConversionConfig {
  enabled: boolean;
  /** Max function byte size to convert (default: 512) */
  maxFunctionSize?: number;
  /** Auto-strip common prefix from method names (default: true) */
  stripPrefix?: boolean;
  /** Addresses to exclude from auto-conversion */
  excludeAddresses?: string[];
  /** Regex patterns on function names to exclude */
  excludePatterns?: string[];
  /** Class names to exclude from auto-conversion */
  excludeClasses?: string[];
  /** If set, only these classes are eligible */
  includeClasses?: string[];
}

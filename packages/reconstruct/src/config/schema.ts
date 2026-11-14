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
  /**
   * One library per Blizzard module, its include visibility from the original
   * import graph (modules/module-libraries.ts). Off unless `enabled`.
   */
  moduleLibraries?: import('../modules/module-libraries.js').ModuleLibrariesConfig;
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
  /**
   * Source outside the generated tree that references generated functions: the
   * hand-written files built beside it, a binder that imports by address. A function
   * it names keeps external linkage (codegen/file-static-functions.ts).
   */
  foreignReferences?: ForeignReferenceEntry[];
  /**
   * The ratchet store (docs/ratchet.md): a directory of per-function bodies the generator
   * keeps where its fresh output differs from a body the VC8 oracle measured MATCH. Path
   * absolute, `~/`-relative or relative to the project dir. `RECON_RATCHET_STORE` overrides
   * it, `RECON_RATCHET=0` turns the ratchet off (the unaided A/B).
   */
  ratchet?: { store: string };
  /**
   * The Mac<->Windows data pairs (mac-win-data-pairs.tsv), a witness for which strings
   * were literals: Clang keeps anonymous literals in `__cstring` and named arrays out of
   * it. Path relative to the project directory, `~` expanded.
   */
  macDataPairs?: string;
}

/**
 * A file, or a directory read recursively for C, C++ and assembly sources. `path` is
 * absolute, `~/`-relative, or relative to the project dir. Every identifier in it
 * (comments and strings aside, mangled symbols split into their names) is a reference
 * by name. With `addressBase`, every integer literal plus it is a reference by address.
 */
export interface ForeignReferenceEntry {
  path: string;
  /** e.g. "0x400000" for offsets from the image base, 0 for absolute addresses. */
  addressBase?: string | number;
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

/** What a module is: the program, one of its DLLs, shared headers, vendored code, or the project's own. */
export type ModuleKind = 'exe' | 'dll-module' | 'headers-only' | '3rdparty' | 'ours';

/** A module this one may use, and why. */
export interface ModuleDependency {
  module: string;
  /** `import`: a static import (transitive). `load`: LoadLibrary + QueryInterface (one step). */
  via: 'import' | 'load';
  /** Where the edge comes from (an import table, a LoadLibrary call). */
  evidence: string;
}

/** A reference the original made against the graph, kept with its reason. */
export interface ModuleException {
  /** The module referenced. */
  to: string;
  /** The symbol the exception covers; omitted, the whole edge. */
  symbol?: string;
  reason: string;
}

/** One module of the tree (modules/module-model.ts). */
export interface ModuleConfig {
  /** Ghidra namespaces the module owns; a namespace belongs to its longest configured prefix. */
  namespaces: string[];
  /** Directory the module's files live in. */
  dir?: string;
  kind?: ModuleKind;
  /** Modules this module may use, each with its evidence. */
  dependencies?: Array<ModuleDependency | string>;
  /** References the original made that the graph does not allow. */
  exceptions?: ModuleException[];
  /** Place in the executable's link order (the 1.14d code runs). */
  linkOrder?: number;
  /**
   * The order of the module's units in its library: `original-address` is the 1.14d
   * link's (each unit by its first function's address, modules/unit-order.ts), `path`
   * (the default) path order.
   */
  unitOrder?: 'original-address' | 'path';
  /** A wrong-direction include is a compile error, not a report line. */
  strict?: boolean;
  /** Compiled into every module that used it (D2Hell): visible to all. */
  embedded?: boolean;
  /** Root-level generated files the module owns (`d2_platform.h`). */
  files?: string[];
  /** The binary the module belongs to; default windows. */
  target?: 'windows' | 'mac';
  /** One paragraph on what the module is; a headers-only module's README. */
  description?: string;
  /**
   * File name of the module's public header in `dir`, `{module}` substituted; default
   * `{module}.h`. Other modules include only this header of the module.
   */
  publicHeader?: string;
  /**
   * Stem the unit of the namespace named after the module takes when the public header
   * has its name, `{module}` substituted; default `{module}Root`.
   */
  rootUnit?: string;
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

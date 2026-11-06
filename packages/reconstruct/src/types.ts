/**
 * Shared types for source reconstruction
 */

import type { ProjectConfig } from './config/schema.js';
import type { SymbolTag } from '@ghidra-mcp/shared';
export type { ProjectConfig, TypeOwnershipEntry, CrossPlatformLink } from './config/schema.js';

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * A function extracted from Ghidra
 */
/** How control enters one label of a decompile (extract/label-flow.ts). */
export interface LabelFlow {
  address: string;
  fallIn: boolean;
  back: number;
  condFwd: number;
  uncondFwd: number;
  computed: number;
  first: string;
  pushedArgs: boolean;
  /**
   * Ghidra's name for a label the decompile printed under its default spelling only
   * (a joined block, `joined_r0x<addr>`); absent where there is none. See label-flow.ts.
   */
  symbol?: string;
}

export interface ExtractedFunction {
  /**
   * Per label of `decompiled`: how control enters it, read from the instructions. Unset in
   * snapshots older than the field (and when the script failed).
   */
  labelFlow?: Record<string, LabelFlow>;
  /**
   * Each comparison token of `decompiled`, tied to the CMP/TEST and Jcc/SETcc that compiled
   * it, as the script's rows (extract/compare-sites.ts). Set only when the script read the
   * same text; unset in older snapshots and when the script failed.
   */
  compareSites?: string;
  /**
   * Code offsets per line of `decompiled` and per `if` keyword (extract/branch-layout.ts).
   * Unset in snapshots older than the field (and when the script failed).
   */
  branchLayout?: import('./extract/branch-layout.js').BranchLayoutFacts;
  /**
   * Direct calls per line of `decompiled`, with the pushes before each (extract/call-order.ts).
   * Unset in snapshots older than the field (and when the script failed).
   */
  callOrder?: import('./extract/call-order.js').CallOrderFacts;
  /**
   * Per line of `decompiled`: call arguments the original loaded into the register their
   * address came through, and the instruction behind each `=` (extract/access-order.ts).
   * Unset in snapshots older than the field.
   */
  accessOrder?: import('./extract/access-order.js').AccessOrderFacts;
  /**
   * The line each way into a halt pushes, and the return addresses a stack probe's CALL
   * leaves in the frame (extract/halt-lines.ts). Unset in snapshots older than the field.
   */
  haltLines?: import('./extract/halt-lines.js').HaltLineFacts;
  name: string;
  address: string;
  signature: string;
  returnType: string;
  parameters: ExtractedParameter[];
  localVariables: ExtractedVariable[];
  namespace?: string;
  parentClass?: string;
  decompiled?: string;
  callingConvention: string;
  size: number;
  isThunk: boolean;
  isExternal: boolean;
  hasVarArgs: boolean;
  /** Ghidra function comment (plate comment) */
  comment?: string;
  sourceFile?: string;
  sourceLine?: number;
  /** Functions called by this function (names or addresses) */
  calledFunctions?: string[];
  /** Functions that call this function (names or addresses) */
  callers?: string[];
  /** Whether this function is a known library function (e.g. CRT) */
  isLibrary?: boolean;
  /** If isLibrary, the mapping to the standard library symbol */
  libraryMapping?: { symbol: string; header: string; category?: string };
  /** Structured tags from Ghidra (method classification, etc.) */
  tags?: SymbolTag[];
  /** Platform identifier (e.g. "mac") for cross-platform sources */
  platform?: string;
  /** #ifdef macro guard (e.g. "D2_PLATFORM_MAC") — wraps this function in codegen */
  ifdef?: string;
  /** Address in the other binary (for cross-reference comments) */
  crossPlatformAddress?: { address: string; platform: string };
  /** Where a thunk jumps. Only set when `isThunk`. */
  thunkTarget?: ThunkTarget;
  /**
   * Listed in an EXCLUDED namespace, and kept anyway because kept code
   * references it and it has a real body in the binary. Extraction sets it; the
   * codegen namespace filter reads it. See `codegen/exclusion-closure`.
   */
  excludedNamespaceReachable?: boolean;
  /**
   * Ghidra call-site prototype overrides on INDIRECT calls in this function: the
   * FUNCTION_DEFINITION each names and its parameter count (see
   * call-site-override-cast). Absent when the snapshot predates them.
   */
  callSiteOverrides?: { callAddress: string; funcdef: string; arity: number }[];
  /**
   * The MSVC EH3/EH4 registration the function opens with, its scope table and the
   * funclets' first instructions (extract/seh-frames.ts). Absent when the function has
   * none or the snapshot predates the field.
   */
  sehFrame?: import('./extract/seh-frames.js').SehFrameFacts;
  /**
   * The stack slots the prologue reserves with `PUSH reg` (MSVC's `PUSH ECX` for
   * `SUB ESP,4`), in Ghidra's stack offsets, with the register pushed
   * (extract/prologue-slots.ts). Absent when there are none or the snapshot predates it.
   */
  pushSlots?: Array<{ offset: number; reg: string }>;
  /**
   * Data references from instruction operands, and the addresses the code derives from
   * them by ADD/SUB/LEA (extract/operand-refs.ts). Absent when the function has none or
   * the snapshot predates the field.
   */
  operandRefs?: import('./extract/operand-refs.js').OperandRefFacts;
  /**
   * The REP STOS/MOVS instructions, with the ECX/EAX they start from and the variables the
   * decompile prints on them (extract/string-ops.ts). Absent when there are none or the
   * snapshot predates the field.
   */
  stringOps?: import('./extract/string-ops.js').StringOpFacts;
  /**
   * The decompiler's jump tables with the bound check's fallback (extract/jump-tables.ts).
   * Absent when there are none or the snapshot predates the field.
   */
  jumpTables?: import('./extract/jump-tables.js').JumpTableFacts;
  /**
   * Per struct-typed stack local, the bytes the original's opening stores write with zero and
   * with anything else (extract/zero-stores.ts). Absent when there are none or the snapshot
   * predates the field.
   */
  zeroStores?: import('./extract/zero-stores.js').ZeroStoreFacts;
  /**
   * The decompile's byte and word masks with the instruction behind each one
   * (extract/mask-sites.ts). Absent when there are none, the text changed since, or the
   * snapshot predates the field.
   */
  maskSites?: import('./extract/mask-sites.js').MaskSiteFacts;
  /**
   * The binary operators whose 32-bit result the decompiler zero-extends to 64 bits and
   * prints as a cast (extract/zext-sites.ts). Absent when there are none, the text changed
   * since, or the snapshot predates the field.
   */
  zextSites?: import('./extract/zext-sites.js').ZextSiteFacts;
  /**
   * The `/` and `%` operators whose instruction is a signed divide (extract/signed-divides.ts).
   * Absent when there are none, the text changed since, or the snapshot predates the field.
   */
  signedDivides?: import('./extract/signed-divides.js').SignedDivideFacts;
  /**
   * The constants the original stores to memory from a register, by the name the left side
   * ends in, with the immediate stores of the same function (extract/register-stores.ts).
   * Absent when there are none or the snapshot predates the field.
   */
  registerStores?: import('./extract/register-stores.js').RegisterStoreFacts;
  /**
   * The rotates by an immediate the original's instructions perform, per decompile line
   * (extract/rotate-sites.ts). Absent when there are none or the snapshot predates the field.
   */
  rotateSites?: import('./extract/rotate-sites.js').RotateSiteFacts;
  /**
   * The register each store is addressed off and each LEA writes, per `=` of a decompile line
   * (extract/store-bases.ts). Absent when there are none or the snapshot predates the field.
   */
  storeBases?: import('./extract/store-bases.js').StoreBaseFacts;
  /**
   * The calls whose result the original divides by a power of two right after they return,
   * per decompile line (extract/call-divides.ts). Absent when there are none or the snapshot
   * predates the field.
   */
  callDivides?: import('./extract/call-divides.js').CallDivideFacts;
}

/**
 * The function a thunk forwards to, resolved by Ghidra's
 * `Function.getThunkedFunction(true)` — i.e. through a chain of thunks to the
 * function that actually has the code.
 *
 * This has to be extracted rather than derived: `decompile` on a thunk returns
 * the TARGET's body under the thunk's name, and the target's name is frequently
 * not the thunk's (`PLRSKILLS_DrawChargeTrailIfPrimary` jumps to
 * `PLRSKILLS_CheckSkillWhipAndLeap`), so neither the body text nor the name is
 * evidence of where it goes.
 */
export interface ThunkTarget {
  /** Entry point of the target. For an import this is Ghidra's EXTERNAL address. */
  address: string;
  /** Target's own name — the import's name when `isExternal`. */
  name: string;
  /** Target's Ghidra namespace path. The DLL name when `isExternal`. */
  namespace?: string;
  /** True when the target is a DLL import rather than a function in this binary. */
  isExternal: boolean;
}

export interface ExtractedParameter {
  name: string;
  dataType: string;
  size: number;
  ordinal: number;
  storage?: string;
}

export interface ExtractedVariable {
  name: string;
  dataType: string;
  size: number;
  storage: string;
  stackOffset?: number;
  register?: string;
}

/**
 * A data type extracted from Ghidra
 */
export interface ExtractedDataType {
  name: string;
  category: string;
  size: number;
  kind: DataTypeKind;
  description?: string;
  /** Platform identifier (e.g. "mac") for cross-platform sources */
  platform?: string;
  /** #ifdef macro guard (e.g. "D2_PLATFORM_MAC") — wraps this type in codegen */
  ifdef?: string;
  /**
   * Set on the shallow listing entry, cleared by the detail that replaces it.
   * While it is set the members are UNKNOWN, which is not the same as a type
   * that genuinely has none: `D2GameViewStrc` has 60,023 components and a
   * ~5 MB `get_data_type` response, and when that fetch was lost the entry it
   * left behind emitted `struct D2GameViewStrc {};` — a body that compiles and
   * then fails at every member access. Codegen refuses to emit a type still
   * carrying this.
   */
  detailUnavailable?: boolean;
  /**
   * The name Ghidra holds this type under, set only where a reconstruct pass gave
   * it another one (`/WardenClient/vtable` -> `WardenClientVtable`). The snapshot
   * carries the emitted name; everything read back from Ghidra - the type listing,
   * the change journal, `get_data_type` - spells the type this way.
   */
  sourceName?: string;
}

export type DataTypeKind =
  | 'BUILT_IN'
  | 'POINTER'
  | 'ARRAY'
  | 'STRUCTURE'
  | 'UNION'
  | 'ENUM'
  | 'FUNCTION_DEFINITION'
  | 'TYPEDEF';

export interface ExtractedStruct extends ExtractedDataType {
  kind: 'STRUCTURE';
  fields: StructField[];
  alignment?: number;
  packed?: boolean;
}

export interface StructField {
  name: string;
  dataType: string;
  offset: number;
  size: number;
  comment?: string;
  /**
   * Bitfields only: the bit position of this field's least-significant bit
   * WITHIN the storage unit that starts at `offset`. Ghidra normalises a
   * bitfield component to minimal storage, so this is always relative to this
   * field's own `offset` and is 0..7 for a one-byte unit.
   *
   * Absent on a snapshot taken before the exporter carried it, and on every
   * non-bitfield. Absent means UNKNOWN, not zero: codegen then falls back to
   * packing the group consecutively from bit 0, which is what it did before
   * the key existed.
   */
  bitOffset?: number;
  /** Bitfields only: effective width in bits, as Ghidra computed it. */
  bitSize?: number;
}

export interface ExtractedEnum extends ExtractedDataType {
  kind: 'ENUM';
  values: EnumValue[];
}

export interface EnumValue {
  name: string;
  value: number;
  comment?: string;
}

export interface ExtractedTypedef extends ExtractedDataType {
  kind: 'TYPEDEF';
  underlyingType: string;
  /**
   * A shifted pointer (a pointer-typedef with a component offset): the pointer holds
   * `base`'s address plus `offset` (extract/shifted-pointers.ts).
   */
  shifted?: { base: string; baseCategory?: string; offset: number };
}

export interface ExtractedUnion extends ExtractedDataType {
  kind: 'UNION';
  fields: StructField[];
}

export interface ExtractedFunctionDefinition extends ExtractedDataType {
  kind: 'FUNCTION_DEFINITION';
  returnType: string;
  parameters: FunctionDefinitionParam[];
  callingConvention?: string;
  hasVarArgs?: boolean;
}

export interface FunctionDefinitionParam {
  name: string;
  dataType: string;
  ordinal: number;
}

/**
 * A global variable / data symbol extracted from Ghidra
 */
export interface ExtractedGlobal {
  name: string;
  address: string;
  dataType: string;
  size: number;
  value?: string;
  namespace?: string;
  isInitialized: boolean;
  xrefCount: number;
  /** List of function names (with namespace) that reference this data */
  referencingFunctions?: string[];
  /** Platform identifier (e.g. "mac") for cross-platform sources */
  platform?: string;
  /** #ifdef macro guard (e.g. "D2_PLATFORM_MAC") — wraps this global in codegen */
  ifdef?: string;
  /** PLATE comment on the data symbol — how the name/type was established */
  comment?: string;
  /**
   * `LIBRARY::symbol` when the data is an import address table slot: a pointer whose
   * reference is EXTERNAL (Ghidra's `->KERNEL32.DLL::SetEvent`). The loader writes the
   * import's address there; the image holds only a hint/name RVA.
   */
  importSlot?: string;
  /**
   * Set only where the address carries two or more labels: true for the one Ghidra
   * makes primary (`SymbolTable.getPrimarySymbol`, the name the decompiler prints),
   * false for the others. Absent in snapshots taken before extraction asked.
   */
  primary?: boolean;
  /** Set by codegen's alias fold on the primary: the address's other labels. */
  aliases?: string[];
}

/**
 * A structured initialized data value from Ghidra
 */
export interface DataValue {
  kind: 'scalar' | 'string' | 'pointer' | 'array' | 'struct' | 'enum';
  value?: string;
  elements?: DataValue[];
  fields?: { name: string; value: DataValue }[];
}

/**
 * Computed scope for a data symbol
 */
export type DataSymbolScope = 'global' | 'static-local' | 'file-local' | 'constant' | 'struct-colocated';

/**
 * Extended data symbol with scope analysis
 */
export interface AnalyzedDataSymbol extends ExtractedGlobal {
  /** Computed scope based on usage */
  scope: DataSymbolScope;
  /** Suggested better name based on usage */
  suggestedName?: string;
  /** Suggested C type (mapped from Ghidra type) */
  suggestedType?: string;
  /** If static-local, which function owns it */
  ownerFunction?: string;
  /** If file-local, which impl file owns it */
  ownerFile?: string;
  /**
   * A `global` several TUs use, defined with external linkage in the TU whose data
   * run it sits in and declared in that TU's data header (file-local-globals.ts).
   */
  homeFile?: string;
  /** A homed global hand-written source names: declared in globals.h, not the data header. */
  homeDeclaredCentrally?: boolean;
  /** Structured initialized data (arrays, structs, pointers resolved to symbols) */
  initializedData?: DataValue;
  /** If struct-colocated, the struct type that owns it (e.g., "D2GameStrc") */
  ownerStructType?: string;
  /** If struct-colocated, the header file that owns it (e.g., "D2Game/GameData/D2GameStrc.h") */
  ownerStructHeader?: string;
  /** An import slot (`importSlot`) no function's decompiled body names: not program data. */
  importSlotUnnamed?: boolean;
  /**
   * Data the compiler or linker made, which the source never declared (compiler-data.ts):
   * a pooled string or float literal, the /GS cookie, RTTI, the image header. Not emitted;
   * references are spelled as the construct that makes VC8 produce it.
   */
  compilerOutput?: import('./codegen/compiler-data.js').CompilerDataClass;
}

/**
 * A string literal extracted from Ghidra
 */
export interface ExtractedString {
  address: string;
  value: string;
  length: number;
  encoding: string;
  inFunction?: string;
  xrefCount: number;
}

/**
 * Namespace information
 */
export interface ExtractedNamespace {
  name: string;
  fullPath: string;
  isClass: boolean;
  parentNamespace?: string;
  functionCount: number;
}

// =============================================================================
// Analysis Types
// =============================================================================

/**
 * Result of scoping analysis for a global
 */
export interface ScopingAnalysis {
  globalId: string;
  globalName: string;
  address: string;
  usedInFunctions: string[];
  shouldBeStatic: boolean;
  suggestedLocation?: string;
}

/**
 * A detected class from analysis
 */
export interface DetectedClass {
  name: string;
  namespace: string;
  vtableAddress?: string;
  methods: DetectedMethod[];
  fields: StructField[];
  baseClasses: string[];
  constructorAddress?: string;
  destructorAddress?: string;
  /**
   * Ghidra's recorded alignment and size for the STRUCTURE this class takes its
   * fields from, carried alongside those fields.
   *
   * A class here is not a C++ class the binary declared - it is a Ghidra
   * structure that acquired methods. Its layout obligations are identical to a
   * struct-shaped one's, and `generateClassDeclaration` needs the same two
   * numbers `generateStructDeclaration` reads off `ExtractedStruct` to decide
   * whether the aggregate has to be packed. Both stay undefined for a class
   * with no matching data type, and an undefined alignment never packs.
   */
  alignment?: number;
  size?: number;
}

export interface DetectedMethod {
  name: string;
  address: string;
  isVirtual: boolean;
  isStatic: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
  visibility: 'public' | 'private' | 'protected';
  vtableIndex?: number;
}

/**
 * Call graph for analysis
 */
export interface CallGraph {
  nodes: Map<string, CallGraphNode>;
  edges: Map<string, Set<string>>;
}

export interface CallGraphNode {
  address: string;
  name: string;
  namespace?: string;
}

/**
 * Call path between two functions
 */
export interface CallPath {
  from: string;
  to: string;
  path: string[];
  depth: number;
}

// =============================================================================
// Code Generation Types
// =============================================================================

/**
 * Binary/program information from Ghidra
 */
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
  /** The data blocks no instruction may write, [start, end): `.rdata`. Absent before extraction recorded it. */
  readOnlyDataSections?: Array<[number, number]>;
}

/**
 * A reconstructed project ready for output
 */
export interface ReconstructedProject {
  name: string;
  files: Map<string, SourceFile>;
  sourceMaps: Map<string, SourceMap>;
  dataTypes: ExtractedDataType[];
  globals: ExtractedGlobal[];
  classes: DetectedClass[];
  namespaces: ExtractedNamespace[];
  /** Binary information from Ghidra */
  programInfo?: ProgramInfo;
  /** Serialized module graph for incremental rebuilds */
  buildInfo?: import('./modules/buildinfo.js').BuildInfo;
  /** Ghidra WARNING comments of the emitted functions, written as warnings.tsv */
  warnings?: import('./codegen/warning-facts.js').WarningRow[];
  /** The module-library pass's reports (module-dag.tsv, module-public-api.tsv), path -> text */
  moduleReports?: Map<string, string>;
}

/**
 * A generated source file
 */
export interface SourceFile {
  path: string;
  content: string;
  type: 'header' | 'implementation';
  namespace?: string;
  className?: string;
  functions: string[];
  includes: string[];
  /**
   * The file exists to pass other headers on (a module's public header): its includes are
   * its content, so the include pass keeps them as written.
   */
  reexport?: boolean;
}

/**
 * Source map for debugging
 */
export interface SourceMap {
  version: number;
  file: string;
  binary?: string;
  functions: FunctionMapping[];
}

export interface CrossPlatformMatch {
  /** Function name in the other binary */
  name: string;
  /** Address in the other binary */
  address: string;
  /** Source file in the other binary's reconstruction */
  file: string;
  /** Platform of the other binary (e.g. "win" or "mac") */
  platform: string;
}

export interface FunctionMapping {
  name: string;
  address: string;
  /** Ghidra namespace (e.g. "Storm::Source::SBig") */
  namespace?: string;
  /**
   * The file the body is defined in when it is not this map's own: an inline host's
   * header (codegen/inline-hosts.ts), included by every TU that calls it.
   */
  definedIn?: string;
  lines: LineMapping[];
  /** Functions called by this function */
  calledFunctions?: string[];
  /** Non-primitive types used in signature and locals (e.g. ["D2GameStrc *", "D2UnitStrc *"]) */
  usedTypes?: string[];
  /** Platform guard (e.g. "D2_PLATFORM_MAC") */
  ifdef?: string;
  /** Same-named function in other binary */
  crossPlatformMatch?: CrossPlatformMatch;
}

export interface LineMapping {
  line: number;
  col?: number;
  address: string;
  asm?: string;
}

/**
 * Line mapping from Ghidra decompiler
 */
export interface DecompilerLineMapping {
  line: number;
  column: number;
  address: string;
  text?: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface ReconstructOptions {
  /** Output directory for generated files (e.g. reconstructed/diablo2/src) */
  outputDir: string;

  /**
   * Project directory containing project.json, overrides/, etc.
   * Defaults to outputDir if not specified.
   * This directory is NOT deleted on regeneration — only outputDir is.
   */
  projectDir?: string;

  /** Output format: 'cpp' or 'c' */
  format: 'cpp' | 'c';

  /** File organization strategy */
  organization: 'namespace' | 'flat' | 'module';

  /** Generate CMakeLists.txt */
  generateCMake: boolean;

  /** Generate source map files */
  generateSourceMaps: boolean;

  /** Transform preset for cpp-parser */
  transformPreset: 'quick' | 'full' | 'custom';

  /** Include address comments in generated code */
  includeAddressComments: boolean;

  /** Apply static promotion for file-local globals */
  promoteStaticGlobals: boolean;

  /** Project name for CMakeLists.txt */
  projectName?: string;

  /** Project config loaded from project.json */
  projectConfig?: ProjectConfig;

  /**
   * Namespace/module names (or patterns) to drop entirely from codegen.
   *
   * Unlike function-level excludePatterns (which only filter individual
   * functions during extraction), this drops every function, class, datatype,
   * global and namespace OWNED by a matching namespace so NO per-namespace
   * header/impl file is generated for it and it never lands in the CMake source
   * list. This is the choke point that keeps reconstructed C/MSVC-runtime
   * modules (compiler/*, VisualStudio/*) out of the build — including
   * mac-merged functions that bypass the extraction-time exclude.
   *
   * Populated by `reconstruct()` from the connection-level `excludePatterns`,
   * so run.ts's existing pattern list is the single source of truth.
   */
  excludeNamespaces?: (string | RegExp)[];
}

export const defaultOptions: ReconstructOptions = {
  outputDir: './reconstructed',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: true,
  generateSourceMaps: true,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: true,
};

// =============================================================================
// API Types
// =============================================================================

/**
 * Connection to a Ghidra session via daemon
 */
export interface GhidraConnection {
  /** Send a command to the Ghidra worker */
  sendCommand<T = unknown>(command: string, params?: Record<string, unknown>): Promise<T>;

  /** Session ID */
  sessionId: string;

  /**
   * The transport puts no bound on one response, so a whole-set listing is one
   * call (`listingPageSize`). The worker's listings are stateless: every page
   * repeats the full walk of the program and keeps only its own slice, so N pages
   * cost N walks. The daemon pages because of HTTP; a local worker need not.
   */
  readonly unpaged?: boolean;

  /** Close the connection */
  close(): Promise<void>;
}

/**
 * Progress callback for long operations
 */
export type ProgressCallback = (phase: string, current: number, total: number) => void;

/**
 * Result of the reconstruction process
 */
export interface ReconstructResult {
  success: boolean;
  project?: ReconstructedProject;
  outputDir?: string;
  filesWritten: string[];
  warnings: string[];
  errors: string[];
  stats: ReconstructStats;
  /** Serialized module graph for incremental rebuilds */
  buildInfo?: import('./modules/buildinfo.js').BuildInfo;
}

export interface ReconstructStats {
  functionsProcessed: number;
  classesDetected: number;
  filesGenerated: number;
  dataTypesExtracted: number;
  globalsExtracted: number;
  stringsExtracted: number;
  timeMs: number;
}

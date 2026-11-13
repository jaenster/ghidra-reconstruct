/**
 * BuildInfo — serializable representation of a module graph build.
 *
 * Stored as JSON on disk after a full reconstruction to enable
 * incremental rebuilds. Comparable to TypeScript's .tsbuildinfo.
 */

import type { DepStrength, ModuleDep, ModuleSymbol, SymbolKind } from './module.js';
import { createHash } from 'node:crypto';
import type { ExtractedFunction, ExtractedDataType, AnalyzedDataSymbol } from '../types.js';

export interface BuildInfo {
  /** Schema version for cache invalidation */
  version: number;
  /** Transform pipeline version */
  pipelineVersion: string;
  /** Timestamp of the build */
  timestamp: number;

  /** Serialized modules (metadata only, no raw data) */
  modules: SerializedModule[];
  /** Symbol name → module ID */
  symbolIndex: Record<string, string>;
  /** Implicit module IDs */
  implicitModules: string[];

  /** Per-symbol content hashes for change detection */
  symbolHashes: Record<string, string>;
  /**
   * The fingerprint of the foreign sources this generation read (hand-written code
   * built beside the tree, `foreignReferences`): an input no Ghidra change reports.
   */
  foreignSources?: string;

  /** Resolved deps per module (output of resolve()) */
  resolved: Record<string, {
    headerIncludes: string[];
    implIncludes: string[];
    forwardDecls: string[];
    crtHeaders: string[];
  }>;
}

export interface SerializedModule {
  id: string;
  implPath: string;
  unitName: string;
  namespace?: string;
  isPlatformOnly: boolean;
  exports: ModuleSymbol[];
  deps: SerializedDep[];
  ownedTypeNames: string[];
  functionNames: string[];
  globalAddresses: string[];
  /**
   * Every unit emitted under this module's header, when several are (the template
   * header's member units). Each names its own functions; the module's deps, owned
   * types and globals are shared by all of them.
   */
  units?: SerializedUnit[];
}

export interface SerializedUnit {
  unitName: string;
  implPath: string;
  functionNames: string[];
}

export interface SerializedDep {
  symbol: string;
  strength: DepStrength;
  targetModule?: string;
}

export const BUILD_INFO_VERSION = 1;

/**
 * Every field of a function record, and whether its unit's hash covers it.
 *
 * The hash decides whether a unit is re-emitted, so a field codegen reads and the
 * hash skips is a change that never reaches the tree: the facts scripts' fields
 * (operandRefs, pushSlots, sehFrame, callSiteOverrides, zextSites, ...) were exactly
 * that. `excluded` is only for a field no generator code reads. A field missing here
 * fails the build (`satisfies`), and a field on a record that this list does not name
 * is hashed.
 */
export const FUNCTION_HASH_FIELDS = {
  name: 'hashed',
  address: 'hashed',
  signature: 'hashed',
  returnType: 'hashed',
  parameters: 'hashed',
  localVariables: 'hashed',
  namespace: 'hashed',
  parentClass: 'hashed',
  decompiled: 'hashed',
  callingConvention: 'hashed',
  size: 'hashed',
  isThunk: 'hashed',
  isExternal: 'hashed',
  hasVarArgs: 'hashed',
  comment: 'hashed',
  calledFunctions: 'hashed',
  callers: 'hashed',
  isLibrary: 'hashed',
  libraryMapping: 'hashed',
  tags: 'hashed',
  platform: 'hashed',
  ifdef: 'hashed',
  crossPlatformAddress: 'hashed',
  thunkTarget: 'hashed',
  excludedNamespaceReachable: 'hashed',
  callSiteOverrides: 'hashed',
  sehFrame: 'hashed',
  pushSlots: 'hashed',
  operandRefs: 'hashed',
  stringOps: 'hashed',
  jumpTables: 'hashed',
  zeroStores: 'hashed',
  maskSites: 'hashed',
  zextSites: 'hashed',
  signedDivides: 'hashed',
  registerStores: 'hashed',
  rotateSites: 'hashed',
  storeBases: 'hashed',
  callDivides: 'hashed',
  shadowedGlobals: 'hashed',
  labelFlow: 'hashed',
  compareSites: 'hashed',
  branchLayout: 'hashed',
  callOrder: 'hashed',
  accessOrder: 'hashed',
  haltLines: 'hashed',
  // Ghidra's source-file annotation of the function: no generator code reads it.
  sourceFile: 'excluded',
  sourceLine: 'excluded',
} as const satisfies Record<keyof ExtractedFunction, 'hashed' | 'excluded'>;

const FUNCTION_HASH_EXCLUDED: ReadonlySet<string> = new Set(
  Object.entries(FUNCTION_HASH_FIELDS).filter(([, how]) => how === 'excluded').map(([field]) => field),
);

/** JSON with every object's keys sorted, so equal records serialise equally. */
function canonicalJson(value: unknown, skip?: ReadonlySet<string>): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v)).join(',')}]`;
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined || skip?.has(key)) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Hash a function for change detection: the whole record, minus the excluded fields. */
export function hashFunction(func: ExtractedFunction): string {
  return createHash('sha256').update(canonicalJson(func, FUNCTION_HASH_EXCLUDED)).digest('hex').slice(0, 16);
}

/**
 * Hash a data type for change detection: the whole record. It covered only the name,
 * kind, size and fields, so a typedef's underlying type or shifted-pointer fact, an
 * enum's values or a function definition's signature could change and no unit using it
 * re-emitted: v1864, seven typedefs lost `shifted`, their headers changed and the .cpp
 * bodies still lowered `ADJ(p)` against the old layout (regen 42e768c21, 6/477 failing).
 */
export function hashDataType(dt: ExtractedDataType): string {
  return createHash('sha256').update(canonicalJson(dt)).digest('hex').slice(0, 16);
}

/** JSON with object keys sorted, so equal values hash equal whatever order built them. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/**
 * Hash a global symbol for change detection.
 *
 * Everything its definition is emitted from: the type and placement, and the
 * initial value. Without the value a global whose bytes changed in Ghidra under
 * the same type kept its old initializer, and nothing marked it.
 */
export function hashGlobal(g: AnalyzedDataSymbol): string {
  const h = createHash('sha256');
  for (const part of [
    g.name, g.dataType, g.address, g.scope ?? '',
    g.suggestedName ?? '', g.suggestedType ?? '', String(g.size ?? ''),
    g.isInitialized ? '1' : '0', g.value ?? '', stableJson(g.initializedData ?? null),
    g.namespace ?? '', g.comment ?? '', g.ifdef ?? '', g.platform ?? '', g.importSlot ?? '',
    g.ownerFile ?? '', g.ownerFunction ?? '', g.ownerStructType ?? '', g.ownerStructHeader ?? '',
  ]) {
    h.update(part);
    h.update('\u0000');
  }
  return h.digest('hex').slice(0, 16);
}

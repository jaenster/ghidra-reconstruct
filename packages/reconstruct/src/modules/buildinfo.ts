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
}

export interface SerializedDep {
  symbol: string;
  strength: DepStrength;
  targetModule?: string;
}

export const BUILD_INFO_VERSION = 1;

/** Hash a function for change detection */
export function hashFunction(func: ExtractedFunction): string {
  const h = createHash('sha256');
  h.update(func.name);
  h.update(func.signature);
  h.update(func.returnType);
  for (const p of func.parameters) {
    h.update(p.name);
    h.update(p.dataType);
  }
  if (func.decompiled) {
    h.update(func.decompiled);
  }
  return h.digest('hex').slice(0, 16);
}

/** Hash a data type for change detection */
export function hashDataType(dt: ExtractedDataType): string {
  const h = createHash('sha256');
  h.update(dt.name);
  h.update(dt.kind);
  h.update(String(dt.size));
  if ('fields' in dt && Array.isArray((dt as any).fields)) {
    for (const f of (dt as any).fields) {
      h.update(f.name ?? '');
      h.update(f.dataType ?? '');
      h.update(String(f.offset ?? 0));
      h.update(String(f.size ?? 0));
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** Hash a global symbol for change detection */
export function hashGlobal(g: AnalyzedDataSymbol): string {
  const h = createHash('sha256');
  h.update(g.name);
  h.update(g.dataType);
  h.update(g.address);
  h.update(g.scope ?? '');
  return h.digest('hex').slice(0, 16);
}

/**
 * Module types for the compilation-unit graph model.
 *
 * A Module represents one compilation unit (header + impl file).
 * It owns symbols (types, functions, globals) and depends on other modules.
 */

import type {
  ExtractedDataType,
  ExtractedFunction,
  AnalyzedDataSymbol,
  DetectedClass,
} from '../types.js';

export type SymbolKind = 'struct' | 'union' | 'enum' | 'typedef' | 'funcdef' | 'function' | 'global';

/**
 * How strongly a module depends on a symbol:
 * - by-value: struct field by value → must #include in header
 * - by-pointer: pointer/reference only → can forward-declare or include
 * - call: function call → include in .cpp
 * - type-ref: type referenced in body (cast, sizeof) → include in .cpp
 */
export type DepStrength = 'by-value' | 'by-pointer' | 'call' | 'type-ref';

export interface ModuleSymbol {
  name: string;
  kind: SymbolKind;
  /** export = declared in header, internal = only in .cpp */
  visibility: 'export' | 'internal';
  /** Optional #ifdef guard wrapping this symbol */
  ifdef?: string;
}

export interface ModuleDep {
  targetModule: string;
  symbol: string;
  strength: DepStrength;
}

export interface Module {
  id: string;              // header path (e.g. "Util/Graph/Graph.h")
  implPath: string;        // .cpp path
  unitName: string;        // original unit name (e.g. "Util::Graph")
  namespace?: string;      // C++ namespace for wrapping
  namespaceParts: string[];

  exports: ModuleSymbol[];
  deps: ModuleDep[];

  ownedTypes: ExtractedDataType[];
  functions: ExtractedFunction[];
  globals: AnalyzedDataSymbol[];
  classInfo?: DetectedClass;

  /** Whether all functions in this module are platform-guarded */
  isPlatformOnly: boolean;
}

export interface ResolvedModule {
  module: Module;
  /** Includes needed in .h (by-value type deps) */
  headerIncludes: string[];
  /** Includes needed in .cpp only (calls, pointer-only, type-refs) */
  implIncludes: string[];
  /** Forward declarations for genuine circular by-value deps */
  forwardDecls: string[];
  /** CRT/stdlib headers (<cstring>, <cmath>, etc.) */
  crtHeaders: string[];
}

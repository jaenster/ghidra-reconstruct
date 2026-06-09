/**
 * Module graph public API
 */

export { ModuleGraph } from './graph.js';
export type {
  Module,
  ModuleSymbol,
  ModuleDep,
  ResolvedModule,
  SymbolKind,
  DepStrength,
} from './module.js';
export { buildModuleGraph, type BuildModuleGraphInput } from './builder.js';
export { ClassicHeaderStrategy, type OutputStrategy, type EmitContext } from './output-strategy.js';
export {
  computeTypeOwnership,
  type TypeOwnershipInput,
  type TypeOwnershipResult,
  stripTypeName,
  stripStructAffixes,
  collectReferencedTypeNames,
  collectReferencedTypeNamesFromTypes,
  countTypeReferences,
  extractStructTypeFromGlobal,
  relocateTypesToSubdirectories,
} from './type-ownership.js';
export {
  BUILD_INFO_VERSION,
  hashFunction,
  hashDataType,
  hashGlobal,
  type BuildInfo,
  type SerializedModule,
  type SerializedDep,
} from './buildinfo.js';

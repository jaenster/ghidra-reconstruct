/**
 * OutputStrategy — pluggable emission backend.
 *
 * The ClassicHeaderStrategy emits traditional #pragma once / #include headers
 * and .cpp implementation files by delegating to the existing generateHeader()
 * and generateImplementation() functions.
 *
 * Future: CppModuleStrategy will emit export module / import syntax.
 */

import type { ResolvedModule } from './module.js';
import type {
  ExtractedDataType,
  ExtractedGlobal,
  AnalyzedDataSymbol,
  ReconstructOptions,
} from '../types.js';
import { generateHeader } from '../codegen/header.js';
import { generateImplementation, type ImplGenContext } from '../codegen/impl.js';
import type { MethodConversionRegistry } from '../methods/index.js';

export interface OutputStrategy {
  emitHeader(
    resolved: ResolvedModule,
    dataTypes: ExtractedDataType[],
    globals: (ExtractedGlobal | AnalyzedDataSymbol)[],
    options: ReconstructOptions,
    context: EmitContext,
  ): string;

  emitImpl(
    resolved: ResolvedModule,
    dataTypes: ExtractedDataType[],
    options: ReconstructOptions,
    context: EmitContext & { implContext: ImplGenContext },
  ): string;
}

export interface EmitContext {
  methodConversions?: MethodConversionRegistry | null;
  allClassNames?: Set<string>;
  /** Set of struct/union/enum names for namespace collision detection */
  structUnionEnumNames?: Set<string>;
  /** Type names already fully defined via includes */
  includedTypeNames?: Set<string>;
  /** Globals header path */
  globalsHeaderPath?: string;
}

/**
 * Classic #pragma once / #include strategy.
 *
 * Delegates to the existing generateHeader() and generateImplementation()
 * functions, translating ResolvedModule data into their parameter format.
 */
export class ClassicHeaderStrategy implements OutputStrategy {
  emitHeader(
    resolved: ResolvedModule,
    dataTypes: ExtractedDataType[],
    globals: (ExtractedGlobal | AnalyzedDataSymbol)[],
    options: ReconstructOptions,
    context: EmitContext,
  ): string {
    const mod = resolved.module;
    const ownedTypeNames = new Set(mod.ownedTypes.map(t => t.name));

    // Compute which types are already defined by our header includes
    const includedTypeNames = context.includedTypeNames ?? new Set<string>();

    return generateHeader(
      mod.unitName,
      mod.functions,
      mod.classInfo,
      dataTypes,
      globals,
      options,
      context.methodConversions,
      resolved.headerIncludes,   // extraIncludes (type includes for .h)
      ownedTypeNames,
      undefined,                  // publicFunctions — declare all
      context.allClassNames,
      includedTypeNames,
      mod.id,                     // headerPath
      undefined,                  // funcIncludes (not used in current model)
    );
  }

  emitImpl(
    resolved: ResolvedModule,
    dataTypes: ExtractedDataType[],
    options: ReconstructOptions,
    context: EmitContext & { implContext: ImplGenContext },
  ): string {
    const mod = resolved.module;

    // Impl includes: own header + headerIncludes + implIncludes + globals
    const implIncludes: string[] = [];
    if (context.globalsHeaderPath) {
      implIncludes.push(context.globalsHeaderPath);
    }
    // All includes (header + impl) go into .cpp
    const allIncludes = new Set([...resolved.headerIncludes, ...resolved.implIncludes]);
    implIncludes.push(...[...allIncludes].sort());

    return generateImplementation(
      mod.unitName,
      mod.functions,
      mod.classInfo,
      mod.id,                                   // headerPath
      options,
      context.implContext,
      implIncludes,
      new Set(resolved.crtHeaders),
      undefined,                                // internalFunctions
      context.structUnionEnumNames,
    );
  }
}

/**
 * ModuleGraph builder — creates and populates a ModuleGraph
 * from extracted Ghidra data and type ownership results.
 *
 * This bridges between the extraction/organization phase
 * and the resolution/emission phase.
 */

import { ModuleGraph } from './graph.js';
import type { DepStrength, SymbolKind } from './module.js';
import type { TypeOwnershipResult } from './type-ownership.js';
import {
  stripTypeName,
  collectReferencedTypeNames,
  collectReferencedTypeNamesFromTypes,
} from './type-ownership.js';
import { parseTypeString, isBuiltinType } from '../analysis/references.js';
import { collectCrtHeaders } from '../codegen/crt-mapping.js';
import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedStruct,
  AnalyzedDataSymbol,
  DetectedClass,
  ReconstructOptions,
} from '../types.js';
import { isPlatformOrBuiltinType } from '../codegen/platform-types.js';

export interface BuildModuleGraphInput {
  organized: Map<string, ExtractedFunction[]>;
  classes: DetectedClass[];
  dataTypes: ExtractedDataType[];
  globals: AnalyzedDataSymbol[];
  unitHeaderPaths: Map<string, string>;
  ownership: TypeOwnershipResult;
  options: ReconstructOptions;
  /** Function name → header path (for call dep resolution) */
  funcNameToHeaderPath: Map<string, string>;
  /** Set of headers that contain only platform-guarded functions */
  platformHeaders: Set<string>;
  /** Enum types in shared header (implicit, not included) */
  sharedEnumTypes?: Set<string>;
  /** Globals header path (if any) */
  globalsHeaderPath?: string;
}

/**
 * Build a fully populated ModuleGraph from extracted data.
 *
 * Each organized unit becomes a module. Types are assigned per typeOwnerMap.
 * Dependencies are registered from struct fields, function signatures,
 * called functions, and global types.
 */
export function buildModuleGraph(input: BuildModuleGraphInput): ModuleGraph {
  const {
    organized,
    classes,
    dataTypes,
    globals,
    unitHeaderPaths,
    ownership,
    options,
    funcNameToHeaderPath,
    platformHeaders,
    sharedEnumTypes,
    globalsHeaderPath,
  } = input;

  const { typeOwnerMap, structsWithOwnUnit, extraHeaderTypes } = ownership;
  const graph = new ModuleGraph();

  const implExt = options.format === 'c' ? '.c' : '.cpp';

  // Register implicit modules
  if (sharedEnumTypes && sharedEnumTypes.size > 0) {
    graph.createModule({ id: 'd2_enums.h', implPath: '', unitName: '_enums' });
    graph.markImplicit('d2_enums.h');
    for (const enumName of sharedEnumTypes) {
      graph.registerGlobalSymbol(enumName, 'd2_enums.h');
    }
  }
  graph.createModule({ id: 'd2_platform.h', implPath: '', unitName: '_platform' });
  graph.markImplicit('d2_platform.h');

  if (globalsHeaderPath) {
    graph.createModule({ id: globalsHeaderPath, implPath: globalsHeaderPath.replace(/\.h$/, implExt), unitName: '_globals' });
  }

  // Create a module for each organized unit
  for (const [unitName, unitFunctions] of organized) {
    const headerPath = unitHeaderPaths.get(unitName)!;
    const classInfo = classes.find(cls => cls.name === unitName);
    const allPlatformGuarded = unitFunctions.length > 0 && unitFunctions.every(f => f.ifdef);

    const mod = graph.createModule({
      id: headerPath,
      implPath: headerPath.replace(/\.h$/, implExt),
      unitName,
      namespace: unitFunctions[0]?.namespace,
      classInfo,
      isPlatformOnly: allPlatformGuarded,
    });

    mod.functions = unitFunctions;

    // Register functions as exports
    for (const func of unitFunctions) {
      graph.exportSymbol(headerPath, func.name, 'function', 'export', func.ifdef);
    }

    // Determine which types this module owns
    const ownedTypeNames = new Set<string>();
    for (const [typeName, ownerPath] of typeOwnerMap) {
      if (ownerPath !== headerPath) continue;
      if (structsWithOwnUnit.has(typeName) && typeName !== unitName) continue;
      ownedTypeNames.add(typeName);
    }

    // Register owned types as exports
    for (const typeName of ownedTypeNames) {
      const dt = dataTypes.find(d => d.name === typeName);
      if (!dt) continue;
      const kind = mapDataTypeKind(dt.kind);
      graph.exportSymbol(headerPath, typeName, kind, 'export', dt.ifdef);
      mod.ownedTypes.push(dt);
    }

    // Add deps from owned struct fields
    for (const dt of mod.ownedTypes) {
      if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
      const struct = dt as ExtractedStruct;
      if (!struct.fields) continue;
      for (const field of struct.fields) {
        const stripped = stripTypeName(field.dataType);
        if (!stripped || isPlatformOrBuiltinType(stripped)) continue;
        if (ownedTypeNames.has(stripped)) continue;
        const strength: DepStrength = (field.dataType.includes('*') || field.dataType.includes('&'))
          ? 'by-pointer' : 'by-value';
        graph.addDependency(headerPath, stripped, strength);
      }
    }

    // Add deps from function signatures
    for (const func of unitFunctions) {
      // Return type
      const retParsed = parseTypeString(func.returnType);
      if (!isBuiltinType(retParsed.name) && !ownedTypeNames.has(retParsed.name)) {
        graph.addDependency(headerPath, retParsed.name, retParsed.isPointer ? 'by-pointer' : 'type-ref');
      }

      // Parameters
      for (const param of func.parameters) {
        const parsed = parseTypeString(param.dataType);
        if (!isBuiltinType(parsed.name) && !ownedTypeNames.has(parsed.name)) {
          graph.addDependency(headerPath, parsed.name, parsed.isPointer ? 'by-pointer' : 'type-ref');
        }
      }

      // Called functions → call deps
      for (const callee of func.calledFunctions ?? []) {
        const calleeHeader = funcNameToHeaderPath.get(callee);
        if (calleeHeader && calleeHeader !== headerPath) {
          const isPlatform = !allPlatformGuarded && platformHeaders.has(calleeHeader);
          if (!isPlatform) {
            graph.addDependency(headerPath, callee, 'call');
          }
        }
      }
    }

    // Add deps from file-local globals
    for (const g of globals) {
      if (g.scope === 'file-local' && g.ownerFile === mod.implPath) {
        const stripped = stripTypeName(g.dataType);
        if (stripped && !isPlatformOrBuiltinType(stripped) && !ownedTypeNames.has(stripped)) {
          const strength: DepStrength = (g.dataType.includes('*') || g.dataType.includes('&'))
            ? 'by-pointer' : 'by-value';
          graph.addDependency(headerPath, stripped, strength);
        }
        mod.globals.push(g);
      }
    }

    // Add dep on globals header if present
    if (globalsHeaderPath) {
      graph.addDependency(headerPath, '_globals_header_sentinel', 'call');
      graph.registerGlobalSymbol('_globals_header_sentinel', globalsHeaderPath);
    }
  }

  // Create modules for type-only headers
  for (const [headerPath, typeNames] of extraHeaderTypes) {
    const mod = graph.createModule({
      id: headerPath,
      implPath: headerPath.replace(/\.h$/, implExt),
      unitName: headerPath.replace(/\.h$/, ''),
    });

    for (const typeName of typeNames) {
      const dt = dataTypes.find(d => d.name === typeName);
      if (!dt) continue;
      const kind = mapDataTypeKind(dt.kind);
      graph.exportSymbol(headerPath, typeName, kind, 'export', dt.ifdef);
      mod.ownedTypes.push(dt);
    }

    // Add deps from struct fields in type-only headers
    const ownedDataTypes = dataTypes.filter(dt => typeNames.has(dt.name));
    for (const dt of ownedDataTypes) {
      if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
      const struct = dt as ExtractedStruct;
      if (!struct.fields) continue;
      for (const field of struct.fields) {
        const stripped = stripTypeName(field.dataType);
        if (!stripped || isPlatformOrBuiltinType(stripped)) continue;
        if (typeNames.has(stripped)) continue;
        const strength: DepStrength = (field.dataType.includes('*') || field.dataType.includes('&'))
          ? 'by-pointer' : 'by-value';
        graph.addDependency(headerPath, stripped, strength);
      }
    }
  }

  return graph;
}

function mapDataTypeKind(kind: string): SymbolKind {
  switch (kind) {
    case 'STRUCTURE': return 'struct';
    case 'UNION': return 'union';
    case 'ENUM': return 'enum';
    case 'TYPEDEF': return 'typedef';
    case 'FUNCTION_DEFINITION': return 'funcdef';
    default: return 'struct';
  }
}

/**
 * Code generation orchestration
 *
 * Coordinates generation of reconstructed source files
 */

export { generateHeader, cleanFunctionComment } from './header.js';
export { generateImplementation, resolveOverridePlaceholders, setParseErrorLogPath, getParseErrorCount, type ImplGenContext } from './impl.js';
export { generateCMakeLists, generateTopLevelCMake, generateTargetCMake, generateUnsortedCMake } from './cmake.js';
export { generateSourceMap } from './sourcemap.js';
export { generateReadme } from './readme.js';
export { resolveCrtInclude, collectCrtHeaders } from './crt-mapping.js';
export {
  createNamespaceDirectory,
  getFilePath,
  organizeByNamespace,
} from './namespace.js';
export {
  generateGlobalsHeader,
  generateGlobalsImpl,
  generateColocatedGlobalsImpl,
  generateExternDeclaration,
  generateStaticLocalDeclaration,
  generateStaticLocalsBlock,
  inferArrayDeclaration,
  emitDataValue,
  groupByNamespace,
  normalizeArrayDeclaration,
  isSwitchTableSymbol,
} from './globals-header.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ReconstructedProject,
  ReconstructOptions,
  DetectedClass,
  ExtractedFunction,
  ExtractedDataType,
  ExtractedGlobal,
  ExtractedNamespace,
  ExtractedStruct,
  SourceFile,
  SourceMap,
  ProgramInfo,
  AnalyzedDataSymbol,
} from '../types.js';
import { resolveOverridePlaceholders } from './impl.js';

import { generateHeader, setKnownFuncDefs } from './header.js';
import { generateImplementation, type ImplGenContext } from './impl.js';
import { generateCMakeLists, generateTopLevelCMake, generateTargetCMake, generateUnsortedCMake } from './cmake.js';
import { generateSourceMap } from './sourcemap.js';
import { generateReadme } from './readme.js';
import { organizeByNamespace, getFilePath, setModuleNames } from './namespace.js';
import { generateGlobalsHeader, generateGlobalsImpl, generateColocatedGlobalsImpl, setKnownFuncDefTypedefs } from './globals-header.js';
import { isPlatformOrBuiltinType, generatePlatformHeader } from './platform-types.js';
import { createOverrideRegistry } from '../overrides/index.js';
import { createLibraryRegistry } from '../library/index.js';
import { createMethodConversionRegistry, getOrCreateRegistry, applyMethodConversions, detectMethodConversionsFromTags, type MethodCallMapping, type MethodConversionRegistry } from '../methods/index.js';
import type { MethodConversionEntry, ModuleConfig, AutoMethodConversionConfig, TypeOwnershipEntry } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';
import { resolveTargets, getTargetDirectory, type ResolvedTarget } from '../targets/index.js';
import { generateStubsHeader } from '../targets/stubs.js';
import { collectCrtHeaders } from './crt-mapping.js';
import {
  computeTypeOwnership,
  stripTypeName,
  extractStructTypeFromGlobal,
  collectReferencedTypeNames,
  collectReferencedTypeNamesFromTypes,
  stripStructAffixes,
  countTypeReferences,
  relocateTypesToSubdirectories,
} from '../modules/type-ownership.js';
import { buildModuleGraph } from '../modules/builder.js';
import { hashFunction, hashDataType, hashGlobal } from '../modules/buildinfo.js';

/**
 * Generate a complete reconstructed project
 */
export function generateProject(
  name: string,
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  dataTypes: ExtractedDataType[],
  globals: AnalyzedDataSymbol[] | ExtractedGlobal[],
  namespaces: ExtractedNamespace[],
  options: ReconstructOptions,
  programInfo?: ProgramInfo
): ReconstructedProject {
  const files = new Map<string, SourceFile>();
  const sourceMaps = new Map<string, SourceMap>();

  // Defensive: a datatype can reach codegen with its detail array undefined —
  // a type whose detail fetch was skipped/failed leaves the shallow listing
  // entry (no fields/values/parameters). Normalize every kind's array once here
  // so every downstream consumer may assume the array exists.
  for (const dt of dataTypes) {
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') {
      const s = dt as ExtractedStruct;
      if (!Array.isArray(s.fields)) s.fields = [];
    } else if (dt.kind === 'ENUM') {
      const e = dt as import('../types.js').ExtractedEnum;
      if (!Array.isArray(e.values)) e.values = [];
    } else if (dt.kind === 'FUNCTION_DEFINITION') {
      const f = dt as import('../types.js').ExtractedFunctionDefinition;
      if (!Array.isArray(f.parameters)) f.parameters = [];
    }
  }

  // Register every function-pointer typedef name (FUNCTION_DEFINITION datatypes)
  // so stripFuncDefIndirection / struct-field stripping recognise all-caps and
  // irregular fnptr typedefs (QUESTCALLBACK, ...), not just naming conventions.
  // Must run before any header/globals/impl emission below.
  const funcDefDataTypes = dataTypes.filter(
    dt => dt.kind === 'FUNCTION_DEFINITION'
  ) as import('../types.js').ExtractedFunctionDefinition[];
  setKnownFuncDefTypedefs(funcDefDataTypes.map(dt => dt.name));
  // Same set, by name, so a typedef targeting `<FunctionDefinition> *` can be
  // inlined into a self-contained function-pointer typedef.
  setKnownFuncDefs(funcDefDataTypes);

  // Drop excluded namespaces/modules ENTIRELY (functions + classes + datatypes
  // + globals + namespace records) so no per-namespace header/impl file is ever
  // generated for them and they never reach the CMake source list (which is
  // derived purely from project.files). This is what keeps reconstructed
  // C/MSVC-runtime modules — compiler/*, VisualStudio/* — out of the build.
  //
  // Function-level excludePatterns only filter PRIMARY-binary functions during
  // extraction; (a) whole runtime namespaces with no matching pattern, and
  // (b) mac-merged functions from a secondary source (which is extracted
  // WITHOUT excludePatterns), still arrive here. Filtering by namespace at the
  // single codegen choke point closes both gaps.
  const excludeNs = options.excludeNamespaces ?? [];
  if (excludeNs.length > 0) {
    const nsMatches = (ns: string | undefined | null): boolean => {
      if (!ns) return false;
      for (const pattern of excludeNs) {
        if (typeof pattern === 'string') {
          if (ns === pattern) return true;
        } else if (pattern.test(ns)) {
          return true;
        }
      }
      return false;
    };
    const catMatches = (category: string | undefined | null): boolean => {
      if (!category) return false;
      return category.split('/').filter(Boolean).some(seg => nsMatches(seg));
    };

    const fnBefore = functions.length;
    functions = functions.filter(f => !nsMatches(f.namespace));
    classes = classes.filter(c => !nsMatches(c.namespace) && !nsMatches(c.name));
    dataTypes = dataTypes.filter(dt => !catMatches(dt.category) && !nsMatches(dt.name));
    globals = (globals as Array<{ namespace?: string }>).filter(
      g => !nsMatches(g.namespace)
    ) as typeof globals;
    namespaces = namespaces.filter(ns => !nsMatches(ns.name) && !nsMatches(ns.fullPath));
    const dropped = fnBefore - functions.length;
    if (dropped > 0) {
      console.log(`Excluded ${dropped} function(s) in excluded namespaces (no file emitted for them)`);
    }
  }

  // Initialize namespace collapsing with module names from project config
  const modules = options.projectConfig?.modules ?? {};
  setModuleNames(Object.keys(modules));

  // Build registries from project config
  // Override files live in projectDir (not outputDir) so they survive regeneration
  const projectDir = options.projectDir ?? options.outputDir;
  const overrides = createOverrideRegistry(options.projectConfig, projectDir);
  const libraries = createLibraryRegistry(options.projectConfig);
  let methodConversions = createMethodConversionRegistry(options.projectConfig);

  // Detect method conversions from structured tags
  const tagEntries = detectMethodConversionsFromTags(functions);
  if (tagEntries.length > 0) {
    methodConversions = getOrCreateRegistry(methodConversions, tagEntries);
    console.log(`Detected ${tagEntries.length} methods from structured tags`);
  }

  // Apply method conversions (from tags + explicit methodConversions in project.json)
  if (methodConversions) {
    applyMethodConversions(functions, classes, methodConversions);
  }

  const explicitMappings = methodConversions?.buildPluginMappings() ?? {};
  const mergedMappings = { ...explicitMappings };

  // Add qualified name entries and remove ambiguous bare names.
  // A bare name is ambiguous when a non-method function shares the same name
  // (e.g., GetRoom exists as both a method on D2DynamicPathStrc and a free function).
  if (methodConversions) {
    const funcByAddr = new Map<string, ExtractedFunction>();
    for (const func of functions) funcByAddr.set(func.address, func);

    // Collect method names to detect ambiguity
    const methodNames = new Set<string>();
    for (const entry of methodConversions.values()) {
      if (entry.originalName) methodNames.add(entry.originalName);
    }

    // Find bare names that also exist as non-method functions
    const ambiguousNames = new Set<string>();
    for (const func of functions) {
      if (methodNames.has(func.name) && !func.parentClass) {
        ambiguousNames.add(func.name);
      }
    }

    // Add qualified entries for all methods
    for (const entry of methodConversions.values()) {
      if (!entry.originalName) continue;
      const func = funcByAddr.get(entry.address);
      if (func?.namespace) {
        const qualifiedKey = `${func.namespace}::${entry.originalName}`;
        mergedMappings[qualifiedKey] = mergedMappings[entry.originalName];
      }
    }

    // Remove ambiguous bare names — they should only match via qualified lookup
    for (const name of ambiguousNames) {
      delete mergedMappings[name];
    }
    if (ambiguousNames.size > 0) {
      console.log(`Removed ${ambiguousNames.size} ambiguous method name mappings (${[...ambiguousNames].slice(0, 10).join(', ')}${ambiguousNames.size > 10 ? '...' : ''})`);
    }
  }
  if (Object.keys(mergedMappings).length > 0) {
    console.log(`Method call mappings: ${Object.keys(mergedMappings).length} entries`);
  }

  // Build function address map for func-ptr-literal resolution
  // Address format is "Game.exe.ram:005011f0" — extract hex after last colon
  const functionAddressMap = new Map<bigint, string>();
  for (const func of functions) {
    if (func.name.startsWith('FUN_')) continue;
    const hexPart = func.address.includes(':')
      ? func.address.slice(func.address.lastIndexOf(':') + 1)
      : func.address;
    try {
      const addr = BigInt('0x' + hexPart);
      functionAddressMap.set(addr, func.name);
    } catch {
      // Skip addresses that can't be parsed
    }
  }

  // Build bitfield catalog from struct metadata
  const bitfieldCatalog = buildBitfieldCatalog(dataTypes);

  const context: ImplGenContext = {
    overrides,
    libraries,
    methodConversions,
    methodMappings: Object.keys(mergedMappings).length > 0 ? mergedMappings : undefined,
    functionAddressMap: functionAddressMap.size > 0 ? functionAddressMap : undefined,
    bitfieldCatalog: bitfieldCatalog.size > 0 ? bitfieldCatalog : undefined,
  };

  // Tag library functions before organizing
  if (libraries) {
    for (const func of functions) {
      const libEntry = libraries.get(func.address);
      if (libEntry) {
        func.isLibrary = true;
        func.libraryMapping = {
          symbol: libEntry.symbol,
          header: libEntry.header,
          category: libEntry.category,
        };
      }
    }
  }

  // Emit platform types header
  files.set('d2_platform.h', {
    path: 'd2_platform.h',
    content: generatePlatformHeader(),
    type: 'header',
    functions: [],
    includes: [],
  });

  // Collect all ENUM data types into a shared header.
  // Enum constants (e.g. SOUND_NONE, UNIT_PLAYER) are used across many files but the
  // body scanner can't detect them (it only finds struct pointer casts). Putting all enums
  // in one shared header included from d2_platform.h makes them universally available.
  const enumTypes = dataTypes.filter(t => t.kind === 'ENUM') as import('../types.js').ExtractedEnum[];
  if (enumTypes.length > 0) {
    const enumLines: string[] = [
      '// Auto-generated by ghidra-mcp — DO NOT EDIT',
      '// Shared enum definitions (included from d2_platform.h)',
      '',
      '#pragma once',
      '',
      '#include <cstdint>',
      '',
    ];
    // Track emitted constexpr names to avoid duplicates across enum types.
    // Values go in a per-enum namespace with `using namespace` to avoid name collisions
    // between enums that share value names (e.g. Death in both player and monster anim modes).
    const emittedNames = new Set<string>();
    // Win32/CRT/compiler constants that Ghidra swept into enums collide with the
    // real <windows.h>/<winnt.h> macros. Under _WIN32 the platform headers own
    // them; emit our copies only when building without the SDK (non-_WIN32).
    //   - `define_*` enums are recovered preprocessor #defines
    //     (TRUE, WINVER, _M_IX86, _MSC_VER, the SAL annotation switches...)
    //   - IMAGE_* values are PE-format section/header constants from <winnt.h>
    const isPlatformEnumValue = (enumName: string, valueName: string): boolean =>
      /^define_/.test(enumName) || /^IMAGE_[A-Z]/.test(valueName);
    for (const e of enumTypes) {
      if (isPlatformOrBuiltinType(e.name)) continue;
      if (/[^a-zA-Z0-9_]/.test(e.name)) continue;
      enumLines.push(`typedef int ${e.name};`);
      if (e.values.length > 0) {
        const normalLines: string[] = [];
        const platformLines: string[] = [];
        for (const v of e.values) {
          // Trim: Ghidra value names sometimes carry a trailing space
          // ("UNITEVENTCALLBACK_MODECHANGE "), which made this cross-enum dedup
          // treat the same constant in two enums as distinct → both emitted →
          // "reference is ambiguous" (C++ ignores the trailing space).
          const vname = v.name.trim();
          if (emittedNames.has(vname)) continue;
          emittedNames.add(vname);
          const comment = v.comment ? ` // ${v.comment.replace(/\\n/g, ' ')}` : '';
          const line = `constexpr ${e.name} ${vname} = ${v.value};${comment}`;
          (isPlatformEnumValue(e.name, vname) ? platformLines : normalLines).push(line);
        }
        if (normalLines.length > 0 || platformLines.length > 0) {
          enumLines.push(`namespace ${e.name}_ns {`);
          enumLines.push(...normalLines);
          if (platformLines.length > 0) {
            enumLines.push('#ifndef _WIN32  // provided by <windows.h>/<winnt.h> on Windows');
            enumLines.push(...platformLines);
            enumLines.push('#endif');
          }
          enumLines.push('}');
          enumLines.push(`using namespace ${e.name}_ns;`);
        }
      }
      enumLines.push('');
    }
    files.set('d2_enums.h', {
      path: 'd2_enums.h',
      content: enumLines.join('\n'),
      type: 'header',
      functions: [],
      includes: [],
    });
    // Mark enum type names so individual headers skip emitting them
    context._sharedEnumTypes = new Set(enumTypes.map(e => e.name));
  }

  // Generate globals.h if we have analyzed globals with scope info
  const analyzedGlobals: AnalyzedDataSymbol[] = (globals as AnalyzedDataSymbol[]).filter(
    g => 'scope' in g
  );

  // Wire analyzed globals into context for static-local injection
  context.analyzedGlobals = analyzedGlobals;

  // Qualified names (namespace::name) of every emitted function. A data symbol
  // can share its name with a function in the same namespace (getter + backing
  // flag both named e.g. IsRecording); globals.h must not redeclare those.
  const functionQualifiedNames = new Set<string>();
  for (const f of functions) {
    functionQualifiedNames.add(f.namespace ? `${f.namespace}::${f.name}` : f.name);
  }

  // Check if we have target configuration
  const targetConfigs = options.projectConfig?.targets;
  const hasTargets = targetConfigs && Object.keys(targetConfigs).length > 0;

  if (hasTargets) {
    // Target-aware generation: partition functions into targets
    const resolution = resolveTargets(functions, namespaces, targetConfigs!);

    // Compute file-scoped statics BEFORE globals.h/cpp generation
    if (options.promoteStaticGlobals && analyzedGlobals.length > 0) {
      // Build func→implPath map for all targets
      const funcToImpl = new Map<string, string>();
      for (const [targetName, target] of resolution.targets) {
        if (target.config.type === 'interface') continue;
        const targetDir = getTargetDirectory(targetName);
        const targetMap = buildFuncToImplPathMap(target.functions, classes, namespaces, options, targetDir);
        for (const [k, v] of targetMap) funcToImpl.set(k, v);
      }
      if (resolution.unsorted.length > 0) {
        const unsortedMap = buildFuncToImplPathMap(resolution.unsorted, classes, namespaces, options, 'unsorted');
        for (const [k, v] of unsortedMap) funcToImpl.set(k, v);
      }
      computeFileLocalGlobals(analyzedGlobals, funcToImpl);
    }

    // Calculate globals path (needed for generateFilesForFunctions includes)
    const coreTarget = Object.entries(targetConfigs!).find(([, c]) => c.type === 'interface');
    const coreDir = coreTarget ? getTargetDirectory(coreTarget[0]) : '';
    const globalsPath = analyzedGlobals.length > 0
      ? (coreDir ? `${coreDir}/globals.h` : 'globals.h')
      : undefined;

    // Generate files per target (classification happens here)
    const mergedTypeOwnerMap = new Map<string, string>();
    for (const [targetName, target] of resolution.targets) {
      if (target.config.type === 'interface') continue; // Interface targets are header-only, handled above

      const targetDir = getTargetDirectory(targetName);
      const tom = generateFilesForFunctions(
        target.functions, classes, namespaces, dataTypes, globals,
        options, context, targetDir, files, sourceMaps, globalsPath
      );
      for (const [k, v] of tom) mergedTypeOwnerMap.set(k, v);

      // Generate stubs.h for cross-target deps
      const stubsContent = generateStubsHeader(target, resolution.targets);
      if (stubsContent) {
        files.set(`${targetDir}/stubs.h`, {
          path: `${targetDir}/stubs.h`,
          content: stubsContent,
          type: 'header',
          functions: [],
          includes: [],
        });
      }
    }

    // Generate unsorted
    if (resolution.unsorted.length > 0) {
      const tom = generateFilesForFunctions(
        resolution.unsorted, classes, namespaces, dataTypes, globals,
        options, context, 'unsorted', files, sourceMaps, globalsPath
      );
      for (const [k, v] of tom) mergedTypeOwnerMap.set(k, v);
    }

    // Generate globals.h/cpp AFTER classification (which happens in generateFilesForFunctions)
    if (analyzedGlobals.length > 0) {
      // Filter out struct-colocated globals (they go in struct headers/impls)
      const centralGlobals = analyzedGlobals.filter(
        g => g.scope !== 'struct-colocated'
      );

      if (centralGlobals.length > 0) {
        const globalsHeaderContent = generateGlobalsHeader(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        }, dataTypes, mergedTypeOwnerMap, functionQualifiedNames, context.bodyIdentifierFnCounts);

        files.set(globalsPath!, {
          path: globalsPath!,
          content: globalsHeaderContent,
          type: 'header',
          functions: [],
          includes: [],
        });

        // Generate globals.cpp with definitions
        const globalsImplPath = globalsPath!.replace(/\.h$/, options.format === 'c' ? '.c' : '.cpp');
        const globalsImplContent = generateGlobalsImpl(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        }, globalsPath!.split('/').pop());
        files.set(globalsImplPath, {
          path: globalsImplPath,
          content: globalsImplContent,
          type: 'implementation',
          functions: [],
          includes: [globalsPath!],
        });

        // Patch globals.cpp with extra includes for non-pointer struct types
        patchGlobalsExtraIncludes(files, globalsImplPath, centralGlobals, mergedTypeOwnerMap, globalsPath!);
      }
    }
  } else {
    // Non-target mode: existing flat generation

    // Compute file-scoped statics BEFORE globals.h/cpp generation
    if (options.promoteStaticGlobals && analyzedGlobals.length > 0) {
      const funcToImpl = buildFuncToImplPathMap(functions, classes, namespaces, options, '');
      computeFileLocalGlobals(analyzedGlobals, funcToImpl);
    }

    // Calculate globals path (needed for generateFilesForFunctions includes)
    const flatGlobalsPath = analyzedGlobals.length > 0 ? 'globals.h' : undefined;

    // Generate files (classification happens here)
    const flatTypeOwnerMap = generateFilesForFunctions(
      functions, classes, namespaces, dataTypes, globals,
      options, context, '', files, sourceMaps, flatGlobalsPath
    );

    // Generate globals.h/cpp AFTER classification
    if (analyzedGlobals.length > 0) {
      // Filter out struct-colocated globals (they go in struct headers/impls)
      const centralGlobals = analyzedGlobals.filter(
        g => g.scope !== 'struct-colocated'
      );

      if (centralGlobals.length > 0) {
        const globalsHeaderContent = generateGlobalsHeader(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        }, dataTypes, flatTypeOwnerMap, functionQualifiedNames, context.bodyIdentifierFnCounts);

        files.set('globals.h', {
          path: 'globals.h',
          content: globalsHeaderContent,
          type: 'header',
          functions: [],
          includes: [],
        });

        // Generate globals.cpp with definitions
        const implExt = options.format === 'c' ? '.c' : '.cpp';
        const globalsImplPath = `globals${implExt}`;
        const globalsImplContent = generateGlobalsImpl(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        });
        files.set(globalsImplPath, {
          path: globalsImplPath,
          content: globalsImplContent,
          type: 'implementation',
          functions: [],
          includes: ['globals.h'],
        });

        // Patch globals.cpp with extra includes for non-pointer struct types
        patchGlobalsExtraIncludes(files, globalsImplPath, centralGlobals, flatTypeOwnerMap, 'globals.h');
      }
    }
  }

  return {
    name,
    files,
    sourceMaps,
    dataTypes,
    globals,
    classes,
    namespaces,
    programInfo,
    buildInfo: context._buildInfo,
  };
}

/**
 * Compute extra includes for globals.cpp.
 * Non-pointer struct types used in global definitions need their defining header.
 */
function computeGlobalsExtraIncludes(
  globals: AnalyzedDataSymbol[],
  typeOwnerMap: Map<string, string>
): string[] {
  const includes = new Set<string>();
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const type = g.suggestedType || g.dataType;
    // Skip pointer types — forward declaration suffices
    if (type.includes('*') || type.includes('&')) continue;
    const stripped = stripTypeName(type);
    if (!stripped) continue;
    const ownerHeader = typeOwnerMap.get(stripped);
    if (ownerHeader && ownerHeader !== 'globals.h') {
      includes.add(ownerHeader);
    }
  }
  return [...includes].sort();
}

/**
 * Patch globals.cpp in the files map with extra includes for non-pointer struct types.
 */
function patchGlobalsExtraIncludes(
  files: Map<string, SourceFile>,
  globalsImplPath: string,
  centralGlobals: AnalyzedDataSymbol[],
  typeOwnerMap: Map<string, string>,
  globalsHeaderPath: string
): void {
  const globalsFile = files.get(globalsImplPath);
  if (!globalsFile) return;

  const extraIncludes = computeGlobalsExtraIncludes(centralGlobals, typeOwnerMap);
  if (extraIncludes.length === 0) return;

  const includeLines = extraIncludes.map(inc => `#include "${inc}"`).join('\n');
  const headerName = globalsHeaderPath.split('/').pop();
  globalsFile.content = globalsFile.content.replace(
    `#include "${headerName}"`,
    `#include "${headerName}"\n${includeLines}`
  );
  globalsFile.includes.push(...extraIncludes);
}

function normalizeHeaderPath(header: string): string {
  const normalized = header.replace(/\\/g, '/');
  if (normalized.endsWith('.h') || normalized.endsWith('.hpp')) return normalized;
  return normalized + '.h';
}

// =============================================================================
// Auto Method Conversion
// =============================================================================

/** Generic types that should never become `this` */
const GENERIC_TYPES = new Set([
  'void', 'int', 'uint', 'char', 'uchar', 'short', 'ushort', 'long', 'ulong',
  'DWORD', 'WORD', 'BYTE', 'BOOL', 'HANDLE', 'LPVOID', 'LPSTR', 'LPCSTR',
  'undefined', 'undefined1', 'undefined2', 'undefined4', 'undefined8',
  'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'float', 'double', 'longlong', 'ulonglong',
  // Win32 / CRT types that aren't real method targets
  'WCHAR', 'wchar_t', 'byte', 'FILE', 'POINT', 'RECT', 'HWND',
  'HINSTANCE', 'HDC', 'HBITMAP', 'HPALETTE', 'HMODULE',
  'LPCRITICAL_SECTION', 'CRITICAL_SECTION', 'LPPALETTEENTRY',
  'LPPOINT', 'LPRECT', 'float10', 'exception',
]);

/**
 * Resolve which module a function belongs to based on its namespace.
 * Extracts the first segment of the namespace (e.g. "D2Client::UI::Automap" → "D2Client")
 * and looks it up in the modules config.
 */
function resolveModuleForFunction(
  func: ExtractedFunction,
  modules: Record<string, ModuleConfig>
): string | null {
  if (!func.namespace) return null;
  const firstSegment = func.namespace.split('::')[0];
  for (const [moduleName, mod] of Object.entries(modules)) {
    if (mod.namespaces.some(ns => ns === firstSegment)) {
      return moduleName;
    }
  }
  return null;
}

/**
 * Resolve which module owns a struct based on typeOwnership entries.
 * Extracts the first path segment of the header (e.g. "D2Common/D2UnitStrc.h" → "D2Common").
 */
function resolveModuleForStruct(
  structName: string,
  typeOwnership: TypeOwnershipEntry[]
): string | null {
  const entry = typeOwnership.find(e => e.type === structName);
  if (!entry) return null;
  const firstSegment = entry.header.replace(/\\/g, '/').split('/')[0];
  return firstSegment || null;
}

/**
 * Detect functions eligible for auto method conversion.
 *
 * Criteria:
 * 1. param[0].dataType contains '*' (pointer)
 * 2. stripped type is a known STRUCTURE/UNION
 * 3. not a generic type
 * 4. no other param has the same struct pointer type (ambiguity)
 * 5. func.size <= maxFunctionSize
 * 6. func.name does not start with 'FUN_'
 * 7. not already in explicit registry
 * 8. not excluded by config
 * 9. not external, not a thunk
 * 10. same-module check passes
 */
export function detectAutoMethods(
  functions: ExtractedFunction[],
  dataTypes: ExtractedDataType[],
  registry: MethodConversionRegistry | null,
  config: { autoMethodConversion?: AutoMethodConversionConfig; modules?: Record<string, ModuleConfig>; typeOwnership?: TypeOwnershipEntry[] }
): MethodConversionEntry[] {
  const amc = config.autoMethodConversion;
  if (!amc?.enabled) return [];

  const maxSize = amc.maxFunctionSize ?? 512;
  const excludeAddrs = new Set((amc.excludeAddresses ?? []).map(a => normalizeAddress(a)));
  const excludePatterns = (amc.excludePatterns ?? []).map(p => new RegExp(p));
  const excludeClasses = new Set(amc.excludeClasses ?? []);
  const includeClasses = amc.includeClasses ? new Set(amc.includeClasses) : null;

  const knownStructs = new Set(
    dataTypes
      .filter(dt => dt.kind === 'STRUCTURE' || dt.kind === 'UNION')
      .map(dt => dt.name)
  );

  const modules = config.modules ?? {};
  const typeOwnership = config.typeOwnership ?? [];
  const entries: MethodConversionEntry[] = [];

  for (const func of functions) {
    // Criterion 9: not external/thunk
    if (func.isExternal || func.isThunk) continue;
    if (func.isLibrary) continue;

    // Criterion 6: no unnamed functions
    if (func.name.startsWith('FUN_')) continue;

    // Criterion 5: size filter
    if (func.size > maxSize) continue;

    // Must have params
    if (!func.parameters || func.parameters.length === 0) continue;

    const param0 = func.parameters[0];

    // Criterion 1: must be a pointer
    if (!param0.dataType.includes('*')) continue;

    const className = stripTypeName(param0.dataType);

    // Criterion 3: not a generic type
    if (!className || GENERIC_TYPES.has(className)) continue;

    // Criterion 2: known struct/union
    if (!knownStructs.has(className)) continue;

    // Criterion 8: config exclusions
    if (excludeAddrs.has(normalizeAddress(func.address))) continue;
    if (excludeClasses.has(className)) continue;
    if (includeClasses && !includeClasses.has(className)) continue;
    if (excludePatterns.some(p => p.test(func.name))) continue;

    // Criterion 7: not already in explicit registry
    if (registry && registry.has(func.address)) continue;

    // Skip functions that already have a `this` param (handled by buildAutoMethodMappings)
    if (func.parameters.some(p => p.name === 'this')) continue;

    // Criterion 4: no other param has the same struct pointer type
    const othersSameType = func.parameters.slice(1).some(p => {
      const stripped = stripTypeName(p.dataType);
      return stripped === className && p.dataType.includes('*');
    });
    if (othersSameType) continue;

    // Criterion 10: same-module check
    if (Object.keys(modules).length > 0) {
      const funcModule = resolveModuleForFunction(func, modules);
      const structModule = resolveModuleForStruct(className, typeOwnership);
      // If both are resolved and differ, skip (cross-module violation)
      if (funcModule && structModule && funcModule !== structModule) continue;
    }

    entries.push({
      address: func.address,
      className,
      methodName: func.name, // will be prefix-stripped later
      thisParam: 0,
    });
  }

  return entries;
}

/**
 * Strip common prefixes from auto-detected method names.
 *
 * Groups entries by className, finds the most common prefix (everything
 * before first '_', including '_'), and strips it if >50% share it.
 */
export function stripCommonPrefix(entries: MethodConversionEntry[]): void {
  // Group by className
  const byClass = new Map<string, MethodConversionEntry[]>();
  for (const entry of entries) {
    const group = byClass.get(entry.className) ?? [];
    group.push(entry);
    byClass.set(entry.className, group);
  }

  const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'return', 'void', 'int', 'class', 'struct', 'enum', 'union', 'const',
    'static', 'virtual', 'override', 'new', 'delete', 'this', 'true', 'false',
    'nullptr', 'NULL', 'default', 'throw', 'try', 'catch',
  ]);

  for (const [, group] of byClass) {
    if (group.length < 2) continue;

    // Extract prefixes (everything before first '_', including '_')
    const prefixCounts = new Map<string, number>();
    for (const entry of group) {
      const name = entry.methodName ?? '';
      const underscoreIdx = name.indexOf('_');
      if (underscoreIdx > 0) {
        const prefix = name.slice(0, underscoreIdx + 1);
        prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      }
    }

    // Find most common prefix
    let bestPrefix = '';
    let bestCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > bestCount) {
        bestCount = count;
        bestPrefix = prefix;
      }
    }

    // Only strip if >50% of methods share it
    if (bestCount <= group.length * 0.5) continue;

    for (const entry of group) {
      const name = entry.methodName ?? '';
      if (!name.startsWith(bestPrefix)) continue;

      const remainder = name.slice(bestPrefix.length);
      // Safety: don't strip if remainder is empty, starts with digit, or is a keyword
      if (!remainder) continue;
      if (/^\d/.test(remainder)) continue;
      if (KEYWORDS.has(remainder)) continue;

      entry.methodName = remainder;
    }
  }
}

function buildAutoMethodMappings(
  functions: ExtractedFunction[],
  dataTypes: ExtractedDataType[],
  methodConversions: ReturnType<typeof createMethodConversionRegistry>
): {
  mappings: Record<string, MethodCallMapping>;
  currentByAddress: Map<string, { className: string; thisParamName: string }>;
} {
  const mappings: Record<string, MethodCallMapping> = {};
  const currentByAddress = new Map<string, { className: string; thisParamName: string }>();

  const knownStructs = new Set(
    dataTypes
      .filter(dt => dt.kind === 'STRUCTURE' || dt.kind === 'UNION')
      .map(dt => dt.name)
  );

  const nameCounts = new Map<string, number>();
  for (const func of functions) {
    nameCounts.set(func.name, (nameCounts.get(func.name) ?? 0) + 1);
  }

  for (const func of functions) {
    if (!func.parameters || func.parameters.length === 0) continue;
    if (func.isExternal || func.isThunk) continue;
    if (methodConversions && methodConversions.has(func.address)) continue;

    const thisParamIndex = func.parameters.findIndex(p => p.name === 'this');
    if (thisParamIndex === -1) continue;

    const thisParam = func.parameters[thisParamIndex];
    const className = stripTypeName(thisParam.dataType);
    if (!className || !knownStructs.has(className)) continue;

    const mapping: MethodCallMapping = {
      className,
      methodName: func.name,
      thisParam: thisParamIndex,
      originalName: func.name,
    };

    if (func.namespace) {
      const qualified = `${func.namespace}::${func.name}`;
      mappings[qualified] = mappings[qualified] ?? mapping;
    }

    if ((nameCounts.get(func.name) ?? 0) === 1) {
      mappings[func.name] = mappings[func.name] ?? mapping;
    }

    currentByAddress.set(func.address, { className, thisParamName: thisParam.name });
  }

  return { mappings, currentByAddress };
}

/**
 * Build a map of function name → impl file path for file-scoped statics computation.
 * This maps functions to their output impl file based on namespace organization.
 */
function buildFuncToImplPathMap(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  namespaces: ExtractedNamespace[],
  options: ReconstructOptions,
  dirPrefix: string
): Map<string, string> {
  const organized = organizeByNamespace(functions, classes, namespaces);
  const implExt = options.format === 'c' ? '.c' : '.cpp';

  // First compute header paths and fix collisions (same logic as generateFilesForFunctions)
  const headerPaths = new Map<string, string>();
  for (const [unitName] of organized) {
    let headerPath = getFilePath(unitName, 'header', options);
    if (dirPrefix) headerPath = `${dirPrefix}/${headerPath}`;
    headerPaths.set(unitName, headerPath);
  }
  // Build func → impl path map
  const funcNameToImplPath = new Map<string, string>();
  for (const [unitName, unitFunctions] of organized) {
    const implPath = headerPaths.get(unitName)!.replace(/\.h$/, implExt);
    for (const func of unitFunctions) {
      funcNameToImplPath.set(func.name, implPath);
      if (func.namespace) {
        funcNameToImplPath.set(`${func.namespace}::${func.name}`, implPath);
      }
    }
  }

  return funcNameToImplPath;
}

/**
 * Rescope globals to 'file-local' when all referencing functions live in the same impl file.
 * Mutates the scope and ownerFile fields of the analyzed globals.
 */
function computeFileLocalGlobals(
  analyzedGlobals: AnalyzedDataSymbol[],
  funcNameToImplPath: Map<string, string>
): void {
  for (const g of analyzedGlobals) {
    if (g.scope !== 'global') continue;
    if (!g.referencingFunctions || g.referencingFunctions.length === 0) continue;

    // Skip file-local promotion for namespaced globals — a namespace indicates
    // the symbol is part of that subsystem's interface, not an internal detail
    if (g.namespace) continue;

    let targetFile: string | undefined;
    let allSameFile = true;
    for (const funcName of g.referencingFunctions) {
      const implPath = funcNameToImplPath.get(funcName);
      if (!implPath) {
        allSameFile = false;
        break;
      }
      if (targetFile === undefined) {
        targetFile = implPath;
      } else if (implPath !== targetFile) {
        allSameFile = false;
        break;
      }
    }

    if (allSameFile && targetFile) {
      g.scope = 'file-local';
      g.ownerFile = targetFile;
    }
  }
}

/**
 * Build a bitfield catalog from struct metadata.
 * Scans all structs for bitfield fields (dataType matches `:N$`) and builds
 * a global map: "field_0xNN:mask" → bitfieldName.
 *
 * The catalog is keyed only by (byte offset, mask) — NOT by struct — because the
 * bitfield-access transform runs on parsed function bodies where the base
 * expression (`pSkillTxt->field_0x5`) carries no resolved struct type, so the
 * transform cannot know which struct a `field_0xNN` access belongs to.
 *
 * To prevent cross-struct contamination (e.g. rewriting `D2SkillsTxt->field_0x5
 * & 0x10` to `->soft` when `soft` is a bitfield of an UNRELATED struct and
 * `D2SkillsTxt` merely has a plain/undefined byte at offset 0x5), a key is
 * emitted only when it is unambiguously safe across the whole program:
 *  - dropped if two structs map the same key to different names (collision), and
 *  - dropped if ANY struct has a NON-bitfield field occupying that byte offset
 *    (because the accessor `field_0xNN` would also be emitted there, and the
 *    rewrite would be wrong for that struct).
 */
export function buildBitfieldCatalog(dataTypes: ExtractedDataType[]): Map<string, string> {
  const catalog = new Map<string, string>();
  const conflicts = new Set<string>();

  // Byte offsets that some struct occupies with a NON-bitfield field. Applying a
  // `field_0xNN & mask` rewrite at such an offset would be wrong for that struct.
  const nonBitfieldByteOffsets = new Set<number>();

  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE') continue;
    const struct = dt as ExtractedStruct;
    if (!Array.isArray(struct.fields)) continue;

    // First pass: record every byte covered by a non-bitfield field in this struct.
    for (const f of struct.fields) {
      const isBitfield = (f.dataType ?? '').trim().match(/^(.+?):(\d+)$/) !== null;
      if (isBitfield) continue;
      const span = f.size > 0 ? f.size : 1;
      for (let b = 0; b < span; b++) {
        nonBitfieldByteOffsets.add(f.offset + b);
      }
    }

    let i = 0;
    while (i < struct.fields.length) {
      const field = struct.fields[i];
      const bfMatch = (field.dataType ?? '').trim().match(/^(.+?):(\d+)$/);
      if (!bfMatch) { i++; continue; }

      // Found start of a bitfield group — collect all consecutive bitfields at overlapping offsets
      const baseOffset = field.offset;
      const groupStart = i;
      while (i < struct.fields.length) {
        const f = struct.fields[i];
        const m = (f.dataType ?? '').trim().match(/^(.+?):(\d+)$/);
        if (!m || f.offset >= baseOffset + 4) break;
        i++;
      }

      // Process each bitfield in the group
      let bitPosition = 0;
      let currentByteOffset = struct.fields[groupStart].offset;
      for (let j = groupStart; j < i; j++) {
        const bf = struct.fields[j];
        const m = (bf.dataType ?? '').trim().match(/^(.+?):(\d+)$/)!;
        const bitWidth = parseInt(m[2], 10);

        // If offset changed, reset bit position within this byte
        if (bf.offset !== currentByteOffset) {
          bitPosition = 0;
          currentByteOffset = bf.offset;
        }

        // Only map single-bit fields with meaningful names
        if (bitWidth === 1 && bf.name && !bf.name.startsWith('_bf_')) {
          const mask = 1 << bitPosition;
          const hexOffset = `0x${bf.offset.toString(16)}`;
          const fieldAccessor = `field_${hexOffset}`;
          const key = `${fieldAccessor}:${mask}`;

          if (conflicts.has(key)) {
            // Already known conflict
          } else if (catalog.has(key) && catalog.get(key) !== bf.name) {
            // Collision: two different structs map the same key to different names
            conflicts.add(key);
            catalog.delete(key);
          } else {
            catalog.set(key, bf.name);
          }
        }

        bitPosition += bitWidth;
      }
    }
  }

  // Drop any key whose byte offset is occupied by a non-bitfield field in some
  // struct — the rewrite would contaminate that struct's plain-byte access.
  let ambiguityDrops = 0;
  for (const key of [...catalog.keys()]) {
    const offMatch = key.match(/^field_0x([0-9a-fA-F]+):/);
    if (!offMatch) continue;
    const byteOffset = parseInt(offMatch[1], 16);
    if (nonBitfieldByteOffsets.has(byteOffset)) {
      catalog.delete(key);
      ambiguityDrops++;
    }
  }
  if (ambiguityDrops > 0) {
    console.log(`Bitfield catalog: dropped ${ambiguityDrops} entr${ambiguityDrops === 1 ? 'y' : 'ies'} whose byte offset collides with a non-bitfield field in another struct (anti-contamination)`);
  }

  return catalog;
}

function generateFilesForFunctions(
  functions: ExtractedFunction[],
  classes: DetectedClass[],
  namespaces: ExtractedNamespace[],
  dataTypes: ExtractedDataType[],
  globals: AnalyzedDataSymbol[] | ExtractedGlobal[],
  options: ReconstructOptions,
  context: ImplGenContext,
  dirPrefix: string,
  files: Map<string, SourceFile>,
  sourceMaps: Map<string, SourceMap>,
  globalsHeaderPath?: string
): Map<string, string> {
  const organized = organizeByNamespace(functions, classes, namespaces);

  const typeOwnershipOverrides = new Map<string, string>();
  const ownershipEntries = options.projectConfig?.typeOwnership ?? [];
  for (const entry of ownershipEntries) {
    if (!entry.type || !entry.header) continue;
    typeOwnershipOverrides.set(entry.type, normalizeHeaderPath(entry.header));
  }

  // Pre-compute header paths for each unit
  const unitHeaderPaths = new Map<string, string>();
  for (const [unitName, unitFunctions] of organized) {
    let effectiveUnitName = unitName;
    if (!unitName.includes('::') && unitFunctions.length > 0) {
      const allMethods = unitFunctions.every(f => f.parentClass === unitName);
      if (allMethods && unitFunctions[0].namespace) {
        effectiveUnitName = `${unitFunctions[0].namespace}::${unitName}`;
      }
    }

    let headerPath = getFilePath(effectiveUnitName, 'header', options);
    if (dirPrefix) headerPath = `${dirPrefix}/${headerPath}`;
    unitHeaderPaths.set(unitName, headerPath);
  }

  // Apply typeOwnership overrides to unitHeaderPaths BEFORE scoring
  for (const [typeName, headerPath] of typeOwnershipOverrides) {
    if (unitHeaderPaths.has(typeName)) {
      unitHeaderPaths.set(typeName, headerPath);
    }
  }

  // ── Pass 1: Assign type ownership (via modules/type-ownership.ts) ──
  const analyzedGlobals = (globals as AnalyzedDataSymbol[]).filter(g => 'scope' in g);
  const { typeOwnerMap, structsWithOwnUnit, extraHeaderTypes } = computeTypeOwnership({
    organized,
    classes,
    dataTypes,
    globals: analyzedGlobals,
    unitHeaderPaths,
    typeOwnershipOverrides,
    sharedEnumTypes: context._sharedEnumTypes,
  });
  // ── Pass 1b: Function cross-include + visibility analysis ──────────
  // Map each function name to the header that declares it.
  // When Mac and Windows both define a function with the same name (e.g. SFILE_HashString),
  // prefer the Windows definition so Windows callers don't get pointed to Mac-only headers.
  const funcNameToHeaderPath = new Map<string, string>();
  const platformHeaders = new Set<string>(); // headers that contain ONLY platform-guarded functions
  for (const [unitName, unitFunctions] of organized) {
    const headerPath = unitHeaderPaths.get(unitName)!;
    const allPlatformGuarded = unitFunctions.length > 0 && unitFunctions.every(f => f.ifdef);
    if (allPlatformGuarded) {
      platformHeaders.add(headerPath);
    }
    for (const func of unitFunctions) {
      // Don't let platform-guarded functions overwrite non-guarded entries
      if (func.ifdef && funcNameToHeaderPath.has(func.name)) {
        continue;
      }
      funcNameToHeaderPath.set(func.name, headerPath);
    }
  }

  // ── Pass 1c: Cross-platform match detection ──────────────────────────
  // Build per-unit cross-platform match maps: when a Mac function has
  // the same name as a Windows function (or vice-versa), record the link.
  type FuncInfo = { address: string; implPath: string; ifdef?: string };
  const allFuncsByName = new Map<string, FuncInfo[]>();
  for (const [unitName, unitFunctions] of organized) {
    const implExt = options.format === 'c' ? '.c' : '.cpp';
    const implPath = unitHeaderPaths.get(unitName)!.replace(/\.h$/, implExt);
    for (const func of unitFunctions) {
      if (func.isExternal || func.isThunk) continue;
      if (!allFuncsByName.has(func.name)) {
        allFuncsByName.set(func.name, []);
      }
      allFuncsByName.get(func.name)!.push({
        address: func.address,
        implPath,
        ifdef: func.ifdef,
      });
    }
  }
  // For each function name with entries in BOTH platform and non-platform units,
  // create cross-platform match records
  const crossPlatformMatchesByUnit = new Map<string, Map<string, import('../types.js').CrossPlatformMatch>>();
  for (const [funcName, infos] of allFuncsByName) {
    if (infos.length < 2) continue;
    const platformInfos = infos.filter(i => i.ifdef);
    const nativeInfos = infos.filter(i => !i.ifdef);
    if (platformInfos.length === 0 || nativeInfos.length === 0) continue;
    // Link platform → native
    for (const pInfo of platformInfos) {
      const nInfo = nativeInfos[0];
      if (!crossPlatformMatchesByUnit.has(pInfo.implPath)) {
        crossPlatformMatchesByUnit.set(pInfo.implPath, new Map());
      }
      crossPlatformMatchesByUnit.get(pInfo.implPath)!.set(funcName, {
        name: funcName,
        address: nInfo.address,
        file: nInfo.implPath,
        platform: 'win',
      });
    }
    // Link native → platform
    for (const nInfo of nativeInfos) {
      const pInfo = platformInfos[0];
      if (!crossPlatformMatchesByUnit.has(nInfo.implPath)) {
        crossPlatformMatchesByUnit.set(nInfo.implPath, new Map());
      }
      crossPlatformMatchesByUnit.get(nInfo.implPath)!.set(funcName, {
        name: funcName,
        address: pInfo.address,
        file: pInfo.implPath,
        platform: 'mac',
      });
    }
  }

  // Compute which functions in each unit are called from other units (externally visible)
  const publicFunctionsPerHeader = new Map<string, Set<string>>(); // headerPath → Set<funcName>
  for (const [unitName, unitFunctions] of organized) {
    const headerPath = unitHeaderPaths.get(unitName)!;
    for (const func of unitFunctions) {
      for (const callee of func.calledFunctions ?? []) {
        const calleeHeader = funcNameToHeaderPath.get(callee);
        if (calleeHeader && calleeHeader !== headerPath) {
          // callee is in a different unit — mark it as public in its own unit
          if (!publicFunctionsPerHeader.has(calleeHeader)) {
            publicFunctionsPerHeader.set(calleeHeader, new Set());
          }
          publicFunctionsPerHeader.get(calleeHeader)!.add(callee);
        }
      }
    }
  }

  // Build set of class names for correct forward declaration keywords (class vs struct)
  const allClassNames = new Set(classes.map(c => c.name));

  // Build type kind lookup for fast classification in include decisions
  const dataTypeKindMap = new Map<string, string>();
  const structUnionEnumNames = new Set<string>();
  for (const dt of dataTypes) {
    dataTypeKindMap.set(dt.name, dt.kind);
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION' || dt.kind === 'ENUM') {
      structUnionEnumNames.add(dt.name);
    }
  }

  // Pass func name → header map into context for func-ptr-literal include resolution
  if (context.functionAddressMap) {
    context.functionNameToHeader = funcNameToHeaderPath;
  }

  // Build the set of all namespace paths so body-qualifier stripping can avoid
  // creating ambiguous references (e.g. shortening D2Common::Path::DynamicPath::Fn
  // to Path::DynamicPath::Fn when a sibling D2Common::Unit::Path also exists).
  const knownNamespaces = new Set<string>();
  const registerNamespacePath = (full: string | undefined) => {
    if (!full) return;
    const segs = full.split('::').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      knownNamespaces.add(segs.slice(0, i).join('::'));
    }
  };
  for (const ns of namespaces) registerNamespacePath(ns.fullPath ?? ns.name);
  for (const func of functions) registerNamespacePath(func.namespace);
  context.knownNamespaces = knownNamespaces;

  // ── Build module graph for include resolution ────────────────────────
  const moduleGraph = buildModuleGraph({
    organized,
    classes,
    dataTypes,
    globals: analyzedGlobals,
    unitHeaderPaths,
    ownership: { typeOwnerMap, structsWithOwnUnit, extraHeaderTypes },
    options,
    funcNameToHeaderPath,
    platformHeaders,
    sharedEnumTypes: context._sharedEnumTypes,
    globalsHeaderPath,
  });
  const resolvedModules = moduleGraph.resolve();

  // Compute symbol hashes and serialize buildinfo for incremental rebuilds
  const symbolHashes: Record<string, string> = {};
  for (const func of functions) {
    symbolHashes[func.name] = hashFunction(func);
  }
  for (const dt of dataTypes) {
    symbolHashes[dt.name] = hashDataType(dt);
  }
  for (const g of analyzedGlobals) {
    symbolHashes[g.name] = hashGlobal(g);
  }
  context._buildInfo = moduleGraph.serialize(resolvedModules, symbolHashes, '1.0.0');

  // ── Pass 2: Generate files using graph-resolved includes ──────────
  for (const [unitName, unitFunctions] of organized) {
    const namespace = namespaces.find(ns => ns.name === unitName);
    const classInfo = classes.find(cls => cls.name === unitName);

    const headerPath = unitHeaderPaths.get(unitName)!;
    const implExt = options.format === 'c' ? '.c' : '.cpp';
    let implPath = headerPath.replace(/\.h$/, implExt);

    // Get graph-resolved includes for this module
    const resolved = resolvedModules.get(headerPath);
    const sortedTypeIncludes = resolved?.headerIncludes ?? [];
    const sortedAllIncludes = resolved
      ? [...new Set([...resolved.headerIncludes, ...resolved.implIncludes])].sort()
      : [];
    const crtHeaders = resolved ? new Set(resolved.crtHeaders) : collectCrtHeaders([]);

    // Compute owned types for this header
    const ownedTypeNames = new Set<string>();
    for (const [typeName, ownerPath] of typeOwnerMap) {
      if (ownerPath !== headerPath) continue;
      if (structsWithOwnUnit.has(typeName) && typeName !== unitName) continue;
      ownedTypeNames.add(typeName);
    }

    // Compute types already fully defined via header includes
    const includedTypeNames = new Set<string>();
    for (const [typeName, ownerPath] of typeOwnerMap) {
      if (resolved?.headerIncludes.includes(ownerPath)) {
        includedTypeNames.add(typeName);
      }
    }

    // Generate header — no funcIncludes to avoid circular include chains
    const headerContent = generateHeader(
      unitName,
      unitFunctions,
      classInfo,
      dataTypes,
      globals,
      options,
      context.methodConversions,
      sortedTypeIncludes,
      ownedTypeNames,
      undefined,  // no publicFunctions filter — declare all functions
      allClassNames,
      includedTypeNames,
      headerPath,
      undefined,  // no funcIncludes
      functions,  // allFunctions for cross-module method lookup
      classes     // allClasses so cross-namespace method structs get method declarations
    );

    files.set(headerPath, {
      path: headerPath,
      content: headerContent,
      type: 'header',
      namespace: namespace?.fullPath,
      className: classInfo?.name,
      functions: unitFunctions.map(f => f.name),
      includes: sortedAllIncludes,
    });

    // Generate implementation (impl includes own header + cross-file headers + globals)
    // Reset preamble accumulator per output file to avoid cross-file leakage.
    const implIncludes = globalsHeaderPath
      ? [globalsHeaderPath, ...sortedAllIncludes]
      : sortedAllIncludes;
    const prevPreambles = context._preambles;
    context._preambles = new Set();

    // Inject file-local globals for this specific impl file
    const prevFileLocals = context.fileLocalGlobals;
    if (context.analyzedGlobals) {
      context.fileLocalGlobals = context.analyzedGlobals.filter(
        g => g.scope === 'file-local' && g.ownerFile === implPath
      );
      if (context.fileLocalGlobals.length === 0) {
        context.fileLocalGlobals = undefined;
      }
    }

    let implContent = generateImplementation(
      unitName,
      unitFunctions,
      classInfo,
      headerPath,
      options,
      context,
      implIncludes,
      crtHeaders,
      undefined,  // no internalFunctions — don't apply static to standalone functions
      structUnionEnumNames
    );
    context.fileLocalGlobals = prevFileLocals;
    context._preambles = prevPreambles;

    // Body dep feedback: scan generated impl for type/function references not yet included
    {
      const existingIncludes = new Set(implIncludes);
      existingIncludes.add(headerPath);
      const newIncludes: string[] = [];

      // Scan for function references from func-ptr-literal plugin
      if (context.functionAddressMap && context.functionNameToHeader) {
        for (const [, funcName] of context.functionAddressMap) {
          if (implContent.includes(funcName)) {
            const funcHeader = context.functionNameToHeader.get(funcName);
            if (funcHeader && !existingIncludes.has(funcHeader)) {
              existingIncludes.add(funcHeader);
              newIncludes.push(funcHeader);
            }
          }
        }
      }

      // Scan for type references in bodies (casts, local vars, etc.)
      for (const [typeName, ownerPath] of typeOwnerMap) {
        if (existingIncludes.has(ownerPath)) continue;
        if (ownerPath === headerPath) continue;
        // Quick word-boundary check to avoid substring false positives
        if (implContent.includes(typeName)) {
          const re = new RegExp(`\\b${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          if (re.test(implContent)) {
            existingIncludes.add(ownerPath);
            newIncludes.push(ownerPath);
          }
        }
      }

      if (newIncludes.length > 0) {
        const includeLines = newIncludes.sort().map(h => `#include "${h}"`).join('\n');
        const lastIncludeIdx = implContent.lastIndexOf('#include');
        const lineEnd = implContent.indexOf('\n', lastIncludeIdx);
        implContent = implContent.slice(0, lineEnd + 1) + includeLines + '\n' + implContent.slice(lineEnd + 1);
      }
    }

    // Append co-located global definitions to struct .cpp files
    const implColocatedGlobals = analyzedGlobals.filter(g =>
      g.scope === 'struct-colocated' &&
      g.ownerStructHeader === headerPath
    );

    if (implColocatedGlobals.length > 0) {
      const globalsDefSection = generateColocatedGlobalsImpl(
        implColocatedGlobals,
        options
      );
      implContent = implContent + '\n\n' + globalsDefSection;
    }

    files.set(implPath, {
      path: implPath,
      content: implContent,
      type: 'implementation',
      namespace: namespace?.fullPath,
      className: classInfo?.name,
      functions: unitFunctions.map(f => f.name),
      includes: [headerPath, ...sortedAllIncludes],
    });

    // Generate source map if requested
    if (options.generateSourceMaps) {
      const mapPath = `${implPath}.map`;
      const crossMatches = crossPlatformMatchesByUnit.get(implPath);
      const sourceMap = generateSourceMap(implPath, unitFunctions, undefined, crossMatches);
      sourceMaps.set(mapPath, sourceMap);
    }
  }

  // ── Pass 3: Generate type-only headers (if any) ────────────────────
  for (const [headerPath, ownedTypeNames] of extraHeaderTypes) {
    const ownedTypes = new Set<string>(ownedTypeNames);
    const guardBase = headerPath.replace(/\\/g, '/').replace(/\.[^/.]+$/, '');

    // Use graph-resolved includes for type-only headers
    const resolved = resolvedModules.get(headerPath);
    const sortedIncludes = resolved?.headerIncludes ?? [];

    // Compute types already fully defined via cross-includes
    const includedTypeNames = new Set<string>();
    for (const [typeName, ownerPath] of typeOwnerMap) {
      if (sortedIncludes.includes(ownerPath)) {
        includedTypeNames.add(typeName);
      }
    }

    const headerContent = generateHeader(
      guardBase,
      [],
      undefined,
      dataTypes,
      globals,
      options,
      context.methodConversions,
      sortedIncludes,
      ownedTypes,
      undefined,
      undefined,
      includedTypeNames,
      headerPath,
      undefined,  // no funcIncludes
      functions,  // allFunctions for cross-module method lookup
      classes     // allClasses so cross-namespace method structs get method declarations
    );

    files.set(headerPath, {
      path: headerPath,
      content: headerContent,
      type: 'header',
      functions: [],
      includes: sortedIncludes,
    });
  }

  return typeOwnerMap;
}

/**
 * Write a reconstructed project to disk
 */
export async function writeProject(
  project: ReconstructedProject,
  outputDir: string,
  options: ReconstructOptions
): Promise<string[]> {
  const writtenFiles: string[] = [];

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  // Resolve override placeholders (reads source files from projectDir, not outputDir)
  const projectDir = options.projectDir ?? outputDir;
  const overrideRegistry = createOverrideRegistry(options.projectConfig, projectDir);
  if (overrideRegistry) {
    for (const [, file] of project.files) {
      if (file.content.includes('[OVERRIDE:REPLACE]')) {
        const resolved = await resolveOverridePlaceholders(file.content, overrideRegistry);
        file.content = resolved.code;
      }
    }
  }

  // Write all source files
  for (const [filePath, file] of project.files) {
    const fullPath = path.join(outputDir, filePath);
    const dir = path.dirname(fullPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
    writtenFiles.push(fullPath);
  }

  // Write source maps
  for (const [mapPath, sourceMap] of project.sourceMaps) {
    const fullPath = path.join(outputDir, mapPath);
    await fs.writeFile(fullPath, JSON.stringify(sourceMap, null, 2), 'utf-8');
    writtenFiles.push(fullPath);
  }

  // Generate CMakeLists.txt if requested
  if (options.generateCMake) {
    const targetConfigs = options.projectConfig?.targets;
    const hasTargets = targetConfigs && Object.keys(targetConfigs).length > 0;

    if (hasTargets) {
      // Build resolved targets for CMake generation
      // We create lightweight ResolvedTarget objects from config + file paths
      const resolvedTargets = new Map<string, ResolvedTarget>();
      for (const [targetName, config] of Object.entries(targetConfigs!)) {
        resolvedTargets.set(targetName, {
          name: targetName,
          config,
          functions: [], // Functions already emitted; CMake only needs file paths
          externalDeps: new Map(),
        });
      }

      // Top-level CMakeLists.txt
      const hasUnsorted = [...project.files.keys()].some(p => p.startsWith('unsorted/'));
      const topCmake = generateTopLevelCMake(project, resolvedTargets, hasUnsorted, options);
      const topCmakePath = path.join(outputDir, 'CMakeLists.txt');
      await fs.writeFile(topCmakePath, topCmake, 'utf-8');
      writtenFiles.push(topCmakePath);

      // Per-target CMakeLists.txt
      for (const [targetName, target] of resolvedTargets) {
        const targetDir = getTargetDirectory(targetName);
        const cmakeContent = generateTargetCMake(target, targetDir, project.files, options);
        const cmakePath = path.join(outputDir, targetDir, 'CMakeLists.txt');
        await fs.mkdir(path.dirname(cmakePath), { recursive: true });
        await fs.writeFile(cmakePath, cmakeContent, 'utf-8');
        writtenFiles.push(cmakePath);
      }

      // Unsorted CMakeLists.txt
      if (hasUnsorted) {
        const unsortedCmake = generateUnsortedCMake(project.files, options);
        const unsortedPath = path.join(outputDir, 'unsorted', 'CMakeLists.txt');
        await fs.mkdir(path.dirname(unsortedPath), { recursive: true });
        await fs.writeFile(unsortedPath, unsortedCmake, 'utf-8');
        writtenFiles.push(unsortedPath);
      }
    } else {
      // Non-target: single CMakeLists.txt
      const cmakePath = path.join(outputDir, 'CMakeLists.txt');
      const cmakeContent = generateCMakeLists(project, options);
      await fs.writeFile(cmakePath, cmakeContent, 'utf-8');
      writtenFiles.push(cmakePath);
    }
  }

  // Always generate README.md
  const readmePath = path.join(outputDir, 'README.md');
  const readmeContent = generateReadme(project, options);
  await fs.writeFile(readmePath, readmeContent, 'utf-8');
  writtenFiles.push(readmePath);

  // Prune stale generated files: remove .cpp/.h/.map/CMakeLists left over from a
  // previous run that this run did not (re)write — e.g. a namespace that moved
  // modules, or a module that became excluded. Keeps the output tree in sync
  // with the current generation instead of accumulating leftovers.
  try {
    const keep = new Set(writtenFiles.map(p => path.resolve(p)));
    const PRUNE = /(\.(cpp|cc|c|h|hpp)$|\.map$|(^|[\\/])CMakeLists\.txt$)/;
    const entries = await fs.readdir(outputDir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = path.resolve((e as { parentPath?: string; path?: string }).parentPath ?? e.path ?? outputDir, e.name);
      const rel = path.relative(outputDir, abs);
      if (!PRUNE.test(rel)) continue;
      if (!keep.has(abs)) await fs.unlink(abs).catch(() => {});
    }
    // Remove directories left empty by the prune (deepest first).
    const dirs = (await fs.readdir(outputDir, { recursive: true, withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => path.resolve((e as { parentPath?: string; path?: string }).parentPath ?? e.path ?? outputDir, e.name))
      .sort((a, b) => b.length - a.length);
    for (const d of dirs) await fs.rmdir(d).catch(() => {});
  } catch { /* best-effort prune */ }

  return writtenFiles;
}

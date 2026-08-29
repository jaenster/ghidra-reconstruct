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
  DataValue,
} from '../types.js';
import { resolveOverridePlaceholders } from './impl.js';
import { VOID_POINTER_SLOT, type FuncPtrTarget } from '@ghidra-mcp/cpp-parser';

import { emittedFieldType, emittedMemberNames, generateHeader, generateFunctionDeclaration, setKnownFuncDefs, sigType } from './header.js';
import { generateImplementation, setQuestStructLayouts, setStructFieldRenames, decompiledReturnType, decompiledFunctionName, type ImplGenContext, type FuncPtrArgCastTables } from './impl.js';
import { generateCMakeLists, generateTopLevelCMake, generateTargetCMake, generateUnsortedCMake } from './cmake.js';
import { generateSourceMap } from './sourcemap.js';
import { generateReadme } from './readme.js';
import { organizeByNamespace, getFilePath, setModuleNames, setNamespaceCollisionTypes, normalizeQualifiedReference } from './namespace.js';
import { buildNamespaceResolution, namespaceResolution, renderNamespace } from './namespace-resolution.js';
import { resetDeclaredNames, recordDeclaredName, setDeclarationClosureModel, setDeclarationClosureEmitters, getDeclarationClosureReport, isUnreferenceableArtifact, sanitizeSymbolName, sanitizeQualifiedReference, setCentralInitializerScope, promoteCentrallyReferencedGlobals, generateGlobalsHeader, generateGlobalsImpl, generateColocatedGlobalsImpl, setKnownFuncDefTypedefs, setKnownEnumConstants, getKnownEnumConstants, setMultidimArrayGlobals, setGlobalInitializerTypes, reconcileOrphanedGlobals, markGlobalsClaimed, setKnownNamespaces, isFuncDefTypedefName, reportGlobalsTakingATypeName, resolveListingBuiltinBlobs, setInitializerSignatureTables, getInitializerFuncPtrArityMismatches, normalizeGlobalDeclType } from './globals-header.js';
import { isPlatformOrBuiltinType, isLibraryType, generatePlatformHeader, normalizeSignatureType, collapseFuncPtrTypedef, setShadowedTypeNames, setAggregateTypeNames, setDeclaredTypeNames, isVoidPointerSpelling, platformDeclaredFunctionNames, EMITTER_POINTER_TYPEDEFS } from './platform-types.js';
import { createOverrideRegistry } from '../overrides/index.js';
import { createLibraryRegistry } from '../library/index.js';
import { createMethodConversionRegistry, getOrCreateRegistry, applyMethodConversions, detectMethodConversionsFromTags, type MethodCallMapping, type MethodConversionRegistry } from '../methods/index.js';
import type { MethodConversionEntry, ModuleConfig, AutoMethodConversionConfig, TypeOwnershipEntry } from '../config/schema.js';
import { normalizeAddress } from '../config/loader.js';
import { resolveTargets, getTargetDirectory, type ResolvedTarget } from '../targets/index.js';
import { generateStubsHeader } from '../targets/stubs.js';
import { collectCrtHeaders, EXCLUDED_SYMBOL_DECLS, WIN32_ZERO_ARITY_CALLBACK_SLOTS } from './crt-mapping.js';
import { normalizePointerSizeSpellings } from './pointer-size-spelling.js';
import { flattenTemplateNames } from './template-names.js';
import { retypeVtableLocals, vtableMembersByType } from '../modules/vtable-types.js';
import { NeedleIndex } from './needle-index.js';
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

  // Ghidra's explicit pointer-size spelling (`D2DataArrayStrc *32`) is understood
  // by nothing downstream — it defeats type-name stripping, so the type is never
  // included and never declared. Normalize it to `*` across the WHOLE model
  // before anything is emitted.
  {
    const rewritten = normalizePointerSizeSpellings(
      dataTypes,
      functions,
      globals as Array<{ dataType?: string; suggestedType?: string }>,
    );
    if (rewritten > 0) {
      console.log(`Normalized ${rewritten} Ghidra pointer-size type spellings (T *32 -> T *)`);
    }
  }

  // Flatten Ghidra's demangled template spellings (`TSHashTable<struct_CELLIST,
  // class_HASHKEY_NONE>`) across the WHOLE model before anything is emitted, so
  // the declaration side and every reference side share one identifier.
  flattenTemplateNames(dataTypes, functions, globals as Array<{ name?: string; dataType?: string; suggestedType?: string; suggestedName?: string; namespace?: string | null }>);

  // Ghidra types a body's vtable LOCALS with the bare `vtable *`, which can only
  // be rendered `void *` — so `pListHead->FUN_004503f0` is a member access on
  // void. The per-class vtable STRUCTUREs have already been named after their
  // owner; the member a body indexes says which of them the local holds.
  {
    const retyped = retypeVtableLocals(functions, vtableMembersByType(dataTypes));
    if (retyped > 0) {
      console.log(`Pointed ${retyped} vtable locals/parameters at the vtable they index`);
    }
  }

  // A function's return type comes from the raw database field, but its BODY
  // comes from the decompiler's own resolved prototype. When nobody has curated
  // the field it reads `undefined` — normalised to `uint8_t` — while the body is
  // the decompiler's `void` one, full of bare `return;` statements, and the
  // emitted function cannot compile. Where the database has nothing to say,
  // take the answer from the same prototype the body came from. A curated field
  // always wins: `undefined` is the only case where there is nothing to override.
  reconcileUndefinedReturnTypes(functions);

  // Register every function-pointer typedef name (FUNCTION_DEFINITION datatypes)
  // so stripFuncDefIndirection / struct-field stripping recognise all-caps and
  // irregular fnptr typedefs (QUESTCALLBACK, ...), not just naming conventions.
  // Must run before any header/globals/impl emission below.
  const funcDefDataTypes = dataTypes.filter(
    dt => dt.kind === 'FUNCTION_DEFINITION'
  ) as import('../types.js').ExtractedFunctionDefinition[];
  setKnownFuncDefTypedefs(funcDefDataTypes.map(dt => dt.name));
  // Which type names have members at all, resolved through Ghidra's typedef
  // chain. `struct-field` asks this before turning `*(T*)(base + off)` into
  // `((T*)base)->field_off`; without it a Win32 pointer typedef looked like a
  // struct and got a member nothing declares.
  setAggregateTypeNames(dataTypes as Array<{ name: string; kind?: string; underlyingType?: string }>);
  // Every declared type name, so no variable is emitted under a name that
  // already denotes a type in the scope it lands in.
  setDeclaredTypeNames(dataTypes.map(dt => dt.name).filter(Boolean));
  // A `case` label must be a constant expression. `switch-reconstruct` treated
  // any bare identifier as one ("could be an enum constant"), which turned an
  // if/else chain over D2ControlStrc* globals into `switch (p) { case gGlobal: }`.
  // Give it the enumerator names so the guess becomes a lookup.
  setKnownEnumConstants(
    (dataTypes.filter(dt => dt.kind === 'ENUM') as import('../types.js').ExtractedEnum[])
      .flatMap(e => e.values.map(v => v.name.trim()))
      .filter(Boolean)
  );
  // Same set, by name, so a typedef targeting `<FunctionDefinition> *` can be
  // inlined into a self-contained function-pointer typedef.
  setKnownFuncDefs(funcDefDataTypes);

  // Register per-quest struct layouts so the union-member rewrite (impl.ts) can
  // remap a field by byte offset when it switches union members. Ghidra resolves
  // D2QuestDataStrc.pQuestSpecificData (32-member union) to an arbitrary member,
  // so the field name belongs to the WRONG quest struct until offset-remapped.
  setQuestStructLayouts(
    dataTypes.filter(dt => dt.kind === 'STRUCTURE') as import('../types.js').ExtractedStruct[],
  );

  // Register the declaration-time field renames so body references to a field
  // the header had to rename (a column literally named `int` → `int_`) use the
  // same spelling. Applied on member-access nodes by `reserved-field-rename`.
  setStructFieldRenames(
    dataTypes.filter(
      dt => dt.kind === 'STRUCTURE' || dt.kind === 'UNION',
    ) as import('../types.js').ExtractedStruct[],
  );

  // Register multidimensional-array globals so their `&name` initializers get a
  // cast to the pointer field type (`(T*)&name`) — a 2-D+ array address is
  // `T(*)[N][M]`, incompatible with the `T*` field even after array decay.
  setMultidimArrayGlobals(globals as Array<{ name: string; dataType?: string; suggestedName?: string; suggestedType?: string }>);
  // Register struct/union layouts so a struct-shaped global initializer can be
  // typed field by field — without it a pointer field is spelled `&sym` with no
  // idea whether that expression's type is the field's type.
  setGlobalInitializerTypes(dataTypes);

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
  //
  // The declaration closure needs the model as Ghidra gave it — this filter is
  // exactly what creates the gap it closes — so it is captured first. Nothing
  // about that changes what is emitted.
  resetDeclaredNames();
  setDeclarationClosureModel(functions, globals as AnalyzedDataSymbol[]);

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

  // What survived the filter is what gets a definition, and therefore what a
  // bare call needs QUALIFYING rather than declaring. Everything else that a
  // body calls is a closure candidate.
  {
    const emittedFunctionNames = new Set<string>();
    for (const f of functions) emittedFunctionNames.add(f.name);
    setDeclarationClosureEmitters(
      emittedFunctionNames,
      makeClosurePrototypeRenderer(dataTypes, options),
    );
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

  // Tag-based method detection is intentionally skipped: the reconstruction is
  // emitted as FREE functions (the receiver stays an explicit first param), keeping
  // namespaces. Ghidra method tags would otherwise turn calls into obj->m() — which
  // mangle as thiscall members and won't link against the free definitions; the
  // C/Zig boundary is a small extern "C" shim instead. Explicit project.json
  // methodConversions are still honored (so the feature remains available).
  void detectMethodConversionsFromTags; void getOrCreateRegistry; // tag path disabled

  // Apply method conversions (only explicit project.json entries, if any)
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

  // Build bitfield catalog from struct metadata
  const bitfieldCatalog = buildBitfieldCatalog(dataTypes);

  const context: ImplGenContext = {
    overrides,
    libraries,
    methodConversions,
    methodMappings: Object.keys(mergedMappings).length > 0 ? mergedMappings : undefined,
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
  const inAddrClaim = buildWinsockInAddrClaim(dataTypes);
  files.set('d2_platform.h', {
    path: 'd2_platform.h',
    content: generatePlatformHeader({
      seedType: dataTypes.some(dt => dt.name === 'D2SeedStrc'),
      anonymousAggregates: buildAnonymousAggregateDefs(dataTypes, functions, inAddrClaim.claimed),
      winsockInAddr: inAddrClaim.lines,
    }),
    type: 'header',
    functions: [],
    includes: [],
  });

  // Collect all ENUM data types into a shared header.
  // Enum constants (e.g. SOUND_NONE, UNIT_PLAYER) are used across many files but the
  // body scanner can't detect them (it only finds struct pointer casts). Putting all enums
  // in one shared header included from d2_platform.h makes them universally available.
  //
  // d2_platform.h includes it unconditionally, so it is emitted unconditionally:
  // an include is only ever as good as the file the same run put on disk, and a
  // program with no enums used to leave d2_platform.h naming a file nothing
  // wrote.
  const enumTypes = dataTypes.filter(t => t.kind === 'ENUM') as import('../types.js').ExtractedEnum[];
  {
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
    if (enumTypes.length > 0) {
      context._sharedEnumTypes = new Set(enumTypes.map(e => e.name));
    }
  }

  // Generate globals.h if we have analyzed globals with scope info
  const analyzedGlobals: AnalyzedDataSymbol[] = (globals as AnalyzedDataSymbol[]).filter(
    g => 'scope' in g
  );
  // Every type name in the program: a global that shares a name with one cannot
  // be reasoned about from body text, and cannot be declared beside it.
  const allDataTypeNames = new Set(dataTypes.map(dt => dt.name));

  // Wire analyzed globals into context for static-local injection
  context.analyzedGlobals = analyzedGlobals;

  // A symbol whose address is taken by ANOTHER symbol's initialized data cannot
  // be a function-scope static: the initializer is emitted at namespace scope and
  // names it there. Ghidra's `referencingFunctions` only counts code xrefs, so a
  // table that is written once and only ever read through that table looks
  // single-owner and gets demoted — then 46 initializer entries name something
  // no scope declares. Promote them back before anything is emitted, so the
  // declaration and the reference come from one place.
  promoteInitializerReferencedStaticLocals(analyzedGlobals);

  // Ghidra's listing BUILT_INs (`IconResource`, `GroupIconResource`) are runs of
  // bytes with no C++ type. Respell them as byte arrays of their own size once,
  // before globals.h and globals.cpp are written from the same records.
  resolveListingBuiltinBlobs(analyzedGlobals);

  // Resolve every symbol's namespace ONCE, for the whole run, and bind it to
  // that symbol's address. Function definition, header declaration, globals.h
  // extern, globals.cpp definition, struct-header co-located extern and every
  // qualified reference all render from this one entity. It is built here, over
  // the WHOLE model, rather than inside the per-target file generator: that ran
  // once per target and each run replaced the previous one's address claims.
  {
    const structUnionEnumNames = new Set<string>();
    for (const dt of dataTypes) {
      if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION' || dt.kind === 'ENUM') {
        structUnionEnumNames.add(dt.name);
      }
    }
    buildNamespaceResolution(structUnionEnumNames, [...functions, ...analyzedGlobals]);
  }

  // Build the function address map for func-ptr-literal resolution.
  // Address format is "Game.exe.ram:005011f0" — extract hex after last colon.
  //
  // A function's address is taken from anywhere: a dispatch table in one module
  // names a handler defined in another. So the entry carries the namespace the
  // DEFINITION is emitted in, taken from the resolution above, and the reference
  // is spelled with it. Three kinds of function keep the bare name because that
  // is where their definition actually is: a method is emitted as `Class::name`
  // at root scope, a library function is declared by a real header at root
  // scope, and an external one has no definition here at all.
  const functionAddressMap = new Map<bigint, FuncPtrTarget>();
  for (const func of functions) {
    if (func.name.startsWith('FUN_')) continue;
    const hexPart = func.address.includes(':')
      ? func.address.slice(func.address.lastIndexOf(':') + 1)
      : func.address;
    let addr: bigint;
    try {
      addr = BigInt('0x' + hexPart);
    } catch {
      continue; // Skip addresses that can't be parsed
    }
    const rootScoped = Boolean(func.parentClass || func.isLibrary || func.isExternal);
    functionAddressMap.set(addr, {
      name: func.name,
      namespaceSegments: rootScoped ? [] : namespaceResolution().of(func).segments,
    });
  }
  if (functionAddressMap.size > 0) context.functionAddressMap = functionAddressMap;

  // Qualified names (namespace::name) of every emitted function. A data symbol
  // can share its name with a function in the same namespace (getter + backing
  // flag both named e.g. IsRecording); globals.h must not redeclare those.
  const functionQualifiedNames = new Set<string>();
  for (const f of functions) {
    const qn = f.namespace ? `${f.namespace}::${f.name}` : f.name;
    functionQualifiedNames.add(qn);
    // A decorated function name (`GLIDEDLL_grLfbLock@24`) is DECLARED under the
    // shared identifier sanitizer, so the globals side must test the collision
    // under that same spelling — otherwise a data symbol at the same decorated
    // name is emitted as an `extern` beside the function declaration
    // ("redeclared as a different kind of entity", once per including TU).
    const sanitized = sanitizeQualifiedReference(qn);
    if (sanitized !== qn) functionQualifiedNames.add(sanitized);
  }
  // d2_platform.h declares the excluded-namespace callees (CRT forwarders, the
  // Glide/RAD/DDraw import thunks) as FUNCTIONS under the same emitted spelling.
  // They own those names in every TU, so an IAT data symbol at the same name —
  // `GLIDEDLL_grLfbLock@24` — must not also get an extern in globals.h.
  for (const d of EXCLUDED_SYMBOL_DECLS) {
    functionQualifiedNames.add(d.emitted);
    const sd = sanitizeQualifiedReference(d.emitted);
    if (sd !== d.emitted) functionQualifiedNames.add(sd);
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
      const rescoped = reconcileStaticScopeWithBodyReferences(analyzedGlobals, functions, funcToImpl, allDataTypeNames);
      if (rescoped.promotedToGlobal || rescoped.promotedToFileLocal) {
        console.log(`Globals rescoped from body references: ${rescoped.promotedToGlobal} to file scope in globals.cpp, ${rescoped.promotedToFileLocal} from function-local to file-local`);
      }
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
      // A global demoted to file-local / struct-colocated is only actually
      // emitted if the file it was assigned to exists. Restore any that no
      // generated file claims, so they get a declaration + definition here
      // instead of vanishing silently.
      reconcileOrphanedGlobals(analyzedGlobals);
      // A symbol named by another global's initializer is referenced, even
      // though no function body mentions it; give it back its extern.
      promoteCentrallyReferencedGlobals(analyzedGlobals);
      // Scopes are only final HERE — file-local promotion and orphan reconcile
      // both ran after the first call. The globals tables (and, with them, the
      // "can globals.cpp see this symbol?" answer) have to be rebuilt from the
      // final scopes, or the central initializers reference symbols that end up
      // `static` in someone else's .cpp.
      setMultidimArrayGlobals(analyzedGlobals as Array<{ name: string; dataType?: string; suggestedName?: string; suggestedType?: string; scope?: string }>);

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
        setCentralInitializerScope(true);
        const globalsImplContent = generateGlobalsImpl(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        }, globalsPath!.split('/').pop());
        setCentralInitializerScope(false);
        files.set(globalsImplPath, {
          path: globalsImplPath,
          content: globalsImplContent,
          type: 'implementation',
          functions: [],
          includes: [globalsPath!],
        });

        // Patch globals.cpp with extra includes for non-pointer struct types
        patchGlobalsExtraIncludes(files, globalsImplPath, centralGlobals, mergedTypeOwnerMap, globalsPath!, context.functionNameCandidates);
      }
    }
  } else {
    // Non-target mode: existing flat generation

    // Compute file-scoped statics BEFORE globals.h/cpp generation
    if (options.promoteStaticGlobals && analyzedGlobals.length > 0) {
      const funcToImpl = buildFuncToImplPathMap(functions, classes, namespaces, options, '');
      computeFileLocalGlobals(analyzedGlobals, funcToImpl);
      reconcileStaticScopeWithBodyReferences(analyzedGlobals, functions, funcToImpl, allDataTypeNames);
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
      // A global demoted to file-local / struct-colocated is only actually
      // emitted if the file it was assigned to exists. Restore any that no
      // generated file claims, so they get a declaration + definition here
      // instead of vanishing silently.
      reconcileOrphanedGlobals(analyzedGlobals);
      // A symbol named by another global's initializer is referenced, even
      // though no function body mentions it; give it back its extern.
      promoteCentrallyReferencedGlobals(analyzedGlobals);
      // Scopes are only final HERE — file-local promotion and orphan reconcile
      // both ran after the first call. The globals tables (and, with them, the
      // "can globals.cpp see this symbol?" answer) have to be rebuilt from the
      // final scopes, or the central initializers reference symbols that end up
      // `static` in someone else's .cpp.
      setMultidimArrayGlobals(analyzedGlobals as Array<{ name: string; dataType?: string; suggestedName?: string; suggestedType?: string; scope?: string }>);

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
        setCentralInitializerScope(true);
        const globalsImplContent = generateGlobalsImpl(centralGlobals, {
          ...options,
          projectName: name,
          binaryName: programInfo?.name,
        });
        setCentralInitializerScope(false);
        files.set(globalsImplPath, {
          path: globalsImplPath,
          content: globalsImplContent,
          type: 'implementation',
          functions: [],
          includes: ['globals.h'],
        });

        // Patch globals.cpp with extra includes for non-pointer struct types
        patchGlobalsExtraIncludes(files, globalsImplPath, centralGlobals, flatTypeOwnerMap, 'globals.h', context.functionNameCandidates);
      }
    }
  }

  const project: ReconstructedProject = {
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

  reportUnresolvableIncludes(project);
  reportCaseCollidingOutputPaths(project);
  reportGlobalsTakingATypeName();
  reportDeclarationClosure();

  return project;
}

/**
 * What the closure declared, and what it refused to.
 *
 * The refusals are the interesting half: each class is a separate defect the
 * closure deliberately does not paper over, and the count is how much of the
 * "was not declared" error family is NOT a closure problem.
 */
function reportDeclarationClosure(): void {
  const report = getDeclarationClosureReport();
  if (!report) return;
  const byOrigin = new Map<string, number>();
  for (const d of report.declarations) byOrigin.set(d.origin, (byOrigin.get(d.origin) ?? 0) + 1);
  if (report.declarations.length > 0) {
    const parts = [...byOrigin].map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`Declaration closure: ${report.declarations.length} declaration(s) added (${parts})`);
  }
  if (report.unresolved.size > 0) {
    const total = [...report.unresolved.values()].reduce((a, l) => a + l.length, 0);
    console.log(`Declaration closure: ${total} referenced name(s) left undeclared, by cause:`);
    for (const [reason, names] of [...report.unresolved].sort((a, b) => b[1].length - a[1].length)) {
      const sample = names.slice(0, 6).join(', ');
      console.log(`  ${String(names.length).padStart(5)}  ${reason}  e.g. ${sample}${names.length > 6 ? ', ...' : ''}`);
    }
  }
}

/**
 * Build the prototype renderer the declaration closure uses for a callee that
 * has no emitted definition.
 *
 * The signature is Ghidra's, unedited. What the renderer will NOT do is emit a
 * prototype it cannot spell honestly: a parameter or return type that is neither
 * a builtin, a platform type, nor a struct/union this build declares would have
 * to be guessed at, and a guessed prototype compiles a call that cannot be
 * right. Those are refused and reported instead.
 *
 * Struct and union types reach the closure block by pointer, so a forward
 * declaration is enough and is emitted alongside. A by-value aggregate is not:
 * that needs the full definition, which globals.h has no way to order correctly.
 */
/**
 * Ghidra type names that describe a byte layout rather than a C type. They pass
 * `isPlatformOrBuiltinType` (the emitter maps them elsewhere) but no header
 * declares them, so a declaration that spells one is not a declaration at all.
 */
const GHIDRA_PSEUDO_TYPE_NAMES = new Set([
  'string', 'TerminatedCString', 'string-utf8', 'undefined', 'code',
]);

function makeClosurePrototypeRenderer(
  dataTypes: ExtractedDataType[],
  options: ReconstructOptions,
): (func: ExtractedFunction) => string | null {
  const forwardDeclarable = new Set<string>();
  for (const dt of dataTypes) {
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') {
      if (!isLibraryType(dt.name, dt.category)) forwardDeclarable.add(dt.name);
    }
  }

  const baseOf = (type: string): string =>
    type.replace(/\[[^\]]*\]/g, '')
        .replace(/[*&]/g, '')
        .replace(/\b(const|volatile|struct|union|enum|unsigned|signed)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

  // Names the platform header already declares — the CRT/Win32 stubs, the
  // curated excluded-symbol prototypes, the inline forwarders. A second
  // declaration here is not a closure, it is an "ambiguating new declaration"
  // (or, for a CRT name that is a MACRO, a macro invoked with the wrong arity).
  const platformDeclared = platformDeclaredFunctionNames();

  return (func: ExtractedFunction): string | null => {
    if (platformDeclared.has(func.name)) return null;
    // A secondary-source function is emitted (where it is emitted at all) behind
    // `#ifdef D2_PLATFORM_MAC`, and every body that calls it is behind the same
    // guard. An unconditional declaration in the one header the WHOLE tree
    // includes is not what those call sites are missing — and several of these
    // names are libc's, which the real headers declare differently.
    if (func.platform) return null;
    const spelled = [func.returnType, ...func.parameters.map(p => p.dataType)].map(sigType);
    const forwards: string[] = [];
    for (const type of spelled) {
      const base = baseOf(type);
      if (!base || base === 'void') continue;
      // Ghidra pseudo-types that the platform predicate accepts but no header
      // declares: `string` is Ghidra's name for a NUL-terminated byte run, not
      // a C type, and a prototype spelling it is undeclared wherever it lands.
      if (GHIDRA_PSEUDO_TYPE_NAMES.has(base)) return null;
      if (isPlatformOrBuiltinType(base)) continue;
      if (!forwardDeclarable.has(base)) return null;
      // Only by pointer — an aggregate passed or returned by value needs the
      // layout, and a forward declaration cannot supply it.
      if (!/[*&]/.test(type)) return null;
      forwards.push(`struct ${base};`);
    }
    const decl = generateFunctionDeclaration(func, options);
    // `generateFunctionDeclaration` prefixes Ghidra's comment block; the closure
    // block wants the one line.
    const line = decl.split('\n').filter(l => !l.startsWith('//')).join('\n').trim();
    if (!line) return null;
    return [...new Set(forwards), line].join('\n');
  };
}

/**
 * Every `#include "..."` the generator emits must name a file the SAME run
 * emitted. An include is computed from a symbol's namespace, and a namespace
 * that moved module — or one whose path is spelled differently by a sibling —
 * produces a path that reads plausibly and does not exist. `globals.h` is
 * included by every translation unit, so three such includes in it fail all 489
 * of them with `fatal error: ... No such file or directory`.
 *
 * So the check is against the emitted file table, the same one `writeProject`
 * writes from — never against a derived or remembered path.
 */
export function findUnresolvableIncludes(
  project: ReconstructedProject
): Map<string, string[]> {
  const emitted = new Set(project.files.keys());
  const unresolved = new Map<string, string[]>();
  for (const [filePath, file] of project.files) {
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    for (const included of collectQuotedIncludes(file.content)) {
      // An include is resolved the way the compiler resolves it: first beside
      // the including file, then from the tree root (every directory is on the
      // include path).
      const beside = dir ? normalizeRelativePath(`${dir}/${included}`) : included;
      if (emitted.has(beside) || emitted.has(included)) continue;
      const referrers = unresolved.get(included) ?? [];
      referrers.push(filePath);
      unresolved.set(included, referrers);
    }
  }
  return unresolved;
}

/**
 * The `#include "..."` lines of a generated file.
 *
 * A line scan, not a regex over emitted code: this reads the text the generator
 * is about to write, and the only thing it needs from it is which quoted paths
 * appear on `#include` lines.
 */
function collectQuotedIncludes(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('#include')) continue;
    const open = line.indexOf('"');
    if (open < 0) continue; // <system> include
    const close = line.indexOf('"', open + 1);
    if (close < 0) continue;
    const p = line.slice(open + 1, close);
    if (p.length > 0) out.push(p);
  }
  return out;
}

/** Collapse `a/./b` and `a/b/../c` in a generated (always forward-slash) path. */
function normalizeRelativePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

function reportUnresolvableIncludes(project: ReconstructedProject): void {
  const unresolved = findUnresolvableIncludes(project);
  if (unresolved.size === 0) return;
  const total = [...unresolved.values()].reduce((a, r) => a + r.length, 0);
  console.warn(`warning: ${unresolved.size} include path(s) name a file this run did not emit (${total} site(s)) — every one of them is a fatal error in each including translation unit:`);
  for (const [inc, referrers] of [...unresolved].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
    console.warn(`  ${inc}  <- ${referrers.length} file(s), e.g. ${referrers.slice(0, 3).join(', ')}`);
  }
  if (unresolved.size > 20) console.warn(`  ... and ${unresolved.size - 20} more`);
}

/**
 * Two output paths that differ only in case are two files on Linux and ONE file
 * on macOS/Windows, where the second write silently destroys the first. The
 * generator cannot decide which of the two Ghidra namespaces is the real one, so
 * it reports the pair; the fix belongs in Ghidra, by merging the case twins.
 */
function reportCaseCollidingOutputPaths(project: ReconstructedProject): void {
  const byFoldedPath = new Map<string, string[]>();
  for (const p of project.files.keys()) {
    const key = p.toLowerCase();
    const group = byFoldedPath.get(key) ?? [];
    group.push(p);
    byFoldedPath.set(key, group);
  }
  const collisions = [...byFoldedPath.values()].filter(g => g.length > 1);
  if (collisions.length === 0) return;
  console.warn(`warning: ${collisions.length} output path(s) differ only in case — on a case-insensitive filesystem each pair is ONE file and the later write destroys the earlier. Merge the case-twin namespaces in Ghidra:`);
  for (const group of collisions.slice(0, 20)) console.warn(`  ${group.sort().join('  ==  ')}`);
  if (collisions.length > 20) console.warn(`  ... and ${collisions.length - 20} more`);
}

/**
 * Compute extra includes for globals.cpp.
 * Non-pointer struct types used in global definitions need their defining header.
 */
function computeGlobalsExtraIncludes(
  globals: AnalyzedDataSymbol[],
  typeOwnerMap: Map<string, string>,
  functionNameCandidates?: Map<string, { qualified: string; header: string }[]>
): string[] {
  const includes = new Set<string>();
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const type = g.suggestedType || g.dataType;
    // Skip pointer types — forward declaration suffices
    if (!type.includes('*') && !type.includes('&')) {
      const stripped = stripTypeName(type);
      const ownerHeader = stripped ? typeOwnerMap.get(stripped) : undefined;
      if (ownerHeader && ownerHeader !== 'globals.h') {
        includes.add(ownerHeader);
      }
    }
    // A namespace can be reached ONLY through an address-taken reference in the
    // initializer — `&D2Common::Skills::SkillMonst::Skills_SrvDoFunc_083` in a
    // handler table. The declared type says nothing about it, so without walking
    // the initializer tree nothing includes SkillMonst.h and every entry is
    // "has not been declared".
    if (g.initializedData && functionNameCandidates) {
      for (const ref of collectInitializerSymbolRefs(g.initializedData)) {
        const header = resolveSymbolReferenceHeader(ref, functionNameCandidates);
        if (header && header !== 'globals.h') includes.add(header);
      }
    }
  }
  return [...includes].sort();
}

/**
 * Every symbol name an initializer tree takes the address of, at any nesting
 * depth (arrays of structs of function-pointer tables all appear here).
 */
function collectInitializerSymbolRefs(dv: DataValue, out: string[] = []): string[] {
  if (dv.kind === 'pointer' && dv.value && /^[A-Za-z_]/.test(dv.value)) {
    out.push(dv.value);
  }
  if (dv.elements) for (const e of dv.elements) collectInitializerSymbolRefs(e, out);
  if (dv.fields) for (const f of dv.fields) collectInitializerSymbolRefs(f.value, out);
  return out;
}

/**
 * Resolve a (possibly qualified) initializer symbol reference to the header that
 * declares it. Ambiguous bare names are resolved by the qualifier — the emitted
 * reference is a suffix of the declaration's qualified name.
 */
function resolveSymbolReferenceHeader(
  rawRef: string,
  functionNameCandidates: Map<string, { qualified: string; header: string }[]>
): string | undefined {
  const ref = normalizeQualifiedReference(rawRef.replace(/\b(?:compiler|VisualStudio)::/g, ''));
  const bare = ref.includes('::') ? ref.slice(ref.lastIndexOf('::') + 2) : ref;
  const candidates = functionNameCandidates.get(bare);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].header;
  for (const c of candidates) {
    if (c.qualified === ref || c.qualified.endsWith(`::${ref}`)) return c.header;
  }
  return undefined;
}

/**
 * Patch globals.cpp in the files map with extra includes for non-pointer struct types.
 */
function patchGlobalsExtraIncludes(
  files: Map<string, SourceFile>,
  globalsImplPath: string,
  centralGlobals: AnalyzedDataSymbol[],
  typeOwnerMap: Map<string, string>,
  globalsHeaderPath: string,
  functionNameCandidates?: Map<string, { qualified: string; header: string }[]>
): void {
  const globalsFile = files.get(globalsImplPath);
  if (!globalsFile) return;

  const extraIncludes = computeGlobalsExtraIncludes(centralGlobals, typeOwnerMap, functionNameCandidates);
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
  // Ghidra's own path, split once by the resolution — the module is its first
  // segment, before any collapsing.
  const firstSegment = namespaceResolution().of(func).ghidraSegments[0];
  if (!firstSegment) return null;
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
 * Undo a static/file-local demotion that the emitted code cannot honour.
 *
 * A global's scope is decided from Ghidra's XREF count at its EXACT start
 * address, but what actually decides whether `static` is legal is how many
 * function bodies NAME the symbol. Those two disagree constantly, most visibly
 * where a Ghidra array is longer than the real table: every
 * `AllocServerMemory(..., __FILE__, ...)` inside its extent decompiles its
 * filename argument as `(char*)(gTable + 0xNN)`, so a symbol with xrefCount 1
 * is named by dozens of functions across a dozen files.
 *
 * The result was a symbol emitted `static` in one place and declared `extern` by
 * globals.h's multi-body safety net — a declaration nothing can ever satisfy,
 * plus, for a function-local static, a body-scoped object no other function can
 * see. Both decisions now come from ONE count.
 *
 * The demotion stays where it is provably safe: a static-local whose name only
 * one function mentions, a file-local whose name only one output file mentions.
 */
export function reconcileStaticScopeWithBodyReferences(
  analyzedGlobals: AnalyzedDataSymbol[],
  functions: ExtractedFunction[],
  funcNameToImplPath: Map<string, string>,
  typeNames: ReadonlySet<string>
): { promotedToGlobal: number; promotedToFileLocal: number } {
  // Names a `scope === 'global'` symbol already owns. Promoting a second symbol
  // into one of them cannot help: globals.h declares exactly one of the two, and
  // whichever loses is worse off than it was as a local — `gaPlayerInitStats` is
  // a `uint[4]` at 006e1520 and a `D2PlayerInitStatsStrc[7]` at 00711e00, and the
  // bodies that index the struct need the struct. That collision is a Ghidra
  // fault; until it is fixed the local copy is the only one that is right.
  const namesOwnedByAGlobal = new Set<string>();
  for (const g of analyzedGlobals) {
    if (g.scope === 'global') namesOwnedByAGlobal.add(sanitizeSymbolName(g.suggestedName || g.name));
  }

  const candidates = new Map<string, AnalyzedDataSymbol[]>();
  for (const g of analyzedGlobals) {
    if (g.scope !== 'static-local' && g.scope !== 'file-local') continue;
    if (namesOwnedByAGlobal.has(sanitizeSymbolName(g.suggestedName || g.name))) continue;
    const name = sanitizeSymbolName(g.suggestedName || g.name);
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    // A symbol whose name is ALSO a type name cannot be counted this way: the
    // decompiled text that names it may be naming the type, and `enum E; E E;`
    // is not declarable at one scope anyway — globals.h refuses to emit an
    // extern for it, so promoting it would produce a definition nothing declares.
    if (typeNames.has(name)) continue;
    const list = candidates.get(name);
    if (list) list.push(g); else candidates.set(name, [g]);
  }
  if (candidates.size === 0) return { promotedToGlobal: 0, promotedToFileLocal: 0 };

  // Which functions name each candidate, read off Ghidra's decompiler output —
  // the INPUT to codegen, and the only place the eventual references exist
  // before any file has been generated.
  const namingFunctions = new Map<string, Set<string>>();
  const identifier = /[A-Za-z_]\w*/g;
  for (const func of functions) {
    const body = func.decompiled;
    if (!body) continue;
    identifier.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = identifier.exec(body)) !== null) {
      const id = m[0];
      if (seen.has(id) || !candidates.has(id)) continue;
      seen.add(id);
      let fns = namingFunctions.get(id);
      if (!fns) { fns = new Set(); namingFunctions.set(id, fns); }
      fns.add(func.name);
    }
  }

  let promotedToGlobal = 0;
  let promotedToFileLocal = 0;
  for (const [name, globalsWithName] of candidates) {
    const fns = namingFunctions.get(name);
    if (!fns || fns.size <= 1) continue;
    const files = new Set<string>();
    let unresolved = false;
    for (const fn of fns) {
      const path = funcNameToImplPath.get(fn);
      if (!path) { unresolved = true; break; }
      files.add(path);
    }
    void files; void unresolved;
    for (const g of globalsWithName) {
      // File scope is NOT a safe halfway house: globals.h emits a fallback
      // extern for any symbol more than one body names, so a `static` that
      // several functions share is a declaration nothing can satisfy however
      // the functions are distributed over files. More than one body ⇒ a
      // global.
      g.scope = 'global';
      g.ownerFile = undefined;
      g.ownerFunction = undefined;
      promotedToGlobal++;
    }
  }
  return { promotedToGlobal, promotedToFileLocal };
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
  const allAnalyzedGlobalNames = new Set(analyzedGlobals.map(g => g.suggestedName || g.name));

  // The run's namespace resolution is built once, over the whole model, in
  // generateProject — before any target is generated.
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
  // A bare function name is NOT a key: `Initialize` is declared by Glide,
  // Direct3D, DirectDraw and Windowed alike, and a one-entry-per-name map is
  // last-wins — the include feedback below then pulls in whichever renderer
  // happened to be organized last and leaves the other three undeclared. Keep
  // every candidate, each tagged with the qualified name a reference to it is
  // spelled with, so an ambiguous name can be resolved from its qualifier.
  const funcNameCandidates = new Map<string, { qualified: string; header: string }[]>();
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

      const qualified = func.namespace
        ? normalizeQualifiedReference(`${func.namespace}::${func.name}`)
        : func.name;
      let candidates = funcNameCandidates.get(func.name);
      if (!candidates) {
        candidates = [];
        funcNameCandidates.set(func.name, candidates);
      }
      if (!candidates.some(c => c.qualified === qualified && c.header === headerPath)) {
        candidates.push({ qualified, header: headerPath });
      }
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
  // The namespace resolution — the single entity header decl, impl def, globals
  // and every call site render from — is built once by generateProject, before
  // any file is emitted. It is deliberately NOT reinstalled here: this function
  // runs once per target with that target's slice of the program, and rebuilding
  // from a slice would give each target its own answer, which is the very bug
  // being removed.
  void setNamespaceCollisionTypes;
  // The reference side of the same decision, applied on the name node.
  context._namespaceCollisionTypeNames = [...structUnionEnumNames];

  // struct/union name → { fieldName → field's struct/union type name }, used to
  // resolve deref chains (`a->b->c`) so the headers of the INTERMEDIATE struct
  // types get included. Struct headers only forward-declare pointer-field types,
  // so a body that walks `pRoomEx->pLevel->pDrlg->pMemoryPool` needs D2DrlgStrc's
  // full definition even though "D2DrlgStrc" never appears as a token → otherwise
  // "invalid use of incomplete type". Field type names are stripped of */[]/const.
  const structFieldTypes = new Map<string, Map<string, string>>();
  for (const dt of dataTypes) {
    if ((dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') || !('fields' in dt)) continue;
    const fm = new Map<string, string>();
    for (const f of (dt as import('../types.js').ExtractedStruct).fields) {
      const base = f.dataType.replace(/\bconst\b/g, '').replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '').trim();
      if (structUnionEnumNames.has(base)) fm.set(f.name, base);
    }
    if (fm.size > 0) structFieldTypes.set(dt.name, fm);
  }

  // Pass func name → header map into context for func-ptr-literal include resolution
  if (context.functionAddressMap) {
    context.functionNameToHeader = funcNameToHeaderPath;
  }
  // globals.cpp is generated after this pass and needs the same resolution to
  // include the headers its data initializers name.
  context.functionNameCandidates = funcNameCandidates;

  // ── Reference-vs-declaration spelling reconciliation ────────────────
  // A function's DECLARATION is spelled from the symbol table (`name` +
  // `namespace`); its REFERENCES are spelled by the decompiler, in a separate
  // round-trip. A rename or a namespace move landing between the two — naming
  // campaigns run continuously — leaves every body calling a name the tree
  // never declares. Read the decompiler's own spelling for each address back
  // out of its body and map it onto the declaration's spelling, so the pair
  // moves together whatever the campaign renamed.
  const declaredSpellings = new Set<string>();
  for (const func of functions) {
    declaredSpellings.add(func.name);
    if (func.namespace) declaredSpellings.add(`${func.namespace}::${func.name}`);
  }
  // A destructor, an operator or a symbol whose name is not a legal C++
  // identifier (`0x44PacketHandler`) is spelled by the emitter's own
  // legalisation, not carried through from the database — respelling a
  // reference with the raw database spelling would emit what the compiler
  // cannot parse.
  const isPlainQualifiedName = (n: string) =>
    n.split('::').every(seg => /^[A-Za-z_]\w*$/.test(seg));
  const aliasClaims = new Map<string, string | null>(); // alias → canonical, null = ambiguous
  for (const func of functions) {
    if (func.isExternal || func.isThunk) continue;
    // A method conversion renames a free function on the EMITTER's side, and
    // `method-call-rewrite` already rewrites its call sites to `this->Init(0)`.
    // Reconciling it here would flatten those back to a plain call.
    if (context.methodConversions?.has(func.address)) continue;
    const alias = decompiledFunctionName(func.decompiled);
    if (!alias || !isPlainQualifiedName(alias)) continue;
    const canonical = func.namespace ? `${func.namespace}::${func.name}` : func.name;
    if (alias === canonical) continue;
    if (!isPlainQualifiedName(canonical)) continue;
    // A spelling that some function really does declare is that function's, not
    // an alias — respelling it would hijack a live name.
    if (declaredSpellings.has(alias)) continue;
    // A qualified alias whose tail already matches keeps the tail; both halves
    // are rewritten from `canonical`, so nothing here is name-specific.
    const prev = aliasClaims.get(alias);
    if (prev === undefined) aliasClaims.set(alias, canonical);
    else if (prev !== canonical) aliasClaims.set(alias, null);
  }
  const functionRefAliases: Record<string, string> = {};
  for (const [alias, canonical] of aliasClaims) {
    if (canonical) functionRefAliases[alias] = canonical;
  }
  context.functionRefAliases = functionRefAliases;

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
  // Data initializers are emitted from strings, not an AST — the globals emitter
  // needs the same table to spot a shadowed qualifier.
  setKnownNamespaces(knownNamespaces);

  // A class's vtable data and its member functions hang under a namespace named
  // after the class, so `namespace D2Client::ButtonWrapper` and the root-scope
  // `struct ButtonWrapper` coexist. Inside `namespace D2Client` the NAMESPACE
  // wins unqualified lookup and the type name stops being a type — every use
  // has to be spelled `::ButtonWrapper`. Collect exactly those names.
  const namespaceComponents = new Set<string>();
  const addComponents = (path: string | undefined) => {
    if (!path) return;
    for (const seg of path.split('::')) if (seg) namespaceComponents.add(seg);
  };
  for (const ns of knownNamespaces) addComponents(ns);
  // A class whose only remaining symbol is its vtable has no function in that
  // namespace, so `knownNamespaces` never sees it — but globals.h still opens
  // `namespace D2Client::ListBoxWrapper` around it and the shadow is just as real.
  for (const g of analyzedGlobals) addComponents(g.namespace);
  const shadowedTypeNames = new Set<string>();
  for (const dt of dataTypes) {
    if (namespaceComponents.has(dt.name)) shadowedTypeNames.add(dt.name);
  }
  for (const typeName of typeOwnerMap.keys()) {
    if (namespaceComponents.has(typeName)) shadowedTypeNames.add(typeName);
  }
  // A FUNCTION shadows a same-named type in exactly the same way a namespace
  // does, and Ghidra produces the collision wholesale: 53 functions carry the
  // name of the funcdef that describes them — `Push`, `Draw`, `Key`, `Release`,
  // `fpDrawGroundTile`. The typedef is emitted at ROOT scope and the function
  // inside its own namespace, so inside that namespace the FUNCTION wins
  // unqualified lookup and the type stops being a type:
  //
  //     namespace D2Win::Src {
  //       Push pPVar2 = pButton->sControl.fpPush;   // error: expected ';' before 'pPVar2'
  //       pTail = *(Push*)(pTail + 0x220);          // error: expected primary-expression
  //     }
  //
  // Same evidence, same remedy: spell the type `::Push`. Restricted to
  // FUNCTION_DEFINITIONs because those are the ones Ghidra names after the
  // function; a struct sharing a constructor's name is handled by the `struct`
  // keyword the header emitter already inserts.
  {
    const funcDefNames = new Set(
      dataTypes.filter(dt => dt.kind === 'FUNCTION_DEFINITION').map(dt => dt.name)
    );
    for (const func of functions) {
      if (funcDefNames.has(func.name)) shadowedTypeNames.add(func.name);
    }
  }
  context.shadowedTypeNames = shadowedTypeNames;
  setShadowedTypeNames(shadowedTypeNames);

  // Function-pointer parameters take the address of a function whose prototype
  // may differ (`CONTAINER_InitializeBuffer(..., STRING_ZeroOneWCHAR)` fills a
  // `void(*)(void*)` slot with a `void(*)(uint16_t*)`). Function pointer types
  // are invariant in C++, so the original source had to write a cast there; the
  // `funcptr-arg-cast` transform emits it, but only where the MODEL says the two
  // prototypes actually differ. Build that comparison table here, once.
  context.funcPtrArgCasts = buildFuncPtrArgCastTables(functions, analyzedGlobals, dataTypes.filter(dt => dt.kind === 'FUNCTION_DEFINITION') as import('../types.js').ExtractedFunctionDefinition[], dataTypes);
  // Data initializers are emitted from strings, not an AST — the globals emitter
  // needs the same prototype tables to decide whether a function address stored
  // in a slot needs the cast C++ has never let it do implicitly.
  setInitializerSignatureTables(
    context.funcPtrArgCasts.functionSignatures,
    context.funcPtrArgCasts.funcdefSignatures,
  );

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

  // One index over every name the per-file include feedback below asks about,
  // so each generated .cpp is scanned once instead of ~20,000 times.
  const dependencyNeedles = new NeedleIndex([
    ...(context.functionAddressMap ? [...context.functionAddressMap.values()].map(t => t.name) : []),
    ...typeOwnerMap.keys(),
  ]);

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
          && !isUnreferenceableArtifact(g, allAnalyzedGlobalNames)
      );
      if (context.fileLocalGlobals.length === 0) {
        context.fileLocalGlobals = undefined;
      }
      // This file now owns their definitions — record it, so the globals.h/cpp
      // pass knows they are not orphans.
      markGlobalsClaimed(context.fileLocalGlobals);
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

    // Co-located global definitions belong to this .cpp's content BEFORE the
    // dependency scan below runs. Appending them afterwards means their type and
    // function references are invisible to the scan, so nothing includes the
    // headers that declare them — e.g. Renderer.cpp's GlideFunctionTable, whose
    // initializer names D2Client::Renderer::Glide::* and got 54 "has not been
    // declared" errors for exactly that reason.
    const implColocatedGlobals = analyzedGlobals.filter(g =>
      g.scope === 'struct-colocated' &&
      g.ownerStructHeader === headerPath
    );

    if (implColocatedGlobals.length > 0) {
      markGlobalsClaimed(implColocatedGlobals);
      const globalsDefSection = generateColocatedGlobalsImpl(
        implColocatedGlobals,
        options
      );
      implContent = implContent + '\n\n' + globalsDefSection;
    }

    // Body dep feedback: scan generated impl for type/function references not yet included
    {
      const existingIncludes = new Set(implIncludes);
      existingIncludes.add(headerPath);
      const newIncludes: string[] = [];

      // Same predicate as `implContent.includes(name)`, resolved for every name
      // in one pass over the file.
      const mentioned = dependencyNeedles.matchesIn(implContent);

      const addInclude = (path: string) => {
        if (!existingIncludes.has(path)) {
          existingIncludes.add(path);
          newIncludes.push(path);
        }
      };

      // Scan for function references — call sites, func-ptr literals, and the
      // address-taken names inside data initializers (the co-located block above
      // is already part of implContent).
      if (context.functionAddressMap) {
        const ambiguous: string[] = [];
        for (const [, target] of context.functionAddressMap) {
          const funcName = target.name;
          if (!mentioned.has(funcName)) continue;
          const candidates = funcNameCandidates.get(funcName);
          if (!candidates || candidates.length === 0) continue;
          if (candidates.length === 1) {
            addInclude(candidates[0].header);
          } else {
            ambiguous.push(funcName);
          }
        }
        // One bare name, several declaring headers: read the qualifier that is
        // actually written at the reference site. An emitted reference is a
        // SUFFIX of the declaration's qualified name — the enclosing namespace
        // is stripped off the front where it is redundant — so match by suffix.
        for (const funcName of ambiguous) {
          const candidates = funcNameCandidates.get(funcName)!;
          const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`((?:[A-Za-z_]\\w*::)+)${escaped}(?![A-Za-z0-9_])`, 'g');
          for (const m of implContent.matchAll(re)) {
            const observed = m[1] + funcName;
            for (const c of candidates) {
              if (c.qualified === observed || c.qualified.endsWith(`::${observed}`)) {
                addInclude(c.header);
              }
            }
          }
        }
      }

      // Scan for type references in bodies (casts, local vars, etc.)
      for (const [typeName, ownerPath] of typeOwnerMap) {
        if (existingIncludes.has(ownerPath)) continue;
        if (ownerPath === headerPath) continue;
        // Quick word-boundary check to avoid substring false positives
        if (mentioned.has(typeName)) {
          const re = new RegExp(`\\b${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          if (re.test(implContent)) {
            existingIncludes.add(ownerPath);
            newIncludes.push(ownerPath);
          }
        }
      }

      // Deref-chain closure: a body that walks `var->f1->f2->f3` accesses the
      // INTERMEDIATE struct types (f1's type, f2's type, …) by value, but those
      // type NAMES never appear as tokens — struct headers only forward-declare
      // pointer-field types. Resolve each chain's types and include their headers,
      // else "invalid use of incomplete type". Bounded by the chain depth itself.
      {
        const varType = new Map<string, string>();
        const addVar = (name: string, dt: string) => {
          const base = dt.replace(/\bconst\b/g, '').replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '').trim();
          if (base && !varType.has(name)) varType.set(name, base);
        };
        for (const fn of unitFunctions) {
          for (const p of fn.parameters ?? []) addVar(p.name, p.dataType);
          for (const v of fn.localVariables ?? []) addVar(v.name, v.dataType);
        }
        // body-declared locals: `TYPE name;` / `TYPE* name = …`
        for (const m of implContent.matchAll(/\b([A-Za-z_]\w*)\s*\*?\s*([A-Za-z_]\w*)\s*[=;]/g)) {
          if (structFieldTypes.has(m[1]) || structUnionEnumNames.has(m[1])) addVar(m[2], m[1]);
        }
        for (const cm of implContent.matchAll(/\b([A-Za-z_]\w*)((?:\s*->\s*[A-Za-z_]\w*)+)/g)) {
          let curType = varType.get(cm[1]);
          if (!curType) continue;
          for (const fm of cm[2].matchAll(/->\s*([A-Za-z_]\w*)/g)) {
            const owner = typeOwnerMap.get(curType);
            if (owner && !existingIncludes.has(owner) && owner !== headerPath) {
              existingIncludes.add(owner);
              newIncludes.push(owner);
            }
            const next = structFieldTypes.get(curType)?.get(fm[1]);
            if (!next) break;
            curType = next;
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
  //
  // The keep-set is compared against what readdir OBSERVES, and on a
  // case-insensitive filesystem those two spellings need not match. Two Ghidra
  // namespaces differing only in case (`D2Client::GAME` / `D2Client::Game`) are
  // two output directories here and ONE directory on disk: whichever spelling
  // mkdir created first is the name readdir reports for every file in it. Every
  // file written under the other spelling was then absent from the keep-set and
  // deleted — 21 headers this run had just written, three of them included by
  // globals.h, which fails every translation unit. So the comparison folds case
  // exactly when the output filesystem does.
  const ignoresCase = await outputFilesystemIgnoresCase(outputDir);
  const pruneKey = (p: string) => (ignoresCase ? p.toLowerCase() : p);
  let prunedCount = 0;
  const pruneFailures: string[] = [];
  try {
    const keep = new Set(writtenFiles.map(p => pruneKey(path.resolve(p))));
    const PRUNE = /(\.(cpp|cc|c|h|hpp)$|\.map$|(^|[\\/])CMakeLists\.txt$)/;
    const entries = await fs.readdir(outputDir, { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = path.resolve((e as { parentPath?: string; path?: string }).parentPath ?? e.path ?? outputDir, e.name);
      const rel = path.relative(outputDir, abs);
      if (!PRUNE.test(rel)) continue;
      if (keep.has(pruneKey(abs))) continue;
      try {
        await fs.unlink(abs);
        prunedCount++;
      } catch (err) {
        pruneFailures.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Remove directories left empty by the prune (deepest first). ENOTEMPTY is
    // the normal outcome for a directory that still holds output and is not a
    // failure; anything else is.
    const dirs = (await fs.readdir(outputDir, { recursive: true, withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => path.resolve((e as { parentPath?: string; path?: string }).parentPath ?? e.path ?? outputDir, e.name))
      .sort((a, b) => b.length - a.length);
    for (const d of dirs) {
      try {
        await fs.rmdir(d);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EEXIST') continue;
        pruneFailures.push(`${path.relative(outputDir, d)}/: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    // A prune that fails silently leaves stale files behind, and stale files are
    // counted by every measurement taken off this tree — six strays once
    // inflated one by 14. Never swallow it.
    console.warn(`warning: stale-file prune failed, the output tree may contain files this run did not write: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pruneFailures.length > 0) {
    console.warn(`warning: stale-file prune could not remove ${pruneFailures.length} path(s); they remain in the output tree:`);
    for (const f of pruneFailures.slice(0, 10)) console.warn(`  ${f}`);
    if (pruneFailures.length > 10) console.warn(`  ... and ${pruneFailures.length - 10} more`);
  }
  if (prunedCount > 0) {
    console.log(`Pruned ${prunedCount} stale file(s) this run did not write`);
  }

  return writtenFiles;
}

/**
 * Does the filesystem under `dir` ignore case in file names?
 *
 * Probed, not assumed from `process.platform`: a case-sensitive volume mounted
 * on macOS and a case-insensitive one on Linux both exist, and getting this
 * wrong deletes freshly written output.
 */
async function outputFilesystemIgnoresCase(dir: string): Promise<boolean> {
  const probe = path.join(dir, '.ghidra-recon-case-probe');
  try {
    await fs.writeFile(probe, '', 'utf-8');
    try {
      await fs.stat(path.join(dir, '.GHIDRA-RECON-CASE-PROBE'));
      return true;
    } catch {
      return false;
    }
  } catch {
    // Cannot probe — assume the filesystem folds case, which is the safe
    // direction: the prune then keeps a file it is unsure about instead of
    // deleting one the run just wrote.
    return true;
  } finally {
    await fs.unlink(probe).catch(() => {});
  }
}

/**
 * Normalized signature key for a prototype: `ret(a,b,c)`, each type spelled the
 * way the emitted header spells it, so two keys compare exactly as the compiler
 * compares the two types.
 */
function signatureKey(returnType: string, paramTypes: string[]): string {
  const spell = (t: string) =>
    collapseFuncPtrTypedef(normalizeSignatureType(t ?? ''), isFuncDefTypedefName)
      .replace(/\s+/g, ' ')
      .trim();
  const params = paramTypes.map(spell).filter(t => t !== '' && t !== 'void');
  return `${spell(returnType)}(${params.join(',')})`;
}

/**
 * Index a name under both its qualified and its bare spelling — a call site may
 * write either. A key claimed by two different signatures is ambiguous and is
 * dropped rather than guessed at.
 *
 * EVERY key goes through that guard, the qualified one included. An
 * UNNAMESPACED function has qualified === bare, so writing the qualified key
 * unconditionally silently overwrote whatever a namespaced function had already
 * claimed for that bare name — the table then bound one name to the other
 * symbol's signature, which compiles and is wrong. Two functions sharing a
 * fully-qualified name land in the same trap.
 */
function indexBothSpellings<T>(
  into: Record<string, T>,
  ambiguous: Set<string>,
  qualified: string,
  bare: string,
  value: T,
  same: (a: T, b: T) => boolean,
): void {
  const keys = bare === qualified ? [qualified] : [qualified, bare];
  for (const key of keys) {
    if (ambiguous.has(key)) continue;
    const existing = into[key];
    if (existing !== undefined && !same(existing, value)) {
      ambiguous.add(key);
      delete into[key];
      continue;
    }
    into[key] = value;
  }
}

/** Ghidra's placeholder name for an anonymous aggregate inside another type. */
const ANONYMOUS_AGGREGATE_RE = /^_(struct|union)_\d+$/;

/** Win32 integer spellings the winsock claim must not depend on <windows.h> for. */
const WINSOCK_SCALARS: Record<string, string> = {
  UCHAR: 'unsigned char',
  BYTE: 'unsigned char',
  UINT8: 'unsigned char',
  USHORT: 'unsigned short',
  WORD: 'unsigned short',
  UINT16: 'unsigned short',
  ULONG: 'unsigned long',
  DWORD: 'unsigned long',
  UINT32: 'unsigned long',
  u_char: 'unsigned char',
  u_short: 'unsigned short',
  u_long: 'unsigned long',
};

/**
 * `in_addr`, spelled the way Ghidra models it, claimed before <winsock2.h>.
 *
 * Ghidra names the anonymous union inside `in_addr` (`_union_1226`) and the two
 * anonymous structs inside that union (`_struct_1227`, `_struct_1228`), and
 * decompiled bodies cast through those names. mingw's `inaddr.h` declares the
 * very same layout with all three left unnamed, so the names never meet:
 * `(in_addr)pDVar1->ipAddress.S_un.S_un_b` is a conversion between two spellings
 * of one 4-byte object that the compiler sees as unrelated types.
 *
 * `inaddr.h` guards its whole body on `#ifndef s_addr`, so emitting the same
 * struct first — with Ghidra's names on the nested aggregates — and defining
 * that guard makes the vendor header a no-op and the two spellings one type.
 * The layout is unchanged (union of a 4-byte struct, a 2-short struct and a
 * 32-bit integer, all at offset 0), so nothing about the object moves; only the
 * nested types gain the names Ghidra already uses for them.
 *
 * The constructors are the Ghidra decompiler's `(in_addr)dword` and
 * `(in_addr)S_un_b` renderings, which are reinterpretations of one 4-byte value,
 * written as the member store they stand for. Each one is total and lossless;
 * none of them can hide a wrong type, because every alternative is the same four
 * bytes.
 *
 * Emitted ONLY when Ghidra's model matches winsock's shape exactly — the member
 * names below are baked into the `s_host`/`s_net`/... macros the vendor header
 * would otherwise supply. Any other shape falls back to the generic anonymous
 * aggregate path.
 */
export function buildWinsockInAddrClaim(
  dataTypes: ExtractedDataType[],
): { lines: string[]; claimed: Set<string> } {
  const empty = { lines: [] as string[], claimed: new Set<string>() };
  const byName = new Map<string, ExtractedDataType>();
  for (const dt of dataTypes) byName.set(dt.name, dt);

  const fieldsOf = (dt: ExtractedDataType | undefined) =>
    (dt as import('../types.js').ExtractedStruct | undefined)?.fields ?? [];

  const inAddr = byName.get('in_addr');
  if (!inAddr || inAddr.kind !== 'STRUCTURE') return empty;
  const outer = fieldsOf(inAddr);
  if (outer.length !== 1 || outer[0].name !== 'S_un') return empty;

  const unionName = outer[0].dataType;
  if (!ANONYMOUS_AGGREGATE_RE.test(unionName)) return empty;
  const un = byName.get(unionName);
  if (!un || un.kind !== 'UNION') return empty;

  const unFields = fieldsOf(un);
  const byMember = new Map(unFields.map(f => [f.name, f]));
  const bytes = byMember.get('S_un_b');
  const words = byMember.get('S_un_w');
  const addr = byMember.get('S_addr');
  if (unFields.length !== 3 || !bytes || !words || !addr) return empty;
  if (unFields.some(f => f.offset !== 0)) return empty;

  const byteStruct = byName.get(bytes.dataType);
  const wordStruct = byName.get(words.dataType);
  if (!byteStruct || byteStruct.kind !== 'STRUCTURE') return empty;
  if (!wordStruct || wordStruct.kind !== 'STRUCTURE') return empty;
  if (!ANONYMOUS_AGGREGATE_RE.test(byteStruct.name)) return empty;
  if (!ANONYMOUS_AGGREGATE_RE.test(wordStruct.name)) return empty;

  const byteFields = fieldsOf(byteStruct);
  const wordFields = fieldsOf(wordStruct);
  const expectNames = (fs: typeof byteFields, names: string[]) =>
    fs.length === names.length && fs.every((f, i) => f.name === names[i]);
  if (!expectNames(byteFields, ['s_b1', 's_b2', 's_b3', 's_b4'])) return empty;
  if (!expectNames(wordFields, ['s_w1', 's_w2'])) return empty;

  const scalar = (t: string): string | undefined => WINSOCK_SCALARS[t.trim()];
  const byteType = scalar(byteFields[0].dataType);
  const wordType = scalar(wordFields[0].dataType);
  const addrType = scalar(addr.dataType);
  if (!byteType || !wordType || !addrType) return empty;
  if (byteFields.some(f => scalar(f.dataType) !== byteType)) return empty;
  if (wordFields.some(f => scalar(f.dataType) !== wordType)) return empty;

  const B = byteStruct.name;
  const W = wordStruct.name;
  const U = un.name;

  const lines = [
    "// in_addr, with Ghidra's names on the nested anonymous aggregates. Claimed",
    '// before <winsock2.h>, whose inaddr.h is guarded on `s_addr` and so becomes',
    '// a no-op. Same layout, same members, same offsets — the union spellings',
    "// decompiled bodies cast through are simply no longer a separate type.",
    '#  ifndef s_addr',
    `struct ${B} { ${byteFields.map(f => `${byteType} ${f.name};`).join(' ')} };`,
    `struct ${W} { ${wordFields.map(f => `${wordType} ${f.name};`).join(' ')} };`,
    `union ${U} {`,
    `    ${B} S_un_b;`,
    `    ${W} S_un_w;`,
    `    ${addrType} S_addr;`,
    `    ${U}() : S_addr(0) {}`,
    `    ${U}(${addrType} a) : S_addr(a) {}`,
    `    ${U}(${B} b) : S_un_b(b) {}`,
    `    ${U}(${W} w) : S_un_w(w) {}`,
    `    operator ${addrType}() const { return S_addr; }`,
    '};',
    'typedef struct in_addr {',
    `    ${U} S_un;`,
    '    in_addr() {}',
    `    in_addr(${U} u) : S_un(u) {}`,
    `    in_addr(${addrType} a) : S_un(a) {}`,
    `    in_addr(${B} b) : S_un(b) {}`,
    `    in_addr(${W} w) : S_un(w) {}`,
    '} IN_ADDR, *PIN_ADDR, *LPIN_ADDR;',
    '#    define s_addr  S_un.S_addr',
    '#    define s_host  S_un.S_un_b.s_b2',
    '#    define s_net   S_un.S_un_b.s_b1',
    '#    define s_imp   S_un.S_un_w.s_w2',
    '#    define s_impno S_un.S_un_b.s_b4',
    '#    define s_lh    S_un.S_un_b.s_b3',
    '#  endif  // s_addr',
  ];

  return { lines, claimed: new Set([B, W, U]) };
}

/**
 * Definitions for the anonymous struct/union members of system types, in
 * dependency order (`_union_1226` holds a `_struct_1227`). They are declared by
 * no real header — Ghidra invented the names — but bodies read their fields, so
 * they have to be emitted somewhere every translation unit sees.
 */
function buildAnonymousAggregateDefs(
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  alreadyClaimed: ReadonlySet<string> = new Set(),
): string[] {
  const anon = new Map<string, ExtractedDataType>();
  for (const dt of dataTypes) {
    if (!ANONYMOUS_AGGREGATE_RE.test(dt.name)) continue;
    // Emitted earlier, next to the system struct they are members of.
    if (alreadyClaimed.has(dt.name)) continue;
    const fields = (dt as import('../types.js').ExtractedStruct).fields ?? [];
    // Ghidra spells an UNNAMED member `null`, and two of them in one aggregate
    // cannot both be declared. Such a type cannot be emitted faithfully, so it
    // is left out rather than emitted wrong — d2_platform.h is force-included
    // everywhere and one bad definition breaks every file.
    const names = new Set(fields.map(f => f.name));
    if (names.size !== fields.length) continue;
    if ([...names].some(n => !/^[A-Za-z_]\w*$/.test(n ?? ''))) continue;
    anon.set(dt.name, dt);
  }
  if (anon.size === 0) return [];

  // Only the ones a body actually names — the rest are members of system structs
  // nothing decompiled ever touches.
  const wanted = new Set<string>();
  for (const fn of functions) {
    const body = fn.decompiled;
    if (!body) continue;
    for (const name of anon.keys()) {
      if (!wanted.has(name) && body.includes(name)) wanted.add(name);
    }
  }
  if (wanted.size === 0) return [];

  const defs: string[] = [];
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (emitted.has(name) || visiting.has(name)) return;
    const dt = anon.get(name);
    if (!dt) return;
    visiting.add(name);
    for (const f of (dt as import('../types.js').ExtractedStruct).fields ?? []) {
      const base = (f.dataType ?? '').replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '').trim();
      if (base !== name && anon.has(base)) visit(base);
    }
    visiting.delete(name);
    emitted.add(name);
    defs.push(emitAnonymousAggregate(dt));
  };
  for (const name of wanted) visit(name);
  return defs;
}

/**
 * Emit one anonymous aggregate verbatim from its Ghidra field list.
 *
 * The shared struct emitter cannot be used here: it runs field types through the
 * platform-type filter, which classifies `_struct_1227` as an artifact and
 * rewrites it to a same-sized scalar — erasing the very member the body reads.
 */
function emitAnonymousAggregate(dt: ExtractedDataType): string {
  const keyword = dt.kind === 'UNION' ? 'union' : 'struct';
  const fields = (dt as import('../types.js').ExtractedStruct).fields ?? [];
  const lines = [`${keyword} ${dt.name} {`];
  for (const f of fields) {
    lines.push(`    ${normalizeSignatureType(f.dataType ?? 'uint8_t')} ${f.name};`);
  }
  lines.push('};');
  return lines.join('\n');
}

/**
 * Every symbol name a data initializer takes the address of, across all globals.
 * Ghidra hands interior references back too (`Tbl[3].pField`, `DAT_x+1`); the
 * LEADING identifier is the symbol that must be declared.
 */
function collectInitializerReferencedNames(globals: AnalyzedDataSymbol[]): Set<string> {
  const names = new Set<string>();
  const walk = (dv: DataValue | undefined): void => {
    if (!dv) return;
    if (dv.kind === 'pointer' && dv.value) {
      const m = dv.value.match(/^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)/);
      if (m) names.add(m[1]);
    }
    for (const e of dv.elements ?? []) walk(e);
    for (const f of dv.fields ?? []) walk(f.value);
  };
  for (const g of globals) walk(g.initializedData);
  return names;
}

/** @see the call site — restores static-locals that a file-scope initializer names. */
function promoteInitializerReferencedStaticLocals(globals: AnalyzedDataSymbol[]): number {
  const referenced = collectInitializerReferencedNames(globals);
  if (referenced.size === 0) return 0;
  let promoted = 0;
  for (const g of globals) {
    if (g.scope !== 'static-local') continue;
    const name = g.suggestedName || g.name;
    if (!referenced.has(name)) continue;
    g.scope = 'global';
    g.ownerFunction = undefined;
    promoted++;
  }
  return promoted;
}

/**
 * The funcdef a declaration spelling names, or undefined when it names anything
 * else. Ghidra writes a function-pointer slot as the funcdef with one star, and
 * where the type is used directly with none; more indirection than that is a
 * pointer TO a function pointer, whose call shape this does not model.
 *
 * The star carries a POINTER WIDTH more often than not — `fnFindPlayerToken *32`
 * is how a 32-bit pointer is spelled in a database whose default width differs,
 * and it is the spelling most of these fields actually use. Reading only a bare
 * star finds the minority of them, which looks like the mechanism working.
 */
export function funcdefBaseName(
  spelling: string, funcdefDecls: Record<string, unknown>,
): string | undefined {
  let s = spelling.replace(/\b(const|volatile)\b/g, ' ').trim();
  let stars = 0;
  for (;;) {
    const m = s.match(/\*\d*$/);
    if (!m) break;
    stars++;
    s = s.slice(0, -m[0].length).trim();
  }
  if (stars > 1 || !s || !/^[A-Za-z_]\w*$/.test(s)) return undefined;
  return funcdefDecls[s] !== undefined ? s : undefined;
}

function buildFuncPtrArgCastTables(
  functions: ExtractedFunction[],
  globals: AnalyzedDataSymbol[],
  funcDefs: import('../types.js').ExtractedFunctionDefinition[],
  dataTypes: ExtractedDataType[],
): FuncPtrArgCastTables {
  const funcdefSignatures: Record<string, string> = {};
  for (const fd of funcDefs) {
    funcdefSignatures[fd.name] = signatureKey(
      fd.returnType,
      [...(fd.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal).map(p => p.dataType),
    );
  }

  // The same funcdefs, kept as DECLARATION SPELLINGS rather than as a comparison
  // key. A call made through a function-pointer field or variable has no callee
  // name, so no name table can say what it returns or what it takes - the
  // funcdef the slot is declared with is the only record of that contract, and
  // it is spelled here exactly as the emitted typedef spells it.
  const funcdefDecls: Record<string, import('./impl.js').FuncdefDecl> = {};
  for (const fd of funcDefs) {
    if (!fd.name) continue;
    funcdefDecls[fd.name] = {
      returnType: sigType(fd.returnType ?? 'void'),
      paramTypes: [...(fd.parameters ?? [])]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(p => sigType(p.dataType ?? '')),
      varArgs: fd.hasVarArgs === true,
    };
  }

  // A funcdef typedef whose name is ALSO a function name is HIDDEN by that
  // function inside its namespace, so `(fpRequiredUserAction)f` parses as a call
  // rather than a cast ("expected ')' before 'f'"). The typedef itself is always
  // emitted at ROOT scope, so the cast just has to say so: `(::fpRequired...)f`.
  const bareFunctionNames = new Set<string>();
  for (const fn of functions) if (fn.name) bareFunctionNames.add(fn.name);
  const rootQualifiedTypedefs = Object.keys(funcdefSignatures).filter(n => bareFunctionNames.has(n));

  const functionSignatures: Record<string, string> = {};
  const paramFuncdefs: Record<string, Record<number, string>> = {};
  const ambiguousSig = new Set<string>();
  const ambiguousSlots = new Set<string>();
  const sameString = (a: string, b: string) => a === b;
  const sameSlots = (a: Record<number, string>, b: Record<number, string>) =>
    JSON.stringify(a) === JSON.stringify(b);

  for (const fn of functions) {
    if (!fn.name) continue;
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;

    indexBothSpellings(
      functionSignatures, ambiguousSig, qualified, fn.name,
      signatureKey(fn.returnType ?? 'void', params.map(p => p.dataType)), sameString,
    );

    // Which of this function's own parameters are declared with a funcdef typedef?
    const slots: Record<number, string> = {};
    params.forEach((p, i) => {
      const base = (p.dataType ?? '').replace(/[*&]/g, '').replace(/\bconst\b/g, '').trim();
      if (base && funcdefSignatures[base] !== undefined) slots[i] = base;
      // A plain `void*` parameter takes a function address at some call sites.
      // C++ has no implicit function-pointer-to-`void*` conversion at all, so
      // the cast the original source wrote is the only spelling that compiles.
      else if (isVoidPointerSpelling(p.dataType)) slots[i] = VOID_POINTER_SLOT;
    });
    if (Object.keys(slots).length === 0) continue;
    indexBothSpellings(paramFuncdefs, ambiguousSlots, qualified, fn.name, slots, sameSlots);
  }

  const variableNames = [...new Set(globals.map(g => g.suggestedName || g.name).filter(Boolean))];

  // Field names whose declared type is `void*` in EVERY struct/union that
  // declares them. A member access alone does not say which struct it walked,
  // so a name that means `void*` in one type and a funcdef in another is
  // dropped rather than guessed at.
  const fieldTypeSpellings = new Map<string, Set<string>>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (!('fields' in dt)) continue;
    for (const f of (dt as import('../types.js').ExtractedStruct).fields ?? []) {
      if (!f.name) continue;
      let seen = fieldTypeSpellings.get(f.name);
      if (!seen) { seen = new Set(); fieldTypeSpellings.set(f.name, seen); }
      seen.add(isVoidPointerSpelling(f.dataType) ? 'void*' : (f.dataType ?? '').replace(/\s+/g, ''));
    }
  }
  const voidPointerFields: string[] = [];
  for (const [name, spellings] of fieldTypeSpellings) {
    if (spellings.size === 1 && spellings.has('void*')) voidPointerFields.push(name);
  }

  // Field name → its declared type, but ONLY where every struct and union that
  // declares that name agrees. A member access does not say which aggregate it
  // walked, so a name that means one type here and another there is dropped
  // rather than guessed at - the same rule `voidPointerFields` runs on.
  const fieldDeclSpellings = new Map<string, Set<string>>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (!('fields' in dt)) continue;
    for (const f of (dt as import('../types.js').ExtractedStruct).fields ?? []) {
      if (!f.name || !f.dataType) continue;
      const spelled = emittedFieldType(f.dataType, f.size);
      if (!spelled) continue;
      let seen = fieldDeclSpellings.get(f.name);
      if (!seen) { seen = new Set(); fieldDeclSpellings.set(f.name, seen); }
      seen.add(spelled);
    }
  }
  const fieldTypes: Record<string, string> = {};
  for (const [name, spellings] of fieldDeclSpellings) {
    if (spellings.size === 1) fieldTypes[name] = [...spellings][0];
  }

  // The same field types, but keyed by the aggregate that declares them. Where
  // the expression walked says WHICH struct it is walking, this is exact and the
  // unanimity rule above does not have to apply - `pNext` may mean a different
  // type in every struct and still be known in each one.
  const structFields: Record<string, Record<string, string>> = {};
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (!('fields' in dt) || !dt.name) continue;
    const into: Record<string, string> = structFields[dt.name] ?? (structFields[dt.name] = {});
    for (const f of (dt as import('../types.js').ExtractedStruct).fields ?? []) {
      if (!f.name || !f.dataType) continue;
      const spelled = emittedFieldType(f.dataType, f.size);
      if (spelled) into[f.name] = spelled;
    }
  }

  // Every member name the emitted declaration of each aggregate carries -
  // taken from the header emitter itself, not rebuilt from its naming rules.
  // `structFields` cannot answer "does this aggregate declare X": it is keyed on
  // Ghidra's field names and so holds nothing for the unnamed filler bytes and
  // bitfield members the header emits under manufactured names, which is exactly
  // where a decompiled body's `field_0xN` alias has to be checked.
  const aggregateMembers: Record<string, string[]> = {};
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (!dt.name) continue;
    aggregateMembers[dt.name] = [...emittedMemberNames(dt)];
  }

  // Which fields hold a FUNCTION POINTER, and which funcdef declares its
  // contract. `structFields` cannot answer this: a funcdef field is emitted as
  // an inline declarator (`void *(*pfnLoad)()`), which `emittedFieldType`
  // rejects because the name sits in the middle of the spelling - so the type of
  // every such field is dropped there and a call through one has no signature at
  // all. Read off the raw Ghidra spelling instead, which names the funcdef.
  const structFieldFuncdefs: Record<string, Record<string, string>> = {};
  const fieldFuncdefSpellings = new Map<string, Set<string>>();
  // Field names some aggregate declares with a type that is NOT a funcdef. That
  // is the real disagreement — not the mere presence of the name in
  // `fieldDeclSpellings`, which now records funcdef fields too (they render as
  // the bare typedef once the redundant pointer is peeled).
  const fieldNonFuncdefNames = new Set<string>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    if (!('fields' in dt)) continue;
    for (const f of (dt as import('../types.js').ExtractedStruct).fields ?? []) {
      if (!f.name || !f.dataType) continue;
      const fd = funcdefBaseName(f.dataType, funcdefDecls);
      if (!fd) { fieldNonFuncdefNames.add(f.name); continue; }
      if (dt.name) (structFieldFuncdefs[dt.name] ??= {})[f.name] = fd;
      let seen = fieldFuncdefSpellings.get(f.name);
      if (!seen) { seen = new Set(); fieldFuncdefSpellings.set(f.name, seen); }
      seen.add(fd);
    }
  }
  // A member access alone does not say which aggregate it walked, so a field
  // name two types declare with DIFFERENT funcdefs is dropped rather than
  // guessed at - the same unanimity rule `fieldTypes` runs on. A name that is a
  // funcdef in one struct and an ordinary field in another is dropped too: the
  // second declaration is a disagreement about the contract, not a silence.
  const fieldFuncdefs: Record<string, string> = {};
  for (const [name, spellings] of fieldFuncdefSpellings) {
    if (spellings.size !== 1) continue;
    if (fieldNonFuncdefNames.has(name)) continue;
    fieldFuncdefs[name] = [...spellings][0];
  }

  // Ghidra's decompiler emits C, where `void*` converts to any object pointer
  // implicitly. C++ requires the cast, and the original MSVC source carried it.
  const voidPointerFunctions = new Set<string>();
  const ambiguousReturn = new Set<string>();
  for (const fn of functions) {
    if (!fn.name) continue;
    const ret = normalizeSignatureType(fn.returnType ?? '').replace(/\s+/g, ' ').trim();
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    if (ret !== 'void *' && ret !== 'void*') {
      // A bare name claimed by a function that does NOT return void* is not safe
      // to key on — the call site may mean that one.
      ambiguousReturn.add(fn.name);
      voidPointerFunctions.delete(fn.name);
      continue;
    }
    voidPointerFunctions.add(qualified);
    if (!ambiguousReturn.has(fn.name)) voidPointerFunctions.add(fn.name);
  }

  // The declared type of every callable's parameters and of every global, in
  // the SAME spelling the declaration is emitted with. A call argument whose own
  // type differs from the slot it fills was an implicit conversion in the C the
  // decompiler emits; C++ has no such conversion between unrelated pointers, so
  // the cast has to be written. Both spellings are indexed because a call site
  // may write either, and a bare name claimed by two different parameter lists
  // is dropped rather than guessed at.
  // A call site spells the callee with whatever suffix of its qualified name
  // resolves from where the call sits, and the namespace path a function is
  // EMITTED under is the module's, not the one Ghidra recorded — so `Units::f`
  // in the model is written `D2Common::Units::f` at the call. Every suffix is
  // therefore indexed, and any suffix two functions disagree over is dropped:
  // a slot whose type is not certain is one this must not cast into.
  const functionParamTypes: Record<string, string[]> = {};
  const functionReturnTypes: Record<string, string> = {};
  // Every spelling that denotes a FUNCTION. Unlike the tables above this one is
  // not pruned on disagreement: two functions sharing a bare name disagree about
  // the SIGNATURE, not about being functions, and a pass that only needs to know
  // "this identifier is not an object" must not lose the name to that collision.
  const functionNames = new Set<string>();
  // Bare names more than one function carries. Every such name is an OVERLOAD
  // SET at any scope that sees both — the emitter files a function under the
  // namespace of its directory, so the per-file `Draw`s of `D2Win/Src/*.cpp` all
  // land in `D2Win::Src` — and a cast reduces an overload set only on an EXACT
  // function type. That is precisely what a funcdef-slot cast is not, so both
  // cast passes spell the function's own type first.
  const bareNameOwners = new Map<string, Set<string>>();
  const varArgFunctions = new Set<string>();
  const paramTypeClaims = new Map<string, Set<string>>();
  const returnTypeClaims = new Map<string, Set<string>>();
  const varArgClaims = new Map<string, Set<string>>();
  const nameSuffixes = (qualified: string): string[] => {
    const parts = qualified.split('::');
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('::'));
    return out;
  };
  const claim = <T>(
    into: Record<string, T>, claims: Map<string, Set<string>>,
    key: string, value: T, spelling: string,
  ): void => {
    let seen = claims.get(key);
    if (!seen) { seen = new Set(); claims.set(key, seen); }
    seen.add(spelling);
    if (seen.size > 1) { delete into[key]; return; }
    into[key] = value;
  };
  // A callee whose declaration the EMITTER writes — a Win32 stub, an inline
  // forwarder, a CRT name a system header declares, an excluded-namespace decl —
  // is compiled against that declaration, not against Ghidra's record of it, and
  // the two routinely disagree: `winuser.h` says `int wsprintfA(LPSTR, LPCSTR,
  // ...)` where the database says `void wsprintfA(undefined4, undefined4,
  // undefined4, undefined4)`. Casting an argument to the database's answer
  // spells a conversion the real declaration rejects, so these names carry no
  // parameter or return types at all. They stay in `functionNames`: the fact
  // that the identifier denotes a function is not in doubt.
  const headerOwned = platformDeclaredFunctionNames();
  for (const fn of functions) {
    if (!fn.name) continue;
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    const paramSpellings = params.map(p => sigType(p.dataType ?? ''));
    const returnSpelling = sigType(fn.returnType ?? 'void');
    let owners = bareNameOwners.get(fn.name);
    if (!owners) { owners = new Set(); bareNameOwners.set(fn.name, owners); }
    owners.add(qualified);
    for (const key of nameSuffixes(qualified)) {
      functionNames.add(key);
      if (!headerOwned.has(key)) {
        claim(functionParamTypes, paramTypeClaims, key, paramSpellings, paramSpellings.join('|'));
        claim(functionReturnTypes, returnTypeClaims, key, returnSpelling, returnSpelling);
      }
      let va = varArgClaims.get(key);
      if (!va) { va = new Set(); varArgClaims.set(key, va); }
      va.add(fn.hasVarArgs ? 'yes' : 'no');
      if (fn.hasVarArgs) varArgFunctions.add(key);
    }
  }
  // A name some overload spells with `...` is never safe to index positionally.
  for (const [key, seen] of varArgClaims) {
    if (seen.size > 1 || seen.has('yes')) { varArgFunctions.add(key); }
  }

  const globalTypes: Record<string, string> = {};
  const ambiguousGlobalTypes = new Set<string>();
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (!name || /[^A-Za-z0-9_]/.test(name)) continue;
    const spelled = normalizeGlobalDeclType(g.suggestedType || g.dataType || '');
    if (!spelled) continue;
    if (ambiguousGlobalTypes.has(name)) continue;
    const existing = globalTypes[name];
    if (existing !== undefined && existing !== spelled) {
      ambiguousGlobalTypes.add(name);
      delete globalTypes[name];
      continue;
    }
    globalTypes[name] = spelled;
  }

  // Typedef name → the spelling it stands for. Windows and Ghidra both hide
  // indirection inside a name (`HACCEL` IS `HACCEL__ *`), so without this a
  // pointer stored into such a slot reads as an integer store and no cast is
  // written. Self-referential entries are Ghidra artefacts (`FARPROC ->
  // FARPROC *`) and are dropped rather than followed.
  const typedefTargets: Record<string, string> = { ...EMITTER_POINTER_TYPEDEFS };
  for (const dt of dataTypes) {
    if (dt.kind !== 'TYPEDEF') continue;
    const under = (dt as import('../types.js').ExtractedTypedef).underlyingType;
    if (!dt.name || !under) continue;
    if (under.replace(/[*&\s]/g, '') === dt.name) continue;
    typedefTargets[dt.name] = under;
  }

  if (process.env.RECON_DUMP_TABLES) {
    const probe = (process.env.RECON_DUMP_TABLES || '').split(',');
    for (const k of probe) {
      console.error(`[probe] ${k}: params=${JSON.stringify(functionParamTypes[k])} ret=${JSON.stringify(functionReturnTypes[k])} isFn=${functionNames.has(k)} varArg=${varArgFunctions.has(k)} isVar=${variableNames.includes(k)} global=${JSON.stringify(globalTypes[k])} funcdefSlots=${JSON.stringify(paramFuncdefs[k])}`);
    }
  }
  return {
    paramFuncdefs,
    zeroArityCallbackSlots: WIN32_ZERO_ARITY_CALLBACK_SLOTS,
    funcdefSignatures,
    functionSignatures,
    variableNames,
    voidPointerFunctions: [...voidPointerFunctions],
    rootQualifiedTypedefs,
    voidPointerFields,
    functionParamTypes,
    functionReturnTypes,
    functionNames: [...functionNames],
    overloadedFunctionNames: [...bareNameOwners].filter(([, o]) => o.size > 1).map(([n]) => n),
    globalTypes,
    varArgFunctions: [...varArgFunctions],
    fieldTypes,
    typedefTargets,
    structFields,
    aggregateMembers,
    funcdefDecls,
    structFieldFuncdefs,
    fieldFuncdefs,
  };
}


/** Ghidra's "no information" return types — see reconcileUndefinedReturnTypes. */
const UNCURATED_RETURN_TYPES = new Set([
  'undefined', 'undefined1', 'undefined2', 'undefined3', 'undefined4',
  'undefined5', 'undefined6', 'undefined7', 'undefined8',
]);

/**
 * Replace an uncurated (`undefined*`) return type with the one the decompiler
 * resolved for the body that will be emitted under it, so the signature and the
 * body cannot disagree about whether the function returns a value.
 *
 * Only `undefined*` is overridden. A database field that says anything else is
 * a curated answer and is left alone even when the decompiler disagrees — and a
 * body whose prototype cannot be read keeps the database's answer too.
 */
function reconcileUndefinedReturnTypes(functions: ExtractedFunction[]): void {
  for (const fn of functions) {
    const declared = (fn.returnType ?? '').trim();
    if (!UNCURATED_RETURN_TYPES.has(declared)) continue;
    const resolved = decompiledReturnType(fn.decompiled);
    if (!resolved || resolved === declared) continue;
    // Guard against a prototype line that parsed into something that is not a
    // type at all (a stray comment, an unusual header) — only accept a plain
    // type spelling.
    if (!/^[A-Za-z_][\w:]*(\s*\*+)?$/.test(resolved)) continue;
    fn.returnType = resolved;
  }
}


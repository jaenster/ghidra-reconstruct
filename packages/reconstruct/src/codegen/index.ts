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
  ExtractedString,
} from '../types.js';
import { resolveOverridePlaceholders } from './impl.js';
import {
  VOID_POINTER_SLOT,
  getFuncPtrArgCastArityMismatchList,
  addressLiteralFloor,
  ADDRESS_LITERAL_CEILING,
  ADDRESS_LITERAL_COMPLEMENT_FLOOR,
  type FuncPtrTarget,
} from '@ghidra-mcp/cpp-parser';

import { fieldDeclSpelling, emittedMemberNames, generateHeader, generateFunctionDeclaration, setKnownFuncDefs, sigType, getIntegerConversionType, emittedFunctionName, returnSigType } from './header.js';
import { generateImplementation, setQuestStructLayouts, setStructFieldRenames, decompiledReturnType, decompiledFunctionName, type ImplGenContext, type FuncPtrArgCastTables, type ThunkForward } from './impl.js';
import { generateCMakeLists, generateTopLevelCMake, generateTargetCMake, generateUnsortedCMake } from './cmake.js';
import { generateSourceMap } from './sourcemap.js';
import { generateReadme } from './readme.js';
import { conventionKeyword } from './calling-convention.js';
import { organizeByNamespace, getFilePath, setModuleNames, setNamespaceCollisionTypes, normalizeQualifiedReference } from './namespace.js';
import { buildNamespaceResolution, namespaceResolution, renderNamespace } from './namespace-resolution.js';
import { setInteriorLabelSymbols, resetDeclaredNames, recordDeclaredName, setDeclarationClosureModel, setDeclarationClosureEmitters, setDeclarationClosureDataContent, getDeclarationClosureReport, isUnreferenceableArtifact, sanitizeSymbolName, sanitizeQualifiedReference, setCentralInitializerScope, promoteCentrallyReferencedGlobals, generateGlobalsHeader, generateGlobalsImpl, generateColocatedGlobalsImpl, setKnownFuncDefTypedefs, setKnownEnumConstants, getKnownEnumConstants, setMultidimArrayGlobals, setGlobalInitializerTypes, reconcileOrphanedGlobals, markGlobalsClaimed, setKnownNamespaces, isFuncDefTypedefName, reportGlobalsTakingATypeName, resolveListingBuiltinBlobs, setInitializerSignatureTables, setInitializerAddressTable, getInitializerFuncPtrArityMismatches, normalizeGlobalDeclType, emittedNamespaceOf } from './globals-header.js';
import { normalizeDataAddress, stringDefinition } from './declaration-closure.js';
import { harvestAnnotatedParameterTypes } from './win32-signatures.js';
import { isPlatformOrBuiltinType, isLibraryType, generatePlatformHeader, arrayRowTypedefLines, arrayRowReturn, arrayRowSpelling, GHIDRA_PSEUDO_OP_RESULT_TYPES, normalizeSignatureType, collapseFuncPtrTypedef, setShadowedTypeNames, setAggregateTypeNames, setDeclaredTypeNames, isVoidPointerSpelling, platformDeclaredFunctionNames, platformDefinedFunctionNames, platformVoidPointerFunctionNames, EMITTER_POINTER_TYPEDEFS } from './platform-types.js';
import { createOverrideRegistry } from '../overrides/index.js';
import { createLibraryRegistry } from '../library/index.js';
import { createMethodConversionRegistry, getOrCreateRegistry, applyMethodConversions, detectMethodConversionsFromTags, type MethodCallMapping, type MethodConversionRegistry } from '../methods/index.js';
import type { MethodConversionEntry, ModuleConfig, AutoMethodConversionConfig, TypeOwnershipEntry } from '../config/schema.js';
import { partitionGlobalsByModule, buildFunctionModuleMap } from './globals-partition.js';
import { normalizeAddress } from '../config/loader.js';
import { resolveTargets, getTargetDirectory, type ResolvedTarget } from '../targets/index.js';
import { generateStubsHeader } from '../targets/stubs.js';
import { collectCrtHeaders, EXCLUDED_SYMBOL_DECLS, declaredIdentifier, WIN32_ZERO_ARITY_CALLBACK_SLOTS, WIN32_ZERO_ARITY_CALLBACK_CASTS, WIN32_OVERLOADED_INTRINSICS, WIN32_GENERIC_HANDLE_RETURNS, HEADER_DECLARED_SIGNATURES } from './crt-mapping.js';
import { selectExclusionEmissions, setPlatformDefinedNames, setPlatformDeclaredNames, collectReferencedNames, mayReferenceNamespaces } from './exclusion-closure.js';
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
 * Refuse a model that carries a type whose members were never read.
 *
 * The mark is set on the shallow listing entry and cleared by the detail that
 * replaces it, so it distinguishes the two cases the emitted text cannot: a
 * struct Ghidra reports as genuinely empty (39 of them in 1.14d, opaque handles
 * every one) still emits, and one whose ~5 MB detail response was lost does not.
 */
export function assertTypeDetailsComplete(dataTypes: readonly ExtractedDataType[]): void {
  const holes = dataTypes.filter(dt => dt.detailUnavailable);
  if (holes.length === 0) return;
  const listed = holes.map(dt => `  ${dt.kind} ${dt.name} (${dt.category})`).join('\n');
  throw new Error(
    `${holes.length} data type(s) reached codegen with no detail — their members are ` +
    `unknown, not absent, and an emitted body would be a lie the compiler accepts:\n` +
    `${listed}\n` +
    `Re-fetch these types (a full extraction, or get_data_type for each) and re-run.`
  );
}

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
  programInfo?: ProgramInfo,
  strings?: ExtractedString[]
): ReconstructedProject {
  const files = new Map<string, SourceFile>();
  const sourceMaps = new Map<string, SourceMap>();

  // A type whose detail fetch never landed reaches here as the shallow listing
  // entry: no fields, no values, no parameters. Emitting it produces a body that
  // is not the type — `struct D2GameViewStrc {};` for a 60 KB struct compiles,
  // and then every member access against it fails. There is nothing to fall back
  // to, because the members are not held anywhere else, so say what is missing
  // and stop. The snapshot on disk is intact; a re-fetch of the named types is
  // all it takes.
  assertTypeDetailsComplete(dataTypes);

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
  // The bytes behind the data the closure declares. Keyed on address inside the
  // setter, because a Ghidra string LABEL is a lossy rendering of its content
  // and only the address in it is exact.
  setDeclarationClosureDataContent(strings ?? []);

  // Module state, so a second run in the same process must not inherit the
  // first's answer — and a run with no exclusions must clear it, not skip it.
  setPlatformDefinedNames(new Set<string>());
  setPlatformDeclaredNames(new Set<string>());

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

    // Types survive or fall on their own, and the closure needs the answer
    // before it decides anything: a body whose signature names a type that did
    // not survive cannot be written down.
    dataTypes = dataTypes.filter(dt => !catMatches(dt.category) && !nsMatches(dt.name));
    const declaredTypeNames = new Set<string>();
    for (const dt of dataTypes) if (dt.name) declaredTypeNames.add(dt.name);
    const isKnownType = (name: string): boolean =>
      declaredTypeNames.has(name) || isPlatformOrBuiltinType(name);

    // The exclusion closure: which of the excluded-namespace functions kept code
    // reaches get a BODY rather than a declaration. Extraction held them and
    // decompiled everything reachable; the decision of what that is worth is
    // made here, from the emitter's own tables and from the kept bodies, so a
    // `--codegen-only` run can change it without going back to the server.
    //
    // Directness is computed here rather than carried from extraction for the
    // same reason: it is a property of what is KEPT, and what is kept is decided
    // on this line, not on the server.
    const excludedNamespaceNames = new Set<string>();
    for (const f of functions) {
      if (f.namespace && nsMatches(f.namespace)) excludedNamespaceNames.add(f.namespace);
    }
    const directlyReferenced = new Set<string>();
    for (const f of functions) {
      if (nsMatches(f.namespace) || !f.decompiled) continue;
      if (!mayReferenceNamespaces(f.decompiled, excludedNamespaceNames)) continue;
      for (const name of collectReferencedNames(f.decompiled)) directlyReferenced.add(name);
    }

    const reachable = functions.filter(f => nsMatches(f.namespace) && f.excludedNamespaceReachable);
    setPlatformDefinedNames(platformDefinedFunctionNames());
    setPlatformDeclaredNames(platformDeclaredFunctionNames());
    const selection = selectExclusionEmissions({
      candidates: reachable,
      directlyReferenced,
      isKnownType,
    });
    const emittedByClosure = new Set<ExtractedFunction>(selection.emit);

    const fnBefore = functions.length;
    functions = functions.filter(f => !nsMatches(f.namespace) || emittedByClosure.has(f));
    const retainedNamespaces = new Set(selection.emit.map(f => f.namespace).filter(Boolean));
    classes = classes.filter(c => !nsMatches(c.namespace) && !nsMatches(c.name));
    globals = (globals as Array<{ namespace?: string }>).filter(
      g => !nsMatches(g.namespace)
    ) as typeof globals;
    // A namespace that still owns a body has to keep its record, or the file
    // generator has nowhere to put the function it just kept.
    namespaces = namespaces.filter(
      ns => retainedNamespaces.has(ns.name) || (!nsMatches(ns.name) && !nsMatches(ns.fullPath))
    );
    const dropped = fnBefore - functions.length;
    if (dropped > 0) {
      console.log(`Excluded ${dropped} function(s) in excluded namespaces (no file emitted for them)`);
    }
    if (reachable.length > 0) {
      console.log(
        `Exclusion closure: ${selection.emit.length} body/bodies emitted of ${reachable.length} reachable`
        + ` (${selection.indirect.length} reached only through excluded code,`
        + ` ${selection.alreadySpokenFor.length} already declared elsewhere,`
        + ` ${selection.inexpressible.length} not expressible,`
        + ` ${selection.duplicates.length} duplicate name(s))`
      );
      for (const f of selection.emit) {
        console.log(`  emit  ${f.namespace}::${f.name} @${f.address} (${f.size} bytes)`);
      }
      for (const f of selection.inexpressible) {
        console.log(`  skip  ${f.namespace}::${f.name} @${f.address} — no C++ spelling for its signature or body`);
      }
      for (const f of selection.duplicates) {
        console.log(`  dupe  ${f.namespace}::${f.name} @${f.address} — same emitted name as an earlier body`);
      }
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
    imageBase: programInfo?.imageBase,
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
      // Return types and GLOBAL types alike: `gpGlideSmackerTexBuf0` is
      // `byte[32768] *`, and the cast into it is spelled through the same row
      // typedef a `T[N] *` return is.
      arrayRowTypedefs: arrayRowTypedefLines([
        ...functions.map(f => f.returnType),
        ...globals.map(g => normalizeGlobalDeclType(g.suggestedType || g.dataType || '')),
      ]),
      winsockInAddr: [...inAddrClaim.lines, ...buildWinsockIpTypesClaim(dataTypes)],
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
    // Each enum's constants live in `namespace <Enum>_ns`, and every one of its
    // members is written there - a member is NEVER dropped because another enum
    // happened to declare the same name first. That cross-enum drop was silently
    // wrong: `eD2PlayerAnimMode` lost 15 of its 20 members to
    // `eD2MonsterAnimMode`, whose numbering differs, so a `case Run:` in a
    // player-mode switch compiled to the monster's 15 instead of the player's 3.
    //
    // Global visibility is then granted one name at a time (`using <Enum>_ns::X;`)
    // and only where every declaring enum agrees on the value, so an unqualified
    // reference can no longer resolve to another enum's number.

    // Win32/CRT/compiler constants that Ghidra swept into enums collide with the
    // real <windows.h>/<winnt.h> macros. Under _WIN32 the platform headers own
    // them; emit our copies only when building without the SDK (non-_WIN32).
    //   - `define_*` enums are recovered preprocessor #defines
    //     (TRUE, WINVER, _M_IX86, _MSC_VER, the SAL annotation switches...)
    //   - IMAGE_* values are PE-format section/header constants from <winnt.h>
    const isPlatformEnumValue = (enumName: string, valueName: string): boolean =>
      /^define_/.test(enumName) || /^IMAGE_[A-Z]/.test(valueName);

    // Which enums this header actually writes, in the order it writes them.
    // One namespace per enum NAME: Ghidra carries the same enum under two
    // category paths in seven cases (`eD2Sounds` twice is 3586 members twice),
    // and now that a namespace keeps every member it declares, a second block of
    // the same name would redeclare all of them. The extraction currently folds
    // those before they get here; the guard is what makes that not matter.
    const seenEnumNames = new Set<string>();
    const emittedEnums = enumTypes.filter(e => {
      if (isPlatformOrBuiltinType(e.name) || /[^a-zA-Z0-9_]/.test(e.name)) return false;
      if (seenEnumNames.has(e.name)) return false;
      seenEnumNames.add(e.name);
      return true;
    });

    // Every enum a constant name is declared by, with the value each one gives
    // it. Trim first: Ghidra value names sometimes carry a trailing space
    // ("UNITEVENTCALLBACK_MODECHANGE "), and C++ ignores it, so the two
    // spellings are one name here.
    const nameOwners = new Map<string, Array<{ enumName: string; value: number | string }>>();
    for (const e of emittedEnums) {
      for (const v of e.values) {
        const vname = v.name.trim();
        if (!vname) continue;
        const into = nameOwners.get(vname) ?? [];
        if (into.length === 0) nameOwners.set(vname, into);
        into.push({ enumName: e.name, value: v.value });
      }
    }

    // A constant is spellable UNQUALIFIED only where every enum that declares it
    // agrees on the value. Where they disagree the name means different numbers
    // in different switches, and no global spelling of it can be right - it is
    // exported by nobody, so an unqualified use is a compile error rather than
    // a silent wrong branch. `enum-constant-qualify` writes the qualified form
    // wherever the controlling type says which enum is meant.
    const exportOwner = new Map<string, string>();
    const ambiguousConstants: string[] = [];
    for (const [vname, owners] of nameOwners) {
      const agrees = owners.every(o => String(o.value) === String(owners[0].value));
      if (agrees) exportOwner.set(vname, owners[0].enumName);
      else ambiguousConstants.push(vname);
    }
    context._ambiguousEnumConstants = ambiguousConstants;
    context._enumMembers = Object.fromEntries(
      emittedEnums.map(e => [e.name, e.values.map(v => v.name.trim()).filter(Boolean)])
    );

    for (const e of emittedEnums) {
      enumLines.push(`typedef int ${e.name};`);
      if (e.values.length > 0) {
        const normalLines: string[] = [];
        const platformLines: string[] = [];
        const normalUsing: string[] = [];
        const platformUsing: string[] = [];
        const declared = new Set<string>();
        for (const v of e.values) {
          const vname = v.name.trim();
          if (!vname || declared.has(vname)) continue;
          declared.add(vname);
          const comment = v.comment ? ` // ${v.comment.replace(/\\n/g, ' ')}` : '';
          const line = `constexpr ${e.name} ${vname} = ${v.value};${comment}`;
          const platform = isPlatformEnumValue(e.name, vname);
          (platform ? platformLines : normalLines).push(line);
          // A `using` may only name a declaration that exists in this build, so
          // an export of a guarded constant carries the same guard.
          if (exportOwner.get(vname) === e.name) {
            (platform ? platformUsing : normalUsing).push(`using ${e.name}_ns::${vname};`);
          }
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
          enumLines.push(...normalUsing);
          if (platformUsing.length > 0) {
            enumLines.push('#ifndef _WIN32  // provided by <windows.h>/<winnt.h> on Windows');
            enumLines.push(...platformUsing);
            enumLines.push('#endif');
          }
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

  // Which member-path-shaped names are REALLY interior to another datum, decided
  // from addresses. Both globals emitters drop an interior label, so a name the
  // shape test got wrong (`s_.I_00708874`, `MPQ_d2kfixup.mpq`) loses its
  // declaration AND its definition while the declaration closure still declares
  // it — an extern nothing defines. Registered once, before any file is written,
  // because the co-located and file-local emitters ask the same question.
  setInteriorLabelSymbols(analyzedGlobals);

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

  // Where each thunk's forwarder points, resolved ONCE from the same namespace
  // resolution the target's own definition renders from. Ghidra gives a thunk no
  // body of its own, so without this the header declares it and nothing defines
  // it — 57 of the tree's undefined symbols were exactly that.
  {
    const thunkForwards = new Map<string, ThunkForward>();
    const byAddressKey = new Map<string, ExtractedFunction>();
    for (const func of functions) {
      const hex = func.address.includes(':')
        ? func.address.slice(func.address.lastIndexOf(':') + 1)
        : func.address;
      byAddressKey.set(hex, func);
    }
    const platformDeclaredNames = platformDeclaredFunctionNames();

    for (const func of functions) {
      if (!func.isThunk || !func.thunkTarget) continue;
      const target = func.thunkTarget;

      if (target.isExternal) {
        // A DLL import. The forwarder goes to global scope, and only where this
        // emitter already owns a declaration for that name — inventing one here
        // would be a second, possibly conflicting, prototype for the same symbol.
        const name = sanitizeSymbolName(target.name);
        if (!platformDeclaredNames.has(name)) continue;
        thunkForwards.set(func.address, {
          qualified: `::${name}`,
          // An import thunk carries the import's own signature, so the two sides
          // agree by construction.
          returnType: returnSigType(func.returnType),
          parameterCount: func.parameters.length,
        });
        continue;
      }

      const hex = target.address.includes(':')
        ? target.address.slice(target.address.lastIndexOf(':') + 1)
        : target.address;
      const targetFunc = byAddressKey.get(hex);
      // A target this tree never emits has no declaration to call.
      if (!targetFunc || targetFunc.isExternal || targetFunc.isLibrary) continue;

      const targetReturn = returnSigType(targetFunc.returnType);
      // Resolved from the PATH, not the address. A data symbol sharing the
      // target's address claims that address after the function does — Ghidra
      // has an `nlist_0061b2d0` sitting on `DRLGROOMEX_ActivateRoomEx` — and the
      // address claim then answers root scope for a function that has a
      // namespace. Both sides memoise on the path, so this is the same entity
      // the target's own definition renders from.
      const segments = targetFunc.parentClass
        ? [targetFunc.parentClass]
        : [...namespaceResolution().resolvePath(targetFunc.namespace).segments];
      const leaf = emittedFunctionName(targetFunc, targetReturn);
      thunkForwards.set(func.address, {
        qualified: ['', ...segments, leaf].join('::'),
        returnType: targetReturn,
        parameterCount: targetFunc.parameters.length,
      });
    }
    if (thunkForwards.size > 0) context.thunkForwards = thunkForwards;
  }

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
    for (const spelling of new Set([d.emitted, declaredIdentifier(d)])) {
      functionQualifiedNames.add(spelling);
      const sd = sanitizeQualifiedReference(spelling);
      if (sd !== spelling) functionQualifiedNames.add(sd);
    }
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
      const rescoped = reconcileStaticScopeWithBodyReferences(analyzedGlobals, functions, funcToImpl, allDataTypeNames, programInfo?.imageBase, strings ?? []);
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
        options, context, targetDir, files, sourceMaps, globalsPath, strings
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
        options, context, 'unsorted', files, sourceMaps, globalsPath, strings
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

        // One globals translation unit per module, plus a shared remainder.
        emitCentralGlobalsUnits(
          centralGlobals, functions, files,
          { ...options, projectName: name, binaryName: programInfo?.name },
          globalsPath!, mergedTypeOwnerMap, context.functionNameCandidates);
      }
    }
  } else {
    // Non-target mode: existing flat generation

    // Compute file-scoped statics BEFORE globals.h/cpp generation
    if (options.promoteStaticGlobals && analyzedGlobals.length > 0) {
      const funcToImpl = buildFuncToImplPathMap(functions, classes, namespaces, options, '');
      computeFileLocalGlobals(analyzedGlobals, funcToImpl);
      reconcileStaticScopeWithBodyReferences(analyzedGlobals, functions, funcToImpl, allDataTypeNames, programInfo?.imageBase, strings ?? []);
    }

    // Calculate globals path (needed for generateFilesForFunctions includes)
    const flatGlobalsPath = analyzedGlobals.length > 0 ? 'globals.h' : undefined;

    // Generate files (classification happens here)
    const flatTypeOwnerMap = generateFilesForFunctions(
      functions, classes, namespaces, dataTypes, globals,
      options, context, '', files, sourceMaps, flatGlobalsPath, strings
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

        // One globals translation unit per module, plus a shared remainder.
        emitCentralGlobalsUnits(
          centralGlobals, functions, files,
          { ...options, projectName: name, binaryName: programInfo?.name },
          'globals.h', flatTypeOwnerMap, context.functionNameCandidates);
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
  reportFuncPtrArityMismatches();

  return project;
}

/**
 * What the closure declared, and what it refused to.
 *
 * The refusals are the interesting half: each class is a separate defect the
 * closure deliberately does not paper over, and the count is how much of the
 * "was not declared" error family is NOT a closure problem.
 */
/**
 * The funcdef-vs-function arity disagreements both cast paths refused.
 *
 * A cast reconciles a parameter TYPE; it cannot reconcile a parameter COUNT, so
 * every line here is a place where the database says a slot takes N arguments
 * and the function stored into it takes M. One of the two prototypes is wrong
 * and only the database can say which — printing the pairs is what turns the
 * class from a number into a worklist.
 */
function reportFuncPtrArityMismatches(): void {
  const bodies = getFuncPtrArgCastArityMismatchList();
  const initializers = getInitializerFuncPtrArityMismatches();
  if (bodies.length === 0 && initializers === 0) return;
  console.log(`Funcdef arity disagreements: ${bodies.length} in bodies, ${initializers} in data initializers (no cast attempted — a cast cannot change arity)`);
  for (const m of [...bodies].sort((a, b) => a.slot.localeCompare(b.slot) || a.callee.localeCompare(b.callee))) {
    console.log(`  ${m.slot} takes ${m.slotArity}, ${m.callee} takes ${m.actualArity}`);
  }
}

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
  const defined = report.declarations.filter(d => d.def).length;
  if (defined > 0) {
    console.log(`Declaration closure: ${defined} declaration(s) also defined from Ghidra's own bytes`);
  }
  if (report.definitionGaps.size > 0) {
    const total = [...report.definitionGaps.values()].reduce((a, l) => a + l.length, 0);
    console.log(`Declaration closure: ${total} declared symbol(s) with no definition (undefined at link), by cause:`);
    for (const [reason, names] of [...report.definitionGaps].sort((a, b) => b[1].length - a[1].length)) {
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
/**
 * Emit the central globals definitions as one translation unit PER MODULE plus a
 * shared remainder, instead of one unit for the whole binary.
 *
 * See `globals-partition.ts` for why and for how a global's module is decided.
 * The one-definition-per-name winner is still computed by `generateGlobalsImpl`
 * over the WHOLE set and each file emits only the winners in its own partition,
 * so the split moves definitions and can neither duplicate nor lose one.
 *
 * Every unit includes globals.h and gets its own extra-include patch, because a
 * by-value aggregate initializer needs the type's own header and which types a
 * unit uses now differs per unit.
 */
function emitCentralGlobalsUnits(
  centralGlobals: AnalyzedDataSymbol[],
  functions: ExtractedFunction[],
  files: Map<string, SourceFile>,
  options: ReconstructOptions & { projectName?: string; binaryName?: string },
  globalsHeaderPath: string,
  typeOwnerMap: Map<string, string>,
  functionNameCandidates: Map<string, { qualified: string; header: string }[]> | undefined,
): void {
  const implExt = options.format === 'c' ? '.c' : '.cpp';
  const headerName = globalsHeaderPath.split('/').pop()!;
  const implDir = globalsHeaderPath.includes('/')
    ? globalsHeaderPath.slice(0, globalsHeaderPath.lastIndexOf('/') + 1)
    : '';
  const implBase = headerName.replace(/\.h$/, '');

  const { partitions, shared } = partitionGlobalsByModule(
    centralGlobals, buildFunctionModuleMap(functions));

  // The shared remainder is first, and it is the unit that owns the closure
  // definitions: they belong to no module, and emitting them from every unit
  // would be as many duplicate definitions as there are units.
  const units: { path: string; members: ReadonlySet<AnalyzedDataSymbol> | undefined; ownsClosure: boolean }[] = [
    { path: `${implDir}${implBase}${implExt}`, members: new Set(shared), ownsClosure: true },
    ...partitions.map(p => ({
      path: `${implDir}${implBase}.${p.module}${implExt}`,
      members: new Set(p.members) as ReadonlySet<AnalyzedDataSymbol>,
      ownsClosure: false,
    })),
  ];

  for (const unit of units) {
    setCentralInitializerScope(true);
    const content = generateGlobalsImpl(
      centralGlobals, options, headerName, undefined, unit.members, unit.ownsClosure);
    setCentralInitializerScope(false);
    files.set(unit.path, {
      path: unit.path,
      content,
      type: 'implementation',
      functions: [],
      includes: [globalsHeaderPath],
    });
    patchGlobalsExtraIncludes(
      files, unit.path, [...(unit.members ?? [])], typeOwnerMap, globalsHeaderPath,
      functionNameCandidates);
  }
  const placed = partitions.reduce((n, p) => n + p.members.length, 0);
  console.log(`Globals: ${units.length} translation unit(s) — ${placed} definition(s) placed by module, ${shared.length} shared`);
}

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
 * function bodies REFERENCE the symbol. Those two disagree constantly, in two
 * distinct ways:
 *
 *  - By NAME. A Ghidra array longer than the real table swallows its
 *    neighbours, so every `AllocServerMemory(..., __FILE__, ...)` inside its
 *    extent decompiles its filename argument as `(char*)(gTable + 0xNN)`, and a
 *    symbol with xrefCount 1 is named by dozens of functions across a dozen
 *    files.
 *
 *  - By ADDRESS. Where the decompiler folded an address into a plain integer,
 *    Ghidra records the operand as a SCALAR, not a data reference, so the xref
 *    count at the symbol never sees it and neither does any scan for the name.
 *    `global-address-literal` later resolves exactly those literals back into
 *    `&name` / `(char*)&name + n` / `~(uintptr_t)<form>` — which is a reference,
 *    created after this decision was taken. `cSCompCompressMethod` was emitted
 *    `static` inside one function of SSComp.cpp and its address then taken from
 *    two others; `gnOutJungPresetOffsetByLevel` was emitted `static` in
 *    OutJung.cpp and its address taken from Act5.cpp, a different translation
 *    unit. Both are undefined at link.
 *
 * The result was a symbol emitted `static` in one place and declared `extern` by
 * globals.h's multi-body safety net — a declaration nothing can ever satisfy,
 * plus, for a function-local static, a body-scoped object no other function can
 * see. All of it now comes from ONE count, over both reference classes.
 *
 * The demotion stays where it is provably safe: a static-local whose name only
 * one function mentions and whose address no other function takes.
 */
export function reconcileStaticScopeWithBodyReferences(
  analyzedGlobals: AnalyzedDataSymbol[],
  functions: ExtractedFunction[],
  funcNameToImplPath: Map<string, string>,
  typeNames: ReadonlySet<string>,
  imageBase?: string | number,
  strings?: ReadonlyArray<ExtractedString>
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

  const ownerOfLiteral = buildAddressLiteralResolver(analyzedGlobals, imageBase, strings ?? []);

  // Which functions reference each candidate, read off Ghidra's decompiler
  // output — the INPUT to codegen, and the only place the eventual references
  // exist before any file has been generated. One pass yields both classes: a
  // token is an identifier or it is a number, and a number that resolves to a
  // candidate's extent is the reference `global-address-literal` will write.
  const namingFunctions = new Map<string, Set<string>>();
  const literalFunctions = new Map<string, Set<string>>();
  // Numbers first, so the digits inside `DAT_00724a80` are consumed by the
  // identifier alternative and never read as an address of their own.
  const token = /0[xX][0-9a-fA-F]+|\d+|[A-Za-z_]\w*/g;
  for (const func of functions) {
    const body = func.decompiled;
    if (!body) continue;
    token.lastIndex = 0;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = token.exec(body)) !== null) {
      const text = m[0];
      const lead = text.charCodeAt(0);
      const isIdentifier = lead === 0x5f /* _ */
        || (lead >= 0x41 && lead <= 0x5a) || (lead >= 0x61 && lead <= 0x7a);
      if (isIdentifier) {
        if (seen.has(text) || !candidates.has(text)) continue;
        seen.add(text);
        let fns = namingFunctions.get(text);
        if (!fns) { fns = new Set(); namingFunctions.set(text, fns); }
        fns.add(func.name);
        continue;
      }
      if (!ownerOfLiteral) continue;
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value <= 0 || value > WORD_VALUES) continue;
      // `-7373669` is one folded word: the emitter prints a top-bit-set address
      // as a signed decimal, so the magnitude preceded by a minus is tried as
      // the word it stands for as well as on its own. A genuine subtraction
      // whose operand happens to complete an address costs a promotion that
      // could have been made, which is the cheap failure.
      const negated = m.index > 0 && body.charCodeAt(m.index - 1) === 0x2d /* - */
        ? (WORD_VALUES - value) >>> 0
        : undefined;
      for (const v of negated === undefined ? [value] : [value, negated]) {
        // The table is keyed by the RAW Ghidra name, the candidate map by the
        // emitted one. They differ only where the sanitizer changed something
        // (a leading digit), and a reference lost to that would be one the
        // emitted tree still makes.
        const owner = ownerOfLiteral(v);
        if (owner === null) continue;
        const name = sanitizeSymbolName(owner);
        if (!candidates.has(name)) continue;
        let fns = literalFunctions.get(name);
        if (!fns) { fns = new Set(); literalFunctions.set(name, fns); }
        fns.add(func.name);
      }
    }
  }

  let promotedToGlobal = 0;
  let promotedToFileLocal = 0;
  for (const [name, globalsWithName] of candidates) {
    const byName = namingFunctions.get(name);
    const byAddress = literalFunctions.get(name);
    const fns = new Set<string>(byName ?? []);
    if (byAddress) for (const fn of byAddress) fns.add(fn);
    // A function-local static lives in ONE body. A single body that only takes
    // its address is still a foreign reference when that body is not the owner
    // — the xref the owner contributed is the reason the symbol was scoped
    // static-local in the first place, and it does not show up here when the
    // decompiler spelled the owner's access some other way.
    if (byAddress && fns.size === 1) {
      for (const g of globalsWithName) {
        if (g.scope === 'static-local' && g.ownerFunction && !byAddress.has(g.ownerFunction)) {
          fns.add(g.ownerFunction);
        }
      }
    }
    if (fns.size <= 1) continue;
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

/** One 32-bit word — the width every folded image address was printed at. */
const WORD_VALUES = 0x100000000;

/** Address bucketing for the interior index. 4KB, the page the image is mapped in. */
const ADDRESS_PAGE_SHIFT = 12;

/**
 * A size beyond which a Ghidra extent is not one. The interior index costs one
 * entry per page an extent spans, so a bogus `size` would cost a million of
 * them; nothing in a 32-bit image's data section is 16MB wide. The symbol still
 * resolves on its exact base.
 */
const MAX_INDEXED_EXTENT = 0x1000000;

/**
 * Global name → its address in the image, and global name → its size in bytes.
 *
 * This IS the table `global-address-literal` resolves against, and the only one:
 * the pass reads it through `funcPtrArgCasts`, and the scope analysis that has
 * to count the references the pass will create reads it here. When the two were
 * built separately they disagreed over which symbols are even admissible, and
 * the disagreement cost a link error — see `buildAddressLiteralResolver`.
 *
 * Both restrictions matter, and both are about ADMISSION, not resolution:
 *
 *  - The name is tested RAW. A Ghidra interior label is named after the object
 *    it points into — `gaLanguageNames_00724a80[1]` is element 1 of the array at
 *    00724a80, not an object of its own — and the bracket disqualifies it. That
 *    is what makes 00724a84 resolve as `(char*)&gaLanguageNames_00724a80 + 4`,
 *    a reference to the ARRAY, rather than as a symbol in its own right.
 *    Sanitizing first would legalise `[1]` into `_1_` and readmit exactly the
 *    symbols this filter exists to exclude.
 *
 *  - A name at two addresses, or at two sizes, is dropped rather than resolved
 *    arbitrarily: the wrong address would put a store at an invented one, and
 *    the larger size would claim bytes the smaller object does not own. An
 *    address entry with no size entry still resolves on its exact base.
 */
/**
 * Ghidra's own label for a string datum, reproduced: `s_<text>_<address>`.
 *
 * Every character that is not identifier-legal becomes `_`, one for one — that
 * is what turns `Error 1:\nDiablo II is unable to p…` into
 * `Error_1__Diablo_II_is_unable_to_p` — and the text is cut at 33 characters.
 * Both facts are read off the labels ALREADY in the tree: every truncated one
 * there is exactly 33 characters wide, and no invalid character is ever
 * collapsed or dropped. The address is 8 lowercase hex digits, which is what
 * `stringLabelAddress` reads back out.
 *
 * WHY REPRODUCE IT rather than carry it: `list_strings` reports address, bytes,
 * length and encoding, and no name — Ghidra's label is not a symbol, it is
 * derived from the datum on demand. The bodies that reference one spell it this
 * way, so a reference synthesized here reaches the SAME object the closure
 * already declares and defines for them.
 *
 * The failure mode of getting the convention wrong is bounded and visible: a
 * second `char[]` with identical bytes under a slightly different name, both
 * defined by the closure. Nothing miscompiles and nothing goes undefined.
 */
export function ghidraStringLabelName(address: number, value: string): string {
  let text = '';
  for (const ch of value) {
    if (text.length >= 33) break;
    text += /[A-Za-z0-9_]/.test(ch) ? ch : '_';
  }
  return `s_${text}_${address.toString(16).padStart(8, '0')}`;
}

/**
 * The string constants an address literal may legitimately resolve to.
 *
 * A string datum is NOT a global: Ghidra types it `string`, which is a byte
 * layout and not a C type, so `analyzeDataSymbols` filters it out and no
 * `globals` record for it is ever built. Its declaration comes from the
 * declaration closure instead, off the `s_<text>_<hex>` naming convention, as
 * `extern char <name>[];` plus a definition built from the bytes.
 *
 * That last part is the admission rule here, and it is exact rather than
 * approximate: a candidate is admitted only if `stringDefinition` — the same
 * function the closure will call — can actually produce the definition. A
 * literal resolved to a name nothing defines is an undefined symbol at link,
 * which is strictly worse than the literal it replaced. So a `unicode` datum, or
 * one whose decoded bytes disagree with the length Ghidra reports, is skipped.
 *
 * The extent is `length + 1`: the object the closure emits is
 * `char name[] = "…"`, whose size is the bytes plus the terminator. Ghidra's own
 * data size is deliberately NOT used — it can include alignment padding the
 * emitted object does not own, and an interior offset into padding would point
 * past the end.
 */
function stringConstantExtents(
  strings: ReadonlyArray<ExtractedString>
): Array<{ name: string; address: number; size: number }> {
  const out: Array<{ name: string; address: number; size: number }> = [];
  const claimed = new Set<string>();
  for (const s of strings) {
    if (!s || typeof s.value !== 'string') continue;
    const address = Number.parseInt(normalizeDataAddress(String(s.address ?? '')), 16);
    if (!Number.isSafeInteger(address) || address <= 0) continue;
    if (!Number.isSafeInteger(s.length) || s.length <= 0) continue;
    const name = ghidraStringLabelName(address, s.value);
    // First record for an address wins, exactly as the closure's content table
    // decides it — two records are two readings of the same bytes, and taking
    // the later one silently would make the tree depend on extraction order.
    if (claimed.has(name)) continue;
    const built = stringDefinition(name, {
      value: s.value,
      length: s.length,
      encoding: s.encoding ?? '',
    });
    if ('reason' in built) continue;
    claimed.add(name);
    out.push({ name, address, size: s.length + 1 });
  }
  return out;
}

export function buildGlobalAddressExtentTables(
  globals: AnalyzedDataSymbol[],
  strings: ReadonlyArray<ExtractedString> = []
): {
  globalAddresses: Record<string, number>;
  globalSizes: Record<string, number>;
  /** The subset of the two tables above whose objects are `char[N]` strings. */
  stringConstantNames: string[];
} {
  const globalAddresses: Record<string, number> = {};
  const ambiguousGlobalAddresses = new Set<string>();
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (!name || /[^A-Za-z0-9_]/.test(name)) continue;
    if (ambiguousGlobalAddresses.has(name)) continue;
    const address = Number.parseInt(String(g.address ?? '').replace(/^0x/i, ''), 16);
    if (!Number.isSafeInteger(address)) continue;
    const existing = globalAddresses[name];
    if (existing !== undefined && existing !== address) {
      ambiguousGlobalAddresses.add(name);
      delete globalAddresses[name];
      continue;
    }
    globalAddresses[name] = address;
  }

  const globalSizes: Record<string, number> = {};
  const ambiguousGlobalSizes = new Set<string>();
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (!name || /[^A-Za-z0-9_]/.test(name)) continue;
    if (ambiguousGlobalSizes.has(name)) continue;
    const size = Number(g.size);
    if (!Number.isSafeInteger(size) || size <= 0) continue;
    const existing = globalSizes[name];
    if (existing !== undefined && existing !== size) {
      ambiguousGlobalSizes.add(name);
      delete globalSizes[name];
      continue;
    }
    globalSizes[name] = size;
  }

  // The string constants last, and never over a name a global already owns: a
  // global has a modelled type and a declaration of its own, and a synthesized
  // label losing to it costs one unresolved literal, while the reverse would
  // give the global's address the wrong type at every use.
  const stringConstantNames: string[] = [];
  for (const { name, address, size } of stringConstantExtents(strings)) {
    if (globalAddresses[name] !== undefined || ambiguousGlobalAddresses.has(name)) continue;
    if (globalSizes[name] !== undefined || ambiguousGlobalSizes.has(name)) continue;
    globalAddresses[name] = address;
    globalSizes[name] = size;
    stringConstantNames.push(name);
  }

  return { globalAddresses, globalSizes, stringConstantNames };
}

/**
 * `value → the global that owns it`, over the same table and by the same rule
 * `global-address-literal` uses.
 *
 * Same admission (`buildGlobalAddressExtentTables`), same floor, same ownership
 * rule as `ownerOfAddress`; it differs only in SHAPE. That pass resolves a
 * handful of literals against a prepared candidate list, this one resolves every
 * literal in the program, so exact bases go in a map and extents into a page
 * index rather than being rescanned per literal.
 *
 * Answers with the RAW Ghidra name, which is what the table is keyed by.
 *
 * Null when no global clears the floor — there is then nothing to resolve, and
 * the caller can skip the numeric half of its scan entirely.
 */
function buildAddressLiteralResolver(
  globals: AnalyzedDataSymbol[],
  imageBase: string | number | undefined,
  strings: ReadonlyArray<ExtractedString> = []
): ((v: number) => string | null) | null {
  const { globalAddresses, globalSizes } = buildGlobalAddressExtentTables(globals, strings);
  const floor = addressLiteralFloor(imageBase);

  const baseAt = new Map<number, string[]>();
  const interiorPages = new Map<number, Array<{ name: string; address: number; size: number }>>();
  let any = false;

  for (const [name, address] of Object.entries(globalAddresses)) {
    if (!Number.isSafeInteger(address) || address < floor || address >= ADDRESS_LITERAL_CEILING) {
      continue;
    }
    any = true;

    const bases = baseAt.get(address);
    if (bases) bases.push(name); else baseAt.set(address, [name]);

    const declared = globalSizes[name];
    const size = Number.isSafeInteger(declared) && declared > 1 ? declared : 0;
    if (size === 0 || size > MAX_INDEXED_EXTENT) continue;
    const first = address >>> ADDRESS_PAGE_SHIFT;
    const last = (address + size - 1) >>> ADDRESS_PAGE_SHIFT;
    for (let page = first; page <= last; page++) {
      const bucket = interiorPages.get(page);
      const entry = { name, address, size };
      if (bucket) bucket.push(entry); else interiorPages.set(page, [entry]);
    }
  }
  if (!any) return null;

  /** Rule 1 then rule 2, each requiring a unique owner. */
  const direct = (v: number): string | null => {
    const bases = baseAt.get(v);
    if (bases) return bases.length === 1 ? bases[0] : null;
    const bucket = interiorPages.get(v >>> ADDRESS_PAGE_SHIFT);
    if (!bucket) return null;
    let hit: string | null = null;
    let hits = 0;
    for (const e of bucket) {
      if (v > e.address && v < e.address + e.size) { hit = e.name; hits++; }
    }
    return hits === 1 ? hit : null;
  };

  return (v: number): string | null => {
    const hit = direct(v);
    if (hit !== null) return hit;
    // Rule 3: a folded `~&global` always lands above 0xFF000000.
    if (v < ADDRESS_LITERAL_COMPLEMENT_FLOOR) return null;
    return direct((~v) >>> 0);
  };
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
  globalsHeaderPath?: string,
  /**
   * The string data Ghidra read, for the address tables built below. A string
   * datum is not a global — the globals extraction drops its `string` type — so
   * it has to arrive on its own or an address literal pointing at one resolves
   * to nothing.
   */
  strings?: ExtractedString[]
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
  context.funcPtrArgCasts = buildFuncPtrArgCastTables(functions, analyzedGlobals, dataTypes.filter(dt => dt.kind === 'FUNCTION_DEFINITION') as import('../types.js').ExtractedFunctionDefinition[], dataTypes, strings ?? []);
  // Data initializers are emitted from strings, not an AST — the globals emitter
  // needs the same prototype tables to decide whether a function address stored
  // in a slot needs the cast C++ has never let it do implicitly.
  setInitializerSignatureTables(
    context.funcPtrArgCasts.functionSignatures,
    context.funcPtrArgCasts.funcdefSignatures,
  );

  // The address table those initializers resolve against — the SAME one
  // `global-address-literal` reads, off the same build. A literal in an
  // initializer is unreachable from the AST pass (the static-locals block is
  // appended as text after the body was transformed), and the six absolute
  // `.rdata` addresses in `gApplicationModeCommandLineArgumentArray` are how
  // that showed up: the recompiled executable walked unmapped memory at
  // 0x006CC928.
  //
  // Only names an initializer can legally NAME are offered. A string constant
  // qualifies — the declaration closure gives each one an `extern char N[];` in
  // globals.h plus a single definition — and so does a `scope === 'global'`
  // symbol. A file-local or static-local is emitted `static` inside one .cpp and
  // referencing it from another is undefined at link. Scopes are already final
  // for demotion at this point: `computeFileLocalGlobals` ran before this
  // function was called, and everything after it only promotes.
  {
    const referenceableNames = new Set<string>(context.funcPtrArgCasts.stringConstantNames);
    for (const g of analyzedGlobals) {
      if (g.scope !== 'global') continue;
      const name = g.suggestedName || g.name;
      if (name) referenceableNames.add(name);
    }
    setInitializerAddressTable({
      globalAddresses: context.funcPtrArgCasts.globalAddresses,
      stringConstantNames: context.funcPtrArgCasts.stringConstantNames,
      referenceableNames,
      imageBase: context.imageBase,
    });
  }

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
        // The namespace this unit's bodies are emitted inside. An UNQUALIFIED
        // call in it resolves outward — `Fog::Engine::Application` looks in
        // Application, then Engine, then Fog — so when several headers declare
        // the name, the one unqualified lookup will land on is the candidate
        // declared in the nearest enclosing namespace. Without this the include
        // is never added and the call is undeclared, even though a header in
        // the tree declares exactly the function the compiler would have found.
        const unitNamespace = unitFunctions.find(f => f.namespace)?.namespace ?? '';
        const enclosingCandidate = (
          candidates: { qualified: string; header: string }[],
        ): string | undefined => {
          if (!unitNamespace) return undefined;
          let best: { depth: number; header: string } | undefined;
          for (const c of candidates) {
            const sep = c.qualified.lastIndexOf('::');
            if (sep < 0) continue;
            const ns = c.qualified.slice(0, sep);
            if (unitNamespace !== ns && !unitNamespace.startsWith(`${ns}::`)) continue;
            const depth = ns.split('::').length;
            if (!best || depth > best.depth) best = { depth, header: c.header };
          }
          return best?.header;
        };

        for (const funcName of ambiguous) {
          const candidates = funcNameCandidates.get(funcName)!;
          const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`((?:[A-Za-z_]\\w*::)+)${escaped}(?![A-Za-z0-9_])`, 'g');
          let resolvedByQualifier = false;
          for (const m of implContent.matchAll(re)) {
            const observed = m[1] + funcName;
            for (const c of candidates) {
              if (c.qualified === observed || c.qualified.endsWith(`::${observed}`)) {
                addInclude(c.header);
                resolvedByQualifier = true;
              }
            }
          }
          if (resolvedByQualifier) continue;
          const enclosing = enclosingCandidate(candidates);
          if (enclosing) addInclude(enclosing);
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
        // A chain mixes both accessors - `pUnit->pUnitData.pUnitDataMonster->pMonStatsTxt`
        // reaches the union BY VALUE and then dereferences again. Matching only `->`
        // stopped at the first `.` and left every type past it incomplete, so both
        // spellings advance the walk; the field's base type is the same either way.
        for (const cm of implContent.matchAll(/\b([A-Za-z_]\w*)((?:\s*(?:->|\.)\s*[A-Za-z_]\w*)+)/g)) {
          let curType = varType.get(cm[1]);
          if (!curType) continue;
          for (const fm of cm[2].matchAll(/(?:->|\.)\s*([A-Za-z_]\w*)/g)) {
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
 * Index a name under its qualified spelling, its bare spelling, and the spelling
 * the EMITTER actually writes — a reference site may carry any of the three.
 *
 * The third is not cosmetic. Ghidra's namespace is `D2Direct3D::Renderer::Direct3D`
 * and the emitted one is `D2Direct3D::Renderer` (the trailing segment collides
 * with a type, so the declaration side drops it). A data initializer naming
 * `&D2Direct3D::Renderer::DrawGroundTile` then matched neither key — the qualified
 * one because it is the raw path, the bare one because `DrawGroundTile` exists in
 * three renderers and is dropped as ambiguous — so the signature comparison saw
 * nothing and no cast was written, while the same field in the Glide and
 * DirectDraw tables (whose namespaces survive intact) got one. Two records of the
 * same name, written at different times, drifting apart.
 *
 * A call site may write either. A key claimed by two different signatures is ambiguous and is
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
  emitted?: string,
): void {
  const keys = [...new Set([qualified, bare, ...(emitted ? [emitted] : [])])];
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
): { lines: string[]; claimed: Set<string>; converting: Set<string> } {
  const empty = { lines: [] as string[], claimed: new Set<string>(), converting: new Set<string>() };
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
    // The two nested structs get a conversion OPERATOR and no constructor. An
    // operator leaves the type an aggregate - it is a constructor that would not -
    // so `if (nAddrBytes)` and `nAddrBytes == nOther`, which are the decompiler
    // reading the four bytes as the word they are, resolve without costing the
    // brace-initialisation the whole tree relies on.
    `struct ${B} { ${byteFields.map(f => `${byteType} ${f.name};`).join(' ')}`
      + ` operator ${addrType}() const { return *reinterpret_cast<const ${addrType}*>(this); } };`,
    `struct ${W} { ${wordFields.map(f => `${wordType} ${f.name};`).join(' ')}`
      + ` operator ${addrType}() const { return *reinterpret_cast<const ${addrType}*>(this); } };`,
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
    `    operator ${addrType}() const { return S_un.S_addr; }`,
    '} IN_ADDR, *PIN_ADDR, *LPIN_ADDR;',
    '#    define s_addr  S_un.S_addr',
    '#    define s_host  S_un.S_un_b.s_b2',
    '#    define s_net   S_un.S_un_b.s_b1',
    '#    define s_imp   S_un.S_un_w.s_w2',
    '#    define s_impno S_un.S_un_b.s_b4',
    '#    define s_lh    S_un.S_un_b.s_b3',
    '#  endif  // s_addr',
  ];

  // Which of the four the block above gives a CONVERTING CONSTRUCTOR to. The two
  // byte/word structs get none deliberately - a user-provided constructor
  // de-aggregates them across every translation unit this header reaches - so a
  // cast to one of those is still a cast with no meaning in C++, while a cast to
  // the union or to `in_addr` already means exactly what it says.
  return { lines, claimed: new Set([B, W, U]), converting: new Set([U, 'in_addr', 'IN_ADDR']) };
}

/** A 4-byte unsigned scalar under any spelling the model uses for `sin_addr`. */
const WINSOCK_DWORD_SPELLINGS = new Set([
  'uint32_t', 'uint', 'dword', 'DWORD', 'ULONG', 'UINT32', 'u_long', 'undefined4',
]);

/**
 * mingw's `psdk_inc/_ip_types.h`, re-declared with Ghidra's `sin_addr`.
 *
 * The tree carries TWO structs named `sockaddr_in`. Ghidra models `sin_addr` as
 * a 32-bit word — which is what the machine code does with it — and the emitter
 * writes that struct out under `#ifndef _WIN32`, so on Windows the SDK's
 * definition wins instead and `sin_addr` is a `struct in_addr`. A translation
 * unit that includes the emitted header sees one type and a unit that does not
 * sees the other, and no rule keyed on the member can be right in both:
 * `nsockaddr.sin_addr` in a ternary against `0` is ambiguous BOTH ways against
 * the claimed `in_addr` (`operator unsigned long` one way, the converting
 * constructor the other), while `Safesock.cpp` stores a plain word into the very
 * same member and compiles.
 *
 * This is the other half of the `in_addr` claim: declare the struct once, ahead
 * of the SDK, so there is only one of it. The whole of `_ip_types.h` is guarded
 * on `_MINGW_IP_TYPES_H` — there is no finer guard around `sockaddr_in` alone —
 * so the claim has to supply everything that file declares. The types Ghidra
 * models are checked against the model and emitted from it; the rest are the
 * vendor's own declarations, reproduced unchanged.
 *
 * Emitted ONLY when the model agrees with winsock's shape field for field. Any
 * disagreement means the two layouts are not the same object after all, and the
 * SDK's header is left to win as it does today.
 */
export function buildWinsockIpTypesClaim(dataTypes: ExtractedDataType[]): string[] {
  const byName = new Map<string, ExtractedDataType>();
  for (const dt of dataTypes) byName.set(dt.name, dt);
  const fieldsOf = (dt: ExtractedDataType | undefined) =>
    (dt as import('../types.js').ExtractedStruct | undefined)?.fields ?? [];

  /** Every named field at the named offset, and nothing else. */
  const shapeIs = (name: string, want: [string, number][]): boolean => {
    const dt = byName.get(name);
    if (!dt || dt.kind !== 'STRUCTURE') return false;
    const fs = fieldsOf(dt);
    return fs.length === want.length
      && fs.every((f, i) => f.name === want[i][0] && f.offset === want[i][1]);
  };

  if (!shapeIs('sockaddr_in', [['sin_family', 0], ['sin_port', 2], ['sin_addr', 4], ['sin_zero', 8]])) return [];
  if (!shapeIs('sockaddr', [['sa_family', 0], ['sa_data', 2]])) return [];
  if (!shapeIs('hostent', [['h_name', 0], ['h_aliases', 4], ['h_addrtype', 8], ['h_length', 10], ['h_addr_list', 12]])) return [];

  const sinAddr = fieldsOf(byName.get('sockaddr_in'))[2].dataType.trim();
  if (!WINSOCK_DWORD_SPELLINGS.has(sinAddr)) return [];

  return [
    "// mingw's psdk_inc/_ip_types.h, claimed so that `sockaddr_in` is ONE type.",
    "// Ghidra models sin_addr as the 32-bit word the code treats it as; the SDK",
    "// models it as `struct in_addr`. The file has no guard finer than its own,",
    '// so everything it declares is declared here, unchanged apart from that one',
    '// member. Same layout, same offsets, same names.',
    '#  ifndef _MINGW_IP_TYPES_H',
    '#  define _MINGW_IP_TYPES_H',
    '#    include <_bsd_types.h>',
    '#    include <_timeval.h>',
    '#    define h_addr h_addr_list[0]',
    'struct hostent { char *h_name; char **h_aliases; short h_addrtype; short h_length; char **h_addr_list; };',
    'struct netent { char *n_name; char **n_aliases; short n_addrtype; u_long n_net; };',
    '#    ifdef _WIN64',
    'struct servent { char *s_name; char **s_aliases; char *s_proto; short s_port; };',
    '#    else',
    'struct servent { char *s_name; char **s_aliases; short s_port; char *s_proto; };',
    '#    endif',
    'struct protoent { char *p_name; char **p_aliases; short p_proto; };',
    'struct sockproto { u_short sp_family; u_short sp_protocol; };',
    'struct linger { u_short l_onoff; u_short l_linger; };',
    'struct sockaddr { u_short sa_family; char sa_data[14]; };',
    `struct sockaddr_in { short sin_family; u_short sin_port; ${sinAddr} sin_addr; char sin_zero[8]; };`,
    'typedef struct hostent HOSTENT, *PHOSTENT, *LPHOSTENT;',
    'typedef struct servent SERVENT, *PSERVENT, *LPSERVENT;',
    'typedef struct protoent PROTOENT, *PPROTOENT, *LPPROTOENT;',
    'typedef struct sockaddr SOCKADDR, *PSOCKADDR, *LPSOCKADDR;',
    'typedef struct sockaddr_in SOCKADDR_IN, *PSOCKADDR_IN, *LPSOCKADDR_IN;',
    'typedef struct linger LINGER, *PLINGER, *LPLINGER;',
    '#    ifdef __LP64__',
    'struct __ms_timeval { __LONG32 tv_sec; __LONG32 tv_usec; };',
    'typedef struct __ms_timeval TIMEVAL, *PTIMEVAL, *LPTIMEVAL;',
    '#    else',
    'typedef struct timeval TIMEVAL, *PTIMEVAL, *LPTIMEVAL;',
    '#    endif',
    '#  endif  // _MINGW_IP_TYPES_H',
  ];
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

export function buildFuncPtrArgCastTables(
  functions: ExtractedFunction[],
  globals: AnalyzedDataSymbol[],
  funcDefs: import('../types.js').ExtractedFunctionDefinition[],
  dataTypes: ExtractedDataType[],
  strings: ReadonlyArray<ExtractedString> = [],
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
      normalizeQualifiedReference(qualified),
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
    indexBothSpellings(paramFuncdefs, ambiguousSlots, qualified, fn.name, slots, sameSlots,
      normalizeQualifiedReference(qualified));
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
      const spelled = fieldDeclSpelling(f.dataType, f.size);
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
      const spelled = fieldDeclSpelling(f.dataType, f.size);
      if (spelled) into[f.name] = spelled;
    }
  }

  // The aggregates whose EMITTED declaration carries a converting constructor -
  // the small integer-only structs the header gives `T(uint32_t)` to, plus the
  // ones `d2_platform.h` writes by hand. A cast to one of those is legal C++ and
  // already means the reinterpretation; a cast to any other aggregate is not a
  // conversion that exists and has to be spelled as the bit move it is.
  const convertingAggregates = new Set<string>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' || !dt.name || !('fields' in dt)) continue;
    // A library type's definition is emitted behind `#ifndef _WIN32`, so on the
    // target that actually builds it is the Win32 SDK's plain struct and the
    // constructor is not there. `_FILETIME` and `tagPALETTEENTRY` are both
    // integer-only and would otherwise be claimed as converting.
    if (isLibraryType(dt.name, dt.category ?? '')) continue;
    const fields = (dt as import('../types.js').ExtractedStruct).fields ?? [];
    if (getIntegerConversionType(fields)) convertingAggregates.add(dt.name);
  }
  for (const name of buildWinsockInAddrClaim(dataTypes).converting) convertingAggregates.add(name);

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
  // Seeded with the SDK names whose declared return is `void *` - the model has
  // no record for an import thunk or a CRT name, so without this a store from
  // `VirtualAlloc` or `malloc` has no return type and no cast is written. The
  // loop below still lets a model function of the same bare name overrule it.
  //
  // The spelling is read through `isVoidPointerSpelling`, not compared against
  // the two literal forms: Ghidra records `CRT_CreateTLS` as returning `LPVOID`
  // and the header emits it that way, and an alias that missed the comparison
  // was not merely skipped — it was filed as a DISAGREEMENT, which deletes the
  // name even when a platform stub had already vouched for it.
  //
  // Every record of a name is collected before any of them decides, so the
  // answer does not depend on the order the model happens to list them in. A
  // name every record answers `void*` for is safe to key a cast on; one two
  // records disagree about is not. An `undefined*` return is Ghidra never
  // having curated the slot — a silence, not a second opinion — so it neither
  // vouches nor vetoes.
  const returnAnswers = new Map<string, { voidPointer: boolean; other: boolean }>();
  const noteReturn = (key: string, isVoidPointer: boolean): void => {
    const answer = returnAnswers.get(key) ?? { voidPointer: false, other: false };
    if (isVoidPointer) answer.voidPointer = true; else answer.other = true;
    returnAnswers.set(key, answer);
  };
  for (const fn of functions) {
    if (!fn.name) continue;
    if (UNCURATED_RETURN_TYPES.has((fn.returnType ?? '').trim())) continue;
    const ret = normalizeSignatureType(fn.returnType ?? '').replace(/\s+/g, ' ').trim();
    const isVoidPointer = isVoidPointerSpelling(ret);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    noteReturn(qualified, isVoidPointer);
    if (qualified !== fn.name) noteReturn(fn.name, isVoidPointer);
  }
  const voidPointerFunctions = new Set<string>(platformVoidPointerFunctionNames());
  for (const [name, answer] of returnAnswers) {
    if (answer.other) voidPointerFunctions.delete(name);
    else if (answer.voidPointer) voidPointerFunctions.add(name);
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
  // The convention the emitted declaration carries, claimed the same way: two
  // functions that share a spelling and disagree about the convention leave the
  // slot empty, because an overload-selecting cast written with the wrong one
  // selects nothing at all.
  const functionConventions: Record<string, string> = {};
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
  const conventionClaims = new Map<string, Set<string>>();
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
  // A SECONDARY-SOURCE function's prototype is not this call's prototype. The
  // Mac build carries its own `CopyRect` - a two-int Carbon helper at
  // DiabloII_macho:001668bd - and the merge indexes it under the bare name, so
  // every WINDOWS call to the Win32 `CopyRect` was cast to `(int *)` against a
  // record from another binary. Those functions are emitted behind
  // `#ifdef D2_PLATFORM_MAC` and only Mac bodies call them, which is the same
  // reason the declaration closure already refuses them. They stay in
  // `functionNames`: the identifier does denote a function either way.
  const headerOwned = platformDeclaredFunctionNames();
  for (const fn of functions) {
    if (!fn.name) continue;
    const params = [...(fn.parameters ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const qualified = fn.namespace ? `${fn.namespace}::${fn.name}` : fn.name;
    const paramSpellings = params.map(p => sigType(p.dataType ?? ''));
    const returnSpelling = sigType(fn.returnType ?? 'void');
    const conventionSpelling = conventionKeyword(fn.callingConvention);
    let owners = bareNameOwners.get(fn.name);
    if (!owners) { owners = new Set(); bareNameOwners.set(fn.name, owners); }
    owners.add(qualified);
    for (const key of nameSuffixes(qualified)) {
      functionNames.add(key);
      if (!headerOwned.has(key) && !fn.platform) {
        claim(functionParamTypes, paramTypeClaims, key, paramSpellings, paramSpellings.join('|'));
        claim(functionReturnTypes, returnTypeClaims, key, returnSpelling, returnSpelling);
        claim(functionConventions, conventionClaims, key, conventionSpelling, conventionSpelling);
      }
      let va = varArgClaims.get(key);
      if (!va) { va = new Set(); varArgClaims.set(key, va); }
      va.add(fn.hasVarArgs ? 'yes' : 'no');
      if (fn.hasVarArgs) varArgFunctions.add(key);
    }
  }
  // A Win32 name the target headers make an overload set. The model has no
  // record of an import thunk, so these tables miss it however it is spelled;
  // without the exact type the overload set cannot be reduced and the address
  // cannot be taken. `headerOwned` keeps the model out of these slots, and this
  // is the header's own answer rather than the database's guess at it.
  for (const [name, sig] of Object.entries(WIN32_OVERLOADED_INTRINSICS)) {
    functionParamTypes[name] = sig.paramTypes;
    functionReturnTypes[name] = sig.returnType;
    functionConventions[name] = sig.convention;
  }

  // A name whose DECLARATION the reconstruction is compiled against is the only
  // authority on its slots, and `headerOwned` deliberately keeps the database's
  // disagreeing record out of these tables. Without an entry here such a name
  // carries no slot type at all, so no pass can write the conversion the header
  // requires. See `HEADER_DECLARED_SIGNATURES`.
  for (const [name, sig] of Object.entries(HEADER_DECLARED_SIGNATURES)) {
    functionParamTypes[name] = sig.paramTypes;
    functionReturnTypes[name] = sig.returnType;
    functionConventions[name] = sig.convention;
  }

  // The generic-handle returns the SDK header declares. Same reason as the
  // overload set above: no model record exists for an import thunk, and this is
  // the header's own answer. A model function of the same name still wins.
  for (const [name, ret] of Object.entries(WIN32_GENERIC_HANDLE_RETURNS)) {
    if (functionReturnTypes[name] === undefined) functionReturnTypes[name] = ret;
  }

  // The emitter's own pseudo-op macros type their result exactly. A call table
  // is where every pass already looks for "what does this expression evaluate
  // to", and these are not model functions, so nothing claims those names.
  for (const [macro, type] of Object.entries(GHIDRA_PSEUDO_OP_RESULT_TYPES)) {
    if (functionReturnTypes[macro] === undefined && !functionNames.has(macro)) {
      functionReturnTypes[macro] = type;
    }
  }

  // A name some overload spells with `...` is never safe to index positionally.
  for (const [key, seen] of varArgClaims) {
    if (seen.size > 1 || seen.has('yes')) { varArgFunctions.add(key); }
  }

  // The imported SDK functions have no `Function` record at all — they are
  // import thunks — so every table above misses them and an argument crossing
  // into a Win32 slot has no declared type to be cast to. Ghidra writes those
  // prototypes into the pseudo-C as per-argument annotations; that is the SDK
  // header's own answer, not the database's guess at it, so it does not carry
  // the disagreement `headerOwned` exists to avoid. A name the database DOES
  // hold a record for is left to the tables above, including where they dropped
  // it as ambiguous: an overload disagreement must not be papered over here.
  const modelClaimed = new Set<string>();
  for (const fn of functions) {
    if (fn.name && !headerOwned.has(fn.name) && !fn.platform) modelClaimed.add(fn.name);
  }
  const pointerOnlyParamTypes = harvestAnnotatedParameterTypes(functions, modelClaimed);

  const globalTypes: Record<string, string> = {};
  const ambiguousGlobalTypes = new Set<string>();
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (!name || /[^A-Za-z0-9_]/.test(name)) continue;
    // A POINTER TO AN ARRAY has no prefix cast spelling: `(byte[32768] *)p` is
    // not C++ at all, and flattening it to `(byte *)` would name a different
    // type — one element wide instead of the whole row. `d2_platform.h` already
    // writes a row typedef for the same shape appearing as a return type, so the
    // cast is spelled through it and the type is preserved exactly.
    const spelled = arrayRowSpelling(
      normalizeGlobalDeclType(g.suggestedType || g.dataType || ''));
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

  // The string constants enter the address table HERE, through the shared
  // builder, so the pass and the scope analysis resolve against one table. They
  // are not globals — see `stringConstantExtents` — and the only thing their
  // membership changes is the spelling of a reference to one.
  const { globalAddresses, globalSizes, stringConstantNames } =
    buildGlobalAddressExtentTables(globals, strings);

  // Global name → the namespace segments its DEFINITION is emitted in. A literal
  // address is folded into a body anywhere — a table in one module pointing into
  // another module's data — so a reference resolved from one has to name the
  // scope the global actually lives in, exactly as `func-ptr-literal` does for a
  // function. Same source and same ambiguity rule as the address table.
  //
  // Two restrictions, both to keep this from ever making a reference WORSE than
  // the bare name it replaces:
  //
  //  - only `scope === 'global'`. Those are the symbols `globals.h` emits
  //    through `groupByEmittedNamespace`, so their emitted scope is the one this
  //    helper reports. A file-local static, a static local and a
  //    struct-colocated extern are written by other emitters into scopes those
  //    emitters decide; a bare name is what they get, which is what they got
  //    before this table existed.
  //
  //  - not a leading segment a root-scope entity of the same name can block.
  //    `generateGlobalsHeader` folds such a segment away (`setUnopenableRootNames`)
  //    and it has not run yet when this table is built, so the segment list here
  //    could name a namespace the header never opens. Dropping those names costs
  //    an unqualified reference; keeping them would cost an unresolvable one.
  const globalNamespaces: Record<string, readonly string[]> = {};
  {
    const blockableLeadSegments = new Set<string>();
    for (const dt of dataTypes) {
      if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION' || dt.kind === 'ENUM') {
        if (dt.name) blockableLeadSegments.add(dt.name);
      }
    }
    for (const g of globals) {
      if (g.scope === 'global' && !g.namespace) {
        const n = g.suggestedName || g.name;
        if (n) blockableLeadSegments.add(n);
      }
    }
    const ambiguous = new Set<string>();
    for (const g of globals) {
      const name = g.suggestedName || g.name;
      if (!name || /[^A-Za-z0-9_]/.test(name)) continue;
      if (ambiguous.has(name)) continue;
      if (g.scope !== 'global') continue;
      const segments = emittedNamespaceOf(g).segments;
      if (segments.length > 0 && blockableLeadSegments.has(segments[0])) continue;
      const existing = globalNamespaces[name];
      if (existing !== undefined && existing.join('::') !== segments.join('::')) {
        ambiguous.add(name);
        delete globalNamespaces[name];
        continue;
      }
      globalNamespaces[name] = [...segments];
    }
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
  // A row typedef stands for the array it was written for, so every shape
  // computed through it is the one the unspelled `T[N]` had. Only the SPELLING
  // of the cast changes; nothing downstream sees a different type.
  for (const g of globals) {
    const row = arrayRowReturn(
      normalizeGlobalDeclType(g.suggestedType || g.dataType || ''));
    if (row) typedefTargets[row.typedefName] = `${row.element}${row.dims.map(d => `[${d}]`).join('')}`;
  }

  if (process.env.RECON_DUMP_TABLES) {
    const probe = (process.env.RECON_DUMP_TABLES || '').split(',');
    for (const k of probe) {
      console.error(`[probe] ${k}: params=${JSON.stringify(functionParamTypes[k])} ret=${JSON.stringify(functionReturnTypes[k])} isFn=${functionNames.has(k)} varArg=${varArgFunctions.has(k)} isVar=${variableNames.includes(k)} global=${JSON.stringify(globalTypes[k])} funcdefSlots=${JSON.stringify(paramFuncdefs[k])} sig=${JSON.stringify(functionSignatures[k])}`);
    }
  }
  return {
    paramFuncdefs,
    zeroArityCallbackSlots: WIN32_ZERO_ARITY_CALLBACK_SLOTS,
    zeroArityCallbackCasts: WIN32_ZERO_ARITY_CALLBACK_CASTS,
    funcdefSignatures,
    functionSignatures,
    variableNames,
    voidPointerFunctions: [...voidPointerFunctions],
    rootQualifiedTypedefs,
    voidPointerFields,
    functionParamTypes,
    pointerOnlyParamTypes,
    functionReturnTypes,
    functionConventions,
    functionNames: [...functionNames],
    overloadedFunctionNames: [...new Set([
      ...[...bareNameOwners].filter(([, o]) => o.size > 1).map(([n]) => n),
      // Overloaded by the TARGET headers rather than by the model - the set has
      // one member here and several there, and the cast has to say which.
      ...Object.keys(WIN32_OVERLOADED_INTRINSICS),
      ...Object.entries(HEADER_DECLARED_SIGNATURES).filter(([, s]) => s.overloaded).map(([n]) => n),
    ])],
    globalTypes,
    globalAddresses,
    globalSizes,
    globalNamespaces,
    stringConstantNames,
    varArgFunctions: [...varArgFunctions],
    fieldTypes,
    typedefTargets,
    structFields,
    convertingAggregates: [...convertingAggregates],
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


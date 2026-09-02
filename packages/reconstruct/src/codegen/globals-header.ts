/**
 * Globals header generation
 *
 * Generates a globals.h file with extern declarations for all global data symbols.
 * Also provides helpers for generating static local declarations.
 */

import type { AnalyzedDataSymbol, ReconstructOptions, DataValue, ExtractedDataType, ExtractedStruct, ExtractedUnion, ExtractedFunctionDefinition, ExtractedFunction } from '../types.js';
import { GLIDE_UNSIGNED_ENUM_TYPEDEFS, PLATFORM_STRUCT_FIELD_TYPES, getAggregateTypeNames, isPlatformOrBuiltinType, isLibraryType, isStructType, castPointerInitializer, normalizeDataValue, isCharacterValueType, isMsvcEhInternal, normalizeWideCharType, normalizeListingBuiltinType, listingBuiltinElementType, imageArtifactElementType, isVoidPointerSpelling, resolveTypedefSpelling, rootQualifyShadowedType, platformDeclaredFunctionNames } from './platform-types.js';
import { generateStructDeclaration, generateUnionDeclaration, generateFunctionDefinitionDeclaration, ghidraDefaultFieldName } from './header.js';
import { normalizeQualifiedReference } from './namespace.js';
import { namespaceResolution, renderNamespace, type ResolvedNamespace } from './namespace-resolution.js';
import { computeDeclarationClosure, renderClosureBlock, renderClosureDefinitionBlock, normalizeDataAddress, type ClosureResult, type ClosureStringContent } from './declaration-closure.js';
import { allOnesSentinel, negativeBytePatternInUnsignedSlot, negativeInUnsignedSlot } from './sentinel-literal.js';
import { enumTypedefLine } from './enum-width.js';
import { addressLiteralFloor, ADDRESS_LITERAL_CEILING } from '@ghidra-mcp/cpp-parser';

/**
 * Exact Win32 SDK typedef names (not `LP`/`IMAGE_` prefixed) seen as
 * `struct X;` forward decls that clash with `<windows.h>`/`<winsock2.h>` typedefs.
 */
const KNOWN_WIN32_TYPEDEFS = new Set<string>([
  'RGBQUAD', 'COLORREF', 'WSADATA', 'SYSTEM_INFO',
  'OSVERSIONINFOA', 'TIME_ZONE_INFORMATION', 'CANDIDATELIST',
]);

/** `LP`-prefixed Win32 pointer typedefs whose base type we must not forward-declare. */
const KNOWN_WIN32_LP_BASES = new Set<string>([
  'WSADATA', 'OSVERSIONINFO', 'OSVERSIONINFOA', 'SYSTEM_INFO',
  'TIME_ZONE_INFORMATION', 'CANDIDATELIST',
]);

/**
 * Conservatively recognise a Win32 SDK typedef by name alone, for the case where
 * the type has no `dataTypes` entry (so its Ghidra category is unknown) yet is
 * clearly Win32. The real SDK header (pulled in by d2_platform.h under _WIN32)
 * already provides these as TYPEDEFs, so `struct X;` after the typedef is an error.
 * Only Win32 families are matched — nothing that could be a D2 game type.
 */
function isKnownWin32Typedef(name: string): boolean {
  if (KNOWN_WIN32_TYPEDEFS.has(name)) return true;
  // IMAGE_* PE/COFF structures (IMAGE_FILE_HEADER, IMAGE_NT_HEADERS32, ...)
  if (name.startsWith('IMAGE_')) return true;
  // LP<base> pointer typedefs for the known Win32 set (LPWSADATA, LPSYSTEM_INFO, ...)
  if (name.startsWith('LP') && KNOWN_WIN32_LP_BASES.has(name.slice(2))) return true;
  return false;
}

/**
 * Build a predicate that decides whether a bare type name is a library type that
 * the real SDK header already provides — so we must NOT emit a `struct X;`
 * forward declaration for it. Resolves the name to its Ghidra category via the
 * available `dataTypes` and defers to `isLibraryType`; falls back to a
 * conservative Win32-name check when the type has no `dataTypes` entry.
 */
function makeLibraryTypeSkipPredicate(
  dataTypes?: ExtractedDataType[]
): (name: string) => boolean {
  const categoryByName = new Map<string, string>();
  if (dataTypes) {
    for (const dt of dataTypes) {
      if (!categoryByName.has(dt.name)) categoryByName.set(dt.name, dt.category);
    }
  }
  return (name: string): boolean => {
    const category = categoryByName.get(name);
    if (category !== undefined && isLibraryType(name, category)) return true;
    if (isKnownWin32Typedef(name)) return true;
    return false;
  };
}

/**
 * Generate globals.h content
 *
 * This file contains:
 * - Extern declarations for all multi-function globals
 * - Constants for read-only data with known values
 */
/**
 * Drop globals whose TYPE is an MSVC-EH internal (C++ exception-handling
 * metadata: `__ehfuncinfo$…` typed as FuncInfo / UnwindMapEntry / HandlerType /
 * TryBlockMapEntry). No real header declares those types, so emitting these
 * globals yields "X does not name a type" wherever they land.
 *
 * NOTE: only EH internals — NOT Win32 SDK types (RGBQUAD, SYSTEMTIME, …), which
 * the real <windows.h> provides, so game globals typed as those stay.
 *
 * The DECLARATION side (globals.h) and the DEFINITION side (globals.cpp, and the
 * co-located blocks in struct .cpp files) must agree on this, or globals.cpp
 * defines symbols whose type no TU can see.
 */
function isEmittableGlobal(g: AnalyzedDataSymbol): boolean {
  const base = (g.suggestedType || g.dataType || '')
    .replace(/[*&]/g, '').replace(/\bconst\b/g, '').replace(/\[[^\]]*\]/g, '').trim();
  return !isMsvcEhInternal(base);
}

/**
 * Decompiler/linker artifacts that are not program data: switch jump tables,
 * relative-offset jump entries, and per-element aliases of an array that is
 * itself declared. globals.h has always filtered these out of the DECLARATION
 * set; globals.cpp did not filter its DEFINITION set, so it defined symbols no
 * TU could see declared — including `Alignment LAB_00687d4a = align(1);`, which
 * is padding, not a variable. The two sets must be the same set.
 */
export function isDataArtifact(g: AnalyzedDataSymbol, allNames: Set<string>): boolean {
  const name = g.suggestedName || g.name;
  return isSwitchTableSymbol(name)
    || isJumpTableArtifact(g)
    || isArrayElementSymbol(name, allNames);
}

/**
 * A symbol globals.h will never declare, and that therefore no body can ever
 * name: a switch/jump-table artifact, a per-element alias of an array that is
 * itself declared, or an interior label inside another symbol
 * (`gsCharSelState1.szCommandStringTable[484]`).
 *
 * The per-file `static` emitter used to define these anyway, one zero-initialised
 * object per file that happened to own the parent's address range — objects with
 * the PARENT's type and size and none of its data, that nothing references.
 * Declaration and definition share this one predicate now.
 */
export function isUnreferenceableArtifact(g: AnalyzedDataSymbol, allNames: Set<string>): boolean {
  // Interiority is a property of the EMITTED name: `s_.D_0070888c` is a Ghidra
  // string label, not a member path, and it sanitizes to the perfectly ordinary
  // identifier `s__D_0070888c` that five bodies name.
  return isDataArtifact(g, allNames) || isInteriorLabel(sanitizeSymbolName(g.suggestedName || g.name));
}

/**
 * The globals that an output file actually took responsibility for emitting.
 * Populated as each impl file is generated; consumed by
 * `reconcileOrphanedGlobals`. Identity-based deliberately: comparing PATHS is
 * what let these symbols go missing in the first place.
 */
const claimedGlobals = new WeakSet<AnalyzedDataSymbol>();

/**
 * Globals that globals.h refused to declare because a FUNCTION already owns the
 * name in that scope. globals.cpp must skip the same set, or it emits a
 * definition that redeclares the function ("redeclared as different kind of
 * entity"). Declaration and definition share one decision, recorded here.
 */
const functionCollidingGlobals = new Set<AnalyzedDataSymbol>();

/**
 * The globals `globals.h` actually emitted an extern for. globals.cpp forward-
 * declares only what is NOT in here: adding a second declaration for a symbol
 * the header already declares would expose (as "conflicting declaration") any
 * place the two sides normalize the type differently, which is a separate bug.
 */
const headerDeclaredGlobals = new Set<AnalyzedDataSymbol>();

/**
 * Every NAME the tree actually emits a declaration for.
 *
 * The model is not the answer to "is this declared?": a symbol Ghidra has can be
 * dropped by any of the globals filters and still be referenced by a body — that
 * asymmetry IS the closure gap. So the emitters record what they emit, and the
 * closure pass reads this rather than the model. Over-recording is the safe
 * direction (it suppresses a closure declaration, leaving an error); under-
 * recording risks a second, conflicting declaration.
 */
const emittedDeclarationNames = new Set<string>();

export function recordDeclaredName(name: string | undefined | null): void {
  if (name) emittedDeclarationNames.add(name);
}

export function resetDeclaredNames(): void {
  emittedDeclarationNames.clear();
}

export function getDeclaredNames(): ReadonlySet<string> {
  return emittedDeclarationNames;
}

/**
 * The full pre-exclusion model, held for the closure pass. Codegen drops the
 * excluded namespaces before anything is emitted, so by the time the gap is
 * measurable the data that would close it is already gone.
 */
let closureFunctions: ReadonlyArray<ExtractedFunction> = [];
let closureGlobals: ReadonlyArray<AnalyzedDataSymbol> = [];
let closureEmittedFunctionNames: ReadonlySet<string> = new Set<string>();
let closureRenderPrototype: ((func: ExtractedFunction) => string | null) | undefined;

export function setDeclarationClosureModel(
  functions: ReadonlyArray<ExtractedFunction>,
  globals: ReadonlyArray<AnalyzedDataSymbol>,
): void {
  closureFunctions = functions;
  closureGlobals = globals;
}

/**
 * Byte content for the data the closure declares, keyed by normalized address.
 *
 * Held here rather than passed down because the closure is computed deep inside
 * `generateGlobalsHeader`, exactly like the model above it. Empty until
 * extraction supplies it, and an empty map is not an error: every declaration
 * still gets emitted, they simply stay undefined and say so in the report.
 */
let closureStringContent: ReadonlyMap<string, ClosureStringContent> = new Map();

export function setDeclarationClosureDataContent(
  strings: ReadonlyArray<{ address: string; value: string; length: number; encoding: string }>,
): void {
  const byAddress = new Map<string, ClosureStringContent>();
  for (const s of strings) {
    if (!s.address) continue;
    const key = normalizeDataAddress(s.address);
    // First wins. Two records for one address would be two readings of the same
    // bytes, and picking the later one silently would make the tree depend on
    // extraction order.
    if (!byAddress.has(key)) {
      byAddress.set(key, { value: s.value, length: s.length, encoding: s.encoding });
    }
  }
  closureStringContent = byAddress;
}

export function setDeclarationClosureEmitters(
  emittedFunctionNames: ReadonlySet<string>,
  renderPrototype: (func: ExtractedFunction) => string | null,
): void {
  closureEmittedFunctionNames = emittedFunctionNames;
  closureRenderPrototype = renderPrototype;
}

/** Record that an output file emits these globals itself. */
export function markGlobalsClaimed(globals: Iterable<AnalyzedDataSymbol> | undefined): void {
  if (!globals) return;
  for (const g of globals) claimedGlobals.add(g);
}

/**
 * Put back every global that no output file ended up claiming.
 *
 * `computeFileLocalGlobals` demotes a global to `file-local` when all its
 * referencing functions land in one impl file, and the struct-co-location pass
 * demotes one to `struct-colocated` when its type is owned by a header. Both
 * record a PATH, and both paths are recomputed independently of the paths the
 * file generator actually emits (`effectiveUnitName`, type-ownership overrides
 * and module resolution can all move a unit's file). When the two disagree, the
 * global is emitted by nobody: no extern in globals.h, no definition anywhere,
 * and the bodies that use it fail with "was not declared in this scope".
 *
 * That is the worst failure mode in this file — a symbol Ghidra knows, with a
 * name and a type, vanishing without a diagnostic. So the demotion is treated as
 * an OPTIMIZATION that must be verified: if the owning file is not among the
 * files actually generated, the global goes back to `global` scope and gets its
 * declaration and definition in globals.h/globals.cpp.
 *
 * @returns the globals that were restored, for reporting.
 */
export function reconcileOrphanedGlobals(
  globals: AnalyzedDataSymbol[]
): AnalyzedDataSymbol[] {
  const restored: AnalyzedDataSymbol[] = [];
  for (const g of globals) {
    if (g.scope !== 'file-local' && g.scope !== 'struct-colocated') continue;
    if (claimedGlobals.has(g)) continue;
    g.scope = 'global';
    g.ownerFile = undefined;
    g.ownerStructType = undefined;
    g.ownerStructHeader = undefined;
    restored.push(g);
  }
  return restored;
}

/**
 * A global named by a CENTRAL initializer cannot stay file-scoped.
 *
 * `computeFileLocalGlobals` demotes a global to static-local/file-local from its
 * XREF count, which counts function bodies only — a reference from another
 * global's initializer is invisible to it. globals.cpp then initializes
 * `gaUnitSoundTable[...] = { …, gaUnitSoundTableModeChange, … }` naming a symbol
 * that is `static` inside D2Common/Unit/UnitSnd.cpp. Promote every such symbol
 * back to `global` so the reference keeps its NAME instead of decaying to an
 * address literal. Iterated to a fixpoint: a promoted symbol's own initializer
 * can name the next one.
 */
export function promoteCentrallyReferencedGlobals(globals: AnalyzedDataSymbol[]): AnalyzedDataSymbol[] {
  const byName = new Map<string, AnalyzedDataSymbol[]>();
  for (const g of globals) {
    const n = sanitizeSymbolName(symbolEmittedName(g));
    if (!n) continue;
    const list = byName.get(n);
    if (list) list.push(g); else byName.set(n, [g]);
  }

  const rootOf = (value: string): string | undefined => {
    const m = value.replace(/\b(?:compiler|VisualStudio)::/g, '').match(/^([A-Za-z_]\w*)/);
    return m ? m[1] : undefined;
  };

  const promoted: AnalyzedDataSymbol[] = [];
  let frontier = globals.filter(g => g.scope === 'global' && g.initializedData);
  while (frontier.length > 0) {
    const next: AnalyzedDataSymbol[] = [];
    const visit = (dv: DataValue | undefined): void => {
      if (!dv) return;
      if (dv.kind === 'pointer' && dv.value) {
        const root = rootOf(dv.value);
        const candidates = root ? byName.get(root) ?? [] : [];
        // Two distinct Ghidra symbols can share an emitted name; then there is
        // no telling which one the initializer meant, and promoting BOTH gives
        // globals.cpp two definitions of it. Promote only an unambiguous name.
        if (candidates.length !== 1) return;
        for (const g of candidates) {
          if (g.scope !== 'static-local' && g.scope !== 'file-local') continue;
          g.scope = 'global';
          g.ownerFile = undefined;
          g.ownerFunction = undefined;
          promoted.push(g);
          if (g.initializedData) next.push(g);
        }
      }
      for (const e of dv.elements ?? []) visit(e);
      for (const f of dv.fields ?? []) visit(f.value);
    };
    for (const g of frontier) visit(g.initializedData);
    frontier = next;
  }
  return promoted;
}

/**
 * Resolve the CENTRAL globals' initializers once, ahead of the header, purely to
 * learn which symbols they will name.
 *
 * The declaration closure — the `extern char s_X[];` in globals.h and the one
 * matching definition the shared globals unit emits — is computed inside
 * `generateGlobalsHeader`, and `emitCentralGlobalsUnits` runs after it. So a
 * string that ONLY a globals unit's initializer resolves was added to
 * `initializerAddressReferences()` too late for the header that had to declare
 * it: seventeen `error: 'NAME' was not declared in this scope`, across
 * `globals.cpp`, `globals.Bnclient.cpp` and `globals.D2Multi.cpp`.
 *
 * A static-locals block never had the problem — `impl.ts` emits it during
 * `generateFilesForFunctions`, earlier than either — which is why
 * `s_Diablo_II_006cc8b8` came out declared and `s_D2_LNG_006d5ee0` did not. The
 * partitioned units are not a different PATH, they are a later one.
 *
 * This re-derives nothing: it calls the same two renderers `generateGlobalsImpl`
 * calls, over the same symbols, and throws the text away. The set it records is
 * deliberately a SUPERSET — it does not repeat the emitter's definition-winner
 * and template-namespace filters — because a name missing here is a build error
 * while an extra one is an unreferenced definition.
 */
export function recordCentralInitializerAddressReferences(
  globals: readonly AnalyzedDataSymbol[]
): void {
  // Emission counts this for the database owner; a discovery pass that counted
  // it too would double every mismatch in the report.
  const mismatchesBeforeDiscovery = initializerFuncPtrArityMismatches;
  for (const global of globals) {
    const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
    setInitializerOwnerAddress(global.address);
    if (global.initializedData) {
      emitDataValue(global.initializedData, 0, type);
    } else if (global.isInitialized) {
      renderGlobalScalarInitializer(global.value, type, inferArrayDeclaration(global)?.count);
    }
    setInitializerOwnerAddress(undefined);
  }
  initializerFuncPtrArityMismatches = mismatchesBeforeDiscovery;
}

export function generateGlobalsHeader(
  globals: AnalyzedDataSymbol[],
  options: ReconstructOptions & { projectName?: string; binaryName?: string },
  dataTypes?: ExtractedDataType[],
  typeOwnerMap?: Map<string, string>,
  functionQualifiedNames?: Set<string>,
  bodyIdentifierFnCounts?: Map<string, number>
): string {
  const lines: string[] = [];

  // The globals units are emitted AFTER this header, so what their initializers
  // resolve to has to be discovered here, or the closure below declares none of
  // it. Same symbols the units will be given, same renderers.
  recordCentralInitializerAddressReferences(globals);

  // Qualified function names (namespace::name) emitted elsewhere as their own
  // declarations. A data symbol can share its name with a function in the same
  // namespace (e.g. D2Game::Game::Record::IsRecording is BOTH a function getter
  // at 0x451980 and a backing-flag data label at 0x7a2784). Emitting an
  // `extern BOOL IsRecording;` in that namespace redeclares the function
  // ("redeclared as different kind of entity"), so the function wins and we
  // suppress the colliding global.
  const fnNames = functionQualifiedNames ?? new Set<string>();

  // Predicate: should we SKIP emitting a `struct X;` forward decl for this type?
  // True when the type is provided by the real Win32 SDK / CRT (pulled in by
  // d2_platform.h under _WIN32) — emitting `struct X;` after the SDK typedef X is
  // an error ("using typedef-name 'X' after 'struct'"). Recognised either by the
  // type's Ghidra category (a system-header path) or by a conservative Win32 name set.
  const isSkippableLibraryType = makeLibraryTypeSkipPredicate(dataTypes);

  // Aggregates this build declares somewhere, so a `struct X;` here is a forward
  // declaration of the same type rather than a second, unrelated one.
  const forwardDeclarableTypeNames = new Set<string>();
  for (const dt of dataTypes ?? []) {
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') forwardDeclarableTypeNames.add(dt.name);
  }

  globals = globals.filter(isEmittableGlobal);
  functionCollidingGlobals.clear();
  headerDeclaredGlobals.clear();

  // Header comment
  lines.push('/**');
  lines.push(' * Auto-generated global data declarations');
  if (options.binaryName) {
    lines.push(` * Binary: ${options.binaryName}`);
  }
  lines.push(' * ');
  lines.push(' * This file contains extern declarations for global data symbols');
  lines.push(' * that are referenced by multiple functions.');
  lines.push(' */');
  lines.push('');

  // Include guard
  lines.push('#pragma once');
  lines.push('');

  // Standard includes
  lines.push('#include <cstdint>');
  lines.push('#include <cstddef>');
  lines.push('#include "d2_platform.h"');

  // Classify types: by-value types get full definitions, pointer-only types get forward declarations
  const { forwardDecls, fullDefs, extraIncludes: byValueIncludes, sharedHeaderOwned } = collectGlobalForwardDeclarations(globals, dataTypes, typeOwnerMap);

  // Include headers for by-value types that have an owning header (avoid duplicate definitions)
  if (byValueIncludes.length > 0) {
    for (const inc of byValueIncludes) {
      lines.push(`#include "${inc}"`);
    }
  }
  lines.push('');

  // Safety net: scan all globals for type names that may be missing from forward declarations
  const declaredNames = new Set<string>(sharedHeaderOwned);
  for (const decl of forwardDecls) declaredNames.add(decl.name);
  for (const def of fullDefs) {
    const m = def.match(/^struct\s+(\w+)/);
    if (m) declaredNames.add(m[1]);
    const em = def.match(/^enum\s+(\w+)/);
    if (em) declaredNames.add(em[1]);
    const tm = def.match(/typedef\s+.*?\(\*(\w+)\)/);
    if (tm) declaredNames.add(tm[1]);
  }
  // Types from by-value includes are also available (the header defines them)
  // We don't need to enumerate - the include handles it
  for (const g of globals) {
    const type = (g.suggestedType || g.dataType).replace(/\*/g, '').replace(/&/g, '').replace(/const\s*/g, '').replace(/\[[^\]]*\]/g, '').trim();
    if (!type || declaredNames.has(type) || isPlatformOrBuiltinType(type)) continue;
    if (isSkippableLibraryType(type)) continue;
    if (!/^[A-Za-z_]\w*$/.test(type)) continue;
    // Skip enum types (eXxx convention) — they're typedef int, not structs
    if (/^e[A-Z]/.test(type)) continue;
    // Skip function pointer typedefs (fnXxx, fpXxx convention)
    if (/^fn[A-Z]/.test(type) || /^fp[A-Z]/.test(type)) continue;
    // Skip types that look like they're from d2_enums.h or standard typedefs
    if (/^__\w+_t$/.test(type)) continue;
    forwardDecls.push({ name: type, text: emitFallbackForwardDecl(type), deps: [] });
    declaredNames.add(type);
  }

  if (forwardDecls.length > 0) {
    lines.push('// Forward declarations');
    for (const decl of orderForwardDeclarations(forwardDecls)) {
      lines.push(decl);
    }
    lines.push('');
  }

  // Full type definitions for by-value types (structs, enums, unions, function typedefs)
  if (fullDefs.length > 0) {
    lines.push('// Full type definitions (used by value in globals)');
    for (const def of fullDefs) {
      lines.push(def);
      lines.push('');
    }
  }

  // Collect names that must NOT appear as a namespace component, because they
  // are already emitted at an outer scope as a different kind of entity:
  //   - forward-declared struct/class names; AND
  //   - global variable names (a BOOL global `IsRecording` collides with a
  //     same-named `namespace IsRecording { ... }` — "redeclared as different
  //     kind of entity"). The variable declaration must win; strip the colliding
  //     namespace component so the inner symbols fold into the parent scope.
  const collidingNamespaceParts = new Set<string>();
  for (const decl of forwardDecls) {
    if (decl.text === `struct ${decl.name};` || decl.text === `class ${decl.name};`) {
      collidingNamespaceParts.add(decl.name);
    }
    // A block that DEFINES the aggregate introduces the same root-scope name a
    // forward declaration does, so it blocks a namespace of that name just as
    // hard. Promoting an unowned type from declaration to definition must not
    // quietly lift that constraint.
    if (decl.defines) {
      collidingNamespaceParts.add(decl.name);
    }
  }
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const gName = g.suggestedName || g.name;
    if (isInteriorLabel(gName)) continue;
    // A root-scope variable of that name blocks a root-scope namespace of it too.
    if (g.namespace) continue;
    collidingNamespaceParts.add(sanitizeSymbolName(gName));
  }

  // Only the names this header introduces at ROOT scope can block a namespace
  // there. Published so globals.cpp, which includes this header, is bound by the
  // same conflict.
  setUnopenableRootNames(collidingNamespaceParts);
  const byNamespace = groupByEmittedNamespace(globals);

  // Build name set for array element suppression
  const allGlobalNames = new Set(globals.map(g => g.suggestedName || g.name));

  // Constants section (small, known values) — CURRENTLY UNUSED
  // The constant scope is not assigned anywhere after removing broken heuristic.
  // This section is kept for future use when we have proper readonly segment detection.
  const constants = globals.filter(g =>
    g.scope === 'constant'
    && !isSwitchTableSymbol(g.suggestedName || g.name)
    && !isJumpTableArtifact(g)
    && !isArrayElementSymbol(g.suggestedName || g.name, allGlobalNames)
  );
  if (constants.length > 0) {
    lines.push('// =============================================================================');
    lines.push('// Constants (read-only data with known values)');
    lines.push('// =============================================================================');
    lines.push('');

    // Group constants by namespace (same as globals)
    const constantsByNamespace = groupByEmittedNamespace(constants);
    for (const { resolved: constantsScope, rendered: rawNamespace, symbols: nsConstants } of constantsByNamespace) {
      void constantsScope;
      if (nsConstants.length === 0) continue;
      // Skip template instantiation namespaces (contain < > , *)
      if (rawNamespace && /[<>,*]/.test(rawNamespace)) continue;

      // Collapse consecutive duplicate segments (Quests::Quests → Quests) so the
      // emitted namespace matches the collapsed form bodies use to reference these
      // constants — otherwise the qualified reference fails ("not a member of").
      const namespace = rawNamespace;

      if (namespace) {
        lines.push(`namespace ${namespace} {`);
        lines.push('');
      }

      for (const constant of nsConstants) {
        const comment = constant.address ? `// @${constant.address}` : '';
        const type = constant.suggestedType || constant.dataType;
        const name = constant.suggestedName || constant.name;
        const arrayInfo = inferArrayDeclaration(constant);
        setInitializerOwnerAddress(constant.address);
        const value = renderGlobalScalarInitializer(constant.value, type, arrayInfo?.count);
        setInitializerOwnerAddress(undefined);
        const init = arrayInfo ? `{ ${value} }` : value;
        recordDeclaredName(name);
        lines.push(`constexpr ${normalizeArrayDeclaration(type, name)} = ${init}; ${comment}`);
      }

      if (namespace) {
        lines.push('');
        lines.push(`} // namespace ${namespace}`);
      }
      lines.push('');
    }
  }

  // Global extern declarations by namespace
  const globalSymbols = globals.filter(g =>
    g.scope === 'global'
    && !isSwitchTableSymbol(g.suggestedName || g.name)
    && !isJumpTableArtifact(g)
    && !isArrayElementSymbol(g.suggestedName || g.name, allGlobalNames)
  );
  // Track emitted global names to avoid duplicate extern declarations with conflicting types
  const emittedGlobalNames = new Set<string>();

  if (globalSymbols.length > 0) {
    lines.push('// =============================================================================');
    lines.push('// Global data (referenced by multiple functions)');
    lines.push('// =============================================================================');
    lines.push('');

    for (const { rendered: namespace, symbols: nsGlobals } of byNamespace) {
      const nsGlobalSymbols = nsGlobals.filter(g =>
        g.scope === 'global'
        && !isSwitchTableSymbol(g.suggestedName || g.name)
        && !isJumpTableArtifact(g)
        && !isArrayElementSymbol(g.suggestedName || g.name, allGlobalNames)
      );
      if (nsGlobalSymbols.length === 0) continue;

      // Skip template instantiation namespaces (contain < > , *) — not valid C++
      if (namespace && /[<>,*]/.test(namespace)) continue;

      if (namespace) {
        lines.push(`namespace ${namespace} {`);
        lines.push('');
      }

      let currentIfdef: string | undefined;
      for (const global of nsGlobalSymbols) {
        // Skip duplicate extern declarations (same name, different namespace scope already emitted)
        const emitted = sanitizeSymbolName(global.suggestedName || global.name);
        const qualifiedName = namespace ? `${namespace}::${emitted}` : emitted;
        if (emittedGlobalNames.has(qualifiedName)) continue;
        // Skip globals that collide with a same-named function in the same scope
        // (the function declaration owns the name — see fnNames above).
        if (fnNames.has(qualifiedName)) {
          lines.push(`// skipped: ${qualifiedName} (collides with a function of the same name)`);
          functionCollidingGlobals.add(global);
          continue;
        }
        emittedGlobalNames.add(qualifiedName);
        headerDeclaredGlobals.add(global);
        // Group consecutive globals with the same ifdef under one guard
        if (global.ifdef !== currentIfdef) {
          if (currentIfdef) {
            lines.push(`#endif // ${currentIfdef}`);
          }
          if (global.ifdef) {
            lines.push(`#ifdef ${global.ifdef}`);
          }
          currentIfdef = global.ifdef;
        }
        {
          const decl = generateExternDeclaration(global, options.includeAddressComments);
          if (decl) lines.push(decl);
        }
      }
      // Close any open ifdef
      if (currentIfdef) {
        lines.push(`#endif // ${currentIfdef}`);
      }

      if (namespace) {
        lines.push('');
        lines.push(`} // namespace ${namespace}`);
      }
      lines.push('');
    }
  }

  // =============================================================================
  // Safety net: globals referenced in multiple function bodies but NOT emitted
  // above as a `scope==='global'` extern (e.g. classified `static-local` because
  // Ghidra under-reported xrefs to a single owner, yet the decompiler still names
  // the symbol in other bodies). Without a declaration those other TUs fail with
  // "X was not declared in this scope". Emit a fallback extern for any analyzed
  // symbol whose name is a valid identifier and appears in >1 function body.
  // =============================================================================
  if (bodyIdentifierFnCounts && bodyIdentifierFnCounts.size > 0) {
    const recovered: AnalyzedDataSymbol[] = [];
    const seen = new Set<string>();
    for (const g of globals) {
      if (g.scope === 'global') continue; // already handled above
      if (isSwitchTableSymbol(g.suggestedName || g.name)) continue;
      if (isJumpTableArtifact(g)) continue;
      if (isArrayElementSymbol(g.suggestedName || g.name, allGlobalNames)) continue;

      // Bodies name the symbol by its SANITIZED identifier; so does the extern.
      const rawName = sanitizeSymbolName(g.suggestedName || g.name);
      if (!/^[A-Za-z_]\w*$/.test(rawName)) continue;

      // Skip self-redeclarations: a symbol whose type base equals its own name
      // (e.g. an enum-typed global `eD2ApplicationMode eD2ApplicationMode`)
      // would emit `extern eD2ApplicationMode eD2ApplicationMode;`, which
      // redeclares the typedef as a variable ("redeclared as different kind of
      // entity"). The original extern section never reaches these (they're not
      // scope==='global'); don't resurrect them here.
      const baseType = (g.suggestedType || g.dataType || '')
        .replace(/[*&]/g, '').replace(/\bconst\b/g, '').replace(/\[[^\]]*\]/g, '')
        .replace(/\s+\d+$/, '').trim();
      if (baseType === rawName) continue;

      // Bodies reference the symbol by its sanitized identifier (same rule the
      // static-local injector uses). A valid identifier sanitizes to itself.
      const count = bodyIdentifierFnCounts.get(rawName) ?? 0;
      if (count <= 1) continue;

      const qualifiedName = g.namespace ? `${g.namespace}::${rawName}` : rawName;
      // Don't double-emit: already an extern above, or collides with a function.
      if (emittedGlobalNames.has(qualifiedName)) continue;
      if (fnNames.has(qualifiedName)) continue;
      if (seen.has(qualifiedName)) continue;
      seen.add(qualifiedName);
      recovered.push(g);
    }

    if (recovered.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Globals recovered from multi-function body references');
      lines.push('// (classified static-local by xref count, but named in other bodies too)');
      lines.push('// =============================================================================');
      lines.push('');

      const recoveredByNamespace = groupByEmittedNamespace(recovered);
      for (const { rendered: rawNamespace, symbols: nsGlobals } of recoveredByNamespace) {
        if (nsGlobals.length === 0) continue;
        if (rawNamespace && /[<>,*]/.test(rawNamespace)) continue;
        // Already the resolved spelling — groupByEmittedNamespace resolved it.
        const namespace = rawNamespace;
        if (namespace) {
          lines.push(`namespace ${namespace} {`);
          lines.push('');
        }
        for (const global of nsGlobals) {
          {
            const decl = generateExternDeclaration(global, options.includeAddressComments);
            if (decl) lines.push(decl);
          }
        }
        if (namespace) {
          lines.push('');
          lines.push(`} // namespace ${namespace}`);
        }
        lines.push('');
      }
    }
  }

  // Everything above declared what the globals model said to declare. The
  // bodies, meanwhile, reference names nothing declared at all — callees in
  // excluded namespaces, symbols the filters above dropped, and Ghidra's own
  // names for data it never typed. This is the one header every translation
  // unit includes, so it is where that closure belongs.
  if (bodyIdentifierFnCounts && bodyIdentifierFnCounts.size > 0) {
    // A symbol resolved into a DATA INITIALIZER is referenced by the tree even
    // though no function body names it: the initializer is emitted as text,
    // after the bodies were parsed and their identifiers counted. Without this
    // merge a string constant resolved in `gApplicationModeCommandLineArgumentArray`
    // would reach the compiler with nothing declaring it.
    const referencedNames = new Map(bodyIdentifierFnCounts);
    for (const name of initializerAddressReferences()) {
      if (!referencedNames.has(name)) referencedNames.set(name, 1);
    }
    const closure = computeDeclarationClosure({
      allFunctions: closureFunctions,
      allGlobals: closureGlobals,
      referenced: referencedNames,
      declared: emittedDeclarationNames,
      emittedFunctionNames: closureEmittedFunctionNames,
      renderPrototype: closureRenderPrototype ?? (() => null),
      renderExtern: (symbol) => {
        // Root scope: the references that fail are the UNQUALIFIED ones, so the
        // declaration has to be reachable unqualified too.
        const type = normalizeGlobalDeclType(symbol.suggestedType || symbol.dataType);
        const name = sanitizeSymbolName(symbol.suggestedName || symbol.name);
        if (!type || !name) return null;
        const base = type.replace(/[*&]/g, '').replace(/\[[^\]]*\]/g, '')
          .replace(/\b(const|volatile|struct|union|enum|unsigned|signed)\b/g, '')
          .replace(/\s+/g, ' ').trim();
        if (isMsvcEhInternal(base)) return null;
        // This block sits at the END of globals.h, and a TU can include a type's
        // owning header AFTER it. A named type therefore needs a forward
        // declaration here, and one this file is allowed to make: the SDK
        // provides its own types as typedefs, and `struct X;` after a typedef is
        // an error. When neither applies the symbol is left undeclared and
        // reported — an `extern` naming a type nobody declares is not a fix.
        // `string` and friends are Ghidra byte-layout names, not C types: a
        // declaration spelling one names a type nothing declares.
        if (['string', 'TerminatedCString', 'string-utf8', 'code'].includes(base)) return null;
        const forwards: string[] = [];
        if (base && base !== 'void' && !isPlatformOrBuiltinType(base)) {
          if (isSkippableLibraryType(base)) return null;
          if (!forwardDeclarableTypeNames.has(base)) return null;
          if (!/[*&]/.test(type)) return null;
          forwards.push(`struct ${base};`);
        }
        const arrayInfo = inferArrayDeclaration(symbol);
        const decl = arrayInfo
          ? `extern ${arrayInfo.type} ${name}[${arrayInfo.count}];`
          : `extern ${normalizeArrayDeclaration(type, name)};`;
        return [...forwards, decl].join('\n');
      },
      sanitize: sanitizeSymbolName,
      stringContentByAddress: closureStringContent,
    });
    for (const line of renderClosureBlock(closure.declarations)) lines.push(line);
    for (const d of closure.declarations) recordDeclaredName(d.name);
    lastClosureResult = closure;
  }

  return lines.join('\n');
}

/** The closure the last `generateGlobalsHeader` computed, for reporting. */
let lastClosureResult: ClosureResult | undefined;

export function getDeclarationClosureReport(): ClosureResult | undefined {
  return lastClosureResult;
}

/**
 * The definitions for the closure globals.h just declared. Empty until
 * `generateGlobalsHeader` has run, because the declaration set is what decides
 * the definition set.
 */
export function renderClosureDefinitions(): string[] {
  if (!lastClosureResult) return [];
  return renderClosureDefinitionBlock(lastClosureResult.declarations);
}

/**
 * Does the name READ like a path into another symbol — `g_chunks.capacity`,
 * `slots[0].highscores[0].score`, `DAT_0043e7e0+1`?
 *
 * Shape only. A dot is not proof of interiority: Ghidra's auto-label for string
 * data embeds the string's own text (`s_.I_00708874` is the four bytes `".I"`),
 * and a hand-given name can carry a filename (`MPQ_d2kfixup.mpq`,
 * `lpGLIDE3x.dll`). `isInteriorLabel` decides those from addresses.
 */
function looksLikeMemberPath(name: string): boolean {
  const segment = String.raw`[A-Za-z_]\w*(?:\[\d+\])*`;
  return new RegExp(`^${segment}(?:\\.${segment})+$`).test(name)
    || /^[A-Za-z_]\w*\+\d+$/.test(name);
}

/**
 * The member-path-shaped names `setInteriorLabelSymbols` saw, and the subset it
 * proved lie inside another datum. A name the registry never saw keeps the
 * shape test's answer — the registry replaces the guess only where it has the
 * addresses to replace it with.
 */
let judgedInteriorCandidates: ReadonlySet<string> | undefined;
let provenInteriorLabels: ReadonlySet<string> | undefined;

/**
 * Decide, from ADDRESSES, which member-path-shaped names are really interior.
 *
 * The shape test alone was wrong for a whole class and cost four symbols their
 * definitions: `generateExternDeclaration` and `emitGlobalDefsWithIfdef` both
 * drop an interior label, so `s_.I_00708874`, `s_.E_00708880`,
 * `MPQ_d2kfixup.mpq` and `lpGLIDE3x.dll` got neither declaration nor definition
 * — and the declaration closure, which reads the model rather than what the
 * emitters did, then declared them anyway. An `extern` with no definition in any
 * unit is exactly the link failure the closure's contract says it is not.
 *
 * Interiority is a property of the DATA, so it is read off the data:
 *
 *  - a label is interior when some other symbol's extent strictly contains its
 *    address. Only a symbol whose own name is not member-path-shaped can be that
 *    container: an interior label reports its PARENT's type and size, so
 *    `gaPaletteBlendEntries[52].peRed` claims 288 bytes and would swallow every
 *    unrelated symbol behind it;
 *  - failing that, a root segment that ends in Ghidra's own `_<address>` suffix
 *    names the datum the label sits in even when that datum has no record of its
 *    own — `dylib_command_00001bb0.dylib.current_version` at 00001bc4 is a field
 *    of the command at 00001bb0. A root with no address in it (`s_`, `TlsLinks`,
 *    `MPQ_d2kfixup`) says nothing, so the symbol stands on its own;
 *  - a `+N` offset label stays interior regardless. It is a byte offset into
 *    something by construction, and every one of them is a switch/jump artifact
 *    the data filters drop anyway.
 */
export function setInteriorLabelSymbols(globals: readonly AnalyzedDataSymbol[]): void {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (looksLikeMemberPath(name)) continue;
    const start = parseInt(g.address, 16);
    if (!Number.isFinite(start) || !(g.size > 1)) continue;
    starts.push(start);
    ends.push(start + g.size);
  }
  const order = starts.map((_, i) => i).sort((a, b) => starts[a] - starts[b]);
  const sortedStarts = order.map(i => starts[i]);
  // Running maximum of the end of every container starting at or before each
  // index, so "does any container reach past this address?" is one lookup.
  const maxEnd: number[] = [];
  let running = -Infinity;
  for (const i of order) {
    running = Math.max(running, ends[i]);
    maxEnd.push(running);
  }
  let maxSize = 0;
  for (let i = 0; i < starts.length; i++) maxSize = Math.max(maxSize, ends[i] - starts[i]);

  const containedStrictly = (addr: number): boolean => {
    let lo = 0, hi = sortedStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedStarts[mid] < addr) lo = mid + 1; else hi = mid;
    }
    return lo > 0 && maxEnd[lo - 1] > addr;
  };

  // A symbol strictly inside a container that reports the CONTAINER'S OWN SIZE
  // did not measure itself - it inherited the container's type, which is what
  // Ghidra hands back for a label placed on the interior of a typed object.
  // It cannot be an independent datum: an object at +4 cannot also be 80 bytes
  // and end past the thing containing it.
  //
  // Emitting storage for it is what makes two globals alias one object in the
  // original and NOT alias after relinking. gGameStateData4 became a second
  // 80-byte FILE*[20] beside globalOpenFileHandleArray, so the log manager wrote
  // through one and read through the other, and fclose() got a junk handle.
  // 15663 symbols across the program have this shape.
  //
  // Deliberately narrower than "contained": a contained symbol with its OWN
  // smaller size may well be a real field someone typed, and dropping those cost
  // four symbols their definitions once already - see the comment above.
  const sizeOfContainerAt = (addr: number, ownSize: number): boolean => {
    let lo = 0, hi = sortedStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedStarts[mid] < addr) lo = mid + 1; else hi = mid;
    }
    for (let k = lo - 1; k >= 0; k--) {
      const ci = order[k];
      if (ends[ci] <= addr) continue;
      if (starts[ci] < addr && ends[ci] - starts[ci] === ownSize) return true;
      if (starts[ci] + maxSize < addr) break;
    }
    return false;
  };

  const candidates = new Set<string>();
  const interior = new Set<string>();
  for (const g of globals) {
    const name = g.suggestedName || g.name;
    if (!looksLikeMemberPath(name)) {
      // Not member-path shaped, so the shape test never considers it - but the
      // inherited-size signature is proof on its own.
      // >= 8 bytes: the rule identifies a label that inherited a CONTAINER's type,
      // and a container is an array or struct. Without this bound, two 4-byte
      // symbols a byte or two apart satisfy "strictly contains, same size" purely
      // by misalignment - which is how gpfnMouseLeftButtonAltHandler lost its
      // declaration while its supposed container was itself only 4 bytes.
      const a = parseInt(g.address, 16);
      if (Number.isFinite(a) && g.size >= 8 && sizeOfContainerAt(a, g.size)) {
        candidates.add(name);
        interior.add(name);
      }
      continue;
    }
    candidates.add(name);
    if (/\+\d+$/.test(name)) { interior.add(name); continue; }
    const addr = parseInt(g.address, 16);
    // No address to judge by — keep the shape test's answer rather than
    // promoting a symbol on no evidence.
    if (!Number.isFinite(addr)) { interior.add(name); continue; }
    if (containedStrictly(addr)) { interior.add(name); continue; }
    const root = name.split('.')[0].replace(/(?:\[\d+\])+$/, '');
    const rootAddr = /_([0-9a-f]{6,})$/i.exec(root);
    if (rootAddr && parseInt(rootAddr[1], 16) !== addr) interior.add(name);
  }
  judgedInteriorCandidates = candidates;
  provenInteriorLabels = interior;
}

/** For tests and repeat runs: go back to the shape-only answer. */
export function resetInteriorLabelSymbols(): void {
  judgedInteriorCandidates = undefined;
  provenInteriorLabels = undefined;
}

/**
 * `g_chunks.capacity`, `slots[0].highscores[0].score`, `DAT_0043e7e0+1` — labels
 * Ghidra puts on the interior of a global: struct field paths once a type is
 * applied, or a byte offset into an untyped blob. The containing global is already
 * declared, so these are noise rather than something we failed to translate.
 *
 * With a registered globals model the answer comes from addresses
 * (`setInteriorLabelSymbols`); without one it falls back to the name's shape.
 */
export function isInteriorLabel(name: string): boolean {
  // Proven interior by the inherited-size rule, whatever the name looks like.
  if (provenInteriorLabels?.has(name)) return true;
  if (!looksLikeMemberPath(name)) return false;
  if (!judgedInteriorCandidates || !judgedInteriorCandidates.has(name)) return true;
  return provenInteriorLabels!.has(name);
}

/**
 * Ghidra type strings that are not legal C++ declaration types.
 *
 * Every place that turns a data symbol's type into a declaration — the extern in
 * globals.h, the definition in globals.cpp, the co-located definition in a struct
 * .cpp, the static local injected into a body — must apply the SAME normalization,
 * or the declaration and the definition disagree and the linker (or the compiler)
 * rejects them. Route all of them through this.
 *
 *   `auto`        what a data symbol Ghidra types bare `undefined` arrives as, and
 *                 nothing else: every one of them is a ONE-BYTE slot whose type is
 *                 undecided. `auto x;` needs an initializer, so it is illegal on an
 *                 extern and on a BSS definition alike - but the replacement has to
 *                 keep the width and the kind. `void*` kept neither: it turned a
 *                 1-byte integer slot into a 4-byte pointer. `uint8_t` is the same
 *                 answer `undefined1` already gets from all four mapping tables.
 *   `T *32`       Ghidra's pointer-SIZE annotation ("a 32-bit pointer to T"), not C
 *                 syntax: `void *32 x;` is "expected unqualified-id before numeric
 *                 constant". Also shows up as `undefined *32`.
 */
export function normalizeGhidraType(type: string): string {
  let t = type;
  if (t.trim() === 'auto') t = 'uint8_t';
  // "void *32" / "undefined *32" / "D2BeltsTxt *32" → "void*" / "undefined*" / …
  t = t.replace(/\s*\*\s*\d+\b/g, '*');
  // D2's 16-bit char reaches globals as WCHAR/wchar_t/wchar16/unicode; bodies and
  // signatures both settle on uint16_t, so globals must agree or every crossing is
  // an invalid conversion.
  t = normalizeWideCharType(t);
  // `string *` is `char *`, `IconResource` is a run of bytes. Ghidra's listing
  // BUILT_INs describe data, and nothing declares them as C++ types.
  t = normalizeListingBuiltinType(t);
  return t;
}

/**
 * Give every listing-BUILT_IN symbol the array declaration its bytes deserve.
 *
 * `IconResource Rsrc_Icon_5_409 = <Icon-Image>;` is two problems at once: the
 * type has no definition, and the "value" is listing text, not an expression.
 * The size is the part of the record that IS modelled and the part that has to
 * survive — the symbol occupies exactly that many bytes and the next symbol
 * begins after them — so the symbol is respelled as a byte array of its own size
 * with no initializer, which at namespace scope is the zero-fill it already was.
 *
 * Run once over the analyzed globals, so globals.h and globals.cpp cannot
 * disagree about a symbol's type.
 */
export function resolveListingBuiltinBlobs(globals: AnalyzedDataSymbol[]): void {
  for (const g of globals) {
    const element = listingBuiltinElementType(g.suggestedType || g.dataType);
    // A pointer TO one of these is a plain pointer and normalizes on its own.
    if (!element || /[*&]/.test(g.suggestedType || g.dataType || '')) continue;
    if (!(g.size > 1)) continue;
    g.suggestedType = `${element}[${g.size}]`;
    g.initializedData = undefined;
    g.value = undefined;
  }
}

/**
 * Generate a single extern declaration for a global
 */
export function generateExternDeclaration(
  global: AnalyzedDataSymbol,
  includeAddressComment = false
): string {
  let type = global.suggestedType || global.dataType;
  let name = global.suggestedName || global.name;

  // Ghidra sometimes carries the array dimension in the NAME ("gdwFoo[91]")
  // rather than the type. Move it to the type so the base name is a valid
  // identifier and normalizeArrayDeclaration emits a proper array declaration
  // (otherwise the whole global is dropped as an "invalid identifier").
  const nameArr = name.match(/^(.+?)((?:\[\d+\])+)$/);
  if (nameArr && !/(?:\[\d+\])+\s*\*?$/.test(type)) {
    name = nameArr[1];
    type = type + nameArr[2];
  }

  // Labels on the interior of another global (`g_chunks.capacity`, `DAT_x+1`):
  // the containing global is already declared, and the reference side spells
  // them as a member/offset expression, so there is nothing to declare here.
  if (isInteriorLabel(name)) return '';
  // Everything else keeps its identity — sanitized with the SAME rule the
  // reference side uses, so a declaration always exists for a name in use.
  name = sanitizeSymbolName(name);

  type = normalizeGlobalDeclType(type);

  // A Ghidra `unicode` run is an ARRAY of code units, and its type spelling
  // carries no dimension of its own. Without one the declaration here is a
  // scalar while globals.cpp defines the array, which is a conflicting
  // declaration rather than the missing dimension it looks like.
  const wideText = isWideTextDatum(global, type) ? inferArrayDeclaration(global) : null;
  if (wideText) type = `${wideText.type}[${wideText.count}]`;

  // Evidence comment, same convention as functions: how the name was established.
  let evidence = '';
  if (global.comment) {
    const lines = global.comment
      .replace(/\\n/g, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !/^@(date|author|function|address|description|params|calling)\b/i.test(l));
    if (lines.length > 0) evidence = lines.map(l => `// ${l}`).join('\n') + '\n';
  }

  recordDeclaredName(name);
  let declaration = `${evidence}extern ${normalizeArrayDeclaration(type, name)};`;

  if (includeAddressComment) {
    declaration += ` // @${global.address}`;
    if (global.referencingFunctions && global.referencingFunctions.length > 0) {
      const funcList = global.referencingFunctions.slice(0, 3).join(', ');
      const more = global.referencingFunctions.length > 3 ? '...' : '';
      declaration += ` (used by: ${funcList}${more})`;
    }
  }

  return declaration;
}

/**
 * Generate static local declaration for insertion into a function
 *
 * @returns The static declaration line, or null if not applicable
 */
export function generateStaticLocalDeclaration(
  symbol: AnalyzedDataSymbol,
  includeAddressComment = false
): string | null {
  if (symbol.scope !== 'static-local') {
    return null;
  }

  let type = symbol.suggestedType || symbol.dataType;
  let name = symbol.suggestedName || symbol.name;

  // Same sanitizer the declaration side and the reference side use.
  name = sanitizeSymbolName(name);

  // `auto` is a one-byte `undefined` slot. It must resolve to the SAME type the
  // extern path gives it, or a symbol that is file-local here and referenced as
  // `&sym` is `int*` on one side and `uint8_t*` on the other.
  type = normalizeGlobalDeclType(type);

  // Whose object this is, for the initializer renderers below — see
  // `setInitializerOwnerAddress`. Cleared before every return.
  setInitializerOwnerAddress(symbol.address);

  let initializer = '';
  if (symbol.initializedData) {
    const arrayInfo = inferArrayDeclaration(symbol);
    const init = emitDataValue(symbol.initializedData, 0, type);
    setInitializerOwnerAddress(undefined);
    if (arrayInfo && symbol.initializedData.kind === 'array') {
      return `static ${arrayInfo.type} ${name}[${arrayInfo.count}] = ${init};`;
    }
    initializer = ` = ${init}`;
  } else if (symbol.value !== undefined && symbol.value !== null) {
    // Quote string values that aren't already quoted
    if (type === 'const char*' && !symbol.value.startsWith('"')) {
      initializer = ` = "${escapeStringForC(symbol.value)}"`;
    } else {
      // An address stored in a pointer slot still needs the pointer cast — the
      // hex prefix only makes it a valid literal, not a valid initializer.
      const valueArrayInfo = inferArrayDeclaration(symbol);
      const body = renderGlobalScalarInitializer(symbol.value, type, valueArrayInfo?.count);
      initializer = ` = ${valueArrayInfo ? `{ ${body} }` : body}`;
    }
  } else if (type === 'auto') {
    // Can't have uninitialized auto
    initializer = ' = {}';
  }

  setInitializerOwnerAddress(undefined);

  recordDeclaredName(name);
  let declaration = `static ${normalizeArrayDeclaration(type, name)}${initializer};`;

  if (includeAddressComment) {
    declaration += ` // Originally: ${symbol.name} @${symbol.address}`;
  }

  return declaration;
}

/**
 * Generate a comment block describing static locals for a function
 */
export function generateStaticLocalsBlock(
  symbols: AnalyzedDataSymbol[],
  functionName: string,
  includeAddressComments = false,
  bodyIdentifiers?: Set<string>
): string | null {
  let statics = symbols.filter(
    s => s.scope === 'static-local' && s.ownerFunction === functionName
      && !isSwitchTableSymbol(s.suggestedName || s.name)
      && !isJumpTableArtifact(s)
  );


  // Filter out globals whose sanitized name doesn't appear in the function body.
  //
  // Ghidra references a global's reused storage slot as `_<global>` (one leading
  // underscore). `underscore-storage-alias` rewrites that back to `<global>` on
  // the AST, but only where the base is one of the analyzed globals under its own
  // `name` — a static local this block spells through `sanitizeSymbolName` can
  // still reach here wearing the underscore. Accept either spelling, or the body
  // names a static local this block just declined to declare.
  if (bodyIdentifiers) {
    statics = statics.filter(s => {
      const n = sanitizeSymbolName(s.suggestedName || s.name);
      return bodyIdentifiers.has(n) || bodyIdentifiers.has(`_${n}`);
    });
  }

  if (statics.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push('    // Static local variables (originally global data)');

  for (const sym of statics) {
    const decl = generateStaticLocalDeclaration(sym, includeAddressComments);
    if (decl) {
      lines.push(`    ${decl}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Group symbols by the namespace RESOLVED for their address.
 *
 * Every globals emission path — the extern block, the constants block, the
 * recovery block, globals.cpp and the struct-header co-located pair — groups
 * through this, so a symbol is declared and defined in one namespace by
 * identity. It used to be five independent derivations.
 */
export interface NamespaceGroup {
  /** The resolved entity — the thing every emission path renders from. */
  readonly resolved: ResolvedNamespace;
  /** Its rendered form, produced once. */
  readonly rendered: string | undefined;
  readonly symbols: AnalyzedDataSymbol[];
}

/**
 * Names that cannot open a namespace at ROOT scope in the header being emitted,
 * because that header declares a struct/class of the same name there. This is a
 * C++ scope conflict in the emitted file — `struct WardenClient;` and
 * `namespace WardenClient { }` at one scope is "redeclared as different kind of
 * entity" — and NOT a second namespace resolution: it constrains only the
 * LEADING segment, at the one scope where both names are introduced. An inner
 * segment is fine (`namespace D2Common { namespace Item { } }` does not clash
 * with a root-scope `struct Item`), which is why dropping inner segments — the
 * old globals.h rule — was what pushed `ItemMods` into a namespace nothing
 * declared.
 */
let unopenableRootNames: ReadonlySet<string> = new Set();
export function setUnopenableRootNames(names: ReadonlySet<string>): void {
  unopenableRootNames = names;
}

/**
 * The namespace a data symbol is EMITTED in — the one derivation every grouping
 * and every reference to it has to agree on.
 *
 * A system-library path (a macOS framework, `/usr/lib`) is not a namespace at
 * all, and a leading segment the header cannot open at root scope is folded
 * away; both are properties of the emitted file, not of Ghidra's model, which is
 * why they live here and not in the resolution.
 */
export function emittedNamespaceOf(symbol: AnalyzedDataSymbol): ResolvedNamespace {
  const resolution = namespaceResolution();
  const root = resolution.resolvePath(undefined);
  const raw = symbol.namespace;
  const isSystemPath = !!raw && (raw.startsWith('/') || raw.includes('/usr/') || raw.includes('/lib/') || raw.startsWith('usr_lib_'));
  const ns = isSystemPath ? root : resolution.of(symbol);
  if (unopenableRootNames.size === 0 || ns.segments.length === 0) return ns;
  let cut = 0;
  while (cut < ns.segments.length && unopenableRootNames.has(ns.segments[cut])) cut++;
  if (cut === 0) return ns;
  return { ghidraSegments: ns.ghidraSegments, segments: ns.segments.slice(cut) };
}

export function groupByEmittedNamespace(symbols: AnalyzedDataSymbol[]): NamespaceGroup[] {
  const resolution = namespaceResolution();
  const groups = new Map<string, NamespaceGroup>();
  const order: NamespaceGroup[] = [];
  const root = resolution.resolvePath(undefined);
  const rootGroup: NamespaceGroup = { resolved: root, rendered: undefined, symbols: [] };
  groups.set('', rootGroup);
  order.push(rootGroup);

  for (const symbol of symbols) {
    const resolved = emittedNamespaceOf(symbol);
    const rendered = renderNamespace(resolved);
    const key = rendered ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { resolved, rendered, symbols: [] };
      groups.set(key, group);
      order.push(group);
    }
    group.symbols.push(symbol);
  }
  return order;
}

/**
 * Group symbols by namespace
 */
export function groupByNamespace(
  symbols: AnalyzedDataSymbol[]
): Map<string | undefined, AnalyzedDataSymbol[]> {
  const byNamespace = new Map<string | undefined, AnalyzedDataSymbol[]>();

  // Ensure global (no namespace) comes first
  byNamespace.set(undefined, []);

  for (const symbol of symbols) {
    let ns = symbol.namespace;
    // Skip system library namespaces (macOS framework paths, /usr/lib, etc.)
    if (ns && (ns.startsWith('/') || ns.includes('/usr/') || ns.includes('/lib/') || ns.startsWith('usr_lib_'))) {
      ns = undefined; // Place in global namespace instead
    }
    if (!byNamespace.has(ns)) {
      byNamespace.set(ns, []);
    }
    byNamespace.get(ns)!.push(symbol);
  }

  return byNamespace;
}

/**
 * Is this datum a WIDE character run — a Ghidra `string` value sitting in a
 * 16-bit character slot?
 *
 * Such a datum has to be declared as an array and initialised element-wise. The
 * spelling the narrow path produces, `uint16_t s = "(null)";`, gets both halves
 * wrong: the scalar type for a seven-element run, and a narrow literal for a
 * wide one.
 */
export function isWideTextDatum(
  symbol: AnalyzedDataSymbol,
  declaredType: string
): boolean {
  return symbol.initializedData?.kind === 'string'
    && isWideTextSlotType(baseTypeName(declaredType));
}

/**
 * Generate array declaration if the symbol looks like an array
 */
export function inferArrayDeclaration(
  symbol: AnalyzedDataSymbol
): { type: string; count: number } | null {
  // If size is larger than base type and divisible, might be an array
  const baseTypeSize = getBaseTypeSize(symbol.dataType);
  if (baseTypeSize > 0 && symbol.size > baseTypeSize && symbol.size % baseTypeSize === 0) {
    const count = symbol.size / baseTypeSize;
    if (count > 1 && count <= 1000) { // Reasonable array size
      return {
        type: normalizeGlobalDeclType(symbol.suggestedType || symbol.dataType),
        count,
      };
    }
  }
  return null;
}

/**
 * Get the size of a base type
 */
function getBaseTypeSize(dataType: string): number {
  const sizes: Record<string, number> = {
    'uint8_t': 1,
    'int8_t': 1,
    'byte': 1,
    'char': 1,
    'uint16_t': 2,
    'int16_t': 2,
    'word': 2,
    'short': 2,
    'uint32_t': 4,
    'int32_t': 4,
    'dword': 4,
    'int': 4,
    'float': 4,
    'uint64_t': 8,
    'int64_t': 8,
    'qword': 8,
    'double': 8,
    'pointer': 4, // 32-bit
    'void*': 4,
    // D2's wide character. Ghidra's `unicode` is a NUL-terminated run of 16-bit
    // code units, so a 14-byte datum is seven of them — without this the run is
    // read as one scalar and a 7-element array is declared as a single `uint16_t`.
    'unicode': 2,
    'wchar16': 2,
    'wchar_t': 2,
    'wchar': 2,
  };

  return sizes[dataType.toLowerCase()] || 0;
}

// =============================================================================
// globals.cpp generation — definitions with initializers
// =============================================================================

/** Slot types that take a bare integer literal rather than a `void*` cast. */
const INTEGER_SLOT_TYPES = new Set([
  'char', 'signed char', 'unsigned char', 'uchar', 'byte', 'word', 'dword', 'qword',
  'short', 'int', 'long', 'uint', 'ulong', 'ushort', 'size_t', 'bool',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
  'undefined', 'undefined1', 'undefined2', 'undefined4', 'undefined8',
]);

/**
 * Ghidra's placeholder name for an address it has no symbol for — `DAT_000a0000`,
 * `LAB_0057ee77_1`, `FUN_004503f0`, `s_umod_006e6f60`, or the bare `ffffffff`.
 * A pointer initializer that names one of these has nothing to point AT: the
 * generator emits no such declaration, so `&DAT_000a0000` is an undeclared
 * identifier. The name still carries the address it stood for, and that address
 * is the actual content of the slot, so spell it as the address.
 *
 * Only names the globals table does NOT declare go down this path — a real
 * symbol that merely looks like one of these keeps its reference.
 */
function unresolvedSymbolAddress(name: string): string | undefined {
  // "Declared" has to mean "declared where this initializer can see it". A
  // static-local / file-local symbol is emitted `static` inside ONE .cpp, so the
  // central globals.cpp cannot name it — `&DAT_00070000`, `&aNpcGossipData…`.
  // Existing in the globals table is not the same as being visible here.
  const invisibleHere = centralInitializerScope && fileScopedGlobalNames.has(name);
  // Being in the globals TABLE is not being DECLARED: every emitter drops the
  // switch/jump-table and interior-label names, so `&LAB_006c6569` names nothing.
  const neverDeclared = isSwitchTableSymbol(name) || isInteriorLabel(name);
  if (globalVariableNames.has(name) && !invisibleHere && !neverDeclared) return undefined;
  const artifact = name.match(/^(?:DAT|LAB|PTR|UNK|FUN|SUB)_([0-9a-fA-F]{6,8})(?:_\d+)?$/);
  if (artifact) return artifact[1];
  const stringSymbol = name.match(/^s_\w*_([0-9a-fA-F]{6,8})$/);
  if (stringSymbol) return stringSymbol[1];
  const bareHex = name.match(/^([0-9a-fA-F]{8})$/);
  if (bareHex) return bareHex[1];
  return undefined;
}

/**
 * The namespace table and the block a data initializer is currently being
 * emitted inside. A pointer initializer names its target with the target's OWN
 * namespace path (`Game::Launcher::AppModeLauncherInit`), which is correct at
 * root scope but not necessarily from inside another namespace block: C++ looks
 * the leading qualifier up through the enclosing scopes and stops at the first
 * one that declares it, so `Game` binds to `D2Client::Game` and the reference
 * fails to resolve. Same decision as the `namespace-shadow-qualify` transform
 * makes for function bodies — initializers are emitted from strings, not from
 * an AST, so it has to be made here too.
 */
let shadowNamespaces: Set<string> | undefined;
let initializerScopes: string[] = [];
let initializerOwnScopes: Set<string> = new Set();

export function setKnownNamespaces(namespaces: Set<string> | undefined): void {
  shadowNamespaces = namespaces && namespaces.size > 0 ? namespaces : undefined;
}

/**
 * Enter (or leave, with `undefined`) the namespace block whose initializers are
 * about to be emitted.
 */
export function setInitializerNamespace(namespace: ResolvedNamespace | undefined): void {
  initializerScopes = [];
  initializerOwnScopes = new Set();
  if (!namespace || namespace.segments.length === 0) return;
  // Segments come from the resolution; nothing here re-derives them from text.
  const segs = namespace.segments;
  for (let i = segs.length; i > 0; i--) initializerScopes.push(segs.slice(0, i).join('::'));
  // Any contiguous run of the enclosing path names a scope the reference is
  // already inside, so it always resolves — see namespace-shadow-qualify.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j <= segs.length; j++) initializerOwnScopes.add(segs.slice(i, j).join('::'));
  }
}

function isShadowedQualifier(qualifier: string): boolean {
  if (!shadowNamespaces || initializerScopes.length === 0) return false;
  if (!shadowNamespaces.has(qualifier) || initializerOwnScopes.has(qualifier)) return false;
  const cut = qualifier.indexOf('::');
  const first = cut === -1 ? qualifier : qualifier.slice(0, cut);
  for (const scope of initializerScopes) {
    if (!shadowNamespaces.has(`${scope}::${first}`)) continue;
    return !shadowNamespaces.has(`${scope}::${qualifier}`);
  }
  return false;
}

/**
 * Root-qualify the leading qualified name of an initializer expression when the
 * enclosing block would shadow its first segment. Interior forms (`Tbl[3].pFn`,
 * `DAT_x+1`) keep everything after the name untouched.
 */
function shadowQualifyReference(expr: string): string {
  const m = expr.match(/^([A-Za-z_]\w*(?:::[A-Za-z_]\w*)+)/);
  if (!m) return expr;
  const name = m[1];
  const qualifier = name.slice(0, name.lastIndexOf('::'));
  return isShadowedQualifier(qualifier) ? `::${expr}` : expr;
}

/**
 * Spell a pointer-valued initializer so that its STATIC TYPE matches the slot it
 * fills, without changing the ADDRESS it denotes.
 *
 * The DataValue model carries only "this 4-byte slot holds the address of X".
 * Three things can then be true of `X`:
 *   - `X` is a 1-D array of the slot's pointee type → the bare name decays to
 *     exactly the right pointer. No `&`, no cast.
 *   - `X` is an object of the slot's pointee type → `&X`. No cast.
 *   - Ghidra types `X` as something else (or as `undefined`, which arrives here
 *     as `void*`), or the address lands on a FIELD inside another table. Then no
 *     spelling of `&`/decay has the slot's type, and the only faithful C++ is a
 *     cast to the DECLARED SLOT TYPE — which narrows nothing and preserves the
 *     address exactly. Whenever this branch fires, the underlying disagreement
 *     is in the database, not here.
 */
/**
 * `a.b` is a member access only when `a` is a symbol we have. Ghidra's own
 * labels are allowed to contain a dot - a string label carries the string's
 * text, and `cmncof_a1.d2` is a filename - so `s_cmncof_a1.d2_006d6c44` is ONE
 * name, not a read of a member `d2_006d6c44` on a variable `s_cmncof_a1` that
 * does not exist. Read as an expression it compiles to five undeclared
 * identifiers; read as a name it goes through the sanitizer and then through
 * `unresolvedSymbolAddress` like every other invented label.
 *
 * Only the DOT is judged here. `Tbl[14]` and `sym+4` cannot be anything but an
 * expression whatever their root is.
 */
function dottedNameIsNotAMemberAccess(expr: string): boolean {
  if (!expr.includes('.')) return false;
  // A subscript or a byte offset is proof of an expression on its own - nothing
  // else produces `Tbl[14].pField` or `sym+4`.
  if (expr.includes('[') || expr.includes('+')) return false;
  const root = expr.match(/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/)?.[0];
  if (!root) return true;
  const bare = root.includes('::') ? root.slice(root.lastIndexOf('::') + 2) : root;
  return !globalVariableNames.has(root) && !globalVariableNames.has(bare);
}

/**
 * A function's address, spelled for the slot it is stored in — or null when the
 * slot takes `&Fn` as it stands.
 *
 * One spelling for both ways a function address arrives: as a NAME from Ghidra,
 * and as a WORD an initializer resolved against `func-ptr-literal`'s table. The
 * two must agree about the cast, so there is one place that decides it.
 */
function functionAddressSpelling(
  name: string,
  spelled: string,
  slotType?: string
): string | null {
  const castTo = functionInitializerCast(name, slotType);
  if (!castTo) return null;
  const cast = `(${rootQualifyShadowedType(castTo)})`;
  // An INTEGER slot takes no pointer of any kind, so the address goes through
  // `uintptr_t` first and is then spelled at the slot's own width — the same
  // two-step a string address in an integral slot already takes.
  return INTEGER_SLOT_TYPES.has(castTo.toLowerCase())
    ? `${cast}(uintptr_t)&${spelled}`
    : `${cast}&${spelled}`;
}

function emitPointerToSymbol(rawValue: string, expectedType?: string): string {
  // Drop the CRT-helper namespace prefixes (compiler/VisualStudio are not emitted).
  const stripped = rawValue.replace(/\b(?:compiler|VisualStudio)::/g, '');
  // Ghidra also hands back INTERIOR references — `Tbl[14].pField`, `DAT_x+1`.
  // Those are already legal C++ expressions and must survive intact; only names
  // that are not legal C++ go through the sanitizer.
  const isLegalExpression =
    /^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\[\d+\]|\.[A-Za-z_]\w*)*(?:\+\d+)?$/.test(stripped)
    && !dottedNameIsNotAMemberAccess(stripped);
  const legalized = isLegalExpression ? stripped : sanitizeQualifiedReference(stripped);
  // Spell the qualifier the way the DECLARATION side spells it. Ghidra hands back
  // the raw symbol path (`D2Game::Quests::Quests::A1Q6::Fn`); the declaration is
  // emitted into the collapsed namespace, so the raw path names a scope that does
  // not exist. Same collapse function both sides — one source of truth.
  const value = normalizeQualifiedReference(legalized);
  // The name the lookups below use is the unqualified one; the SPELLING may need
  // a root qualifier to survive the namespace block it lands in.
  const spelled = shadowQualifyReference(value);
  const bare = value.match(/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/) ? value : undefined;
  const slotType = expectedType ? stripFuncDefIndirection(expectedType.trim()) : undefined;
  // Asked of what the slot STANDS FOR: `typedef void* pointer` has no star to
  // find, and without this a `pointer` slot got no pointee and fell back to a
  // `void*` cast — which is how `(void*)0x006dc978` came to be spelled.
  const expectsPointer = isPointerSlotSpelling(slotType);
  // Compared UNQUALIFIED against the symbol's own declared type; spelled
  // root-qualified, because the cast lands inside a namespace block whose own
  // name may shadow the type (`namespace D2Client::Mouse` hides root `Mouse`).
  // What the slot STANDS FOR, so a typedef's pointee is the typedef's pointee
  // and not the typedef itself: `pointer` is `void*`, whose pointee is `void`.
  const standsFor = expectsPointer ? slotStandsFor(slotType!) : undefined;
  const pointeeBare = standsFor ? baseTypeName(standsFor.replace(/\*\s*$/, '')) : undefined;
  const pointee = pointeeBare ? rootQualifyShadowedType(pointeeBare) : undefined;
  // The CAST is the slot's own spelling. A star-less pointer typedef already
  // carries its indirection, so `(pointer)` is the slot's type and `(pointer*)`
  // would be `void**` — one level too many.
  const pointerCast = !expectsPointer ? undefined
    : /\*\s*$/.test(slotType!.trim()) ? `${pointee}*`
    : rootQualifyShadowedType(slotType!.trim());

  // The same, one level out: `s_umod_006e6f60+3` / `LAB_00646c24+1` is an
  // INTERIOR pointer whose root is one of those invented names. The root carries
  // its address and the suffix is a byte offset, so the pair is a literal.
  const interior = value.match(/^([A-Za-z_]\w*)\+(\d+)$/);
  if (interior) {
    const rootAddress = unresolvedSymbolAddress(interior[1]);
    if (rootAddress !== undefined) {
      const literal = `0x${(parseInt(rootAddress, 16) + Number(interior[2])).toString(16).padStart(8, '0')}`;
      if (pointerCast) return `(${pointerCast})${literal}`;
      const base = slotType ? baseTypeName(slotType).toLowerCase() : undefined;
      return base && INTEGER_SLOT_TYPES.has(base) ? literal : `(void*)${literal}`;
    }
  }

  // A name Ghidra invented for a bare address is not a declaration anywhere —
  // emit the address it stood for instead of a reference to nothing.
  if (bare) {
    const address = unresolvedSymbolAddress(bare);
    if (address !== undefined) {
      const literal = `0x${address.toLowerCase()}`;
      // Unless the tree CAN name it after all. That rule predates the
      // declaration closure, which now gives every referenced string constant an
      // `extern char N[];` in globals.h and exactly one definition — so
      // `s_Font8_006dc978` is declarable, and demoting it to 0x006DC978 throws
      // away the only spelling that survives relinking. `aFontNames` is fifteen
      // of these, and `D2WINFONT_BuildFontPath` passes each to `wsprintfA` as a
      // `%s`. Same table and same rule as every other address on this side, so
      // a label the table cannot name still falls through to the literal below.
      const named = pointerSlotAddressReference(literal, slotType);
      if (named) return named;
      if (pointerCast) return `(${pointerCast})${literal}`;
      // Only a slot whose type is NAMED as an integer takes the bare value; a
      // pointer spelled through a typedef (`pointer`, `LPVOID`, `HANDLE`) has no
      // `*` to test for, so anything else gets the `void*` cast.
      const base = slotType ? baseTypeName(slotType).toLowerCase() : undefined;
      return base && INTEGER_SLOT_TYPES.has(base) ? literal : `(void*)${literal}`;
    }
  }

  // `&<multidim-array-global>` is `T(*)[N][M]`; array decay still leaves
  // `T(*)[M]`, so this one genuinely needs the cast even when T matches.
  const multidimElem = bare ? multidimArrayGlobals.get(bare) : undefined;
  if (multidimElem) return `(${multidimElem}*)&${spelled}`;

  // A function address in a slot whose type is `void*`, a differing funcdef, or
  // a plain integer word.
  if (bare) {
    const asFunction = functionAddressSpelling(value, spelled, slotType);
    if (asFunction) return asFunction;
  }

  if (bare) {
    const elem = arrayGlobals.get(bare);
    if (elem) {
      // 1-D array: decay. Cast only when Ghidra's element type is not the slot's.
      if (pointerCast && baseTypeName(elem) !== pointeeBare) return `(${pointerCast})${spelled}`;
      return value;
    }
    const declared = globalDeclaredTypes.get(bare);
    // `&sym` has type `<declared> *`. Compare at FULL pointer depth, not just the
    // base name: a symbol declared `DC6 *` yields `DC6 **`, which a `DC6 *` slot
    // does not take — `baseTypeName` erases exactly the `*` that makes them differ.
    if (pointerCast && declared !== undefined && pointerDepthAwareName(declared) !== pointeeBare) {
      return `(${pointerCast})&${spelled}`;
    }
    return `&${spelled}`;
  }

  // Not a bare symbol: an interior path like `Tbl[14].pField`. `&` there yields a
  // pointer to the FIELD's type, which is only by luck the slot's type.
  if (pointerCast) return `(${pointerCast})&${spelled}`;
  return `&${spelled}`;
}

/**
 * Types whose slot a `char` literal actually fits. Anything else — notably the
 * 16-bit char unified on `uint16_t` — takes the numeric code unit, because a
 * `char` literal with the high bit set is negative and will not narrow.
 */
const CHAR_SLOT_TYPES = new Set(['char', 'signed char', 'unsigned char', 'uchar', 'byte', 'int8_t', 'uint8_t', 'undefined1', 'undefined']);

/**
 * The 8-bit slots that are UNSIGNED. A `char` literal is signed on this target,
 * so `'\x9c'` is -100 and narrowing it into one of these is an error even though
 * the byte fits: `narrowing conversion of '\234' from 'char' to 'uint8_t'`.
 * A code unit at or above 0x80 takes the numeric byte in these slots.
 */
/** Glide's enumeration typedefs, which the platform header spells `unsigned int`. */
const GLIDE_UNSIGNED_SLOTS = new Set<string>(GLIDE_UNSIGNED_ENUM_TYPEDEFS);

const UNSIGNED_BYTE_SLOT_TYPES = new Set(['unsigned char', 'uchar', 'byte', 'uint8_t', 'undefined1', 'undefined']);

function isCharSlotType(base: string): boolean {
  return CHAR_SLOT_TYPES.has(base.toLowerCase());
}

/**
 * Slots whose element is a 16-BIT character. Ghidra's `unicode` is a
 * NUL-terminated run of these, and D2's wide char is emitted as `uint16_t`
 * (mingw's `wchar_t` is 16-bit but is a distinct type that no narrow string
 * literal reaches either way).
 *
 * Named positively rather than as "not a char slot": Ghidra's own `string` is
 * the byte-layout name for a NARROW run, and every one of those lands in a
 * `char[N]` that a string literal initialises perfectly well.
 */
const WIDE_TEXT_SLOT_TYPES = new Set(['uint16_t', 'wchar_t', 'wchar16', 'unicode', 'WCHAR']);

function isWideTextSlotType(base: string | undefined): boolean {
  return base !== undefined && WIDE_TEXT_SLOT_TYPES.has(base);
}

/**
 * A slot whose datum Ghidra RENDERS as a character rather than as a number.
 *
 * This is the question that decides whether a bare `6` in an initializer is the
 * byte 0x36 or the byte 0x06, and the type is the only thing that can answer it:
 * `sinTable_f32` holds 1.0 at a quarter turn and Ghidra renders that `1`, so a
 * float slot reading its digits as characters would spell 0x31.
 *
 * Narrow and wide both, because both are text: a `WCHAR[256]` lookup table
 * renders the code unit as the character exactly as a `char[N]` does. What the
 * character becomes in the wide slot is still the numeric code unit - see the
 * branches below - only the READING changes here.
 */
function isCharacterRenderedSlot(base: string | undefined): boolean {
  return base !== undefined && (isCharSlotType(base) || isWideTextSlotType(base));
}

function isUnsignedByteSlotType(base: string): boolean {
  return UNSIGNED_BYTE_SLOT_TYPES.has(base.toLowerCase());
}

/**
 * The all-ones sentinel, asked with this module's knowledge of what is an enum
 * and what is a funcdef typedef. One wrapper, so every emit point below asks
 * the question the same way.
 */
function sentinelContext() {
  return {
    isEnumType: (n: string) => enumTypeNames.has(n),
    isFuncDefTypedef: isFuncDefTypedefName,
    isUnsignedSlot: (n: string) => GLIDE_UNSIGNED_SLOTS.has(n),
    // Collapse `void *` to `void*`: the same spelling castPointerInitializer
    // already writes, so one cast form appears in the output, not two.
    spellType: (t: string) => rootQualifyShadowedType(t.replace(/\s+/g, ' ').trim()).replace(/\s+\*/g, '*'),
  };
}

function sentinelSpelling(rawValue: string | null | undefined, slotType: string | null | undefined): string | undefined {
  return allOnesSentinel(rawValue, slotType, sentinelContext());
}

/**
 * The unsigned spelling a negative datum needs written out, or `undefined` when
 * the slot takes the value as it stands.
 */
function unsignedSlotSpelling(rawValue: string | null | undefined, slotType: string | null | undefined): string | undefined {
  return negativeInUnsignedSlot(rawValue, slotType, sentinelContext());
}

/**
 * The bit pattern a negative datum has to be written as to survive its unsigned
 * slot, or `undefined` when the slot takes the value as it stands.
 */
function unsignedSlotBitPattern(rawValue: string | null | undefined, slotType: string | null | undefined): string | undefined {
  return negativeBytePatternInUnsignedSlot(rawValue, slotType, sentinelContext());
}

/**
 * `0` is the one rendering Ghidra writes BOTH ways, and the collision is inside
 * a single datum.
 *
 * A defined character datum spells its zero byte `'\x00'`; an UNDEFINED byte —
 * the tail of a BSS buffer — spells it `0`. But `0` is also how the character
 * 0x30 arrives, so the same three glyphs mean 0x00 in `szCustomSymbolSearchPath`
 * (32768 of them) and 0x30 in `"207.82.87.243"`. `gszFogCrashReportCustomMessage`
 * holds both readings in ONE `char[4096]`: 1976 defined `'\x00'` followed by
 * 2120 undefined `0`. So the datum as a whole cannot decide it — a rule that
 * asked "does this array render anything as text?" would have written 0x30 over
 * all 2120 of those bytes.
 *
 * Its NEIGHBOURS can. A character 0 sits between two other characters, because
 * that is what text is; the undefined tail is a RUN, so every `0` in it has a
 * `0` on at least one side, and the byte before the run is the `'\x00'` that
 * ends the defined part. Requiring both sides to be single characters that are
 * not themselves `0` — and neither end of the array, which has only one side —
 * reads exactly seven zeros in the whole image as characters: the `0` of
 * `207.82.87.243` in both realm addresses, the `$0?` of four MSVC RTTI names,
 * and index 0x30 of `CharacterLookupTable`, which holds its own index. It reads
 * none of the 162909 others.
 */
function characterZeroSpellings(
  elements: readonly DataValue[] | null | undefined,
  elemType: string | undefined,
): Array<string | undefined> | undefined {
  if (!elements || elements.length < 3) return undefined;
  const base = elemType ? baseTypeName(elemType) : undefined;
  if (!isCharacterRenderedSlot(base)) return undefined;
  const isCharacter = (dv: DataValue | undefined): boolean =>
    dv !== undefined && dv.kind === 'scalar' && (dv.value ?? '').length === 1 && dv.value !== '0';
  let any = false;
  const out = new Array<string | undefined>(elements.length).fill(undefined);
  for (let i = 1; i < elements.length - 1; i++) {
    const e = elements[i];
    if (e.kind !== 'scalar' || e.value !== '0') continue;
    if (!isCharacter(elements[i - 1]) || !isCharacter(elements[i + 1])) continue;
    // A wide slot takes the code unit, exactly as every other character in it
    // does — a narrow `char` literal does not reach a `uint16_t`.
    out[i] = isCharSlotType(base!) ? "'0'" : '0x30';
    any = true;
  }
  return any ? out : undefined;
}

/**
 * The exact symbol bases an initializer scalar may be resolved to.
 *
 * A literal in a DATA INITIALIZER is out of reach of `global-address-literal`:
 * `generateStaticLocalsBlock` is emitted as TEXT, and `impl.ts` appends it after
 * the body has already been parsed, transformed and emitted. The literals here
 * are `DataValue` scalars, not AST nodes — so the resolution has to happen here,
 * and it has to happen against the SAME table the pass resolves against, or the
 * two disagree about what an address even is.
 *
 * The table is therefore built by `buildGlobalAddressExtentTables` and pushed in
 * from the one place that builds it, exactly like the signature tables above it.
 *
 * `referenceableNames` is the extra restriction this side needs: a reference
 * written into an initializer has to be a name the emitted file can NAME. A
 * string constant qualifies (the declaration closure gives every one an
 * `extern char N[];` in globals.h and one definition), and so does a
 * `scope === 'global'` symbol. A file-local or static-local is emitted `static`
 * inside one .cpp and naming it from anywhere else is undefined at link.
 */
interface InitializerAddressEntry {
  readonly name: string;
  /** `char[N]`: the bare name already decays. `&name` would be `char(*)[N]`. */
  readonly stringConstant: boolean;
}

let initializerAddressBases = new Map<number, InitializerAddressEntry | null>();
let initializerAddressNamesUsed = new Set<string>();

/**
 * The image window `setInitializerAddressTable` admitted, kept so the FUNCTION
 * table below can be held to exactly the same one.
 */
let initializerAddressFloor = 0;

/**
 * Address -> the function defined there, spelled with the namespace its
 * DEFINITION is emitted in.
 *
 * This is `func-ptr-literal`'s own map, pushed in from the one place that builds
 * it. A function address in a data initializer is the same question that pass
 * answers for a function address in a BODY, down to the qualifier the reference
 * needs, and answering it from a second table is how the two would drift.
 */
let initializerFunctionBases = new Map<number, string>();

export function setInitializerFunctionAddresses(
  functionAddresses?: ReadonlyMap<bigint, { name: string; namespaceSegments?: readonly string[] }>,
): void {
  // Module state: a second run must not inherit the first's map, and a run with
  // no map must clear it rather than skip the reset.
  initializerFunctionBases = new Map();
  if (!functionAddresses) return;
  for (const [address, target] of functionAddresses) {
    const word = Number(address);
    if (!Number.isSafeInteger(word)) continue;
    const segments = target.namespaceSegments ?? [];
    initializerFunctionBases.set(
      word, segments.length > 0 ? `${segments.join('::')}::${target.name}` : target.name);
  }
}

/**
 * The address of the object whose initializer is being rendered, or undefined.
 *
 * THE TREE HOLDS TWO IMAGES. The Mac build's data symbols are merged in beside
 * the Windows ones for their cross-platform anchors, and the two address spaces
 * overlap: `PTR_DAT_00396304 = (void*)0x005cc240` is a Mac pointer holding a Mac
 * address that lands exactly on a Windows function, and so is
 * `PTR_DAT_00396178 = (void*)0x005c6910`. Two of the five values in the tree
 * that hit a Windows function are these — a rule reading only the VALUE would be
 * wrong two times in five.
 *
 * The owner is what separates them: an object below the Windows image base is
 * not a Windows image pointer, so what it holds is not a Windows address. An
 * emit path that has not said whose object it is resolves no function at all,
 * so a path nobody wired renders exactly what it rendered before.
 */
let initializerOwnerAddress: number | undefined;

export function setInitializerOwnerAddress(address?: string | number): void {
  if (address === undefined || address === null) {
    initializerOwnerAddress = undefined;
    return;
  }
  const word = typeof address === 'number'
    ? address
    : Number.parseInt(String(address).replace(/^0x/i, '').replace(/^.*:/, ''), 16);
  initializerOwnerAddress = Number.isSafeInteger(word) ? word : undefined;
}

/** Is `word` an address in the image the object being initialised belongs to? */
function ownerSharesImageWith(word: number): boolean {
  if (initializerOwnerAddress === undefined) return false;
  if (initializerOwnerAddress < initializerAddressFloor) return false;
  if (initializerOwnerAddress >= ADDRESS_LITERAL_CEILING) return false;
  return word >= initializerAddressFloor && word < ADDRESS_LITERAL_CEILING;
}

/** The function defined at `word`, when the owner argues that is what it is. */
function initializerFunctionAt(word: number): string | null {
  if (initializerFunctionBases.size === 0) return null;
  if (!ownerSharesImageWith(word)) return null;
  return initializerFunctionBases.get(word) ?? null;
}

export function setInitializerAddressTable(input?: {
  globalAddresses: Record<string, number>;
  stringConstantNames: readonly string[];
  referenceableNames: ReadonlySet<string>;
  imageBase?: string | number;
}): void {
  // Module state: a second run in the same process must not inherit the first's
  // table, and a run with no table must clear it rather than skip the reset.
  initializerAddressBases = new Map();
  initializerAddressNamesUsed = new Set();
  initializerAddressFloor = 0;
  if (!input) return;

  const floor = addressLiteralFloor(input.imageBase);
  initializerAddressFloor = floor;
  const strings = new Set(input.stringConstantNames);
  for (const [name, address] of Object.entries(input.globalAddresses)) {
    if (!input.referenceableNames.has(name)) continue;
    if (!Number.isSafeInteger(address)) continue;
    // The same floor and the same ceiling the pass applies. Below the image base
    // a "symbol" is a Ghidra placeholder standing where a reference could not be
    // resolved; at 0x80000000 and above nothing is mapped in a 32-bit image.
    if (address < floor || address >= ADDRESS_LITERAL_CEILING) continue;
    // Two names on one address identify no object. Recorded as null rather than
    // deleted, so a later entry cannot resurrect the address.
    initializerAddressBases.set(address, initializerAddressBases.has(address) ? null : { name, stringConstant: strings.has(name) });
  }
}

/**
 * The names initializers actually referenced, for the declaration closure.
 *
 * The closure declares what FUNCTION BODIES name, counted off the transformed
 * AST. A reference written here is in neither place — it is emitted text, made
 * after the bodies were counted — so a string constant resolved in an
 * initializer would reach the compiler with nothing declaring it. These names
 * are merged into the closure's reference set when globals.h is built.
 */
export function initializerAddressReferences(): ReadonlySet<string> {
  return initializerAddressNamesUsed;
}

/**
 * Fold a shard worker's initializer references into this process's set.
 *
 * A shard renders the co-located initializers of the files it owns, so the
 * names those resolve to are recorded in ITS module instance. The closure runs
 * on the coordinator, and a name missing from it is a build error in a file the
 * coordinator never emitted.
 */
export function addInitializerAddressReferences(names: Iterable<string>): void {
  for (const n of names) initializerAddressNamesUsed.add(n);
}


/** The word a Ghidra scalar holds, or null when it is not a plain number. */
function scalarWordValue(raw: string | null | undefined): number | null {
  const normalized = normalizeDataValue((raw ?? '').trim());
  const value = /^0x[0-9a-fA-F]+$/.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : NaN;
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The shape of a slot, read off what its spelling STANDS FOR.
 *
 * `d2_platform.h` has `typedef void* pointer;`, so `pointer aFontNames[15]` is
 * fifteen pointer slots with not one star between them. Both resolvers below
 * used to ask `/\*$/` of the spelling and decline — fifteen string constants
 * kept their absolute addresses and `D2WINFONT_BuildFontPath` read 0x006DC970.
 * The same is true of `LPVOID`, `PVOID`, `LPCVOID`, `LPCSTR` and the HANDLE
 * family wherever they land as an element or field type.
 *
 * A trailing `[N]` is checked FIRST and is never a pointer slot: after the outer
 * dimension has come off, a remaining one is a row of a 2-D array, and a row is
 * not assignable.
 */
function slotStandsFor(slotType: string): string {
  const slot = slotType.trim();
  if (/\]\s*$/.test(slot)) return slot;
  if (/\*\s*$/.test(slot)) return slot;
  return resolveTypedefSpelling(baseTypeName(slot));
}

/** A slot that holds an ADDRESS, however its type is spelled. */
function isPointerSlotSpelling(slotType: string | undefined): boolean {
  const slot = slotType?.trim();
  if (!slot) return false;
  return /\*\s*$/.test(slotStandsFor(slot));
}

/** A slot that holds a WORD, however its type is spelled. */
function isIntegerSlotSpelling(slotType: string | undefined): boolean {
  const slot = slotType?.trim();
  if (!slot) return false;
  const stands = slotStandsFor(slot);
  if (/[*[\]]/.test(stands)) return false;
  return INTEGER_SLOT_TYPES.has(baseTypeName(stands).toLowerCase());
}

/**
 * The reference, spelled to fit the slot it is stored in — or null when it
 * cannot be spelled and the literal must stand.
 *
 * The slot in the live case is `uint`, so the value has to be INTEGRAL: a
 * `char[N]` decays to `char*`, which is not an integer, and a braced initializer
 * rejects a narrowing conversion outright. `(uint)(uintptr_t)name` carries the
 * address, is spelled at the slot's own width so nothing narrows, and — not
 * being a constant expression — becomes dynamic initialization, which is what
 * makes it follow the object wherever the linker puts it.
 */
function initializerAddressSpelling(
  entry: InitializerAddressEntry,
  slotType: string | undefined
): string | null {
  const slot = slotType?.trim();
  if (!slot) return null;
  const reference = shadowQualifyReference(
    entry.stringConstant ? entry.name : `&${entry.name}`);
  // The cast carries the DECLARED spelling either way: it is the type the
  // reader declared, and it converts exactly as the resolved one would.
  if (isPointerSlotSpelling(slot)) return `(${rootQualifyShadowedType(slot)})${reference}`;
  if (!isIntegerSlotSpelling(slot)) return null;
  return `(${rootQualifyShadowedType(slot)})(uintptr_t)${reference}`;
}

/**
 * The reference an address literal in a POINTER slot resolves to, or null.
 *
 * The per-array corroboration rule below guards INTEGER slots, where the word
 * could plausibly be a number and only its neighbours can say otherwise. A slot
 * whose declared type is a POINTER is a slot that holds an address by
 * declaration, so one exact base is evidence enough on its own — the same
 * standard `emitPointerToSymbol` already applies when Ghidra hands back a NAME
 * for the slot instead of a word. Without this, `char * fnCursorVisibilityHook =
 * (char *)0x006cc8b8` reached `RegisterClassA` as an absolute 1.14d address and
 * faulted inside user32.
 *
 * Exact bases only, as everywhere on this side: an interior address (base + n)
 * is not in the table and keeps its literal, because there is no surrounding
 * expression here to check an extent against.
 */
function pointerSlotAddressReference(
  rawValue: string | null | undefined,
  slotType: string | undefined
): string | null {
  const slot = slotType?.trim();
  if (!slot || !isPointerSlotSpelling(slot)) return null;
  const word = scalarWordValue(rawValue);
  // Zero is a null slot, not an address; the table's floor excludes it anyway.
  if (word === null || word === 0) return null;
  const entry = initializerAddressBases.get(word);
  if (!entry) {
    // Not data — a third kind the extent table never held. A function needs no
    // declaration from the closure (a header already has its prototype), so
    // nothing is recorded for it.
    const func = initializerFunctionAt(word);
    if (!func) return null;
    const spelled = shadowQualifyReference(func);
    return functionAddressSpelling(func, spelled, slot) ?? `&${spelled}`;
  }
  const reference = shadowQualifyReference(
    entry.stringConstant ? entry.name : `&${entry.name}`);
  initializerAddressNamesUsed.add(entry.name);
  // A string constant is `char N[]`, which decays to exactly `char*` and to
  // nothing else: in a char-shaped slot the bare name IS the initializer.
  // `&name` would be `char(*)[N]`, and `array-global-address-of` runs at
  // priority 46 — before the address passes — so it would never be cleaned up.
  // Every other pairing takes the slot's own type, which carries the address
  // across unchanged and narrows nothing.
  if (entry.stringConstant && baseTypeName(slot.replace(/\*\s*$/, '')) === 'char') {
    return reference;
  }
  return `(${rootQualifyShadowedType(slot.replace(/\s+/g, ' '))})${reference}`;
}

/** One array element that holds a function address, or null when it holds none. */
function functionElementSpelling(word: number, elemType: string | undefined): string | null {
  const func = initializerFunctionAt(word);
  if (!func) return null;
  const spelled = shadowQualifyReference(func);
  return functionAddressSpelling(func, spelled, elemType) ?? `&${spelled}`;
}

/**
 * The spellings for one array's elements, or null to leave every one of them
 * alone.
 *
 * The decision is taken per ARRAY, never per element, and that is the whole
 * safeguard: an initializer scalar has no surrounding expression to corroborate
 * it, so the corroboration has to come from its neighbours. Six elements all
 * landing on a symbol base is a pointer table; one of six is a number that
 * happens to collide with an address, and rewriting it would put a symbol
 * reference in the middle of five raw words.
 *
 *  - every element is a plain scalar,
 *  - every non-zero one resolves to an EXACT base — no interiors, no complement
 *    retry, both of which the pass allows itself only because a body gives it a
 *    surrounding expression,
 *  - and at least two do, so a lone scalar (or a one-element array, which is the
 *    same thing) is never rewritten,
 *  - zero stays zero: a null slot is a null slot.
 */
function arrayAddressSpellings(
  elements: readonly DataValue[],
  elemType: string | undefined
): Array<string | undefined> | null {
  if (elements.length < 2) return null;
  const out: Array<string | undefined> = new Array(elements.length);
  let resolved = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    if (element.kind !== 'scalar') return null;
    const word = scalarWordValue(element.value);
    if (word === null) return null;
    if (word === 0) continue;
    const entry = initializerAddressBases.get(word);
    // A dispatch table's entries are function addresses, which the extent table
    // does not hold. Same corroboration rule either way: the decision is still
    // taken over the whole array.
    const spelling = entry
      ? initializerAddressSpelling(entry, elemType)
      : functionElementSpelling(word, elemType);
    if (!spelling) return null;
    out[i] = spelling;
    resolved++;
  }
  return resolved >= 2 ? out : null;
}

/**
 * Convert a DataValue tree to a C initializer string.
 *
 * `expectedType` is the declared type of the slot being initialized — the
 * global's own type at the top level, then the array element type / struct field
 * type as the walk descends. It is what lets a pointer slot be spelled with the
 * right static type instead of a guess.
 */
export function emitDataValue(dv: DataValue, indent = 0, expectedType?: string): string {
  const pad = '    '.repeat(indent);
  const innerPad = '    '.repeat(indent + 1);
  const baseExpected = expectedType ? baseTypeName(expectedType) : undefined;

  switch (dv.kind) {
    case 'scalar': {
      // Ask before normalizing: the raw value may be bare hex or decimal, and
      // the slot type is what decides whether all-ones means -1 here.
      const sentinel = sentinelSpelling(dv.value, expectedType);
      if (sentinel !== undefined) return sentinel;
      // Ghidra reads the datum against the type IT modelled; where the emitted
      // slot is unsigned a negative reading narrows, and the conversion the
      // original source made implicitly has to be spelled.
      const unsignedSlot = unsignedSlotSpelling(dv.value, expectedType);
      if (unsignedSlot !== undefined) return unsignedSlot;
      // Same disagreement one step down: a real array extent gives a byte slot
      // its real contents, and Ghidra reads those bytes SIGNED. `-0x60` is the
      // palette byte 0xA0, and only the spelling is wrong.
      const bitPattern = unsignedSlotBitPattern(dv.value, expectedType);
      if (bitPattern !== undefined) return bitPattern;
      const val = normalizeDataValue(dv.value ?? '0');
      // A single character is a CHARACTER, and a digit is no exception: Ghidra
      // renders a character slot's byte as the character, and renders a NUMERIC
      // byte `0x`-prefixed, so a bare `6` in a `char` slot is 0x36. Reading it
      // as the number 6 turned ".dc6" into ".dc\x06" and 207.82.87.243 into
      // \x02\x00\x07.\x08\x02..., with nothing to diagnose either.
      //
      // `0` alone is excluded here and decided one level up, by its neighbours:
      // see `characterZeroSpellings`. Outside a character slot every digit stays
      // a number, because there that is what it is.
      const digit = val.length === 1 && val >= '0' && val <= '9';
      const characterValue = val.length === 1
        && (!digit || (val !== '0' && isCharacterRenderedSlot(baseExpected)));
      if (characterValue) {
        const code = val.charCodeAt(0);
        // A char literal only belongs in a char-shaped slot. In any wider integer
        // slot (D2's 16-bit char is uint16_t) a code unit >= 0x80 is a NEGATIVE
        // `char` and cannot narrow into the slot: `narrowing conversion of '\200'
        // from 'char' to 'uint16_t'`. Emit the numeric code unit instead.
        if (baseExpected !== undefined && !isCharSlotType(baseExpected)) {
          return `0x${code.toString(16)}`;
        }
        // Same reasoning one slot narrower: an UNSIGNED byte slot cannot take a
        // `char` literal with the high bit set either, because that literal is
        // negative. The byte is right, the spelling is not.
        if (code > 127 && baseExpected !== undefined && isUnsignedByteSlotType(baseExpected)) {
          return `0x${code.toString(16)}`;
        }
        // Non-printable or non-ASCII: emit as hex escape
        if (code > 127 || code < 0x20) {
          return `'\\x${code.toString(16).padStart(2, '0')}'`;
        }
        // Escape special chars in char literals
        const escaped = val === '\\' ? '\\\\' : val === '\'' ? '\\\'' : val;
        return `'${escaped}'`;
      }
      // Ghidra reports a four-byte datum as a SCALAR whether the slot is an
      // integer or a pointer, so the same word that the `pointer` case above
      // casts arrives here uncast. A bare integer converts to no pointer type in
      // C++; the cast keeps the bytes and gives them the slot's type.
      return castPointerInitializer(expectedType ? stripFuncDefIndirection(expectedType.trim()) : '', val);
    }

    case 'string': {
      const text = dv.value ?? '';
      // A narrow string literal initialises only a char-shaped array. Ghidra's
      // `unicode` datum lands in a 16-bit slot (D2's wide char is `uint16_t`
      // here), where `= "(null)"` is `const char*` into an integer and there is
      // no `L"…"` spelling that reaches a non-`wchar_t` element either. Emit the
      // code units, which is what the bytes are.
      if (isWideTextSlotType(baseExpected)) {
        return `{ ${[...[...text].map(charLiteralFor), '0'].join(', ')} }`;
      }
      // Escape the string for C
      return `"${escapeStringForC(text)}"`;
    }

    case 'pointer': {
      if (!dv.value || dv.value === '0x0' || dv.value === '0x00000000' || dv.value === 'DAT_00000000') {
        return 'nullptr';
      }
      // A funcdef typedef is emitted pointer-style, so Ghidra's `Mouse *` is one
      // star too many for the slot the header actually declares (`Mouse`). The
      // declaration already collapses it; the cast has to agree or it produces
      // `BOOL (**)(...)` where a `BOOL (*)(...)` is wanted.
      const slotType = expectedType ? stripFuncDefIndirection(expectedType.trim()) : undefined;
      // Before the symbol test: a bare unprefixed `ffffffff` begins with a
      // letter and would otherwise be read as a symbol name.
      const sentinel = sentinelSpelling(dv.value, slotType ?? expectedType ?? 'void*');
      if (sentinel !== undefined) return sentinel;
      // If it looks like a symbol name (not hex), emit as address-of / decay.
      if (/^[A-Za-z_]/.test(dv.value)) {
        return emitPointerToSymbol(dv.value, slotType);
      }
      const literal = normalizeDataValue(dv.value);
      // A funcdef slot carries its indirection in the typedef, so it has no `*`
      // for castPointerInitializer to key on — but an address literal still
      // needs the cast to become a function pointer.
      if (slotType && isFuncDefTypedefName(slotType)) {
        return `(${rootQualifyShadowedType(slotType)})${literal}`;
      }
      // The word may be the base of a symbol this file can name. A pointer slot
      // holds an address by declaration, so one exact base settles it.
      const resolved = pointerSlotAddressReference(literal, slotType);
      if (resolved) return resolved;
      // Raw hex pointer — normalize value (add 0x prefix if needed)
      return castPointerInitializer(slotType ?? 'void*', literal);
    }

    case 'enum': {
      // Ghidra says this slot is an enum but not which one, so the width still
      // has to come from the declared type; without it there is no rewrite.
      const sentinel = sentinelSpelling(dv.value, expectedType);
      if (sentinel !== undefined) return sentinel;
      return dv.value ?? '0';
    }

    case 'array': {
      if (!dv.elements || dv.elements.length === 0) return '{}';
      // The element type is the declared type minus its outermost dimension.
      const elemType = expectedType ? stripOuterArrayDimension(expectedType) : undefined;
      return emitArrayElements(dv, indent, elemType, pad, innerPad);
    }

    case 'struct': {
      if (!dv.fields || dv.fields.length === 0) return '{}';
      const layout = baseExpected ? structFieldTypes.get(baseExpected) : undefined;
      const fieldLines = dv.fields.map((f, i) => {
        const v = emitDataValue(f.value, indent + 1, layout?.get(f.name));
        const comma = i < dv.fields!.length - 1 ? ',' : '';
        // Use positional init (field names may be auto-generated)
        const isAutoName = /^field_\d+$/.test(f.name);
        if (isAutoName) {
          return `${innerPad}${v}${comma}`;
        }
        return `${innerPad}/* .${f.name} = */ ${v}${comma}`;
      });
      return `{\n${fieldLines.join('\n')}\n${pad}}`;
    }

    default:
      return dv.value ?? '0';
  }
}

/** The body of an array initializer, once the datum's rendering is settled. */
function emitArrayElements(
  dv: DataValue,
  indent: number,
  elemType: string | undefined,
  pad: string,
  innerPad: string,
): string {
  // A table of absolute image addresses, decided over the whole array — see
  // `arrayAddressSpellings`. Undefined per element means "emit it as it is",
  // which is what a zero slot and every element of an unresolved array get.
  const addressed = arrayAddressSpellings(dv.elements, elemType);
  // A zero byte Ghidra rendered as `0` where its neighbours say it is the
  // CHARACTER. Never overlaps the table above: an address spelling is only ever
  // produced for a non-zero word.
  const characterZeros = characterZeroSpellings(dv.elements, elemType);
  if (addressed) {
    for (const spelling of addressed) {
      if (!spelling) continue;
      const named = spelling.match(/[A-Za-z_]\w*$/);
      if (named) initializerAddressNamesUsed.add(named[0]);
    }
  }
  // For small arrays of scalars/pointers, emit on fewer lines
  const isSimple = dv.elements.every(e => e.kind === 'scalar' || e.kind === 'pointer' || e.kind === 'enum');
  if (isSimple && dv.elements.length <= 8) {
    const vals = dv.elements.map((e, i) => {
      const v = addressed?.[i] ?? characterZeros?.[i] ?? emitDataValue(e, 0, elemType);
      return i < dv.elements!.length - 1 ? `${v},` : v;
    });
    return `{ ${vals.join(' ')} }`;
  }
  // Multi-line array
  const lines = dv.elements.map((e, i) => {
    const v = addressed?.[i] ?? characterZeros?.[i] ?? emitDataValue(e, indent + 1, elemType);
    const comma = i < dv.elements!.length - 1 ? ',' : '';
    return `${innerPad}${v}${comma}`;
  });
  return `{\n${lines.join('\n')}\n${pad}}`;
}

/**
 * `D2Foo[8][4]` → `D2Foo[4]`, `D2Foo[8]` → `D2Foo`, `D2Foo` → `D2Foo`.
 * Descending one level into an array initializer drops one dimension.
 */
function stripOuterArrayDimension(type: string): string {
  const m = type.match(/^(.*?)\s*\[\d+\]((?:\s*\[\d+\])*)\s*$/);
  if (!m) return type;
  return (m[1] + m[2]).trim();
}

/**
 * Check if a symbol name is a switch jump table artifact (dead after goto cleanup)
 *
 * MSVC decoration (`@`) is NOT evidence of an artifact: `PTR__BinkOpen@8_006cc5b8`
 * is a real import thunk pointer and `s_.?AUSGAMEDATA@@_0070f56c` is a real RTTI
 * name string that SMemAlloc call sites pass as their allocator tag. Both are
 * referenced by function bodies under the shared identifier sanitizer, so
 * refusing to declare them only removes the declaration, never the reference.
 */
export function isSwitchTableSymbol(name: string): boolean {
  return name.startsWith('switchdataD_') || name.startsWith('PTR_caseD_')
    || name.startsWith('LAB_') || name.startsWith('SUB_')
    || name.includes('+');  // Malformed names like "PTR_caseD_3_0067582c+2"
}

/**
 * Check if a user-renamed data symbol is actually a jump table artifact.
 * Catches symbols like gaExcelFieldTypeDefaultWriters that are renamed switch tables.
 *
 * Heuristic: 4-byte int/undefined4, referenced by exactly 1 function,
 * with a small negative value (relative offset in jump table).
 */
export function isJumpTableArtifact(symbol: AnalyzedDataSymbol): boolean {
  if (symbol.size !== 4) return false;
  if (symbol.dataType !== 'int' && symbol.dataType !== 'undefined4') return false;
  if (!symbol.referencingFunctions || symbol.referencingFunctions.length !== 1) return false;
  const raw = symbol.value || '0';
  // Try decimal first (handles negative values like "-42"), then hex
  let val = parseInt(raw, 10);
  if (isNaN(val)) val = parseInt(raw, 16);
  if (isNaN(val)) return false;
  return val < 0 && val > -0x10000;
}

/**
 * Normalize array type declarations: move array brackets from type to name.
 * "DC6 *[4]" + "pAutoMapDC6" → "DC6* pAutoMapDC6[4]"
 * "int[10]"  + "counts"       → "int counts[10]"
 */

/**
 * Does `normalizeArrayDeclaration` turn this type into an ARRAY object rather
 * than a scalar or a pointer? It mirrors that function's branches — the
 * pointer-to-array form declares a pointer, the two dimension-bearing forms
 * declare an array — so the two cannot answer differently about one type.
 */
export function declaresArrayObject(type: string): boolean {
  const t = stripFuncDefIndirection(type);
  if (/^(.+?)((?:\[\d+\])+)\s*\*$/.test(t)) return false;   // TYPE[N] * → pointer
  if (/^(.+?)((?:\[\d+\])+)$/.test(t)) return true;          // TYPE[N]
  if (/^(.+?\*)\s*(\[.+\])$/.test(t)) return true;            // TYPE *[N]
  return false;
}

/**
 * An array object needs a brace-enclosed initializer; C++ rejects
 * `CRITICAL_SECTION g[256] = 0;` outright. Ghidra hands back a single scalar for
 * such a symbol when only its first element carries data, so the faithful
 * spelling is that one element in braces — which zero-fills the rest, exactly
 * what the record says about them. A plain zero becomes `{}` rather than `{0}`
 * because a struct element cannot be initialized from `0`.
 */
export function braceArrayInitializer(type: string, initializer: string): string {
  if (!declaresArrayObject(type)) return initializer;
  if (initializer.startsWith('{')) return initializer;
  const v = initializer.trim();
  if (v === '0' || v === 'nullptr' || v === 'NULL') return '{}';
  return `{ ${v} }`;
}

export function normalizeArrayDeclaration(type: string, name: string): string {
  type = stripFuncDefIndirection(type);
  // "TYPE[N] *" → pointer to array: "TYPE (*name)[N]"
  const ptrToArrayMatch = type.match(/^(.+?)((?:\[\d+\])+)\s*\*$/);
  if (ptrToArrayMatch) {
    const base = ptrToArrayMatch[1].trim();
    const dims = ptrToArrayMatch[2];
    return `${base} (*${name})${dims}`;
  }
  // Extract ALL array dimensions from the type: "char[5][4]" → base="char", dims="[5][4]"
  const allDimsMatch = type.match(/^(.+?)((?:\[\d+\])+)$/);
  if (allDimsMatch) {
    const base = allDimsMatch[1].trim();
    const dims = allDimsMatch[2];
    return `${base} ${name}${dims}`;
  }
  // "TYPE *[N]" or "TYPE*[N]" → "TYPE* name[N]"
  const ptrArrayMatch = type.match(/^(.+?\*)\s*(\[.+\])$/);
  if (ptrArrayMatch) return `${ptrArrayMatch[1]} ${name}${ptrArrayMatch[2]}`;
  return `${type} ${name}`;
}

/**
 * Function-pointer typedefs are emitted pointer-style (`typedef T (*Name)(...)`),
 * so the C++ name already carries one level of indirection. Ghidra models a
 * function pointer as `Name *`, which would render `T (**)(...)` — one pointer
 * too many. Collapse that redundant level (incl. array forms `Name *[N]`) so a
 * funcptr global/field matches initializers like `&Func`.
 */
export function stripFuncDefIndirection(type: string): string {
  const m = type.match(/^(\w+)\s*\*\s*((?:\[\d+\])*)$/);
  if (m && isFuncDefTypedefName(m[1])) {
    return `${m[1]}${m[2]}`;
  }
  return type;
}

/**
 * Registry of ACTUAL function-pointer typedef names emitted by the codegen,
 * populated from the Ghidra FUNCTION_DEFINITION datatypes before any module is
 * emitted. The name conventions below are case-sensitive and miss all-caps /
 * irregular names (QUESTCALLBACK, QUESTINIT, ...), so the registry is the
 * authoritative source; the regexes stay as a fallback for safety.
 */
const knownFuncDefTypedefs = new Set<string>();

/** Populate the function-pointer typedef registry. Must run before emission. */
export function setKnownFuncDefTypedefs(names: Iterable<string>): void {
  knownFuncDefTypedefs.clear();
  for (const n of names) knownFuncDefTypedefs.add(n);
}

/** The registered function-pointer typedef names (for the funcdef-cast-collapse plugin). */
export function getKnownFuncDefTypedefs(): string[] {
  return [...knownFuncDefTypedefs];
}

/**
 * Every enumerator name Ghidra's ENUM datatypes define. A `case` label must be a
 * constant expression, and an identifier is only knowably one when it names an
 * enumerator — a global variable's identifier is not. Populated from the ENUM
 * datatypes before emission; consumed by `switch-reconstruct`, which otherwise
 * accepted any identifier as a case label and manufactured
 * `switch (pClickedAnim) { case gpAnimImgCharCreateAmazon: }`.
 */
const knownEnumConstants = new Set<string>();

/** Populate the enumerator registry. Must run before emission. */
export function setKnownEnumConstants(names: Iterable<string>): void {
  knownEnumConstants.clear();
  for (const n of names) knownEnumConstants.add(n);
}

/** The registered enumerator names (for the switch-reconstruct plugin). */
export function getKnownEnumConstants(): string[] {
  return [...knownEnumConstants];
}

/**
 * Globals declared as MULTIDIMENSIONAL arrays (`T[N][M]…`), mapped to their
 * element base type. Taking the address of such a global (`&name`) yields
 * `T(*)[N][M]`, but the pointer field it initializes wants `T*` — and unlike a
 * 1-D array, dropping the `&` still leaves `T(*)[M]` (not `T*`). So a CAST is
 * required: `(T*)&name`. Populated from the extracted globals before emission.
 */
const multidimArrayGlobals = new Map<string, string>();

/**
 * Globals declared as a ONE-dimensional array (`T[N]`), mapped to their element
 * type `T`. `&name` on such a global is `T(*)[N]`, which is NOT what a `T*`
 * pointer slot wants — but the bare name decays to exactly `T*`. So the `&` is
 * dropped rather than cast: array-to-pointer decay is the faithful, cast-free
 * spelling of "the address of the first element".
 */
const arrayGlobals = new Map<string, string>();

/** Declared (already Ghidra-normalized) type of every global, by emitted name. */
const globalDeclaredTypes = new Map<string, string>();

/**
 * Normalized signature keys for every FUNCTION (bare and qualified) and every
 * function-pointer typedef, so a data initializer that stores a function address
 * can tell whether the slot's type and the function's own prototype agree.
 *
 * A function pointer converts to NOTHING implicitly in C++ — not to `void*`, not
 * to a differently-typed function pointer — so wherever they disagree the
 * original source carried the cast, and emitting it reconstructs that.
 *
 * That includes an ARITY disagreement, which is where this used to stop. The
 * reasoning it stopped on — "no cast makes such a CALL work" — is about a call,
 * and this is a STORE. A heterogeneous dispatch table is built exactly this way:
 * `paSCompCompressCodecTable` declares its slot `pfnSCompCodec *` (five
 * parameters) and fills it with codecs taking six and seven, because
 * `SCompCompress` casts the slot away at the call site
 * (`(*(code *)pSrc[1])(...)`). The conversion between two function-pointer types
 * is well formed whatever their arities, it names the same symbol, and without
 * it the initializer does not compile at all. The disagreement is still real, so
 * it is still counted for the database owner — but it is counted over emitted
 * text that builds, not over text that does not.
 */
/**
 * Does `d2_platform.h` — or a system header it pulls in — declare a FUNCTION by
 * this name? The registry is what lets the initializer emitter tell a callee it
 * declared itself from one Ghidra handed it. Memoised; it is asked once per
 * symbol reference in every initializer in the tree.
 */
let emitterDeclaredFunctions: Set<string> | undefined;
function emitterDeclaresFunction(name: string): boolean {
  emitterDeclaredFunctions ??= platformDeclaredFunctionNames();
  return emitterDeclaredFunctions.has(name);
}

let initializerFunctionSignatures: Record<string, string> = {};
let initializerFuncdefSignatures: Record<string, string> = {};
let initializerFuncPtrArityMismatches = 0;

export function setInitializerSignatureTables(
  functionSignatures: Record<string, string>,
  funcdefSignatures: Record<string, string>,
): void {
  initializerFunctionSignatures = functionSignatures;
  initializerFuncdefSignatures = funcdefSignatures;
  initializerFuncPtrArityMismatches = 0;
}

/** How many function-address initializers were cast across an arity disagreement. */
export function getInitializerFuncPtrArityMismatches(): number {
  return initializerFuncPtrArityMismatches;
}

/** The arity encoded in a signature key `ret(a,b,c)`; -1 when unparseable. */
function signatureArity(sig: string): number {
  const open = sig.indexOf('(');
  if (open === -1 || !sig.endsWith(')')) return -1;
  const inner = sig.slice(open + 1, -1).trim();
  if (inner === '' || inner === 'void') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

/**
 * The cast a function-address initializer needs to land in `expectedType`, or
 * undefined when none is needed (or when a cast cannot honestly fix it).
 */
function functionInitializerCast(name: string, expectedType?: string): string | undefined {
  if (!expectedType) return undefined;
  // A name that also denotes DATA is not proof of a function.
  if (globalDeclaredTypes.has(name) || globalVariableNames.has(name)) return undefined;
  const bare = name.includes('::') ? name.slice(name.lastIndexOf('::') + 2) : name;
  if (globalDeclaredTypes.has(bare) || globalVariableNames.has(bare)) return undefined;
  const actual = initializerFunctionSignatures[name] ?? initializerFunctionSignatures[bare];
  if (actual === undefined) {
    // A callee the EMITTER declares has no model prototype to compare, but it is
    // still a function, and a function address reaches `void*` through a cast or
    // not at all. `__purecall` is the case: the MSVC pure-virtual thunk fills
    // every slot of an abstract class's vtable, and the vtable is a `pointer[]`.
    // A slot spelled as a funcdef is left alone — without a signature there is
    // nothing to compare it against, and a cast would be a guess.
    // Asked under BOTH spellings: the registry keys an excluded-namespace
    // prototype by the qualified name it is emitted under
    // (`_Wrappers::CRT_StrLen`), which is also the name the initializer carries.
    if (isVoidPointerSpelling(expectedType)
      && (emitterDeclaresFunction(name) || emitterDeclaresFunction(bare))) return 'void*';
    return undefined;
  }

  if (isVoidPointerSpelling(expectedType)) return 'void*';

  const slot = baseTypeName(expectedType);
  const target = initializerFuncdefSignatures[slot];
  if (target === undefined) {
    // The slot is not a function pointer at all: a word-wide integer field
    // holding a callback. `&Fn` is a function pointer and no integer type takes
    // one, so the address has to be spelled as the number it is — the caller
    // routes it through `uintptr_t`, exactly as a string address in an integral
    // slot already is. Only an UNDECORATED integer qualifies: `uint32_t *` is a
    // pointer slot whose base name reads as an integer and is not one.
    const undecorated = !/[*[\]]/.test(expectedType);
    return undecorated && INTEGER_SLOT_TYPES.has(slot.toLowerCase()) ? slot : undefined;
  }
  if (target === actual) return undefined;
  // Counted, not refused — see the note on `initializerFunctionSignatures`.
  if (signatureArity(actual) !== signatureArity(target)) initializerFuncPtrArityMismatches++;
  return slot;
}

/** Field name → field type, per STRUCTURE/UNION, for typing struct initializers. */
const structFieldTypes = new Map<string, Map<string, string>>();

/** Names of STRUCTURE/UNION data types (for the elaborated-specifier rule). */
const structOrUnionTypeNames = new Set<string>();

/**
 * Names of ENUM data types. d2_enums.h spells each as `typedef int X;`, and a
 * typedef-name has no elaborated form — so where a struct gets `struct X`, an
 * enum cannot be hidden at all. See `enumTypeNameTakenByAGlobal`.
 */
const enumTypeNames = new Set<string>();

/** Emitted names of every global variable (for the elaborated-specifier rule). */
const globalVariableNames = new Set<string>();

/**
 * Globals classified static-local / file-local: emitted `static` into a single
 * .cpp, so no other translation unit can name them. Consulted only while the
 * CENTRAL globals.cpp is being emitted (`centralInitializerScope`), because a
 * file-local block referencing its OWN statics is perfectly fine.
 */
const fileScopedGlobalNames = new Set<string>();
let centralInitializerScope = false;

/** Enter/leave emission of the central globals.cpp initializers. */
export function setCentralInitializerScope(on: boolean): void {
  centralInitializerScope = on;
}

/** The emitted name of a data symbol: suggestedName, else name, else sanitized. */
function symbolEmittedName(g: { name: string; suggestedName?: string }): string {
  return g.suggestedName || g.name;
}

export function setMultidimArrayGlobals(
  globals: Iterable<{ name: string; dataType?: string; suggestedName?: string; suggestedType?: string; scope?: string }>,
): void {
  multidimArrayGlobals.clear();
  arrayGlobals.clear();
  globalDeclaredTypes.clear();
  globalVariableNames.clear();
  fileScopedGlobalNames.clear();
  for (const g of globals) {
    const name = sanitizeSymbolName(symbolEmittedName(g));
    const rawType = g.suggestedType || g.dataType;
    if (name) globalVariableNames.add(name);
    if (name && (g.scope === 'static-local' || g.scope === 'file-local')) fileScopedGlobalNames.add(name);
    if (!rawType) continue;
    const type = normalizeGhidraType(rawType);
    if (name) globalDeclaredTypes.set(name, type);
    // `char[5][4]`, `undefined1 [3][2]`, `D2Foo[8][8]` → 2+ dimensions.
    const multi = type.match(/^([\w:]+(?:\s*\*)*)\s*(?:\[\d+\]\s*){2,}$/);
    if (multi) {
      multidimArrayGlobals.set(g.name, multi[1].trim());
      if (name) multidimArrayGlobals.set(name, multi[1].trim());
      continue;
    }
    const single = type.match(/^([\w:]+(?:\s*\*)*)\s*\[\d+\]$/);
    if (single && name) arrayGlobals.set(name, single[1].trim());
  }
}

/**
 * Register the struct/union layouts so a struct-shaped initializer can be typed
 * field by field. Without this, `emitDataValue` sees only `{name, value}` pairs
 * and has to guess how to spell a pointer — which is how `&sym` ends up one
 * indirection off the slot it initializes.
 */
export function setGlobalInitializerTypes(dataTypes: ExtractedDataType[] | undefined): void {
  structFieldTypes.clear();
  structOrUnionTypeNames.clear();
  enumTypeNames.clear();
  // The platform structs this generator declares itself. Ghidra reports them as
  // BUILT_IN with no field list, so without this an initializer for one is typed
  // as nothing and its bytes are spelled as `char` literals. Seeded FIRST, so a
  // real Ghidra layout of the same name still wins.
  for (const [name, fields] of PLATFORM_STRUCT_FIELD_TYPES) {
    structFieldTypes.set(name, new Map(fields));
  }
  if (!dataTypes) return;
  for (const dt of dataTypes) {
    if (dt.kind === 'ENUM') enumTypeNames.add(dt.name);
    if (dt.kind !== 'STRUCTURE' && dt.kind !== 'UNION') continue;
    structOrUnionTypeNames.add(dt.name);
    const fields = (dt as ExtractedStruct).fields;
    if (!fields) continue;
    const byName = new Map<string, string>();
    const isUnion = dt.kind === 'UNION';
    fields.forEach((f, i) => {
      if (!f.dataType) return;
      // A member Ghidra never named still HAS a name everywhere else: the
      // decompiler auto-names it, the header declares it under that auto-name,
      // and the initialized-data record hands its fields back under it too. Key
      // the layout on the same name or a struct initializer for such a slot is
      // typed as nothing at all - which is how a function address landed in a
      // `void*` field with no cast, and a sentinel in an int field with no
      // sentinel spelling.
      byName.set(f.name || ghidraDefaultFieldName(isUnion, i, f.offset), f.dataType);
    });
    structFieldTypes.set(dt.name, byName);
  }
}

/**
 * Ghidra names that are not legal C++ identifiers — MSVC RTTI symbols
 * (`RTTI_Base_Class_Descriptor_at_(0,-1,0,64)`), decompiler string labels
 * (`s_.?AUBREAKCMD@@_007088d8`), demangled template names. They cannot be
 * emitted verbatim, but they ARE referenced — by other globals' initializers and
 * by function bodies (which sanitize with exactly this rule). Refusing to
 * declare a symbol that is still referenced is the worst of both worlds, so
 * declaration and reference are put through the SAME sanitizer instead.
 */
export function sanitizeSymbolName(name: string): string {
  let out = name.replace(/[^A-Za-z0-9_]/g, '_');
  // A leading digit is REPLACED, not prefixed. Ghidra's decompiler already has to
  // legalize the same name to print a body, and it substitutes: `800BorderFrame`
  // comes out of the decompiler as `_00BorderFrame`. Prefixing here would declare
  // `_800BorderFrame` and leave every body naming an identifier that exists
  // nowhere ("'_00BorderFrame' was not declared; did you mean '_800BorderFrame'?").
  // The reference side is the decompiler's, so the declaration follows its rule.
  out = out.replace(/^\d/, '_');
  return out;
}

/**
 * Sanitize a possibly-qualified reference (`Ns::Sub::sym`) component-wise, so
 * the `::` scope operator survives while each component becomes a legal
 * identifier — matching what the declaration side emits.
 */
export function sanitizeQualifiedReference(name: string): string {
  return name.split('::').map(sanitizeSymbolName).join('::');
}

/**
 * Strip pointer/array/const noise off a type string to get its base type name.
 */
/**
 * `baseTypeName` with the pointer stars KEPT (`DC6 *` → `DC6*`), for comparing a
 * slot's pointee type against the type an `&symbol` really produces.
 */
function pointerDepthAwareName(type: string): string {
  const stars = (type.match(/\*/g) ?? []).length;
  return baseTypeName(type) + '*'.repeat(stars);
}

function baseTypeName(type: string): string {
  return type
    .replace(/[*&]/g, '')
    .replace(/\bconst\b/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\bstruct\b|\bunion\b/g, '')
    .replace(/\s+\d+$/, '')
    .trim();
}

/**
 * A global variable may carry the SAME name as the struct type it is declared
 * with (`extern D2NpcMenuOptions D2NpcMenuOptions[48];` — Ghidra names the table
 * after its element type). After that declaration the name denotes the variable,
 * so the definition in globals.cpp reads `D2NpcMenuOptions D2NpcMenuOptions[48]`
 * → "'D2NpcMenuOptions' does not name a type". The elaborated specifier
 * `struct D2NpcMenuOptions` is unambiguous in both positions and costs nothing.
 */
function elaborateCollidingStructType(type: string): string {
  const base = baseTypeName(type);
  if (!base || !/^[A-Za-z_]\w*$/.test(base)) return type;
  if (/\b(?:struct|union|enum)\b/.test(type)) return type;
  if (!structOrUnionTypeNames.has(base) || !globalVariableNames.has(base)) return type;
  return type.replace(new RegExp(`\\b${base}\\b`), `struct ${base}`);
}

/**
 * Globals whose NAME is already a type name — a fault only Ghidra can settle.
 *
 * Ghidra names the app-mode word at 0x0074c704 `eD2ApplicationMode`, which is
 * also the enum it is typed with. C++ has no spelling for that: an enum reaches
 * the tree through d2_enums.h as `typedef int X;`, and a typedef-name may
 * neither be redeclared as a variable in its scope nor be hidden by one (only a
 * class or enum name can be). Every escape was tried and each breaks something
 * real:
 *
 *  - an alias (`using X_type = X;`) does not help — the conflict is the NAME,
 *    not the spelling of the type;
 *  - dropping the typedef and declaring the underlying `int` compiles the
 *    declaration, but `Fog::Engine::Application::CLIENT_CheckIfApplicationMode…`
 *    takes an `eD2ApplicationMode *` parameter, so the type is genuinely in use;
 *  - a real `enum X : int` can be hidden by a variable, but then every use of
 *    the type needs the `enum` keyword — including inside decompiled bodies,
 *    which are not spelled by this emitter.
 *
 * So the emitter reports it with the address and leaves the declaration alone.
 * Renaming the label in Ghidra (`geD2ApplicationMode`) fixes it at the source
 * and costs one symbol.
 */
export function reportGlobalsTakingATypeName(): void {
  const taken: string[] = [];
  for (const [name, type] of globalDeclaredTypes) {
    // A struct or union is not a problem: `elaborateCollidingStructType` gives
    // it `struct X`, which is exactly what the elaborated form is for. Only a
    // typedef-name — every ENUM — is unrepresentable.
    if (!enumTypeNames.has(name)) continue;
    if (baseTypeName(type) !== name) continue;
    taken.push(name);
  }
  if (taken.length === 0) return;
  console.warn(`warning: ${taken.length} global(s) carry the name of the type they are declared with; the declaration in globals.h is ill-formed and fails every translation unit. Rename the label in Ghidra:`);
  for (const name of taken.sort()) console.warn(`  ${name}`);
}


/**
 * The single type-normalization every global DECLARATION and DEFINITION must
 * share. `generateExternDeclaration` used to hold the artifact mapping on its
 * own, so globals.h said `uint8_t` where globals.cpp said `IMAGE_DOS_HEADER` —
 * "conflicting declaration". One function, both sides.
 */
export function normalizeGlobalDeclType(type: string): string {
  let t = normalizeGhidraType(type);
  // Ghidra artifact types that have no C equivalent - use uint8_t. A symbol whose
  // whole type is one of these keeps its EXTENT through resolveListingBuiltinBlobs;
  // collapsing a 128-byte DOS header to a scalar `uint8_t` also left its struct
  // initializer behind, which is "scalar object requires one element".
  t = imageArtifactElementType(t) ?? t;
  return elaborateCollidingStructType(t);
}

/**
 * Name conventions for FunctionDefinition typedefs emitted by the codegen.
 *
 * The conventions are a fallback for a name the model does not record, and they
 * lose to the model wherever it has an answer. `D2Vtable_Callback` is a
 * STRUCTURE with one function-pointer member; the `Callback` suffix made it look
 * like the funcdef it is not, and `collapseFuncPtrTypedef` then ate the star off
 * every `D2Vtable_Callback *` parameter - so a body that reads
 * `pCallbackVtable->vmethod_0` had nothing to dereference.
 */
export function isFuncDefTypedefName(name: string): boolean {
  if (knownFuncDefTypedefs.has(name)) return true;
  if (getAggregateTypeNames()?.has(name)) return false;
  return /^fn[A-Z]/.test(name)
    || /^fp[A-Z]/.test(name)
    || /^AI_/.test(name)
    || /^D2NET_/.test(name)
    || /(?:Func|Callback|Handler|Action)$/i.test(name)
    || /_fn$/.test(name)
    || /[a-z]Fn$/.test(name)
    || /Proc[A-Z]?$/.test(name);
}

/**
 * Check if a symbol name is an individual array element (e.g. "pAutoMapDC6[1]")
 * that should be suppressed when the parent array symbol exists.
 */
function isArrayElementSymbol(name: string, allNames: Set<string>): boolean {
  const match = name.match(/^(.+)\[\d+\]$/);
  return !!match && allNames.has(match[1]);
}

/**
 * Ensure bare hex values have 0x prefix
 */
/**
 * Ghidra hands a pointer/address value back as bare hex, and the emitter has to
 * put the `0x` back on. Two shapes, both established by evidence rather than by
 * what the digits happen to look like:
 *
 *  - **Exactly 8 digits** is Ghidra's fixed-width address spelling, so it is hex
 *    whether or not any digit lands in a-f. The letter test alone got 340 of them
 *    wrong: `gszCrashDumpLine_6 = 00584245` is the bytes of "EBX", and
 *    `PTR_s_dialogbackground_007274ac = 00727498` is an address 0x14 below the one
 *    in its own name. Left bare, C++ reads a leading zero as OCTAL — `00584245`
 *    is a hard error only because of the 8; `00442150` compiles silently at a
 *    different value, which is the worse half of this bug.
 *  - Any other width keeps the letter test, so a short decimal is not mangled.
 *
 * A CHARACTER type is excluded from both: Ghidra spells a `char`'s value as the
 * character itself, so `'A'` was being read as hex and emitted as `0xA` — the
 * value 10 where the binary holds 65.
 */
function ensureHexPrefix(value: string, declaredType?: string): string {
  if (!/^[0-9a-fA-F]+$/.test(value)) return value;
  // Only the types Ghidra renders as TEXT. `uint8_t` / `byte` / `int8_t` are
  // character-sized but Ghidra renders them as hex, so reading one as a
  // character turns the byte 0 into `'0'`, which is 0x30.
  if (declaredType && isTextRenderedType(declaredType)) {
    return value.length === 1 ? `'${escapeStringForC(value)}'` : value;
  }
  if (value.length === 8) return `0x${value}`;
  if (/[a-fA-F]/.test(value)) return `0x${value}`;
  return value;
}


/**
 * Types whose VALUE Ghidra renders as the text of the bytes rather than as a
 * number. A `char` at 006ed5b4 holding 0x43 comes back as `"C"`, and a
 * `char[4]` holding "end\0" comes back as `"end"` — neither is a C expression.
 * Emitted verbatim they become undeclared identifiers (`= C;`, `= { end };`),
 * or, when the byte is a control character, a literal newline inside the
 * declaration (`char szOOGPasswordDialogTimeFmt = <CR>;`).
 *
 * Only the genuinely character-shaped spellings are listed. `uint8_t` / `byte` /
 * `undefined1` are deliberately absent: Ghidra renders those as hex, so reading
 * their value as text would corrupt every one of them.
 */
const TEXT_RENDERED_TYPES = new Set(['char', 'CHAR', 'signed char', 'unsigned char']);

function isTextRenderedType(type: string): boolean {
  const base = type
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(const|volatile)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return TEXT_RENDERED_TYPES.has(base);
}

/**
 * Ghidra pseudo-types whose "value" is listing text, not data: a resource blob
 * renders as `<Icon-Image>` or as the bare renderer name `GroupIcon`, and
 * section padding renders as `align(1)`. `normalizeDataValue` already catches
 * the two bracketed/parenthesised shapes by their punctuation; the bare word is
 * indistinguishable from a symbol reference by text alone, so it is caught by
 * the TYPE instead.
 */
function isGhidraRenderedPseudoType(type: string): boolean {
  const base = type.replace(/\[[^\]]*\]/g, '').replace(/[*&]/g, '').trim();
  return /Resource$/.test(base) || base === 'Alignment';
}

/**
 * One byte of Ghidra-rendered text as a C character literal.
 *
 * A code unit above 0xFF means the text did not come back as bytes — that is a
 * decode fault upstream, so the numeric code is emitted rather than a literal
 * that would silently narrow.
 */
function charLiteralFor(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code > 0xff) return `0x${code.toString(16)}`;
  if (ch === "'") return "'\\''";
  if (ch === '\\') return "'\\\\'";
  if (code < 0x20 || code > 0x7e) return `'\\x${code.toString(16).padStart(2, '0')}'`;
  return `'${ch}'`;
}

/**
 * Render Ghidra's rendered text for a character slot as an initializer.
 *
 * `elementCount` is the declared array length when the slot is an array; the
 * list is padded with 0 to that length (Ghidra stops the text at the NUL) and
 * truncated to it when the text is longer, because the declaration's length is
 * what the rest of the emitted tree agrees on.
 *
 * Returns the initializer BODY — the caller supplies the braces, exactly as it
 * already does for every other value.
 */
export function renderTextDataInitializer(rawValue: string | undefined, elementCount?: number): string {
  const text = rawValue ?? '';
  if (elementCount === undefined) {
    return text.length > 0 ? charLiteralFor(text[0]) : '0';
  }
  const parts: string[] = [];
  for (let i = 0; i < elementCount; i++) {
    parts.push(i < text.length ? charLiteralFor(text[i]) : '0');
  }
  return parts.join(', ');
}

/**
 * The one place a global's raw Ghidra `value` becomes a C initializer body.
 *
 * Three emitters used to do this by hand — globals.h's `static` declarations,
 * globals.cpp's "initialized scalars", and the co-located per-file statics in
 * impl.ts — and they disagreed: one quoted a single character, one did not, and
 * none of them handled a multi-character `char[N]`. Same input, same output,
 * everywhere.
 *
 * Returns the initializer BODY; callers wrap it in braces where the declaration
 * is an array.
 */
export function renderGlobalScalarInitializer(
  rawValue: string | undefined,
  declaredType: string,
  elementCount?: number
): string {
  if (isGhidraRenderedPseudoType(declaredType)) {
    // Value-initialize: there is no datum here to carry, and `{}` is valid for
    // the aggregate spelling and the scalar one alike.
    return '{}';
  }
  if (isTextRenderedType(declaredType)) {
    // The caller's array info is derived from byte sizes and is absent for a
    // type that already carries its own dimension (`char[4]`). Take the length
    // from the declaration itself when that happens, or the text collapses to
    // its first character.
    const declaredCount = declaredType.match(/\[\s*(\d+)\s*\]\s*$/);
    return renderTextDataInitializer(
      rawValue,
      elementCount ?? (declaredCount ? Number(declaredCount[1]) : undefined),
    );
  }
  const sentinel = sentinelSpelling(rawValue, declaredType);
  if (sentinel !== undefined) return sentinel;
  let value = normalizeDataValue(rawValue ?? '0');
  if ((value === '0' || value === '0x0') && isStructType(declaredType)) return '{}';
  // A funcdef typedef carries its own indirection in this tree, so Ghidra's
  // `pfnD2CmdHandler *` is spelled `pfnD2CmdHandler` here — which is what every
  // declaration printer this renderer is paired with already prints. Without
  // the same normalization the cast came out one star wider than the
  // declaration it initialises. The typedef then has no `*` for
  // `castPointerInitializer` to key on, so the cast is spelled here, exactly as
  // `emitDataValue`'s pointer case spells it.
  const slotType = stripFuncDefIndirection(declaredType.trim());
  if (isFuncDefTypedefName(slotType)) {
    return `(${rootQualifyShadowedType(slotType)})${ensureHexPrefix(value, declaredType)}`;
  }
  // A four-byte pointer never carries `initializedData` — `fetchInitializedData`
  // only asks Ghidra for `size > 4` — so a `char *` global or static local whose
  // content is a string base arrives HERE as a raw `value`, not through
  // `emitDataValue`. Same table, same rule as the pointer case there.
  const resolved = pointerSlotAddressReference(value, slotType);
  if (resolved) return resolved;
  return castPointerInitializer(slotType, ensureHexPrefix(value, declaredType));
}

/**
 * Escape a string for use in a C string literal
 */
function escapeStringForC(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/**
 * Generate globals.cpp content — actual definitions with initializers
 *
 * This file contains:
 * - Definitions for globals that have initialized data (arrays, structs, tables)
 * - Uninitialized definitions for BSS globals
 */
export function generateGlobalsImpl(
  globals: AnalyzedDataSymbol[],
  options: ReconstructOptions & { projectName?: string; binaryName?: string },
  globalsHeaderPath = 'globals.h',
  extraIncludes?: string[],
  partition?: ReadonlySet<AnalyzedDataSymbol>,
  emitClosureDefinitions = false
): string {
  const lines: string[] = [];

  lines.push('/**');
  lines.push(' * Auto-generated global data definitions');
  if (options.binaryName) {
    lines.push(` * Binary: ${options.binaryName}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push(`#include "${globalsHeaderPath}"`);
  if (extraIncludes) {
    for (const inc of extraIncludes) {
      lines.push(`#include "${inc}"`);
    }
  }
  lines.push('');

  // Before anything the globals MODEL owns: the storage behind globals.h's
  // closure declarations. It belongs to exactly one unit — this one — and has to
  // be emitted before the early return below, or a partition that happens to
  // hold no modelled global would drop it.
  if (emitClosureDefinitions) {
    const closureDefs = renderClosureDefinitions();
    if (closureDefs.length > 0) lines.push(...closureDefs);
  }

  // Only emit definitions for non-constant globals, and only for the ones
  // globals.h is willing to declare (see isEmittableGlobal).
  const allGlobalNames = new Set(globals.map(g => g.suggestedName || g.name));
  const definable = globals.filter(g =>
    g.scope === 'global' && isEmittableGlobal(g) && !isDataArtifact(g, allGlobalNames)
    && !functionCollidingGlobals.has(g)
  );
  if (definable.length === 0 || (partition && partition.size === 0)) {
    lines.push('// No global definitions to emit');
    return lines.join('\n');
  }

  // Group by the namespace globals.h actually emitted, not the raw Ghidra path.
  const byNamespace = groupByEmittedNamespace(definable);

  // ONE definition per emitted (namespace, name).
  //
  // Two Ghidra symbols at different addresses can sanitize to the same emitted
  // name in the same emitted namespace — a genuine database collision
  // (`gLightRoomGreen` at two addresses), a `vftable` per class folded into the
  // parent namespace, or two spellings of one object. globals.h already picks
  // ONE of them for its extern and records the winner; globals.cpp defined all
  // of them, which is a hard C++ redefinition and, where the types differ, a
  // conflicting declaration as well. Pick the header's winner where there is
  // one, otherwise the first, and say what was dropped rather than dropping it
  // silently.
  const definitionWinner = new Map<string, AnalyzedDataSymbol>();
  const dropped = new Map<string, AnalyzedDataSymbol[]>();
  for (const { rendered: namespace, symbols: nsGlobals } of byNamespace) {
    for (const g of nsGlobals) {
      const key = `${namespace ?? ''}::${sanitizeSymbolName(g.suggestedName || g.name)}`;
      const held = definitionWinner.get(key);
      if (!held) { definitionWinner.set(key, g); continue; }
      // The header's choice wins, so declaration and definition are the same object.
      if (!headerDeclaredGlobals.has(held) && headerDeclaredGlobals.has(g)) {
        definitionWinner.set(key, g);
        (dropped.get(key) ?? dropped.set(key, []).get(key)!).push(held);
      } else {
        (dropped.get(key) ?? dropped.set(key, []).get(key)!).push(g);
      }
    }
  }
  const isDefinitionWinner = (namespace: string | undefined, g: AnalyzedDataSymbol): boolean =>
    definitionWinner.get(`${namespace ?? ''}::${sanitizeSymbolName(g.suggestedName || g.name)}`) === g;
  if (dropped.size > 0 && !partition) {
    lines.push(`// ${dropped.size} name(s) claimed by more than one Ghidra symbol in the same`);
    lines.push('// emitted namespace; one definition each, the others listed by address:');
    for (const [key, others] of [...dropped].sort()) {
      lines.push(`//   ${key} — also at ${others.map(o => `${o.address} (${o.suggestedType || o.dataType})`).join(', ')}`);
    }
    lines.push('');
  }

  // Forward declarations for everything this file defines.
  //
  // A data initializer can name a symbol defined LATER in this same file
  // (`aNpcGossipData` is used at :2333 and defined at :74472), and globals.h
  // does not declare every symbol globals.cpp defines — a global reconciled back
  // from `static-local` gets a definition here but no extern there. Declaring
  // the file's own definitions up front makes the order irrelevant. The
  // declaration is built by the same shape rules as the definition below, so a
  // redundant one is exactly the extern globals.h already has.
  for (const { rendered: namespace, symbols: nsGlobals } of byNamespace) {
    if (nsGlobals.length === 0) continue;
    if (namespace && /[<>,*]/.test(namespace)) continue;
    // Not restricted to the partition: a symbol this file's initializers name may
    // be DEFINED in a sibling partition, and globals.h does not declare every
    // symbol the globals files define (one reconciled back from `static-local`
    // gets a definition but no extern). An extern for a symbol defined
    // elsewhere is exactly what the reference needs.
    const undeclared = nsGlobals.filter(g => !headerDeclaredGlobals.has(g) && isDefinitionWinner(namespace, g));
    if (undeclared.length === 0) continue;
    if (namespace) lines.push(`namespace ${namespace} {`);
    emitGlobalDefsWithIfdef(lines, undeclared, false, (global, ls) => {
      const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
      const name = sanitizeSymbolName(global.suggestedName || global.name);
      const arrayInfo = inferArrayDeclaration(global);
      if (arrayInfo && (!global.initializedData || global.initializedData.kind === 'array'
                        || isWideTextDatum(global, type))) {
        recordDeclaredName(name);
        ls.push(`extern ${arrayInfo.type} ${name}[${arrayInfo.count}];`);
      } else {
        recordDeclaredName(name);
        ls.push(`extern ${normalizeArrayDeclaration(type, name)};`);
      }
    });
    if (namespace) lines.push(`} // namespace ${namespace}`);
  }
  lines.push('');

  for (const { resolved: namespaceScope, rendered: namespace, symbols: nsGlobals } of byNamespace) {
    if (nsGlobals.length === 0) continue;
    // Skip template instantiation namespaces (contain < > , *)
    if (namespace && /[<>,*]/.test(namespace)) continue;

    // Split into: initialized with data, initialized without data, uninitialized
    const owned = nsGlobals.filter(g =>
      isDefinitionWinner(namespace, g) && (!partition || partition.has(g)));
    const withData = owned.filter(g => g.initializedData);
    const withoutData = owned.filter(g => g.isInitialized && !g.initializedData);
    const uninitialized = owned.filter(g => !g.isInitialized);

    if (namespace) {
      lines.push(`namespace ${namespace} {`);
      lines.push('');
    }
    // Pointer initializers below resolve from inside this block.
    setInitializerNamespace(namespaceScope);

    // Initialized data with full values
    if (withData.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Initialized data (arrays, structs, tables)');
      lines.push('// =============================================================================');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withData, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        // Check if this should be an array declaration
        const arrayInfo = inferArrayDeclaration(global);
        setInitializerOwnerAddress(global.address);
        const initializer = emitDataValue(global.initializedData!, 0, type);
        setInitializerOwnerAddress(undefined);

        if (arrayInfo && (global.initializedData!.kind === 'array' || isWideTextDatum(global, type))) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${braceArrayInitializer(type, initializer)};`);
        }
        ls.push('');
      });
    }

    // Initialized scalars without structured data
    if (withoutData.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Initialized scalars');
      lines.push('// =============================================================================');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withoutData, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        setInitializerOwnerAddress(global.address);
        const value = renderGlobalScalarInitializer(global.value, type, arrayInfo?.count);
        setInitializerOwnerAddress(undefined);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${braceArrayInitializer(type, value)};`);
        }
      });
      lines.push('');
    }

    // Uninitialized (BSS)
    if (uninitialized.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Uninitialized data (BSS)');
      lines.push('// =============================================================================');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, uninitialized, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}];`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)};`);
        }
      });
      lines.push('');
    }

    setInitializerNamespace(undefined);

    if (namespace) {
      lines.push(`} // namespace ${namespace}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Emit global definitions with #ifdef grouping for consecutive same-ifdef globals.
 */
function emitGlobalDefsWithIfdef(
  lines: string[],
  globals: AnalyzedDataSymbol[],
  _includeAddressComments: boolean,
  emitOne: (global: AnalyzedDataSymbol, lines: string[]) => void
): void {
  let currentIfdef: string | undefined;
  for (const global of globals) {
    // Interior labels name a slot inside another global — nothing to define.
    const gName = global.suggestedName || global.name;
    if (isInteriorLabel(gName)) continue;
    if (global.ifdef !== currentIfdef) {
      if (currentIfdef) {
        lines.push(`#endif // ${currentIfdef}`);
      }
      if (global.ifdef) {
        lines.push(`#ifdef ${global.ifdef}`);
      }
      currentIfdef = global.ifdef;
    }
    emitOne(global, lines);
  }
  if (currentIfdef) {
    lines.push(`#endif // ${currentIfdef}`);
  }
}

/**
 * Collect forward declarations for struct/class types used as pointers in global declarations.
 * This ensures globals.h can reference struct types without needing full includes.
 */
function collectGlobalForwardDeclarations(
  globals: AnalyzedDataSymbol[],
  dataTypes?: ExtractedDataType[],
  typeOwnerMap?: Map<string, string>
): { forwardDecls: ForwardDeclaration[]; fullDefs: string[]; extraIncludes: string[]; sharedHeaderOwned: Set<string> } {
  // Library types (Win32 SDK / CRT) are provided by the real headers under
  // _WIN32 — never emit our own forward decl/definition for them.
  const isSkippableLibraryType = makeLibraryTypeSkipPredicate(dataTypes);

  // Collect type names referenced by globals and track which are used by value
  const typeInfo = new Map<string, { byValue: boolean }>();
  for (const g of globals) {
    const type = g.suggestedType || g.dataType;
    const isPointer = type.includes('*') || type.includes('&');

    const stripped = type
      .replace(/\*/g, '')
      .replace(/&/g, '')
      .replace(/const\s*/g, '')
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\{[^}]*\}/g, '')
      .trim()
      .replace(/\s+\d+$/, '');

    if (stripped && !isPlatformOrBuiltinType(stripped) && !isSkippableLibraryType(stripped) && /^[A-Za-z_]/.test(stripped) && !/[{}:<>,\s]/.test(stripped)) {
      const existing = typeInfo.get(stripped);
      if (existing) {
        if (!isPointer) existing.byValue = true;
      } else {
        typeInfo.set(stripped, { byValue: !isPointer });
      }
    }
  }

  // Build lookup for dataTypes by name
  const dataTypeMap = new Map<string, ExtractedDataType>();
  if (dataTypes) {
    for (const dt of dataTypes) {
      dataTypeMap.set(dt.name, dt);
    }
  }

  // Expand typeInfo by scanning fields/params of by-value types (worklist approach)
  const worklist: string[] = [];
  for (const [name, info] of typeInfo) {
    if (info.byValue && dataTypeMap.has(name)) {
      worklist.push(name);
    }
  }
  while (worklist.length > 0) {
    const name = worklist.pop()!;
    const dt = dataTypeMap.get(name);
    if (!dt) continue;

    const referencedTypes: { typeName: string; isPointer: boolean }[] = [];

    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') {
      const fields = (dt as ExtractedStruct | ExtractedUnion).fields;
      for (const field of fields) {
        const parsed = parseReferencedType(field.dataType);
        if (parsed) referencedTypes.push(parsed);
      }
    } else if (dt.kind === 'FUNCTION_DEFINITION') {
      const funcDef = dt as ExtractedFunctionDefinition;
      const retParsed = parseReferencedType(funcDef.returnType);
      if (retParsed) referencedTypes.push(retParsed);
      for (const param of funcDef.parameters) {
        const parsed = parseReferencedType(param.dataType);
        if (parsed) referencedTypes.push(parsed);
      }
    }

    for (const { typeName, isPointer } of referencedTypes) {
      const existing = typeInfo.get(typeName);
      if (existing) {
        if (!isPointer && !existing.byValue) {
          existing.byValue = true;
          if (dataTypeMap.has(typeName)) worklist.push(typeName);
        }
      } else {
        typeInfo.set(typeName, { byValue: !isPointer });
        if (!isPointer && dataTypeMap.has(typeName)) worklist.push(typeName);
      }
    }
  }

  // A function-pointer typedef is emitted IN FULL even when every global that
  // reaches it does so through a pointer (see the pointer-only loop below, which
  // calls generateFunctionDefinitionDeclaration rather than emitting `struct X;`).
  // That typedef names its return type and every parameter type, so those types
  // need a declaration in globals.h too — but the by-value worklist above never
  // reaches them, because the typedef itself was never by-value. Result:
  //   typedef void (*D2MissileSrvDmgFunc)(…, D2MissileDamageDataStrc * pDamage);
  // with no `struct D2MissileDamageDataStrc;` anywhere above it, which fails to
  // compile in every TU that includes globals.h.
  //
  // Register those signature types as POINTER references only: an incomplete type
  // is legal in a function-type parameter list, so a forward declaration always
  // suffices and we never drag a full struct body into globals.h.
  {
    const pending = [...typeInfo.keys()].filter(n => dataTypeMap.get(n)?.kind === 'FUNCTION_DEFINITION');
    const walked = new Set<string>();
    while (pending.length > 0) {
      const name = pending.pop()!;
      if (walked.has(name)) continue;
      walked.add(name);
      const fd = dataTypeMap.get(name) as ExtractedFunctionDefinition;
      const signature = [fd.returnType, ...fd.parameters.map(p => p.dataType)];
      for (const t of signature) {
        const parsed = parseReferencedType(t);
        if (!parsed) continue;
        if (isSkippableLibraryType(parsed.typeName)) continue;
        if (!typeInfo.has(parsed.typeName)) {
          typeInfo.set(parsed.typeName, { byValue: false });
        }
        if (dataTypeMap.get(parsed.typeName)?.kind === 'FUNCTION_DEFINITION') {
          pending.push(parsed.typeName);
        }
      }
    }
  }

  // Build dependency graph for topological ordering of full definitions
  const deps = new Map<string, Set<string>>();
  const fullDefTypes = new Set<string>();

  for (const [name, info] of typeInfo) {
    if (info.byValue && dataTypeMap.has(name)) {
      fullDefTypes.add(name);
      deps.set(name, new Set());
    }
  }

  for (const name of fullDefTypes) {
    const dt = dataTypeMap.get(name)!;
    const fieldTypes: string[] = [];

    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') {
      for (const field of (dt as ExtractedStruct | ExtractedUnion).fields) {
        const parsed = parseReferencedType(field.dataType);
        if (parsed) fieldTypes.push(parsed.typeName);
      }
    } else if (dt.kind === 'FUNCTION_DEFINITION') {
      const funcDef = dt as ExtractedFunctionDefinition;
      const retParsed = parseReferencedType(funcDef.returnType);
      if (retParsed) fieldTypes.push(retParsed.typeName);
      for (const param of funcDef.parameters) {
        const parsed = parseReferencedType(param.dataType);
        if (parsed) fieldTypes.push(parsed.typeName);
      }
    }

    for (const dep of fieldTypes) {
      if (fullDefTypes.has(dep) && dep !== name) {
        deps.get(name)!.add(dep);
      }
    }
  }

  // Topological sort (Kahn's algorithm), fallback to alphabetical for ties
  const sorted: string[] = [];
  const inDegree = new Map<string, number>();
  for (const name of fullDefTypes) inDegree.set(name, 0);
  for (const [, d] of deps) {
    for (const dep of d) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }
  // Reverse: inDegree tracks how many types depend ON this type (not how many it depends on)
  // We actually need: for each type, count how many of its dependencies are unresolved
  const depCount = new Map<string, number>();
  for (const [name, d] of deps) depCount.set(name, d.size);

  const queue = [...fullDefTypes].filter(n => depCount.get(n) === 0).sort();
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(name);
    for (const [other, d] of deps) {
      if (d.has(name)) {
        d.delete(name);
        depCount.set(other, depCount.get(other)! - 1);
        if (depCount.get(other) === 0) {
          // Insert sorted to keep alphabetical tie-breaking
          const idx = queue.findIndex(q => q > other);
          if (idx === -1) queue.push(other);
          else queue.splice(idx, 0, other);
        }
      }
    }
  }
  // Any remaining (cycles) — just append alphabetically
  for (const name of [...fullDefTypes].sort()) {
    if (!sorted.includes(name)) sorted.push(name);
  }

  const forwardDecls: ForwardDeclaration[] = [];
  const fullDefs: string[] = [];
  const extraIncludes = new Set<string>();
  // Types this header deliberately does not declare because a shared header
  // already does. They are declared as far as the caller's safety net is
  // concerned — without that, the net emits `struct X;` over a `typedef int X`.
  const sharedHeaderOwned = new Set<string>();

  // Emit full definitions in topological order, but prefer #include for types with an owning header
  for (const name of sorted) {
    const ownerHeader = typeOwnerMap?.get(name);
    if (ownerHeader && ownerHeader !== 'globals.h') {
      // Type has its own header — include it instead of duplicating the definition
      extraIncludes.add(ownerHeader);
      continue;
    }

    const dt = dataTypeMap.get(name)!;
    if (dt.kind === 'ENUM') {
      // d2_enums.h holds EVERY ENUM datatype and d2_platform.h includes it
      // unconditionally, so by the time this header's body is reached the type
      // is already complete. Defining it again re-defines each enumerator's
      // `constexpr` in `<name>_ns` — one such enum failed every translation
      // unit in the tree four times over.
      sharedHeaderOwned.add(name);
      continue;
    }
    switch (dt.kind) {
      case 'STRUCTURE':
        fullDefs.push(generateStructDeclaration(dt as ExtractedStruct));
        break;
      case 'UNION':
        fullDefs.push(generateUnionDeclaration(dt as ExtractedUnion));
        break;
      case 'FUNCTION_DEFINITION':
        fullDefs.push(generateFunctionDefinitionDeclaration(dt as ExtractedFunctionDefinition));
        break;
      default:
        forwardDecls.push({ name, text: emitFallbackForwardDecl(name), deps: [] });
        break;
    }
  }

  // Emit forward declarations for pointer-only / unavailable types
  for (const name of [...typeInfo.keys()].sort()) {
    if (fullDefTypes.has(name)) continue;
    // Library types (Win32 SDK / CRT) are provided by the real headers — never
    // emit a `struct X;` forward decl that would clash with the SDK typedef.
    if (isSkippableLibraryType(name)) continue;
    // Check if this type is a FUNCTION_DEFINITION in the dataTypeMap
    // (it might be owned by another header and not in fullDefTypes)
    const dt = dataTypeMap.get(name);
    if (dt?.kind === 'ENUM') {
      // Same reason as the by-value case: d2_enums.h owns it. The fallback here
      // would be `typedef int X;` for an `eXxx` name but `struct X;` for any
      // other, and that second form contradicts the typedef d2_enums.h emits.
      sharedHeaderOwned.add(name);
      continue;
    }
    if (dt?.kind === 'FUNCTION_DEFINITION') {
      // Emit the actual funcdef typedef, not a struct forward decl. Its signature
      // may name other typedefs in this same block, so it carries them as
      // dependencies — the emission order is resolved from those, not from the
      // name the declaration happens to sort under.
      const fd = dt as ExtractedFunctionDefinition;
      forwardDecls.push({
        name,
        text: generateFunctionDefinitionDeclaration(fd),
        deps: signatureTypeNames(fd),
      });
    } else if ((dt?.kind === 'STRUCTURE' || dt?.kind === 'UNION') && typeOwnerMap && !typeOwnerMap.get(name)) {
      // An aggregate Ghidra fully describes that NO header owns. Every global
      // reaching it does so through a pointer, so the pointer-only rule spells
      // `struct X;` — but with no owner there is no header that could ever
      // complete it, and a body that dereferences the pointer fails with
      // "invalid use of incomplete type" and nothing to include. Ghidra has the
      // layout; emit it here, where the pointer is declared.
      //
      // Only when unowned, and only when ownership was computed at all: a type
      // some header defines must stay a forward declaration here, or the two
      // definitions collide in every TU that sees both, and without the map
      // there is no way to tell which types those are.
      forwardDecls.push({
        name,
        text: dt.kind === 'STRUCTURE'
          ? generateStructDeclaration(dt as ExtractedStruct)
          : generateUnionDeclaration(dt as ExtractedUnion),
        deps: aggregateMemberTypeNames(dt as ExtractedStruct | ExtractedUnion),
        defines: true,
      });
    } else {
      forwardDecls.push({ name, text: emitFallbackForwardDecl(name), deps: [] });
    }
  }

  return { forwardDecls, fullDefs, extraIncludes: [...extraIncludes].sort(), sharedHeaderOwned };
}

/**
 * Extract the base type name from a C type string, returning whether it's a pointer.
 * Returns null for platform/builtin types or unparseable strings.
 */
function parseReferencedType(typeStr: string): { typeName: string; isPointer: boolean } | null {
  const isPointer = typeStr.includes('*') || typeStr.includes('&');
  const stripped = typeStr
    .replace(/\*/g, '')
    .replace(/&/g, '')
    .replace(/const\s*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .trim()
    .replace(/\s+\d+$/, '');

  if (!stripped || isPlatformOrBuiltinType(stripped) || !/^[A-Za-z_]/.test(stripped) || /[{}:<>,\s]/.test(stripped)) {
    return null;
  }
  return { typeName: stripped, isPointer };
}

/**
 * One line of the forward-declaration block, kept as a record rather than as
 * text: the type it introduces and the types its own spelling needs already
 * declared. A function-pointer typedef whose signature names another typedef
 * must be emitted after it, and that fact lives in the data type, not in the
 * characters of the emitted line.
 */
export interface ForwardDeclaration {
  /** The type this line declares. */
  name: string;
  /** The emitted line. */
  text: string;
  /** Types this line names and therefore must follow. */
  deps: string[];
  /**
   * True when the line DEFINES the aggregate rather than declaring it. The name
   * lands at root scope either way, so a namespace of that name still collides.
   */
  defines?: boolean;
}

/**
 * Type names an aggregate's members spell out. An EMBEDDED member needs its type
 * complete, so its declaration has to come first; a pointer member does not, but
 * ordering it first costs nothing and the block only keeps edges between lines it
 * actually emits.
 */
function aggregateMemberTypeNames(agg: ExtractedStruct | ExtractedUnion): string[] {
  const names: string[] = [];
  for (const field of agg.fields ?? []) {
    const parsed = parseReferencedType(field.dataType);
    if (parsed && parsed.typeName !== agg.name) names.push(parsed.typeName);
  }
  return names;
}

/** Type names a function definition's signature spells out (return type + parameters). */
function signatureTypeNames(fd: ExtractedFunctionDefinition): string[] {
  const names: string[] = [];
  for (const t of [fd.returnType, ...fd.parameters.map(p => p.dataType)]) {
    const parsed = parseReferencedType(t);
    if (parsed && parsed.typeName !== fd.name) names.push(parsed.typeName);
  }
  return names;
}

/**
 * Order the forward-declaration block so a declaration follows every declaration
 * it names. Kahn's algorithm over the recorded dependencies, with the ready set
 * drained in the block's existing key order (the declaration text) so the output
 * is stable: an unconstrained declaration keeps the place it had, and only the
 * ones an edge actually binds move.
 */
export function orderForwardDeclarations(
  decls: ForwardDeclaration[],
  where = 'globals.h',
): string[] {
  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const byName = new Map<string, ForwardDeclaration>();
  for (const d of decls) if (!byName.has(d.name)) byName.set(d.name, d);

  // Edges are kept only between declarations this block actually emits; a
  // signature naming a library type or a type declared elsewhere constrains
  // nothing here.
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const d of decls) {
    const need = new Set<string>();
    for (const dep of d.deps) {
      if (dep === d.name || !byName.has(dep)) continue;
      need.add(dep);
    }
    pending.set(d.name, need);
    for (const dep of need) {
      const list = dependents.get(dep);
      if (list) list.push(d.name);
      else dependents.set(dep, [d.name]);
    }
  }

  const ready = decls.filter(d => pending.get(d.name)!.size === 0).map(d => d.name);
  ready.sort((a, b) => byKey(byName.get(a)!.text, byName.get(b)!.text));

  const ordered: string[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const name = ready.shift()!;
    if (emitted.has(name)) continue;
    emitted.add(name);
    ordered.push(byName.get(name)!.text);
    for (const dependent of dependents.get(name) ?? []) {
      const need = pending.get(dependent)!;
      need.delete(name);
      if (need.size > 0 || emitted.has(dependent)) continue;
      const text = byName.get(dependent)!.text;
      const idx = ready.findIndex(q => byKey(byName.get(q)!.text, text) > 0);
      if (idx === -1) ready.push(dependent);
      else ready.splice(idx, 0, dependent);
    }
  }

  // A cycle cannot be resolved by ordering. C has no forward declaration for a
  // typedef name, so report the members rather than pick an arbitrary order for
  // them, and fall back to the key order.
  const stuck = decls.filter(d => !emitted.has(d.name));
  if (stuck.length > 0) {
    console.warn(`${where}: ${stuck.length} forward declaration(s) form a dependency cycle and stay in key order:`);
    for (const d of [...stuck].sort((a, b) => byKey(a.name, b.name))) {
      console.warn(`  ${d.name} -> ${d.deps.filter(x => stuck.some(o => o.name === x)).join(', ')}`);
    }
    for (const d of [...stuck].sort((a, b) => byKey(a.text, b.text))) ordered.push(d.text);
  }

  return ordered;
}

function emitFallbackForwardDecl(name: string): string {
  if (/^e[A-Z]/.test(name)) {
    return enumTypedefLine(name);
  }
  if (/^fn[A-Z]/.test(name) || /^fp[A-Z]/.test(name) || /Proc[A-Z]?$/.test(name) || /Callback$/.test(name) || /Handler$/.test(name)) {
    return `typedef void (*${name})();`;
  }
  return `struct ${name};`;
}

/**
 * Generate co-located global definitions for struct .cpp files
 * (no header/includes, just the definitions)
 */
export function generateColocatedGlobalsImpl(
  globals: AnalyzedDataSymbol[],
  options: ReconstructOptions
): string {
  const lines: string[] = [];

  const colocatedNames = new Set(globals.map(g => g.suggestedName || g.name));
  globals = globals.filter(g => isEmittableGlobal(g) && !isDataArtifact(g, colocatedNames));
  if (globals.length === 0) {
    return '';
  }

  lines.push('// =============================================================================');
  lines.push('// Co-located global data definitions');
  lines.push('// =============================================================================');
  lines.push('');

  // Group by the namespace globals.h actually emitted, not the raw Ghidra path.
  // Same grouping as the struct header's extern block.
  const byNamespace = groupByEmittedNamespace(globals);

  for (const { resolved: namespaceScope, rendered: namespace, symbols: nsGlobals } of byNamespace) {
    if (nsGlobals.length === 0) continue;
    // Skip template instantiation namespaces (contain < > , *)
    if (namespace && /[<>,*]/.test(namespace)) continue;

    // Split into: initialized with data, initialized without data, uninitialized
    const withData = nsGlobals.filter(g => g.initializedData);
    const withoutData = nsGlobals.filter(g => g.isInitialized && !g.initializedData);
    const uninitialized = nsGlobals.filter(g => !g.isInitialized);

    if (namespace) {
      lines.push(`namespace ${namespace} {`);
      lines.push('');
    }
    // Pointer initializers below resolve from inside this block.
    setInitializerNamespace(namespaceScope);

    // Initialized data with full values
    if (withData.length > 0) {
      lines.push('// Initialized data');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withData, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        setInitializerOwnerAddress(global.address);
        const initializer = emitDataValue(global.initializedData!, 0, type);
        setInitializerOwnerAddress(undefined);

        if (arrayInfo && (global.initializedData!.kind === 'array' || isWideTextDatum(global, type))) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${braceArrayInitializer(type, initializer)};`);
        }
        ls.push('');
      });
    }

    // Initialized scalars without structured data
    if (withoutData.length > 0) {
      lines.push('// Initialized scalars');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withoutData, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        setInitializerOwnerAddress(global.address);
        const value = renderGlobalScalarInitializer(global.value, type, arrayInfo?.count);
        setInitializerOwnerAddress(undefined);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${braceArrayInitializer(type, value)};`);
        }
      });
      lines.push('');
    }

    // Uninitialized (BSS)
    if (uninitialized.length > 0) {
      lines.push('// Uninitialized data (BSS)');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, uninitialized, options.includeAddressComments, (global, ls) => {
        const type = normalizeGlobalDeclType(global.suggestedType || global.dataType);
        const name = sanitizeSymbolName(global.suggestedName || global.name);

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}];`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)};`);
        }
      });
      lines.push('');
    }

    setInitializerNamespace(undefined);

    if (namespace) {
      lines.push(`} // namespace ${namespace}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

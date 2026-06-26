/**
 * Globals header generation
 *
 * Generates a globals.h file with extern declarations for all global data symbols.
 * Also provides helpers for generating static local declarations.
 */

import type { AnalyzedDataSymbol, ReconstructOptions, DataValue, ExtractedDataType, ExtractedStruct, ExtractedEnum, ExtractedUnion, ExtractedFunctionDefinition } from '../types.js';
import { isPlatformOrBuiltinType, isLibraryType, isStructType, castPointerInitializer, normalizeDataValue, isMsvcEhInternal } from './platform-types.js';
import { generateStructDeclaration, generateEnumDeclaration, generateUnionDeclaration, generateFunctionDefinitionDeclaration } from './header.js';
import { collapseConsecutiveDuplicates } from './namespace.js';

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
export function generateGlobalsHeader(
  globals: AnalyzedDataSymbol[],
  options: ReconstructOptions & { projectName?: string; binaryName?: string },
  dataTypes?: ExtractedDataType[],
  typeOwnerMap?: Map<string, string>,
  functionQualifiedNames?: Set<string>,
  bodyIdentifierFnCounts?: Map<string, number>
): string {
  const lines: string[] = [];

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

  // Drop globals whose TYPE is an MSVC-EH internal (C++ exception-handling
  // metadata: __ehfuncinfo$ etc. typed as FuncInfo / UnwindMapEntry /
  // HandlerType / TryBlockMapEntry). No real header declares those types, so
  // emitting these globals yields "X does not name a type" across every TU.
  // NOTE: only EH internals — NOT Win32 SDK types (RGBQUAD, SYSTEMTIME, ...),
  // which the real <windows.h> provides, so game globals typed as those stay.
  globals = globals.filter(g => {
    const base = (g.suggestedType || g.dataType || '')
      .replace(/[*&]/g, '').replace(/\bconst\b/g, '').replace(/\[[^\]]*\]/g, '').trim();
    return !isMsvcEhInternal(base);
  });

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
  const { forwardDecls, fullDefs, extraIncludes: byValueIncludes } = collectGlobalForwardDeclarations(globals, dataTypes, typeOwnerMap);

  // Include headers for by-value types that have an owning header (avoid duplicate definitions)
  if (byValueIncludes.length > 0) {
    for (const inc of byValueIncludes) {
      lines.push(`#include "${inc}"`);
    }
  }
  lines.push('');

  // Safety net: scan all globals for type names that may be missing from forward declarations
  const declaredNames = new Set<string>();
  for (const decl of forwardDecls) {
    const m = decl.match(/(?:struct|class)\s+(\w+)/);
    if (m) declaredNames.add(m[1]);
    const tm = decl.match(/typedef\s+.*?\(\*(\w+)\)/);
    if (tm) declaredNames.add(tm[1]);
    const tm2 = decl.match(/typedef\s+\w+\s+(\w+)/);
    if (tm2) declaredNames.add(tm2[1]);
  }
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
    forwardDecls.push(emitFallbackForwardDecl(type));
    declaredNames.add(type);
  }

  if (forwardDecls.length > 0) {
    lines.push('// Forward declarations');
    for (const decl of [...forwardDecls].sort()) {
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
    const m = decl.match(/^(?:struct|class)\s+(\w+);$/);
    if (m) collidingNamespaceParts.add(m[1]);
  }
  for (const g of globals) {
    if (g.scope !== 'global') continue;
    const gName = g.suggestedName || g.name;
    if (/^[A-Za-z_]\w*$/.test(gName)) collidingNamespaceParts.add(gName);
  }

  // Group globals by namespace, stripping components that collide with struct
  // names or global variable names
  const rawByNamespace = groupByNamespace(globals);
  const byNamespace = new Map<string | undefined, typeof globals>();
  for (const [ns, nsGlobals] of rawByNamespace) {
    let cleanNs = ns;
    if (cleanNs && collidingNamespaceParts.size > 0) {
      const parts = cleanNs.split('::');
      const filtered = parts.filter(p => !collidingNamespaceParts.has(p));
      cleanNs = filtered.length > 0 ? filtered.join('::') : undefined;
    }
    // Collapse consecutive duplicate segments (e.g. Monsters::Monsters::Umod →
    // Monsters::Umod) so the global's emitted namespace matches the collapsed
    // form function bodies use to reference it — otherwise the qualified body
    // reference fails to resolve ("not a member of ...::Umod").
    if (cleanNs) cleanNs = collapseConsecutiveDuplicates(cleanNs) || undefined;
    const existing = byNamespace.get(cleanNs);
    if (existing) {
      existing.push(...nsGlobals);
    } else {
      byNamespace.set(cleanNs, [...nsGlobals]);
    }
  }

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
    const constantsByNamespace = groupByNamespace(constants);
    for (const [rawNamespace, nsConstants] of constantsByNamespace) {
      if (nsConstants.length === 0) continue;
      // Skip template instantiation namespaces (contain < > , *)
      if (rawNamespace && /[<>,*]/.test(rawNamespace)) continue;

      // Collapse consecutive duplicate segments (Quests::Quests → Quests) so the
      // emitted namespace matches the collapsed form bodies use to reference these
      // constants — otherwise the qualified reference fails ("not a member of").
      const namespace = rawNamespace ? (collapseConsecutiveDuplicates(rawNamespace) || undefined) : rawNamespace;

      if (namespace) {
        lines.push(`namespace ${namespace} {`);
        lines.push('');
      }

      for (const constant of nsConstants) {
        const comment = constant.address ? `// @${constant.address}` : '';
        const type = constant.suggestedType || constant.dataType;
        const name = constant.suggestedName || constant.name;
        const value = ensureHexPrefix(constant.value ?? '0');
        lines.push(`constexpr ${normalizeArrayDeclaration(type, name)} = ${value}; ${comment}`);
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

    for (const [namespace, nsGlobals] of byNamespace) {
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
        const qualifiedName = namespace ? `${namespace}::${global.suggestedName || global.name}` : (global.suggestedName || global.name);
        if (emittedGlobalNames.has(qualifiedName)) continue;
        // Skip globals that collide with a same-named function in the same scope
        // (the function declaration owns the name — see fnNames above).
        if (fnNames.has(qualifiedName)) {
          lines.push(`// skipped: ${qualifiedName} (collides with a function of the same name)`);
          continue;
        }
        emittedGlobalNames.add(qualifiedName);
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
        lines.push(generateExternDeclaration(global, options.includeAddressComments));
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

      const rawName = g.suggestedName || g.name;
      // Must be a valid C identifier (generateExternDeclaration would otherwise
      // drop it; an invalid-name extern can't resolve a body reference anyway).
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

      const recoveredByNamespace = groupByNamespace(recovered);
      for (const [rawNamespace, nsGlobals] of recoveredByNamespace) {
        if (nsGlobals.length === 0) continue;
        if (rawNamespace && /[<>,*]/.test(rawNamespace)) continue;
        // Collapse consecutive duplicate segments (Quests::Quests → Quests) to
        // match the collapsed form bodies use to reference these recovered globals.
        const namespace = rawNamespace ? (collapseConsecutiveDuplicates(rawNamespace) || undefined) : rawNamespace;
        if (namespace) {
          lines.push(`namespace ${namespace} {`);
          lines.push('');
        }
        for (const global of nsGlobals) {
          lines.push(generateExternDeclaration(global, options.includeAddressComments));
        }
        if (namespace) {
          lines.push('');
          lines.push(`} // namespace ${namespace}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
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

  // Skip globals with invalid C++ identifier names (digits, special chars)
  if (/[^A-Za-z0-9_]/.test(name) || /^\d/.test(name)) return `// skipped: ${name} (invalid identifier)`;

  // 'auto' is not valid for extern declarations
  if (type === 'auto') type = 'void*';
  // Strip Ghidra pointer size annotations: "void *32" → "void*"
  type = type.replace(/\s*\*\s*\d+\b/g, '*');
  // Ghidra artifact types that have no C equivalent — use uint8_t
  if (type === 'Alignment' || type === 'IMAGE_DOS_HEADER' || type === 'IMAGE_DEBUG_DIRECTORY'
    || type === 'IMAGE_DIRECTORY_ENTRY_EXPORT' || type === 'IMAGE_RESOURCE_DIRECTORY'
    || type === 'VS_VERSION_INFO' || type === 'IMAGE_NT_HEADERS' || type === 'IMAGE_SECTION_HEADER') type = 'uint8_t';

  let declaration = `extern ${normalizeArrayDeclaration(type, name)};`;

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

  // Sanitize names with invalid C++ identifier characters
  // RTTI names like ".?AUStringEntryNode@@" and dotted names like "Obj.field"
  name = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^\d/.test(name)) name = '_' + name;

  // auto is not useful in reconstructed code — use int for scalar values
  if (type === 'auto') type = 'int';

  let initializer = '';
  if (symbol.initializedData) {
    const arrayInfo = inferArrayDeclaration(symbol);
    const init = emitDataValue(symbol.initializedData, 0);
    if (arrayInfo && symbol.initializedData.kind === 'array') {
      return `static ${arrayInfo.type} ${name}[${arrayInfo.count}] = ${init};`;
    }
    initializer = ` = ${init}`;
  } else if (symbol.value !== undefined && symbol.value !== null) {
    // Quote string values that aren't already quoted
    if (type === 'const char*' && !symbol.value.startsWith('"')) {
      initializer = ` = "${escapeStringForC(symbol.value)}"`;
    } else {
      initializer = ` = ${ensureHexPrefix(symbol.value)}`;
    }
  } else if (type === 'auto') {
    // Can't have uninitialized auto
    initializer = ' = {}';
  }

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

  // Filter out globals whose sanitized name doesn't appear in the function body
  if (bodyIdentifiers) {
    statics = statics.filter(s => {
      let name = s.suggestedName || s.name;
      name = name.replace(/[^A-Za-z0-9_]/g, '_');
      if (/^\d/.test(name)) name = '_' + name;
      return bodyIdentifiers.has(name);
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
        type: symbol.suggestedType || symbol.dataType,
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
  };

  return sizes[dataType.toLowerCase()] || 0;
}

// =============================================================================
// globals.cpp generation — definitions with initializers
// =============================================================================

/**
 * Convert a DataValue tree to a C initializer string
 */
export function emitDataValue(dv: DataValue, indent = 0): string {
  const pad = '    '.repeat(indent);
  const innerPad = '    '.repeat(indent + 1);

  switch (dv.kind) {
    case 'scalar': {
      const val = normalizeDataValue(dv.value ?? '0');
      // If value is a single printable char (not a number/hex), wrap in char literal quotes
      if (val.length === 1 && !/\d/.test(val)) {
        const code = val.charCodeAt(0);
        // Non-printable or non-ASCII: emit as hex escape
        if (code > 127 || code < 0x20) {
          return `'\\x${code.toString(16).padStart(2, '0')}'`;
        }
        // Escape special chars in char literals
        const escaped = val === '\\' ? '\\\\' : val === '\'' ? '\\\'' : val;
        return `'${escaped}'`;
      }
      return val;
    }

    case 'string':
      // Escape the string for C
      return `"${escapeStringForC(dv.value ?? '')}"`;

    case 'pointer':
      if (!dv.value || dv.value === '0x0' || dv.value === '0x00000000' || dv.value === 'DAT_00000000') {
        return 'nullptr';
      }
      // If it looks like a symbol name (not hex), emit as address-of.
      // Drop the CRT-helper namespace prefixes (compiler/VisualStudio are not emitted).
      if (/^[A-Za-z_]/.test(dv.value)) {
        const sym = dv.value.replace(/\b(?:compiler|VisualStudio)::/g, '');
        // `&<multidim-array-global>` is `T(*)[N][M]`; the pointer field wants `T*`.
        // Cast it (a 1-D array would just decay, but a 2-D+ one needs the cast).
        const elem = multidimArrayGlobals.get(sym);
        return elem ? `(${elem}*)&${sym}` : `&${sym}`;
      }
      // Raw hex pointer — normalize value (add 0x prefix if needed)
      return `(void*)${normalizeDataValue(dv.value)}`;

    case 'enum':
      return dv.value ?? '0';

    case 'array': {
      if (!dv.elements || dv.elements.length === 0) return '{}';
      // For small arrays of scalars/pointers, emit on fewer lines
      const isSimple = dv.elements.every(e => e.kind === 'scalar' || e.kind === 'pointer' || e.kind === 'enum');
      if (isSimple && dv.elements.length <= 8) {
        const vals = dv.elements.map((e, i) => {
          const v = emitDataValue(e, 0);
          return i < dv.elements!.length - 1 ? `${v},` : v;
        });
        return `{ ${vals.join(' ')} }`;
      }
      // Multi-line array
      const lines = dv.elements.map((e, i) => {
        const v = emitDataValue(e, indent + 1);
        const comma = i < dv.elements!.length - 1 ? ',' : '';
        return `${innerPad}${v}${comma}`;
      });
      return `{\n${lines.join('\n')}\n${pad}}`;
    }

    case 'struct': {
      if (!dv.fields || dv.fields.length === 0) return '{}';
      const fieldLines = dv.fields.map((f, i) => {
        const v = emitDataValue(f.value, indent + 1);
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

/**
 * Check if a symbol name is a switch jump table artifact (dead after goto cleanup)
 */
export function isSwitchTableSymbol(name: string): boolean {
  return name.startsWith('switchdataD_') || name.startsWith('PTR_caseD_')
    || name.startsWith('LAB_') || name.startsWith('SUB_')
    || name.includes('+')   // Malformed names like "PTR_caseD_3_0067582c+2"
    || name.includes('@');  // Decorated names like "PTR__BinkOpen@8_006cc5b8"
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
 * Globals declared as MULTIDIMENSIONAL arrays (`T[N][M]…`), mapped to their
 * element base type. Taking the address of such a global (`&name`) yields
 * `T(*)[N][M]`, but the pointer field it initializes wants `T*` — and unlike a
 * 1-D array, dropping the `&` still leaves `T(*)[M]` (not `T*`). So a CAST is
 * required: `(T*)&name`. Populated from the extracted globals before emission.
 */
const multidimArrayGlobals = new Map<string, string>();

export function setMultidimArrayGlobals(
  globals: Iterable<{ name: string; dataType?: string }>,
): void {
  multidimArrayGlobals.clear();
  for (const g of globals) {
    if (!g.dataType) continue;
    // `char[5][4]`, `undefined1 [3][2]`, `D2Foo[8][8]` → 2+ dimensions.
    const m = g.dataType.match(/^([\w:]+(?:\s*\*)*)\s*(?:\[\d+\]\s*){2,}$/);
    if (m) multidimArrayGlobals.set(g.name, m[1].trim());
  }
}

/** Name conventions for FunctionDefinition typedefs emitted by the codegen. */
export function isFuncDefTypedefName(name: string): boolean {
  return knownFuncDefTypedefs.has(name)
    || /^fn[A-Z]/.test(name)
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
function ensureHexPrefix(value: string): string {
  // Matches bare hex like "005a32f5" — has hex digits and at least one a-f letter
  if (/^[0-9a-fA-F]+$/.test(value) && /[a-fA-F]/.test(value)) {
    return `0x${value}`;
  }
  return value;
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
  extraIncludes?: string[]
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

  // Only emit definitions for non-constant globals
  const definable = globals.filter(g => g.scope === 'global');
  if (definable.length === 0) {
    lines.push('// No global definitions to emit');
    return lines.join('\n');
  }

  // Group by namespace for proper wrapping
  const byNamespace = groupByNamespace(definable);

  for (const [namespace, nsGlobals] of byNamespace) {
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

    // Initialized data with full values
    if (withData.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Initialized data (arrays, structs, tables)');
      lines.push('// =============================================================================');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withData, options.includeAddressComments, (global, ls) => {
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        // Check if this should be an array declaration
        const arrayInfo = inferArrayDeclaration(global);
        const initializer = emitDataValue(global.initializedData!, 0);

        if (arrayInfo && global.initializedData!.kind === 'array') {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${initializer};`);
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
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;
        let value = normalizeDataValue(global.value ?? '0');

        // Struct types can't be initialized with = 0; use = {} instead
        if ((value === '0' || value === '0x0') && isStructType(type)) {
          value = '{}';
        }

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        value = castPointerInitializer(type, value);
        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${value};`);
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
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;

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
    // Skip globals with invalid C++ identifier names (dots, digits, special chars)
    const gName = global.suggestedName || global.name;
    if (/[^A-Za-z0-9_]/.test(gName) || /^\d/.test(gName)) {
      lines.push(`// skipped: ${gName} (invalid identifier)`);
      continue;
    }
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
): { forwardDecls: string[]; fullDefs: string[]; extraIncludes: string[] } {
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

  const forwardDecls: string[] = [];
  const fullDefs: string[] = [];
  const extraIncludes = new Set<string>();

  // Emit full definitions in topological order, but prefer #include for types with an owning header
  for (const name of sorted) {
    const ownerHeader = typeOwnerMap?.get(name);
    if (ownerHeader && ownerHeader !== 'globals.h') {
      // Type has its own header — include it instead of duplicating the definition
      extraIncludes.add(ownerHeader);
      continue;
    }

    const dt = dataTypeMap.get(name)!;
    switch (dt.kind) {
      case 'STRUCTURE':
        fullDefs.push(generateStructDeclaration(dt as ExtractedStruct));
        break;
      case 'ENUM':
        fullDefs.push(generateEnumDeclaration(dt as ExtractedEnum));
        break;
      case 'UNION':
        fullDefs.push(generateUnionDeclaration(dt as ExtractedUnion));
        break;
      case 'FUNCTION_DEFINITION':
        fullDefs.push(generateFunctionDefinitionDeclaration(dt as ExtractedFunctionDefinition));
        break;
      default:
        forwardDecls.push(emitFallbackForwardDecl(name));
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
    if (dt?.kind === 'FUNCTION_DEFINITION') {
      // Emit the actual funcdef typedef, not a struct forward decl
      forwardDecls.push(generateFunctionDefinitionDeclaration(dt as ExtractedFunctionDefinition));
    } else {
      forwardDecls.push(emitFallbackForwardDecl(name));
    }
  }

  return { forwardDecls, fullDefs, extraIncludes: [...extraIncludes].sort() };
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

function emitFallbackForwardDecl(name: string): string {
  if (/^e[A-Z]/.test(name)) {
    return `typedef int ${name};`;
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

  if (globals.length === 0) {
    return '';
  }

  lines.push('// =============================================================================');
  lines.push('// Co-located global data definitions');
  lines.push('// =============================================================================');
  lines.push('');

  // Group by namespace for proper wrapping
  const byNamespace = groupByNamespace(globals);

  for (const [namespace, nsGlobals] of byNamespace) {
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

    // Initialized data with full values
    if (withData.length > 0) {
      lines.push('// Initialized data');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withData, options.includeAddressComments, (global, ls) => {
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        const arrayInfo = inferArrayDeclaration(global);
        const initializer = emitDataValue(global.initializedData!, 0);

        if (arrayInfo && global.initializedData!.kind === 'array') {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = ${initializer};`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${initializer};`);
        }
        ls.push('');
      });
    }

    // Initialized scalars without structured data
    if (withoutData.length > 0) {
      lines.push('// Initialized scalars');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, withoutData, options.includeAddressComments, (global, ls) => {
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;
        let value = normalizeDataValue(global.value ?? '0');

        // Struct types can't be initialized with = 0; use = {} instead
        if ((value === '0' || value === '0x0') && isStructType(type)) {
          value = '{}';
        }

        if (options.includeAddressComments) {
          ls.push(`// @${global.address}`);
        }

        value = castPointerInitializer(type, value);
        const arrayInfo = inferArrayDeclaration(global);
        if (arrayInfo) {
          ls.push(`${arrayInfo.type} ${name}[${arrayInfo.count}] = { ${value} };`);
        } else {
          ls.push(`${normalizeArrayDeclaration(type, name)} = ${value};`);
        }
      });
      lines.push('');
    }

    // Uninitialized (BSS)
    if (uninitialized.length > 0) {
      lines.push('// Uninitialized data (BSS)');
      lines.push('');

      emitGlobalDefsWithIfdef(lines, uninitialized, options.includeAddressComments, (global, ls) => {
        const type = global.suggestedType || global.dataType;
        const name = global.suggestedName || global.name;

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

    if (namespace) {
      lines.push(`} // namespace ${namespace}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Header file generation
 *
 * Generates .h files with class/struct definitions and function declarations
 */

import type {
  ExtractedFunction,
  ExtractedDataType,
  ExtractedGlobal,
  ExtractedStruct,
  ExtractedEnum,
  ExtractedTypedef,
  ExtractedUnion,
  ExtractedFunctionDefinition,
  DetectedClass,
  StructField,
  ReconstructOptions,
  AnalyzedDataSymbol,
} from '../types.js';
import type { MethodConversionRegistry } from '../methods/index.js';
import { parseTemplateName, collapseConsecutiveDuplicates } from './namespace.js';
import { namespaceResolution, renderNamespace } from './namespace-resolution.js';
import { isGhidraGeneratedName, suggestBetterName, type FuncPtrTarget } from '@ghidra-mcp/cpp-parser';
import { isPlatformOrBuiltinType, isLibraryType, normalizeSignatureType, normalizeWideCharType, collapseFuncPtrTypedef, rootQualifyShadowedType, emittedParameterName, WINDOWS_STRUCTS, platformDeclaredFunctionNames } from './platform-types.js';
import { generateExternDeclaration, isFuncDefTypedefName, sanitizeSymbolName } from './globals-header.js';
import { declarationHead, pointerConvention } from './calling-convention.js';

/** normalizeSignatureType + fn-ptr-typedef double-indirection collapse, for
 *  emitting function parameter and return types ("fpFoo *" → "fpFoo"). */
export function sigType(type: string): string {
  return rootQualifyShadowedType(
    collapseFuncPtrTypedef(normalizeSignatureType(type), isFuncDefTypedefName)
  );
}

/**
 * C++ keywords that Ghidra can auto-pick as a struct field / variable name
 * (`int default;`, `char class;`). Using one as an identifier is a syntax error;
 * such names are suffixed with `_`. Shared with impl.ts so body member accesses
 * get the same rename.
 *
 * Type keywords belong here too: Ghidra names the data-table structs after the
 * .txt column headers, and CharTemplate.txt has a column called `int`, so
 * D2CharTemplateTxt really does carry a field named `int`.
 */
export const CPP_KEYWORDS = new Set<string>([
  'default', 'class', 'new', 'delete', 'operator', 'template', 'namespace',
  'this', 'friend', 'public', 'private', 'protected', 'virtual', 'register',
  'export', 'goto', 'throw', 'try', 'catch', 'typename', 'typeid', 'switch',
  'case', 'return', 'while', 'for', 'do', 'if', 'else', 'break', 'continue',
  'and', 'or', 'not', 'xor', 'bitand', 'bitor', 'compl', 'typedef', 'sizeof',
  'int', 'char', 'float', 'double', 'short', 'long', 'bool', 'void',
  'signed', 'unsigned', 'auto', 'const', 'static', 'struct', 'union', 'enum',
  'inline', 'extern', 'volatile',
]);

/**
 * Clean a parameter name: apply the same renaming the body transform does
 */
function cleanParamName(name: string): string {
  if (name === 'this') return 'pThis';
  if (!isGhidraGeneratedName(name)) return name;
  return suggestBetterName(name) ?? name;
}

/**
 * Renumber param_N / param_N_NN names sequentially to fix Ghidra's
 * mixed calling convention duplicate naming (e.g., param_1 in ECX + param_1_00 on stack)
 */
function renumberParams(params: Array<{ name: string; dataType: string }>): Array<{ name: string; dataType: string }> {
  let counter = 1;
  return params.map(p => {
    let name = cleanParamName(p.name);
    if (/^param_\d+(_\d+)?$/.test(name)) {
      name = `param_${counter}`;
      counter++;
    }
    return { name, dataType: p.dataType };
  });
}

/**
 * Check if a name is a valid C++ namespace (not a template instantiation)
 */
function isValidNamespace(name: string): boolean {
  const templateInfo = parseTemplateName(name);
  // Template instantiations are not valid namespace names
  if (templateInfo.isTemplate) return false;
  // Also reject names with angle brackets
  if (name.includes('<') || name.includes('>')) return false;
  // Also reject names with commas (mangled template params)
  if (name.includes(',')) return false;
  // Reject switch table artifacts
  if (name.startsWith('switchD_') || name.includes('::switchD_')) return false;
  return true;
}


/**
 * Generate a header file
 */
export function generateHeader(
  name: string,
  functions: ExtractedFunction[],
  classInfo: DetectedClass | undefined,
  dataTypes: ExtractedDataType[],
  globals: (ExtractedGlobal | AnalyzedDataSymbol)[],
  options: ReconstructOptions,
  methodConversions?: MethodConversionRegistry | null,
  extraIncludes?: string[],
  ownedTypes?: Set<string>,
  publicFunctions?: Set<string>,
  classNames?: Set<string>,
  includedTypes?: Set<string>,
  headerPath?: string,
  funcIncludes?: string[],
  allFunctions?: ExtractedFunction[],
  allClasses?: DetectedClass[]
): string {
  const lines: string[] = [];

  // Build address→name map for resolving FUN_ references in comments
  const fnAddrMap = new Map<bigint, FuncPtrTarget>();
  for (const f of functions) {
    if (f.address && !f.name.startsWith('FUN_')) {
      try { fnAddrMap.set(BigInt(f.address), { name: f.name }); } catch { /* skip invalid */ }
    }
  }

  // Generated file banner
  lines.push('// Auto-generated by ghidra-mcp — DO NOT EDIT');
  lines.push('');

  // Include guard
  lines.push('#pragma once');
  lines.push('');

  // Standard includes
  lines.push('#include <cstdint>');
  lines.push('#include <cstddef>');
  lines.push('#include <cstdio>');
  lines.push('#include <cstdarg>');
  lines.push('#include "d2_platform.h"');

  // Type includes: needed for by-value struct fields (before type definitions)
  if (extraIncludes && extraIncludes.length > 0) {
    const seen = new Set<string>();
    for (const inc of [...extraIncludes].sort()) {
      const normalized = inc.replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(`#include "${normalized}"`);
    }
  }
  lines.push('');

  // Forward declarations — skip types already fully defined via #includes (includedTypes).
  // Don't skip ownedTypes: they might not be emitted due to filtering, and need forward decl.
  const alreadyDefined = new Set<string>([...(includedTypes ?? [])]);
  const funcDefReferencedTypes = new Set<string>();
  const forwardDecls = collectForwardDeclarations(functions, classInfo, dataTypes, classNames, alreadyDefined, ownedTypes, allClasses, allFunctions, funcDefReferencedTypes);
  if (forwardDecls.length > 0) {
    lines.push('// Forward declarations');
    // A function-pointer typedef names struct types in its signature, so every
    // plain forward declaration has to precede the typedef block that uses one.
    const isTypedefBlock = (d: string) => d.startsWith('#ifndef RECON_FPTD_');
    for (const decl of forwardDecls.filter(d => !isTypedefBlock(d))) {
      lines.push(decl);
    }
    // A struct this header DEFINES is defined BELOW the typedef block, so the
    // typedef still needs its own forward declaration of it.
    const ownedAhead: string[] = [];
    for (const name of funcDefReferencedTypes) {
      if (!ownedTypes?.has(name)) continue;
      const dt = dataTypes?.find(t => t.name === name);
      if (!dt) continue;
      if (dt.kind === 'STRUCTURE') ownedAhead.push(`struct ${name};`);
      else if (dt.kind === 'UNION') ownedAhead.push(`union ${name};`);
    }
    for (const decl of ownedAhead.sort()) lines.push(decl);
    for (const decl of forwardDecls.filter(isTypedefBlock)) {
      lines.push(decl);
    }
    lines.push('');
  }

  // Emit relevant data types BEFORE namespace (structs/enums stay at file scope)
  // ENUMs are emitted in a shared d2_enums.h file (included from d2_platform.h),
  // so skip them in individual headers to avoid double definitions.
  const declarableKinds = new Set(['STRUCTURE', 'TYPEDEF', 'UNION', 'FUNCTION_DEFINITION']);
  const relevantTypes = ownedTypes
    ? dataTypes.filter(t => declarableKinds.has(t.kind))
    : filterRelevantTypes(dataTypes, functions, classInfo);
  const typesToEmit = topologicalSortTypes(relevantTypes.filter(t => {
    // If ownership set provided, only emit types we own (or the class type)
    if (ownedTypes && !ownedTypes.has(t.name) && !(classInfo && t.name === classInfo.name)) return false;
    // Never emit platform/builtin typedefs (they come from <cstdint> or d2_platform.h)
    if (isPlatformOrBuiltinType(t.name)) return false;
    // Skip types with invalid C++ identifier characters (e.g. "BOOL.conflict" from Ghidra)
    if (/[^a-zA-Z0-9_]/.test(t.name)) return false;
    return true;
  }));
  // Track whether the class struct was emitted during topo-sort (for self-referential types)
  let classEmittedInTopoSort = false;
  // Emit intra-file forward declarations for types referenced by pointer before their definition
  if (typesToEmit.length > 1) {
    const emitOrder = new Map<string, number>();
    typesToEmit.forEach((t, i) => emitOrder.set(t.name, i));
    const intraForwardDecls = new Set<string>();
    for (const t of typesToEmit) {
      const fields: { dataType: string }[] = ('fields' in t && Array.isArray((t as any).fields))
        ? (t as any).fields : [];
      for (const field of fields) {
        if (!field.dataType.includes('*')) continue;
        const ref = extractBaseTypeName(field.dataType);
        if (ref && emitOrder.has(ref) && emitOrder.get(ref)! > emitOrder.get(t.name)!) {
          intraForwardDecls.add(`struct ${ref};`);
        }
      }
    }
    for (const decl of intraForwardDecls) {
      lines.push(decl);
    }
    if (intraForwardDecls.size > 0) lines.push('');
  }

  // Track emitted constexpr names to avoid duplicates across enum types
  const emittedConstexprNames = new Set<string>();

  // Emit a single type's full definition into `out` (handles class/struct/enum
  // special-casing). Returns true if the emitted type was the class struct.
  const emitTypeDefinition = (type: ExtractedDataType, out: string[]): boolean => {
    // If this is the class type, emit it as a class declaration (with methods)
    if (classInfo && type.name === classInfo.name) {
      if ((!classInfo.fields || classInfo.fields.length === 0) && 'fields' in type) {
        classInfo.fields = (type as ExtractedStruct).fields;
      }
      out.push(generateClassDeclaration(classInfo, functions, options, methodConversions, true, allFunctions));
      out.push('');
      return true;
    }
    // If this struct type matches a method-converted class (not already handled above),
    // emit it as a class declaration so that method declarations are included.
    // This handles the case where functions are namespaced to a different unit than
    // the struct they extend (e.g., Fog::BitBuffer functions → D2BitBufferStrc methods).
    if (type.kind === 'STRUCTURE' && allClasses && type.name !== classInfo?.name) {
      const matchingClass = allClasses.find(c => c.name === type.name && c.methods.length > 0);
      if (matchingClass) {
        if ((!matchingClass.fields || matchingClass.fields.length === 0) && 'fields' in type) {
          matchingClass.fields = (type as ExtractedStruct).fields;
        }
        out.push(generateClassDeclaration(matchingClass, functions, options, methodConversions, true, allFunctions));
        out.push('');
        return false;
      }
    }
    let decl = generateDataTypeDeclaration(type, options);
    // Deduplicate constexpr names across enum types
    if (type.kind === 'ENUM') {
      decl = decl.split('\n').filter(line => {
        const m = line.match(/^constexpr\s+\S+\s+(\w+)/);
        if (m) {
          if (emittedConstexprNames.has(m[1])) return false;
          emittedConstexprNames.add(m[1]);
        }
        return true;
      }).join('\n');
    }
    out.push(decl);
    out.push('');
    return false;
  };

  if (typesToEmit.length > 0) {
    lines.push('// Data types');
    // Partition into normal vs library types. Library types (CRT / Win32 / MSVC-EH
    // internals Ghidra pulled in from the statically-linked CRT) get their full
    // DEFINITIONS guarded behind #ifndef _WIN32, because the real SDK / CRT that
    // d2_platform.h includes provides them on Windows — re-emitting collides.
    // Topological ordering is preserved within each partition (stable filter of
    // the already-sorted list); forward declarations above stay unguarded.
    const normalTypes = typesToEmit.filter(t => !isLibraryType(t.name, t.category));
    const libraryTypes = typesToEmit.filter(t => isLibraryType(t.name, t.category));

    let currentIfdef: string | undefined;
    for (const type of normalTypes) {
      // Wrap platform-specific types in #ifdef guards
      if (type.ifdef !== currentIfdef) {
        if (currentIfdef) {
          lines.push(`#endif // ${currentIfdef}`);
          lines.push('');
        }
        if (type.ifdef) {
          lines.push(`#ifdef ${type.ifdef}`);
        }
        currentIfdef = type.ifdef;
      }
      if (emitTypeDefinition(type, lines)) classEmittedInTopoSort = true;
    }
    if (currentIfdef) {
      lines.push(`#endif // ${currentIfdef}`);
      lines.push('');
    }

    if (libraryTypes.length > 0) {
      lines.push('#ifndef _WIN32  // provided by the Win32 SDK / CRT on Windows');
      lines.push('');
      for (const type of libraryTypes) {
        if (emitTypeDefinition(type, lines)) classEmittedInTopoSort = true;
      }
      lines.push('#endif // _WIN32');
      lines.push('');
    }
  }

  // Co-located globals (struct-typed globals that belong with their struct definitions)
  if (headerPath) {
    const colocatedGlobals = (globals as AnalyzedDataSymbol[])
      .filter(g =>
        g.scope === 'struct-colocated' &&
        g.ownerStructHeader === headerPath
      );

    if (colocatedGlobals.length > 0) {
      lines.push('// =============================================================================');
      lines.push('// Global data (co-located with struct definitions)');
      lines.push('// =============================================================================');
      lines.push('');

      // These externs used to go out at ROOT scope while
      // `generateColocatedGlobalsImpl` wrapped the matching DEFINITIONS in the
      // symbol's namespace — so `D2Client::UI::Hireables::gpHireablesList` was
      // defined and `::gpHireablesList` was declared, and the reference sites,
      // which spell the namespace, resolved to neither. Both sides call
      // `colocatedGlobalNamespace` now.
      const colocatedByNamespace = new Map<string | undefined, AnalyzedDataSymbol[]>();
      for (const g of colocatedGlobals) {
        const ns = renderNamespace(namespaceResolution().of(g));
        const bucket = colocatedByNamespace.get(ns);
        if (bucket) bucket.push(g); else colocatedByNamespace.set(ns, [g]);
      }

      for (const [ns, nsGlobals] of colocatedByNamespace) {
        if (ns && /[<>,*]/.test(ns)) continue;
        if (ns) { lines.push(`namespace ${ns} {`); lines.push(''); }
        let currentIfdef: string | undefined;
        for (const global of nsGlobals) {
          if (global.ifdef !== currentIfdef) {
            if (currentIfdef) lines.push(`#endif // ${currentIfdef}`);
            if (global.ifdef) lines.push(`#ifdef ${global.ifdef}`);
            currentIfdef = global.ifdef;
          }
          {
            const decl = generateExternDeclaration(global, options.includeAddressComments);
            if (decl) lines.push(decl);
          }
        }
        if (currentIfdef) lines.push(`#endif // ${currentIfdef}`);
        if (ns) { lines.push(''); lines.push(`} // namespace ${ns}`); }
        lines.push('');
      }
    }
  }

  // For class-based headers, emit the class struct BEFORE funcIncludes (if not already
  // emitted during topo-sort above — which happens when other types depend on it).
  if (classInfo && !classEmittedInTopoSort) {
    if ((!classInfo.fields || classInfo.fields.length === 0) && dataTypes) {
      const matchingStruct = dataTypes.find(
        t => t.kind === 'STRUCTURE' && t.name === classInfo.name && 'fields' in t && (t as ExtractedStruct).fields?.length
      ) as ExtractedStruct | undefined;
      if (matchingStruct?.fields) {
        classInfo.fields = matchingStruct.fields;
      }
    }
    lines.push(generateClassDeclaration(classInfo, functions, options, methodConversions, true, allFunctions));
    lines.push('');
  }

  // Function includes: needed for called functions (after type definitions to break cycles)
  if (funcIncludes && funcIncludes.length > 0) {
    for (const inc of funcIncludes) {
      lines.push(`#include "${inc}"`);
    }
    lines.push('');
  }

  // Get namespace from first function or class
  const rawNamespace = classInfo?.namespace || functions[0]?.namespace;

  // CRITICAL FIX: Only wrap STANDALONE FUNCTIONS in namespaces, never structs/types
  // Structs (even with methods) should always be at global scope
  // Methods are scoped to struct name (StructName::Method), not namespace
  const standaloneFunctions = functions.filter(f => !f.parentClass);
  const hasStandaloneFunctions = standaloneFunctions && standaloneFunctions.length > 0;
  // Rendered from the resolution, so the declaration is in the namespace the
  // definition opens — by identity, not by two copies of the same rule.
  const namespaceOwner = (hasStandaloneFunctions && rawNamespace)
    ? (classInfo?.namespace ? { address: undefined, namespace: rawNamespace } : functions[0])
    : undefined;
  let namespace = namespaceOwner
    ? renderNamespace(namespaceResolution().of(namespaceOwner))
    : undefined;

  // Only emit namespace block if it's a valid C++ namespace (not a template instantiation)
  const useNamespace = namespace && options.organization === 'namespace' && isValidNamespace(namespace);

  // Open namespace
  if (useNamespace) {
    lines.push(`namespace ${namespace} {`);
    lines.push('');
  }

  // Emit standalone functions (class was already emitted above)
  if (!classInfo) {
    // Global/file-level function declarations.
    //
    // A function whose name ALSO names a data type used to be dropped here. That
    // was a real loss: Ghidra names ~53 functions after their own funcdef
    // (`Push`, `Release`, `fpDrawGroundTile`, the eleven `D2Win*` control
    // factories), and every other TU calling one got "is not a member of", or —
    // where the type is a struct — parsed the call as a functional cast and asked
    // for a constructor that does not exist. Declaring them is legal C++: the
    // typedef is at ROOT scope, the function is inside its namespace, and the
    // elaborated-`struct` post-pass below defends the signatures against the
    // struct/function shadow.
    //
    // It was tried once and measured at +25 errors, because the declaration lets
    // the compiler compare each function against the funcdef slot it is stored
    // in and they disagreed — the wrong-signature bug `disambiguateCategoryDuplicates`
    // repairs upstream. That fix is in the model now (`fpDrawGroundTile` and
    // `D2RendererFunctionsStrc_fpDrawGroundTile` are separate types), so the
    // declaration is emitted.

    // C/C++ standard library functions that must never be re-declared
    const C_STDLIB_NAMES = new Set([
      'memset', 'memcpy', 'memmove', 'memcmp', 'malloc', 'calloc', 'realloc', 'free',
      'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strchr',
      'strrchr', 'strstr', 'sprintf', 'snprintf', 'printf', 'fprintf', 'sscanf', 'fscanf',
      'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'ftell', 'fflush', 'fgets', 'fputs',
      'abs', 'atoi', 'atof', 'strtol', 'strtoul', 'rand', 'srand', 'qsort', 'bsearch',
      'exit', 'abort', 'atexit', 'getenv', 'system', 'time', 'clock', 'difftime',
      'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'exp', 'ceil', 'floor', 'fabs',
      'tolower', 'toupper', 'isalpha', 'isdigit', 'isalnum', 'isspace',
      'va_start', 'va_end', 'va_arg', 'va_copy',
    ]);

    const nonLibraryFunctions = functions.filter(f => !f.isLibrary && !f.isExternal
      // Skip functions with @ in names (Ghidra-generated like "Catch_All@006b4c42")
      && !f.name.includes('@')
      // Skip operator overloads as free functions — these are Ghidra thiscall artifacts
      && !f.name.startsWith('operator')
      // Skip destructor-like free functions (~TypeName)
      && !f.name.startsWith('~')
      // NOTE: a digit-leading name is no longer skipped. It is legalized by the
      // same rule the definition and every reference use (`emittedFunctionName`),
      // so `0x44PacketHandler` is declared as `_x44PacketHandler`. Skipping it
      // here left one symbol with three spellings and no declaration for any.
      && f.name.length > 0
      // Skip C standard library functions
      && !C_STDLIB_NAMES.has(f.name)
    );

    // When publicFunctions is provided, only declare externally-visible functions
    const declaredFunctions = publicFunctions
      ? nonLibraryFunctions.filter(f => publicFunctions.has(f.name))
      : nonLibraryFunctions;
    const internalCount = nonLibraryFunctions.length - declaredFunctions.length;

    if (declaredFunctions.length > 0) {
      lines.push('// Function declarations');
      let currentIfdef: string | undefined;
      const emittedFuncNames = new Set<string>();
      for (const func of declaredFunctions) {
        // Deduplicate by name + parameter signature, NOT name alone. Same-name
        // functions with DIFFERENT parameters are valid C++ overloads and must
        // all be declared — dropping them made callers bind to the one surviving
        // overload (e.g. 7 SpawnMonster overloads, STATLIST_GetItemStatBonusValues),
        // causing "cannot convert" errors. Same name AND same params (a return-type-
        // only difference, which C++ can't overload) still collapses to the first.
        const sigKey = func.name + '(' +
          (func.parameters ?? []).map(p => p.dataType).join(',') + ')';
        if (emittedFuncNames.has(sigKey)) continue;
        emittedFuncNames.add(sigKey);
        // Group consecutive functions with the same ifdef under one guard
        if (func.ifdef !== currentIfdef) {
          if (currentIfdef) {
            lines.push(`#endif // ${currentIfdef}`);
          }
          if (func.ifdef) {
            lines.push(`#ifdef ${func.ifdef}`);
          }
          currentIfdef = func.ifdef;
        }
        lines.push(generateFunctionDeclaration(func, options, fnAddrMap));
      }
      // Close any open ifdef
      if (currentIfdef) {
        lines.push(`#endif // ${currentIfdef}`);
      }
      if (internalCount > 0) {
        lines.push(`// ${internalCount} internal function${internalCount > 1 ? 's' : ''} (defined in .cpp)`);
      }
      lines.push('');
    } else if (internalCount > 0) {
      lines.push(`// ${internalCount} internal function${internalCount > 1 ? 's' : ''} (defined in .cpp)`);
      lines.push('');
    }
  }

  // Post-process: qualify struct types with 'struct' tag in function signatures.
  // This prevents shadowing issues where a function name matches a struct type name
  // (e.g., constructor "D2WinTextBox()" shadows "struct D2WinTextBox"), both within
  // this file and from included headers.
  {
    // Collect all struct type names from forward declarations we emitted
    const forwardDeclaredStructs = new Set<string>();
    for (const decl of forwardDecls) {
      const m = decl.match(/^struct (\w+);$/);
      if (m) forwardDeclaredStructs.add(m[1]);
    }
    // Also include struct types from data types (for types defined in this file)
    if (dataTypes) {
      for (const dt of dataTypes) {
        if (dt.kind === 'STRUCTURE') forwardDeclaredStructs.add(dt.name);
      }
    }
    // Always qualify forward-declared structs with 'struct' keyword in function signatures.
    // This prevents shadowing from namespace names that match struct names.
    // Note: lines[] entries can be multi-line (comment block + signature), so we must
    // process individual lines within each entry.
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('*')) continue;
      const sublines = lines[i].split('\n');
      for (let j = 0; j < sublines.length; j++) {
        const sl = sublines[j];
        if (!sl.includes('*')) continue;
        if (sl.startsWith('//')) continue;
        if (sl.startsWith('struct ') || sl.startsWith('class ') || sl.startsWith('union ')) continue;
        sublines[j] = sl.replace(/(\W)([A-Z_]\w+)(\s*\*)/g, (full, pre, name, post) => {
          if (pre === '.' || pre === '>') return full;
          // Already root-qualified by sigType (`::QServer *`) — the shadow the
          // `struct` keyword defends against is gone, and inserting it here
          // would produce `::struct QServer *`.
          if (pre === ':') return full;
          if (forwardDeclaredStructs.has(name) && !full.startsWith('struct ')) {
            return `${pre}struct ${name}${post}`;
          }
          return full;
        });
        sublines[j] = sublines[j].replace(/^([A-Z_]\w+)(\s*\*)/, (full, name, post) => {
          if (forwardDeclaredStructs.has(name)) {
            return `struct ${name}${post}`;
          }
          return full;
        });
      }
      lines[i] = sublines.join('\n');
    }
  }

  // Close namespace
  if (useNamespace) {
    lines.push(`} // namespace ${namespace}`);
  }

  return lines.join('\n');
}

/**
 * Generate a class declaration
 */
export function generateClassDeclaration(
  classInfo: DetectedClass,
  functions: ExtractedFunction[],
  options: ReconstructOptions,
  methodConversions?: MethodConversionRegistry | null,
  isStruct?: boolean,
  allFunctions?: ExtractedFunction[]
): string {
  const lines: string[] = [];

  // Base class
  let baseClause = '';
  if (classInfo.baseClasses.length > 0) {
    baseClause = ` : public ${classInfo.baseClasses.join(', public ')}`;
  }

  const keyword = isStruct ? 'struct' : 'class';
  lines.push(`${keyword} ${classInfo.name}${baseClause} {`);

  // Helper: get thisParamIndex for a method conversion (default 0 for instance methods)
  const getThisParamIndex = (address: string, isStatic: boolean): number | undefined => {
    const conversion = methodConversions?.get(address);
    if (conversion) return conversion.thisParam ?? 0;
    // Auto-detected instance methods: this-pointer is always param 0
    return isStatic ? undefined : 0;
  };

  // Collect all methods (no visibility sections — these are reconstructed structs)
  const allMethods = classInfo.methods;

  // Methods section
  if (allMethods.length > 0 || classInfo.constructorAddress) {
    // Constructor/destructor first
    const ctor = allMethods.find(m => m.isConstructor);
    const dtor = allMethods.find(m => m.isDestructor);

    if (ctor) {
      const func = functions.find(f => f.address === ctor.address)
        ?? allFunctions?.find(f => f.address === ctor.address);
      if (func) {
        lines.push(`    ${generateConstructorDeclaration(classInfo.name, func, getThisParamIndex(ctor.address, false))};`);
      }
    }

    if (dtor) {
      const isVirtual = dtor.isVirtual ? 'virtual ' : '';
      lines.push(`    ${isVirtual}~${classInfo.name}();`);
    }

    // All other methods — filter invalid names and deduplicate
    const emittedMethodNames = new Set<string>();
    for (const method of allMethods) {
      if (method.isConstructor || method.isDestructor) continue;

      const func = functions.find(f => f.address === method.address)
        ?? allFunctions?.find(f => f.address === method.address);
      if (!func) continue;
      // Skip methods with invalid C++ identifier names
      if (/[^a-zA-Z0-9_]/.test(func.name) || /^\d/.test(func.name)) continue;
      // Skip duplicate method declarations (same name)
      if (emittedMethodNames.has(func.name)) continue;
      emittedMethodNames.add(func.name);

      const virtual = method.isVirtual ? 'virtual ' : '';
      const staticKw = method.isStatic ? 'static ' : '';
      lines.push(`    ${staticKw}${virtual}${generateMethodDeclaration(func, classInfo.name, getThisParamIndex(method.address, method.isStatic))};`);
    }

    lines.push('');
  }

  // Add implicit integer conversion operators for small integer-only structs.
  // Ghidra's decompiler freely casts between small structs (e.g. D2SeedStrc) and
  // their integer equivalent (uint64_t). C++ requires explicit conversion operators.
  const intConversionType = getIntegerConversionType(classInfo.fields);
  if (intConversionType) {
    lines.push(`    ${classInfo.name}() = default;`);
    lines.push(`    ${classInfo.name}(${intConversionType} v) { *reinterpret_cast<${intConversionType}*>(this) = v; }`);
    lines.push(`    operator ${intConversionType}() const { return *reinterpret_cast<const ${intConversionType}*>(this); }`);
    lines.push('');
  }

  // Fields
  emitFieldLines(classInfo.fields, lines);

  lines.push('};');

  return lines.join('\n');
}

/**
 * Check if a struct's fields are all integer types and the total size matches
 * a standard integer type. Returns the integer type name or null.
 * This enables Ghidra's decompiler pattern of casting between small structs and integers.
 */
function getIntegerConversionType(fields: StructField[]): string | null {
  if (!fields || fields.length === 0) return null;
  const integerTypes = new Set([
    'int', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'char', 'short', 'long', 'unsigned int', 'unsigned short', 'unsigned char',
    'byte', 'BYTE', 'WORD', 'DWORD', 'BOOL',
  ]);
  // Only consider non-padding real fields
  const realFields = fields.filter(f => f.name && !f.name.startsWith('_pad_'));
  if (realFields.length === 0) return null;
  // All real fields must be integer types
  for (const f of realFields) {
    if (!integerTypes.has(f.dataType.trim())) return null;
  }
  // Calculate total struct size from last field
  const lastField = fields[fields.length - 1];
  const totalSize = lastField.offset + lastField.size;
  const sizeToType: Record<number, string> = { 1: 'uint8_t', 2: 'uint16_t', 4: 'uint32_t', 8: 'uint64_t' };
  return sizeToType[totalSize] ?? null;
}

/** Flatten literal \n in an inline comment to spaces */
function cleanInlineComment(comment: string): string {
  return comment.replace(/\\n/g, ' ');
}

/**
 * Strip Ghidra metadata lines from a function comment.
 * Removes register annotations, custom-register warnings, plate comment metadata, and URLs.
 */
export function cleanFunctionComment(
  comment: string,
  functionAddressMap?: Map<bigint, FuncPtrTarget>,
): string {
  // Convert literal \n sequences to actual newlines
  const rawLines = comment.replace(/\\n/g, '\n').split('\n');
  // Ghidra's batch_rename rewrites plate comments into an @function/@address/@date/
  // @calling/@description template and buries the original text inside @description.
  // That text is the source-file attribution, so unwrap it rather than dropping it
  // with the tag.
  const lines = rawLines.map(line => {
    const described = line.match(/^\s*@description\s+(.*)$/i);
    return described ? described[1] : line;
  });
  const cleaned = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Register annotations: [type param@REG:size]
    if (/^\[.*@.*:\d+\]$/.test(trimmed)) return false;
    // Custom register warning
    if (trimmed === 'Function uses custom registers for function arguments!') return false;
    // Plate comment metadata tags (case-insensitive, with or without colon)
    // (@description is unwrapped above, so a bare tag with no payload falls through here.)
    // @calling is redundant — the emitted signature already carries the convention.
    if (/^@(date|author|function|address|description|params|calling)\b/i.test(trimmed)) return false;
    // Param lines inside @params block (e.g. "  param_1: ECX:4 (int32_t)")
    if (/^\s*param_\d+\s*:/.test(trimmed)) return false;
    // Bare URLs
    if (/^https?:\/\//.test(trimmed)) return false;
    // Standalone FUN_ metadata lines: "Function: FUN_XXXXXXXX" or "Called from FUN_XXXXXXXX"
    if (/^(Function|Called from)\s*:?\s*FUN_[0-9a-fA-F]+$/i.test(trimmed)) return false;
    return true;
  });

  // Evidence lines quote debug strings verbatim, and those strings often embed a
  // newline — which would otherwise split the quote across two comment lines
  // mid-sentence. Fold continuations back into the `name:`/`name?:` line they belong to.
  const folded: string[] = [];
  for (const line of cleaned) {
    const isTagged = /^\s*(src\??:|name\??:|logged locals:)/.test(line);
    const prev = folded[folded.length - 1];
    if (!isTagged && prev !== undefined && /^\s*name\??:/.test(prev)) {
      folded[folded.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    } else {
      folded.push(line);
    }
  }

  let result = folded.join('\n');

  // Resolve inline FUN_ references to their actual names
  if (functionAddressMap && result.includes('FUN_')) {
    result = result.replace(/FUN_([0-9a-fA-F]{6,8})/g, (_match, hex: string) => {
      const addr = BigInt('0x' + hex);
      const target = functionAddressMap.get(addr);
      return target?.name ?? _match;
    });
  }

  return result;
}

/**
 * Generate a function declaration
 */
/**
 * The identifier a function is DEFINED and DECLARED under.
 *
 * Ghidra's name is not always a legal C++ identifier, and the reference side has
 * its own legalizer (`sanitizeSymbolName`), so both must apply the SAME rule or a
 * call names something that exists nowhere. `0x44PacketHandler` was the proof:
 * the definition kept it verbatim — `uint32_t 0x44PacketHandler(...)`, not C++ at
 * all — while every reference to it said `_x44PacketHandler`, one symbol under
 * three spellings.
 *
 * A trailing `()` is a Ghidra artifact and comes off first; a name that equals its
 * own return type is a constructor and becomes `Create_<name>`, so the declaration
 * cannot be read as one.
 */
export function emittedFunctionName(func: ExtractedFunction, returnType: string): string {
  const cleanName = sanitizeSymbolName(func.name.replace(/[()]+$/, ''));
  if (returnType.startsWith(cleanName + ' ') || returnType === cleanName) {
    return `Create_${cleanName}`;
  }
  return cleanName;
}

export function generateFunctionDeclaration(
  func: ExtractedFunction,
  options: ReconstructOptions,
  functionAddressMap?: Map<bigint, FuncPtrTarget>,
): string {
  let commentBlock = '';
  if (func.comment) {
    const cleaned = cleanFunctionComment(func.comment, functionAddressMap);
    if (cleaned) {
      commentBlock = cleaned.split('\n').map(l => `// ${l}`).join('\n') + '\n';
    }
  }
  let params = renumberParams(func.parameters)
    .map(p => {
      const type = sigType(p.dataType);
      // Avoid param name shadowing its own type (e.g., "eD2ItemFlag eD2ItemFlag")
      return `${type} ${emittedParameterName(p.name, type)}`;
    })
    .join(', ');
  if (func.hasVarArgs) params = params ? `${params}, ...` : '...';

  const stripAddr = (a: string) => a.includes(':') ? a.slice(a.lastIndexOf(':') + 1) : a;
  let addressComment = '';
  if (func.crossPlatformAddress) {
    const xplat = func.crossPlatformAddress;
    if (func.platform) {
      addressComment = ` // 1.14d ${func.platform}: ${stripAddr(func.address)}`;
    } else {
      addressComment = ` // 1.14d win: ${stripAddr(func.address)} | ${xplat.platform}: ${stripAddr(xplat.address)}`;
    }
  } else if (func.platform) {
    addressComment = ` // 1.14d ${func.platform}: ${stripAddr(func.address)}`;
  } else {
    addressComment = ` // 1.14d: ${stripAddr(func.address)}`;
  }

  const cleanName = emittedFunctionName(func, sigType(func.returnType));

  return `${commentBlock}${declarationHead(sigType(func.returnType), func.callingConvention)}${cleanName}(${params});${addressComment}`;
}

/**
 * Generate a method declaration (without class prefix)
 *
 * @param thisParamIndex - If set, skip param at this index (for method conversions
 *   where the this-param has a real name like "pDrlg" instead of "this")
 */
function generateMethodDeclaration(
  func: ExtractedFunction,
  className: string,
  thisParamIndex?: number
): string {
  // Filter out 'this' parameter for methods
  const filtered = func.parameters
    .filter((p, i) => p.name === 'this' || i === thisParamIndex ? false : true);
  const params = renumberParams(filtered)
    .map(p => `${sigType(p.dataType)} ${p.name}`)
    .join(', ');

  return `${sigType(func.returnType)} ${func.name}(${params})`;
}

/**
 * Generate constructor declaration
 */
function generateConstructorDeclaration(
  className: string,
  func: ExtractedFunction,
  thisParamIndex?: number
): string {
  const filtered = func.parameters
    .filter((p, i) => p.name === 'this' || i === thisParamIndex ? false : true);
  const params = renumberParams(filtered)
    .map(p => `${sigType(p.dataType)} ${p.name}`)
    .join(', ');

  return `${className}(${params})`;
}

/**
 * Generate data type declaration
 */
function generateDataTypeDeclaration(
  type: ExtractedDataType,
  options: ReconstructOptions
): string {
  if (type.kind === 'STRUCTURE') {
    return generateStructDeclaration(type as ExtractedStruct);
  } else if (type.kind === 'ENUM') {
    return generateEnumDeclaration(type as ExtractedEnum);
  } else if (type.kind === 'TYPEDEF') {
    return generateTypedefDeclaration(type as ExtractedTypedef);
  } else if (type.kind === 'UNION') {
    return generateUnionDeclaration(type as ExtractedUnion);
  } else if (type.kind === 'FUNCTION_DEFINITION') {
    return generateFunctionDefinitionDeclaration(type as ExtractedFunctionDefinition);
  }
  return `// Unknown type: ${type.name}`;
}

/**
 * Emit struct/class/union field lines with offset comments and padding collapse.
 *
 * - Adds `/* 0xNN *​/` offset prefix to each field
 * - Collapses consecutive unnamed `undefined` (1-byte) fields into `uint8_t _pad_0xNN[count]`
 *   (genuine decompiler filler that bodies never reference)
 * - Gives other unnamed members Ghidra's decompiler default name so body
 *   references resolve: `field<i>` for unions, `field<i>_0x<off>` for structs
 */
/**
 * Longest run of unnamed `undefined` filler bytes that gets one named member per
 * byte. Above this the run stays a collapsed `_pad_` array: the handful of runs
 * that big in Diablo II are multi-kilobyte unanalysed tails (up to 59999 bytes),
 * and expanding them would add ~85k member declarations to headers that hundreds
 * of translation units include. Every filler offset any reconstructed body
 * actually reaches lies well inside this limit.
 */
const MAX_NAMED_FILLER_BYTES = 4096;

function emitFieldLines(
  fields: StructField[],
  lines: string[],
  isUnion = false,
  emitted?: Set<string>,
): void {
  // Determine hex width from the largest offset (minimum 2 digits)
  const maxOffset = fields.length > 0 ? Math.max(...fields.map(f => f.offset)) : 0;
  const hexWidth = Math.max(2, maxOffset.toString(16).length);

  // Track seen field names to deduplicate (Ghidra sometimes has duplicate names at different offsets)
  const seenNames = new Set<string>();

  // Count how many fields use each base type name. A field whose name equals its
  // own type only shadows that type for SUBSEQUENT same-typed fields, so a
  // single-use field can keep its name — which matters because the decompiled
  // body accesses it by that name. Renaming a single-use field (n-prefix) without
  // rewriting bodies produced "has no member named 'eD2LevelId'".
  const typeUseCount = new Map<string, number>();
  for (const f of fields) {
    const bt = extractBaseTypeName(normalizeUndefinedType(f.dataType, f.size));
    if (bt) typeUseCount.set(bt, (typeUseCount.get(bt) ?? 0) + 1);
  }

  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    const offsetHex = `0x${field.offset.toString(16).toUpperCase().padStart(hexWidth, '0')}`;

    // Detect bitfield groups: consecutive fields with "type:N" syntax at overlapping offsets.
    // Emit as union { rawInt; struct { bitfields }; } so both mask-based and named access compile.
    if (isBitfield(field)) {
      const groupStart = i;
      const baseOffset = field.offset;
      while (i < fields.length && isBitfield(fields[i]) && fields[i].offset < baseOffset + 4) {
        i++;
      }
      const groupEnd = i;
      const bitfieldCount = groupEnd - groupStart;

      if (bitfieldCount >= 2) {
        // Emit anonymous struct with bitfields (no union wrapper needed —
        // the bitfield-access transform plugin handles mask-to-name mapping in .cpp)
        lines.push(`    /* ${offsetHex} */ struct {`);
        for (let j = groupStart; j < groupEnd; j++) {
          const bf = fields[j];
          const bfOffsetHex = `0x${bf.offset.toString(16).toUpperCase().padStart(hexWidth, '0')}`;
          const bfComment = bf.comment ? ` // ${cleanInlineComment(bf.comment)}` : '';
          const bfName = (bf.name ?? '').replace(/[^a-zA-Z0-9_]/g, '_') || `_bf_${bfOffsetHex}_${j}`;
          const bfDecl = normalizeFieldDeclaration(
            normalizeUndefinedType(bf.dataType, bf.size), bfName, bf.size);
          emitted?.add(bfName);
          lines.push(`        /* ${bfOffsetHex} */ ${bfDecl};${bfComment}`);
        }
        lines.push(`    };`);
        continue;
      }
      // Single bitfield — fall through to normal emission
      i = groupStart;
    }

    // Collapse consecutive unnamed single-byte `undefined` fields into a padding array
    if (isUnnamedUndefined1(field)) {
      let count = 1;
      while (i + count < fields.length && isUnnamedUndefined1(fields[i + count])) {
        count++;
      }
      if (count === 1) {
        // A LONE undefined byte is still undefined space, and the decompiler names
        // a read of it `field_0x<off>` exactly as it does inside a longer run —
        // the component's ordinal never appears. Emitting the ordinal-bearing
        // `field<i>_0x<off>` here gave the one member Ghidra's own body text never
        // spells ("has no member named 'field_0x44'"). Same offset, same byte.
        const loneName = `field_0x${field.offset.toString(16)}`;
        if (!seenNames.has(loneName)) {
          seenNames.add(loneName);
          const loneComment = field.comment ? ` // ${cleanInlineComment(field.comment)}` : '';
          emitted?.add(loneName);
          lines.push(`    /* ${offsetHex} */ uint8_t ${loneName};${loneComment}`);
          i += 1;
          continue;
        }
      }
      if (count > 1) {
        // Ghidra's decompiler names an access into undefined filler
        // `field_0x<unpadded-lowercase-hex>` at the offset it touches — so a body
        // that reaches into the middle of a run needs a member AT that offset, not
        // just at the run's start. A lumped `uint8_t _pad[N]` gives no name at any
        // offset ("struct D2WinScrollbar has no member named 'field_0x48'"), so
        // name every byte of the run instead.
        //
        // Layout is untouched: N consecutive `uint8_t` members occupy the same N
        // bytes at the same offsets, with the same alignment, as `uint8_t[N]`.
        if (count <= MAX_NAMED_FILLER_BYTES) {
          for (let k = 0; k < count; k++) {
            const byteOffset = field.offset + k;
            const byteOffsetHex = `0x${byteOffset.toString(16).toUpperCase().padStart(hexWidth, '0')}`;
            let byteName = `field_0x${byteOffset.toString(16)}`;
            // A real member of that exact name elsewhere in the struct wins; this
            // byte still has to occupy its slot, so fall back to a unique pad name.
            if (seenNames.has(byteName)) byteName = `_pad_${byteOffsetHex}`;
            seenNames.add(byteName);
            emitted?.add(byteName);
            lines.push(`    /* ${byteOffsetHex} */ uint8_t ${byteName};`);
          }
          i += count;
          continue;
        }
        // Runs past the limit stay collapsed — naming every byte of a multi-kilobyte
        // unanalysed tail would add more declarations than the rest of the header
        // holds, and nothing in the tree reaches that far into one. The run's first
        // byte still gets its Ghidra name, which is the offset bodies actually read.
        const ghName = `field_0x${field.offset.toString(16)}`;
        if (!seenNames.has(ghName)) {
          seenNames.add(ghName);
          emitted?.add(ghName);
          lines.push(`    /* ${offsetHex} */ uint8_t ${ghName};`);
          const restOffsetHex = `0x${(field.offset + 1).toString(16).toUpperCase().padStart(hexWidth, '0')}`;
          emitted?.add(`_pad_${restOffsetHex}`);
          lines.push(`    /* ${restOffsetHex} */ uint8_t _pad_${restOffsetHex}[${count - 1}];`);
          i += count;
          continue;
        }
        emitted?.add(`_pad_${offsetHex}`);
        lines.push(`    /* ${offsetHex} */ uint8_t _pad_${offsetHex}[${count}];`);
        i += count;
        continue;
      }
    }

    const comment = field.comment ? ` // ${cleanInlineComment(field.comment)}` : '';

    // Extract array suffix from field name before sanitizing: "entry[6]" → "entry", "[6]"
    let rawFieldName = field.name ?? '';
    let fieldNameArraySuffix = '';
    const fieldNameArrayMatch = rawFieldName.match(/^(.+?)(\[\d+\](?:\[\d+\])*)$/);
    if (fieldNameArrayMatch) {
      rawFieldName = fieldNameArrayMatch[1];
      fieldNameArraySuffix = fieldNameArrayMatch[2];
    }
    // Fallback name for an unnamed member must MATCH Ghidra's decompiler
    // auto-name, because function bodies reference these members by that name:
    //   - union member at ordinal i      → `field<i>`        (e.g. field0, field1)
    //   - struct member at ordinal i/off → `field<i>_0x<off>` (e.g. field2_0x1f44)
    // Ghidra uses lowercase, unpadded hex (Integer.toHexString) for the offset.
    const ghidraDefaultName = isUnion
      ? `field${i}`
      : `field${i}_0x${field.offset.toString(16)}`;
    // Sanitize field names: replace spaces/invalid chars with underscores
    let rawName = rawFieldName ? rawFieldName.replace(/[^a-zA-Z0-9_]/g, '_') : ghidraDefaultName;
    if (!rawName) rawName = ghidraDefaultName;
    // A leading digit is not a valid identifier start, and Ghidra's decompiler
    // repairs it the same way it repairs every other illegal character in a field
    // name: by REPLACING that character with `_`. `D2UIFlagStrc` really does have
    // members named `0x1D`/`0x1E`/`0x20`, and bodies spell them `_x1D`/`_x1E`/
    // `_x20` (just as `Day Event` is spelled `Day_Event`). Prefixing instead —
    // `field_0x1D` — declared a member under a name no body ever uses.
    if (/^[0-9]/.test(rawName)) rawName = `_${rawName.slice(1)}`;
    // A field auto-named after a C++ keyword (Ghidra: `char class;`, `int default;`)
    // is a syntax error. Append `_`; body accesses are rewritten to match (impl.ts).
    if (CPP_KEYWORDS.has(rawName)) rawName = `${rawName}_`;
    const type = normalizeUndefinedType(field.dataType, field.size);
    // If field name exactly matches its type name, prefix to avoid C++ name hiding
    // (a field shadows the type within the struct, breaking subsequent fields of the same type)
    const baseTypeName = extractBaseTypeName(type);
    if (baseTypeName && rawName === baseTypeName && (typeUseCount.get(baseTypeName) ?? 0) >= 2) {
      rawName = `n${rawName}`;
    }
    // Deduplicate field names (Ghidra can have same name at different offsets)
    if (seenNames.has(rawName)) {
      rawName = `${rawName}_${offsetHex.slice(2)}`;
    }
    seenNames.add(rawName);
    emitted?.add(rawName);
    // Reconstruct name with array suffix for normalizeFieldDeclaration
    const name = rawName + fieldNameArraySuffix;

    // A field typed `<FuncDef> *` (pointer to a Ghidra function-signature type)
    // must be emitted as an INLINE function pointer: the bare FuncDef name has no
    // standalone C definition, so normalizeFieldDeclaration falls back to `void*`
    // and the field becomes uncallable ("expression cannot be used as a function").
    const fdMatch = !fieldNameArraySuffix && type.trim().match(/^(\w+)\s*\*(?:32|64)?$/);
    const fd = fdMatch ? knownFuncDefs.get(fdMatch[1]) : undefined;
    if (fd) {
      const fdParams = fd.parameters.map(p => sigType(p.dataType)).join(', ');
      const fdVarArgs = fd.hasVarArgs ? (fdParams ? ', ...' : '...') : '';
      lines.push(`    /* ${offsetHex} */ ${normalizeSignatureType(fd.returnType)} (${pointerConvention(fd.callingConvention)}*${name})(${fdParams}${fdVarArgs});${comment}`);
      i++;
      continue;
    }

    const decl = normalizeFieldDeclaration(type, name, field.size);

    lines.push(`    /* ${offsetHex} */ ${decl};${comment}`);
    i++;
  }
}

/** Check if a field is an unnamed single-byte undefined */
function isUnnamedUndefined1(field: StructField): boolean {
  const t = (field.dataType ?? '').trim();
  return !field.name && (t === 'undefined' || t === 'undefined1') && field.size <= 1;
}

/** Check if a field is a bitfield (type contains ":N" suffix, e.g. "int:1") */
function isBitfield(field: StructField): boolean {
  return /:\d+$/.test((field.dataType ?? '').trim());
}

/**
 * Map Ghidra `undefined` types to C types. Odd sizes become uint8_t[N].
 * Also unifies D2's wide-character spellings on `uint16_t` so struct fields
 * agree with the `uint16_t` that decompiled bodies produce.
 */
function normalizeUndefinedType(dataType: string, size: number): string {
  const t = normalizeWideCharType((dataType ?? '').trim());

  // Handle pointer variants: "undefined4 *" → "uint32_t *"
  const ptrMatch = t.match(/^(undefined\d?)\s*([\s*]+)$/);
  if (ptrMatch) {
    const base = normalizeUndefinedType(ptrMatch[1], 0);
    const stars = ptrMatch[2].replace(/\s+/g, '').trim();
    return `${base} ${stars}`;
  }

  // Replace Ghidra artifact pointer types: "vtable *" → "void *"
  const artifactPtrMatch = t.match(/^(vtable)\s*([\s*]+)$/);
  if (artifactPtrMatch) {
    const stars = artifactPtrMatch[2].replace(/\s+/g, '').trim();
    return `void ${stars}`;
  }

  switch (t) {
    case 'undefined':
    case 'undefined1': return 'uint8_t';
    case 'undefined2': return 'uint16_t';
    case 'undefined4': return 'uint32_t';
    case 'undefined8': return 'uint64_t';
    // Odd sizes → byte array
    case 'undefined3': return 'uint8_t[3]';
    case 'undefined5': return 'uint8_t[5]';
    case 'undefined6': return 'uint8_t[6]';
    case 'undefined7': return 'uint8_t[7]';
    // Ghidra artifact types
    case 'vtable': return 'void';
    case 'pointer': return 'void*';
    default:
      // Ghidra anonymous struct/union: _struct_1234 → uint8_t[size], _union_1234 → uint8_t[size]
      if (/^_(struct|union)_\d+$/.test(t) && size > 0) {
        return size === 1 ? 'uint8_t' : size === 2 ? 'uint16_t' : size === 4 ? 'uint32_t' : `uint8_t[${size}]`;
      }
      return t;
  }
}

/**
 * Normalize a struct field declaration:
 * - Map Ghidra string types (string, TerminatedCString, string-utf8) to char[size]
 * - Fix array syntax: "byte[3] name" → "byte name[3]"
 */
function normalizeFieldDeclaration(fieldType: string, fieldName: string, fieldSize: number): string {
  let type = (fieldType ?? '').trim();
  let name = fieldName ?? '';
  let arraySuffix = '';

  // Fix bitfield syntax: "int:1" -> type="int", emit "int name : 1"
  const bitfieldMatch = type.match(/^(.+?):(\d+)$/);
  if (bitfieldMatch) {
    return `${bitfieldMatch[1]} ${name} : ${bitfieldMatch[2]}`;
  }

  // Strip Ghidra pointer size annotations: "Type *32" → "Type *"
  type = type.replace(/\*(\d+)(?!\])/g, '*');

  // Fix function pointer typedef double-indirection: "fnFoo *" → "fnFoo"
  // Ghidra stores function pointer fields as "fnFoo *" but fnFoo is already a pointer typedef
  const funcPtrMatch = type.match(/^(\w+)\s*\*$/);
  if (funcPtrMatch && isFuncDefTypedefName(funcPtrMatch[1])) {
    type = funcPtrMatch[1];
  }

  // Fix pointer-to-array field types: "Type *[N]" → "Type *" + move [N] to array suffix
  const ptrArrayMatch = type.match(/^(.+\*)\[(\d+)\](.*)$/);
  if (ptrArrayMatch) {
    type = ptrArrayMatch[1] + ptrArrayMatch[3];
    arraySuffix = `[${ptrArrayMatch[2]}]${arraySuffix}`;
    // Re-apply the fnptr-typedef strip: an array of fnptr-typedef pointers
    // ("QUESTCALLBACK *[15]") reduces to "QUESTCALLBACK *" here, but the typedef
    // already encodes the pointer, so collapse to "QUESTCALLBACK" (→ QUESTCALLBACK
    // NAME[15], whose elements accept &func). The scalar strip above ran before
    // this split and so missed the array form.
    const arrFnPtr = type.match(/^(\w+)\s*\*$/);
    if (arrFnPtr && isFuncDefTypedefName(arrFnPtr[1])) {
      type = arrFnPtr[1];
    }
  }

  // Fix array-pointer field types: "Type[N] *" → "Type *" (Ghidra artifact, array decays to pointer)
  const arrayPtrMatch = type.match(/^(.+?)\[\d+\]\s*(\*+.*)$/);
  if (arrayPtrMatch) {
    type = `${arrayPtrMatch[1]} ${arrayPtrMatch[2]}`;
  }

  // Extract array suffix from field name: "File[32]" → name="File", nameSuffix="[32]"
  const nameArrayMatch = name.match(/^(.+?)\[(\d+)\]$/);
  let nameSuffix = '';
  if (nameArrayMatch) {
    name = nameArrayMatch[1];
    nameSuffix = `[${nameArrayMatch[2]}]`;
  }

  // Map Ghidra string types → char with array suffix
  // Handles: "string {60} [32]" → char[32][60], "string {60}" → char[60],
  //          "string *" → char *, "string" → char[fieldSize]
  const stringWithSizeAndArrayMatch = type.match(/^string\s*\{(\d+)\}\s*\[(\d+)\]$/);
  const stringWithSizeMatch = type.match(/^string\s*\{(\d+)\}$/);
  if (stringWithSizeAndArrayMatch) {
    type = 'char';
    arraySuffix = `[${stringWithSizeAndArrayMatch[2]}][${stringWithSizeAndArrayMatch[1]}]`;
  } else if (stringWithSizeMatch) {
    type = 'char';
    arraySuffix = `[${stringWithSizeMatch[1]}]`;
  } else if (type === 'string *') {
    type = 'char *';
  } else if (type === 'string' || type === 'TerminatedCString' || type === 'string-utf8') {
    type = 'char';
    if (fieldSize > 0) {
      arraySuffix = `[${fieldSize}]`;
    }
  }

  // Fix array syntax in type: "byte[3]" → base="byte", suffix="[3]"
  // Also handles multi-dimensional: "Entry[3][6]" → base="Entry", suffix="[3][6]"
  const arrayMatch = type.match(/^(.+?)((?:\[\d+\])+)$/);
  if (arrayMatch) {
    type = arrayMatch[1];
    arraySuffix = `${arrayMatch[2]}${arraySuffix}`;
  }

  return `${type} ${name}${nameSuffix}${arraySuffix}`;
}

/**
 * The type spelling a struct field is EMITTED with, or null when the field is
 * not a cast target at all (a bitfield, or an array).
 *
 * `sigType` is NOT that spelling and using it is a real defect, not a nicety:
 * Ghidra's `string *` is emitted `char *`, and a `fnFoo *` field is emitted
 * `fnFoo`. A cast written from the wrong spelling names a type the struct does
 * not have - `(string*)` fails to parse and takes the rest of the file with it.
 */
export function emittedFieldType(dataType: string, size: number): string | null {
  const raw = normalizeUndefinedType(dataType ?? '', size);
  if (/^.+?:\d+$/.test(raw.trim())) return null; // bitfield
  const SENTINEL = 'RECON_FIELD_NAME';
  const decl = normalizeFieldDeclaration(raw, SENTINEL, size);
  const idx = decl.indexOf(SENTINEL);
  if (idx < 0) return null;
  if (decl.slice(idx + SENTINEL.length).trim() !== '') return null; // array suffix
  const type = decl.slice(0, idx).trim();
  return type === '' ? null : type;
}

/**
 * Generate struct declaration
 */
export function generateStructDeclaration(struct: ExtractedStruct): string {
  const lines: string[] = [];

  const packed = struct.packed ? '__attribute__((packed)) ' : '';
  lines.push(`struct ${packed}${struct.name} {`);

  // Add integer conversion operators for small integer-only structs
  const intConversionType = getIntegerConversionType(struct.fields);
  if (intConversionType) {
    lines.push(`    ${struct.name}() = default;`);
    lines.push(`    ${struct.name}(${intConversionType} v) { *reinterpret_cast<${intConversionType}*>(this) = v; }`);
    lines.push(`    operator ${intConversionType}() const { return *reinterpret_cast<const ${intConversionType}*>(this); }`);
    // The conversion ctor/operator make the struct non-aggregate, which breaks
    // brace-init of multi-field int structs (`{0, 0}` arrays). Add a field-wise
    // constructor so `{a, b, ...}` matches it.
    const realFields = struct.fields.filter(f => f.name && !f.name.startsWith('_pad_'));
    if (realFields.length >= 2) {
      const sani = (n: string) => {
        let r = n.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^\d/.test(r)) r = `field_${r}`;
        if (CPP_KEYWORDS.has(r)) r = `${r}_`;
        return r;
      };
      const params = realFields.map((f, i) => `${f.dataType} a${i}`).join(', ');
      const inits = realFields.map((f, i) => `${sani(f.name!)}(a${i})`).join(', ');
      lines.push(`    ${struct.name}(${params}) : ${inits} {}`);
    }
    lines.push('');
  }

  emitFieldLines(struct.fields, lines);

  lines.push('};');

  return lines.join('\n');
}

/**
 * Generate enum declaration
 */
export function generateEnumDeclaration(enumType: ExtractedEnum): string {
  const lines: string[] = [];

  // Emit as typedef + named constants instead of C++ enum.
  // This ensures forward declarations (typedef int eXxx;) are always
  // compatible with the full definition (no enum/typedef tag mismatch).
  // Values go in a dedicated namespace to avoid collisions when multiple enums
  // share value names (e.g., eD2MonsterAnimMode::Death vs eD2PlayerAnimMode::Death).
  lines.push(`typedef int ${enumType.name};`);

  if (enumType.values.length > 0) {
    lines.push(`namespace ${enumType.name}_ns {`);
    for (const value of enumType.values) {
      const comment = value.comment ? ` // ${cleanInlineComment(value.comment)}` : '';
      lines.push(`constexpr ${enumType.name} ${value.name} = ${value.value};${comment}`);
    }
    lines.push(`}`);
    lines.push(`using namespace ${enumType.name}_ns;`);
  }

  return lines.join('\n');
}

/**
 * Does `d2_platform.h` (or a system header it pulls in) already declare a
 * FUNCTION by this name? Memoised: the registry is assembled from five tables
 * and this is asked once per candidate type name per header.
 */
let emitterDeclaredFunctions: Set<string> | undefined;
function emitterDeclaresFunction(name: string): boolean {
  emitterDeclaredFunctions ??= platformDeclaredFunctionNames();
  return emitterDeclaredFunctions.has(name);
}

/**
 * Generate typedef declaration
 */
// FunctionDefinition datatypes by name, registered before emission so a typedef
// whose target is a pointer to one can be inlined (see generateTypedefDeclaration).
const knownFuncDefs = new Map<string, ExtractedFunctionDefinition>();

/**
 * The guarded typedef for a function-pointer type, or undefined when no
 * FUNCTION_DEFINITION by that name is registered. The `RECON_FPTD_<name>` guard
 * is the same one `addForwardDeclaration` uses, so a file that emits the typedef
 * locally and a header that also declares it cannot both expand in one TU.
 */
export function guardedFuncDefTypedef(name: string): string | undefined {
  if (emitterDeclaresFunction(name)) return undefined;
  const fd = knownFuncDefs.get(name);
  if (!fd) return undefined;
  return `#ifndef RECON_FPTD_${name}\n#define RECON_FPTD_${name}\n${generateFunctionDefinitionDeclaration(fd)}\n#endif`;
}

export function setKnownFuncDefs(defs: Iterable<ExtractedFunctionDefinition>): void {
  knownFuncDefs.clear();
  for (const d of defs) knownFuncDefs.set(d.name, d);
}

function generateTypedefDeclaration(type: ExtractedTypedef): string {
  // A typedef whose target is `<FunctionDefinition> *` (e.g. QUESTCALLBACKFN =
  // `QUESTCALLBACK *`, where QUESTCALLBACK is a Ghidra function-signature type)
  // must be emitted as a self-contained function-pointer typedef: the bare
  // FunctionDefinition name has no standalone C definition, so referencing it
  // leaves the typedef — and every TU that includes it — undefined.
  const m = type.underlyingType.trim().match(/^(\w+)\s*\*$/);
  if (m) {
    const fd = knownFuncDefs.get(m[1]);
    if (fd) return generateFunctionDefinitionDeclaration({ ...fd, name: type.name });
  }
  return `typedef ${type.underlyingType} ${type.name};`;
}

/**
 * Generate union declaration
 */
export function generateUnionDeclaration(type: ExtractedUnion): string {
  const lines: string[] = [];

  lines.push(`union ${type.name} {`);

  emitFieldLines(type.fields, lines, /* isUnion */ true);

  lines.push('};');

  return lines.join('\n');
}

/**
 * Generate a function pointer typedef declaration.
 * Emits: typedef returnType (__callconv *TypeName)(param1Type param1Name, ...);
 */
export function generateFunctionDefinitionDeclaration(type: ExtractedFunctionDefinition): string {
  const params = type.parameters
    .map(p => {
      // Ghidra spells a __thiscall receiver `this`; as a parameter name in a
      // free function-pointer typedef that is a C++ keyword, not an identifier
      // ("'this' must be the first specifier in a parameter declaration").
      // Same rename the function signatures make.
      const name = p.name && p.name !== '' ? ` ${cleanParamName(p.name)}` : '';
      return `${sigType(p.dataType)}${name}`;
    })
    .join(', ');

  const varArgs = type.hasVarArgs ? (params ? ', ...' : '...') : '';

  return `typedef ${normalizeSignatureType(type.returnType)} (${pointerConvention(type.callingConvention)}*${type.name})(${params}${varArgs});`;
}

/**
 * Topologically sort types so that dependencies come before dependents.
 * Uses Kahn's algorithm (BFS). Cycles are broken by leaving back-edge types
 * in their original order (they'll need forward declarations).
 */
function topologicalSortTypes(types: ExtractedDataType[]): ExtractedDataType[] {
  if (types.length <= 1) return types;

  const nameToType = new Map<string, ExtractedDataType>();
  for (const t of types) nameToType.set(t.name, t);

  // Build adjacency: type A depends on type B if A's fields reference B by value (not pointer)
  const deps = new Map<string, Set<string>>();
  for (const t of types) deps.set(t.name, new Set());

  for (const t of types) {
    const fields: { dataType: string }[] =
      (t as any).fields ?? (t as any).underlyingType ? [] : [];

    // For structs/unions, scan fields
    if ('fields' in t && Array.isArray((t as any).fields)) {
      for (const field of (t as any).fields as { dataType: string }[]) {
        const ref = extractBaseTypeName(field.dataType);
        // Only value-type dependencies (not pointers) require ordering
        if (ref && nameToType.has(ref) && ref !== t.name && !field.dataType.includes('*')) {
          deps.get(t.name)!.add(ref);
        }
      }
    }
    // For typedefs, the underlying type is a dependency
    if (t.kind === 'TYPEDEF' && 'underlyingType' in t) {
      const ref = extractBaseTypeName((t as ExtractedTypedef).underlyingType);
      if (ref && nameToType.has(ref) && ref !== t.name) {
        deps.get(t.name)!.add(ref);
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const t of types) inDegree.set(t.name, 0);
  for (const [, d] of deps) {
    for (const dep of d) {
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
    }
  }

  // Wait — inDegree should count how many types depend ON this type,
  // but for topo sort we need: inDegree = number of deps this type has that aren't yet emitted.
  // Let me redo: inDegree[A] = number of types A depends on.
  const inDeg = new Map<string, number>();
  for (const [name, d] of deps) inDeg.set(name, d.size);

  // Start with leaf types (no dependencies). Prioritize typedefs/enums before structs/unions
  // so that types used in method signatures are available before class declarations.
  const queue: string[] = [];
  const leafTypedefs: string[] = [];
  const leafOthers: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) {
      const kind = nameToType.get(name)?.kind;
      if (kind === 'TYPEDEF' || kind === 'ENUM' || kind === 'FUNCTION_DEFINITION') {
        leafTypedefs.push(name);
      } else {
        leafOthers.push(name);
      }
    }
  }
  queue.push(...leafTypedefs, ...leafOthers);

  const sorted: ExtractedDataType[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(nameToType.get(name)!);

    // For each type that depends on `name`, decrement its in-degree
    for (const [other, d] of deps) {
      if (d.has(name)) {
        const newDeg = inDeg.get(other)! - 1;
        inDeg.set(other, newDeg);
        if (newDeg === 0) queue.push(other);
      }
    }
  }

  // Append any remaining (cycle members) in original order
  if (sorted.length < types.length) {
    const sortedNames = new Set(sorted.map(t => t.name));
    for (const t of types) {
      if (!sortedNames.has(t.name)) sorted.push(t);
    }
  }

  return sorted;
}

/** Extract base type name from a field type string (strip pointers, arrays, const) */
function extractBaseTypeName(typeStr: string): string | null {
  const cleaned = typeStr
    .replace(/\*/g, '')
    .replace(/&/g, '')
    .replace(/const\s*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/:\d+$/, '')
    .trim()
    .replace(/\s+\d+$/, '');
  if (!cleaned || isPlatformOrBuiltinType(cleaned)) return null;
  return cleaned;
}

/**
 * Collect forward declarations needed
 */
function collectForwardDeclarations(
  functions: ExtractedFunction[],
  classInfo?: DetectedClass,
  dataTypes?: ExtractedDataType[],
  classNames?: Set<string>,
  alreadyDefined?: Set<string>,
  ownedTypes?: Set<string>,
  allClasses?: DetectedClass[],
  allFunctions?: ExtractedFunction[],
  funcDefReferencedTypes?: Set<string>
): string[] {
  const declarations = new Set<string>();

  // Build name sets by kind from data types
  const structNames = new Set<string>();
  const unionNames = new Set<string>();
  const enumNames = new Set<string>();
  const typedefNames = new Set<string>();
  const funcDefNames = new Set<string>();
  const funcDefMap = new Map<string, ExtractedFunctionDefinition>();
  if (dataTypes) {
    for (const dt of dataTypes) {
      // Skip malformed Ghidra type names (bitfields, sized strings, etc.)
      if (/[:{}<>]/.test(dt.name) || isPlatformOrBuiltinType(dt.name)) continue;
      if (dt.kind === 'STRUCTURE') structNames.add(dt.name);
      else if (dt.kind === 'UNION') unionNames.add(dt.name);
      else if (dt.kind === 'ENUM') enumNames.add(dt.name);
      else if (dt.kind === 'TYPEDEF') typedefNames.add(dt.name);
      else if (dt.kind === 'FUNCTION_DEFINITION') {
        funcDefNames.add(dt.name);
        funcDefMap.set(dt.name, dt as ExtractedFunctionDefinition);
      }
    }
  }

  // Helper: extract all type references from a data type string (including template params)
  const extractAllTypeRefs = (dataType: string): string[] => {
    const refs: string[] = [];
    const main = extractClassName(dataType);
    if (main) refs.push(main);
    // Extract Ghidra template parameters: TSHashTable<struct_CELLIST,class_HASHKEY_NONE>
    const templateMatch = dataType.match(/<([^>]+)>/);
    if (templateMatch) {
      for (const param of templateMatch[1].split(',')) {
        const trimmed = param.trim();
        // Match struct_XXX and class_XXX patterns from Ghidra
        const ghidraMatch = trimmed.match(/^(struct_\w+|class_\w+)$/);
        if (ghidraMatch) refs.push(ghidraMatch[1]);
      }
    }
    return refs;
  };

  // Collect types used in function signatures
  for (const func of functions) {
    for (const param of func.parameters) {
      for (const type of extractAllTypeRefs(param.dataType)) {
        if (type !== classInfo?.name) {
          addForwardDeclaration(declarations, type, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
        }
      }
    }

    const returnType = extractClassName(func.returnType);
    if (returnType && returnType !== classInfo?.name) {
      addForwardDeclaration(declarations, returnType, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
    }
  }

  // Collect types used in struct/union fields and class method signatures
  if (dataTypes) {
    for (const dt of dataTypes) {
      if (ownedTypes ? !ownedTypes.has(dt.name) : !alreadyDefined?.has(dt.name)) continue; // Only scan types this header defines
      const fields: { dataType: string }[] = ('fields' in dt && Array.isArray((dt as any).fields))
        ? (dt as any).fields : [];
      for (const field of fields) {
        const type = extractClassName(field.dataType);
        if (type && type !== dt.name) {
          addForwardDeclaration(declarations, type, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
        }
      }
    }
  }
  // Also scan class method parameters and return types
  if (classInfo) {
    for (const method of classInfo.methods) {
      const func = functions.find(f => f.address === method.address);
      if (!func) continue;
      for (const param of func.parameters) {
        const type = extractClassName(param.dataType);
        if (type && type !== classInfo.name) {
          addForwardDeclaration(declarations, type, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
        }
      }
      const returnType = extractClassName(func.returnType);
      if (returnType && returnType !== classInfo.name) {
        addForwardDeclaration(declarations, returnType, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
      }
    }
  }

  // Also scan methods emitted INTO a struct body. When functions are method-converted
  // onto a struct (allClasses, e.g. D2QuestDataStrc.QUEST_SetStateAndBroadcast),
  // generateClassDeclaration emits the method signature into the struct — so its
  // parameter/return types (e.g. an fpExecuteOnUnitFunction* function-pointer param)
  // need forward declarations / guarded typedefs too. The primary classInfo is handled
  // above; this covers the secondary structs reached via allClasses.
  if (allClasses) {
    const fnByAddr = new Map<string, ExtractedFunction>();
    for (const f of (allFunctions ?? functions)) {
      if (f.address) fnByAddr.set(f.address, f);
    }
    for (const cls of allClasses) {
      if (cls.name === classInfo?.name) continue; // already handled
      if (!cls.methods || cls.methods.length === 0) continue;
      for (const method of cls.methods) {
        const func = fnByAddr.get(method.address);
        if (!func) continue;
        for (const param of func.parameters) {
          for (const type of extractAllTypeRefs(param.dataType)) {
            if (type !== cls.name) {
              addForwardDeclaration(declarations, type, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
            }
          }
        }
        const returnType = extractClassName(func.returnType);
        if (returnType && returnType !== cls.name) {
          addForwardDeclaration(declarations, returnType, structNames, unionNames, enumNames, typedefNames, funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, undefined, funcDefReferencedTypes);
        }
      }
    }
  }

  return Array.from(declarations).sort();
}

function addForwardDeclaration(
  declarations: Set<string>,
  type: string,
  structNames: Set<string>,
  unionNames: Set<string>,
  enumNames: Set<string>,
  typedefNames: Set<string>,
  funcDefNames: Set<string>,
  funcDefMap: Map<string, ExtractedFunctionDefinition>,
  classNames?: Set<string>,
  alreadyDefined?: Set<string>,
  ownedTypes?: Set<string>,
  visiting: Set<string> = new Set(),
  funcDefReferencedTypes?: Set<string>,
): void {
  // Validate: skip malformed or artifact type names
  if (!type || isPlatformOrBuiltinType(type)) return;
  // A name the emitter already declares as a FUNCTION cannot also be introduced
  // as a type. Ghidra records the MSVC pure-virtual thunk twice — as the
  // function `__purecall` and as a FUNCTION_DEFINITION of the same name — and
  // declaring both makes the typedef win every lookup, so a vtable initializer
  // taking `&__purecall` takes the address of a type. The function is the one
  // call sites and initializers mean; the type declaration is dropped.
  if (emitterDeclaresFunction(type)) return;
  if (/[{}:<>,]/.test(type)) return;    // Ghidra size annotations, bitfields, templates
  if (/^\d/.test(type)) return;          // Numeric garbage
  if (!/^[A-Za-z_]/.test(type)) return;  // Must start with letter or underscore

  // Skip types defined in this very file — they'll be emitted as full definitions below
  if (ownedTypes?.has(type)) return;

  // Skip types already fully defined via included headers
  if (alreadyDefined?.has(type)) return;

  // Enum types: emit typedef int as forward declaration.
  if (/^e[A-Z]/.test(type) || enumNames.has(type)) {
    declarations.add(`typedef int ${type};`);
    return;
  }

  if (unionNames.has(type)) {
    declarations.add(`union ${type};`);
  } else if (classNames?.has(type) || structNames.has(type) || WINDOWS_STRUCTS.has(type)) {
    declarations.add(`struct ${type};`);
  } else if (/^fn[A-Z]/.test(type) || /^fp[A-Z]/.test(type) || funcDefNames.has(type)) {
    const funcDef = funcDefMap.get(type);
    // The typedef spells its parameter and return types by name, so those need
    // declarations of their own — and BEFORE it. A vtable slot typed
    // `pfnIgnoreListGetPersistent` names `::IgnoreList`, a class Ghidra holds
    // only as a category, and nothing else in the header mentions it.
    if (funcDef && !visiting.has(type)) {
      visiting.add(type);
      const referenced = [funcDef.returnType, ...funcDef.parameters.map(fp => fp.dataType)];
      for (const ref of referenced) {
        const name = extractClassName(ref ?? '');
        if (!name || name === type) continue;
        // A type this header DEFINES is still declared too late: the typedef
        // block sits in the forward-declaration section, above the definitions.
        funcDefReferencedTypes?.add(name);
        addForwardDeclaration(
          declarations, name, structNames, unionNames, enumNames, typedefNames,
          funcDefNames, funcDefMap, classNames, alreadyDefined, ownedTypes, visiting,
          funcDefReferencedTypes,
        );
      }
      visiting.delete(type);
    }
    // Guard the typedef with a per-name macro so the real signature (here) and
    // an opaque fallback (in a header that lacks the FUNCTION_DEFINITION) can't
    // both expand in one translation unit — first include wins, the rest skip.
    // Without this, a function-pointer type used as a struct field/param but
    // whose FUNCTION_DEFINITION isn't in this header's type set was emitted
    // nowhere ("'fpExecuteOnUnitFunction' has not been declared").
    const guard = `RECON_FPTD_${type}`;
    const body = funcDef
      ? generateFunctionDefinitionDeclaration(funcDef)
      : `typedef void (*${type})();`;
    declarations.add(`#ifndef ${guard}\n#define ${guard}\n${body}\n#endif`);
  } else {
    declarations.add(`struct ${type};`);
  }
}

/**
 * Extract class name from type string (e.g., "MyClass*" -> "MyClass")
 */
function extractClassName(typeStr: string): string | null {
  // Remove pointer/reference suffixes, const, array brackets, size annotations, and Ghidra artifacts
  const cleaned = typeStr
    .replace(/\*/g, '')
    .replace(/&/g, '')
    .replace(/const\s*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')     // Strip Ghidra size annotations like {32}
    .replace(/:\d+$/, '')           // Strip bitfield notation like :1
    .trim()
    .replace(/\s+\d+$/, '');

  if (isPlatformOrBuiltinType(cleaned) || cleaned === '') {
    return null;
  }

  return cleaned;
}

/**
 * Filter data types relevant to the file being generated
 */
function filterRelevantTypes(
  dataTypes: ExtractedDataType[],
  functions: ExtractedFunction[],
  classInfo?: DetectedClass
): ExtractedDataType[] {
  // Only consider types that have actual declarations to emit
  const declarableKinds = new Set(['STRUCTURE', 'ENUM', 'TYPEDEF', 'UNION', 'FUNCTION_DEFINITION']);

  const usedTypes = new Set<string>();

  // Collect types used in function signatures
  for (const func of functions) {
    for (const param of func.parameters) {
      usedTypes.add(param.dataType.replace(/[*&]/g, '').trim());
    }
    usedTypes.add(func.returnType.replace(/[*&]/g, '').trim());
  }

  // Collect types from class fields
  if (classInfo) {
    for (const field of classInfo.fields) {
      usedTypes.add(field.dataType.replace(/[*&]/g, '').trim());
    }
  }

  return dataTypes.filter(t => declarableKinds.has(t.kind) && usedTypes.has(t.name));
}

/**
 * The member names an aggregate's declaration actually carries, keyed by type
 * name.
 *
 * A body written by the decompiler reads a bitfield storage unit by its
 * whole-byte alias (`pSkillsTxt->field_0x4`), and that alias is NOT a member:
 * Ghidra models offset 4 of `D2SkillsTxt` as eight `int:1` bitfields, so the
 * emitted struct declares `decquant`, `lob`, … and nothing named `field_0x4`.
 * Deciding whether such a read resolves needs the member set the header emitter
 * really wrote, not a reconstruction of its naming rules - the rules are long
 * (bitfield groups, lone filler bytes, named filler runs, keyword and
 * leading-digit repair, shadowing and duplicate suffixes) and a second copy of
 * them would drift the first time one changed.
 *
 * So the set is taken FROM the emitter, by running the same `emitFieldLines`
 * over a throwaway line buffer. Memoised on the type name; the line buffer is
 * discarded.
 */
const emittedMemberNameCache = new Map<string, ReadonlySet<string>>();

export function resetEmittedMemberNames(): void {
  emittedMemberNameCache.clear();
}

export function emittedMemberNames(type: ExtractedDataType): ReadonlySet<string> {
  const cached = emittedMemberNameCache.get(type.name);
  if (cached) return cached;
  const names = new Set<string>();
  if (type.kind === 'STRUCTURE' || type.kind === 'UNION') {
    const fields = (type as ExtractedStruct | ExtractedUnion).fields ?? [];
    emitFieldLines(fields, [], type.kind === 'UNION', names);
  }
  emittedMemberNameCache.set(type.name, names);
  return names;
}

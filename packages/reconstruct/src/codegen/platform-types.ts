/**
 * Platform and builtin type definitions
 *
 * Canonical set of all platform/builtin type names.
 * Consolidates duplicate sets from header.ts, globals-header.ts, and references.ts.
 */

// =============================================================================
// Type Sets
// =============================================================================

/** Standard C/C++ types from <cstdint>, <cstddef>, and language primitives */
import {
  generateExcludedSymbolDecls, EXTRA_WIN32_SDK_HEADERS,
  EXCLUDED_SYMBOL_DECLS, CRT_DECLARED_FUNCTION_NAMES,
} from './crt-mapping.js';

export const STANDARD_C_TYPES = new Set([
  // Language primitives
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double',
  'signed', 'unsigned', '_Bool',
  // Fixed-width integers
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  // Pointer-width types
  'intptr_t', 'uintptr_t', 'ptrdiff_t',
  // Size types
  'size_t', 'ssize_t',
  // Wide char
  'wchar_t',
  // C stdlib
  'FILE', 'va_list', '_locale_t',
  // auto (from type-normalize)
  'auto',
]);

/** Windows scalar, pointer, handle, and struct types */
export const WINDOWS_TYPES = new Set([
  // Scalar typedefs
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'QWORD',
  'CHAR', 'WCHAR', 'TCHAR',
  'INT', 'UINT', 'LONG', 'ULONG', 'SHORT', 'USHORT',
  'LONGLONG', 'ULONGLONG',
  'SIZE_T', 'SSIZE_T', 'DWORD_PTR', 'ULONG_PTR', 'HRESULT',
  // Pointer/handle typedefs
  'LPVOID', 'LPCVOID', 'PVOID',
  'HANDLE', 'HMODULE', 'HINSTANCE', 'HWND',
  'LPSTR', 'LPCSTR', 'LPWSTR', 'LPCWSTR',
  'LPBYTE', 'LPDWORD', 'LPINT', 'LPFILETIME', 'LPOVERLAPPED',
  'LPSERVICE_STATUS', 'WNDPROC',
  'FARPROC', 'LRESULT', 'WPARAM', 'LPARAM', 'ATOM', 'HGLOBAL',
  'HDC', 'HBITMAP', 'HFONT', 'HBRUSH', 'HPEN', 'HKEY',
  'HCURSOR', 'HICON', 'HMENU', 'HPALETTE', 'HRGN', 'HRSRC',
  'SOCKET', 'CONTEXT', 'LPCONTEXT',
  'IMAGE_DOS_HEADER', 'PTHREAD_START_ROUTINE',
  'UCHAR', 'u_short', 'u_long',
  // Struct types
  'CRITICAL_SECTION', 'LPCRITICAL_SECTION',
  'POINT', 'LPPOINT', 'RECT', 'LPRECT', 'tagRECT',
  'FILETIME', 'MEMORYSTATUS', 'SYSTEMTIME',
  '_FILETIME', '_LARGE_INTEGER', 'LARGE_INTEGER', '_MEMORYSTATUS', '_OVERLAPPED',
  '_SECURITY_ATTRIBUTES', '_SYSTEMTIME',
  'OVERLAPPED', 'GUID', 'SECURITY_ATTRIBUTES', 'WIN32_FIND_DATA',
  'LPPALETTEENTRY', 'PALETTEENTRY',
  // PE header types
  'IMAGE_DOS_HEADER', 'IMAGE_NT_HEADERS', 'IMAGE_SECTION_HEADER',
  'IMAGE_DEBUG_DIRECTORY', 'IMAGE_RESOURCE_DIRECTORY',
  'IMAGE_DIRECTORY_ENTRY_EXPORT', 'VS_VERSION_INFO',
  // Thread types
  'PTHREAD_START_ROUTINE', 'LPTHREAD_START_ROUTINE',
  // Windows pointer types
  'LPSECURITY_ATTRIBUTES', 'LPMEMORYSTATUS', 'LPSYSTEMTIME', 'PLONG', 'u_long',
  // Thread/exception context
  'CONTEXT',
  // IME types
  'HIMC__',
  // Exception type
  'exception',
  // Additional Win32 stubs
  'tagWINDOWPLACEMENT', 'WINDOWPLACEMENT', 'IID',
  '_Unwind_Reason_Code', '_Unwind_Exception',
]);

/** 3dfx Glide API types (used by Diablo 2's Glide renderer) */
export const GLIDE_TYPES = new Set([
  'FxBool', 'GrAlphaBlendFnc_t', 'GrAlpha_t', 'GrAspectRatio_t',
  'GrBuffer_t', 'GrChipID_t', 'GrChromakeyMode_t', 'GrCmpFnc_t',
  'GrColorFormat_t', 'GrColor_t', 'GrCombineFactor_t', 'GrCombineFunction_t',
  'GrCombineLocal_t', 'GrCombineOther_t', 'GrContext_t', 'GrCoordinateSpaceMode_t',
  'GrDepthBufferMode_t', 'GrDitherMode_t', 'GrEnableMode_t', 'GrLOD_t',
  'GrLfbInfo_t', 'GrLfbWriteMode_t', 'GrLock_t', 'GrMipMapMode_t',
  'GrOriginLocation_t', 'GrScreenRefresh_t', 'GrScreenResolution_t',
  'GrTexTable_t', 'GrTextureFilterMode_t', 'GrTextureFormat_t',
  'GrTexInfo', 'GrProc',
  'FxFloat', 'FxI32', 'FxU32', 'FxI16', 'FxU16',
]);

/** Ghidra decompiler artifact types (undefined, byte, word, etc.) */
export const GHIDRA_ARTIFACT_TYPES = new Set([
  'undefined', 'undefined1', 'undefined2', 'undefined3',
  'undefined4', 'undefined5', 'undefined6', 'undefined7', 'undefined8',
  'byte', 'word', 'dword', 'qword',
  'sbyte', 'sword', 'sdword', 'sqword',
  'uint', 'ushort', 'ulong', 'ulonglong',
  'uchar',
  'longlong', 'int3', 'int5', 'int6', 'int7', 'uint3', 'uint5', 'uint6', 'uint7',
  'unkfloat1', 'float10', 'unkbool1', 'pointer', 'Alignment',
  'string', 'TerminatedCString', 'string-utf8',
  'vtable', 'unicode', 'wchar16', 'pointer32', 'ImageBaseOffset32',
]);

/** Windows structs that need `struct` keyword in forward declarations */
export const WINDOWS_STRUCTS = new Set([
  'POINT', 'RECT', 'FILETIME', 'MEMORYSTATUS', 'SYSTEMTIME',
  'OVERLAPPED', 'GUID', 'SECURITY_ATTRIBUTES', 'WIN32_FIND_DATA',
  'in_addr', 'sockaddr',
]);

// =============================================================================
// Library type detection (SDK/CRT-provided types)
// =============================================================================

/**
 * MSVC C++ exception-handling internal types.
 *
 * Ghidra recovers these from the statically-linked CRT into the root category
 * `/` — the SAME category game types live under — so a category check can't
 * distinguish them; we need an explicit name-set. They are referenced ONLY by
 * compiler-runtime files (compiler/*, globals.*), never by game bodies, so it's
 * safe to guard their definitions out under _WIN32 (the real C++ SDK / CRT
 * `<vcruntime.h>`/`<ehdata.h>` provides them, and re-emitting our own copies
 * collides with those).
 */
const EH_INTERNAL_TYPES = new Set<string>([
  'FuncInfo', '_s_FuncInfo',
  'UnwindMapEntry', '_s_UnwindMapEntry',
  'TryBlockMapEntry', '_s_TryBlockMapEntry',
  'HandlerType', '_s_HandlerType',
  'ESTypeList', '_s_ESTypeList',
  'ThrowInfo', '_s_ThrowInfo',
  'CatchableType', '_s_CatchableType',
  'CatchableTypeArray', '_s_CatchableTypeArray',
  'PMD', '_PMD',
  // MSVC RTTI metadata (the `??_R*` object-locator chain the compiler emits for
  // every polymorphic class). Ghidra recovers these from the statically-linked
  // CRT into root category `/`, exactly like the EH internals above, and no real
  // header declares them either — the C++ compiler regenerates the whole chain
  // from the class definitions, so re-emitting Ghidra's copies is both
  // uncompilable and redundant.
  'RTTICompleteObjectLocator', '_s__RTTICompleteObjectLocator',
  'RTTIClassHierarchyDescriptor', '_s__RTTIClassHierarchyDescriptor',
  'RTTIBaseClassDescriptor', '_s__RTTIBaseClassDescriptor',
  'RTTIBaseClassArray', '_s__RTTIBaseClassArray',
  'TypeDescriptor', '_TypeDescriptor',
]);

/** System-header category path, e.g. `/winsock.h`, `/inaddr.h`, `/WinDef.h` */
const SYSTEM_HEADER_CATEGORY_RE = /^\/[A-Za-z0-9_]+\.h$/;

/**
 * MSVC C++ exception-handling internal type (FuncInfo, UnwindMapEntry, ...).
 * Unlike Win32 SDK types (RGBQUAD, SYSTEMTIME), these are NOT declared by any
 * real header (windows.h/CRT) — so anything typed as one cannot compile and
 * must be dropped, not merely left to the SDK.
 */
/**
 * Ghidra's CPUID pseudo-operations, one per leaf. These are decompiler output,
 * not symbols in the binary, so nothing but the platform header can declare them.
 */
const GHIDRA_CPUID_PSEUDO_OPS = [
  'cpuid',
  'cpuid_basic_info',
  'cpuid_Version_info',
  'cpuid_cache_tlb_info',
  'cpuid_serial_info',
  'cpuid_Deterministic_Cache_Parameters_info',
  'cpuid_MONITOR_MWAIT_Features_info',
  'cpuid_Thermal_Power_Management_info',
  'cpuid_Extended_Feature_Enumeration_info',
  'cpuid_Direct_Cache_Access_info',
  'cpuid_Architectural_Performance_Monitoring_info',
  'cpuid_Extended_Topology_info',
  'cpuid_Processor_Extended_States_info',
  'cpuid_Quality_of_Service_info',
  'cpuid_brand_part1_info',
  'cpuid_brand_part2_info',
  'cpuid_brand_part3_info',
] as const;

export function isMsvcEhInternal(name: string): boolean {
  return EH_INTERNAL_TYPES.has(name);
}

/**
 * Decide whether a data type is a "library type" — i.e. provided by the real
 * Win32 SDK / C runtime on Windows, NOT by us.
 *
 * Ghidra pulled C-runtime / Win32 / MSVC-EH internal types INTO the type
 * database because the binary statically linked the CRT. Re-emitting our own
 * struct/typedef definitions for these collides with the real headers that
 * d2_platform.h pulls in (`<windows.h>`/`<winsock2.h>`/CRT) under _WIN32
 * ("redefinition of struct X"). So these definitions must be guarded behind
 * `#ifndef _WIN32` and only emitted for the no-SDK build.
 *
 * A type is a library type iff EITHER:
 *   1. its Ghidra category is a system-header path (`/<header>.h`) — game types
 *      live under `/` or `/Diablo2/...` and NEVER under such a path; OR
 *   2. its name is a known MSVC C++ exception-handling internal (these sit at
 *      root category `/`, shared with game types, so they need a name-set).
 */
/**
 * Winsock types Ghidra filed under the ROOT category instead of `/winsock.h`,
 * so the category test cannot see them. Their siblings — `sockaddr`, `hostent`,
 * `fd_set`, `timeval`, `WSAData` — all carry `/winsock.h` and are guarded
 * correctly; `sockaddr_in` alone lost its attribution, and emitting an
 * unguarded definition of it collides with `<winsock2.h>` in every translation
 * unit that reaches it (178 diagnostics when it first became reachable).
 *
 * The authoritative fix is in Ghidra — move the type to `/winsock.h` — at which
 * point this entry becomes redundant but stays harmless.
 */
const ROOT_CATEGORY_WINSOCK_TYPES = new Set<string>([
  'sockaddr_in',
]);

export function isLibraryType(name: string, category: string): boolean {
  if (SYSTEM_HEADER_CATEGORY_RE.test(category)) return true;
  if (EH_INTERNAL_TYPES.has(name)) return true;
  if (ROOT_CATEGORY_WINSOCK_TYPES.has(name)) return true;
  return false;
}

// =============================================================================
// Type Checking
// =============================================================================

/**
 * Types the platform headers DEFINE, not merely name — the type-level counterpart
 * of `platformDeclaredFunctionNames()`. Emitting our own definition of one of
 * these is a redefinition, not a fallback, because `d2_platform.h` has already
 * pulled the real one in.
 *
 * `IUnknown` is the proven case: mingw's `unknwnbase.h:75` defines it as a C++
 * interface class whenever `CINTERFACE` is not set, which is every translation
 * unit here, and Ghidra's own `IUnknown` (the C shape, `{ IUnknownVtbl* lpVtbl; }`)
 * collided with it in 12 files. Nothing in the tree reads a field through an
 * `IUnknown`, so the platform's is a drop-in.
 *
 * Deliberately NOT extended to the DirectDraw/DirectSound/Direct3D interfaces or
 * to `IUnknownVtbl`: the C++ branch of those headers defines only the interface
 * classes, so `IUnknownVtbl` and the `IDirect*Vtbl` shapes have no platform
 * definition at all and ours is the only one. Add a name here only after seeing
 * it collide.
 */
const PLATFORM_DEFINED_TYPES = new Set<string>([
  'IUnknown',
]);

/**
 * Check if a type name is a platform, standard, or Ghidra artifact type
 * that should never be emitted as a typedef/struct or need a forward declaration.
 */
export function isPlatformOrBuiltinType(name: string): boolean {
  return STANDARD_C_TYPES.has(name)
    || WINDOWS_TYPES.has(name)
    || GHIDRA_ARTIFACT_TYPES.has(name)
    || GLIDE_TYPES.has(name)
    || PLATFORM_DEFINED_TYPES.has(name)
    // Ghidra internal anonymous types: _struct_NNNN, _union_NNNN
    || /^_(struct|union)_\d+$/.test(name);
}

/** Scalar types that can be initialized with = 0 (not structs) */
const SCALAR_TYPE_RE = /^(void|bool|char|short|int|long|float|double|unsigned|signed|u?int\d+_t|u?int\d|uint|ushort|ulong|ulonglong|longlong|uchar|byte|word|dword|qword|sbyte|sword|sdword|sqword|size_t|ssize_t|BOOL|BYTE|WORD|DWORD|QWORD|CHAR|WCHAR|LONG|ULONG|SHORT|USHORT|INT|UINT|HANDLE|HWND|HDC|HMODULE|HINSTANCE|HKEY|FARPROC|LRESULT|WPARAM|LPARAM|ATOM|HRESULT|SOCKET|pointer|code|auto)$/;

/**
 * Check if a type name represents a struct/class (not a scalar/pointer/builtin).
 * Used to determine if `= 0` needs to be `= {}` for zero-initialization.
 */
export function isStructType(type: string): boolean {
  const base = type.replace(/\s*(const|volatile|\*|&|\[.*\])\s*/g, '').trim();
  if (!base) return false;
  if (type.includes('*') || type.includes('&')) return false;
  if (SCALAR_TYPE_RE.test(base)) return false;
  if (isPlatformOrBuiltinType(base)) return false;
  return true;
}

/**
 * If type is a pointer and value is a non-zero integer literal, wrap in a cast.
 * e.g. type="void*", value="0x006e3598" → "(void*)0x006e3598"
 */
export function castPointerInitializer(type: string, value: string): string {
  if (!type.includes('*')) return value;
  // 0 / 0x0 / nullptr are fine without cast
  if (value === '0' || value === '0x0' || value === 'nullptr') return value;
  // Non-zero integer literal needs cast
  if (/^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value)) {
    // Use the base pointer type for the cast. The initializer may land inside a
    // namespace block whose own name shadows the type, so spell it root-qualified.
    const castType = rootQualifyShadowedType(type.replace(/\s+/g, ' ').trim());
    return `(${castType})${value}`;
  }
  return value;
}

/**
 * A single-character scalar, whose Ghidra `value` is the CHARACTER, not a number.
 * `CHAR_A_006ed5ac` is declared `char` and valued `A`; read as a number that is
 * the hex digit 0xA, and the emitted byte becomes 10 where the binary holds 65.
 */
export function isCharacterValueType(type: string): boolean {
  const t = type.replace(/\b(const|volatile|unsigned|signed)\b/g, '').replace(/\s+/g, ' ').trim();
  return t === 'char' || t === 'CHAR' || t === 'int8_t' || t === 'uint8_t' || t === 'byte';
}

/**
 * Normalize a Ghidra data value for C++ output.
 * - Raw hex strings (e.g. "0030437a") get 0x prefix
 * - GUID strings get wrapped in a comment
 * - Already-prefixed "0x..." values pass through
 */
export function normalizeDataValue(value: string): string {
  // Already a valid C literal
  if (value === '0' || value === 'nullptr' || value.startsWith('0x') || value.startsWith('-')) return value;
  // GUID format: 00000000-0000-0000-0000-000000000000
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    return `{} /* ${value} */`;
  }
  // Raw hex without 0x prefix: either contains hex letters (a-f) or has leading zeros
  // (Ghidra reports addresses and data values without 0x prefix)
  if (/^[0-9a-fA-F]{4,}$/.test(value) && (/[a-fA-F]/.test(value) || /^0[0-9]/.test(value))) {
    return `0x${value}`;
  }
  // Ghidra RENDERS some data rather than valuing it: `<Icon-Image>` for an icon
  // resource, `align(1)` for section padding. That is listing text, not a C
  // expression — emitted verbatim it parses as undeclared identifiers
  // ('Icon' / 'Image' / 'align' was not declared in this scope).
  if (/^<.*>$/.test(value) || /^align\(\d+\)$/.test(value)) {
    return '0';
  }
  return value;
}

// =============================================================================
// Signature Type Normalization
// =============================================================================

/** Map of Ghidra undefined types to C stdint equivalents */
const UNDEFINED_TYPE_MAP: Record<string, string> = {
  'undefined': 'uint8_t',
  'undefined1': 'uint8_t',
  'undefined2': 'uint16_t',
  'undefined3': 'uint8_t',  // 3 bytes — no exact match, use smallest
  'undefined4': 'uint32_t',
  'undefined5': 'uint8_t',
  'undefined6': 'uint8_t',
  'undefined7': 'uint8_t',
  'undefined8': 'uint64_t',
};

/**
 * Ghidra spellings of Diablo II's own 16-bit character.
 *
 * The game is Unicode internally: its strings are 16-bit code units. Ghidra
 * carries that as `ushort` in decompiled bodies but as `WCHAR`, `wchar_t`,
 * `wchar16` or `unicode` in the prototypes and struct layouts that were typed
 * by hand. `ushort` normalizes to `uint16_t` (type-normalize, on bodies), so a
 * prototype spelled `WCHAR *` and a body spelled `uint16_t *` are two distinct
 * C++ types at every call — even though on i686 they are the same 16 bits.
 *
 * D2's own APIs therefore converge on `uint16_t`, the one spelling the bodies
 * can produce. `WCHAR`/`wchar_t` stay untouched for the real Win32 and CRT
 * declarations (windows.h, wcslen, MessageBoxW), which need the true wchar_t.
 */
const D2_WIDE_CHAR_TYPES = ['WCHAR', 'wchar_t', 'wchar16', 'unicode'] as const;
const D2_WIDE_CHAR_RE = new RegExp(`\\b(?:${D2_WIDE_CHAR_TYPES.join('|')})\\b`, 'g');

/**
 * Rewrite every Ghidra spelling of D2's 16-bit character to `uint16_t`.
 *
 * Applies to the base type inside any pointer/array/const decoration:
 * `WCHAR *` → `uint16_t *`, `wchar_t * *` → `uint16_t * *`, `WCHAR[16]` →
 * `uint16_t[16]`.
 */
export function normalizeWideCharType(type: string): string {
  return type.replace(D2_WIDE_CHAR_RE, 'uint16_t');
}

/**
 * Normalize Ghidra `undefined[N]` types in function signatures to C equivalents.
 *
 * Handles both bare types and pointer variants:
 * - `undefined4` → `uint32_t`
 * - `undefined4 *` → `uint32_t *`
 * - `undefined` → `uint8_t`
 *
 * Also unifies D2's wide-character spellings on `uint16_t`
 * (see {@link normalizeWideCharType}).
 *
 * Returns the input unchanged for known/normal types.
 */
export function normalizeSignatureType(type: string): string {
  return normalizeWideCharType(normalizeSignatureTypeInner(type));
}

function normalizeSignatureTypeInner(type: string): string {
  // Strip leading/trailing unbalanced parentheses (Ghidra decompiler artifacts)
  let trimmed = type.trim();
  if (trimmed.startsWith('(') && !trimmed.includes(')')) {
    trimmed = trimmed.slice(1).trim();
  }

  // Check for pointer variant: "undefinedN *", "undefinedN*", "undefinedN * *"
  const ptrMatch = trimmed.match(/^(undefined\d?)\s*([\s*]+)$/);
  if (ptrMatch) {
    const base = UNDEFINED_TYPE_MAP[ptrMatch[1]];
    if (base) {
      // Normalize pointer stars: collapse spaces between stars
      const stars = ptrMatch[2].replace(/\s+/g, '').trim();
      return `${base} ${stars}`;
    }
  }

  // Check for bare undefined type
  if (UNDEFINED_TYPE_MAP[trimmed]) {
    return UNDEFINED_TYPE_MAP[trimmed];
  }

  // Replace Ghidra template instantiations with void: "TSHashTable<A,B,0> *" → "void *"
  // Template params like struct_CELLIST, class_HASHKEY_NONE are Ghidra internal names.
  if (trimmed.includes('<')) {
    const stars = trimmed.match(/(\s*[*&]+\s*)$/);
    return stars ? `void ${stars[1].trim()}` : 'void';
  }

  // Fix array-pointer types: "Type[N] *" → "Type *" (Ghidra artifact for pointer-to-array params)
  const arrayPtrMatch = trimmed.match(/^(.+?)\[\d+\]\s*\*$/);
  if (arrayPtrMatch) {
    return `${arrayPtrMatch[1].trim()} *`;
  }

  // Fix bare array param types: "char[4]" → "char *" (arrays decay to pointers in function params)
  const bareArrayMatch = trimmed.match(/^(.+?)\[\d+\]$/);
  if (bareArrayMatch) {
    return `${bareArrayMatch[1].trim()} *`;
  }

  // Replace Ghidra's `code` type (executable code) with `void` in signatures
  if (/^code\s*[*&]/.test(trimmed)) {
    return trimmed.replace(/^code/, 'void');
  }
  if (trimmed === 'code') return 'void';

  return type;
}

/**
 * Collapse function-pointer-typedef double-indirection in a signature type:
 * "fpFoo *" → "fpFoo". Ghidra stores a function-pointer parameter/return as
 * "fpFoo *", but fpFoo is itself emitted as a pointer typedef
 * (typedef BOOL (*fpFoo)(...)), so the extra star yields BOOL (**) and a
 * decayed-function argument fails to convert. The struct field renderer already
 * does this; this lets signatures (params + return types) do the same.
 *
 * @param isFuncDefTypedef predicate identifying emitted fn-ptr typedef names
 *   (passed in to avoid a circular import on globals-header).
 */
export function collapseFuncPtrTypedef(
  type: string,
  isFuncDefTypedef: (name: string) => boolean
): string {
  const m = type.trim().match(/^(\w+)\s*\*$/);
  return m && isFuncDefTypedef(m[1]) ? m[1] : type;
}

// =============================================================================
// Platform Header Generation
// =============================================================================

/**
 * Generate d2_platform.h content with cross-platform type definitions
 */

// =============================================================================
// The declaration registry — what THIS emitter declares, versus what Ghidra did
// =============================================================================

/**
 * One function `d2_platform.h` declares itself.
 *
 * The emitter has to be able to answer "did I write this callee's declaration,
 * or did it come out of the database?", because the two answers demand opposite
 * treatment. A callee reconstructed from Ghidra carries the prototype Ghidra
 * recovered, and a call into it can be cast to that prototype. A callee declared
 * HERE — or by `<windows.h>` in the `_WIN32` build, where these same names come
 * from the vendor instead — carries the platform's prototype, and Ghidra's
 * record of it is frequently wrong: `wsprintfA` is `(LPSTR, LPCSTR, ...)` in
 * `winuser.h` and `void wsprintfA(undefined4, undefined4, undefined4,
 * undefined4)` in the database. Casting an argument to Ghidra's answer there
 * writes a conversion the real declaration rejects.
 *
 * `name` is the identifier a call site writes. It is a field rather than
 * something recovered from `decl`, for the same reason `ExcludedSymbolDecl`
 * spells `emitted` out: the registry has to be readable without parsing C++.
 */
export interface PlatformFunctionDecl {
  /** Identifier as written at the call site. */
  readonly name: string;
  /** The declaration line, verbatim. */
  readonly decl: string;
}

const WIN32_CORE_STUBS: readonly PlatformFunctionDecl[] = [
  { name: "GetTickCount", decl: "DWORD GetTickCount();" },
  { name: "Sleep", decl: "void Sleep(DWORD dwMilliseconds);" },
  { name: "QueryPerformanceCounter", decl: "BOOL QueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount);" },
  { name: "QueryPerformanceFrequency", decl: "BOOL QueryPerformanceFrequency(LARGE_INTEGER* lpFrequency);" },
  { name: "wsprintfA", decl: "int wsprintfA(LPSTR lpOut, LPCSTR lpFmt, ...);" },
  { name: "wsprintfW", decl: "int wsprintfW(LPWSTR lpOut, LPCWSTR lpFmt, ...);" },
  { name: "GetLastError", decl: "DWORD GetLastError();" },
  { name: "SetLastError", decl: "void SetLastError(DWORD dwErrCode);" },
  { name: "GetCurrentThreadId", decl: "DWORD GetCurrentThreadId();" },
  { name: "GetCurrentProcessId", decl: "DWORD GetCurrentProcessId();" },
  { name: "OutputDebugStringA", decl: "void OutputDebugStringA(LPCSTR lpOutputString);" },
  { name: "GetModuleHandleA", decl: "HMODULE GetModuleHandleA(LPCSTR lpModuleName);" },
  { name: "GetProcAddress", decl: "FARPROC GetProcAddress(HMODULE hModule, LPCSTR lpProcName);" },
  { name: "LoadLibraryA", decl: "HMODULE LoadLibraryA(LPCSTR lpLibFileName);" },
  { name: "FreeLibrary", decl: "BOOL FreeLibrary(HMODULE hLibModule);" },
  { name: "GetProcessHeap", decl: "HANDLE GetProcessHeap();" },
  { name: "HeapAlloc", decl: "LPVOID HeapAlloc(HANDLE hHeap, DWORD dwFlags, SIZE_T dwBytes);" },
  { name: "HeapFree", decl: "BOOL HeapFree(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem);" },
  { name: "InitializeCriticalSection", decl: "void InitializeCriticalSection(LPCRITICAL_SECTION lpCriticalSection);" },
  { name: "EnterCriticalSection", decl: "void EnterCriticalSection(LPCRITICAL_SECTION lpCriticalSection);" },
  { name: "LeaveCriticalSection", decl: "void LeaveCriticalSection(LPCRITICAL_SECTION lpCriticalSection);" },
  { name: "DeleteCriticalSection", decl: "void DeleteCriticalSection(LPCRITICAL_SECTION lpCriticalSection);" },
  { name: "CreateThread", decl: "HANDLE CreateThread(LPSECURITY_ATTRIBUTES lpThreadAttributes, SIZE_T dwStackSize, LPTHREAD_START_ROUTINE lpStartAddress, LPVOID lpParameter, DWORD dwCreationFlags, LPDWORD lpThreadId);" },
  { name: "WaitForSingleObject", decl: "DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);" },
  { name: "CloseHandle", decl: "BOOL CloseHandle(HANDLE hObject);" },
  { name: "ExitProcess", decl: "void ExitProcess(UINT uExitCode);" },
  { name: "MessageBoxA", decl: "int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType);" },
  { name: "VirtualAlloc", decl: "LPVOID VirtualAlloc(LPVOID lpAddress, SIZE_T dwSize, DWORD flAllocationType, DWORD flProtect);" },
  { name: "VirtualFree", decl: "BOOL VirtualFree(LPVOID lpAddress, SIZE_T dwSize, DWORD dwFreeType);" },
];
const WIN32_UI_STUBS: readonly PlatformFunctionDecl[] = [
  { name: "IsBadCodePtr", decl: "BOOL IsBadCodePtr(FARPROC lpfn);" },
  { name: "IsBadReadPtr", decl: "BOOL IsBadReadPtr(const void* lp, UINT ucb);" },
  { name: "IsBadWritePtr", decl: "BOOL IsBadWritePtr(LPVOID lp, UINT ucb);" },
  { name: "CreateEventA", decl: "HANDLE CreateEventA(LPSECURITY_ATTRIBUTES lpEventAttributes, BOOL bManualReset, BOOL bInitialState, LPCSTR lpName);" },
  { name: "SetEvent", decl: "BOOL SetEvent(HANDLE hEvent);" },
  { name: "ResetEvent", decl: "BOOL ResetEvent(HANDLE hEvent);" },
  { name: "PostQuitMessage", decl: "void PostQuitMessage(int nExitCode);" },
  { name: "PostMessageA", decl: "BOOL PostMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam);" },
  { name: "GetSystemMetrics", decl: "int GetSystemMetrics(int nIndex);" },
  { name: "SetWindowPos", decl: "BOOL SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags);" },
  { name: "ShowWindow", decl: "BOOL ShowWindow(HWND hWnd, int nCmdShow);" },
  { name: "DestroyWindow", decl: "BOOL DestroyWindow(HWND hWnd);" },
  { name: "CreateWindowExA", decl: "HWND CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam);" },
  { name: "GetClientRect", decl: "BOOL GetClientRect(HWND hWnd, LPRECT lpRect);" },
  { name: "GetDC", decl: "HDC GetDC(HWND hWnd);" },
  { name: "ReleaseDC", decl: "int ReleaseDC(HWND hWnd, HDC hDC);" },
];
const CRT_EXTERN_STUBS: readonly PlatformFunctionDecl[] = [
  { name: "CRT_Floor", decl: "double CRT_Floor(...);" },
  { name: "CRT_Ceil", decl: "double CRT_Ceil(...);" },
  { name: "CRT_Strchr", decl: "char* CRT_Strchr(...);" },
  { name: "CRT_ClearFP", decl: "unsigned int CRT_ClearFP(...);" },
  { name: "_strrev", decl: "char* _strrev(char*);" },
  { name: "__strrev", decl: "char* __strrev(char*);" },
];
const WIN32_SYNC_FALLBACK_STUBS: readonly PlatformFunctionDecl[] = [
  { name: "CreateEventW", decl: "HANDLE CreateEventW(LPSECURITY_ATTRIBUTES lpEventAttributes, BOOL bManualReset, BOOL bInitialState, LPCWSTR lpName);" },
  { name: "WaitForMultipleObjects", decl: "DWORD WaitForMultipleObjects(DWORD nCount, const HANDLE* lpHandles, BOOL bWaitAll, DWORD dwMilliseconds);" },
  { name: "SendMessageA", decl: "LRESULT SendMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam);" },
];
const WIN32_FILE_FALLBACK_STUBS: readonly PlatformFunctionDecl[] = [
  { name: "WriteFile", decl: "BOOL WriteFile(HANDLE hFile, LPCVOID lpBuffer, DWORD nBytes, LPDWORD lpBytesWritten, LPOVERLAPPED lpOverlapped);" },
  { name: "ReadFile", decl: "BOOL ReadFile(HANDLE hFile, LPVOID lpBuffer, DWORD nBytes, LPDWORD lpBytesRead, LPOVERLAPPED lpOverlapped);" },
  { name: "CreateFileA", decl: "HANDLE CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode, LPSECURITY_ATTRIBUTES lpSec, DWORD dwCreationDisposition, DWORD dwFlagsAndAttributes, HANDLE hTemplate);" },
  { name: "SetFilePointer", decl: "DWORD SetFilePointer(HANDLE hFile, LONG lDistanceToMove, PLONG lpDistanceToMoveHigh, DWORD dwMoveMethod);" },
  { name: "GetFileSize", decl: "DWORD GetFileSize(HANDLE hFile, LPDWORD lpFileSizeHigh);" },
  { name: "GetFileAttributesA", decl: "DWORD GetFileAttributesA(LPCSTR lpFileName);" },
  { name: "GetModuleFileNameA", decl: "DWORD GetModuleFileNameA(HMODULE hModule, LPSTR lpFilename, DWORD nSize);" },
  { name: "GetLocalTime", decl: "void GetLocalTime(LPSYSTEMTIME lpSystemTime);" },
  { name: "GetCurrentProcess", decl: "HANDLE GetCurrentProcess();" },
  { name: "GetKeyState", decl: "SHORT GetKeyState(int nVirtKey);" },
  { name: "SetRect", decl: "void SetRect(LPRECT lprc, int left, int top, int right, int bottom);" },
  { name: "WSAGetLastError", decl: "int WSAGetLastError();" },
  { name: "timeGetTime", decl: "DWORD timeGetTime(void);" },
];

/**
 * Functions the platform header DEFINES rather than declares — the `static
 * inline` forwarders and the extra overloads that adapt Ghidra's spelling of an
 * argument to the vendor's (`int32_t*` to `LONG*`, `uint32_t*` to
 * `LPCRITICAL_SECTION`, `uint16_t*` to `wchar_t*`). Their bodies are written
 * inline above rather than as a table because each one carries a conversion, not
 * just a signature; only the names belong in the registry.
 */
const PLATFORM_INLINE_FORWARDERS: readonly string[] = [
  'InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange',
  'InterlockedCompareExchange',
  'MultiByteToWideChar', 'WideCharToMultiByte',
  'FloatToLong', 'LongToFloat',
  '__alldiv', '__allmul', '__allrem', '__alldvrm', '__allshr', '__allshl',
  '__aulldiv', '__aullrem', '__aullshr',
];

/**
 * CRT entry points the header maps to the real one with an object-like macro
 * (`#define _fclose fclose`). The call site writes the left-hand name and the
 * preprocessor hands the compiler the right-hand one, so the prototype that
 * actually binds is the C library's — never Ghidra's.
 */
const PLATFORM_MACRO_ALIASES: readonly string[] = [
  '_sprintf', '_memcpy', '_memset', '_memcmp', '_strlen', '_strcpy', '_strncpy',
  '_strcmp', '_strncmp', '_strcat', '_strncat', '_atoi', '_atol', '_sscanf',
  '_fprintf', '_printf', '_malloc', '_free', '_calloc', '_realloc', '_abs',
  'builtin_strncpy', 'builtin_memcpy', 'builtin_memset', 'builtin_strcmp',
  'builtin_strlen', 'builtin_strcpy',
  '__snprintf_s', '__snprintf', '_snprintf', '_vsnprintf', '_strncpy_s',
  '__stricmp', '_stricmp', '_strnicmp', '_strrchr', '_strtok', '_strcspn',
  '_fopen', '_fclose', '_fread', '_fwrite', '_ftell', '_fseek', '_fflush',
  '_fgets', '_fputs', '_time64', '_difftime64',
];

/**
 * Every callee whose declaration this emitter owns — the stub tables above, the
 * inline forwarders, the macro aliases, the excluded-namespace declarations in
 * `crt-mapping`, and the CRT/Win32 names a system header declares. Ghidra's
 * prototype for any of these is not the one the compiler will see, so nothing
 * may be cast to it.
 */
export function platformDeclaredFunctionNames(): Set<string> {
  const names = new Set<string>();
  for (const group of [
    WIN32_CORE_STUBS, WIN32_UI_STUBS, CRT_EXTERN_STUBS,
    WIN32_SYNC_FALLBACK_STUBS, WIN32_FILE_FALLBACK_STUBS,
  ]) {
    for (const d of group) names.add(d.name);
  }
  for (const n of PLATFORM_INLINE_FORWARDERS) names.add(n);
  for (const n of PLATFORM_MACRO_ALIASES) names.add(n);
  for (const d of EXCLUDED_SYMBOL_DECLS) names.add(d.emitted);
  for (const n of CRT_DECLARED_FUNCTION_NAMES) names.add(n);
  return names;
}

/**
 * The MSVC CRT `FILE` layout, claimed before any libc header can define it.
 *
 * Ghidra models the CRT stream object the way MSVC 6/7 declared it — `struct
 * _iobuf { char *_ptr; int _cnt; char *_base; int _flag; int _file; int
 * _charbuf; int _bufsiz; char *_tmpfname; }` — and D2 reaches into those
 * members directly (`FILETOOLS_ResetOffsets` writes a vftable through `_ptr`).
 * A UCRT toolchain declares the same struct as a single opaque `void
 * *_Placeholder`, so every one of those member reads fails to compile against
 * a type that is nominally the same.
 *
 * Both mingw-w64's `stdio.h` and its `mbstring.h` gate the declaration on
 * `_FILE_DEFINED`, so defining the struct first and claiming that guard makes
 * `FILE` resolve to the layout the binary was actually built against. Nothing
 * is masked: the members are the real ones, at their real offsets, and every
 * `<cstdio>` entry point still takes `FILE *` — the same `struct _iobuf *`.
 */
function msvcFileStructLines(): string[] {
  return [
    '// MSVC CRT stream layout (what Ghidra models and what D2 indexes into).',
    '// Claimed before <cstdio> so a UCRT toolchain cannot substitute its opaque',
    '// one-member _iobuf; FILE stays `struct _iobuf`, so the CRT calls still fit.',
    '#ifndef _FILE_DEFINED',
    '#define _FILE_DEFINED',
    'struct _iobuf {',
    '    char* _ptr;',
    '    int _cnt;',
    '    char* _base;',
    '    int _flag;',
    '    int _file;',
    '    int _charbuf;',
    '    int _bufsiz;',
    '    char* _tmpfname;',
    '};',
    'typedef struct _iobuf FILE;',
    '#endif',
    '',
  ];
}

export function generatePlatformHeader(
  options: {
    seedType?: boolean;
    anonymousAggregates?: string[];
    /** `in_addr` under Ghidra's names, claimed ahead of <winsock2.h>. */
    winsockInAddr?: string[];
  } = {},
): string {
  const lines: string[] = [];

  lines.push('// Auto-generated by ghidra-mcp — DO NOT EDIT');
  lines.push('//');
  lines.push('// Platform type definitions for cross-compilation support.');
  lines.push('// On Windows, pulls in windows.h; on other platforms, provides');
  lines.push('// minimal compatible typedefs.');
  lines.push('');
  lines.push('#pragma once');
  lines.push('');
  lines.push('// Core type aliases MUST come before system headers to prevent');
  lines.push('// std::byte (C++17) from shadowing our byte typedef');
  lines.push('typedef unsigned char byte;');
  lines.push('typedef unsigned int uint;');
  lines.push('typedef unsigned short ushort;');
  lines.push('typedef unsigned int ulong;');
  lines.push('');
  lines.push('#include <cstdint>');
  lines.push('#include <cstddef>');
  lines.push(...msvcFileStructLines());
  lines.push('#include <cstdio>');
  lines.push('#include <cstdarg>');
  lines.push('#include <cstring>');
  lines.push('#include <cstdlib>');
  lines.push('#include <cmath>');
  lines.push('#include <ctime>');
  lines.push('#include <cwchar>');
  lines.push('');
  lines.push('// MSVC _locale_t stub (not available on all platforms)');
  lines.push('#ifndef _WIN32');
  lines.push('typedef void* _locale_t;');
  lines.push('#endif');
  lines.push('');
  lines.push('// Ghidra-style lowercase type aliases (used throughout reconstructed code)');
  lines.push('// (byte, uint, ushort, ulong already defined above before system headers)');
  lines.push('typedef uint64_t ulonglong;');
  lines.push('typedef int64_t longlong;');
  lines.push('typedef uint8_t uchar;');
  lines.push('typedef void* pointer;');
  lines.push('typedef uint32_t pointer32;');
  lines.push('typedef uint32_t ImageBaseOffset32;');
  lines.push('typedef uint32_t undefined4;');
  lines.push('typedef uint16_t word;');
  lines.push('typedef uint32_t dword;');
  lines.push('typedef uint64_t qword;');
  lines.push('typedef int8_t sbyte;');
  lines.push('typedef int16_t sword;');
  lines.push('typedef int32_t sdword;');
  lines.push('typedef int64_t sqword;');
  lines.push('typedef long double float10;');
  lines.push('typedef uint16_t wchar16;');
  lines.push('typedef uint16_t unicode;');
  lines.push('typedef uint8_t undefined;');
  lines.push('typedef uint8_t undefined1;');
  lines.push('typedef uint16_t undefined2;');
  lines.push('typedef uint8_t undefined3;  // 3 bytes — no exact C type');
  // Ghidra's `vtable` is the (opaque) virtual function table STRUCT, so `vtable *`
  // is a single pointer. `typedef void* vtable` made `vtable *` a DOUBLE pointer
  // and disagreed with the struct-field mapping in header.ts, which renders the
  // same Ghidra type `vtable *` as `void *` — every field read into a `vtable *`
  // local was then "invalid conversion from 'void*' to 'void**'".
  lines.push('typedef void vtable;   // opaque virtual function table; `vtable *` == `void *`');
  lines.push('// Ghidra non-standard integer sizes (approximate to nearest C type)');
  lines.push('typedef int32_t int3;   // 3 bytes — Ghidra artifact, use int32_t');
  lines.push('typedef uint32_t uint3;  // 3 bytes — Ghidra artifact, use uint32_t');
  lines.push('typedef int32_t int5;   // 5 bytes — Ghidra artifact');
  lines.push('typedef uint64_t uint5;  // 5 bytes — Ghidra artifact');
  lines.push('typedef int32_t int6;   // 6 bytes — Ghidra artifact');
  lines.push('typedef uint64_t uint6;  // 6 bytes — Ghidra artifact');
  lines.push('typedef int32_t int7;   // 7 bytes — Ghidra artifact');
  lines.push('typedef float unkfloat1;');
  lines.push('typedef uint8_t unkbool1;');
  lines.push('typedef int code(...);  // Ghidra executable code type — code* = callable function pointer');
  lines.push('');
  // Decompiler pseudo-operations. Ghidra prints these where the instruction has
  // no C spelling; they are not symbols in the binary, so nothing else declares
  // them and every body that names one fails to compile. `NAN` arrives renamed
  // to `D2_IsNaN` — the Ghidra spelling collides with <cmath>'s object-like NAN
  // macro, which turns `NAN(x)` into a float constant applied to an argument.
  lines.push('// Ghidra decompiler pseudo-operations (no instruction-level C spelling)');
  lines.push('static inline bool D2_IsNaN(double x) { return x != x; }');
  lines.push('static inline void LOCK() {}    // x86 LOCK prefix — marks the atomic region');
  lines.push('static inline void UNLOCK() {}  // end of the region LOCK opened');
  lines.push('');
  // CPUID: Ghidra models the instruction as a pseudo-op per leaf, each returning
  // a POINTER to the four result registers — every body reads them back as
  // `*(uint32_t*)(r + 0|4|8|0xc)` == eax|ebx|ecx|edx. Reproduce that contract
  // rather than stub it: a stub returning zeroes would make CPU detection report
  // a vendorless CPU and every caller would silently take the wrong branch.
  lines.push('// Ghidra models CPUID as one pseudo-op per leaf, each returning a pointer to');
  lines.push('// the four result registers, read back as *(uint32_t*)(r + 0|4|8|0xc).');
  lines.push('#if defined(__GNUC__) && (defined(__i386__) || defined(__x86_64__))');
  lines.push('#  include <cpuid.h>');
  lines.push('#endif');
  lines.push('static inline int D2_Cpuid(uint32_t nLeaf) {');
  lines.push('  static uint32_t aRegs[4];');
  lines.push('#if defined(__GNUC__) && (defined(__i386__) || defined(__x86_64__))');
  lines.push('  __get_cpuid(nLeaf, &aRegs[0], &aRegs[1], &aRegs[2], &aRegs[3]);');
  lines.push('#elif defined(_MSC_VER)');
  lines.push('  __cpuid((int*)aRegs, (int)nLeaf);');
  lines.push('#else');
  lines.push('  aRegs[0] = aRegs[1] = aRegs[2] = aRegs[3] = 0;');
  lines.push('#endif');
  lines.push('  return (int)(uintptr_t)aRegs;');
  lines.push('}');
  for (const op of GHIDRA_CPUID_PSEUDO_OPS) {
    lines.push(`static inline int ${op}(uint32_t nLeaf) { return D2_Cpuid(nLeaf); }`);
  }
  lines.push('');
  lines.push('// __debugbreak stub for non-Windows (INT 3 debug breakpoint)');
  lines.push('#ifndef _WIN32');
  lines.push('#define __debugbreak() ((void)0)');
  lines.push('#endif');
  lines.push('');
  lines.push('#ifdef _WIN32');
  lines.push('#  ifndef WIN32_LEAN_AND_MEAN');
  lines.push('#    define WIN32_LEAN_AND_MEAN');
  lines.push('#  endif');
  if (options.winsockInAddr && options.winsockInAddr.length > 0) {
    lines.push(...options.winsockInAddr);
    lines.push('');
  }
  lines.push('#  include <windows.h>');
  lines.push('#  include <winsock2.h>');
  // Imports the reconstruction calls that <windows.h> alone does not declare.
  // The real SDK header is preferred over a hand-written prototype so the
  // signature and its dependent types come from the vendor, not from us.
  for (const h of EXTRA_WIN32_SDK_HEADERS) {
    lines.push(`#  include ${h}`);
  }
  // D2 declares its own functions whose names collide with <windows.h> A/W macros
  // (e.g. a renderer CreateWindow(HWND,int)). The macro expands the declaration to
  // an 11-arg CreateWindowExA call → "macro requires 11 arguments". Undef the macro
  // forms so D2's own functions of these names compile; the real Win32 entry points
  // remain reachable via their explicit ...ExA/...ExW / ...A / ...W names.
  for (const m of ['CreateWindow', 'CreateWindowA', 'CreateWindowW']) {
    lines.push(`#  ifdef ${m}`);
    lines.push(`#    undef ${m}`);
    lines.push(`#  endif`);
  }
  // Win32 Interlocked* take LONG*; D2 calls them with int32_t* (a distinct type on
  // i686). Add int32_t* overloads forwarding to the real LONG* intrinsics.
  lines.push('static inline LONG InterlockedIncrement(int32_t volatile* p) { return InterlockedIncrement((LONG volatile*)p); }');
  lines.push('static inline LONG InterlockedDecrement(int32_t volatile* p) { return InterlockedDecrement((LONG volatile*)p); }');
  // CriticalSection fns take LPCRITICAL_SECTION; D2 calls them with uint32_t*
  // (Ghidra typed the lock as a generic dword). Add forwarding overloads.
  lines.push('static inline void EnterCriticalSection(uint32_t* p) { EnterCriticalSection((LPCRITICAL_SECTION)p); }');
  lines.push('static inline void LeaveCriticalSection(uint32_t* p) { LeaveCriticalSection((LPCRITICAL_SECTION)p); }');
  lines.push('static inline void InitializeCriticalSection(uint32_t* p) { InitializeCriticalSection((LPCRITICAL_SECTION)p); }');
  lines.push('static inline void DeleteCriticalSection(uint32_t* p) { DeleteCriticalSection((LPCRITICAL_SECTION)p); }');
  // D2's own wide strings are uint16_t* (Ghidra's ushort, the one spelling the
  // decompiled bodies produce). The Win32 code-page converters take the true
  // wchar_t*. On i686 the two are the same 16 bits but distinct C++ types, so
  // give the converters uint16_t* overloads that forward to the real ones —
  // same pattern as the Interlocked*/CriticalSection overloads above. The real
  // wchar_t* declarations from windows.h stay intact.
  lines.push('static inline int MultiByteToWideChar(UINT cp, DWORD flags, LPCCH src, int srcLen, uint16_t* dst, int dstLen) {');
  lines.push('  return MultiByteToWideChar(cp, flags, src, srcLen, (LPWSTR)dst, dstLen);');
  lines.push('}');
  lines.push('static inline int WideCharToMultiByte(UINT cp, DWORD flags, const uint16_t* src, int srcLen, LPSTR dst, int dstLen, LPCCH dflt, LPBOOL usedDflt) {');
  lines.push('  return WideCharToMultiByte(cp, flags, (LPCWCH)src, srcLen, dst, dstLen, dflt, usedDflt);');
  lines.push('}');
  lines.push('#else');
  lines.push('');

  // Scalar typedefs
  lines.push('// Scalar types');
  lines.push('typedef int BOOL;');
  lines.push('typedef unsigned char BYTE;');
  lines.push('typedef unsigned short WORD;');
  lines.push('typedef unsigned long DWORD;');
  lines.push('typedef unsigned long long QWORD;');
  lines.push('typedef char CHAR;');
  lines.push('typedef uint16_t WCHAR;');
  lines.push('typedef char TCHAR;');
  lines.push('typedef long LONG;');
  lines.push('typedef unsigned long ULONG;');
  lines.push('typedef short SHORT;');
  lines.push('typedef unsigned short USHORT;');
  lines.push('typedef int INT;');
  lines.push('typedef unsigned int UINT;');
  lines.push('typedef long long LONGLONG;');
  lines.push('typedef unsigned long long ULONGLONG;');
  lines.push('typedef size_t SIZE_T;');
  lines.push('typedef intptr_t SSIZE_T;');
  lines.push('typedef uintptr_t DWORD_PTR;');
  lines.push('typedef uintptr_t ULONG_PTR;');
  lines.push('typedef WORD LANGID;');
  lines.push('typedef long HRESULT;');
  lines.push('typedef unsigned short ATOM;');
  lines.push('');

  // Pointer/handle types
  lines.push('// Pointer and handle types');
  lines.push('typedef void* LPVOID;');
  lines.push('typedef const void* LPCVOID;');
  lines.push('typedef void* PVOID;');
  lines.push('typedef void* HANDLE;');
  lines.push('typedef void* HMODULE;');
  lines.push('typedef void* HINSTANCE;');
  lines.push('typedef void* HWND;');
  lines.push('typedef void* HDC;');
  lines.push('typedef void* HBITMAP;');
  lines.push('typedef void* HFONT;');
  lines.push('typedef void* HBRUSH;');
  lines.push('typedef void* HPEN;');
  lines.push('typedef void* HKEY;');
  lines.push('typedef void* HCURSOR;');
  lines.push('typedef void* HICON;');
  lines.push('typedef void* HMENU;');
  lines.push('typedef void* HPALETTE;');
  lines.push('typedef void* HRGN;');
  lines.push('typedef void* HRSRC;');
  lines.push('typedef void* HGLOBAL;');
  lines.push('typedef intptr_t LRESULT;');
  lines.push('typedef uintptr_t WPARAM;');
  lines.push('typedef intptr_t LPARAM;');
  lines.push('typedef uint16_t LANGID;');
  lines.push('typedef void (*FARPROC)();');
  lines.push('');

  // String pointer types
  lines.push('// String pointer types');
  lines.push('typedef char* LPSTR;');
  lines.push('typedef const char* LPCSTR;');
  lines.push('typedef WCHAR* LPWSTR;');
  lines.push('typedef const WCHAR* LPCWSTR;');
  lines.push('typedef BYTE* LPBYTE;');
  lines.push('typedef DWORD* LPDWORD;');
  lines.push('typedef int* LPINT;');
  lines.push('typedef unsigned char UCHAR;');
  lines.push('typedef unsigned short u_short;');
  lines.push('typedef void (*WNDPROC)(HWND, UINT, WPARAM, LPARAM);');
  lines.push('typedef DWORD (*PTHREAD_START_ROUTINE)(LPVOID);');
  lines.push('typedef PTHREAD_START_ROUTINE LPTHREAD_START_ROUTINE;');
  lines.push('typedef void* LPSERVICE_STATUS;');
  lines.push('');

  // Minimal struct definitions
  lines.push('// Minimal struct definitions');
  lines.push('struct CRITICAL_SECTION { void* DebugInfo; long LockCount; long RecursionCount; void* OwningThread; void* LockSemaphore; unsigned long SpinCount; };');
  lines.push('typedef CRITICAL_SECTION* LPCRITICAL_SECTION;');
  lines.push('struct POINT { long x; long y; };');
  lines.push('typedef POINT* LPPOINT;');
  lines.push('struct RECT { long left; long top; long right; long bottom; };');
  lines.push('typedef RECT* LPRECT;');
  lines.push('struct FILETIME { DWORD dwLowDateTime; DWORD dwHighDateTime; };');
  lines.push('typedef FILETIME* LPFILETIME;');
  lines.push('struct GUID { DWORD Data1; WORD Data2; WORD Data3; BYTE Data4[8]; };');
  lines.push('struct OVERLAPPED { DWORD Internal; DWORD InternalHigh; DWORD Offset; DWORD OffsetHigh; HANDLE hEvent; };');
  lines.push('typedef OVERLAPPED* LPOVERLAPPED;');
  lines.push('');

  // Palette entry (needed by some rendering code)
  lines.push('struct PALETTEENTRY { BYTE peRed; BYTE peGreen; BYTE peBlue; BYTE peFlags; };');
  lines.push('typedef PALETTEENTRY* LPPALETTEENTRY;');
  lines.push('');

  // Underscore-prefixed struct aliases (Ghidra sometimes uses these)
  lines.push('typedef FILETIME _FILETIME;');
  lines.push('typedef OVERLAPPED _OVERLAPPED;');
  lines.push('struct MEMORYSTATUS { DWORD dwLength; DWORD dwMemoryLoad; SIZE_T dwTotalPhys; SIZE_T dwAvailPhys; SIZE_T dwTotalPageFile; SIZE_T dwAvailPageFile; SIZE_T dwTotalVirtual; SIZE_T dwAvailVirtual; };');
  lines.push('typedef MEMORYSTATUS _MEMORYSTATUS;');
  lines.push('struct SYSTEMTIME { WORD wYear; WORD wMonth; WORD wDayOfWeek; WORD wDay; WORD wHour; WORD wMinute; WORD wSecond; WORD wMilliseconds; };');
  lines.push('typedef SYSTEMTIME _SYSTEMTIME;');
  lines.push('struct SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; };');
  lines.push('typedef SECURITY_ATTRIBUTES _SECURITY_ATTRIBUTES;');
  lines.push('typedef SECURITY_ATTRIBUTES* LPSECURITY_ATTRIBUTES;');
  lines.push('typedef MEMORYSTATUS* LPMEMORYSTATUS;');
  lines.push('typedef SYSTEMTIME* LPSYSTEMTIME;');
  lines.push('typedef LONG* PLONG;');
  lines.push('union _LARGE_INTEGER { struct { DWORD LowPart; long HighPart; } s; long long QuadPart; };');
  lines.push('typedef _LARGE_INTEGER LARGE_INTEGER;');
  lines.push('typedef RECT tagRECT;');
  lines.push('');

  // Network types
  lines.push('// Network types');
  lines.push('typedef int SOCKET;');
  lines.push('typedef unsigned long u_long;');
  lines.push('');

  // (3dfx Glide types moved out of the !_WIN32 branch — see below. They are a
  //  third-party renderer API, not part of the Win32 SDK, so they must always
  //  be defined regardless of platform.)

  // Thread context
  lines.push('// Thread context (minimal stub)');
  lines.push('struct CONTEXT { DWORD ContextFlags; };');
  lines.push('typedef CONTEXT* LPCONTEXT;');
  lines.push('');

  // Common Win32 API function declarations
  lines.push('// Common Win32 API function stubs');
  lines.push('extern "C" {');
  for (const d of WIN32_CORE_STUBS) lines.push(d.decl);
  lines.push('}');
  lines.push('');

  // Additional Win32 APIs
  for (const d of WIN32_UI_STUBS) lines.push(d.decl);
  lines.push('');

  lines.push('#endif // _WIN32');
  lines.push('');

  // 3dfx Glide types (used by Diablo 2's Glide renderer) — a third-party API,
  // NOT part of the Win32 SDK, so always defined on every platform.
  lines.push('// 3dfx Glide API types');
  lines.push('typedef float FxFloat;');
  lines.push('typedef int FxI32;');
  lines.push('typedef unsigned int FxU32;');
  lines.push('typedef short FxI16;');
  lines.push('typedef unsigned short FxU16;');
  lines.push('typedef int FxBool;');
  lines.push('typedef unsigned int GrAlphaBlendFnc_t;');
  lines.push('typedef unsigned int GrAlpha_t;');
  lines.push('typedef unsigned int GrAspectRatio_t;');
  lines.push('typedef unsigned int GrBuffer_t;');
  lines.push('typedef unsigned int GrChipID_t;');
  lines.push('typedef unsigned int GrChromakeyMode_t;');
  lines.push('typedef unsigned int GrCmpFnc_t;');
  lines.push('typedef unsigned int GrColorFormat_t;');
  lines.push('typedef unsigned int GrColor_t;');
  lines.push('typedef unsigned int GrCombineFactor_t;');
  lines.push('typedef unsigned int GrCombineFunction_t;');
  lines.push('typedef unsigned int GrCombineLocal_t;');
  lines.push('typedef unsigned int GrCombineOther_t;');
  lines.push('typedef unsigned int GrContext_t;');
  lines.push('typedef unsigned int GrCoordinateSpaceMode_t;');
  lines.push('typedef unsigned int GrDepthBufferMode_t;');
  lines.push('typedef unsigned int GrDitherMode_t;');
  lines.push('typedef unsigned int GrEnableMode_t;');
  lines.push('typedef unsigned int GrLOD_t;');
  lines.push('typedef unsigned int GrLfbWriteMode_t;');
  lines.push('typedef unsigned int GrLock_t;');
  lines.push('typedef unsigned int GrMipMapMode_t;');
  lines.push('typedef unsigned int GrOriginLocation_t;');
  lines.push('typedef unsigned int GrScreenRefresh_t;');
  lines.push('typedef unsigned int GrScreenResolution_t;');
  lines.push('typedef unsigned int GrTexTable_t;');
  lines.push('typedef unsigned int GrTextureFilterMode_t;');
  lines.push('typedef unsigned int GrTextureFormat_t;');
  lines.push('struct GrLfbInfo_t { int size; void* lfbPtr; uint32_t strideInBytes; };');
  lines.push('struct GrTexInfo { GrLOD_t smallLodLog2; GrLOD_t largeLodLog2; GrAspectRatio_t aspectRatioLog2; GrTextureFormat_t format; void* data; };');
  lines.push('typedef void (*GrProc)();');
  lines.push('');

  // MSVC underscore-prefixed CRT aliases
  lines.push('// MSVC underscore-prefixed CRT aliases');
  lines.push('#define _sprintf sprintf');
  lines.push('#define _memcpy memcpy');
  lines.push('#define _memset memset');
  lines.push('#define _memcmp memcmp');
  lines.push('#define _strlen strlen');
  lines.push('#define _strcpy strcpy');
  lines.push('#define _strncpy strncpy');
  lines.push('#define _strcmp strcmp');
  lines.push('#define _strncmp strncmp');
  lines.push('#define _strcat strcat');
  lines.push('#define _strncat strncat');
  lines.push('#define _atoi atoi');
  lines.push('#define _atol atol');
  lines.push('#define _sscanf sscanf');
  lines.push('#define _fprintf fprintf');
  lines.push('#define _printf printf');
  lines.push('#define _malloc malloc');
  lines.push('#define _free free');
  lines.push('#define _calloc calloc');
  lines.push('#define _realloc realloc');
  lines.push('#define _abs abs');
  lines.push('');

  // Ghidra placeholder constants for immediates it could not resolve (an
  // "unknown" float / id). They are decompiler artifacts with no real value;
  // define them so the bodies compile (placeholder zero).
  lines.push('// Ghidra unresolved-immediate placeholders');
  lines.push('#define FLOAT_UNKNOWN 0.0f');
  lines.push('#define GL_ID_UNKNOWN 0');
  lines.push('');

  // Ghidra builtin_ prefixed functions
  lines.push('// Ghidra builtin_ prefixed functions');
  lines.push('#define builtin_strncpy strncpy');
  lines.push('#define builtin_memcpy memcpy');
  lines.push('#define builtin_memset memset');
  lines.push('#define builtin_strcmp strcmp');
  lines.push('#define builtin_strlen strlen');
  lines.push('#define builtin_strcpy strcpy');
  lines.push('');

  // Ghidra ROUND intrinsic: rounds a floating-point value to the nearest integer
  // value (kept as floating-point). Maps to <cmath> round().
  lines.push('// Ghidra ROUND intrinsic (round-to-nearest, result stays floating-point)');
  lines.push('#define ROUND(x) round(x)');
  lines.push('');

  // Statically-linked CRT functions Ghidra named with a `CRT_` prefix that the
  // reconstruction does NOT rebuild (we don't reconstruct the C runtime). Their
  // call sites survive (often with mangled x87/FP argument lists), so declare them
  // as variadic externs — enough to compile; they resolve to the real CRT at link.
  lines.push('// External statically-linked CRT functions (Ghidra `CRT_`-prefixed, not reconstructed)');
  lines.push('extern "C" {');
  for (const d of CRT_EXTERN_STUBS) lines.push(d.decl);
  lines.push('}');
  lines.push('');

  lines.push('');


  // Ghidra CONCAT macros (byte concatenation intrinsics)
  lines.push('// Ghidra CONCAT macros — CONCATmn concatenates m-byte and n-byte values');
  lines.push('#define CONCAT11(a, b) ((uint16_t)(((uint16_t)(uint8_t)(a) << 8) | (uint8_t)(b)))');
  lines.push('#define CONCAT12(a, b) ((uint32_t)(((uint32_t)(uint8_t)(a) << 16) | (uint16_t)(b)))');
  lines.push('#define CONCAT13(a, b) ((uint32_t)(((uint32_t)(uint8_t)(a) << 24) | ((uint32_t)(b) & 0xFFFFFF)))');
  lines.push('#define CONCAT21(a, b) ((uint32_t)(((uint32_t)(uint16_t)(a) << 8) | (uint8_t)(b)))');
  lines.push('#define CONCAT22(a, b) ((uint32_t)(((uint32_t)(uint16_t)(a) << 16) | (uint16_t)(b)))');
  lines.push('#define CONCAT31(a, b) ((uint32_t)(((uint32_t)(a) << 8) | (uint8_t)(b)))');
  lines.push('#define CONCAT44(a, b) ((uint64_t)(((uint64_t)(uint32_t)(a) << 32) | (uint32_t)(b)))');
  lines.push('#define CONCAT14(a, b) ((uint64_t)(((uint64_t)(uint8_t)(a) << 32) | (uint32_t)(b)))');
  lines.push('#define CONCAT41(a, b) ((uint64_t)(((uint64_t)(uint32_t)(a) << 8) | (uint8_t)(b)))');
  lines.push('#define CONCAT24(a, b) ((uint64_t)(((uint64_t)(uint16_t)(a) << 32) | (uint32_t)(b)))');
  lines.push('#define CONCAT42(a, b) ((uint64_t)(((uint64_t)(uint32_t)(a) << 16) | (uint16_t)(b)))');
  lines.push('');

  // Ghidra SUB macros (byte extraction — SUBmn extracts n bytes at position from m-byte value)
  lines.push('// Ghidra SUB macros — SUBmn extracts n-byte sub-value from m-byte value');
  lines.push('#define SUB41(x, n) ((uint8_t)((uint32_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB42(x, n) ((uint16_t)((uint32_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB43(x, n) ((uint32_t)((uint32_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB84(x, n) ((uint32_t)((uint64_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB82(x, n) ((uint16_t)((uint64_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB81(x, n) ((uint8_t)((uint64_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB21(x, n) ((uint8_t)((uint16_t)(x) >> ((n) * 8)))');
  lines.push('#define SUB14(x, n) ((uint8_t)((uint32_t)(x) >> ((n) * 8)))');
  lines.push('');

  // Ghidra zero/sign extension macros
  lines.push('// Ghidra zero/sign extension macros');
  lines.push('#define ZEXT14(x) ((uint32_t)(uint8_t)(x))');
  lines.push('#define ZEXT24(x) ((uint32_t)(uint16_t)(x))');
  lines.push('#define ZEXT48(x) ((uint64_t)(uint32_t)(x))');
  lines.push('#define SEXT14(x) ((int32_t)(int8_t)(x))');
  lines.push('#define SEXT24(x) ((int32_t)(int16_t)(x))');
  lines.push('#define SEXT48(x) ((int64_t)(int32_t)(x))');
  lines.push('');

  // Ghidra pseudo-operations — instructions the decompiler cannot express in C
  // and calls out by name instead. They reach bodies exactly as written, so they
  // need a definition, not a declaration; each is what the instruction does.
  lines.push('// Ghidra pseudo-operations (instructions with no C spelling)');
  lines.push('#define ABS(x) ((x) < 0 ? -(x) : (x))');
  lines.push('static inline uint64_t rdtsc(void) {');
  lines.push('#if defined(__GNUC__) && (defined(__i386__) || defined(__x86_64__))');
  lines.push('  uint32_t nLow, nHigh;');
  lines.push('  __asm__ __volatile__("rdtsc" : "=a"(nLow), "=d"(nHigh));');
  lines.push('  return ((uint64_t)nHigh << 32) | nLow;');
  lines.push('#else');
  lines.push('  return 0;');
  lines.push('#endif');
  lines.push('}');
  lines.push('// `swi(n)` is INT n. Ghidra models it as returning the handler address the');
  lines.push('// body then calls; there is no such value at runtime, so the trap is raised');
  lines.push('// and a null handler returned rather than pretending otherwise.');
  lines.push('static inline void* swi(int nVector) {');
  lines.push('#if defined(__GNUC__) && (defined(__i386__) || defined(__x86_64__))');
  lines.push('  if (nVector == 3) __asm__ __volatile__("int3");');
  lines.push('#else');
  lines.push('  (void)nVector;');
  lines.push('#endif');
  lines.push('  return nullptr;');
  lines.push('}');
  lines.push('');

  // Ghidra carry/borrow detection macros
  lines.push('// Ghidra carry/borrow detection');
  lines.push('#define CARRY4(a, b) ((uint32_t)(a) + (uint32_t)(b) < (uint32_t)(a))');
  lines.push('#define CARRY2(a, b) ((uint16_t)(a) + (uint16_t)(b) < (uint16_t)(a))');
  lines.push('#define CARRY1(a, b) ((uint8_t)(a) + (uint8_t)(b) < (uint8_t)(a))');
  lines.push('#define SBORROW4(a, b) ((int32_t)((uint32_t)(a) ^ (uint32_t)(b)) < 0 && (int32_t)((uint32_t)(a) ^ ((uint32_t)(a) - (uint32_t)(b))) < 0)');
  lines.push('#define SBORROW2(a, b) ((int16_t)((uint16_t)(a) ^ (uint16_t)(b)) < 0 && (int16_t)((uint16_t)(a) ^ ((uint16_t)(a) - (uint16_t)(b))) < 0)');
  lines.push('');

  // Diablo 2 PRNG (Linear Congruential Generator) macros. These name D2SeedStrc, so
  // they only make sense for a binary that actually has that type.
  if (options.seedType) {
    lines.push('// Diablo 2 PRNG — LCG with multiplier 0x6AC690C5');
    lines.push('#define D2_SEED_NEXT(seed) ((D2SeedStrc)((uint64_t)(uint32_t)(seed).nSeedLow * 0x6ac690c5u + (uint64_t)(uint32_t)(seed).nSeedHigh))');
    lines.push('#define D2_SEED_NEXT_VAL(sv) ((D2SeedStrc)((uint64_t)(uint32_t)(sv) * 0x6ac690c5u + ((uint64_t)(sv) >> 32)))');
    lines.push('');
  }

  // Ghidra type conversion helpers
  lines.push('// Ghidra type conversion helpers');
  lines.push('static inline int32_t FloatToLong(float f) { return (int32_t)f; }');
  lines.push('static inline float LongToFloat(int32_t n) { return (float)n; }');
  lines.push('');

  // MSVC 64-bit integer intrinsics (compiler builtins on x86)
  lines.push('// MSVC 64-bit integer intrinsics');
  lines.push('static inline int64_t __alldiv(int64_t a, int64_t b) { return a / b; }');
  lines.push('static inline int64_t __alldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) / (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }');
  lines.push('static inline int64_t __allmul(int64_t a, int64_t b) { return a * b; }');
  lines.push('static inline int64_t __allmul(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) * (int64_t)(lo2 | ((uint64_t)hi2 << 32)); }');
  lines.push('static inline int64_t __allrem(int64_t a, int64_t b) { return a % b; }');
  lines.push('static inline int64_t __alldvrm(uint32_t lo1, uint32_t hi1, uint32_t lo2, int hi2) { return (int64_t)(lo1 | ((uint64_t)hi1 << 32)) / (int64_t)(lo2 | ((uint64_t)(uint32_t)hi2 << 32)); }');
  lines.push('static inline int64_t __allshr(int64_t a, int n) { return a >> n; }');
  lines.push('static inline int64_t __allshl(int64_t a, int n) { return a << n; }');
  lines.push('static inline uint64_t __aulldiv(uint64_t a, uint64_t b) { return a / b; }');
  lines.push('static inline uint64_t __aulldiv(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) / (lo2 | ((uint64_t)hi2 << 32)); }');
  lines.push('static inline uint64_t __aullrem(uint64_t a, uint64_t b) { return a % b; }');
  lines.push('static inline uint64_t __aullrem(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) % (lo2 | ((uint64_t)hi2 << 32)); }');
  lines.push('static inline uint64_t __aullshr(uint64_t a, unsigned int n) { return a >> n; }');
  lines.push('');

  // Additional Win32 APIs and Interlocked functions
  lines.push('#ifndef _WIN32');
  lines.push('static inline LONG InterlockedIncrement(volatile LONG* p) { return ++(*p); }');
  lines.push('static inline LONG InterlockedDecrement(volatile LONG* p) { return --(*p); }');
  lines.push('static inline LONG InterlockedExchange(volatile LONG* p, LONG v) { LONG old = *p; *p = v; return old; }');
  lines.push('static inline LONG InterlockedCompareExchange(volatile LONG* p, LONG exchange, LONG comparand) { LONG old = *p; if (*p == comparand) *p = exchange; return old; }');
  lines.push('// Overloads for int32_t* (Ghidra decompiler uses int32_t instead of LONG)');
  lines.push('static inline int32_t InterlockedIncrement(volatile int32_t* p) { return ++(*p); }');
  lines.push('static inline int32_t InterlockedDecrement(volatile int32_t* p) { return --(*p); }');
  for (const d of WIN32_SYNC_FALLBACK_STUBS) lines.push(d.decl);
  lines.push('#endif');
  lines.push('');

  // Ghidra decompiler helper: converts ECX:EDX register pair to long via double
  lines.push('static inline uint32_t FloatToLong(int32_t lo, int32_t hi) {');
  lines.push('  union { struct { int32_t lo; int32_t hi; } parts; double d; } u;');
  lines.push('  u.parts.lo = lo; u.parts.hi = hi;');
  lines.push('  return (uint32_t)(int32_t)u.d;');
  lines.push('}');
  lines.push('');

  // MSVC secure CRT and snprintf variants
  lines.push('// MSVC secure CRT variants');
  lines.push('#define __snprintf_s(buf, size, count, ...) snprintf(buf, size, __VA_ARGS__)');
  lines.push('#define __snprintf snprintf');
  lines.push('#define _snprintf snprintf');
  lines.push('#define _vsnprintf vsnprintf');
  lines.push('#define _strncpy_s(dst, dsz, src, cnt) strncpy(dst, src, cnt)');
  lines.push('#define __stricmp strcasecmp');
  lines.push('#define _stricmp strcasecmp');
  lines.push('#define _strnicmp strncasecmp');
  lines.push('#define _strrchr strrchr');
  lines.push('#define _strtok strtok');
  lines.push('#define _strcspn strcspn');
  lines.push('#define _fopen fopen');
  lines.push('#define _fclose fclose');
  lines.push('#define _fread fread');
  lines.push('#define _fwrite fwrite');
  lines.push('#define _ftell ftell');
  lines.push('#define _fseek fseek');
  lines.push('#define _fflush fflush');
  lines.push('#define _fgets fgets');
  lines.push('#define _fputs fputs');
  lines.push('#define _time64 time');
  lines.push('#define _difftime64 difftime');
  lines.push('');

  // More Win32 file/system APIs
  lines.push('#ifndef _WIN32');
  for (const d of WIN32_FILE_FALLBACK_STUBS) lines.push(d.decl);
  lines.push('#endif');
  lines.push('');

  // Win32 PE/IMM/shell types — the real <windows.h> provides these, so only
  // stub them when building without the platform SDK (non-_WIN32).
  lines.push('#ifndef _WIN32');
  lines.push('typedef void* PRTL_CRITICAL_SECTION_DEBUG;');
  lines.push('struct HIMC__ { int unused; };');
  lines.push('struct WIN32_FIND_DATA { char cFileName[260]; };');
  lines.push('struct IMAGE_DOS_HEADER { WORD e_magic; };');
  lines.push('struct IMAGE_NT_HEADERS { DWORD Signature; };');
  lines.push('struct IMAGE_SECTION_HEADER { char Name[8]; };');
  lines.push('struct tagWINDOWPLACEMENT { UINT length; UINT flags; UINT showCmd; POINT ptMinPosition; POINT ptMaxPosition; RECT rcNormalPosition; };');
  lines.push('typedef tagWINDOWPLACEMENT WINDOWPLACEMENT;');
  lines.push('typedef GUID IID;');
  lines.push('#endif // _WIN32');
  lines.push('');
  // Itanium/GCC unwind ABI types — not provided by <windows.h>; always defined.
  lines.push('typedef int _Unwind_Reason_Code;');
  lines.push('struct _Unwind_Exception { uint64_t exception_class; void (*exception_cleanup)(_Unwind_Reason_Code, struct _Unwind_Exception *); uint64_t private_1; uint64_t private_2; };');
  lines.push('');

  // MSVC C++ exception-handling frame types. Not declared by any real header;
  // they appear only as parameter types of the EH personality routine below.
  lines.push('// MSVC C++ EH frame types (opaque — only ever used through a pointer)');
  lines.push('struct EHExceptionRecord;');
  lines.push('struct EHRegistrationNode;');
  lines.push('');

  // Declarations for the Ghidra namespaces run.ts excludes from emission.
  lines.push(...generateExcludedSymbolDecls());

  // Ghidra's placeholder names for the ANONYMOUS aggregates inside a system
  // struct (`in_addr`'s unnamed union is `_union_1226`). No real header ever
  // declares those names, yet decompiled bodies cast through them and read their
  // fields — so this is the only place they can come from.
  if (options.anonymousAggregates && options.anonymousAggregates.length > 0) {
    lines.push('// Anonymous aggregates of system structs, under the names Ghidra gave them');
    for (const def of options.anonymousAggregates) {
      lines.push(def);
      lines.push('');
    }
  }

  // Include shared enum definitions (all Ghidra enum types collected into one file)
  lines.push('// Shared enum constants (SOUND_NONE, UNIT_PLAYER, SKILL_Attack, etc.)');
  lines.push('#include "d2_enums.h"');
  lines.push('');

  return lines.join('\n');
}

/**
 * Project type names that are ALSO emitted as a namespace component.
 *
 * Ghidra hangs a class's vtable data and its member functions under a namespace
 * named after the class (`D2Client::ButtonWrapper`, `D2Client::Draw`), and the
 * generator emits that namespace. The struct/typedef of the same name is emitted
 * at ROOT scope. Inside `namespace D2Client { ... }` unqualified lookup for
 * `ButtonWrapper` then finds the NAMESPACE first and stops:
 *
 *     namespace D2Client {
 *       void F(ButtonWrapper * pThis) { ... }   // error: 'ButtonWrapper' is not a type
 *       pwszCursor = (Draw**)...;               // error: expected primary-expression
 *     }
 *
 * The type must be spelled root-qualified (`::ButtonWrapper`) at every use site.
 * Only names that really are both a namespace component and a root-scope type
 * are listed, so nothing else is touched.
 */
let shadowedTypeNames: Set<string> | undefined;

export function setShadowedTypeNames(names: Set<string> | undefined): void {
  shadowedTypeNames = names && names.size > 0 ? names : undefined;
}

export function getShadowedTypeNames(): Set<string> | undefined {
  return shadowedTypeNames;
}

/**
 * Root-qualify the base name of a Ghidra type string when it is shadowed by a
 * same-named namespace. `ButtonWrapper *` → `::ButtonWrapper *`,
 * `struct Item *` → `struct ::Item *`. Already-qualified names, names with no
 * base identifier, and unshadowed names come back unchanged.
 */
export function rootQualifyShadowedType(type: string): string {
  if (!shadowedTypeNames || !type) return type;
  if (type.includes('::')) return type;
  const m = type.match(
    /^(\s*(?:(?:const|volatile)\s+)*(?:(?:struct|class|union|enum)\s+)?)([A-Za-z_]\w*)\b([\s\S]*)$/
  );
  if (!m) return type;
  if (!shadowedTypeNames.has(m[2])) return type;
  return `${m[1]}::${m[2]}${m[3]}`;
}


/**
 * Ghidra's spellings for a `void`-pointer slot. `pointer` is its own alias
 * (`typedef void* pointer`), and the Win32 SDK ones reach the emitter unexpanded.
 * A function address stored in any of them needs the same explicit `(void*)`.
 */
const VOID_POINTER_SPELLINGS = new Set<string>([
  'void*', 'pointer', 'LPVOID', 'PVOID', 'LPCVOID',
]);

/**
 * Typedefs `d2_platform.h` writes ITSELF, whose target is a pointer, mapped to
 * what the emitted line actually says.
 *
 * Ghidra records `pointer` as a POINTER data type, not as a TYPEDEF, so it never
 * reaches the typedef map the cast passes read — and every one of them then
 * treats a `pointer` slot as a star-less integer, which is exactly the shape
 * that needs no cast. A funcdef declaring seven `pointer` parameters therefore
 * types nothing at all, however well the funcdef itself is resolved.
 *
 * Only pointer-valued aliases belong here: an alias for an integer (`pointer32`
 * really is `uint32_t`) is already reduced correctly by name.
 */
export const EMITTER_POINTER_TYPEDEFS: Record<string, string> = {
  pointer: 'void *',
  _locale_t: 'void *',
};

/** Does this Ghidra type string denote a plain `void`-pointer slot? */
export function isVoidPointerSpelling(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.replace(/\bconst\b/g, '').replace(/\s+/g, '').trim();
  return VOID_POINTER_SPELLINGS.has(t);
}

/**
 * The name a parameter is emitted under, given its already-rendered type.
 *
 * `eD2ItemFlag eD2ItemFlag` is not a declaration a body can then name — the
 * parameter hides its own type — so such a parameter is emitted as `n<name>`.
 *
 * The comparison has to ignore a leading `::`. The rule lived in three places
 * and only ONE of them stripped it, so as soon as a parameter's type became
 * root-qualified (`::fpRequiredUserAction`, once a same-named function shadowed
 * it) the body renamed the parameter and the two signature emitters did not:
 * the declaration said `fpRequiredUserAction` and the body said
 * `nfpRequiredUserAction`. One rule, one implementation.
 */
export function emittedParameterName(name: string, renderedType: string): string {
  const baseType = renderedType
    .replace(/\s*[*&]+\s*$/, '')
    .replace(/^(struct|class|union|enum)\s+/, '')
    .replace(/^::/, '')
    .trim();
  return name === baseType ? `n${name}` : name;
}

/**
 * Every type name that names a struct or a union — the STRUCTURE/UNION data
 * types themselves plus every typedef whose chain ends at one.
 *
 * `struct-field` needs this to decide whether `((T*)base)->field_N` can compile
 * at all. It used to decide from a regex over Ghidra's primitive spellings, which
 * knows nothing about Win32: `HANDLE` is `void *`, `SOCKET` is `uint`,
 * `PRTL_CRITICAL_SECTION_DEBUG` is a pointer, and each of them slipped through as
 * "might be a struct" and got a `field_10` that nothing declares. Resolving the
 * typedef chain answers the question instead of guessing at it.
 */
let aggregateTypeNames: Set<string> | undefined;

export function setAggregateTypeNames(
  dataTypes: Array<{ name: string; kind?: string; underlyingType?: string }>,
): void {
  const aggregates = new Set<string>();
  const typedefTargets = new Map<string, string>();
  for (const dt of dataTypes) {
    if (!dt.name) continue;
    if (dt.kind === 'STRUCTURE' || dt.kind === 'UNION') aggregates.add(dt.name);
    else if (dt.kind === 'TYPEDEF' && dt.underlyingType) {
      typedefTargets.set(dt.name, dt.underlyingType);
    }
  }
  // Follow each typedef to its end. A target carrying a `*` or a `[` is a pointer
  // or an array, never an aggregate lvalue, so the chain stops there.
  const resolveToAggregate = (name: string): boolean => {
    let cur = name;
    for (let depth = 0; depth < 16; depth++) {
      if (aggregates.has(cur)) return true;
      const target = typedefTargets.get(cur);
      if (!target) return false;
      const base = target.replace(/\b(const|volatile|struct|union)\b/g, '').trim();
      if (base.includes('*') || base.includes('[')) return false;
      cur = base;
    }
    return false;
  };
  for (const name of typedefTargets.keys()) {
    if (resolveToAggregate(name)) aggregates.add(name);
  }
  aggregateTypeNames = aggregates.size > 0 ? aggregates : undefined;
}

export function getAggregateTypeNames(): Set<string> | undefined {
  return aggregateTypeNames;
}

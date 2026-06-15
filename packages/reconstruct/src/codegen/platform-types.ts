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
]);

/** System-header category path, e.g. `/winsock.h`, `/inaddr.h`, `/WinDef.h` */
const SYSTEM_HEADER_CATEGORY_RE = /^\/[A-Za-z0-9_]+\.h$/;

/**
 * MSVC C++ exception-handling internal type (FuncInfo, UnwindMapEntry, ...).
 * Unlike Win32 SDK types (RGBQUAD, SYSTEMTIME), these are NOT declared by any
 * real header (windows.h/CRT) — so anything typed as one cannot compile and
 * must be dropped, not merely left to the SDK.
 */
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
export function isLibraryType(name: string, category: string): boolean {
  if (SYSTEM_HEADER_CATEGORY_RE.test(category)) return true;
  if (EH_INTERNAL_TYPES.has(name)) return true;
  return false;
}

// =============================================================================
// Type Checking
// =============================================================================

/**
 * Check if a type name is a platform, standard, or Ghidra artifact type
 * that should never be emitted as a typedef/struct or need a forward declaration.
 */
export function isPlatformOrBuiltinType(name: string): boolean {
  return STANDARD_C_TYPES.has(name)
    || WINDOWS_TYPES.has(name)
    || GHIDRA_ARTIFACT_TYPES.has(name)
    || GLIDE_TYPES.has(name)
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
    // Use the base pointer type for the cast
    const castType = type.replace(/\s+/g, ' ').trim();
    return `(${castType})${value}`;
  }
  return value;
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
 * Normalize Ghidra `undefined[N]` types in function signatures to C equivalents.
 *
 * Handles both bare types and pointer variants:
 * - `undefined4` → `uint32_t`
 * - `undefined4 *` → `uint32_t *`
 * - `undefined` → `uint8_t`
 *
 * Returns the input unchanged for known/normal types.
 */
export function normalizeSignatureType(type: string): string {
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

// =============================================================================
// Platform Header Generation
// =============================================================================

/**
 * Generate d2_platform.h content with cross-platform type definitions
 */
export function generatePlatformHeader(): string {
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
  lines.push('#include <cstdio>');
  lines.push('#include <cstdarg>');
  lines.push('#include <cstring>');
  lines.push('#include <cstdlib>');
  lines.push('#include <cmath>');
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
  lines.push('typedef void* vtable;');
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
  lines.push('// __debugbreak stub for non-Windows (INT 3 debug breakpoint)');
  lines.push('#ifndef _WIN32');
  lines.push('#define __debugbreak() ((void)0)');
  lines.push('#endif');
  lines.push('');
  lines.push('#ifdef _WIN32');
  lines.push('#  ifndef WIN32_LEAN_AND_MEAN');
  lines.push('#    define WIN32_LEAN_AND_MEAN');
  lines.push('#  endif');
  lines.push('#  include <windows.h>');
  lines.push('#  include <winsock2.h>');
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
  lines.push('DWORD GetTickCount();');
  lines.push('void Sleep(DWORD dwMilliseconds);');
  lines.push('BOOL QueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount);');
  lines.push('BOOL QueryPerformanceFrequency(LARGE_INTEGER* lpFrequency);');
  lines.push('int wsprintfA(LPSTR lpOut, LPCSTR lpFmt, ...);');
  lines.push('int wsprintfW(LPWSTR lpOut, LPCWSTR lpFmt, ...);');
  lines.push('DWORD GetLastError();');
  lines.push('void SetLastError(DWORD dwErrCode);');
  lines.push('DWORD GetCurrentThreadId();');
  lines.push('DWORD GetCurrentProcessId();');
  lines.push('void OutputDebugStringA(LPCSTR lpOutputString);');
  lines.push('HMODULE GetModuleHandleA(LPCSTR lpModuleName);');
  lines.push('FARPROC GetProcAddress(HMODULE hModule, LPCSTR lpProcName);');
  lines.push('HMODULE LoadLibraryA(LPCSTR lpLibFileName);');
  lines.push('BOOL FreeLibrary(HMODULE hLibModule);');
  lines.push('HANDLE GetProcessHeap();');
  lines.push('LPVOID HeapAlloc(HANDLE hHeap, DWORD dwFlags, SIZE_T dwBytes);');
  lines.push('BOOL HeapFree(HANDLE hHeap, DWORD dwFlags, LPVOID lpMem);');
  lines.push('void InitializeCriticalSection(LPCRITICAL_SECTION lpCriticalSection);');
  lines.push('void EnterCriticalSection(LPCRITICAL_SECTION lpCriticalSection);');
  lines.push('void LeaveCriticalSection(LPCRITICAL_SECTION lpCriticalSection);');
  lines.push('void DeleteCriticalSection(LPCRITICAL_SECTION lpCriticalSection);');
  lines.push('HANDLE CreateThread(LPSECURITY_ATTRIBUTES lpThreadAttributes, SIZE_T dwStackSize, LPTHREAD_START_ROUTINE lpStartAddress, LPVOID lpParameter, DWORD dwCreationFlags, LPDWORD lpThreadId);');
  lines.push('DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);');
  lines.push('BOOL CloseHandle(HANDLE hObject);');
  lines.push('void ExitProcess(UINT uExitCode);');
  lines.push('int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType);');
  lines.push('LPVOID VirtualAlloc(LPVOID lpAddress, SIZE_T dwSize, DWORD flAllocationType, DWORD flProtect);');
  lines.push('BOOL VirtualFree(LPVOID lpAddress, SIZE_T dwSize, DWORD dwFreeType);');
  lines.push('}');
  lines.push('');

  // Additional Win32 APIs
  lines.push('BOOL IsBadCodePtr(FARPROC lpfn);');
  lines.push('BOOL IsBadReadPtr(const void* lp, UINT ucb);');
  lines.push('BOOL IsBadWritePtr(LPVOID lp, UINT ucb);');
  lines.push('HANDLE CreateEventA(LPSECURITY_ATTRIBUTES lpEventAttributes, BOOL bManualReset, BOOL bInitialState, LPCSTR lpName);');
  lines.push('BOOL SetEvent(HANDLE hEvent);');
  lines.push('BOOL ResetEvent(HANDLE hEvent);');
  lines.push('void PostQuitMessage(int nExitCode);');
  lines.push('BOOL PostMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam);');
  lines.push('int GetSystemMetrics(int nIndex);');
  lines.push('BOOL SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags);');
  lines.push('BOOL ShowWindow(HWND hWnd, int nCmdShow);');
  lines.push('BOOL DestroyWindow(HWND hWnd);');
  lines.push('HWND CreateWindowExA(DWORD dwExStyle, LPCSTR lpClassName, LPCSTR lpWindowName, DWORD dwStyle, int X, int Y, int nWidth, int nHeight, HWND hWndParent, HMENU hMenu, HINSTANCE hInstance, LPVOID lpParam);');
  lines.push('BOOL GetClientRect(HWND hWnd, LPRECT lpRect);');
  lines.push('HDC GetDC(HWND hWnd);');
  lines.push('int ReleaseDC(HWND hWnd, HDC hDC);');
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

  // Ghidra builtin_ prefixed functions
  lines.push('// Ghidra builtin_ prefixed functions');
  lines.push('#define builtin_strncpy strncpy');
  lines.push('#define builtin_memcpy memcpy');
  lines.push('#define builtin_memset memset');
  lines.push('#define builtin_strcmp strcmp');
  lines.push('#define builtin_strlen strlen');
  lines.push('#define builtin_strcpy strcpy');
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

  // Ghidra carry/borrow detection macros
  lines.push('// Ghidra carry/borrow detection');
  lines.push('#define CARRY4(a, b) ((uint32_t)(a) + (uint32_t)(b) < (uint32_t)(a))');
  lines.push('#define CARRY2(a, b) ((uint16_t)(a) + (uint16_t)(b) < (uint16_t)(a))');
  lines.push('#define CARRY1(a, b) ((uint8_t)(a) + (uint8_t)(b) < (uint8_t)(a))');
  lines.push('#define SBORROW4(a, b) ((int32_t)((uint32_t)(a) ^ (uint32_t)(b)) < 0 && (int32_t)((uint32_t)(a) ^ ((uint32_t)(a) - (uint32_t)(b))) < 0)');
  lines.push('#define SBORROW2(a, b) ((int16_t)((uint16_t)(a) ^ (uint16_t)(b)) < 0 && (int16_t)((uint16_t)(a) ^ ((uint16_t)(a) - (uint16_t)(b))) < 0)');
  lines.push('');

  // Diablo 2 PRNG (Linear Congruential Generator) macros
  lines.push('// Diablo 2 PRNG — LCG with multiplier 0x6AC690C5');
  lines.push('#define D2_SEED_NEXT(seed) ((D2SeedStrc)((uint64_t)(uint32_t)(seed).nSeedLow * 0x6ac690c5u + (uint64_t)(uint32_t)(seed).nSeedHigh))');
  lines.push('#define D2_SEED_NEXT_VAL(sv) ((D2SeedStrc)((uint64_t)(uint32_t)(sv) * 0x6ac690c5u + ((uint64_t)(sv) >> 32)))');
  lines.push('');

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
  lines.push('static inline uint64_t __aullrem(uint64_t a, uint64_t b) { return a % b; }');
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
  lines.push('HANDLE CreateEventW(LPSECURITY_ATTRIBUTES lpEventAttributes, BOOL bManualReset, BOOL bInitialState, LPCWSTR lpName);');
  lines.push('DWORD WaitForMultipleObjects(DWORD nCount, const HANDLE* lpHandles, BOOL bWaitAll, DWORD dwMilliseconds);');
  lines.push('LRESULT SendMessageA(HWND hWnd, UINT Msg, WPARAM wParam, LPARAM lParam);');
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
  lines.push('BOOL WriteFile(HANDLE hFile, LPCVOID lpBuffer, DWORD nBytes, LPDWORD lpBytesWritten, LPOVERLAPPED lpOverlapped);');
  lines.push('BOOL ReadFile(HANDLE hFile, LPVOID lpBuffer, DWORD nBytes, LPDWORD lpBytesRead, LPOVERLAPPED lpOverlapped);');
  lines.push('HANDLE CreateFileA(LPCSTR lpFileName, DWORD dwDesiredAccess, DWORD dwShareMode, LPSECURITY_ATTRIBUTES lpSec, DWORD dwCreationDisposition, DWORD dwFlagsAndAttributes, HANDLE hTemplate);');
  lines.push('DWORD SetFilePointer(HANDLE hFile, LONG lDistanceToMove, PLONG lpDistanceToMoveHigh, DWORD dwMoveMethod);');
  lines.push('DWORD GetFileSize(HANDLE hFile, LPDWORD lpFileSizeHigh);');
  lines.push('DWORD GetFileAttributesA(LPCSTR lpFileName);');
  lines.push('DWORD GetModuleFileNameA(HMODULE hModule, LPSTR lpFilename, DWORD nSize);');
  lines.push('void GetLocalTime(LPSYSTEMTIME lpSystemTime);');
  lines.push('HANDLE GetCurrentProcess();');
  lines.push('SHORT GetKeyState(int nVirtKey);');
  lines.push('void SetRect(LPRECT lprc, int left, int top, int right, int bottom);');
  lines.push('int WSAGetLastError();');
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

  // Include shared enum definitions (all Ghidra enum types collected into one file)
  lines.push('// Shared enum constants (SOUND_NONE, UNIT_PLAYER, SKILL_Attack, etc.)');
  lines.push('#include "d2_enums.h"');
  lines.push('');

  return lines.join('\n');
}

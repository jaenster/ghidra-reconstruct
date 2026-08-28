/**
 * CRT / stdlib / Win32 function → header mapping
 *
 * Maps well-known C runtime and Windows API function names to
 * the standard C++ header that declares them.
 */

const CRT_TABLE: Record<string, string> = {
  // <cstring>
  memset: '<cstring>',
  memcpy: '<cstring>',
  memmove: '<cstring>',
  memcmp: '<cstring>',
  strlen: '<cstring>',
  strcmp: '<cstring>',
  strncmp: '<cstring>',
  strcpy: '<cstring>',
  strncpy: '<cstring>',
  strcat: '<cstring>',
  strncat: '<cstring>',
  strchr: '<cstring>',
  strrchr: '<cstring>',
  strstr: '<cstring>',
  strtok: '<cstring>',
  _stricmp: '<cstring>',
  _strnicmp: '<cstring>',
  _memicmp: '<cstring>',
  _strlwr: '<cstring>',
  _strupr: '<cstring>',
  _strdup: '<cstring>',
  _strrev: '<cstring>',
  strerror: '<cstring>',

  // <cstdlib>
  malloc: '<cstdlib>',
  calloc: '<cstdlib>',
  realloc: '<cstdlib>',
  free: '<cstdlib>',
  abort: '<cstdlib>',
  exit: '<cstdlib>',
  _exit: '<cstdlib>',
  atexit: '<cstdlib>',
  atoi: '<cstdlib>',
  atol: '<cstdlib>',
  atof: '<cstdlib>',
  strtol: '<cstdlib>',
  strtoul: '<cstdlib>',
  strtod: '<cstdlib>',
  rand: '<cstdlib>',
  srand: '<cstdlib>',
  abs: '<cstdlib>',
  labs: '<cstdlib>',
  div: '<cstdlib>',
  ldiv: '<cstdlib>',
  qsort: '<cstdlib>',
  bsearch: '<cstdlib>',
  getenv: '<cstdlib>',
  system: '<cstdlib>',
  _itoa: '<cstdlib>',
  _ltoa: '<cstdlib>',
  _ultoa: '<cstdlib>',
  _rotl: '<cstdlib>',
  _rotr: '<cstdlib>',

  // <cstdio>
  printf: '<cstdio>',
  sprintf: '<cstdio>',
  snprintf: '<cstdio>',
  _snprintf: '<cstdio>',
  fprintf: '<cstdio>',
  sscanf: '<cstdio>',
  fscanf: '<cstdio>',
  scanf: '<cstdio>',
  fopen: '<cstdio>',
  fclose: '<cstdio>',
  fread: '<cstdio>',
  fwrite: '<cstdio>',
  fgets: '<cstdio>',
  fputs: '<cstdio>',
  fseek: '<cstdio>',
  ftell: '<cstdio>',
  rewind: '<cstdio>',
  fflush: '<cstdio>',
  feof: '<cstdio>',
  ferror: '<cstdio>',
  remove: '<cstdio>',
  rename: '<cstdio>',
  tmpfile: '<cstdio>',
  tmpnam: '<cstdio>',
  vsprintf: '<cstdio>',
  vsnprintf: '<cstdio>',
  _vsnprintf: '<cstdio>',
  vfprintf: '<cstdio>',
  puts: '<cstdio>',
  getc: '<cstdio>',
  putc: '<cstdio>',
  ungetc: '<cstdio>',

  // <cmath>
  sqrt: '<cmath>',
  sqrtf: '<cmath>',
  sin: '<cmath>',
  sinf: '<cmath>',
  cos: '<cmath>',
  cosf: '<cmath>',
  tan: '<cmath>',
  tanf: '<cmath>',
  asin: '<cmath>',
  acos: '<cmath>',
  atan: '<cmath>',
  atan2: '<cmath>',
  atan2f: '<cmath>',
  pow: '<cmath>',
  powf: '<cmath>',
  exp: '<cmath>',
  log: '<cmath>',
  log10: '<cmath>',
  ceil: '<cmath>',
  ceilf: '<cmath>',
  floor: '<cmath>',
  floorf: '<cmath>',
  fabs: '<cmath>',
  fabsf: '<cmath>',
  fmod: '<cmath>',
  fmodf: '<cmath>',
  ldexp: '<cmath>',
  frexp: '<cmath>',

  // <cctype>
  isalpha: '<cctype>',
  isdigit: '<cctype>',
  isalnum: '<cctype>',
  isspace: '<cctype>',
  isupper: '<cctype>',
  islower: '<cctype>',
  isprint: '<cctype>',
  ispunct: '<cctype>',
  iscntrl: '<cctype>',
  toupper: '<cctype>',
  tolower: '<cctype>',

  // <cassert>
  assert: '<cassert>',

  // <ctime>
  time: '<ctime>',
  clock: '<ctime>',
  difftime: '<ctime>',
  mktime: '<ctime>',
  localtime: '<ctime>',
  gmtime: '<ctime>',
  strftime: '<ctime>',

  // <windows.h> — Win32 API (provided by d2_platform.h, not emitted as include)
  EnterCriticalSection: '<windows.h>',
  LeaveCriticalSection: '<windows.h>',
  InitializeCriticalSection: '<windows.h>',
  DeleteCriticalSection: '<windows.h>',
  TryEnterCriticalSection: '<windows.h>',
  Sleep: '<windows.h>',
  SleepEx: '<windows.h>',
  GetTickCount: '<windows.h>',
  GetCurrentThreadId: '<windows.h>',
  GetCurrentProcessId: '<windows.h>',
  GetLastError: '<windows.h>',
  SetLastError: '<windows.h>',
  CloseHandle: '<windows.h>',
  CreateThread: '<windows.h>',
  WaitForSingleObject: '<windows.h>',
  WaitForMultipleObjects: '<windows.h>',
  InterlockedIncrement: '<windows.h>',
  InterlockedDecrement: '<windows.h>',
  InterlockedExchange: '<windows.h>',
  InterlockedCompareExchange: '<windows.h>',
  VirtualAlloc: '<windows.h>',
  VirtualFree: '<windows.h>',
  HeapAlloc: '<windows.h>',
  HeapFree: '<windows.h>',
  GetProcessHeap: '<windows.h>',
  LoadLibraryA: '<windows.h>',
  LoadLibraryW: '<windows.h>',
  GetProcAddress: '<windows.h>',
  FreeLibrary: '<windows.h>',
  GetModuleHandleA: '<windows.h>',
  GetModuleHandleW: '<windows.h>',
  OutputDebugStringA: '<windows.h>',
  OutputDebugStringW: '<windows.h>',
  QueryPerformanceCounter: '<windows.h>',
  QueryPerformanceFrequency: '<windows.h>',
  CreateEventA: '<windows.h>',
  CreateEventW: '<windows.h>',
  SetEvent: '<windows.h>',
  ResetEvent: '<windows.h>',
  CreateMutexA: '<windows.h>',
  ReleaseMutex: '<windows.h>',
  PostMessageA: '<windows.h>',
  SendMessageA: '<windows.h>',
  GetWindowRect: '<windows.h>',
  GetClientRect: '<windows.h>',
  SetWindowPos: '<windows.h>',
  ShowWindow: '<windows.h>',
  InvalidateRect: '<windows.h>',
  GetDC: '<windows.h>',
  ReleaseDC: '<windows.h>',
  CreateFileA: '<windows.h>',
  CreateFileW: '<windows.h>',
  ReadFile: '<windows.h>',
  WriteFile: '<windows.h>',
  SetFilePointer: '<windows.h>',
  GetFileSize: '<windows.h>',
  FindFirstFileA: '<windows.h>',
  FindNextFileA: '<windows.h>',
  FindClose: '<windows.h>',
  CreateDirectoryA: '<windows.h>',
  GetCurrentDirectoryA: '<windows.h>',
  SetCurrentDirectoryA: '<windows.h>',
  GetSystemTime: '<windows.h>',
  GetLocalTime: '<windows.h>',
  MultiByteToWideChar: '<windows.h>',
  WideCharToMultiByte: '<windows.h>',
  wsprintfA: '<windows.h>',
  wsprintfW: '<windows.h>',
  lstrcpyA: '<windows.h>',
  lstrcpynA: '<windows.h>',
  lstrlenA: '<windows.h>',
  lstrcmpA: '<windows.h>',
  lstrcmpiA: '<windows.h>',
};

/**
 * Every CRT / Win32 name a system header declares for us. The reconstruction
 * calls these, but their prototype comes from `<cstring>`, `<cstdio>` or
 * `<windows.h>` — never from the database — so nothing may be cast to Ghidra's
 * record of one. Derived from `CRT_TABLE` so the two cannot drift apart.
 */
export const CRT_DECLARED_FUNCTION_NAMES: readonly string[] = Object.keys(CRT_TABLE);

/**
 * Strip common Ghidra namespace prefixes from a function name.
 * e.g. "VisualStudio::memset" → "memset", "_memset" → "memset"
 */
function stripCrtPrefix(name: string): string {
  // Strip namespace prefixes (VisualStudio::, msvcrt::, etc.)
  const colonIdx = name.lastIndexOf('::');
  let stripped = colonIdx >= 0 ? name.slice(colonIdx + 2) : name;

  // Strip leading underscore (MSVC decoration) but not double-underscore
  if (stripped.startsWith('_') && !stripped.startsWith('__')) {
    const withoutUnderscore = stripped.slice(1);
    // Only strip if the base name exists in our table
    if (CRT_TABLE[withoutUnderscore]) {
      stripped = withoutUnderscore;
    }
  }

  return stripped;
}

/**
 * Resolve a single function name to its CRT header, or undefined if not a CRT function.
 */
export function resolveCrtInclude(name: string): string | undefined {
  // Try direct lookup first
  if (CRT_TABLE[name]) return CRT_TABLE[name];

  // Try after stripping prefixes
  const stripped = stripCrtPrefix(name);
  return CRT_TABLE[stripped];
}

/**
 * Collect the set of CRT/stdlib headers needed by a list of called function names.
 */
export function collectCrtHeaders(calledFunctions: string[]): Set<string> {
  const headers = new Set<string>();
  for (const name of calledFunctions) {
    const header = resolveCrtInclude(name);
    // Skip <windows.h> — Win32 types/functions are provided by d2_platform.h
    if (header && header !== '<windows.h>') headers.add(header);
  }
  return headers;
}

// =============================================================================
// Excluded-namespace symbol declarations
// =============================================================================

/**
 * Ghidra's `compiler` / `CRT` / `_Wrappers` namespaces hold the statically-linked
 * MSVC C runtime and the import thunks. `run.ts` excludes them from emission —
 * correctly, we are not reimplementing the CRT — but kept game code still calls
 * into them, and without a declaration every such call site is
 * "'X' was not declared in this scope".
 *
 * This table declares those callees. Each entry carries the REAL signature, taken
 * from the real CRT / Win32 / vendor SDK where one exists, otherwise from Ghidra's
 * own recovered prototype for `/windows/lod/1.14d/Game.exe` (which is ground truth
 * for this binary). Nothing here is variadic-to-silence or void*-to-silence: a
 * symbol whose true signature could not be established is deliberately absent.
 *
 * `emitted` is the identifier the generator actually writes at the call site.
 * Where that differs from `real`, it is a Ghidra naming artifact — an extra
 * leading underscore on the decorated CRT name, a `FID_conflict_` FunctionID
 * collision prefix, or a stdcall `@N` byte count rewritten as `_N`. Normalising
 * those names belongs upstream in the emitter; until it happens, the declaration
 * has to answer to the name the call site uses.
 */
export interface ExcludedSymbolDecl {
  /** Identifier as written at the emitted call site. */
  emitted: string;
  /** The real entry point this is, for a reader chasing it back to an SDK. */
  real: string;
  /** Where the signature came from: a system header, a vendor SDK, or Ghidra. */
  source: 'crt' | 'win32' | 'winsock' | 'ddraw' | 'rad' | 'glide' | 'ghidra';
  /** C++ declaration text. */
  decl: string;
  /** Emit only when the Win32 platform SDK is present. */
  win32Only?: boolean;
}

/** MSVC CRT entry points that a real libc / mingw CRT header already declares. */
const CRT_FORWARDERS: ExcludedSymbolDecl[] = [
  { emitted: '__strnicmp', real: '_strnicmp', source: 'crt',
    decl: 'static inline int __strnicmp(const char* a, const char* b, size_t n) { return _strnicmp(a, b, n); }',
    win32Only: true },
  { emitted: '__strlwr', real: '_strlwr', source: 'crt',
    decl: 'static inline char* __strlwr(char* s) { return _strlwr(s); }', win32Only: true },
  { emitted: '__strupr', real: '_strupr', source: 'crt',
    decl: 'static inline char* __strupr(char* s) { return _strupr(s); }', win32Only: true },
  { emitted: '__itoa', real: '_itoa', source: 'crt',
    decl: 'static inline char* __itoa(int v, char* buf, int radix) { return _itoa(v, buf, radix); }',
    win32Only: true },
  { emitted: '__ultoa', real: '_ultoa', source: 'crt',
    decl: 'static inline char* __ultoa(unsigned long v, char* buf, int radix) { return _ultoa(v, buf, radix); }',
    win32Only: true },
  { emitted: '__i64toa', real: '_i64toa', source: 'crt',
    decl: 'static inline char* __i64toa(long long v, char* buf, int radix) { return _i64toa(v, buf, radix); }',
    win32Only: true },
  { emitted: '__ui64toa', real: '_ui64toa', source: 'crt',
    decl: 'static inline char* __ui64toa(unsigned long long v, char* buf, int radix) { return _ui64toa(v, buf, radix); }',
    win32Only: true },
  { emitted: '__vsnprintf', real: '_vsnprintf', source: 'crt',
    decl: 'static inline int __vsnprintf(char* buf, size_t n, const char* fmt, va_list ap) { return _vsnprintf(buf, n, fmt, ap); }' },
  { emitted: '__fullpath', real: '_fullpath', source: 'crt',
    decl: 'static inline char* __fullpath(char* absPath, const char* relPath, size_t maxLength) { return _fullpath(absPath, relPath, maxLength); }',
    win32Only: true },
  { emitted: '__wfopen', real: '_wfopen', source: 'crt',
    decl: 'static inline FILE* __wfopen(const wchar_t* filename, const wchar_t* mode) { return _wfopen(filename, mode); }',
    win32Only: true },
  { emitted: '__time64', real: '_time64', source: 'crt',
    decl: 'static inline __time64_t __time64(__time64_t* destTime) { return _time64(destTime); }',
    win32Only: true },
  { emitted: 'FID_conflict___time32', real: '_time32', source: 'crt',
    decl: 'static inline __time32_t FID_conflict___time32(__time32_t* destTime) { return _time32(destTime); }',
    win32Only: true },
  { emitted: '__beginthreadex', real: '_beginthreadex', source: 'crt',
    decl: 'static inline uintptr_t __beginthreadex(void* security, unsigned stackSize, unsigned (__stdcall* startAddress)(void*), void* arglist, unsigned initflag, unsigned* thrdaddr) { return _beginthreadex(security, stackSize, startAddress, arglist, initflag, thrdaddr); }',
    win32Only: true },
  { emitted: 'builtin_wcsncpy', real: 'wcsncpy', source: 'crt',
    decl: 'static inline wchar_t* builtin_wcsncpy(wchar_t* dst, const wchar_t* src, size_t n) { return wcsncpy(dst, src, n); }' },
  // sscanf is genuinely variadic — a pack forwarder keeps every argument's real
  // type, unlike a `...` redeclaration.
  { emitted: 'FID_conflict__sscanf', real: 'sscanf', source: 'crt',
    decl: 'template <typename... Args> static inline int FID_conflict__sscanf(const char* src, const char* fmt, Args... args) { return sscanf(src, fmt, args...); }' },
];

/**
 * MSVC compiler-runtime helpers with no libc equivalent: the SEH/C++-EH
 * personality routines, the unwinders, and the x87/64-bit codegen intrinsics.
 * Signatures are Ghidra's recovered prototypes for 1.14d `Game.exe` — the only
 * ground truth there is, since none of these are declared by any public header.
 */
const MSVC_RUNTIME_DECLS: ExcludedSymbolDecl[] = [
  // __CxxFrameHandler3 @ 0068333c — Ghidra:
  //   undefined4 (EHExceptionRecord*, EHRegistrationNode*, _CONTEXT*, void*)
  { emitted: 'FID_conflict____CxxFrameHandler3', real: '__CxxFrameHandler3', source: 'ghidra',
    decl: 'extern "C" uint32_t FID_conflict____CxxFrameHandler3(EHExceptionRecord* pExceptionRecord, EHRegistrationNode* pRegistrationNode, CONTEXT* pContext, void* pDispatcherContext);' },
  // __except_handler4 @ 00684f50 — Ghidra: undefined4 (int*, PVOID, undefined4)
  { emitted: '__except_handler4', real: '_except_handler4', source: 'ghidra',
    decl: 'extern "C" uint32_t __except_handler4(int* pRecord, void* pRegistration, uint32_t dwContext);' },
  // __global_unwind2 @ 00697f74 — Ghidra: undefined (PVOID)
  { emitted: '__global_unwind2', real: '_global_unwind2', source: 'ghidra',
    decl: 'extern "C" void __global_unwind2(void* pRegistration);' },
  // __local_unwind2 @ 00697fd9 — Ghidra: undefined (int, uint)
  { emitted: '__local_unwind2', real: '_local_unwind2', source: 'ghidra',
    decl: 'extern "C" void __local_unwind2(int nRegistration, uint32_t nStop);' },
  // __NLG_Notify @ 00698089 — Ghidra: void (ulong), __stdcall
  { emitted: '__NLG_Notify', real: '_NLG_Notify', source: 'ghidra',
    decl: 'extern "C" void __NLG_Notify(unsigned long nCode);' },
  // __ValidateEH3RN @ 00698170 — Ghidra: undefined4 (void*)
  { emitted: '__ValidateEH3RN', real: '_ValidateEH3RN', source: 'ghidra',
    decl: 'extern "C" uint32_t __ValidateEH3RN(void* pRegistration);' },
  // ___report_gsfailure @ 006889d6 — Ghidra: void (void)
  { emitted: '___report_gsfailure', real: '__report_gsfailure', source: 'ghidra',
    decl: 'extern "C" void ___report_gsfailure(void);' },
  // _CallDestructExceptionObject @ 00697f3d — Ghidra: undefined (int*)
  { emitted: '_CallDestructExceptionObject', real: '_CallDestructExceptionObject', source: 'ghidra',
    decl: 'extern "C" void _CallDestructExceptionObject(int* pExceptionObject);' },
  // __purecall @ 006877fe — Ghidra: undefined (void). The real CRT entry point is
  // `_purecall`; on i686 MSVC its decorated name is the `__purecall` Ghidra shows.
  { emitted: '__purecall', real: '_purecall', source: 'ghidra',
    decl: 'extern "C" void __purecall(void);' },
  // `eh_vector_constructor_iterator' @ 006869fc — Ghidra:
  //   void __stdcall (void*, uint, int, void(__thiscall*)(void*), void(__thiscall*)(void*))
  { emitted: '_eh_vector_constructor_iterator_', real: "`eh vector constructor iterator'", source: 'ghidra',
    decl: 'extern "C" void _eh_vector_constructor_iterator_(void* pArray, uint32_t nElementSize, int nCount, void (*pfnConstructor)(void*), void (*pfnDestructor)(void*));' },
  // `eh_vector_destructor_iterator' @ 00686ad1 — Ghidra:
  //   void __stdcall (void*, uint, int, void(__thiscall*)(void*))
  { emitted: '_eh_vector_destructor_iterator_', real: "`eh vector destructor iterator'", source: 'ghidra',
    decl: 'extern "C" void _eh_vector_destructor_iterator_(void* pArray, uint32_t nElementSize, int nCount, void (*pfnDestructor)(void*));' },
  // __ftol2 @ 00683006 — Ghidra: ulonglong (void). The double is passed on the x87
  // stack, which is why the recovered prototype takes nothing and the call sites
  // pass nothing; both agree, so the declaration is exact for this binary.
  { emitted: '__ftol2', real: '_ftol2', source: 'ghidra',
    decl: 'extern "C" uint64_t __ftol2(void);' },
  // __CIsqrt @ 006879c0 — Ghidra: undefined (void); x87-stack argument, as above.
  { emitted: '__CIsqrt', real: '_CIsqrt', source: 'ghidra',
    decl: 'extern "C" double __CIsqrt(void);' },
  // __sqrt_common @ 006879dd — Ghidra: uint (int, uint, undefined4 in EDX). The
  // double arrives split across two stack dwords plus EDX, which is exactly the
  // three-argument shape the call sites use.
  { emitted: '__sqrt_common', real: '_sqrt_common', source: 'ghidra',
    decl: 'extern "C" uint32_t __sqrt_common(int nMantissaLo, uint32_t nMantissaHi, uint32_t nEdxIn);' },
  // __aulldvrm @ 00686b60 — unsigned 64/64 divide-and-remainder, four dword args.
  // Matches the existing __alldvrm/__aulldiv inlines below in this header.
  { emitted: '__aulldvrm', real: '_aulldvrm', source: 'ghidra',
    decl: 'static inline uint64_t __aulldvrm(uint32_t lo1, uint32_t hi1, uint32_t lo2, uint32_t hi2) { return (lo1 | ((uint64_t)hi1 << 32)) / (lo2 | ((uint64_t)hi2 << 32)); }' },
  // CRT_Pow @ 00683080 — Ghidra: float10 (double)
  { emitted: 'CRT_Pow', real: 'pow', source: 'ghidra',
    decl: 'extern "C" long double CRT_Pow(double x);' },
  // CRT_Pow10 @ 00687c10, CRT_Log10 @ 00687ac0, CRT_Sqrt @ 00687ea0 — all
  // __stdcall `(void)` in Ghidra: the operand arrives on the x87 stack and the
  // result comes back in ST(0), so there is no C-level parameter and the return
  // is the 80-bit register value. The call sites pass no arguments, which agrees.
  { emitted: 'CRT_Pow10', real: '_pow10', source: 'ghidra',
    decl: 'extern "C" long double CRT_Pow10(void);' },
  { emitted: 'CRT_Log10', real: 'log10', source: 'ghidra',
    decl: 'extern "C" long double CRT_Log10(void);' },
  { emitted: 'CRT_Sqrt', real: 'sqrt', source: 'ghidra',
    decl: 'extern "C" long double CRT_Sqrt(void);' },
  // CRT_Srand @ 00687454 — Ghidra: undefined (ulong)
  { emitted: 'CRT_Srand', real: 'srand', source: 'ghidra',
    decl: 'static inline void CRT_Srand(unsigned long nSeed) { srand((unsigned int)nSeed); }' },
  // CRT_Fgetc @ 00684c94 — Ghidra: int (FILE*, byte*). NOT plain fgetc: it takes a
  // second buffer pointer, so it is not forwarded to <cstdio>.
  { emitted: 'CRT_Fgetc', real: '_fgetc_nolock (MSVC internal)', source: 'ghidra',
    decl: 'extern "C" int CRT_Fgetc(FILE* pFile, unsigned char* pBuffer);' },
  // CRT_Fgets @ 00688271 — Ghidra: char* (char*, int, FILE*)
  { emitted: 'CRT_Fgets', real: 'fgets', source: 'ghidra',
    decl: 'static inline char* CRT_Fgets(char* szText, int nMax, FILE* pFile) { return fgets(szText, nMax, pFile); }' },
  // CRT_Fputc @ 00682058 — Ghidra: uint (uint, FILE*)
  { emitted: 'CRT_Fputc', real: 'fputc', source: 'ghidra',
    decl: 'static inline unsigned int CRT_Fputc(unsigned int nChar, FILE* pFile) { return (unsigned int)fputc((int)nChar, pFile); }' },
  // CRT_LocalTime_S @ 006856e9 — Ghidra: errno_t (tm*, uint*)
  { emitted: 'CRT_LocalTime_S', real: '_localtime32_s', source: 'ghidra',
    decl: 'extern "C" int CRT_LocalTime_S(struct tm* pTm, unsigned int* pnTime);' },
  // CRT_Vsprintf_L @ 00685637 — Ghidra: undefined (FILE*, int, undefined4)
  { emitted: 'CRT_Vsprintf_L', real: '_vsprintf_l', source: 'ghidra',
    decl: 'extern "C" int CRT_Vsprintf_L(FILE* pFile, int nParam, void* pArgList);' },
  // CRT_Encode_Secure_Pointer @ 00684af3 — Ghidra: void* (void*)
  { emitted: 'CRT_Encode_Secure_Pointer', real: 'EncodePointer', source: 'ghidra',
    decl: 'extern "C" void* CRT_Encode_Secure_Pointer(void* pPointer);' },
  // CRT_ReturnValue @ 006b1a30 — Ghidra: undefined (undefined4), __stdcall
  { emitted: 'CRT_ReturnValue', real: 'unidentified CRT helper', source: 'ghidra',
    decl: 'extern "C" uint32_t CRT_ReturnValue(uint32_t dwValue);' },
];

/**
 * Import thunks Ghidra parked in the `_Wrappers` namespace. Each one is a real
 * winsock entry point, so the shim forwards to the SDK declaration rather than
 * restating it.
 *
 * `_Wrappers::DirectDrawEnumerateA` is deliberately absent: its true signature is
 * known (`HRESULT WINAPI(LPDDENUMCALLBACKA, LPVOID)`), but the reconstruction
 * declares its own `IDirectDraw`, and the call site passes a callback typed
 * `uint32_t(uint32_t*, uint32_t, uint*)`. Declaring the real one only turns
 * "not declared" into "cannot convert" — the fix is the COM vtable work in
 * Ghidra, not a shim. Same for `DirectDrawCreate` / `DirectSoundCreate` /
 * `DirectSoundEnumerateA`.
 */
const WRAPPER_DECLS: ExcludedSymbolDecl[] = [
  { emitted: '_Wrappers::accept', real: 'accept', source: 'winsock',
    decl: 'static inline SOCKET accept(SOCKET s, struct sockaddr* addr, int* addrlen) { return ::accept(s, addr, addrlen); }',
    win32Only: true },
  { emitted: '_Wrappers::bind', real: 'bind', source: 'winsock',
    decl: 'static inline int bind(SOCKET s, const struct sockaddr* addr, int namelen) { return ::bind(s, addr, namelen); }',
    win32Only: true },
  { emitted: '_Wrappers::listen', real: 'listen', source: 'winsock',
    decl: 'static inline int listen(SOCKET s, int backlog) { return ::listen(s, backlog); }',
    win32Only: true },
  // Real functions in Game.exe that happen to sit in the excluded `_Wrappers`
  // namespace. Signatures are Ghidra's, at the addresses noted.
  // 006cb430 — undefined(void), __stdcall; used as an atexit() handler.
  { emitted: '_Wrappers::CRT_SecurityCookieStub2', real: 'Game.exe 006cb430', source: 'ghidra',
    decl: 'void CRT_SecurityCookieStub2(void);' },
  // 006d5bd0 — undefined4(char* in EAX), __stdcall.
  { emitted: '_Wrappers::CRT_StrLen', real: 'Game.exe 006d5bd0', source: 'ghidra',
    decl: 'uint32_t CRT_StrLen(char* pText);' },
  // 006c9c3b / 006ca0b8 / 006ca118 — SEH filters, all
  // undefined(EHExceptionRecord*, EHRegistrationNode*, _CONTEXT*, void*).
  { emitted: '_Wrappers::CRT_ExceptionFilter1', real: 'Game.exe 006c9c3b', source: 'ghidra',
    decl: 'void CRT_ExceptionFilter1(EHExceptionRecord* pExceptionRecord, EHRegistrationNode* pRegistrationNode, CONTEXT* pContext, void* pDispatcherContext);' },
  { emitted: '_Wrappers::CRT_ExceptionFilter2', real: 'Game.exe 006ca0b8', source: 'ghidra',
    decl: 'void CRT_ExceptionFilter2(EHExceptionRecord* pExceptionRecord, EHRegistrationNode* pRegistrationNode, CONTEXT* pContext, void* pDispatcherContext);' },
  { emitted: '_Wrappers::CRT_ExceptionFilter3', real: 'Game.exe 006ca118', source: 'ghidra',
    decl: 'void CRT_ExceptionFilter3(EHExceptionRecord* pExceptionRecord, EHRegistrationNode* pRegistrationNode, CONTEXT* pContext, void* pDispatcherContext);' },
  // 006d5b20 — a FUNCTION despite the `g` name, with register-passed parameters
  // Ghidra itself flags as uncertain. Kept code only ever takes its address, so
  // the arity is not load-bearing at any call site.
  { emitted: '_Wrappers::gCmdLineHelpText', real: 'Game.exe 006d5b20', source: 'ghidra',
    decl: 'uint32_t gCmdLineHelpText(unsigned short* pText, uint32_t nEcx, unsigned char* pBytes);' },
  { emitted: '_Wrappers::WSASetLastError', real: 'WSASetLastError', source: 'winsock',
    decl: 'static inline void WSASetLastError(int iError) { ::WSASetLastError(iError); }',
    win32Only: true },
];

/**
 * RAD Game Tools Smacker / Bink entry points. Diablo II links the 32-bit
 * `__stdcall` builds, so Ghidra's symbol carries the decorated `@N` argument-byte
 * count rewritten as `_N` — which pins the arity exactly and is what each
 * signature below was checked against (e.g. `_SmackToBuffer_28` = 7 dword args).
 */
const RAD_DECLS: ExcludedSymbolDecl[] = [
  { emitted: '_SmackOpen_12', real: 'SmackOpen', source: 'rad',
    decl: 'extern "C" __stdcall void* _SmackOpen_12(const char* szName, uint32_t dwFlags, uint32_t dwExtraBuf);' },
  { emitted: '_SmackClose_4', real: 'SmackClose', source: 'rad',
    decl: 'extern "C" __stdcall void _SmackClose_4(void* pSmack);' },
  { emitted: '_SmackDoFrame_4', real: 'SmackDoFrame', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _SmackDoFrame_4(void* pSmack);' },
  { emitted: '_SmackNextFrame_4', real: 'SmackNextFrame', source: 'rad',
    decl: 'extern "C" __stdcall void _SmackNextFrame_4(void* pSmack);' },
  { emitted: '_SmackWait_4', real: 'SmackWait', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _SmackWait_4(void* pSmack);' },
  { emitted: '_SmackToBuffer_28', real: 'SmackToBuffer', source: 'rad',
    decl: 'extern "C" __stdcall void _SmackToBuffer_28(void* pSmack, uint32_t nLeft, uint32_t nTop, uint32_t nPitch, uint32_t nDestHeight, void* pBuffer, uint32_t dwFlags);' },
  { emitted: '_BinkOpen_8', real: 'BinkOpen', source: 'rad',
    decl: 'extern "C" __stdcall void* _BinkOpen_8(const char* szName, uint32_t dwFlags);' },
  { emitted: '_BinkClose_4', real: 'BinkClose', source: 'rad',
    decl: 'extern "C" __stdcall void _BinkClose_4(void* pBink);' },
  { emitted: '_BinkDoFrame_4', real: 'BinkDoFrame', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _BinkDoFrame_4(void* pBink);' },
  { emitted: '_BinkNextFrame_4', real: 'BinkNextFrame', source: 'rad',
    decl: 'extern "C" __stdcall void _BinkNextFrame_4(void* pBink);' },
  { emitted: '_BinkWait_4', real: 'BinkWait', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _BinkWait_4(void* pBink);' },
  { emitted: '_BinkCopyToBuffer_28', real: 'BinkCopyToBuffer', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _BinkCopyToBuffer_28(void* pBink, void* pDest, int32_t nDestPitch, uint32_t nDestHeight, uint32_t nDestX, uint32_t nDestY, uint32_t dwFlags);' },
  { emitted: '_BinkSetSoundSystem_8', real: 'BinkSetSoundSystem', source: 'rad',
    decl: 'extern "C" __stdcall int32_t _BinkSetSoundSystem_8(void* pfnOpen, uint32_t dwParam);' },
  { emitted: '_BinkOpenDirectSound_4', real: 'BinkOpenDirectSound', source: 'rad',
    decl: 'extern "C" __stdcall void* _BinkOpenDirectSound_4(uint32_t dwParam);' },
  { emitted: '_BinkDDSurfaceType_4', real: 'BinkDDSurfaceType', source: 'rad',
    decl: 'extern "C" __stdcall uint32_t _BinkDDSurfaceType_4(void* pDDSurface);' },
];

/**
 * 3dfx Glide 2.x entry points, called through the `GLIDEDLL_` import thunks.
 * Same `_N` stdcall byte count as above; each signature was checked against it
 * (e.g. `grLfbLock` takes six dwords, hence `_24`). The Gr*_t / Fx* typedefs are
 * already defined further up in this header.
 */
const GLIDE_DECLS: ExcludedSymbolDecl[] = [
  { emitted: 'GLIDEDLL_grClipWindow_16', real: 'grClipWindow', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grClipWindow_16(FxU32 minx, FxU32 miny, FxU32 maxx, FxU32 maxy);' },
  { emitted: 'GLIDEDLL_grDepthBufferFunction_4', real: 'grDepthBufferFunction', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grDepthBufferFunction_4(GrCmpFnc_t func);' },
  { emitted: 'GLIDEDLL_grDepthBufferMode_4', real: 'grDepthBufferMode', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grDepthBufferMode_4(GrDepthBufferMode_t mode);' },
  { emitted: 'GLIDEDLL_grDisable_4', real: 'grDisable', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grDisable_4(GrEnableMode_t mode);' },
  { emitted: 'GLIDEDLL_grEnable_4', real: 'grEnable', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grEnable_4(GrEnableMode_t mode);' },
  { emitted: 'GLIDEDLL_grDrawTriangle_12', real: 'grDrawTriangle', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grDrawTriangle_12(const void* a, const void* b, const void* c);' },
  { emitted: 'GLIDEDLL_grGetProcAddress_4', real: 'grGetProcAddress', source: 'glide',
    decl: 'extern "C" __stdcall GrProc GLIDEDLL_grGetProcAddress_4(char* procName);' },
  { emitted: 'GLIDEDLL_grGetString_4', real: 'grGetString', source: 'glide',
    decl: 'extern "C" __stdcall const char* GLIDEDLL_grGetString_4(FxU32 pname);' },
  { emitted: 'GLIDEDLL_grLfbLock_24', real: 'grLfbLock', source: 'glide',
    decl: 'extern "C" __stdcall FxBool GLIDEDLL_grLfbLock_24(GrLock_t type, GrBuffer_t buffer, GrLfbWriteMode_t writeMode, GrOriginLocation_t origin, FxBool pixelPipeline, GrLfbInfo_t* info);' },
  { emitted: 'GLIDEDLL_grLfbUnlock_8', real: 'grLfbUnlock', source: 'glide',
    decl: 'extern "C" __stdcall FxBool GLIDEDLL_grLfbUnlock_8(GrLock_t type, GrBuffer_t buffer);' },
  { emitted: 'GLIDEDLL_grTexDownloadMipMap_16', real: 'grTexDownloadMipMap', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grTexDownloadMipMap_16(GrChipID_t tmu, FxU32 startAddress, FxU32 evenOdd, GrTexInfo* info);' },
  { emitted: 'GLIDEDLL_grTexMipMapMode_12', real: 'grTexMipMapMode', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grTexMipMapMode_12(GrChipID_t tmu, GrMipMapMode_t mode, FxBool lodBlend);' },
  { emitted: 'GLIDEDLL_grTexSource_16', real: 'grTexSource', source: 'glide',
    decl: 'extern "C" __stdcall void GLIDEDLL_grTexSource_16(GrChipID_t tmu, FxU32 startAddress, FxU32 evenOdd, GrTexInfo* info);' },
  { emitted: 'GLIDEDLL_grTexTextureMemRequired_8', real: 'grTexTextureMemRequired', source: 'glide',
    decl: 'extern "C" __stdcall FxU32 GLIDEDLL_grTexTextureMemRequired_8(FxU32 evenOdd, GrTexInfo* info);' },
];

/** Every excluded-namespace declaration, in emission order. */
export const EXCLUDED_SYMBOL_DECLS: readonly ExcludedSymbolDecl[] = [
  ...CRT_FORWARDERS,
  ...MSVC_RUNTIME_DECLS,
  ...WRAPPER_DECLS,
  ...RAD_DECLS,
  ...GLIDE_DECLS,
];

/**
 * Win32 SDK headers that declare imports the reconstruction calls but that
 * `<windows.h>` alone does not pull in. Preferring the real header over a
 * hand-written prototype keeps the signature honest and picks up the SDK's own
 * dependent types (`MODULEINFO`, `PROCESSENTRY32`, `LPDDENUMCALLBACKA`, ...).
 */
export const EXTRA_WIN32_SDK_HEADERS: readonly string[] = [
  '<process.h>',    // _beginthreadex
  '<shlobj.h>',     // SHGetFolderPathA
  '<shellapi.h>',   // ShellExecuteA, SHAppBarMessage
  '<tlhelp32.h>',   // CreateToolhelp32Snapshot, Process32/Thread32/Module32*
  '<psapi.h>',      // GetModuleFileNameExA, GetModuleInformation, MODULEINFO
  '<mmsystem.h>',   // timeGetTime, and WAVEFORMATEX for <dsound.h> below
];

/** Render the excluded-namespace declaration block for `d2_platform.h`. */
export function generateExcludedSymbolDecls(): string[] {
  const lines: string[] = [];
  lines.push('// =============================================================================');
  lines.push('// Excluded-namespace callees (Ghidra `compiler` / `CRT` / `_Wrappers`)');
  lines.push('// =============================================================================');
  lines.push('// These are NOT reconstructed — they are the statically-linked MSVC C runtime');
  lines.push('// and the import thunks. Kept game code still calls them, so they are declared');
  lines.push('// here with their real signatures and, where a real entry point exists, defined');
  lines.push('// as a forwarder to it.');
  lines.push('');

  const globals = EXCLUDED_SYMBOL_DECLS.filter(d => !d.emitted.startsWith('_Wrappers::'));
  const wrappers = EXCLUDED_SYMBOL_DECLS.filter(d => d.emitted.startsWith('_Wrappers::'));

  const emitGroup = (group: ExcludedSymbolDecl[], indent: string) => {
    for (const d of group) {
      lines.push(`${indent}${d.decl}`);
    }
  };

  const portable = globals.filter(d => !d.win32Only);
  const win32 = globals.filter(d => d.win32Only);

  emitGroup(portable, '');
  lines.push('');
  if (win32.length > 0 || wrappers.length > 0) {
    lines.push('#ifdef _WIN32');
    emitGroup(win32, '');
    if (wrappers.length > 0) {
      lines.push('namespace _Wrappers {');
      emitGroup(wrappers, '  ');
      lines.push('}  // namespace _Wrappers');
    }
    lines.push('#endif // _WIN32');
  }
  lines.push('');
  return lines;
}

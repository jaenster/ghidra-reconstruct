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

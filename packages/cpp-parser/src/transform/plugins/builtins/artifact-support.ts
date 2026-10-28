/**
 * The C++ helpers the decompiler-artifact lowerings emit calls to.
 *
 * The lowerings in `pseudo-op-lower` and `subpiece-access` are plain C++ wherever C++ has
 * a spelling. Two operations have none in C++17 and need a helper: reading the bit
 * pattern of a float (C++20's std::bit_cast) and touching exactly three bytes of memory.
 * The text is defined here, beside the passes that call it, and the platform header
 * includes it verbatim, so the definitions a test compiles are the ones the tree compiles.
 */

export const ARTIFACT_SUPPORT_LINES: readonly string[] = [
  '// Helpers the decompiler-artifact lowerings call (see artifact-support.ts).',
  '#include <cstring>',
  '#include <cmath>',
  '// __rdtsc (RDTSC) and, on mingw, __debugbreak (INT3) for the instruction-like pseudo-ops.',
  '#if defined(__GNUC__) && (defined(__i386__) || defined(__x86_64__))',
  '#  include <x86intrin.h>',
  '#endif',
  // __debugbreak comes with <windows.h> (winnt.h). Not <intrin.h>: beside <windows.h> it
  // redeclares the 3DNow! intrinsics GCC's <x86intrin.h> declared, and the mingw-w64
  // headers that do not guard that fail every TU.
  '#if defined(_WIN32)',
  '#  include <windows.h>',
  '#endif',
  '#if defined(__FAST_MATH__)',
  '#error "-ffast-math breaks std::isnan and float bit patterns the lowered code relies on"',
  '#endif',
  '// A LOCK CMPXCHG / CMPXCHG8B region (pseudo-op-lower): on *p == *pExpected store desired,',
  '// else load *p into *pExpected; true on a match. Sequentially consistent.',
  '#if defined(__GNUC__)',
  'template <class T, class U> static inline bool D2_AtomicCompareExchange(T* p, T* pExpected, U desired) {',
  '    return __atomic_compare_exchange_n(p, pExpected, (T)desired, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);',
  '}',
  '#elif defined(_MSC_VER)',
  'extern "C" long __cdecl _InterlockedCompareExchange(long volatile* pDestination, long nExchange, long nComparand);',
  'extern "C" __int64 __cdecl _InterlockedCompareExchange64(__int64 volatile* pDestination, __int64 nExchange, __int64 nComparand);',
  '#pragma intrinsic(_InterlockedCompareExchange, _InterlockedCompareExchange64)',
  'template <int N> struct D2AtomicCas;',
  'template <> struct D2AtomicCas<4> {',
  '    static bool Exchange(void* p, void* pExpected, const void* pDesired) {',
  '        long nExpected = *(long*)pExpected;',
  '        long nOld = _InterlockedCompareExchange((long volatile*)p, *(const long*)pDesired, nExpected);',
  '        *(long*)pExpected = nOld;',
  '        return nOld == nExpected;',
  '    }',
  '};',
  'template <> struct D2AtomicCas<8> {',
  '    static bool Exchange(void* p, void* pExpected, const void* pDesired) {',
  '        __int64 nExpected = *(__int64*)pExpected;',
  '        __int64 nOld = _InterlockedCompareExchange64((__int64 volatile*)p, *(const __int64*)pDesired, nExpected);',
  '        *(__int64*)pExpected = nOld;',
  '        return nOld == nExpected;',
  '    }',
  '};',
  'template <class T, class U> static inline bool D2_AtomicCompareExchange(T* p, T* pExpected, U desired) {',
  '    T tDesired = (T)desired;',
  '    return D2AtomicCas<sizeof(T)>::Exchange((void*)p, (void*)pExpected, &tDesired);',
  '}',
  '#endif',
  '// The bit pattern of a float or double, as C++20 std::bit_cast gives it.',
  'template <class To, class From>',
  'static inline To d2_bit_cast(const From& v) {',
  '  static_assert(sizeof(To) == sizeof(From), "d2_bit_cast needs equal sizes");',
  '  To r;',
  '  std::memcpy(&r, &v, sizeof(To));',
  '  return r;',
  '}',
  '// Three bytes at p, little-endian: a 3-byte decompiler field, without touching a fourth.',
  'static inline uint32_t d2_load24(const void* p) {',
  '  uint32_t v = 0;',
  '  std::memcpy(&v, p, 3);',
  '  return v;',
  '}',
  '// The same three bytes as a signed 24-bit value, sign-extended from bit 23.',
  'static inline int32_t d2_load24s(const void* p) {',
  '  return (int32_t)(d2_load24(p) ^ 0x800000u) - 0x800000;',
  '}',
  'static inline void d2_store24(void* p, uint32_t v) { std::memcpy(p, &v, 3); }',
];

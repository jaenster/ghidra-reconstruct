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

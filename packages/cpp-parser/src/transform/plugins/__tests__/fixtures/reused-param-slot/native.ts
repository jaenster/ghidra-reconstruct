/** Native fixture for the v2088 difficulty lifetime and its typed byte address. */
export const input = `uint32_t Evaluate(Region *p, uint8_t diff, int merc, const uint8_t *stats) {
  Region *alias;
  UseIncoming(p);
  if (diff != 0) {
    if (1 < diff) { p = (Region *)&DAT_00000002; goto difficulty; }
    p = (Region *)(uint32_t)diff;
    goto difficulty;
  }
  p = (Region *)0;
difficulty:
  if (merc) p = (Region *)0;
  alias = p;
  return (uint32_t)(p[3].aArray[0].aComponentVariants + 3)[(intptr_t)stats]
    + (uint32_t)(uintptr_t)p * 257 + (uint32_t)(uintptr_t)alias * 17
    + ReadDifficulty((Difficulty)(uintptr_t)alias);
}
uint64_t WordViews(Region *p, uint32_t next) {
  UseIncoming(p);
  p = (Region *)(uint32_t)next;
  return Pack((int32_t)(uintptr_t)p, (uint32_t)(uintptr_t)p, (intptr_t)p);
}`;

export function harness(before: string, after: string): string {
  return `#include <cstdint>
#include <cstdio>
#pragma pack(push, 1)
struct Sub { uint8_t aComponentVariants[16]; };
struct Region { uint16_t nClassId; uint8_t nRarity, pad; Sub aArray[3]; };
#pragma pack(pop)
static_assert(sizeof(Region) == 52 && alignof(Region) == 1, "live packed region layout");
enum Difficulty { Normal, Nightmare, Hell };
static uintptr_t seen;
static unsigned seenCount;
void UseIncoming(Region *p) { seen = (uintptr_t)p; ++seenCount; }
uint32_t ReadDifficulty(Difficulty d) { return (uint32_t)d; }
uint64_t Pack(int32_t a, uint32_t b, intptr_t c) {
  return ((uint64_t)(uint32_t)a << 32) ^ b ^ ((uint64_t)(uintptr_t)c * UINT64_C(0x9e3779b185ebca87));
}
namespace Before {
${before}
}
namespace After {
${after}
}
int CheckCases() {
  uint8_t stats[256];
  for (unsigned i = 0; i < 256; ++i) stats[i] = (uint8_t)(i * 37 + 11);
  Region regions[3] = {};
  unsigned cases = 0;
  for (unsigned r = 0; r < 3; ++r) {
    for (unsigned d = 0; d < 256; ++d) for (int merc = 0; merc < 2; ++merc) {
      unsigned n = merc ? 0 : (d > 1 ? 2 : d);
      uint32_t expected = stats[163 + n] + n * 275;
      seenCount = 0;
      uint32_t a = Before::Evaluate(&regions[r], (uint8_t)d, merc, stats);
      if (a != expected || seen != (uintptr_t)&regions[r] || seenCount != 1) return 1;
      seenCount = 0;
      uint32_t b = After::Evaluate(&regions[r], (uint8_t)d, merc, stats);
      if (b != expected || seen != (uintptr_t)&regions[r] || seenCount != 1) return 2;
      ++cases;
    }
  }
  const uint32_t words[] = {0,1,2,127,128,255,256,65535,UINT32_C(0x7fffffff),UINT32_C(0x80000000),UINT32_C(0xfffffffe),UINT32_C(0xffffffff)};
  for (uint32_t word : words) {
    uint64_t expected = Pack((int32_t)word, word, (intptr_t)(uintptr_t)word);
    seenCount = 0;
    uint64_t a = Before::WordViews(&regions[0], word);
    if (a != expected || seen != (uintptr_t)&regions[0] || seenCount != 1) return 3;
    seenCount = 0;
    uint64_t b = After::WordViews(&regions[0], word);
    if (b != expected || seen != (uintptr_t)&regions[0] || seenCount != 1) return 4;
    ++cases;
  }
  std::printf("%u", cases);
  return 0;
}
`;
}

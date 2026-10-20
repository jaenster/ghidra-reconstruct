// zlib real-value round trip (design 7.5): the tree's rebuilt zlib against zlib 1.2.8 built
// from source, both compiled for i686 and run on the same inputs. Deflate output must be
// byte-identical; inflate must reproduce the input on every stream at every buffer size, and
// on corrupted streams must return the same code, message and output as the reference.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <vector>
#include <string>
#include <unistd.h>
#include <sys/wait.h>
#define SIDE(x) tree_##x
#include "api.h"
#undef SIDE
#define SIDE(x) ref_##x
#include "api.h"

static uint64_t rs = 88172645463325252ull;
static uint32_t rnd() { rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (uint32_t)rs; }
static uint64_t fnv = 1469598103934665603ull;
static void mix(const void* p, size_t n) { const unsigned char* b = (const unsigned char*)p; for (size_t i = 0; i < n; i++) { fnv ^= b[i]; fnv *= 1099511628211ull; } }

static int fails = 0, cases = 0, crashes = 0;
static void fail(const char* what, const std::string& name) { if (fails < 40) printf("FAIL %s: %s\n", what, name.c_str()); fails++; }
// The tree side runs in a child: a crash in the rebuilt code is one case's verdict, not the end
// of the run. `f` returns 0 when the tree agrees with the reference. One line per case on
// stdout: the verdict the before/after comparison diffs.
template <class F> static int isolated(const std::string& name, F f) {
  fflush(stdout);
  pid_t pid = fork();
  if (pid == 0) { alarm(60); _exit(f() ? 1 : 0); }
  int st = 0; waitpid(pid, &st, 0);
  const char* v = WIFEXITED(st) ? (WEXITSTATUS(st) ? "differs" : "same") : "crash";
  printf("CASE %s: %s\n", name.c_str(), v);
  if (!WIFEXITED(st)) crashes++;
  return WIFEXITED(st) ? WEXITSTATUS(st) : 2;
}

int main(int argc, char** argv) {
  std::vector<std::pair<std::string, std::vector<unsigned char>>> inputs;
  { const char* h = "hello, hello!"; inputs.push_back({"hello", std::vector<unsigned char>(h, h + strlen(h) + 1)}); }
  inputs.push_back({"empty", {}});
  for (int i = 1; i < argc; i++) {
    FILE* f = fopen(argv[i], "rb"); if (!f) continue;
    std::vector<unsigned char> d; int c; while ((c = fgetc(f)) != EOF) d.push_back((unsigned char)c); fclose(f);
    inputs.push_back({argv[i], d});
  }
  { std::vector<unsigned char> d(50000); for (auto& x : d) x = (unsigned char)rnd(); inputs.push_back({"random", d}); }
  { inputs.push_back({"zeros", std::vector<unsigned char>(70000, 0)}); }
  { std::vector<unsigned char> d(40000); for (size_t i = 0; i < d.size(); i++) d[i] = "abcab"[i % 5] + (rnd() % 97 == 0); inputs.push_back({"runs", d}); }
  for (int k = 0; k < 24; k++) { std::vector<unsigned char> d(rnd() % 400); for (auto& x : d) x = (unsigned char)("aaab\x00\xff"[rnd() % 6]); inputs.push_back({"small" + std::to_string(k), d}); }

  static unsigned char A[1 << 21], R[1 << 21], O1[1 << 21], O2[1 << 21];
  const unsigned char dict[] = "hello, abcab the zlib deflate inflate";
  struct Cfg { int level, wbits, mem, strat, flush; unsigned ichunk, ochunk; bool dict; };
  std::vector<Cfg> cfgs;
  for (int level : {-1, 0, 1, 3, 6, 9}) for (int strat : {0, 1, 2, 3, 4}) for (int wbits : {15, -15, 31, 9})
    cfgs.push_back({level, wbits, 8, strat, 0, 1u << 30, 1u << 30, false});
  for (int flush : {2, 3, 5}) for (unsigned ic : {1000u, 37u}) for (unsigned oc : {1u << 30, 7u, 1u})
    cfgs.push_back({6, 15, 8, 0, flush, ic, oc, false});
  for (int mem : {1, 9}) cfgs.push_back({9, 15, mem, 0, 0, 4096, 4096, false});
  cfgs.push_back({6, 15, 8, 0, 0, 1u << 30, 1u << 30, true});
  cfgs.push_back({9, 15, 8, 1, 2, 100, 3, true});
  cfgs.push_back({6, -15, 8, 0, 0, 1u << 30, 1u << 30, true});

  for (auto& in : inputs) {
    for (auto& c : cfgs) {
      // A one-byte input chunk is slow under emulation: only on the small inputs.
      if ((c.ichunk < 100 || c.ochunk < 10) && in.second.size() > 5000) continue;
      if (c.dict && c.wbits == 31) continue;
      char nm[256]; snprintf(nm, sizeof nm, "%s L%d W%d M%d S%d F%d i%u o%u%s", in.first.c_str(), c.level, c.wbits, c.mem, c.strat, c.flush, c.ichunk, c.ochunk, c.dict ? " dict" : "");
      std::string name = nm;
      if (getenv("RT_VERBOSE")) fprintf(stderr, "%s\n", nm);
      cases++;
      unsigned la = 0, lr = 0;
      const unsigned char* d = c.dict ? dict : nullptr; unsigned dl = c.dict ? (unsigned)sizeof dict - 1 : 0;
      int rr = ref_deflate(in.second.data(), (unsigned)in.second.size(), R, sizeof R, &lr, c.level, c.wbits, c.mem, c.strat, c.ichunk, c.ochunk, c.flush, d, dl);
      mix(R, lr);
      if (isolated("deflate " + name, [&] {
        int ra = tree_deflate(in.second.data(), (unsigned)in.second.size(), A, sizeof A, &la, c.level, c.wbits, c.mem, c.strat, c.ichunk, c.ochunk, c.flush, d, dl);
        return ra != rr || la != lr || memcmp(A, R, lr) != 0;
      })) fail("deflate differs", name);
      if (rr) continue;
      // Inflate the reference stream with the tree at three buffer sizes.
      for (unsigned bs : {1u << 30, 7u, 1u}) {
        if (bs < 10 && in.second.size() > 5000) continue;
        char m1[128], m2[128]; unsigned l1 = 0, l2 = 0;
        int r2 = ref_inflate(R, lr, O2, sizeof O2, &l2, c.wbits, bs, bs, d, dl, m2);
        cases++;
        if (r2 != 1 || l2 != in.second.size() || memcmp(O2, in.second.data(), l2)) fail("reference round trip", name);
        if (isolated("inflate " + name + " bs" + std::to_string(bs), [&] {
          int r1 = tree_inflate(R, lr, O1, sizeof O1, &l1, c.wbits, bs, bs, d, dl, m1);
          bool bad = r1 != r2 || l1 != l2 || memcmp(O1, O2, l2) || strcmp(m1, m2);
          if (bad && getenv("RT_DETAIL")) { unsigned k = 0; while (k < l1 && k < l2 && O1[k] == O2[k]) k++; fprintf(stderr, "  tree %d '%s' %u, ref %d '%s' %u, first diff at %u\n", r1, m1, l1, r2, m2, l2, k); }
          return bad;
        })) fail("inflate differs", name + " bs" + std::to_string(bs));
      }
      // Corrupted copies: the error paths (state->mode = BAD) must agree with the reference.
      if (lr > 2 && in.second.size() < 50000) {
        for (int k = 0; k < 6; k++) {
          std::vector<unsigned char> bad(R, R + lr);
          int flips = 1 + (int)(rnd() % 3);
          for (int f = 0; f < flips; f++) bad[rnd() % lr] ^= (unsigned char)(1u << (rnd() % 8));
          if (k == 5) bad.resize(lr / 2);
          char m1[128], m2[128]; unsigned l1 = 0, l2 = 0;
          unsigned bs = k % 2 ? 5u : (1u << 30);
          int r2 = ref_inflate(bad.data(), (unsigned)bad.size(), O2, sizeof O2, &l2, c.wbits, bs, bs, d, dl, m2);
          cases++;
          mix(&r2, sizeof r2); mix(m2, strlen(m2));
          if (isolated("corrupt " + name + " #" + std::to_string(k), [&] {
            int r1 = tree_inflate(bad.data(), (unsigned)bad.size(), O1, sizeof O1, &l1, c.wbits, bs, bs, d, dl, m1);
            return r1 != r2 || l1 != l2 || memcmp(O1, O2, l2) || strcmp(m1, m2);
          })) fail("inflate (corrupt) differs", name + " #" + std::to_string(k));
        }
      }
    }
  }
  printf("%d cases, %d failures (%d crashes), reference digest %016llx\n", cases, fails, crashes, (unsigned long long)fnv);
  return fails ? 1 : 0;
}

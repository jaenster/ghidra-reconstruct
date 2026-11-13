#include <cmath>
#include <cfenv>
#include <cstdio>
#include <cstdint>
/*__GENERATED_FUNCTIONS__*/

static unsigned short cw() {
  unsigned short word;
  __asm__ __volatile__("fnstcw %0" : "=m"(word));
  return word;
}
static int native32(double x) {
  unsigned short saved=cw(), mode=(unsigned short)(saved | 0xc00);
  int result;
  __asm__ __volatile__("fldcw %2; fldl %1; fistpl %0; fldcw %3"
      : "=m"(result) : "m"(x), "m"(mode), "m"(saved) : "st", "memory");
  return result;
}
static long long native64(double x) {
  unsigned short saved=cw(), mode=(unsigned short)(saved | 0xc00);
  long long result;
  __asm__ __volatile__("fldcw %2; fldl %1; fistpll %0; fldcw %3"
      : "=m"(result) : "m"(x), "m"(mode), "m"(saved) : "st", "memory");
  return result;
}
int main() {
  unsigned long long cases=0, bad=0, oldBad=0, cwBad=0;
  const int modes[]={FE_TONEAREST,FE_DOWNWARD,FE_UPWARD,FE_TOWARDZERO};
  for (int m=0;m<4;m++) {
    if (std::fesetround(modes[m])) return 2;
    unsigned short before=cw();
    for (int i=-32768;i<32768;i++) {
      double x=(double)i / 16.0;
      int a=native32(x); long long b=native64(x);
      bad += correct32(x)!=a; bad += correct64(x)!=b;
      oldBad += old32(x)!=a; oldBad += old64(x)!=b;
      cwBad += cw()!=before; cases+=2;
    }
    const double wide[]={4294967295.75,-4294967295.75,2147483647.75,-2147483648.75,
      4503599627370495.5,-4503599627370495.5,0.0,-0.0,1e-300,-1e-300};
    for (unsigned j=0;j<sizeof(wide)/sizeof(wide[0]);j++) {
      double x=wide[j]; long long a=native64(x);
      bad += correct64(x)!=a; oldBad += old64(x)!=a;
      cwBad += cw()!=before; cases++;
    }
  }
  std::fesetround(FE_TONEAREST);
  std::printf("cases=%llu corrected_mismatches=%llu baseline_mismatches=%llu control_word_changes=%llu\n",cases,bad,oldBad,cwBad);
  return bad || !oldBad || cwBad ? 1 : 0;
}

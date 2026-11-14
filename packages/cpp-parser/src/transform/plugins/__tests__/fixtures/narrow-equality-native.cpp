#include <cstdint>
#include <cstdio>

/*__GENERATED_FUNCTIONS__*/

static bool machine8(int8_t a, uint8_t b) {
  uint8_t equal;
  __asm__ __volatile__("cmpb %2, %1; sete %0" : "=qm"(equal) : "q"(a), "q"(b) : "cc");
  return equal != 0;
}
static bool machine16(int16_t a, uint16_t b) {
  uint8_t equal;
  __asm__ __volatile__("cmpw %2, %1; sete %0" : "=qm"(equal) : "r"(a), "r"(b) : "cc");
  return equal != 0;
}
int main() {
  unsigned long long checks=0, bad=0, oldBad=0;
  for (unsigned a=0;a<256;a++) for (unsigned b=0;b<256;b++) {
    int8_t s=(int8_t)a; uint8_t u=(uint8_t)b;
    bool expected=machine8(s,u);
    bad+=eq8(s,u)!=expected; bad+=ne8(u,s)==expected;
    oldBad+=oldEq8(s,u)!=expected; checks+=2;
  }
  for (unsigned a=0;a<65536;a++) {
    int16_t s=(int16_t)a;
    const uint16_t values[]={(uint16_t)a,(uint16_t)(a^0x8000),(uint16_t)(a+1),0,1,0x7fff,0x8000,0xffff};
    for (unsigned j=0;j<sizeof(values)/sizeof(values[0]);j++) {
      uint16_t u=values[j]; bool expected=machine16(s,u);
      bad+=eq16(s,u)!=expected; bad+=ne16(u,s)==expected;
      oldBad+=oldEq16(s,u)!=expected; checks+=2;
    }
  }
  for (unsigned a=0;a<256;a++) {
    int8_t s=(int8_t)a;
    const uint16_t values[]={0,1,0xff,0x7f,0x80,0x7fff,0x8000,0xff80,0xffff};
    for (unsigned j=0;j<sizeof(values)/sizeof(values[0]);j++) {
      bool expected=machine16((int16_t)s,values[j]);
      bad+=eqByteWord(s,values[j])!=expected; checks++;
    }
  }
  std::printf("checks=%llu corrected_mismatches=%llu baseline_mismatches=%llu\n",checks,bad,oldBad);
  return bad || !oldBad ? 1 : 0;
}

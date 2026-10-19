// Hand-supplied body. Ghidra address 004107d0. ECX = pdwResult, EDX = pllTarget.
//
//   004107d4  MOV EAX,EBX ; 004107d6 MOV EDX,ECX   comparand EDX:EAX = new value ECX:EBX
//   004107d8  LOCK CMPXCHG8B [ESI]                 ESI = pllTarget
//   004107dc  MOV [ECX],EAX ; 004107de MOV [ECX+4],EDX
//
// A compare-exchange whose comparand and new value are the same 64 bits: on a match it
// writes back what is there, otherwise it loads it, so EDX:EAX is *pllTarget either way and
// the target never changes - an atomic 64-bit read. The comparand (EBX, ECX) is a
// don't-care; 0 stands in for it, on both sides, so a match still writes back the same value.
int64_t llValue = 0;
__atomic_compare_exchange_n((int64_t*)pllTarget, &llValue, (int64_t)0, false,
                            __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); // 004107d8
*(int64_t*)pdwResult = llValue;                                  // 004107dc / 004107de

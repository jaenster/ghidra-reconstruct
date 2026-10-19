// Hand-supplied body. Ghidra address 00408090.
//
//   00408090  MOV EAX,[ESP]   ; this call's return address
//   00408093  RET
//
// The address of the instruction after the call in the caller. Declared noinline: inlined,
// __builtin_return_address(0) would be the CALLER's return address instead.
return (int32_t)(uintptr_t)__builtin_return_address(0);

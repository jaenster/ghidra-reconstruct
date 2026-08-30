// Hand-supplied body. Ghidra address 0041d6d0.
//
// The decompiler cannot express this function: it allocates two variable-length
// buffers with _alloca (__alloca_probe_16 @006869d0, replaced by Ghidra's
// alloca_probe injection), which makes the stack spacebase untrackable
// ("Unable to track spacebase fully for stack"). Two consequences, both of
// which make the generated body unusable rather than merely unspellable:
//
//   1. The outgoing-argument PUSHes and the CALL return-address pushes leak
//      into the body as stores to &stack0xNNNNNNNN + <runtime>, which is what
//      the six "was not declared in this scope" errors are.
//   2. Ghidra tracks the FIRST alloca's shift and DROPS THE SECOND's. It
//      renders EBX (the second buffer) as a bare &stack0xffffffe0 - which is
//      ESP *before* either allocation, i.e. the saved-register area and the
//      return address. Any respelling of the six names therefore compiles and
//      then memcpy()s the RSA payload over this function's own return address.
//
// Every statement below cites the instruction it comes from, so the buffer
// binding is checkable against the disassembly. The two allocations are:
//
//   0041d709  CALL __alloca_probe_16   size = EAX = EBX = [ESI] = nDataLen
//   0041d70e  MOV  EDI,ESP             -> pHash   (allocated FIRST, higher)
//   0041d72e  CALL __alloca_probe_16   size = EAX = [ESI] = nDataLen
//   0041d735  MOV  EBX,ESP             -> pSig    (allocated SECOND, lower)
//
// so pSig < pHash. Ghidra's output has the inequality the other way round.
//
// The /GS cookie (0041d6d6, 0041d6bc) and the __security_check_cookie tail call
// are compiler-emitted prologue/epilogue, not source, and are omitted.
uint32_t* rsaPair[2];
uint32_t  bVerified   = 0;                                  // 0041d6e8  XOR EDI,EDI
int32_t   nKeyIdSaved = nKeyId;                             // 0041d6ed  MOV [EBP-0x8],EDX

if (pContext->nBytesBuffered == pContext->nBufferSize &&     // 0041d6e4 / 0041d6ea
    *(int*)pContext->pDataBuffer == 0x5349474e) {            // 0041d6f6 / 0041d6f9  'SIGN'

  uint32_t nSigLen = pContext->nDataLen;                     // 0041d705  MOV EBX,[ESI]
  uint8_t* pHash   = (uint8_t*)__builtin_alloca(nSigLen);    // 0041d709 / 0041d70e

  SSystem::SSYSTEM_Memset(pHash, nSigLen, 0xbb);             // 0041d710-0041d717
  pHash[pContext->nDataLen - 1] = 0x0b;                      // 0041d71c / 0041d722
  Sha1_Finalize((int32_t)pHash, pContext->sha1State + 1);    // 0041d71e-0041d727

  uint8_t* pSig = (uint8_t*)__builtin_alloca(pContext->nDataLen); // 0041d72c-0041d735

  SSystem::STORM_Memcpy(pSig, (void*)((int)pContext->pDataBuffer + 4),
                        pContext->nDataLen);                 // 0041d733-0041d740
  SSIG_InitRSAPair((uint32_t*)rsaPair);                      // 0041d745 / 0041d748
  CryptRSA_Prepare(nKeyIdSaved, pContext->nDataLen, pModulus,
                   pContext->nFlags, rsaPair);               // 0041d74d-0041d75f
  CryptRSA_Process(pSig, pContext->nDataLen, rsaPair);       // 0041d764-0041d76b
  bVerified = (SSystem::SSYSTEM_MemCompare(
                   (int*)pSig,
                   (D2QServerClientConnectionStrc*)pHash,
                   pContext->nDataLen) == 0);                // 0041d770-0041d783
  SSIG_FreeRSAPair((void**)rsaPair);                         // 0041d780 / 0041d786
}

SMem::SMemFree(pContext->pDataBuffer, ".\\SOURCE\\SSignature.cpp", 0xd0, 0); // 0041d78b-0041d79b
SMem::SMemFree(pContext, "delete", -1, 0);                   // 0041d7a0-0041d7aa
return (int)bVerified;                                       // 0041d7af  MOV EAX,EDI

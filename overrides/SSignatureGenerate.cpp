// Hand-supplied body. Ghidra address 0041d590.
//
// Same cause as SSignatureVerifyStream_Finish: three _alloca regions
// (__alloca_probe_16 @006869d0) make the stack spacebase untrackable, so the
// outgoing-argument PUSHes and the CALL return-address pushes leak into the
// body as stores to &stack0xffffffcc + <runtime>. Here Ghidra DOES track all
// three shifts correctly (-nKeySize, -2*nKeySize, -3*nKeySize), so the
// generated body is spatially right - it is only unspellable. The body below
// therefore reproduces Ghidra's own relative layout, and nothing more is
// claimed for it than that.
//
// The three allocations, each nKeySize bytes:
//
//   0041d5c2  CALL __alloca_probe_16 ; 0041d5c7  MOV EDI,ESP  -> pHash
//   0041d5e8  CALL __alloca_probe_16 ; 0041d5ed  MOV ESI,ESP  -> pSig1
//   0041d620  CALL __alloca_probe_16 ; 0041d625  MOV EAX,ESP  -> pSig2 ([EBP-0x10])
//
// KNOWN GHIDRA DEFECT, not fixable from here: the binary returns EAX - 1 at
// 0041d6b1 on a verified round-trip, 0 at 0041d67b otherwise - but the Ghidra
// prototype says void, so the result cannot be spelled. Correcting the
// prototype to `int` (or BOOL) is a one-line set_prototype; this file then
// gains `return 1;` / `return 0;` at the two marked points. No caller of this
// exported function exists in Game.exe, so the missing return is inert today.
//
// The /GS cookie (0041d596, 0041d6bc) is compiler-emitted and omitted.
uint32_t* rsaPair1[2];
uint32_t* rsaPair2[2];
int       nMarkerOffset;

uint8_t*  pDataBytes = (uint8_t*)pData;                      // 0041d5a6  MOV [EBP-0xc],ECX
uint32_t  nDataLen   = *pnDataLen;                           // 0041d5ad  MOV EDX,[EDX]

// SSIG_FindSignatureMarker (0041d340) never writes EDX - it is a leaf that
// touches only EAX, ECX and [ESI] - so EDX still holds *pnDataLen at 0041d5bd.
// Ghidra's `extraout_EDX` there is an artifact of not modelling that.
if (!SSIG_FindSignatureMarker(nKeySize, nDataLen, pData, &nMarkerOffset)) // 0041d5b2-0041d5bb
  nMarkerOffset = (int)nDataLen;                             // 0041d5bd  MOV [EBP-0x8],EDX

uint8_t* pHash = (uint8_t*)__builtin_alloca(nKeySize);       // 0041d5c0-0041d5c7
SSystem::SSYSTEM_Memset(pHash, nKeySize, 0xbb);              // 0041d5c9-0041d5d0
pHash[nKeySize - 1] = 0x0b;                                  // 0041d5dc
SSIG_HashData((uint32_t)nMarkerOffset, pDataBytes, (int32_t)pHash); // 0041d5d5-0041d5e1

uint8_t* pSig1 = (uint8_t*)__builtin_alloca(nKeySize);       // 0041d5e6-0041d5ed
SSystem::STORM_Memcpy(pSig1, pHash, nKeySize);               // 0041d5ef-0041d5f2
SSIG_InitRSAPair((uint32_t*)rsaPair1);                       // 0041d5f7 / 0041d5fa
CryptRSA_Prepare(nKeyId, nKeySize, pModulus1, nModulus1Len, rsaPair1); // 0041d5ff-0041d60f
CryptRSA_Process(pSig1, nKeySize, rsaPair1);                 // 0041d614-0041d619

uint8_t* pSig2 = (uint8_t*)__builtin_alloca(nKeySize);       // 0041d61e-0041d625
SSystem::STORM_Memcpy(pSig2, pSig1, nKeySize);               // 0041d627-0041d62d
SSIG_InitRSAPair((uint32_t*)rsaPair2);                       // 0041d632 / 0041d635
CryptRSA_Prepare(nKeyId, nKeySize, pModulus2, nModulus2Len, rsaPair2); // 0041d63a-0041d64a
CryptRSA_Process(pSig2, nKeySize, rsaPair2);                 // 0041d64f-0041d657

if (SSystem::SSYSTEM_MemCompare((int*)pSig2,
                                (D2QServerClientConnectionStrc*)pHash,
                                nKeySize) == 0) {            // 0041d65c-0041d669
  *(uint32_t*)(pDataBytes + nMarkerOffset) = 0x5349474e;     // 0041d686  'SIGN'
  SSystem::STORM_Memcpy(pDataBytes + nMarkerOffset + 4, pSig1, nKeySize); // 0041d685-0041d693
  *pnDataLen = (uint32_t)(nMarkerOffset + nKeySize + 4);     // 0041d69b / 0041d69f
  SSIG_FreeRSAPair((void**)rsaPair2);                        // 0041d6a1 / 0041d6a4
  SSIG_FreeRSAPair((void**)rsaPair1);                        // 0041d6a9 / 0041d6ac
  // 0041d6b1  MOV EAX,0x1  -> `return 1;` once the prototype returns int.
} else {
  SSIG_FreeRSAPair((void**)rsaPair2);                        // 0041d66b / 0041d66e
  SSIG_FreeRSAPair((void**)rsaPair1);                        // 0041d673 / 0041d676
  // 0041d67b  XOR EAX,EAX  -> `return 0;` once the prototype returns int.
}

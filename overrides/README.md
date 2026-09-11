# Hand-supplied function bodies

The generator emits only what it derives from the Ghidra database. These two files
are the exception the rule allows for: a decompiler representation with no faithful
C spelling, where the honest spelling has to be supplied from outside.

Both functions in `Storm/Source/SSignature.cpp` call `__alloca_probe_16` (`006869d0`).
Ghidra replaces that with its `alloca_probe` injection, the stack spacebase stops
being trackable, and two things happen to the emitted body:

- the outgoing-argument `PUSH`es and the `CALL` return-address pushes leak in as
  stores to `&stack0xNNNNNNNN + <runtime>` — the six
  `'stack0xNNNNNNNN' was not declared in this scope` errors;
- in `SSignatureVerifyStream_Finish`, Ghidra tracks the **first** alloca's shift and
  **drops the second's**, rendering the second buffer as a bare `&stack0xffffffe0` —
  ESP *before either* allocation, i.e. the saved registers and the return address.

The second point is why a spelling-only fix was rejected: any respelling of those six
names compiles and then `memcpy`s the RSA payload over the frame. The full analysis is
in `~/code/re/diablo2/docs/analysis/artifact-ssignature.md`.

Every statement in these bodies cites the instruction it comes from, so the buffer
binding is checkable against the disassembly.
`packages/reconstruct/src/__tests__/alloca-override.test.ts` asserts the bindings.

## Registration

`project/` is gitignored, so the registration itself is not tracked. `project.json`
needs:

```json
"overrides": [
  { "address": "0041d590", "name": "SSignatureGenerate",
    "action": "replace", "sourceFile": "../overrides/SSignatureGenerate.cpp" },
  { "address": "0041d6d0", "name": "SSignatureVerifyStream_Finish",
    "action": "replace", "sourceFile": "../overrides/SSignatureVerifyStream_Finish.cpp" }
]
```

## Open Ghidra item

`SSignatureGenerate`'s prototype says it returns `void`. The binary returns `EAX`:
`1` at `0041d6b1`, `0` at `0041d67b`. Correcting the return type to `int` lets
`SSignatureGenerate.cpp` gain its two `return` statements at the marked points.

## MONSTERAI_GetAiFunctionFromTable (patch, not a replacement)

`005b15d0` picks a monster's AI descriptor by indexing `arrGeneralAiList` with its MonStats
`AI` column, bounds-checked against the table size. The binary is unambiguous:

    005b161f MOVZX EAX, word ptr [ESI + 0x1e]   ; pMonStatsTxt->AI
    005b1628 CMP   AX, 0x94                     ; 148 == sizeof(arrGeneralAiList)/16
    005b162c JNC   -> return arrGeneralAiList    ; fall back to entry 0
    005b1631 SHL   EAX, 0x4
    005b1635 ADD   EAX, 0x73ca18                ; arrGeneralAiList + AI

Ghidra's decompiler renders that constant as an **undeclared variable**:

    if ((-1 < wAiIndex) && ((ushort)wAiIndex < uVar3)) { ... }

`uVar3` appears in no variable list and is assigned nowhere, so the emitted body compares the
AI index against uninitialised stack. The check fails, every monster falls back to entry 0 —
`AI_Function1_None` — and the whole game's monster AI does nothing: measured 2026-09-10, 49
monsters spawned with AI structs and armed timers, ticking thousands of times, every one of
them running `AI_Function1_None`.

It resists every Ghidra-side fix tried: retyping the `AI` field (`short`/`ushort`), retyping
the local `pMonStatsTxt` from the wrong `D2UnitDataMonsterStrc *` to `D2MonStatsTxt *` (which
did clean up the field access), and retyping `wAiIndex`. The constant never comes back.

Registration in `project.json`:

```json
{ "address": "005b15d0", "name": "MONSTERAI_GetAiFunctionFromTable",
  "action": "patch",
  "patches": [ { "find": "wAiIndex < uVar3", "replace": "wAiIndex < 0x94" },
                { "find": "wAiIndex < uVar3", "replace": "wAiIndex < 0x94" } ] }
```

The comparison is emitted **twice** - Ghidra duplicates the block at its `goto` target, and the
second copy is the hot one (`nFunctionId == 0`, which is what monster spawn passes). Patches
apply in order and each replaces the first remaining match, so the entry is listed twice.

The `find` is deliberately the comparison and not the bare name: the synthesized
`uint32_t uVar3;` declaration is emitted first and `applySinglePatch` replaces only the first
occurrence. The declaration is left behind unused, which is harmless.

**Retire-When:** the decompiler recovers the constant, or the comparison is expressed in Ghidra
some other way. Re-check by decompiling 005b15d0 and looking for `0x94`.

## The register-split family (patches)

Ghidra's default x86 model marks EAX/ECX/EDX **killed by call**. When the original compiler kept a
value in one of those across a call to a function that demonstrably never writes it, Ghidra splits
one variable into two and leaves the post-call half declared and never assigned. The emitted code
then indexes or loops on uninitialised stack. "Unaffected" lives in the calling-convention prototype
model (the cspec), not in a per-function signature, so `set_prototype` and `set_custom_signature`
cannot express it - hence patches.

Found by `docs/tools/unassigned_bounds.py` and confirmed against the disassembly.

### TXT_AllocTxt_montype (00658520)

EDX is the inner loop counter: `00658682 XOR EDX,EDX`, passed as the `__fastcall` 2nd argument at
`00658692 CALL 00658460` (MONSTERTBLS_GetMonSeqFrameCount), then reused after the call as the bit
index at `0065869e/006586a6` and incremented at `006586ba`. All of 00658460-0065851f was
disassembled: EDX is only ever read there (`TEST EDX,EDX`, `CMP EDX,ECX`), never written, and the
callee makes no calls. Emitted, the OR at MonsterTbls.cpp indexes the montype bit matrix with
`((int)nColTypeIdx >> 5) * 4` off uninitialised stack - **an unbounded OOB write during table
load** - and `nBitIdx = nColTypeIdx + 1` makes the trip count garbage.

```json
{ "address": "00658520", "name": "TXT_AllocTxt_montype", "action": "patch",
  "patches": [ { "find": "((int)nColTypeIdx >> 5)", "replace": "((int)nBitIdx >> 5)" },
               { "find": "BitMaskAnd[nColTypeIdx & 0x1f]", "replace": "BitMaskAnd[nBitIdx & 0x1f]" },
               { "find": "nBitIdx = nColTypeIdx + 1;", "replace": "nBitIdx = nBitIdx + 1;" } ] }
```

### CUnit::GetName (00464a60)

Same shape, two registers. `00464ae9 XOR ECX,ECX` and `00464ae6 MOV EDX,[EBP-0x4]` initialise the
loop index and bound; `00464afd CALL 00464a10` (CUNIT_IterateUntilWarp) touches only EAX and flags -
the whole callee is `TEST EAX,EAX / CMP [EAX],0x5 / MOV EAX,[EAX+0xe8] / XOR EAX,EAX / RET`. Both
registers survive and the loop continues with them at `00464b06 ADD ECX,1 / 00464b09 CMP ECX,EDX`.
Emitted, `nIdx = nAdjRoomIdx;` overwrites the live index with uninitialised stack and
`pAdjacentRooms[nAdjRoomIdx]` hands a **wild D2RoomStrc\*** to ROOM_GetWarpDestinationName - reached
by hovering a level exit.

```json
{ "address": "00464a60", "name": "GetName", "action": "patch",
  "patches": [ { "find": "nIdx = nAdjRoomIdx;", "replace": "(void)0;" },
               { "find": "__frame0.nAdjacentCount = nAdjRoomCount;", "replace": "(void)0;" },
               { "find": "__frame0.pAdjacentRooms[nAdjRoomIdx]", "replace": "__frame0.pAdjacentRooms[nIdx]" } ] }
```

### MONSTER_RollAndAssignUMods (005a0760)

Not a split - a lost CONSTANT, the same species as the monster-AI `0x94`. `005a0777 XOR EDX,EDX`
makes EDX the function's zero register, and every comparison the emitter turned into `nNull` is a
compare against it: `005a0779 CMP EAX,EDX`, `005a0799 CMP ESI,EDX`, `005a07b0 CMP EDI,EDX`,
`005a07d9 CMP ECX,EDX`, `005a07e7 CMP [EBP+0xc],EDX`. Ghidra declared `int nNull;` and never
assigned it, so five null/bounds tests in the unique- and champion-modifier roll run against
uninitialised stack. All five occurrences are replaced; the dead declaration is left behind.

**Retire-When:** a custom prototype model with ECX/EDX unaffected is added to the x86win cspec and
assigned to the two leaf callees (00658460, 00464a10). That would fix both properly and retire both
entries.


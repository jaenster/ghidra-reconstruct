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

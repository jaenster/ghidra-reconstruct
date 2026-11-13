# Graduation: freezing the code shape of a matched function

A function graduates when the VC8 oracle has proven that our compile of it equals the original's
bytes (status MATCH in `asm_matching/msvc8/evidence/audit.tsv`). From then on the live daemon no
longer derives that function's statements from the Ghidra decompile. It keeps emitting the body
that was proven, and Ghidra changes that would alter that body's code shape are reported as
conflicts instead of applied.

Plain freezing (store the C++ text, emit it forever) is not enough: a matched function still has to
take struct, field, type and symbol changes from Ghidra, or the frozen text drifts away from the
headers it compiles against. So a graduated body freezes its **code shape** only. Every name in it
stays bound to Ghidra, and names, types and layouts still reach it as AST-level refactors, after which
the oracle checks it again.

## What is frozen and what is not

|Frozen (the shape)|Still from Ghidra (the bindings)|
|-|-|
|statement order, control flow, temporaries, expression trees, casts, constants, literals|the name of every function, global, parameter, local, type and field the body mentions|
|the vc8form forms already applied to the body|the namespace and TU the function lives in, and how references are qualified|
|which callee each call targets (by address)|declared types of parameters, locals, globals and fields; struct layouts|

## The graduated record

One record per function, keyed by address (never by name: 186 function names are shared):

- `addr`, `bh` (original size and byte hash, as in the vc8form tag) and `ev` (the evidence row);
- `body`: the matched body as a C++ AST in which every identifier is a **binding**, not a string.
  Functions and globals bind by address, types by Ghidra data type ID, fields by (type ID, offset at
  graduation, name at graduation), parameters by ordinal, locals by frame or register storage and
  first-use ordinal. Generator temporaries (`t2_c2`, `uVar1`) bind as locals with their own name;
- `gshape`: the shape hash of the generator's own output for the function at graduation, before
  vc8form rewriting: tokens one space apart, comments dropped, every qualifier dropped, every
  identifier replaced by a placeholder;
- `decls`: the declared type of each bound parameter, local and global at graduation.

Emitting a graduated function means printing `body` with the current name, qualification and
declared type of each binding, taken from the daemon's model. A rename, a namespace move, a type
rename or a field rename therefore needs no rewrite step at all: it is how the body is printed.

## Each Ghidra change

The daemon still extracts and generates graduated functions as it does now, into a side buffer that
is never emitted. Per dirty graduated function it compares, in this order:

1. The fresh generator output's shape hash against `gshape`. Equal means Ghidra changed only
   names, qualifiers or comments: print `body` with the new bindings. Done.
2. The fresh output with casts removed against the old output with casts removed, and the declared
   types against `decls`. If the only difference is declarations plus casts Ghidra added or dropped
   around them, apply the declaration changes to `body` and keep its own casts. Mark the function
   for re-check.
3. Anything else is a **conflict**. The body is printed with the new bindings and its old shape, the
   conflict is written to the daemon log and `graduation-conflicts.tsv` (address, version, class,
   unified diff of fresh against frozen), and the function stays graduated.

A binding that no longer resolves (a field whose offset moved or whose type ID vanished, a callee
address no longer a function, a local whose storage Ghidra split) is also a conflict, class
`binding`. The daemon never guesses a replacement.

After every batch that touched a graduated function in case 1 or 2, the oracle compiles the touched
TUs (cheap since the Zig port) and re-checks those functions. Still MATCH: the change is accepted
and `gshape`/`decls` move to the new values. Lost MATCH: the change is reverted for that function
only (old declarations kept via a cast at the definition, or the batch flagged if that cannot
compile) and reported as a conflict of class `oracle`.

## Change classes, measured

Method: `source/regen` history in `recon/diablo-2`, every consecutive pair of regen commits from
d6f7ec21e (v2055) to baff97c37 (v2075): 27 pairs, 18 of them a Ghidra version step, 9 a generator
redeploy at the same version. The function set is the 8675 functions MATCH in the v2054 audit,
i.e. what would have graduated at the start of the window. Bodies are cut at `// 1.14d:` markers
and brace-matched, comments dropped, then compared token-wise with identifiers normalised. Scripts:
`scratchpad/n1153/grad/classify.py` and `show.py`; rows in `changes-v2054set.tsv`.

|Class|Handling|Ghidra steps: rows / functions|Generator redeploys: rows / functions|
|-|-|-|-|
|qualifier only (callee moved namespace)|mechanical|123 / 76|0|
|identifier rename (callee 3, callee+global 1)|mechanical|4 / 4|2 / 1 (field)|
|builtin type spelling only|mechanical + re-check|0|2 / 1|
|cast added or dropped after a retype|mechanical + re-check|18 / 18|8 / 4|
|field rename, type rename, struct layout|mechanical|0 seen|0 seen|
|shape: parameter retype narrowed a call argument (004804a0)|conflict|2 / 1|-|
|shape: global retype turned `*(uint32_t*)(char*)&g` into `g` (004a7a80, 004a7a90)|conflict|2 / 2|-|
|shape: local retype split a variable (00646c00, 0064b760)|conflict|2 / 2|-|
|shape: temporary added, then removed again (004cc870)|conflict|2 / 1|-|
|shape: if/else inverted, then back (00435580)|conflict|2 / 1|-|
|shape: generator rules and forms|not applied (generator)|-|116 / 100|

Over 18 Ghidra versions, 105 graduated functions changed; 98 of those changes are mechanical by
this rule and 7 functions (10 changes) would have raised a conflict. Four of the ten were flip-flops
that Ghidra itself reverted one or two versions later. All 7 conflict functions are MATCH again at
the end of the window, so in hindsight none of the conflicts was a real regression, but the one
real loss in the window that came from Ghidra (PATH_SetTargetAndCalculate at v2058, lost in the
1149 audit, recovered at v2059) is in that set. The 1149 audit lost 9 more of the set, all from the
generator redeploy at v2058; graduation would have kept those.

Measured: the counts above, and that no MATCH function of the set moved TU in the window. Estimated:
that 2 and 3 above separate the same way on the daemon's model as on emitted text (the measurement
used text); the per-class rates outside this window; that field renames and layout changes are rare
(none touched a graduated body here, but struct work came in bursts before v2055). Not measured:
how often the step-2 re-check would have failed, because the oracle was not run per version.

## Un-graduating

Explicit only: `graduate --release <addr>` on the control endpoint, or deleting the record. The
next batch emits the function from Ghidra as any other, and the oracle decides whether it is still
MATCH. A conflict never un-graduates by itself. Resolving a conflict means one of: accept the fresh
shape (release, let the oracle re-measure, re-graduate on MATCH), keep the frozen shape and record
the conflict as acknowledged until the next change, or fix Ghidra so the fresh output returns to the
graduated shape. A function whose original bytes changed (`bh` no longer matches the program) is
released automatically, because the proof no longer applies.

## Where the records live

In a separate store, not in the generated tree: `graduated/` on `source/modified` (`recon/modified`),
one JSON file per address, read by the daemon the way it already reads `foreignReferences` from
`recon/modified/Redivivus`, and excluded from the rsync and the regen merge like `Redivivus/`.

- The generated tree is output. If the frozen body were its own previous output, every regen would
  read back what it wrote and a broken emission could graduate itself.
- The record needs data the C++ text does not hold: bindings, `gshape`, `decls`, `ev`, `bh`.
- TU moves and namespace moves rewrite paths in the generated tree; an address-keyed file does not
  move, so nothing has to follow it.
- Git history on one small file per function is the audit trail for each acceptance and conflict.
- `source/regen` stays a record of what the pipeline alone produces. Like overrides, graduated
  bodies are generator input that lands there, so every report gives both numbers: emitted from
  Ghidra versus emitted from the store.

## Interactions

- **Namespace moves.** Moving a function or a callee changes only qualification, which the record
  does not store: no conflict, no lost MATCH. This retires the stale-vc8form-after-a-move class for
  graduated functions (56 moves cost 7 MATCH at v1937/v1938). The dirty-unit fix e55db1d still
  applies: a moved graduated function is printed into its new unit.
- **File-static.** Linkage and the static register convention are decided per TU by
  file-static-functions.ts from all callers. A graduated body keeps being selected the same way; if
  the selection for it or a callee changes (a caller moved TU), that is a conflict of class
  `linkage`, because VC8's code for it changes.
- **vc8form tags.** The forms are already in `body`, so the tags are not re-applied to a graduated
  function and their `dh` going stale is not an event. The tags stay in Ghidra as provenance; a
  tag added or changed on a graduated function is a conflict (someone asked for a different form).
  On release the tags apply again and are re-measured like any other.
- **Hand-follow delta.** The oracle measures `source/modified`, so a hand hunk inside a MATCH
  function was part of what matched. Graduation takes the body from that measured tree: the hunk
  becomes part of `body`, and `hand-follow.py inventory` drops it from the delta at the same commit. Afterwards nothing hand-written may touch a graduated function in the
  tree: the change goes into the record and through the oracle instead.
- **Dirty units.** The record's bindings are the function's dependency edges in `buildinfo.json`, so
  the existing hash-driven propagation decides when a graduated body must be printed again.

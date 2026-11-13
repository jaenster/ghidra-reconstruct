# The ratchet: bodies a regen may not take away

A regen must never silently replace a function body that byte-matched the original with one that
may not, and must never overwrite a body someone edited by hand. The ratchet keeps both kinds of
body in one per-function store, and prints them again under whatever names the current Ghidra
gives the things they refer to. Renames, namespace moves and field renames keep flowing into the
kept code: this is not the plain freezing the owner rejected on 2026-11-10 (graduation.md).

## The store

`ratchet/` on `source/modified` (`recon/modified/ratchet`), committed, beside the VC8 evidence
that justifies it:

|Path|What|
|-|-|
|`ratchet/fn/<address>.json`|one record per function, kind `match` or `pin`|
|`ratchet/release.tsv`|addresses whose generated body goes through anyway, with the reason|

Why there and not in ghidra-reconstruct:

- A `match` record is a consequence of a measurement of `source/modified`, and only a measurement
  may advance it. It belongs in the same history as `asm_matching/msvc8/evidence/audit.tsv`, so
  one commit can say "evidence at N, store advanced", and a `git log` on one record is the audit
  trail of that function.
- A `pin` is hand-written code. Hand-written code lives on `source/modified`; ghidra-reconstruct
  is a tool that also drives other targets and holds no Diablo II data.
- The generator already reads `source/modified` (`foreignReferences` reads `Redivivus/`), and the
  daemon already treats paths there as never-touch (`packages/live/src/paths.ts`: `ratchet/` is in
  `NEVER_TOUCH`; `hand-follow` excludes it). The store is not generator output, so the regen merge
  never sees it.
- Records are keyed by address, never by name or path: TU moves and renames do not move them.

The generator finds the store through `project.json`:

```json
"ratchet": { "store": "~/code/re/diablo2/recon/modified/ratchet" }
```

`RECON_RATCHET_STORE=<dir>` overrides it; `RECON_RATCHET=0` turns the ratchet off, which is how
the unaided number is measured (A/B, as for overrides in regen-workflow.md).

## A record

`members[0]` is the function; for a `match`, the rest are its file-static callees (transitive,
same file). VC8 gives a static function a custom register convention and may inline it, so the
caller's bytes follow the callee's shape: deploy 1163 lost `0057eab0` because its static callee
`0057e860` changed. A member body is kept as captured:

- `text`: the whole definition as emitted (`source/modified` at the evidence commit);
- `scope`, `params`, `paramTypes`, `ret`: what it was printed against;
- `bindings`: for every reference site in the body (a name, a member, a type), what it denotes
  independently of its spelling: a function or global by address, a field by (struct, offset), an
  enum constant by (enum, value), a type by name, a parameter by position. A callee binding also
  carries the callee's parameter names and types and its return type; a field or global binding
  its type;
- `siteHash`: proves the parser re-finds the same sites in `text` later.

Sites are found on the parse of the body (cpp-parser), numbered in walk order; edits are spliced
at the parser's locations, so everything that is not a reference stays byte for byte.

## Every regen: apply (generator, full regen and live daemon alike)

`writeProject` (codegen/index.ts) runs `applyRatchetToProject` after the overrides, over every
unit's text, re-emitted or reused, so the live daemon's dirty-unit path and the batch regen behave
the same. Only `match` records apply there; pins never enter `source/regen`. Per record:

1. Fresh body equal to the stored one modulo spelling (bindings compared, comments ignored), or
   equal after re-spelling: nothing to do.
2. Different: the stored body is printed under the current index: a function by its address's
   current qualified name (as deeply qualified as before when that resolves, else the spelling the
   fresh body uses, else the shortest that resolves), a field by the name at its offset, a
   parameter by position in the current signature; a call whose callee's parameters were renamed
   or re-ordered gets its arguments re-ordered by name. The body replaces the fresh one; the
   signature and comments stay fresh.
3. Not printable: a symbol gone, a field offset gone, a type gone, the function's arity or a
   parameter or return type changed, a callee, field or global retyped, a callee that gained a
   parameter or would drop an argument with a side effect. Then the fresh body stays, the stored
   one is kept under `#if 0` right above it with the reason, and the function is reported. The
   regen never fails for it.

Report: `<project>/.ghidra-mcp/ratchet-report.tsv` (status, address, name, record, kind, detail),
one summary line in the generation log, one `RATCHET UNRESOLVED` line per function that could not
be kept. Statuses: `kept`, `equal`, `released`, `unresolved`, `stale` (the parser no longer
re-finds the stored sites: recapture), `gone` (not defined any more), `shadowed` (another record
already supplied that body).

## Every merge into source/modified: `ratchet merge`

```sh
node <gr>/packages/reconstruct/dist/ratchet/cli.js merge --tree recon/modified source/regen
```

Replaces `git merge source/regen`; the live daemon's `mergeIntoModified` does this whenever
`<modified>/ratchet` exists. For every file holding a pinned function, the pin is printed under the
regen's names and that text replaces the function's body in base, ours and theirs before
`git merge-file` runs: the three agree on every pinned region, so the textual merge only sees the
rest of the file and a pinned body is never merged as text. A pin that cannot be re-spelled is
reported and kept under `#if 0` beside the generated body. Then the hand-written files
(`Redivivus/`, `support/`) follow the regen: their references are bound under the tree before the
merge and re-spelled under the regen (a moved function re-qualified, a renamed field renamed, a
callee whose parameters changed called with its arguments re-ordered by name and side-effect-free
dropped arguments removed, the header that now declares a moved function included next to the
old one). Hand files use macros the parser does not know, so they are read as tokens: qualified
names, and unqualified names only where they are called. What cannot be followed is listed; the
rest of the file is still followed. Conflicts outside pinned functions are left as markers, as
before.

## Pins: hand edits without merge pain

```sh
# capture the edited function from the working tree of source/modified
node <gr>/packages/reconstruct/dist/ratchet/cli.js pin --tree recon/modified --store recon/modified/ratchet \
  0052d7b0 005e8530 --note "restores the dropped 0x53 stores; Retire-When: ..."
node <gr>/packages/reconstruct/dist/ratchet/cli.js unpin --store recon/modified/ratchet 0052d7b0
```

Scriptable: any number of addresses, one record each, exit 1 if any could not be captured. A pin
always wins over the generated body. A pin whose stored body equals the fresh one modulo spelling
shows `equal` in the merge report: the edit has reached the generator and the pin can go.

## The escape hatch: releasing a kept body

A deliberate behaviour change (deploy 1163's store fix in `0057e860`, which the ratchet would
otherwise revert because `0057eab0` was MATCH with the old callee) is let through by either:

- `ratchet release --store recon/modified/ratchet 0057eab0 --reason "nLevel store fix, 1163"`
  (a row in `release.tsv`), or
- the Ghidra function tag `ratchet:release` on the function (read from the source map's
  `ratchet: "release"`; no store edit needed).

Releasing a record's root lets every member through; releasing a member lets only that member
through. The next measurement consumes a release: still MATCH, the new body is stored; not MATCH,
the record is retired (the generated body won deliberately) and the release row removed.

## The ratchet only advances on measurement

After a full VC8 measurement of `source/modified`:

```sh
node <gr>/packages/reconstruct/dist/ratchet/cli.js advance --tree recon/modified \
  --audit recon/modified/asm_matching/msvc8/evidence/audit.tsv --evidence <evidence-commit> \
  --store recon/modified/ratchet --regen source/regen --report advance.tsv
```

|Status|Meaning|Store|
|-|-|-|
|`new`, `refreshed`|MATCH, captured (refreshed: the tree's text differs from the record, e.g. renamed)|written|
|`unchanged`|MATCH, same text|untouched|
|`hand`|MATCH, but the body differs from `--regen`: a hand edit. Pin it.|not captured|
|`phase-noise`|not MATCH, the tree carries the stored body: something outside the body moved (00633f40 at 1163)|kept, not advanced|
|`lost`|not MATCH and the tree carries another body (see the apply report for why)|kept|
|`retired`|released and not MATCH|record and release removed|
|`uncapturable`|the body does not parse standalone (5 EH destructors with local classes)|not captured|

## Trade-off to know

A kept file-static callee is kept even when its change was an improvement: at 1162,
`005153c0` went OUR-3 to OUR-2 while its caller stayed MATCH. The ratchet cannot know that
without measuring; the apply report lists such members (`kept` with a `record` other than their
own address), and a release is how they go through.

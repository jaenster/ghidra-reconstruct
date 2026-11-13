# Regen scripts

Reproducible reconstruction loop (previously lived as ad-hoc `/tmp` scripts).

## Setup
    cp scripts/.env.example scripts/.env      # then fill in (gitignored)

`.env` holds the PRIVATE Ghidra server path + local machine paths — never committed.

## Run
    ./scripts/start-daemon.sh                 # launch the local ghidra-mcp daemon (RMI checkout)
    ./scripts/regen.sh                        # reconstruct -> sync to RECON_OUTPUT_REPO -> measure errors

`regen.sh` runs `run.ts` (writes `output/`), rsyncs into `$RECON_OUTPUT_REPO`,
commits `regen: pending-msg`, and (if a cross-compiler is present) reports the
D2Common/D2Game compile-error count. Override `CXX` / `MODULES` for other targets.

Restart `start-daemon.sh` after committing new Ghidra changes (forces a fresh checkout).

## hand-follow
    pnpm hand-follow inventory --base source/regen --head source/modified -o OUT   # run in the redivivus tree

Carries source/modified's hand delta through regens that move functions between files, keyed
by each function's `// 1.14d:` marker. Subcommands `inventory`, `plan`, `reapply`, `audit`,
`simulate`; the usage is in `packages/live/src/hand-follow/cli.ts`. It replaces redivivus
`tools/hand-follow.py` with byte-identical outputs (golden tests in
`packages/live/src/__tests__/hand-follow.test.ts`).

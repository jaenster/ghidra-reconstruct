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

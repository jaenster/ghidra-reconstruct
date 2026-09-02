#!/usr/bin/env bash
# Prove that parallel generation emits the same tree as the serial path.
#
# Both runs replay the SAME extraction snapshot, so they are the same Ghidra
# version by construction and any difference is the sharding's fault. The bar is
# byte-for-byte: a shard that built a global table from its own slice instead of
# the whole model produces a tree that still compiles and is quietly different,
# and nothing but this diff would catch it.
#
#   scripts/verify-parallel-codegen.sh [workers]     default 8
#
# Runs two codegen-only generations into scratch directories; never touches
# output/ or the recon repo.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKERS="${1:-8}"
WORK="${VERIFY_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/verify-parallel-XXXXXX")}"
SER="$WORK/serial"
PAR="$WORK/parallel"

echo "=== parallel-codegen verification ==="
echo "root:    $ROOT"
echo "workers: $WORKERS"
echo "scratch: $WORK"

cd "$ROOT"
echo "--- build ---"
# @ghidra-mcp/cpp-parser resolves through its exports map to dist/, so a change
# that was only type-checked is not the one that runs.
npx tsc -b || { echo "ABORT: tsc -b failed"; exit 1; }

rm -rf "$SER" "$PAR"; mkdir -p "$SER" "$PAR"

echo "--- serial generation ---"
S0=$SECONDS
GHIDRA_OUTPUT_DIR="$SER" npx tsx run.ts --codegen-only > "$WORK/serial.log" 2>&1
RC=$?
SERIAL_SECS=$((SECONDS - S0))
[ $RC -ne 0 ] && { echo "ABORT: serial run failed (rc=$RC), see $WORK/serial.log"; tail -20 "$WORK/serial.log"; exit $RC; }
echo "serial: ${SERIAL_SECS}s"

echo "--- parallel generation ($WORKERS shards) ---"
P0=$SECONDS
GHIDRA_OUTPUT_DIR="$PAR" npx tsx run.ts --codegen-only --gen-workers="$WORKERS" > "$WORK/parallel.log" 2>&1
RC=$?
PAR_SECS=$((SECONDS - P0))
[ $RC -ne 0 ] && { echo "ABORT: parallel run failed (rc=$RC), see $WORK/parallel.log"; tail -20 "$WORK/parallel.log"; exit $RC; }
echo "parallel: ${PAR_SECS}s"

echo "--- generation phase, as each run measured it ---"
grep -a '^  generation ' "$WORK/serial.log" | sed 's/^/  serial   /'
grep -a '^  generation ' "$WORK/parallel.log" | sed 's/^/  parallel /'
grep -a '^Parallel generation:' "$WORK/parallel.log" | sed 's/^/  /'

echo "--- byte-for-byte diff ---"
# `diff -r` reports content differences AND files present on one side only; both
# are failures. --brief keeps a mismatch from printing 40 MB of context.
if diff -r --brief "$SER" "$PAR" > "$WORK/diff.txt" 2>&1; then
  FILES=$(find "$SER" -type f | wc -l | tr -d ' ')
  BYTES=$(find "$SER" -type f -exec cat {} + | wc -c | tr -d ' ')
  echo "IDENTICAL: $FILES files, $BYTES bytes, no difference"
  echo "speedup: ${SERIAL_SECS}s -> ${PAR_SECS}s"
  [ -n "${VERIFY_DIR:-}" ] || rm -rf "$WORK"
  exit 0
else
  echo "DIFFERENT — parallel generation is WRONG. Do not use it."
  echo "  $(wc -l < "$WORK/diff.txt" | tr -d ' ') differing path(s); first 20:"
  head -20 "$WORK/diff.txt" | sed 's/^/    /'
  echo "  trees kept at $SER and $PAR"
  exit 1
fi

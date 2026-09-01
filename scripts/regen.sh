#!/usr/bin/env bash
# Reconstruct the program, sync the C++ into the output repo, and measure errors.
# Assumes start-daemon.sh is already running.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
: "${GHIDRA_PROJECT_PATH:?set in scripts/.env}"
: "${RECON_OUTPUT_REPO:?set in scripts/.env}"
export GHIDRA_PROJECT_PATH GHIDRA_PROGRAM_PATH GHIDRA_MCP_TOKEN
export GHIDRA_DAEMON_URL="${GHIDRA_DAEMON_URL:-http://localhost:8433}"

echo "[regen] reconstruct -> $ROOT/output"
( cd "$ROOT" && npx tsx run.ts )

echo "[regen] sync output -> $RECON_OUTPUT_REPO"
rsync -a "$ROOT/output/" "$RECON_OUTPUT_REPO/" --exclude='.git/'
( cd "$RECON_OUTPUT_REPO" && git add -A && git commit -q --no-gpg-sign -m "regen: pending-msg" || true
  echo "committed: $(git rev-parse --short HEAD)" )

# Optional D2-specific error measurement (override CXX/MODULES as needed).
if command -v "${CXX:-i686-w64-mingw32-g++}" >/dev/null 2>&1; then
  cd "$RECON_OUTPUT_REPO"
  RSP=/tmp/d2-incdirs.rsp; find . -type d ! -path '*/.git*' | sed 's/^/-I/' > "$RSP"
  cxx(){ "${CXX:-i686-w64-mingw32-g++}" -std=c++17 -fsyntax-only -w -fms-extensions -fpermissive -include d2_platform.h @"$RSP" -fmax-errors=0 "$1" 2>&1; }
  total=0
  for m in ${MODULES:-D2Common D2Game}; do
    n=0; for f in $(find "$m" -name '*.cpp'); do n=$((n + $(cxx "$f" | grep -c ' error:'))); done
    echo "  $m=$n"; total=$((total+n))
  done
  echo "RESULT (uncapped): total=$total"
fi

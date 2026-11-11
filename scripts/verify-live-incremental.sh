#!/usr/bin/env bash
# Prove that a generator change leaves the live daemon's incremental tree byte-identical,
# and time both, from one frozen daemon state - never the running daemon's own files.
#
#   scripts/verify-live-incremental.sh freeze <daemon-checkout> <frozen-dir>
#       Copy what one rebuild reads: project/ (project.json, the live snapshot, the
#       per-unit identifier cache and texts, the stage cache) and the previous tree.
#       Run it while the daemon is idle; it only reads the daemon's files.
#
#   scripts/verify-live-incremental.sh run <frozen-dir> <work-dir> <checkout-a> <checkout-b> [units]
#       Generate from the frozen state once with each checkout's built packages/live,
#       exactly as rebuild.ts spawns the child, and diff the trees, the identifier
#       caches, the unit texts and buildinfo.json. `units` is a number N (the first N
#       units of the identifier cache are re-emitted), `all` (full emission) or `none`
#       (every unit reused). Default 1. Each run gets its own APFS clone of the frozen
#       state, so the two cannot see each other's writes.
set -uo pipefail

cmd="${1:-}"; shift || true

case "$cmd" in
freeze)
  SRC="$1"; DST="$2"
  [ -e "$DST" ] && { echo "refusing: $DST exists"; exit 1; }
  mkdir -p "$DST/project/.ghidra-mcp"
  for f in "$SRC"/project/*; do
    [ "$(basename "$f")" = ".ghidra-mcp" ] && continue
    cp -cR "$f" "$DST/project/"
  done
  for f in live-snapshot unit-identifiers.json unit-identifiers.json.units codegen-cache buildinfo.json; do
    [ -e "$SRC/project/.ghidra-mcp/$f" ] && cp -cR "$SRC/project/.ghidra-mcp/$f" "$DST/project/.ghidra-mcp/"
  done
  cp -cR "$SRC/output" "$DST/output"
  echo "frozen: $(du -sh "$DST" | cut -f1) at $DST"
  ;;
run)
  FROZEN="$1"; WORK="$2"; A="$3"; B="$4"; UNITS="${5:-1}"
  mkdir -p "$WORK"
  IDENT="$FROZEN/project/.ghidra-mcp/unit-identifiers.json"
  case "$UNITS" in
    all)  EMIT_ENV=() ;;
    none) EMIT_ENV=(RECON_REUSE_DIR=@OUT@ RECON_EMIT_UNITS=) ;;
    *)    LIST=$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(o).sort().slice(0,+process.argv[2]).join(","))' "$IDENT" "$UNITS")
          EMIT_ENV=(RECON_REUSE_DIR=@OUT@ "RECON_EMIT_UNITS=$LIST") ;;
  esac
  for side in a b; do
    checkout=$A; [ $side = b ] && checkout=$B
    D="$WORK/$side"
    [ -e "$D" ] && { echo "refusing: $D exists"; exit 1; }
    mkdir -p "$D"
    cp -cR "$FROZEN/project" "$D/project"
    cp -cR "$FROZEN/output" "$D/output"
    # The generator reads <project>/../overrides: the checkout's own, as in the daemon.
    ln -s "$checkout/overrides" "$D/overrides"
    envs=()
    for e in "${EMIT_ENV[@]+"${EMIT_ENV[@]}"}"; do envs+=("${e//@OUT@/$D/output}"); done
    echo "--- $side: $checkout ($UNITS unit(s)) ---"
    T0=$(date +%s)
    /usr/bin/time -l env \
      RECON_CHILD_PROJECT_DIR="$D/project" \
      RECON_CHILD_OUTPUT_DIR="$D/output" \
      RECON_CHILD_SNAPSHOT_DIR="$D/project/.ghidra-mcp/live-snapshot" \
      RECON_CHILD_PROJECT_NAME=Reconstructed \
      RECON_GEN_TIMING=1 \
      RECON_UNIT_IDENT_CACHE="$D/project/.ghidra-mcp/unit-identifiers.json" \
      "${envs[@]+"${envs[@]}"}" \
      node --stack-size=8192 "$checkout/packages/live/dist/codegen-run.js" > "$D/run.log" 2> "$D/time.txt"
    RC=$?
    echo "  rc=$RC wall=$(( $(date +%s) - T0 ))s  $(grep -a 'maximum resident' "$D/time.txt" | awk '{printf "maxrss=%.1fGB", $1/1024/1024/1024}')  $(grep -a 'real' "$D/time.txt" | head -1)"
    grep -a '^Parallel generation:\|^  generation \|project/total\|units/impl \|units/setup ' "$D/run.log" | sed 's/^/  /'
    [ $RC -ne 0 ] && { tail -20 "$D/run.log"; exit $RC; }
  done
  echo "--- diff ---"
  bad=0
  diff -r --brief "$WORK/a/output" "$WORK/b/output" > "$WORK/diff-tree.txt" 2>&1 || bad=1
  diff -r --brief "$WORK/a/project/.ghidra-mcp/unit-identifiers.json.units" "$WORK/b/project/.ghidra-mcp/unit-identifiers.json.units" >> "$WORK/diff-state.txt" 2>&1 || bad=1
  # The identifier cache and buildinfo compared as data: a unit's identifier list is in
  # the order the process's running tally first met each name, which depends on which
  # units that process emitted before it (the declaration closure that reads the tally
  # sorts it), and buildinfo carries a timestamp.
  node -e '
    const fs = require("fs");
    const canon = x => JSON.stringify(x, (k, v) => v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
    const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
    const [a, b] = process.argv.slice(1);
    const ia = read(a + "/unit-identifiers.json"), ib = read(b + "/unit-identifiers.json");
    for (const u of [ia, ib]) for (const k of Object.keys(u)) if (Array.isArray(u[k].idents)) u[k].idents = [...u[k].idents].sort();
    const ba = read(a + "/buildinfo.json"), bb = read(b + "/buildinfo.json");
    delete ba.timestamp; delete bb.timestamp;
    let ok = true;
    if (canon(ia) !== canon(ib)) { console.log("unit-identifiers.json differs"); ok = false; }
    if (canon(ba) !== canon(bb)) { console.log("buildinfo.json differs"); ok = false; }
    process.exit(ok ? 0 : 1);
  ' "$WORK/a/project/.ghidra-mcp" "$WORK/b/project/.ghidra-mcp" >> "$WORK/diff-state.txt" 2>&1 || bad=1
  if [ $bad -eq 0 ]; then
    echo "IDENTICAL: $(find "$WORK/a/output" -type f | wc -l | tr -d ' ') files, plus the identifier cache, unit texts and buildinfo"
  else
    echo "DIFFERENT:"; head -20 "$WORK/diff-tree.txt" "$WORK/diff-state.txt" | sed 's/^/  /'
    exit 1
  fi
  ;;
*)
  sed -n '2,18p' "$0"; exit 2 ;;
esac

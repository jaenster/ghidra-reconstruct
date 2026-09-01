#!/usr/bin/env bash
# Merge the two A2 Racer II reconstruction trees into the published repo.
#
# Both binaries link the same in-house winlib, so the two decompilations overlap.
# Engine-only and menu-only directories are replaced wholesale; winlib is resolved
# per-file. Finally the D2-derived naming the generator still emits is rewritten to
# this project's own.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
GAME="$SRC/repo-game"
MENU="$SRC/repo-menu"
PUB="${A2RACER_REPO:-/Users/jaenster/code/claude/a2racer2/repo}"

for d in "$GAME" "$MENU" "$PUB"; do
  [ -d "$d" ] || { echo "missing: $d" >&2; exit 1; }
done

# Directories owned exclusively by one side.
rsync -a --delete "$GAME/A2racII/Game/" "$PUB/A2racII/Game/"
rsync -a --delete "$MENU/A2racII/menu/" "$PUB/A2racII/menu/"
for d in misc dplib inputlib win3ddp win3dlib; do
  rsync -a --delete "$GAME/$d/" "$PUB/$d/"
done

# winlib: shared between both binaries. Keep whichever decompilation produced more.
# Crude — functions present only in the smaller copy are lost. See README limitations.
mkdir -p "$PUB/winlib"
rm -f "$PUB"/winlib/*
{ ls "$GAME/winlib"; ls "$MENU/winlib"; } | sort -u | while read -r fname; do
  gpath="$GAME/winlib/$fname"
  mpath="$MENU/winlib/$fname"
  if [[ -f "$gpath" && -f "$mpath" ]]; then
    if [[ "$(stat -f%z "$gpath")" -ge "$(stat -f%z "$mpath")" ]]; then
      cp "$gpath" "$PUB/winlib/$fname"
    else
      cp "$mpath" "$PUB/winlib/$fname"
    fi
  elif [[ -f "$gpath" ]]; then
    cp "$gpath" "$PUB/winlib/$fname"
  else
    cp "$mpath" "$PUB/winlib/$fname"
  fi
done

# The engine's unnamespaced unit is emitted under winlib/ but is not winlib code —
# it is everything with no namespace at all. It is published at the tree root and
# in _unattributed/; leaving a copy here would file ~700 unplaced functions under a
# library they have no evidence of belonging to.
rm -f "$PUB/winlib/_unnamespaced.h" "$PUB/winlib/_unnamespaced.cpp" "$PUB/winlib/_unnamespaced.cpp.map"

# Root singletons: the engine's copies are canonical.
# The engine's unnamespaced unit is emitted once, under winlib/, and older
# generator versions also duplicated it at the tree root. Take whichever exists —
# they are byte-identical when both do.
game_unnamespaced() {
  local ext="$1"
  if [ -f "$GAME/_unnamespaced$ext" ]; then
    printf '%s' "$GAME/_unnamespaced$ext"
  elif [ -f "$GAME/winlib/_unnamespaced$ext" ]; then
    printf '%s' "$GAME/winlib/_unnamespaced$ext"
  else
    echo "publish: no engine _unnamespaced$ext in $GAME" >&2
    exit 1
  fi
}

cp "$GAME/globals.h"          "$PUB/globals.h"
cp "$(game_unnamespaced .h)"  "$PUB/_unnamespaced.h"
cp "$GAME/d2_enums.h"         "$PUB/enums.h"
cp "$GAME/d2_platform.h"      "$PUB/platform.h"

# Unplaceable translation units, prefixed by which binary they came from.
mkdir -p "$PUB/_unattributed"
cp "$GAME/globals.cpp"        "$PUB/_unattributed/engine_globals.cpp"
cp "$(game_unnamespaced .cpp)" "$PUB/_unattributed/engine_unattributed.cpp"
cp "$MENU/globals.h"          "$PUB/_unattributed/menu_globals.h"
cp "$MENU/globals.cpp"        "$PUB/_unattributed/menu_globals.cpp"
cp "$MENU/_unnamespaced.h"    "$PUB/_unattributed/menu__unnamespaced.h"
cp "$MENU/_unnamespaced.cpp"  "$PUB/_unattributed/menu_unattributed.cpp"

# The generator's header names and address-comment tag are inherited from the D2
# project it was written for. Rewrite them to this project's own.
find "$PUB" -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.map' \) -not -path '*/.git/*' -print0 \
  | xargs -0 perl -pi -e '
      s/\bd2_platform\.h\b/platform.h/g;
      s/\bd2_enums\.h\b/enums.h/g;
      s{//\s*1\.14d:}{// addr:}g;
      s{"winlib/_unnamespaced\.h"}{"_unnamespaced.h"}g;
    '

for pattern in '1\.14d' 'd2_platform' 'd2_enums' 'Diablo' 'D2_SEED' 'D2[A-Z][A-Za-z]*Strc'; do
  hits=$(grep -rl "$pattern" "$PUB" --exclude-dir=.git 2>/dev/null || true)
  [ -z "$hits" ] || { echo "post-process left these matching $pattern:" >&2; echo "$hits" >&2; exit 1; }
done

echo "published -> $PUB"

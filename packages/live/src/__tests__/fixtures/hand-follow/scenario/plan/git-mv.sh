#!/bin/sh
# Pure renames, no content change. Run on the deploy tree before merging the regen.
set -eu
T="${1:?usage: git-mv.sh <tree>}"
mkdir -p "$T/Source/C"
git -C "$T" mv -- "Source/C/Crlf.cpp" "Source/C/Gamma.cpp"
git -C "$T" mv -- "Source/C/Crlf.h" "Source/C/Gamma.h"
git -C "$T" commit -q -m "chore(layout): move files to the new layout"

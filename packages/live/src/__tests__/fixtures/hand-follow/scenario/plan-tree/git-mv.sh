#!/bin/sh
# Pure renames, no content change. Run on the deploy tree before merging the regen.
set -eu
T="${1:?usage: git-mv.sh <tree>}"

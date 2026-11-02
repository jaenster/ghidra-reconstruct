#!/bin/bash
# Run the local worker's Java tests against the built jar (run build.sh first).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cp=$(cat "$HERE/dist/classpath.txt")
out=$HERE/dist/test-classes
rm -rf "$out"; mkdir -p "$out"
javac -nowarn -encoding UTF-8 --release 21 -proc:none -cp "$cp" -d "$out" $(find "$HERE/test" -name '*.java')
java -cp "$out:$cp" com.ghidramcp.local.CheckoutGuardTest

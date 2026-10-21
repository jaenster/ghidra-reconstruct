#!/bin/bash
# Build the stdio worker: the ghidra-mcp worker sources plus StdioWorker, compiled
# against the same Ghidra the worker runs under. Output: dist/local-worker.jar and
# dist/classpath.txt (the runtime classpath, laid out like the daemon's pool.ts).
#
#   GHIDRA_HOME      a Ghidra 12.1.2 install            (required)
#   GHIDRA_MCP_SRC   the ghidra-mcp checkout            (default ~/code/ghidra-mcp)
#   JAVA_HOME        a JDK 21                           (default: javac on PATH)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
: "${GHIDRA_HOME:?set GHIDRA_HOME to a Ghidra 12.1.2 install}"
GHIDRA_MCP_SRC=${GHIDRA_MCP_SRC:-$HOME/code/ghidra-mcp}
JAVAC=${JAVA_HOME:+$JAVA_HOME/bin/}javac
JAR=${JAVA_HOME:+$JAVA_HOME/bin/}jar

want=12.1.2
got=$(sed -n 's/^application.version=//p' "$GHIDRA_HOME/Ghidra/application.properties")
[ "$got" = "$want" ] || { echo "GHIDRA_HOME is Ghidra $got; the worker needs $want" >&2; exit 1; }

# Runtime classpath: every lib dir of Framework, Features and Processors, then patch.
cp_parts=()
for group in Framework Features Processors; do
  for lib in "$GHIDRA_HOME/Ghidra/$group"/*/lib; do
    [ -d "$lib" ] && cp_parts+=("$lib/*")
  done
done
cp_parts+=("$GHIDRA_HOME/Ghidra/patch/*")
ghidra_cp=$(IFS=:; echo "${cp_parts[*]}")

# gson and httpclient5 come from the worker's own build (its fat jar ships them).
deps=$(ls "$GHIDRA_MCP_SRC/ghidra-worker/build/libs/"ghidra-worker-*.jar 2>/dev/null | head -1 || true)
[ -n "$deps" ] || { echo "no ghidra-worker jar under $GHIDRA_MCP_SRC/ghidra-worker/build/libs (dependency jars)" >&2; exit 1; }

out=$HERE/dist
rm -rf "$out/classes"; mkdir -p "$out/classes"
find "$GHIDRA_MCP_SRC/ghidra-worker/src/main/java" "$HERE/src" -name '*.java' > "$out/sources.txt"
"$JAVAC" -nowarn -encoding UTF-8 --release 21 -proc:none -cp "$deps:$ghidra_cp" -d "$out/classes" @"$out/sources.txt"
"$JAR" cf "$out/local-worker.jar" -C "$out/classes" .

# The worker sources' revision, so a run can say which worker code produced it.
(cd "$GHIDRA_MCP_SRC" && git rev-parse --short HEAD 2>/dev/null && git status --porcelain ghidra-worker/src | wc -l) \
  > "$out/worker-revision.txt" || true
echo "$out/local-worker.jar:$deps:$ghidra_cp" > "$out/classpath.txt"
echo "built $out/local-worker.jar (worker $(head -1 "$out/worker-revision.txt" 2>/dev/null))"

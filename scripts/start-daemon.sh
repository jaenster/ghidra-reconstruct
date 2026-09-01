#!/usr/bin/env bash
# Launch the local ghidra-mcp regen daemon (checks out the program over RMI).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
: "${GHIDRA_MCP_DIR:?set GHIDRA_MCP_DIR in scripts/.env}"
: "${GHIDRA_HOME:?set GHIDRA_HOME in scripts/.env}"
PORT="${GHIDRA_MCP_PORT:-8433}"
PW_FILE="${GHIDRA_SERVER_PASSWORD_FILE:-$HOME/.ghidra-mcp-server-password}"
pkill -f "bin.js --port ${PORT}" 2>/dev/null || true
sleep 3
rm -rf "$HOME/Library/Application Support/ghidra-mcp/projects"/* 2>/dev/null || true
GHIDRA_HOME="$GHIDRA_HOME" \
GHIDRA_MCP_HEARTBEAT_STALE_MS=2400000 GHIDRA_MCP_MAX_WORKERS=2 \
GHIDRA_MCP_STARTUP_TIMEOUT_MS=900000 GHIDRA_MCP_MEMORY=8g \
GHIDRA_SERVER_PASSWORD="$(cat "$PW_FILE")" \
nohup node "$GHIDRA_MCP_DIR/packages/cli/dist/bin.js" --port "$PORT" > /tmp/ghidra-daemon-$PORT.log 2>&1 &
echo "daemon starting on :$PORT (log: /tmp/ghidra-daemon-$PORT.log)"

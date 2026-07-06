#!/usr/bin/env bash
# Fresh-install smoke: pack workspaces, install agent-dealer in a temp dir, start, curl /health.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.temporal/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/install-smoke.log"

exec > >(tee -a "$LOG") 2>&1

echo "[install-smoke] prepare-release"
node "$ROOT/scripts/prepare-release.mjs"

PACK_DIR="$(mktemp -d)"
INSTALL_DIR="$(mktemp -d)"
HOME_DIR="$INSTALL_DIR/home"
export HOME="$HOME_DIR"
PORT=49221

cleanup() {
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$PACK_DIR" "$INSTALL_DIR"
}
trap cleanup EXIT

echo "[install-smoke] packing to $PACK_DIR"
(cd "$ROOT/packages/shared" && npm pack --pack-destination "$PACK_DIR")
(cd "$ROOT/packages/server" && npm pack --pack-destination "$PACK_DIR")
(cd "$ROOT/packages/cli" && npm pack --pack-destination "$PACK_DIR")

SHARED_TGZ="$(ls "$PACK_DIR"/agent-dealer-shared-*.tgz | head -1)"
SERVER_TGZ="$(ls "$PACK_DIR"/agent-dealer-server-*.tgz | head -1)"
CLI_TGZ="$(ls "$PACK_DIR"/agent-dealer-*.tgz | grep -v shared | grep -v server | head -1)"

echo "[install-smoke] install in $INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install "$SHARED_TGZ" "$SERVER_TGZ" "$CLI_TGZ"

export PATH="$INSTALL_DIR/node_modules/.bin:$PATH"

echo "[install-smoke] doctor"
agent-dealer doctor

echo "[install-smoke] setup"
agent-dealer setup --home "$HOME_DIR/.agent-dealer"

echo "[install-smoke] start on port $PORT"
PORT=$PORT AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer start --port "$PORT" &
PID=$!

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "[install-smoke] ✓ /health"
    break
  fi
  sleep 0.25
done

curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "[install-smoke] FAIL health"; exit 1; }
curl -sf "http://127.0.0.1:$PORT/" | head -c 200 | grep -qi html || { echo "[install-smoke] FAIL dashboard HTML"; exit 1; }
curl -sf "http://127.0.0.1:$PORT/api/snapshot" >/dev/null || { echo "[install-smoke] FAIL /api/snapshot"; exit 1; }

echo "[install-smoke] ✓ dashboard + API"
kill "$PID"
wait "$PID" 2>/dev/null || true
PID=""

echo "[install-smoke] PASS"

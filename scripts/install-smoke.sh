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
  if [[ -n "${HOME_DIR:-}" ]] && command -v agent-dealer >/dev/null 2>&1; then
    AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer stop >/dev/null 2>&1 || true
  fi
  rm -rf "$PACK_DIR" "$INSTALL_DIR"
}
trap cleanup EXIT

echo "[install-smoke] stage npm package"
node "$ROOT/scripts/stage-npm-package.mjs"

echo "[install-smoke] pack staged CLI"
(cd "$ROOT/.temporal/npm-stage/agent-dealer" && npm pack --pack-destination "$PACK_DIR")
CLI_TGZ="$(ls "$PACK_DIR"/agent-dealer-*.tgz | head -1)"

echo "[install-smoke] install in $INSTALL_DIR"
cd "$INSTALL_DIR"
npm init -y >/dev/null
npm install "$CLI_TGZ"

export PATH="$INSTALL_DIR/node_modules/.bin:$PATH"

echo "[install-smoke] doctor"
agent-dealer doctor

echo "[install-smoke] setup"
agent-dealer setup --home "$HOME_DIR/.agent-dealer"

echo "[install-smoke] seed LINEAR_API_KEY in .env (no shell export)"
echo 'LINEAR_API_KEY=smoke_test_key' >> "$HOME_DIR/.agent-dealer/.env"

echo "[install-smoke] doctor (env file only)"
DOC_OUT="$(AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer doctor 2>&1)"
echo "$DOC_OUT"
echo "$DOC_OUT" | grep -Fq "LINEAR_API_KEY set" || {
  echo "[install-smoke] FAIL doctor did not see LINEAR_API_KEY from .env"
  exit 1
}

echo "[install-smoke] legacy PORT=2221 in .env maps to bundled 2222"
sed -i.bak 's/^PORT=.*/PORT=2221/' "$HOME_DIR/.agent-dealer/.env"
DOC_OUT="$(AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer doctor 2>&1)"
echo "$DOC_OUT"
echo "$DOC_OUT" | grep -Eq "port 2222|agent-dealer running on :2222" || {
  echo "[install-smoke] FAIL doctor did not resolve bundled port 2222"
  exit 1
}

echo "[install-smoke] start --daemon on port $PORT"
AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer start --daemon --port "$PORT"

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

echo "[install-smoke] status"
AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer status || { echo "[install-smoke] FAIL status"; exit 1; }

echo "[install-smoke] run.json exists"
test -f "$HOME_DIR/.agent-dealer/run.json" || { echo "[install-smoke] FAIL run.json missing"; exit 1; }

echo "[install-smoke] ✓ dashboard + API (daemon)"

echo "[install-smoke] stop"
AGENT_DEALER_HOME="$HOME_DIR/.agent-dealer" agent-dealer stop || { echo "[install-smoke] FAIL stop"; exit 1; }

sleep 0.5
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && { echo "[install-smoke] FAIL still healthy after stop"; exit 1; }

echo "[install-smoke] PASS"

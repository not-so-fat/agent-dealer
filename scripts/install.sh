#!/usr/bin/env bash
# Managed install for agent-dealer — does not migrate queue/config (same ~/.agent-dealer data home).
set -euo pipefail

export AGENT_DEALER_HOME="${AGENT_DEALER_HOME:-$HOME/.agent-dealer}"
mkdir -p "$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install from https://nodejs.org/ then re-run." >&2
  exit 1
fi

echo "Installing agent-dealer into $AGENT_DEALER_HOME (existing data kept) ..."
npx --yes agent-dealer@latest install "$@"

echo ""
echo "Ensure ~/.local/bin is on your PATH, then:"
echo "  agent-dealer doctor"
echo "  agent-dealer setup"
echo "  agent-dealer start --daemon --open"

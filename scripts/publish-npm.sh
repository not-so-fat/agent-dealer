#!/usr/bin/env bash
# Publish staged agent-dealer tarball — must cd into stage dir (monorepo root is private).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/.temporal/npm-stage/agent-dealer"

node "$ROOT/scripts/stage-npm-package.mjs"
cd "$STAGE"
npm publish --access public "$@"

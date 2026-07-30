import fs from "node:fs";

import { localBinDir, localBinLauncherPath } from "./paths.js";

const LAUNCHER_BODY = `#!/usr/bin/env bash
set -euo pipefail
HOME_DIR="\${AGENT_DEALER_HOME:-$HOME/.agent-dealer}"
CURRENT="$HOME_DIR/current"
BIN="$CURRENT/node_modules/agent-dealer/dist/bin.js"
if [ ! -f "$BIN" ]; then
  echo "agent-dealer: managed install broken (missing $BIN). Re-run: agent-dealer install" >&2
  exit 1
fi
exec node "$BIN" "$@"
`;

export function writeLocalBinLauncher(): void {
  fs.mkdirSync(localBinDir(), { recursive: true });
  const target = localBinLauncherPath();
  fs.writeFileSync(target, LAUNCHER_BODY, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  activateVersion,
  cliEntryInVersionDir,
  fetchLatestVersion,
  installCliVersionToPrefix,
  localBinLauncherPath,
  PACKAGE_NAME,
  versionDir,
} from "./managed/index.js";

export type InstallDeps = {
  installVersion?: typeof installCliVersionToPrefix;
  fetchLatest?: () => Promise<string | null>;
  purgeGlobal?: () => Promise<number>;
};

function parseArgs(args: string[]): {
  to?: string;
  migrateCli: boolean;
  purgeGlobal: boolean;
} {
  let to: string | undefined;
  let migrateCli = false;
  let purgeGlobal = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--to") to = args[++i];
    else if (a === "--migrate-cli") migrateCli = true;
    else if (a === "--purge-global") purgeGlobal = true;
  }
  return { to, migrateCli, purgeGlobal };
}

export function printInstallHelp(): void {
  console.log(`Usage:
  agent-dealer install [--to VERSION] [--migrate-cli] [--purge-global]

Installs agent-dealer into ~/.agent-dealer/versions and writes ~/.local/bin/agent-dealer.
Existing config, queue data, and logs are left unchanged.`);
}

export async function runInstall(args: string[], deps: InstallDeps = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printInstallHelp();
    return 0;
  }

  const { to, migrateCli, purgeGlobal } = parseArgs(args);
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const installVersion = deps.installVersion ?? installCliVersionToPrefix;

  const version = to ?? (await fetchLatest());
  if (!version) {
    console.error("Could not resolve latest version from npm.");
    return 1;
  }

  if (!fs.existsSync(cliEntryInVersionDir(versionDir(version)))) {
    const result = await installVersion(version);
    if (!result.ok) {
      console.error(`Managed install failed: ${result.error}`);
      return 1;
    }
  }

  activateVersion(version);

  const home = process.env.AGENT_DEALER_HOME?.trim() || path.join(os.homedir(), ".agent-dealer");
  console.log(`Installed ${PACKAGE_NAME}@${version} to ${home} (data home unchanged).`);
  console.log(`Launcher: ${localBinLauncherPath()}`);
  console.log('If command not found: export PATH="$HOME/.local/bin:$PATH"');
  if (migrateCli) {
    console.log("Prefer ~/.local/bin ahead of any npm global agent-dealer on PATH.");
  }
  console.log("Next: agent-dealer doctor && agent-dealer start --daemon --open");

  if (purgeGlobal) {
    const code = deps.purgeGlobal
      ? await deps.purgeGlobal()
      : await new Promise<number>((resolve) => {
          const child = spawn("npm", ["uninstall", "-g", PACKAGE_NAME], {
            stdio: "inherit",
            shell: process.platform === "win32",
          });
          child.on("exit", (c) => resolve(c ?? 1));
        });
    if (code !== 0) {
      console.warn("Warning: could not uninstall npm global package (managed install is still active).");
    }
  }

  return 0;
}

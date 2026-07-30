import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  activateVersion,
  compareSemver,
  detectInstallKind,
  fetchLatestVersion,
  installCliVersionToPrefix,
  readCurrentManagedVersion,
} from "./managed/index.js";
import { fetchLatestPublishedVersion } from "./npm-registry.js";
import { getVersion } from "./version.js";

const PKG_NAME = "agent-dealer";

export function printUpgradeHelp(): void {
  console.log(`Usage:
  agent-dealer upgrade [--to VERSION] [--yes] [--check]

Managed install: download into ~/.agent-dealer/versions and activate.
npm-global: npm install -g agent-dealer@VERSION.`);
}

function parseBooleanLike(s: string | undefined): boolean {
  const v = s?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

async function confirmPrompt(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

async function runNpmGlobalInstall(version: string): Promise<number> {
  const target = `${PKG_NAME}@${version}`;
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", target], {
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runUpgrade(options: {
  toVersion?: string;
  yes?: boolean;
  check?: boolean;
} = {}): Promise<number> {
  const toVersion = options.toVersion?.trim();

  if (detectInstallKind() === "managed") {
    const current = readCurrentManagedVersion() ?? getVersion();
    const latest = toVersion ?? (await fetchLatestVersion());
    if (!latest) {
      console.error(`Could not resolve latest version for ${PKG_NAME}.`);
      return 1;
    }

    console.log(`Current: ${current}`);
    console.log(`Latest:  ${latest}`);
    console.log("Install: managed");

    if (!toVersion && compareSemver(latest, current) <= 0) {
      console.log("Already on the latest version.");
      return 0;
    }

    if (options.check) {
      console.log("Update available. Run: agent-dealer upgrade");
      return 0;
    }

    console.log(`Upgrading managed install ${PKG_NAME} → ${latest} ...`);
    const result = await installCliVersionToPrefix(latest);
    if (!result.ok) {
      console.error(`Upgrade failed: ${result.error}`);
      return 1;
    }
    activateVersion(latest);
    console.log("Upgrade complete. Restart any running agent-dealer process.");
    return 0;
  }

  let version = toVersion ?? (await fetchLatestPublishedVersion(PKG_NAME));
  if (!version) {
    console.error(`Could not resolve latest version for ${PKG_NAME}.`);
    return 1;
  }

  console.log(`Current: ${getVersion()}`);
  console.log(`Latest:  ${version}`);
  console.log("Install: npm-global (or unknown)");

  if (options.check) {
    if (compareSemver(version, getVersion()) > 0) {
      console.log("Update available. Run: agent-dealer upgrade");
      console.log("Tip: agent-dealer install  # managed auto-updates (data unchanged)");
    } else {
      console.log("Already on the latest version.");
    }
    return 0;
  }

  const autoYes = options.yes ?? parseBooleanLike(process.env.AGENT_DEALER_UPGRADE_YES) ?? false;
  if (!autoYes) {
    const ok = await confirmPrompt(
      `Upgrade ${PKG_NAME} to ${version} via "npm install -g ${PKG_NAME}@${version}"? [y/N] `,
    );
    if (!ok) {
      console.log("Upgrade cancelled.");
      return 0;
    }
  }

  const code = await runNpmGlobalInstall(version);
  if (code === 0) {
    console.log(`Upgraded to ${PKG_NAME}@${version}. Re-run your command to use the new version.`);
    console.log("Tip: agent-dealer install  # switch CLI to managed auto-updates (data unchanged)");
  }
  return code;
}

export async function installAgentDealerVersion(version: string): Promise<number> {
  if (detectInstallKind() === "managed") {
    const result = await installCliVersionToPrefix(version);
    if (!result.ok) return 1;
    activateVersion(version);
    return 0;
  }
  return runNpmGlobalInstall(version);
}

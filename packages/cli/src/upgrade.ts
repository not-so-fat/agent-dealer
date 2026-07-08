import { spawn } from "node:child_process";
import readline from "node:readline";
import { fetchLatestPublishedVersion } from "./npm-registry.js";

const PKG_NAME = "agent-dealer";

export function printUpgradeHelp(): void {
  console.log(`Usage:
  agent-dealer upgrade [--to VERSION] [--yes]

Installs the latest global version of agent-dealer (or --to VERSION).`);
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
} = {}): Promise<number> {
  const toVersion = options.toVersion?.trim();
  let version = toVersion ?? (await fetchLatestPublishedVersion(PKG_NAME));

  if (!version) {
    console.error(`Could not resolve latest version for ${PKG_NAME}.`);
    return 1;
  }

  const autoYes =
    options.yes ??
    parseBooleanLike(process.env.AGENT_DEALER_UPGRADE_YES) ??
    false;

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
  }
  return code;
}

// Used by update-check: prompts happen elsewhere, so we only do the install.
export async function installAgentDealerVersion(version: string): Promise<number> {
  return runNpmGlobalInstall(version);
}


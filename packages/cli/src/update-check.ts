import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { prodHomeDir } from "./env.js";
import { getVersion } from "./version.js";
import { fetchLatestPublishedVersion } from "./npm-registry.js";
import { installAgentDealerVersion } from "./upgrade.js";

const PKG_NAME = "agent-dealer";
const CACHE_FILE = ".agent-dealer-update-check.json";
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000;

type UpdateCheckResult = { upgraded: boolean };

function parseXyzVersion(v: string): { major: number; minor: number; patch: number } | undefined {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function isNewer(latest: string, current: string): boolean {
  const a = parseXyzVersion(latest);
  const b = parseXyzVersion(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  return false;
}

async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

function cachePath(): string {
  const home = prodHomeDir();
  return path.join(home, CACHE_FILE);
}

function readCache(): { checkedAt?: number; latestVersion?: string; promptedAt?: number } | undefined {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as { checkedAt?: number; latestVersion?: string; promptedAt?: number };
  } catch {
    return undefined;
  }
}

function writeCache(next: { checkedAt?: number; latestVersion?: string; promptedAt?: number }): void {
  try {
    const home = prodHomeDir();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(next), "utf8");
  } catch {
    // Ignore cache write failures (permissions, read-only FS, etc).
  }
}

export async function maybeCheckForUpdateOnRun(): Promise<UpdateCheckResult> {
  if (process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK === "1") {
    return { upgraded: false };
  }

  const current = getVersion();
  const cache = readCache();
  if (cache?.checkedAt && Date.now() - cache.checkedAt < CHECK_THROTTLE_MS) {
    // Throttle network checks, but still report based on cached latestVersion.
    if (cache.latestVersion && isNewer(cache.latestVersion, current)) {
      console.log(`Update available: ${current} -> ${cache.latestVersion}`);

      const autoUpgrade = ["1", "true", "yes"].includes(
        process.env.AGENT_DEALER_AUTO_UPGRADE?.trim().toLowerCase() ?? "",
      );
      if (autoUpgrade) {
        const code = await installAgentDealerVersion(cache.latestVersion);
        return { upgraded: code === 0 };
      }

      const canPrompt = process.stdin.isTTY && process.stdout.isTTY;
      if (!canPrompt) {
        console.log(`Run: agent-dealer upgrade`);
        return { upgraded: false };
      }

      // Prompt at most once per throttle window to avoid nagging.
      const promptAgeMs = cache.promptedAt ? Date.now() - cache.promptedAt : Infinity;
      if (promptAgeMs >= CHECK_THROTTLE_MS) {
        writeCache({ ...cache, promptedAt: Date.now() });
        const ok = await promptYesNo(`Upgrade now? [y/N] `);
        if (!ok) return { upgraded: false };
      } else {
        // Recently prompted; do not prompt again.
      }

      const code = await installAgentDealerVersion(cache.latestVersion);
      return { upgraded: code === 0 };
    }

    return { upgraded: false };
  }

  const latest = await fetchLatestPublishedVersion(PKG_NAME);
  // Always write checkedAt so we don't hammer the registry on repeated failures.
  writeCache({ checkedAt: Date.now(), latestVersion: latest, promptedAt: cache?.promptedAt });

  if (!latest || latest === current) return { upgraded: false };
  if (!isNewer(latest, current)) return { upgraded: false };

  const autoUpgrade = ["1", "true", "yes"].includes(process.env.AGENT_DEALER_AUTO_UPGRADE?.trim().toLowerCase() ?? "");

  console.log(`Update available: ${current} -> ${latest}`);

  if (autoUpgrade) {
    const code = await installAgentDealerVersion(latest);
    return { upgraded: code === 0 };
  }

  const canPrompt = process.stdin.isTTY && process.stdout.isTTY;
  if (!canPrompt) {
    console.log(`Run: agent-dealer upgrade`);
    return { upgraded: false };
  }

  const ok = await promptYesNo(`Upgrade now? [y/N] `);
  if (!ok) return { upgraded: false };

  const code = await installAgentDealerVersion(latest);
  return { upgraded: code === 0 };
}


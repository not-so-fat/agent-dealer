import { detectInstallKind, runManagedCliEntryHooks } from "./managed/index.js";
import { installAgentDealerVersion } from "./upgrade.js";
import { fetchLatestPublishedVersion } from "./npm-registry.js";
import { getVersion } from "./version.js";
import { compareSemver } from "./managed/semver.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { prodHomeDir } from "./env.js";

const PKG_NAME = "agent-dealer";
const CACHE_FILE = ".agent-dealer-update-check.json";
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000;

type UpdateCheckResult = { upgraded: boolean };

async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toLowerCase().startsWith("y");
}

function cachePath(): string {
  return path.join(prodHomeDir(), CACHE_FILE);
}

function readCache(): { checkedAt?: number; latestVersion?: string; promptedAt?: number } | undefined {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as {
      checkedAt?: number;
      latestVersion?: string;
      promptedAt?: number;
    };
  } catch {
    return undefined;
  }
}

function writeCache(next: { checkedAt?: number; latestVersion?: string; promptedAt?: number }): void {
  try {
    fs.mkdirSync(prodHomeDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(next), "utf8");
  } catch {
    // ignore
  }
}

/** npm-global / unknown path — keep TTY prompt behavior. Managed uses hooks instead. */
export async function maybeCheckForUpdateOnRun(): Promise<UpdateCheckResult> {
  if (detectInstallKind() === "managed") {
    const { activated } = runManagedCliEntryHooks({ allowActivate: true });
    if (activated) {
      console.log(`[agent-dealer] Activated managed version ${activated}`);
      console.log("Re-run your command to use the new version.");
      return { upgraded: true };
    }
    return { upgraded: false };
  }

  if (process.env.AGENT_DEALER_DISABLE_UPGRADE_CHECK === "1") {
    return { upgraded: false };
  }
  if (process.env.AGENT_DEALER_DISABLE_AUTOUPDATER === "1") {
    return { upgraded: false };
  }

  const current = getVersion();
  const cache = readCache();
  if (cache?.checkedAt && Date.now() - cache.checkedAt < CHECK_THROTTLE_MS) {
    if (cache.latestVersion && compareSemver(cache.latestVersion, current) > 0) {
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
        console.log("Tip: agent-dealer install  # managed auto-updates");
        return { upgraded: false };
      }

      const promptAgeMs = cache.promptedAt ? Date.now() - cache.promptedAt : Infinity;
      if (promptAgeMs >= CHECK_THROTTLE_MS) {
        writeCache({ ...cache, promptedAt: Date.now() });
        const ok = await promptYesNo(`Upgrade now? [y/N] `);
        if (!ok) return { upgraded: false };
      }

      const code = await installAgentDealerVersion(cache.latestVersion);
      return { upgraded: code === 0 };
    }
    return { upgraded: false };
  }

  const latest = await fetchLatestPublishedVersion(PKG_NAME);
  writeCache({ checkedAt: Date.now(), latestVersion: latest, promptedAt: cache?.promptedAt });

  if (!latest || latest === current) return { upgraded: false };
  if (compareSemver(latest, current) <= 0) return { upgraded: false };

  const autoUpgrade = ["1", "true", "yes"].includes(
    process.env.AGENT_DEALER_AUTO_UPGRADE?.trim().toLowerCase() ?? "",
  );

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

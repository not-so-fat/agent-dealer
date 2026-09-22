import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { cursorAuthIssueFromOutput } from "@agent-dealer/shared";
import { claudeAvailable, cursorAvailable } from "./cli-check.js";
import {
  loadProdEnvFile,
  prodEnvFilePath,
  prodHomeDir,
  resolveBundledListenPort,
  shortenHome,
} from "./env.js";
import { probeAgentDealer } from "./ports.js";
import { resolveServerEntry, resolveUiDist } from "./paths.js";
import {
  detectInstallKind,
  localBinLauncherPath,
  readCurrentManagedVersion,
  readUpdateState,
  resolveCurrentVersionDir,
} from "./managed/index.js";
import { getVersion } from "./version.js";

export async function runDoctor(): Promise<number> {
  let failed = false;

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`✗ Node.js 20+ required (found ${process.versions.node})`);
    return 1;
  }
  console.log(`✓ Node ${process.versions.node}`);

  const claude = await claudeAvailable();
  if (claude.ok) {
    console.log(`✓ Claude Code CLI (${claude.bin})`);
  } else {
    console.error("✗ Claude Code CLI not found — install claude and ensure it is on PATH");
    console.error("  https://docs.anthropic.com/en/docs/claude-code");
    failed = true;
  }

  {
    const cursor = await cursorAvailable();
    if (!cursor.ok) {
      console.warn("⚠ Cursor Agent CLI not found (optional for cursor_local agents)");
    } else {
      const { spawnSync } = await import("node:child_process");
      const bin = cursor.bin;
      const statusArgs = path.basename(bin) === "cursor" ? ["agent", "status"] : ["status"];
      const status = spawnSync(bin, statusArgs, {
        encoding: "utf8",
        timeout: 8000,
        env: process.env,
      });
      const output = `${status.stdout ?? ""}${status.stderr ?? ""}${status.error?.message ?? ""}`;
      const authIssue = cursorAuthIssueFromOutput(output);
      if (authIssue) {
        console.error(`✗ Cursor auth — ${authIssue.message}`);
        console.error("  See docs/TROUBLESHOOTING.md#cursor-macos-keychain-auth");
        failed = true;
      } else if (status.error || status.status !== 0) {
        const detail = (status.error?.message ?? output.trim()) || `exit ${status.status}`;
        console.error(`✗ Cursor auth — status failed (${detail})`);
        console.error("  See docs/TROUBLESHOOTING.md#cursor-macos-keychain-auth");
        failed = true;
      } else {
        console.log(`✓ Cursor Agent CLI auth (${bin})`);
      }
    }
  }

  {
    const { spawnSync } = await import("node:child_process");
    const ghVer = spawnSync("gh", ["--version"], { encoding: "utf8" });
    if (ghVer.error || ghVer.status !== 0) {
      console.error("✗ GitHub CLI (`gh`) not found — install gh (required to open draft PRs)");
      failed = true;
    } else {
      const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      const out = `${auth.stdout ?? ""}${auth.stderr ?? ""}`.toLowerCase();
      if (
        auth.status !== 0 ||
        out.includes("not logged in") ||
        out.includes("failed to log in") ||
        out.includes("token in keyring is invalid") ||
        out.includes("re-authenticate")
      ) {
        console.error("✗ GitHub CLI auth — run: gh auth login -h github.com");
        console.error("  (Issue workflows open draft PRs via gh; invalid auth wastes agent runs.)");
        failed = true;
      } else {
        console.log("✓ GitHub CLI auth");
      }
    }
  }

  try {
    resolveServerEntry();
    console.log("✓ @agent-dealer/server entry");
  } catch (err) {
    console.error(`✗ server: ${err instanceof Error ? err.message : err}`);
    failed = true;
  }

  const ui = resolveUiDist();
  if (ui) {
    console.log(`✓ dashboard bundle ${ui}`);
  } else {
    console.warn("⚠ dashboard bundle missing (API-only)");
  }

  const envFile = loadProdEnvFile() ?? prodEnvFilePath();
  if (fs.existsSync(envFile)) {
    console.log(`✓ config ${shortenHome(envFile)}`);
    if (process.env.LINEAR_API_KEY?.trim()) {
      console.log("✓ LINEAR_API_KEY set");
    } else {
      console.warn("⚠ LINEAR_API_KEY not set — Linear inbox disabled");
    }
    // NOT-250: experimental Cursor Individual dashboard adapter status
    // (informational only — never fails doctor, never reads credentials).
    if (process.env.AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY === "experimental") {
      console.warn(
        "⚠ Cursor Individual capacity: EXPERIMENTAL dashboard adapter enabled " +
          "(undocumented API, no support guarantee — unset AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY to disable)"
      );
    }
  } else {
    console.warn(`⚠ no config — run: agent-dealer setup`);
  }

  const home = prodHomeDir();
  if (fs.existsSync(home)) {
    console.log(`✓ data ${shortenHome(home)}`);
  }

  console.log(`Package version ${getVersion()}`);
  const kind = detectInstallKind();
  console.log(`Install kind: ${kind}`);
  if (kind === "managed") {
    const current = readCurrentManagedVersion();
    const currentDir = resolveCurrentVersionDir();
    console.log(`Managed current: ${current ?? "(unknown)"} (${currentDir ?? "missing"})`);
    console.log(`Launcher: ${localBinLauncherPath()}`);
    const pending = readUpdateState()?.pendingVersion;
    if (pending) {
      console.log(`Pending managed version: ${pending} (activates on next start/doctor/upgrade)`);
    }
  } else {
    console.log("Tip: agent-dealer install  # managed CLI + auto-updates (data unchanged)");
  }

  const port = resolveBundledListenPort();
  const probe = await probeAgentDealer("127.0.0.1", port);
  if (probe.up) {
    console.log(`✓ agent-dealer running on :${port}`);
  } else {
    const free = await isPortFree(port);
    if (free) {
      console.log(`✓ port ${port} available`);
    } else {
      console.warn(`⚠ port ${port} in use (not agent-dealer — run: agent-dealer status)`);
    }
  }

  return failed ? 1 : 0;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

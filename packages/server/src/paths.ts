import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./db/index.js";

export function getTemporalDir(): string {
  return path.join(getDataDir(), ".temporal");
}

export function getTemporalOutputDir(): string {
  const dir = path.join(getTemporalDir(), "output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTemporalLogsDir(): string {
  const dir = path.join(getTemporalDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Per-attempt Agent Deck MCP config files for worker CLIs (claude `--mcp-config`,
 * codex `CODEX_HOME`) — never the worktree (a generated checkout must not carry a
 * persistent-looking config) and never `.temporal/logs` (those are retained; this
 * directory is scrubbed per-attempt by the caller and at coordinator startup).
 * Mode 0700 — configs are process-local and short-lived.
 */
export function getWorkerMcpConfigDir(): string {
  const dir = path.join(getTemporalDir(), "worker-mcp-config");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Startup-only: removes every per-attempt entry left under `getWorkerMcpConfigDir()`
 * by a crash (a clean shutdown never reaches here — `releaseWorkerDeckConnection` already
 * removed its own entry). Safe unconditionally: every entry is scoped to exactly one
 * attempt's spawn, and that attempt cannot still be running (this *is* the coordinator
 * restarting). Claude and codex still write per-attempt MCP configs outside the worktree;
 * cursor's config lives inside the worktree and is not cleaned here.
 */
export function cleanupOrphanedWorkerMcpConfig(): void {
  const dir = getWorkerMcpConfigDir();
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

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
 * Per-attempt Agent Deck MCP config files carrying a live execution-authority secret
 * (NOT-87) — never the worktree (a generated checkout must not carry a persistent-looking
 * credential file) and never `.temporal/logs` (those are retained; this directory is
 * scrubbed per-attempt by the caller). Mode 0700 — the secret is process-local, one-time,
 * and short-lived, but still not world-readable while the file exists.
 */
export function getExecutionAuthorityConfigDir(): string {
  const dir = path.join(getTemporalDir(), "worker-mcp-config");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Startup-only: removes every per-attempt entry left under `getExecutionAuthorityConfigDir()`
 * by a crash (a clean shutdown never reaches here — `releaseWorkerAuthority` already
 * removed its own entry). Safe unconditionally: every entry is scoped to exactly one
 * attempt's spawn, that attempt cannot still be running (this *is* the coordinator
 * restarting), and its Deck-side authority either already expired by TTL or is revoked
 * independently — nothing here is resumable, so nothing is lost by deleting it (NOT-85
 * §6: "coordinator restart can rediscover issued authority without reading its secret
 * from Dealer state"). Run before anything else touches this directory (PR #19 review
 * round 3: an orphaned entry can hold a live credential — claude's authority bearer, or
 * codex's symlinked login — indefinitely otherwise).
 */
export function cleanupOrphanedWorkerMcpConfig(): void {
  const dir = getExecutionAuthorityConfigDir();
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

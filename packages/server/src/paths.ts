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

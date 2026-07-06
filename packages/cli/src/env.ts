import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

/** Production data + config directory (respects AGENT_DEALER_HOME from shell). */
export function prodHomeDir(): string {
  return (
    process.env.AGENT_DEALER_HOME?.trim() ||
    path.join(os.homedir(), ".agent-dealer")
  );
}

export function prodEnvFilePath(): string {
  return path.join(prodHomeDir(), ".env");
}

/** Load ~/.agent-dealer/.env for CLI (Linear keys, port, etc.). Does not override existing env. */
export function loadProdEnvFile(): string | undefined {
  const envFile = prodEnvFilePath();
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
    return envFile;
  }
  return undefined;
}

/**
 * Bundled npm start: listen on prod dashboard port (2222).
 * Legacy setups used PORT=2221 for API-only; ignore that when bundling UI.
 */
export function resolveBundledListenPort(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (process.env.WEB_PORT) return Number(process.env.WEB_PORT);
  const port = process.env.PORT;
  if (port && port !== "2221") return Number(port);
  return 2222;
}

export function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

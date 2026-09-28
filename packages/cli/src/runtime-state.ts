import fs from "node:fs";
import path from "node:path";
import { prodHomeDir } from "./env.js";
import { probeAgentDealer } from "./ports.js";

export interface RunState {
  host: string;
  port: number;
  serverPid: number;
  cliPid: number;
  startedAt: string;
}

export function runStatePath(): string {
  return path.join(prodHomeDir(), "run.json");
}

export function readRunState(): RunState | null {
  try {
    const raw = fs.readFileSync(runStatePath(), "utf8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export function writeRunState(state: RunState): void {
  fs.mkdirSync(prodHomeDir(), { recursive: true });
  fs.writeFileSync(runStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function clearRunState(): void {
  try {
    fs.unlinkSync(runStatePath());
  } catch {
    // ignore
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The server's own liveness marker (packages/server/src/server-liveness.ts), written by
 * every launch mode — not only by this CLI's supervisor like run.json. */
export function serverPidMarkerPath(): string {
  return path.join(prodHomeDir(), "server.pid");
}

function isServerPidMarkerLive(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(serverPidMarkerPath(), "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" && isProcessAlive(raw.pid);
  } catch {
    return false;
  }
}

/**
 * NOT-279: whether a backend may still be serving this home — a healthy agent-dealer on the
 * port, or a live owner of the server's pid marker (a backend still booting or draining
 * holds the marker before/after it answers /health). Gate for switching the managed
 * `current` version: activation must only happen when this is false.
 */
export async function isBackendLive(host: string, port: number): Promise<boolean> {
  if ((await probeAgentDealer(host, port)).up) return true;
  return isServerPidMarkerLive();
}

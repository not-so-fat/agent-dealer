import fs from "node:fs";
import path from "node:path";
import { prodHomeDir } from "./env.js";

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

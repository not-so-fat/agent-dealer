import type { ChildProcess } from "node:child_process";

const activeChildren = new Map<string, ChildProcess>();
const activeLogPaths = new Map<string, string>();

let activeSpawnCount = 0;
const spawnWaiters: Array<() => void> = [];

export function maxConcurrentSpawns(): number {
  return Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
}

export async function acquireSpawnSlot(): Promise<void> {
  const max = maxConcurrentSpawns();
  if (activeSpawnCount < max) {
    activeSpawnCount++;
    return;
  }
  await new Promise<void>((resolve) => spawnWaiters.push(resolve));
  activeSpawnCount++;
}

export function releaseSpawnSlot(): void {
  activeSpawnCount = Math.max(0, activeSpawnCount - 1);
  const next = spawnWaiters.shift();
  if (next) next();
}

export function registerChild(runId: string, child: ChildProcess, logPath?: string): void {
  activeChildren.set(runId, child);
  if (logPath) activeLogPaths.set(runId, logPath);
}

export function unregisterChild(runId: string): void {
  activeChildren.delete(runId);
  activeLogPaths.delete(runId);
}

export function getActiveLogPath(runId: string): string | undefined {
  return activeLogPaths.get(runId);
}

export function killRunProcess(runId: string): boolean {
  const child = activeChildren.get(runId);
  if (!child?.pid) return false;
  try {
    child.kill("SIGTERM");
    return true;
  } catch {
    return false;
  }
}

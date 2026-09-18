// packages/server/src/direct-start-temp-home-cleanup.ts
//
// Shared interrupt/exit cleanup for direct-start-liveness.integration.test.ts:
// live servers and temp AGENT_DEALER_HOME dirs share one registry so the signal
// handler that calls process.exit(1) (which skips t.after) cannot reap one and
// abandon the other. Also a guarded sweep for abandoned dealer-direct-start-*
// debris left by earlier interrupted runs (NOT-140).
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DIRECT_START_HOME_PREFIX = "dealer-direct-start-";

/** Homes modified more recently than this are assumed to belong to a run in flight. */
export const DEFAULT_RECENT_MS = 60_000;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readRecordedPid(home: string): number | undefined {
  try {
    const recorded = (JSON.parse(fs.readFileSync(path.join(home, "server.pid"), "utf8")) as { pid?: unknown })
      .pid;
    return typeof recorded === "number" && Number.isFinite(recorded) ? recorded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One registry for the interrupt path: every server spawnServer() still owns, and
 * every temp home makeHome() still owns. reapAll() is the single net used by both
 * process.on("exit") and the SIGINT/SIGTERM/SIGHUP handlers.
 */
export class DirectStartLiveCleanup {
  readonly servers = new Set<ChildProcess>();
  readonly homes = new Set<string>();

  trackHome(home: string): void {
    this.homes.add(home);
  }

  untrackHome(home: string): void {
    this.homes.delete(home);
  }

  addServer(child: ChildProcess): void {
    this.servers.add(child);
  }

  removeServer(child: ChildProcess): void {
    this.servers.delete(child);
  }

  /**
   * Kill every tracked server group, then rmSync every tracked home.
   * Order matters: never delete a home out from under a still-live server.
   */
  reapAll(signalGroup: (child: ChildProcess, signal: NodeJS.Signals) => void): void {
    for (const child of this.servers) signalGroup(child, "SIGKILL");
    this.servers.clear();
    for (const home of this.homes) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // Best-effort on the interrupt path — do not throw out of a signal handler.
      }
    }
    this.homes.clear();
  }
}

export function shouldSweepHome(
  home: string,
  opts: { now: number; recentMs: number; isPidAlive: (pid: number) => boolean }
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(home).mtimeMs;
  } catch {
    return false;
  }
  if (opts.now - mtimeMs < opts.recentMs) return false;
  const pid = readRecordedPid(home);
  if (pid !== undefined && opts.isPidAlive(pid)) return false;
  return true;
}

/**
 * One-time (or on-load) sweep of abandoned `$TMPDIR/dealer-direct-start-*` homes.
 * Skips any home whose recorded server.pid is still alive, and any home modified
 * within `recentMs`, so a concurrent in-flight run is never deleted out from under.
 */
export function sweepAbandonedDirectStartHomes(
  tmpDir: string,
  opts?: {
    now?: number;
    recentMs?: number;
    isPidAlive?: (pid: number) => boolean;
    prefix?: string;
  }
): { removed: string[]; skipped: string[] } {
  const now = opts?.now ?? Date.now();
  const recentMs = opts?.recentMs ?? DEFAULT_RECENT_MS;
  const alive = opts?.isPidAlive ?? isPidAlive;
  const prefix = opts?.prefix ?? DIRECT_START_HOME_PREFIX;
  const removed: string[] = [];
  const skipped: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return { removed, skipped };
  }

  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const home = path.join(tmpDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(home);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!shouldSweepHome(home, { now, recentMs, isPidAlive: alive })) {
      skipped.push(home);
      continue;
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
      removed.push(home);
    } catch {
      skipped.push(home);
    }
  }
  return { removed, skipped };
}

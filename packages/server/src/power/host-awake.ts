// NOT-369: keep the macOS host awake while Dealer work is active.
//
// One reference-counted idle-sleep assertion (`caffeinate -i -w <server pid>`).
// First acquire spawns; further acquires only bump the count; last release
// terminates the child. Non-darwin is a no-op. Spawn failures log once and
// never fail the caller.

import { spawn, type ChildProcess } from "node:child_process";

/** Minimal child surface the guard needs — real `spawn` or a test fake. */
export type CaffeinateChild = {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
};

export type CaffeinateSpawner = (command: string, args: string[]) => CaffeinateChild;

export type HostAwakeLogger = (message: string) => void;

export type HostAwakeOptions = {
  platform?: string;
  /** Server pid that `-w` watches; defaults to `process.pid`. */
  pid?: number;
  spawn?: CaffeinateSpawner;
  log?: HostAwakeLogger;
};

function defaultSpawn(command: string, args: string[]): CaffeinateChild {
  const child: ChildProcess = spawn(command, args, {
    stdio: "ignore",
    detached: false,
  });
  return {
    pid: child.pid,
    kill: (signal) => child.kill(signal),
    once: (event, listener) => {
      child.once(event, listener);
    },
  };
}

/**
 * Reference-counted macOS idle-sleep hold. Create one per server process
 * (or per test). Never throws from acquire/release.
 */
export class HostAwakeGuard {
  private readonly platform: string;
  private readonly pid: number;
  private readonly spawnFn: CaffeinateSpawner;
  private readonly log: HostAwakeLogger;

  private holds = 0;
  private child: CaffeinateChild | null = null;
  private spawnFailureLogged = false;

  constructor(opts: HostAwakeOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.pid = opts.pid ?? process.pid;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.log = opts.log ?? ((msg) => console.warn(msg));
  }

  /** Platform this guard was constructed for (injectable in tests). */
  getPlatform(): string {
    return this.platform;
  }

  /** True when a live caffeinate child is held (darwin + count > 0 + spawn ok). */
  isHoldActive(): boolean {
    return this.child != null && this.holds > 0;
  }

  /** Current reference count (including holds that could not spawn). */
  holdCount(): number {
    return this.holds;
  }

  acquire(): void {
    this.holds += 1;
    if (this.platform !== "darwin") return;
    // Always ensure a live child while holds > 0 — including after an unexpected
    // caffeinate exit (further acquires used to return early when holds > 1).
    this.ensureChild();
  }

  /** Idempotent: releasing when count is already zero is a no-op. */
  release(): void {
    if (this.holds <= 0) {
      this.holds = 0;
      return;
    }
    this.holds -= 1;
    if (this.holds > 0) return;
    this.stopChild();
  }

  /** Drop every hold and kill caffeinate — used on server shutdown. */
  releaseAll(): void {
    this.holds = 0;
    this.stopChild();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort: never fail shutdown or session completion over this.
    }
  }

  /**
   * Spawn caffeinate when missing and holds remain. Called from acquire and from
   * the unexpected-exit path so the host stays protected for the whole hold window.
   */
  private ensureChild(): void {
    if (this.platform !== "darwin") return;
    if (this.holds <= 0) return;
    if (this.child) return;
    try {
      const child = this.spawnFn("caffeinate", ["-i", "-w", String(this.pid)]);
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) this.child = null;
        // Unexpected death while work is still active — restore the assertion.
        // stopChild clears `this.child` before kill, so intentional release does not respawn.
        if (this.holds > 0) this.ensureChild();
      });
      child.once("error", () => {
        if (this.child === child) this.child = null;
        this.logSpawnFailure("caffeinate child error");
      });
    } catch (err) {
      this.child = null;
      this.logSpawnFailure(err instanceof Error ? err.message : String(err));
    }
  }

  private logSpawnFailure(detail: string): void {
    if (this.spawnFailureLogged) return;
    this.spawnFailureLogged = true;
    this.log(`[host-awake] caffeinate unavailable — continuing without sleep hold (${detail})`);
  }
}

/** Process-wide guard; tests call `installHostAwakeForTests` to replace it. */
let activeGuard = new HostAwakeGuard();

export function getHostAwakeGuard(): HostAwakeGuard {
  return activeGuard;
}

export function acquireHostAwake(): void {
  activeGuard.acquire();
}

export function releaseHostAwake(): void {
  activeGuard.release();
}

export function releaseAllHostAwake(): void {
  activeGuard.releaseAll();
}

export function isHostAwakeHoldActive(): boolean {
  return activeGuard.isHoldActive();
}

/**
 * Production session/merge lifecycle wrapper: acquire → work → release in finally.
 * Worker-loop and auto-merge call this so every outcome (including throw) releases.
 */
export async function withHostAwakeHold<T>(work: () => Promise<T>): Promise<T> {
  acquireHostAwake();
  try {
    return await work();
  } finally {
    releaseHostAwake();
  }
}

/** Replace the process-wide guard (unit tests). Returns the installed instance. */
export function installHostAwakeForTests(opts: HostAwakeOptions = {}): HostAwakeGuard {
  activeGuard.releaseAll();
  activeGuard = new HostAwakeGuard(opts);
  return activeGuard;
}

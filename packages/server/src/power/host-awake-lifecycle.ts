// NOT-369: production lifecycle seam for host-awake holds.
//
// Worker-loop / auto-merge call `runHeldWork`. Server startup calls
// `registerHostAwakeShutdownCleanup`. Lifecycle tests drive those same
// entry points (via processWorkItem / finalizeAutoMerge / a fake process)
// so a removed finally or an unwired shutdown handler fails the suite.

import { releaseAllHostAwake, withHostAwakeHold } from "./host-awake.js";

/** Acquire → work → release. Used by worker-loop and auto-merge. */
export async function runHeldWork<T>(work: () => Promise<T>): Promise<T> {
  return withHostAwakeHold(work);
}

/** Minimal process surface so tests can emit SIGINT/SIGTERM/exit without touching the real process. */
export type ShutdownEventTarget = {
  on(event: "SIGINT" | "SIGTERM" | "exit", listener: () => void): unknown;
};

/**
 * Register releaseAll on SIGINT, SIGTERM, and exit — the same events index.ts
 * must cover so a clean server stop does not leave caffeinate behind.
 * Returns the cleanup function (idempotent; safe to invoke more than once).
 */
export function registerHostAwakeShutdownCleanup(
  target: ShutdownEventTarget = process
): () => void {
  const cleanup = (): void => {
    try {
      releaseAllHostAwake();
    } catch {
      // Best-effort — never block process exit.
    }
  };
  target.on("SIGINT", cleanup);
  target.on("SIGTERM", cleanup);
  target.on("exit", cleanup);
  return cleanup;
}

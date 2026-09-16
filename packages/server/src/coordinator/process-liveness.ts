// packages/server/src/coordinator/process-liveness.ts
//
// NOT-124: is the CLI a leased work item spawned actually still running?
//
// Before this, `recoverCoordinator()` decided a worker was dead purely from
// `lease_expires_at < now`. The heartbeat that keeps that lease fresh is a `setInterval`,
// and timers do not fire while the host is asleep — but wall-clock time keeps advancing.
// So every macOS wake looked exactly like a crash, and six healthy sessions (one of which
// had already pushed and opened its PR) were torn down and redone.
//
// The lease timestamp is an *assertion* that a worker is gone. The pid is *evidence*. This
// module turns the assertion into a check.
import os from "node:os";
import { v4 as uuid } from "uuid";

/**
 * Identity of THIS coordinator process. Regenerated on every module load, so it can never
 * collide with a previous run's value even if the OS hands out the same pid again.
 *
 * This is the load-bearing half of the design. A bare pid recorded in the DB is not
 * liveness evidence once the recording process is gone: the OS recycles pids, so
 * `kill(pid, 0)` against a stale row can succeed forever against some unrelated program,
 * and the work item would never be reclaimed again — a permanent stall, strictly worse
 * than the over-eager reclaim being fixed. Scoping the evidence to the process that
 * produced it means a restart (or another host) degrades to exactly the timestamp-only
 * behaviour NOT-116 shipped, which is the correct thing to do there anyway.
 */
export const COORDINATOR_PROCESS_OWNER = `${os.hostname()}:${process.pid}:${uuid().slice(0, 8)}`;

export type LivenessVerdict =
  /** A pid recorded by this coordinator answers signal 0 — the CLI is still running. */
  | "alive"
  /** A pid recorded by this coordinator is gone (ESRCH) — reclaim is correct. */
  | "dead"
  /** No pid, or one owned by a process that is no longer running: no evidence either way. */
  | "unknown";

/**
 * @param pid    `worker_sessions.process_pid`
 * @param owner  `worker_sessions.process_owner`
 */
export function processLiveness(pid: number | null, owner: string | null): LivenessVerdict {
  if (!pid || pid <= 0) return "unknown";
  if (owner !== COORDINATOR_PROCESS_OWNER) return "unknown";
  try {
    // Signal 0 performs the permission + existence check without delivering a signal.
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive, still not ours
    // to reclaim. Only ESRCH ("no such process") is positive evidence of death.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "alive";
    return "dead";
  }
}

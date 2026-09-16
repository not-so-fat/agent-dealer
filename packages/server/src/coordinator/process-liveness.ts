// packages/server/src/coordinator/process-liveness.ts
//
// NOT-124: is the CLI a leased work item spawned actually still running?
// NOT-131: ...and can a *successor* coordinator still answer that after a restart?
//
// Before NOT-124, `recoverCoordinator()` decided a worker was dead purely from
// `lease_expires_at < now`. The heartbeat that keeps that lease fresh is a `setInterval`,
// and timers do not fire while the host is asleep — but wall-clock time keeps advancing.
// So every macOS wake looked exactly like a crash, and six healthy sessions (one of which
// had already pushed and opened its PR) were torn down and redone.
//
// The lease timestamp is an *assertion* that a worker is gone. The pid is *evidence*. This
// module turns the assertion into a check.
//
// NOT-124 scoped that evidence to the coordinator process that produced it, which made the
// guard inert across exactly the transition it most needed to survive: a restart (`tsx
// watch` reload, crash, operator restart, deploy) regenerates the owner string, so every
// in-flight session read "unknown", the guard could never fire, and one lease period later
// every live worker was reclaimed — with its CLI still running, because NOT-126's
// AbortController died with the process that held it. Four duplicated workers in 22
// minutes, three `claude -p` processes implementing one ticket in three worktrees.
//
// The owner scoping was not the mistake; the conclusion drawn from it was. A bare pid is
// genuinely not evidence across processes — the OS recycles pids, so `kill(pid, 0)` against
// a stale row can succeed forever against an unrelated program and strand the item. The fix
// is to make the evidence *portable* rather than to throw it away: record the process start
// time alongside the pid. A recycled pid always started later than the one we recorded, so
// an exact match identifies the process, not merely the number.
import { execFileSync } from "node:child_process";
import os from "node:os";
import { v4 as uuid } from "uuid";

/**
 * Identity of THIS coordinator process. Regenerated on every module load, so it can never
 * collide with a previous run's value even if the OS hands out the same pid again.
 *
 * Still the fast path: for a session this process spawned, the pid needs no corroboration.
 * A *different* owner no longer means "no evidence" (NOT-131) — it means the evidence has
 * to be corroborated by `process_started_at` before it counts.
 */
export const COORDINATOR_PROCESS_OWNER = `${os.hostname()}:${process.pid}:${uuid().slice(0, 8)}`;

/** `ps` is a local probe; a hung one must never stall a recovery tick. */
const PS_TIMEOUT_MS = 2_000;

export type LivenessVerdict =
  /** The recorded pid is confirmed to still be the CLI this session spawned. */
  | "alive"
  /** The recorded pid is gone, or now belongs to a different (recycled) process. */
  | "dead"
  /** No pid, no start time, another host, or no working `ps`: no evidence either way. */
  | "unknown";

/**
 * The hostname half of a `process_owner` (`${hostname}:${pid}:${uuid8}`). A hostname can
 * itself contain `:`, so strip the two known trailing fields rather than splitting on the
 * first separator.
 */
function ownerHost(owner: string): string {
  const parts = owner.split(":");
  return parts.length < 3 ? owner : parts.slice(0, -2).join(":");
}

/**
 * The OS-reported start time of `pid`, as an opaque string, or null if there is no such
 * process (or `ps` is unusable here — BusyBox has no `lstart`).
 *
 * Deliberately never parsed: it is compared only by exact string equality, so no locale,
 * timezone, or format assumption can turn an identity check into a wrong verdict. Its one
 * job is to be stable for one process and different for the next one to reuse that pid.
 */
export function readProcessStartTime(pid: number | null): string | null {
  if (!pid || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    // Non-zero exit (no such pid), no `ps`, or the timeout above — all "cannot tell".
    return null;
  }
}

/** ESRCH from signal 0 is the only positive evidence that a pid is gone. */
function signalProbe(pid: number): "alive" | "dead" | "foreign" {
  try {
    // Signal 0 performs the permission + existence check without delivering a signal.
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the pid exists but belongs to another user. Our own CLIs run as us, so
    // for a cross-process check that is proof of recycling, not of our worker's health.
    if (code === "EPERM") return "foreign";
    return "dead";
  }
}

/**
 * @param pid        `worker_sessions.process_pid`
 * @param owner      `worker_sessions.process_owner`
 * @param startTime  `worker_sessions.process_started_at` — required to reach a verdict for
 *                   a pid this coordinator process did not itself spawn. A row written
 *                   before NOT-131 has none, and must read "unknown" (never "alive"), so a
 *                   pre-upgrade row degrades to the timestamp-only behaviour NOT-116
 *                   shipped instead of being mistaken for a live worker.
 */
export function processLiveness(
  pid: number | null,
  owner: string | null,
  startTime: string | null = null
): LivenessVerdict {
  if (!pid || pid <= 0) return "unknown";

  // Our own child: we hold the handle, so the pid cannot have been recycled under us.
  if (owner === COORDINATOR_PROCESS_OWNER) {
    const probe = signalProbe(pid);
    return probe === "dead" ? "dead" : "alive";
  }

  // Spawned by some other process — corroborate, or abstain.
  if (!owner) return "unknown";
  // Another machine's pid is not ours to probe or signal at all.
  if (ownerHost(owner) !== os.hostname()) return "unknown";
  if (!startTime) return "unknown";

  const current = readProcessStartTime(pid);
  if (current !== null) return current === startTime ? "alive" : "dead";

  // `ps` told us nothing. Separate "the process is gone" (a real verdict) from "`ps` does
  // not work here" (no verdict at all) — conflating them would reclaim every live worker
  // on a host without `lstart`, which is the bug this module exists to prevent.
  const probe = signalProbe(pid);
  if (probe === "dead" || probe === "foreign") return "dead";
  return "unknown";
}

/**
 * May this coordinator send a signal to `pid` believing it is this session's CLI?
 *
 * Stricter than `processLiveness`, and deliberately so: a wrong verdict costs one
 * unnecessary reclaim, while a wrong *kill* terminates an unrelated program on the
 * developer's machine. Only two things authorize it — we spawned the process ourselves, or
 * the recorded start time still matches exactly. Everything else (another host, a missing
 * start time, a recycled pid) declines, which is why NOT-131 keeps the reclaim-time kill as
 * a safety net rather than a replacement for a correct verdict.
 */
export function canSignalWorkerProcess(
  pid: number | null,
  owner: string | null,
  startTime: string | null
): boolean {
  if (!pid || pid <= 0) return false;
  if (owner === COORDINATOR_PROCESS_OWNER) return true;
  if (!owner || ownerHost(owner) !== os.hostname()) return false;
  if (!startTime) return false;
  return readProcessStartTime(pid) === startTime;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

export type TerminationOutcome =
  /** The process is confirmed not running (it already was, or our signals stopped it). */
  | "stopped"
  /** Identity could not be established, so nothing was signalled — the pid may still run. */
  | "unverified"
  /** Signalled, including SIGKILL, and it is still there. */
  | "failed";

/**
 * Make a predecessor's CLI verifiably not running before a successor attempt is spawned
 * (NOT-131 AC 2). SIGTERM first — the agent CLIs reap their own children (login shells,
 * test runners) on SIGTERM the way they do on Ctrl-C, so terminating politely is what
 * actually cleans up the whole tree — then SIGKILL as the backstop, mirroring
 * `spawn-cli.ts`'s abort escalation.
 *
 * Returns "unverified" rather than signalling on an unidentifiable pid; callers must treat
 * that as "an orphan may survive", not as success.
 */
export async function terminateWorkerProcess(
  pid: number | null,
  owner: string | null,
  startTime: string | null,
  opts?: { graceMs?: number; pollMs?: number }
): Promise<TerminationOutcome> {
  if (!pid || pid <= 0) return "stopped"; // nothing was ever recorded to outlive us
  if (signalProbe(pid) === "dead") return "stopped";
  if (!canSignalWorkerProcess(pid, owner, startTime)) return "unverified";

  const graceMs = opts?.graceMs ?? Number(process.env.SPAWN_ABORT_KILL_GRACE_MS ?? 5_000);
  const pollMs = opts?.pollMs ?? 100;

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      // Exited between the probe and this signal — the poll below confirms it.
    }
    const deadline = Date.now() + graceMs;
    do {
      if (signalProbe(pid) === "dead") return "stopped";
      await sleep(pollMs);
    } while (Date.now() < deadline);
  }
  return signalProbe(pid) === "dead" ? "stopped" : "failed";
}

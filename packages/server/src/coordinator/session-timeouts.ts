// packages/server/src/coordinator/session-timeouts.ts
//
// How long one agent CLI may run, by role — and the ceiling on how long recovery will keep
// a lease alive on the strength of that CLI still breathing (NOT-131).
//
// These live in their own leaf module because two places need the same number and neither
// should own it: `developer-effect`/`reviewer-effect` pass it to `spawnCli` as the
// in-process wall clock, and `recovery` needs it to bound the NOT-131 liveness hold. A
// successor coordinator has no other way to know when a CLI it did not spawn was supposed
// to be over.
import type { WorkerSessionRole } from "@agent-dealer/shared";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export function developerSessionTimeoutMs(): number {
  return num("DEVELOPER_TIMEOUT_MS", 60 * 60_000);
}

export function reviewerSessionTimeoutMs(): number {
  return num("REVIEWER_TIMEOUT_MS", 30 * 60_000);
}

/**
 * NOT-307: silent-child bound for the Muse developer lane only (other runtimes do
 * not read this). Undefined means the watchdog is disabled. Measured
 * 2026-09/10 `session_activity_events` history: completed Muse sessions show up
 * to ~39.8 min between sampler-persisted stream events (7 gaps over 20 min in 5
 * sessions, max 39.8 min on 2026-10-01). Those gaps measure *recognized* stream
 * events at 10s sampler ticks — true stdout-byte silence may be shorter (bytes
 * the sampler does not recognize advance its offset silently) — while the
 * watchdog watches a strictly more sensitive signal (any stdout bytes, plus
 * `session.jsonl` mtime growth). The 20-minute default therefore stands as the
 * prescribed bound, not as headroom above the longest observed gap: a healthy
 * session quieter than its own history can be idle-killed, and the first idle
 * kills (with their `lastActivityAt`/`lastToolName` evidence) calibrate it.
 * `0` disables explicitly. A non-numeric or negative value falls back to the
 * default with a logged warning rather than silently disabling the guard (or
 * killing healthy sessions on a typo like `-1`).
 */
export const DEFAULT_MUSE_IDLE_TIMEOUT_MS = 20 * 60_000;

export function museIdleTimeoutMs(): number | undefined {
  const raw = process.env.MUSE_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MUSE_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed === 0) return undefined;
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[dealer] ignoring invalid MUSE_IDLE_TIMEOUT_MS=${JSON.stringify(raw)} — using default ${DEFAULT_MUSE_IDLE_TIMEOUT_MS}`
    );
    return DEFAULT_MUSE_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

export function sessionTimeoutMsFor(role: WorkerSessionRole | null | undefined): number {
  return role === "reviewer" ? reviewerSessionTimeoutMs() : developerSessionTimeoutMs();
}

/**
 * The longest recovery will honour an "alive" verdict before reclaiming anyway (NOT-131).
 *
 * Making the pid verdict portable across a restart fixes the wrong reclaim, but it opens
 * the opposite failure: the `spawnCli` timeout that bounds a session is a `setTimeout` in
 * the process that spawned it, and that process is exactly the one that died. A successor
 * that honours "alive" unconditionally will extend a hung CLI's lease on every tick,
 * forever, and the work item never resolves — the permanent stall `process-liveness.ts`
 * warns about, arriving through the front door instead. So the hold is bounded: past this,
 * the CLI is killed and the item reclaimed whatever the pid says.
 *
 * Measured from `worker_sessions.started_at`, which is stamped *before* worktree setup and
 * the deck bind, so it precedes the actual spawn by an unbounded amount. Hence the 2x
 * default rather than the bare timeout: a slow clone must never make this fire on a healthy
 * session. The guarantee is a hard bound on the stall, not a precise re-enforcement of the
 * CLI's own deadline.
 */
export function maxAliveHoldMsFor(role: WorkerSessionRole | null | undefined): number {
  const raw = process.env.COORDINATOR_MAX_ALIVE_HOLD_MS;
  if (raw !== undefined && raw !== "") return Number(raw);
  return sessionTimeoutMsFor(role) * 2;
}

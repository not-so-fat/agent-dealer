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
 * not read this). Undefined means the watchdog is disabled. The watchdog ships
 * ENABLED with a 30-minute default: 20 min risks false kills against the
 * reported ~39.8 min silent gap in completed-session history; 45 min saves only
 * 15 of the 60-min wall-clock cap; disabled does not address the observed
 * 1-hour stalls. The ~39.8 min figure could not be re-verified — historical raw
 * logs carry replayed `recorded_at`, not arrival times, so it may overstate
 * true stdout/session.jsonl silence. The value is env-tunable, and the new
 * per-event `ts`/`durationMs` plus `metadata_json` stall fields will provide
 * the real gap distribution to recalibrate; a false kill is bounded by timeout
 * salvage + retry from the branch. `0` disables explicitly. A non-numeric or
 * negative value falls back to the default with a logged warning rather than
 * silently disabling the guard (or killing healthy sessions on a typo like
 * `-1`).
 */
export const DEFAULT_MUSE_IDLE_TIMEOUT_MS = 30 * 60_000;

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

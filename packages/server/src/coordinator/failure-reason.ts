// packages/server/src/coordinator/failure-reason.ts
//
// Human-readable reasons for worker.failed timeline payloads and the issue-detail
// failure strip (NOT-113). Prefer classified runner stderr (keychain / auth /
// reconnect) over opaque outcome kinds like dirty_worktree / session_failed.
import fs from "node:fs";
import { cursorAuthIssueFromOutput } from "@agent-dealer/shared";
import type { DeveloperOutcome, ReviewerOutcome } from "./routing.js";

/** Written to worker_sessions.errorJson when recovery reclaims an expired lease. */
export const PRESUMED_DEAD_REASON = "recovered — worker process presumed dead";

/**
 * NOT-129: a reclaim that republishes what the dead attempt already committed must read
 * differently on the timeline from one that starts a whole new agent session. Both keep
 * PRESUMED_DEAD_REASON as their prefix — the cause is the same, only the remedy differs.
 */
export function presumedDeadReclaimReason(
  role: "developer" | "reviewer",
  republish: { branch: string; commits: number; alreadyPushed: boolean } | null
): string {
  if (!republish) {
    // Only a developer item ever had a branch to publish; saying so for a reclaimed reviewer
    // would describe a choice that was never on the table, and name the wrong role as the one
    // being re-run.
    return role === "developer"
      ? `${PRESUMED_DEAD_REASON} — nothing on the branch to publish, re-running the developer`
      : `${PRESUMED_DEAD_REASON} — re-running the reviewer`;
  }
  if (republish.alreadyPushed) {
    return `${PRESUMED_DEAD_REASON} — ${republish.branch} is already on origin, re-verifying the PR instead of re-running the developer`;
  }
  const n = republish.commits;
  return `${PRESUMED_DEAD_REASON} — republishing ${n} unpushed commit${n === 1 ? "" : "s"} on ${republish.branch} instead of re-running the developer`;
}

const RECONNECT_EXHAUSTED_RE =
  /reconnect(?:ion)?s?\s+(?:exhausted|failed|gave up)|failed to reconnect|unable to reconnect|connection (?:lost|closed|reset).{0,40}(?:retries|attempts)/i;

function stripStderrTrailer(raw: string): string {
  const idx = raw.indexOf("\n--- stderr ---\n");
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

/** Full log text + stderr trailer for classifiers (mirrors usage-cap log reading). */
export function readSpawnLogHaystack(logPath: string | null | undefined): string {
  if (!logPath || !fs.existsSync(logPath)) return "";
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const stderr = raw.includes("\n--- stderr ---\n") ? (raw.split("\n--- stderr ---\n")[1] ?? "") : "";
    return `${stripStderrTrailer(raw)}\n${stderr}`;
  } catch {
    return "";
  }
}

/**
 * Classify Cursor/runtime stderr into an actionable failure reason.
 * Keychain / auth / reconnect win over generic crash labels.
 */
export function classifyRunnerLogFailure(logPath: string | null | undefined): string | null {
  const haystack = readSpawnLogHaystack(logPath);
  if (!haystack.trim()) return null;
  const auth = cursorAuthIssueFromOutput(haystack);
  if (auth?.code === "cursor_keychain") {
    // auth.message already names keychain / errSecDuplicateItem + remediation — don't stack a second copy.
    return `Cursor auth/keychain died mid-run. ${auth.message}`;
  }
  if (auth?.code === "runtime_auth") {
    return `Cursor auth required mid-run — ${auth.message}`;
  }
  if (RECONNECT_EXHAUSTED_RE.test(haystack)) {
    return "Cursor runtime reconnect exhausted mid-run.";
  }
  return null;
}

export function parseErrorJsonReason(errorJson: string | null | undefined): string | null {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson) as { reason?: unknown; error?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason.trim()) return parsed.reason.trim();
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    const trimmed = errorJson.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** dirty_worktree keeps preservation behavior; reason mentions auth when stderr says so. */
export function reasonForDirtyWorktree(logPath: string | null | undefined): string {
  const classified = classifyRunnerLogFailure(logPath);
  if (classified) {
    return `${classified} Worktree preserved with uncommitted changes.`;
  }
  return "Developer worktree has uncommitted changes after the session ended.";
}

export function reasonForSessionCrash(opts: {
  timedOut: boolean;
  logPath: string | null | undefined;
}): string {
  const classified = classifyRunnerLogFailure(opts.logPath);
  if (classified) return classified;
  return opts.timedOut ? "Developer session timed out." : "Developer session failed or crashed.";
}

function outcomeExplicitReason(outcome: DeveloperOutcome | ReviewerOutcome): string | null {
  if ("reason" in outcome && typeof (outcome as { reason?: unknown }).reason === "string") {
    const r = (outcome as { reason: string }).reason.trim();
    return r || null;
  }
  return null;
}

function fallbackReasonForKind(outcome: DeveloperOutcome | ReviewerOutcome): string {
  switch (outcome.kind) {
    case "dirty_worktree":
      return "Developer worktree has uncommitted changes after the session ended.";
    case "session_failed":
      return "Worker session failed or crashed.";
    case "timed_out":
      return "Developer session timed out.";
    case "no_pr":
      return "Developer session produced no PR.";
    case "checks_failed":
      return "Developer's PR checks failed.";
    case "publish_failed":
      return "Review publication to GitHub failed.";
    case "unpushed_commit":
      return "Developer's commits could not be pushed.";
    case "worktree_conflict":
      return "Developer worktree conflict.";
    case "live_owner":
      return "Developer worktree still owned by a live predecessor session.";
    case "adapter_failure":
      return "Git/GitHub verification failed.";
    case "deck_failure":
      return "Agent Deck preflight failed.";
    case "stale":
      return "PR head moved before the reviewer could evaluate it.";
    case "usage_capped":
      return "Runtime usage capped.";
    default:
      return `Worker ended with ${outcome.kind}.`;
  }
}

/**
 * Resolve the prose `reason` for a worker.failed timeline payload.
 * Priority: explicit outcome.reason → session errorJson → log classifier → route reason → kind fallback.
 *
 * `sessionErrorJson` is only useful when the caller already has the recorded error
 * (recovery / detail strip). On the applyCompletion hot path, worker-loop has not
 * written errorJson yet — pass `logPath` + outcome instead.
 */
export function reasonForWorkerFailedEvent(opts: {
  outcome: DeveloperOutcome | ReviewerOutcome;
  routeReason?: string | null;
  sessionErrorJson?: string | null;
  logPath?: string | null;
}): string {
  const explicit = outcomeExplicitReason(opts.outcome);
  if (explicit) return explicit;

  const fromSession = parseErrorJsonReason(opts.sessionErrorJson);
  if (fromSession) return fromSession;

  const fromLog = classifyRunnerLogFailure(opts.logPath);
  if (fromLog) {
    if (opts.outcome.kind === "dirty_worktree") {
      return `${fromLog} Worktree preserved with uncommitted changes.`;
    }
    return fromLog;
  }

  if (opts.routeReason?.trim()) return opts.routeReason.trim();
  return fallbackReasonForKind(opts.outcome);
}

/** Whether this outcome should persist errorJson on the worker_session row. */
export function outcomeShouldRecordError(outcome: DeveloperOutcome | ReviewerOutcome): boolean {
  return (
    outcome.kind === "session_failed" ||
    outcome.kind === "timed_out" ||
    outcome.kind === "dirty_worktree" ||
    outcome.kind === "publish_failed" ||
    outcome.kind === "no_pr" ||
    outcome.kind === "checks_failed" ||
    outcome.kind === "adapter_failure" ||
    outcome.kind === "deck_failure" ||
    outcome.kind === "unpushed_commit" ||
    outcome.kind === "worktree_conflict" ||
    outcome.kind === "live_owner"
  );
}

// packages/server/src/coordinator/failure-reason.ts
//
// Human-readable reasons for worker.failed timeline payloads and the issue-detail
// failure strip (NOT-113). Prefer classified runner stderr (keychain / auth /
// reconnect) over opaque outcome kinds like dirty_worktree / session_failed.
import fs from "node:fs";
import type { Runtime, RuntimeAuthClassification } from "@agent-dealer/shared";
import {
  CURSOR_KEYCHAIN_REMEDIATION,
  RUNTIME_AUTH_LABEL,
  isCursorKeychainStuckOutput,
  runtimeAuthClassificationForLog,
} from "@agent-dealer/shared";
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

const STDERR_MARKER = "\n--- stderr ---\n";

function stripStderrTrailer(raw: string): string {
  const idx = raw.indexOf(STDERR_MARKER);
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

/**
 * Strings from one stream event that describe a *failure*. Everything else an event can
 * carry — assistant text, thinking, tool arguments, file contents — is the worker's own
 * prose, and a worker that merely discusses `not logged in` or `401 Unauthorized` (this
 * ticket's own session does) must not be reported as an auth death.
 *
 * Covers all three runtimes' terminal shapes: Claude/Cursor `result`+`is_error` and
 * `system`/`error` events, Codex native JSONL `turn.failed` / `error`.
 */
function failureTextFromEvent(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v);
    // `error` is a bare string in some events and `{ message }` in others (Codex
    // `turn.failed`), and either shape can appear under any of the keys below.
    else if (v && typeof v === "object") push((v as { message?: unknown }).message);
  };
  switch (e.type) {
    case "result":
      if (e.is_error) push(e.result);
      break;
    case "system":
      if (e.subtype === "error" || e.subtype === "api_retry") push(e.error);
      break;
    case "error":
    case "stream_error":
    case "turn.failed":
      push(e.message);
      push(e.error);
      break;
    default:
      break;
  }
  return out;
}

/**
 * The failure-bearing text of a spawn log: its stderr trailer, plus any terminal error
 * strings from the structured stream, plus stdout lines the CLI printed outside that stream.
 *
 * Deliberately *not* the whole log. Every runner runs its CLI in a structured output mode
 * (`--output-format stream-json` / `--json`), so transcript bodies always arrive as JSON
 * event lines; scanning those made a worker's own discussion of an auth error read as an
 * auth error. Lines that are not JSON events are CLI diagnostics rather than model output,
 * so they stay in — that is where a text-mode warning like Cursor's rejected-API-key notice
 * lands. Mirrors the usage-cap classifier's haystack (runners/usage-cap.ts, NOT-117).
 */
export function readSpawnLogFailureText(logPath: string | null | undefined): string {
  if (!logPath || !fs.existsSync(logPath)) return "";
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const idx = raw.indexOf(STDERR_MARKER);
    const stderr = idx >= 0 ? raw.slice(idx + STDERR_MARKER.length) : "";
    const parts: string[] = [];
    for (const line of stripStderrTrailer(raw).split("\n")) {
      const t = line.trim();
      if (!t) continue;
      // A line the CLI meant as a stream event: only its failure fields count. Unparseable
      // ones (a transcript truncated by a kill) are skipped rather than read as raw text.
      // Only `{` starts an event — all three runners emit one JSON object per line, so a
      // `[`-prefixed line is timestamped CLI text (`[error] not logged in`), not an event.
      if (t.startsWith("{")) {
        try {
          const parsed = JSON.parse(t) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parts.push(...failureTextFromEvent(parsed as Record<string, unknown>));
          }
        } catch {
          // not an event after all — and not trusted as prose either
        }
        continue;
      }
      parts.push(line);
    }
    parts.push(stderr);
    return parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Classify runner stderr into an actionable failure reason.
 * Keychain / auth / reconnect win over generic crash labels.
 *
 * `runtime` is a hint, not the answer. Callers like the recovery/detail strip hold a log
 * path and a session row whose runtime may be null — or may disagree with what actually ran
 * — so a log that names its own CLI outranks the row. Shared prose (`Not logged in`) falls
 * back to the recorded runtime, and failing that yields an auth reason naming no runtime
 * rather than a plausible-looking wrong one.
 */
export function classifyRunnerLogFailure(
  logPath: string | null | undefined,
  runtime?: Runtime
): string | null {
  const haystack = readSpawnLogFailureText(logPath);
  if (!haystack.trim()) return null;
  // The keychain signature is unmistakable and could only have come from Cursor, so it is
  // never gated on the session's recorded runtime — which is null on older rows.
  // CURSOR_KEYCHAIN_REMEDIATION already names keychain / errSecDuplicateItem + the fix,
  // so don't stack a second copy.
  if (isCursorKeychainStuckOutput(haystack)) {
    return `Cursor auth/keychain died mid-run. ${CURSOR_KEYCHAIN_REMEDIATION}`;
  }
  const classified: RuntimeAuthClassification | null = runtimeAuthClassificationForLog(
    haystack,
    runtime ?? null
  );
  if (classified?.issue.code === "runtime_auth") {
    // NOT-133: this is the branch the operator never saw, because cursor-agent's own
    // "Authentication required" matched nothing and the strip fell back to "failed or crashed".
    // Without a recorded runtime the log may not name its CLI either — say "Runtime" rather
    // than pick one, since the remediation that follows then covers all three.
    const label = classified.runtime ? RUNTIME_AUTH_LABEL[classified.runtime] : "Runtime";
    return `${label} auth required mid-run — ${classified.issue.message}`;
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
export function reasonForDirtyWorktree(
  logPath: string | null | undefined,
  runtime?: Runtime
): string {
  const classified = classifyRunnerLogFailure(logPath, runtime);
  if (classified) {
    return `${classified} Worktree preserved with uncommitted changes.`;
  }
  return "Developer worktree has uncommitted changes after the session ended.";
}

export function reasonForSessionCrash(opts: {
  timedOut: boolean;
  logPath: string | null | undefined;
  runtime?: Runtime;
}): string {
  const classified = classifyRunnerLogFailure(opts.logPath, opts.runtime);
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
    case "muse_cron_used":
      return "muse_cron_used: the Muse session called a cron_* tool, which Muse cannot disable.";
    case "adapter_failure":
      return "Git/GitHub verification failed.";
    case "deck_failure":
      return "Agent Deck preflight failed.";
    case "deck_unavailable":
      return "Agent Deck is unreachable.";
    case "base_fetch_failed":
      return "Could not fetch the base branch before creating the issue branch.";
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
  runtime?: Runtime;
}): string {
  const explicit = outcomeExplicitReason(opts.outcome);
  if (explicit) return explicit;

  const fromSession = parseErrorJsonReason(opts.sessionErrorJson);
  if (fromSession) return fromSession;

  const fromLog = classifyRunnerLogFailure(opts.logPath, opts.runtime);
  if (fromLog) {
    if (opts.outcome.kind === "dirty_worktree") {
      return `${fromLog} Worktree preserved with uncommitted changes.`;
    }
    return fromLog;
  }

  if (opts.routeReason?.trim()) return opts.routeReason.trim();
  return fallbackReasonForKind(opts.outcome);
}

/**
 * Whether this outcome should persist errorJson on the worker_session row.
 * `deck_unavailable` and `usage_capped` are deliberately absent — they are waits, not
 * failures, and worker-loop records their reason on the deferral path instead (NOT-136).
 */
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
    outcome.kind === "live_owner" ||
    outcome.kind === "muse_cron_used"
  );
}

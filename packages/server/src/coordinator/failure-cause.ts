// packages/server/src/coordinator/failure-cause.ts
//
// NOT-171: normalized first-actionable-cause classification.
//
// The single classifier for both observed failures (commands.ts worker.failed,
// worker-loop session errorJson) and recovery-produced failures (recovery.ts
// presumed-dead reclaims). It never replaces raw evidence: the operator prose
// from failure-reason.ts, `worker_sessions.error_json`, log paths, and workflow
// events stay as recorded; classification only references them.
//
// Evidence discipline mirrors failure-reason.ts / usage-cap.ts (NOT-117, NOT-133):
// log evidence comes from `readSpawnLogFailureText` — the stderr trailer plus
// terminal error strings from structured stream events — so a worker merely
// discussing an auth error in its transcript never classifies as one.
import type {
  FailureCause,
  FailureCauseCode,
  FailureCauseConfidence,
  FailureEvidenceSource,
  Runtime,
} from "@agent-dealer/shared";
import {
  FAILURE_CAUSE_DEFAULT_DOMAIN,
  isCursorKeychainStuckOutput,
  runtimeAuthClassificationForLog,
} from "@agent-dealer/shared";
import { PRESUMED_DEAD_REASON, readSpawnLogFailureText } from "./failure-reason.js";
import type { WorkflowEvent } from "@agent-dealer/shared";
import { eventCursor, listWorkflowEventsForSessionOrdered } from "../repository/workflow-events.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import { recordFailureCauses } from "../repository/failure-causes.js";

/** Input evidence for classifying one failed attempt's observation. */
export interface AttemptFailureInput {
  outcomeKind: string | null;
  outcomeReason?: string | null;
  sessionErrorJson?: string | null;
  routeReason?: string | null;
  logPath?: string | null;
  runtime?: Runtime | null;
  exitCode?: number | null;
  timedOut?: boolean;
  /** Independent evidence a tool/test subprocess was in flight (timeout only). */
  toolInFlight?: boolean;
  /** A host.suspended event covers this session's lease window. */
  hostSuspended?: boolean;
  /** Recovery-produced failure (reclaim), not an observed agent failure. */
  recovery?: "rerun" | "republish" | null;
  occurredAt?: string | null;
  eventCursor?: number | null;
  sessionId?: string | null;
  eventId?: string | null;
  eventType?: string | null;
  /** Backfill-on-read for legacy rows marks quality inferred, never exact. */
  quality?: "exact" | "inferred";
}

interface Signal {
  code: FailureCauseCode;
  confidence: FailureCauseConfidence;
  evidenceSource: FailureEvidenceSource;
  rawReason: string;
}

function parseSessionReason(errorJson: string | null | undefined): string | null {
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

/** Provider capacity/rate-limit markers in failure-bearing text. Never bare "limit reached". */
const PROVIDER_CAPACITY_RES = [
  /\b429\b/,
  /\brate[_\s-]*limit(?:ed|ing)?\b/i,
  /\bquota\b/i,
  /\bbilling_error\b/i,
  /\bsubscription limit\b/i,
  /\bcapacity\b/i,
  /\boverloaded\b/i,
  /\bis_overloaded_error\b/i,
  /\bmodel.{0,40}\bunavailable\b/i,
  /\bserver (?:is )?overloaded\b/i,
  /\btry again later\b/i,
  /\bprovider.{0,40}(?:timeout|timed out|unavailable|error)\b/i,
  /\b5\d\d\b.{0,40}(?:model|provider|api|gateway)|(?:model|provider|api|gateway).{0,40}\b5\d\d\b/i,
];

/** Phrases that mention a limit but are NOT provider capacity (NOT-117-style near-misses). */
const NON_PROVIDER_LIMIT_RE =
  /\binfra-attempt limit\b|attempt limit|token limit|context\b.{0,20}limit|output limit|review-round|rate_limit_info/i;

/** Test/tool words that, together with a timeout, prove a tool/test was in flight. */
const TOOL_TEST_RE =
  /\b(vitest|jest|pytest|mocha|rspec|tap|bun test|go test|cargo test|test suite|unit tests?|integration tests?|e2e tests?|npm test|yarn test|pnpm test|subprocess|tool call)\b/i;
const TIMEOUT_WORD_RE = /\btimed?\s*out\b|\btimeout\b/i;

/** Publish/push/PR/remote markers. */
const PUBLISH_RE =
  /\b(push|pull request|\bpr\b|publish|gh\b|github|remote|fetch|origin|non-fast-forward|rejected|unpushed|republish)\b/i;

/** Presumed-dead reclaim carrying a host-sleep story. */
const SLEEP_WORD_RE = /\b(sleep|slept|suspend|suspended|clock jump|laptop|host)\b/i;

const RECONNECT_EXHAUSTED_RE =
  /reconnect(?:ion)?s?\s+(?:exhausted|failed|gave up)|failed to reconnect|unable to reconnect|connection (?:lost|closed|reset).{0,40}(?:retries|attempts)/i;

function hasProviderCapacitySignal(text: string): boolean {
  if (!text.trim()) return false;
  if (NON_PROVIDER_LIMIT_RE.test(text)) return false;
  return PROVIDER_CAPACITY_RES.some((re) => re.test(text));
}

function detectLogSignal(haystack: string, runtime: Runtime | null): Signal | null {
  if (!haystack.trim()) return null;
  if (isCursorKeychainStuckOutput(haystack)) {
    return {
      code: "authentication_configuration",
      confidence: "high",
      evidenceSource: "spawn_log",
      rawReason: haystack.slice(0, 500),
    };
  }
  const auth = runtimeAuthClassificationForLog(haystack, runtime);
  if (auth?.issue.code === "runtime_auth") {
    return {
      code: "authentication_configuration",
      confidence: auth.runtime ? "high" : "medium",
      evidenceSource: "spawn_log",
      rawReason: haystack.slice(0, 500),
    };
  }
  if (hasProviderCapacitySignal(haystack)) {
    return {
      code: "provider_capacity_rate_limit",
      confidence: "high",
      evidenceSource: "spawn_log",
      rawReason: haystack.slice(0, 500),
    };
  }
  if (RECONNECT_EXHAUSTED_RE.test(haystack)) {
    return {
      code: "provider_capacity_rate_limit",
      confidence: "medium",
      evidenceSource: "spawn_log",
      rawReason: haystack.slice(0, 500),
    };
  }
  return null;
}

function detectOutcomeSignal(
  kind: string | null,
  reasonText: string,
  opts: { timedOut: boolean; toolInFlight: boolean; logHaystack: string }
): Signal | null {
  const rawReason = reasonText.trim();
  switch (kind) {
    case "checks_failed":
      return {
        code: "validation_failure",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Developer's PR checks failed.",
      };
    case "publish_failed":
      return {
        code: "publish_git_failure",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Review publication to GitHub failed.",
      };
    case "unpushed_commit":
      return {
        code: "publish_git_failure",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Developer's commits could not be pushed.",
      };
    case "base_fetch_failed":
      return {
        code: "publish_git_failure",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Could not fetch the base branch.",
      };
    case "deck_unavailable":
    case "deck_failure":
      return {
        code: "agent_deck_unavailable",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Agent Deck unavailable.",
      };
    case "usage_capped":
      return {
        code: "provider_capacity_rate_limit",
        confidence: "high",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Runtime usage capped.",
      };
    case "adapter_failure":
      if (PUBLISH_RE.test(rawReason)) {
        return {
          code: "publish_git_failure",
          confidence: "medium",
          evidenceSource: "outcome_kind",
          rawReason: rawReason || "Git/GitHub verification failed.",
        };
      }
      // Coordinator-side tooling (checkout/setup/verification harness), not publish.
      return {
        code: "coordinator_crash",
        confidence: "medium",
        evidenceSource: "outcome_kind",
        rawReason: rawReason || "Git/GitHub verification failed.",
      };
    case "timed_out": {
      const toolEvidence =
        opts.toolInFlight ||
        (TIMEOUT_WORD_RE.test(`${rawReason}\n${opts.logHaystack}`) &&
          TOOL_TEST_RE.test(`${rawReason}\n${opts.logHaystack}`));
      if (toolEvidence) {
        return {
          code: "tool_test_timeout",
          confidence: opts.toolInFlight ? "high" : "medium",
          evidenceSource: opts.toolInFlight ? "workflow_event" : "spawn_log",
          rawReason: rawReason || "Developer session timed out.",
        };
      }
      // Ambiguous timeout stays unknown — never promoted to tool_test_timeout.
      return null;
    }
    default:
      return null;
  }
}

/**
 * Order causes for one attempt and mark exactly one primary: the earliest
 * chronological actionable cause. Sorting uses durable ordering (occurred-at,
 * then workflow event cursor); ties keep insertion order, and callers insert
 * log evidence before outcome evidence before recovery evidence. Later
 * validation/publish/recovery causes are consequences and cannot replace the
 * primary. When nothing is actionable, the first unknown cause is primary.
 */
export function orderAttemptCauses(causes: FailureCause[]): FailureCause[] {
  const epoch = (c: FailureCause): number => {
    if (!c.occurredAt) return Number.POSITIVE_INFINITY;
    const ms = Date.parse(c.occurredAt);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const indexed = causes.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    const ea = epoch(a.c);
    const eb = epoch(b.c);
    if (ea !== eb) return ea - eb;
    const ca = a.c.eventCursor ?? Number.POSITIVE_INFINITY;
    const cb = b.c.eventCursor ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return a.i - b.i;
  });
  const primaryIdx = indexed.findIndex(({ c }) => c.code !== "unknown");
  const pick = primaryIdx >= 0 ? primaryIdx : 0;
  return indexed.map(({ c }, i) => ({ ...c, primary: i === pick }));
}

/**
 * Central classifier for one failed attempt's observation. Observed failures
 * (outcome + session error + spawn log) and recovery-produced failures
 * (reclaim flag) share this path, so both read the same taxonomy.
 *
 * Returns causes in deterministic order with exactly one primary. Raw evidence
 * (error JSON, log path, event references) rides along on each cause; the
 * operator remediation prose in failure-reason.ts is untouched.
 */
export function classifyAttemptFailure(input: AttemptFailureInput): FailureCause[] {
  const runtime = input.runtime ?? null;
  const quality = input.quality ?? "exact";
  const sessionReason = parseSessionReason(input.sessionErrorJson);
  const outcomeReason = input.outcomeReason?.trim() || null;
  const routeReason = input.routeReason?.trim() || null;
  const rawReason = outcomeReason ?? sessionReason ?? routeReason ?? "";
  const logHaystack = readSpawnLogFailureText(input.logPath);
  const timedOut = input.timedOut ?? input.outcomeKind === "timed_out";
  const toolInFlight = input.toolInFlight ?? false;

  const base = {
    domain: undefined as never,
    occurredAt: input.occurredAt ?? null,
    eventCursor: input.eventCursor ?? null,
    sessionId: input.sessionId ?? null,
    logPath: input.logPath ?? null,
    eventId: input.eventId ?? null,
    eventType: input.eventType ?? null,
    quality,
  };
  const finish = (s: Signal): FailureCause => ({
    code: s.code,
    domain: FAILURE_CAUSE_DEFAULT_DOMAIN[s.code],
    primary: false,
    confidence: s.confidence,
    evidenceSource: s.evidenceSource,
    occurredAt: base.occurredAt,
    eventCursor: base.eventCursor,
    rawReason: s.rawReason || rawReason || "no failure reason recorded",
    sessionId: base.sessionId,
    logPath: base.logPath,
    eventId: base.eventId,
    eventType: base.eventType,
    quality: base.quality,
  });

  const signals: Signal[] = [];

  // Recovery-produced failures share the classifier. A reclaim over a
  // host-sleep window is host_sleep_liveness; any other presumed-dead reclaim
  // is a coordinator/host crash, never a task failure.
  const presumedDead =
    input.recovery != null ||
    (sessionReason ?? "").includes(PRESUMED_DEAD_REASON) ||
    (outcomeReason ?? "").includes(PRESUMED_DEAD_REASON);
  if (presumedDead) {
    const sleepEvidence = input.hostSuspended === true || SLEEP_WORD_RE.test(rawReason);
    signals.push(
      sleepEvidence
        ? {
            code: "host_sleep_liveness",
            confidence: input.hostSuspended === true ? "high" : "medium",
            evidenceSource: input.recovery != null ? "recovery" : "session_error",
            rawReason: rawReason || PRESUMED_DEAD_REASON,
          }
        : {
            code: "coordinator_crash",
            confidence: "medium",
            evidenceSource: input.recovery != null ? "recovery" : "session_error",
            rawReason: rawReason || PRESUMED_DEAD_REASON,
          }
    );
  }

  // Spawn-log evidence predates outcome evidence: a provider/auth crash that
  // later surfaces as checks_failed/publish fallout keeps the earlier cause.
  const logSignal = detectLogSignal(logHaystack, runtime);
  if (logSignal) signals.push(logSignal);

  // Deck words in failure-bearing text (not transcript prose) name the Deck.
  if (
    !signals.some((s) => s.code === "agent_deck_unavailable") &&
    /\bagent deck\b/i.test(`${outcomeReason ?? ""}\n${sessionReason ?? ""}\n${logHaystack}`)
  ) {
    signals.push({
      code: "agent_deck_unavailable",
      confidence: input.outcomeKind === "deck_failure" ? "high" : "medium",
      evidenceSource: logHaystack && /\bagent deck\b/i.test(logHaystack) ? "spawn_log" : "outcome_kind",
      rawReason: rawReason || "Agent Deck failure.",
    });
  }

  const outcomeSignal = detectOutcomeSignal(input.outcomeKind, rawReason, {
    timedOut,
    toolInFlight,
    logHaystack,
  });
  if (outcomeSignal) {
    // A generic crash signal adds nothing once a specific cause exists; a
    // specific validation/publish/deck/cap cause is recorded as a consequence.
    signals.push(outcomeSignal);
  }

  // Non-zero CLI exit with no other signal is a CLI crash. A timeout's exit
  // code (kill escalation) is ambiguous, never a crash.
  if (
    signals.length === 0 &&
    input.exitCode != null &&
    input.exitCode !== 0 &&
    !timedOut
  ) {
    signals.push({
      code: "agent_cli_crash",
      confidence: "medium",
      evidenceSource: input.eventId ? "workflow_event" : "outcome_kind",
      rawReason: rawReason || `Agent CLI exited with code ${input.exitCode}.`,
    });
  }

  // Failure-bearing log text that matches nothing is still a crash signal;
  // silence (no log, no exit, no reason) is unknown, never guessed.
  if (signals.length === 0 && logHaystack.trim() && !timedOut) {
    signals.push({
      code: "agent_cli_crash",
      confidence: "low",
      evidenceSource: "spawn_log",
      rawReason: logHaystack.slice(0, 500),
    });
  }

  if (signals.length === 0) {
    signals.push({
      code: "unknown",
      confidence: "low",
      evidenceSource: sessionReason ? "session_error" : "outcome_kind",
      rawReason: rawReason || "no failure evidence recorded",
    });
  }

  // Deduplicate identical codes, keeping the earliest-inserted (log before outcome).
  const seen = new Set<FailureCauseCode>();
  const deduped = signals.filter((s) => {
    if (seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });

  return orderAttemptCauses(deduped.map(finish));
}

function agentCompletedEvidence(
  workerSessionId: string | null
): { exitCode: number | null; timedOut: boolean; hostSuspended: boolean } {
  const out = { exitCode: null as number | null, timedOut: false, hostSuspended: false };
  if (!workerSessionId) return out;
  let rows: Array<{ event: WorkflowEvent }>;
  try {
    rows = listWorkflowEventsForSessionOrdered(workerSessionId);
  } catch {
    return out;
  }
  for (const { event } of rows) {
    if (event.type === "host.suspended") out.hostSuspended = true;
    if (event.type !== "agent.completed") continue;
    try {
      const payload = JSON.parse(event.payloadJson ?? "{}") as {
        exitCode?: unknown;
        timedOut?: unknown;
      };
      if (typeof payload.exitCode === "number") out.exitCode = payload.exitCode;
      if (payload.timedOut === true) out.timedOut = true;
    } catch {
      // malformed payload is not failure evidence
    }
  }
  return out;
}

/**
 * Backfill-on-read for legacy rows: classify from existing session error/log
 * evidence without mutating any append-only event. Always quality "inferred" —
 * only newly recorded emissions are "exact".
 */
export function backfillCausesForSession(
  session: {
    id: string;
    errorJson: string | null;
    logPath: string | null;
    runtime: Runtime | null;
    exitCode: number | null;
    completedAt: string | null;
    updatedAt: string;
  },
  opts?: {
    outcomeKind?: string | null;
    occurredAt?: string | null;
    eventCursor?: number | null;
    eventId?: string | null;
    eventType?: string | null;
  }
): FailureCause[] {
  const agent = agentCompletedEvidence(session.id);
  const outcomeKind = opts?.outcomeKind ?? null;
  return classifyAttemptFailure({
    outcomeKind,
    sessionErrorJson: session.errorJson,
    logPath: session.logPath,
    runtime: session.runtime,
    exitCode: session.exitCode ?? agent.exitCode,
    timedOut: outcomeKind === "timed_out" || agent.timedOut,
    hostSuspended: agent.hostSuspended,
    occurredAt: opts?.occurredAt ?? session.completedAt ?? session.updatedAt,
    eventCursor: opts?.eventCursor ?? null,
    sessionId: session.id,
    eventId: opts?.eventId ?? null,
    eventType: opts?.eventType ?? null,
    quality: "inferred",
  });
}

/**
 * Classify and persist causes for a just-emitted worker.failed event, from the
 * same outcome/session/log sources the event reason was built from (plus the
 * agent.completed exit code and host.suspended evidence for the session).
 * Insert-only: never touches error_json or the event itself, and never throws —
 * evidence must not fail the attempt it describes.
 */
export function recordCausesForWorkerFailedEvent(opts: {
  issueId: string;
  workflowInstanceId: string | null;
  event: WorkflowEvent;
  outcomeKind: string | null;
  outcomeReason?: string | null;
  routeReason?: string | null;
  recovery?: "rerun" | "republish" | null;
}): void {
  try {
    const session = opts.event.workerSessionId ? getWorkerSession(opts.event.workerSessionId) : null;
    const agent = agentCompletedEvidence(opts.event.workerSessionId);
    const outcomeTimedOut = opts.outcomeKind === "timed_out";
    const causes = classifyAttemptFailure({
      outcomeKind: opts.outcomeKind,
      outcomeReason: opts.outcomeReason,
      sessionErrorJson: session?.errorJson ?? null,
      routeReason: opts.routeReason,
      logPath: session?.logPath ?? null,
      runtime: session?.runtime ?? undefined,
      exitCode: session?.exitCode ?? agent.exitCode,
      timedOut: outcomeTimedOut || agent.timedOut,
      hostSuspended: agent.hostSuspended,
      recovery: opts.recovery,
      occurredAt: opts.event.ts,
      eventCursor: eventCursor(opts.event.id),
      sessionId: opts.event.workerSessionId,
      eventId: opts.event.id,
      eventType: opts.event.type,
    });
    recordFailureCauses(
      causes.map((cause) => ({
        issueId: opts.issueId,
        cause,
        workflowInstanceId: opts.workflowInstanceId,
      }))
    );
  } catch (err) {
    console.error("[coordinator] recordCausesForWorkerFailedEvent", opts.event.id, err);
  }
}

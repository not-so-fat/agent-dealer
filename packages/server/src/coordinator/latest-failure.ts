// packages/server/src/coordinator/latest-failure.ts
//
// Issue-detail failure strip payload (NOT-113): reason + when + infra n/max + log path.
import type { Issue, WorkerSession, WorkflowEvent } from "@agent-dealer/shared";
import {
  getLatestFailedWorkerSessionForIssue,
  getWorkerSession,
} from "../repository/worker-sessions.js";
import {
  eventCursor,
  listWorkflowEventsForIssue,
  workerStartedEventCursor,
} from "../repository/workflow-events.js";
import { parseErrorJsonReason } from "./failure-reason.js";

export interface LatestSessionFailure {
  reason: string;
  when: string;
  role: string | null;
  outcome: string | null;
  sessionId: string | null;
  logPath: string | null;
  infraAttempts: number;
  maxInfraAttempts: number;
}

function parsePayload(json: string | null): {
  reason?: string;
  outcome?: string;
  sessionId?: string;
} | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as { reason?: string; outcome?: string; sessionId?: string };
  } catch {
    return null;
  }
}

function fromFailedEvent(
  event: WorkflowEvent,
  issue: Issue,
  session: WorkerSession | null
): LatestSessionFailure | null {
  const payload = parsePayload(event.payloadJson);
  const reason =
    (payload?.reason && payload.reason.trim()) ||
    parseErrorJsonReason(session?.errorJson) ||
    null;
  if (!reason) return null;
  return {
    reason,
    when: event.ts,
    role: event.actorType === "developer" || event.actorType === "reviewer" ? event.actorType : null,
    outcome: payload?.outcome ?? null,
    sessionId: payload?.sessionId ?? session?.id ?? event.workerSessionId,
    logPath: session?.logPath ?? null,
    infraAttempts: issue.infraAttempts,
    maxInfraAttempts: issue.maxInfraAttempts,
  };
}

function fromSession(session: WorkerSession, issue: Issue): LatestSessionFailure | null {
  const reason = parseErrorJsonReason(session.errorJson);
  if (!reason) return null;
  return {
    reason,
    when: session.completedAt ?? session.updatedAt,
    role: session.role === "developer" || session.role === "reviewer" ? session.role : null,
    outcome: null,
    sessionId: session.id,
    logPath: session.logPath,
    infraAttempts: issue.infraAttempts,
    maxInfraAttempts: issue.maxInfraAttempts,
  };
}

/** True when a worker.completed was inserted after `afterCursor` (exclusive). Uses rowid, not ts. */
function hasCompletedAfterCursor(events: WorkflowEvent[], afterCursor: number): boolean {
  for (const e of events) {
    if (e.type !== "worker.completed") continue;
    const c = eventCursor(e.id);
    if (c != null && c > afterCursor) return true;
  }
  return false;
}

/**
 * Prefer the latest worker.failed timeline reason; fall back to the latest session
 * errorJson so soft-recovery / incomplete emits still surface something.
 * Suppressed when a later worker.completed exists after that failure (stale strip).
 *
 * Ordering uses workflow_events.rowid via `eventCursor` / `workerStartedEventCursor` —
 * never raw `ts` comparisons (ms collisions; see workflow-events.ts).
 */
export function latestSessionFailureForIssue(issue: Issue): LatestSessionFailure | null {
  const events = listWorkflowEventsForIssue(issue.id);

  let lastFailed: WorkflowEvent | null = null;
  let lastFailedCursor = -1;
  for (const e of events) {
    if (e.type !== "worker.failed") continue;
    const c = eventCursor(e.id);
    if (c == null) continue;
    if (c >= lastFailedCursor) {
      lastFailed = e;
      lastFailedCursor = c;
    }
  }
  if (lastFailed && lastFailedCursor >= 0) {
    if (hasCompletedAfterCursor(events, lastFailedCursor)) return null;
    const payload = parsePayload(lastFailed.payloadJson);
    const sessionId = payload?.sessionId ?? lastFailed.workerSessionId ?? null;
    const session = sessionId ? getWorkerSession(sessionId) : null;
    const built = fromFailedEvent(lastFailed, issue, session);
    if (built) return built;
  }

  const failedSession = getLatestFailedWorkerSessionForIssue(issue.id);
  if (!failedSession) return null;
  // Anchor at this session's worker.started rowid (same convention as guidance windows).
  // A later worker.completed (any session) clears the strip — including same-ms inserts.
  const startedCursor = workerStartedEventCursor(failedSession.id);
  if (startedCursor != null && hasCompletedAfterCursor(events, startedCursor)) return null;
  return fromSession(failedSession, issue);
}

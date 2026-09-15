// packages/server/src/coordinator/latest-failure.ts
//
// Issue-detail failure strip payload (NOT-113): reason + when + infra n/max + log path.
import type { Issue, WorkerSession, WorkflowEvent } from "@agent-dealer/shared";
import {
  getLatestFailedWorkerSessionForIssue,
  getWorkerSession,
} from "../repository/worker-sessions.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";
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

/**
 * Prefer the latest worker.failed timeline reason; fall back to the latest session
 * errorJson so soft-recovery / incomplete emits still surface something.
 * Suppressed when a later worker.completed exists after that failure (stale strip).
 */
export function latestSessionFailureForIssue(issue: Issue): LatestSessionFailure | null {
  const events = listWorkflowEventsForIssue(issue.id);

  let lastFailedIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "worker.failed") {
      lastFailedIdx = i;
      break;
    }
  }
  if (lastFailedIdx >= 0) {
    if (hasCompletedAfter(events, lastFailedIdx)) return null;
    const e = events[lastFailedIdx]!;
    const payload = parsePayload(e.payloadJson);
    const sessionId = payload?.sessionId ?? e.workerSessionId ?? null;
    const session = sessionId ? getWorkerSession(sessionId) : null;
    const built = fromFailedEvent(e, issue, session);
    if (built) return built;
  }

  const failedSession = getLatestFailedWorkerSessionForIssue(issue.id);
  if (!failedSession) return null;
  const when = failedSession.completedAt ?? failedSession.updatedAt;
  // Session fallback must honor the same supersede rule: a later successful handoff
  // clears the strip even when no worker.failed event was recorded for that session.
  if (events.some((e) => e.type === "worker.completed" && e.ts > when)) return null;
  return fromSession(failedSession, issue);
}

function hasCompletedAfter(events: WorkflowEvent[], afterIdx: number): boolean {
  for (let i = afterIdx + 1; i < events.length; i++) {
    if (events[i]!.type === "worker.completed") return true;
  }
  return false;
}

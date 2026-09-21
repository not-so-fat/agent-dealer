// packages/server/src/repository/session-activity.ts
//
// NOT-170: append-only `session_activity_events` evidence plus the read-model assembly
// of persisted rows + agent_process bounds + host-sleep evidence into silence
// intervals for a later API ticket. Read-only toward control-plane code: this module
// is observational and must not be imported by admission, leases, recovery, routing,
// retry, termination, or scheduling code.

import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import type {
  SessionActivityKind,
  SessionActivityState,
} from "../coordinator/session-activity.js";
import {
  deriveSilenceIntervals,
  silenceThresholdMs,
  type SilenceActivityPoint,
  type SilenceDerivation,
  type SleepWindow,
} from "../coordinator/session-silence.js";
import { listWorkflowEventsForSessionOrdered } from "./workflow-events.js";

export interface SessionActivityEvent {
  id: string;
  issueId: string;
  workerSessionId: string;
  observedAt: string;
  sourceCursor: number | null;
  sourceOffset: number | null;
  activityKind: SessionActivityKind;
  state: SessionActivityState;
  callId: string | null;
  summary: string | null;
  rawEvidence: string | null;
}

interface SessionActivityRow {
  id: string;
  issue_id: string;
  worker_session_id: string;
  observed_at: string;
  source_cursor: number | null;
  source_offset: number | null;
  activity_kind: string;
  state: string;
  call_id: string | null;
  summary: string | null;
  raw_evidence: string | null;
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "assistant_output",
  "provider_wait",
  "tool_started",
  "tool_completed",
  "unknown_activity",
]);

function rowToEvent(row: SessionActivityRow): SessionActivityEvent {
  const kind = VALID_KINDS.has(row.activity_kind)
    ? (row.activity_kind as SessionActivityKind)
    : ("unknown_activity" as SessionActivityKind);
  const state =
    row.state === "started" || row.state === "completed" ? (row.state as SessionActivityState) : ("observed" as SessionActivityState);
  return {
    id: row.id,
    issueId: row.issue_id,
    workerSessionId: row.worker_session_id,
    observedAt: row.observed_at,
    sourceCursor: row.source_cursor,
    sourceOffset: row.source_offset,
    activityKind: kind,
    state,
    callId: row.call_id,
    summary: row.summary,
    rawEvidence: row.raw_evidence,
  };
}

export interface InsertSessionActivityInput {
  issueId: string;
  workerSessionId: string;
  observedAt?: string;
  sourceCursor?: number | null;
  sourceOffset?: number | null;
  activityKind: SessionActivityKind;
  state: SessionActivityState;
  callId?: string | null;
  /** Existing ≤120-char operator summary only — never transcript bodies or arguments. */
  summary?: string | null;
  /** Pointer to the raw evidence (`<log_path>#offset=<n>`), never payload. */
  rawEvidence?: string | null;
}

/**
 * Append one activity row. Re-inserting the same (session, source_offset) is a
 * no-op returning the existing row, so sampler re-reads and restarts are idempotent.
 */
export function insertSessionActivityEvent(input: InsertSessionActivityInput): SessionActivityEvent {
  const db = getDb();
  if (input.sourceOffset !== undefined && input.sourceOffset !== null) {
    const existing = db
      .prepare("SELECT * FROM session_activity_events WHERE worker_session_id = ? AND source_offset = ?")
      .get(input.workerSessionId, input.sourceOffset) as SessionActivityRow | undefined;
    if (existing) return rowToEvent(existing);
  }
  const row: SessionActivityRow = {
    id: `sa_${uuid()}`,
    issue_id: input.issueId,
    worker_session_id: input.workerSessionId,
    observed_at: input.observedAt ?? new Date().toISOString(),
    source_cursor: input.sourceCursor ?? null,
    source_offset: input.sourceOffset ?? null,
    activity_kind: input.activityKind,
    state: input.state,
    call_id: input.callId ?? null,
    summary: input.summary ?? null,
    raw_evidence: input.rawEvidence ?? null,
  };
  db.prepare(
    `INSERT INTO session_activity_events
      (id, issue_id, worker_session_id, observed_at, source_cursor, source_offset,
       activity_kind, state, call_id, summary, raw_evidence)
     VALUES (@id, @issue_id, @worker_session_id, @observed_at, @source_cursor, @source_offset,
       @activity_kind, @state, @call_id, @summary, @raw_evidence)`
  ).run(row);
  return rowToEvent(row);
}

/** Rows for one session in observation order (observed_at, then insertion order). */
export function listSessionActivityEvents(workerSessionId: string): SessionActivityEvent[] {
  const rows = getDb()
    .prepare("SELECT rowid AS rid, * FROM session_activity_events WHERE worker_session_id = ? ORDER BY observed_at ASC, rid ASC")
    .all(workerSessionId) as Array<SessionActivityRow & { rid: number }>;
  return rows.map(rowToEvent);
}

/** Durable resume point for the sampler: the farthest byte offset persisted, if any. */
export function getSessionActivityMaxOffset(workerSessionId: string): number | null {
  const row = getDb()
    .prepare("SELECT MAX(source_offset) AS max_offset FROM session_activity_events WHERE worker_session_id = ?")
    .get(workerSessionId) as { max_offset: number | null } | undefined;
  return row?.max_offset ?? null;
}

/** Durable resume cursor: the farthest source line cursor persisted, if any. */
export function getSessionActivityMaxCursor(workerSessionId: string): number | null {
  const row = getDb()
    .prepare("SELECT MAX(source_cursor) AS max_cursor FROM session_activity_events WHERE worker_session_id = ?")
    .get(workerSessionId) as { max_cursor: number | null } | undefined;
  return row?.max_cursor ?? null;
}

export interface SessionSilenceReadModel extends SilenceDerivation {
  workerSessionId: string;
  processStartMs: number | null;
  processEndMs: number | null;
}

/**
 * Assemble persisted activity rows, exact/inferred agent_process bounds, and durable
 * host-sleep evidence into silence intervals for one session. Bounds come from the
 * session's `agent.started` / `agent.completed` workflow events; a missing boundary
 * yields `unavailable` (never fabricated). Sleep windows derive from `host.suspended`
 * payloads as [detectedAt − wallGapMs, detectedAt).
 */
export function getSessionSilenceIntervals(
  workerSessionId: string,
  opts?: { thresholdMs?: number }
): SessionSilenceReadModel {
  const events = listWorkflowEventsForSessionOrdered(workerSessionId);
  let startedMs: number | null = null;
  let completedMs: number | null = null;
  const sleeps: SleepWindow[] = [];
  for (const { event } of events) {
    if (event.type === "agent.started" && startedMs === null) {
      const ms = Date.parse(event.ts);
      if (Number.isFinite(ms)) startedMs = ms;
    } else if (event.type === "agent.completed" && completedMs === null) {
      const ms = Date.parse(event.ts);
      if (Number.isFinite(ms)) completedMs = ms;
    } else if (event.type === "host.suspended") {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = event.payloadJson ? JSON.parse(event.payloadJson) : {};
        if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
      } catch {
        payload = {};
      }
      const detected = typeof payload.detectedAt === "string" ? Date.parse(payload.detectedAt) : NaN;
      const gap = typeof payload.wallGapMs === "number" ? payload.wallGapMs : NaN;
      if (Number.isFinite(detected) && Number.isFinite(gap) && gap > 0) {
        sleeps.push({ startMs: detected - gap, endMs: detected });
      }
    }
  }

  const rows = listSessionActivityEvents(workerSessionId);
  const activities: SilenceActivityPoint[] = [];
  for (const row of rows) {
    const ms = Date.parse(row.observedAt);
    if (!Number.isFinite(ms)) continue;
    activities.push({ observedMs: ms, kind: row.activityKind, callId: row.callId });
  }

  const boundsAvailable = startedMs !== null && completedMs !== null;
  const derived = deriveSilenceIntervals({
    processStartMs: startedMs,
    processEndMs: completedMs,
    processQuality: boundsAvailable ? "exact" : "unavailable",
    processReasons: boundsAvailable ? [] : ["no_defensible_boundary"],
    activities,
    sleepWindows: sleeps,
    thresholdMs: opts?.thresholdMs ?? silenceThresholdMs(),
  });
  return {
    ...derived,
    workerSessionId,
    processStartMs: startedMs,
    processEndMs: completedMs,
  };
}

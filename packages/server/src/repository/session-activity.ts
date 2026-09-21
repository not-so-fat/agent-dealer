// packages/server/src/repository/session-activity.ts
//
// NOT-170: append-only `session_activity_events` evidence plus the read-model assembly
// of persisted rows + agent_process bounds + host-sleep evidence into silence
// intervals for a later API ticket. Read-only toward control-plane code: this module
// is observational and must not be imported by admission, leases, recovery, routing,
// retry, termination, or scheduling code.

import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { deriveAttemptIntervals } from "../coordinator/execution-intervals.js";
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
  /** 0-based index of this entry within its NDJSON line (parallel blocks share an offset). */
  sourceSeq: number | null;
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
  source_seq: number | null;
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
    sourceSeq: row.source_seq,
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
  /** 0-based entry index within its NDJSON line; defaults to 0. */
  sourceSeq?: number | null;
  activityKind: SessionActivityKind;
  state: SessionActivityState;
  callId?: string | null;
  /** Existing ≤120-char operator summary only — never transcript bodies or arguments. */
  summary?: string | null;
  /** Pointer to the raw evidence (`<log_path>#offset=<n>`), never payload. */
  rawEvidence?: string | null;
}

/**
 * Append one activity row. Re-inserting the same (session, source_offset, source_seq)
 * is a no-op returning the existing row, so sampler re-reads and restarts are
 * idempotent while parallel entries from one line persist as distinct rows.
 */
export function insertSessionActivityEvent(input: InsertSessionActivityInput): SessionActivityEvent {
  const db = getDb();
  const seq = input.sourceSeq ?? 0;
  if (input.sourceOffset !== undefined && input.sourceOffset !== null) {
    const existing = db
      .prepare("SELECT * FROM session_activity_events WHERE worker_session_id = ? AND source_offset = ? AND source_seq = ?")
      .get(input.workerSessionId, input.sourceOffset, seq) as SessionActivityRow | undefined;
    if (existing) return rowToEvent(existing);
  }
  const row: SessionActivityRow = {
    id: `sa_${uuid()}`,
    issue_id: input.issueId,
    worker_session_id: input.workerSessionId,
    observed_at: input.observedAt ?? new Date().toISOString(),
    source_cursor: input.sourceCursor ?? null,
    source_offset: input.sourceOffset ?? null,
    source_seq: seq,
    activity_kind: input.activityKind,
    state: input.state,
    call_id: input.callId ?? null,
    summary: input.summary ?? null,
    raw_evidence: input.rawEvidence ?? null,
  };
  db.prepare(
    `INSERT INTO session_activity_events
      (id, issue_id, worker_session_id, observed_at, source_cursor, source_offset, source_seq,
       activity_kind, state, call_id, summary, raw_evidence)
     VALUES (@id, @issue_id, @worker_session_id, @observed_at, @source_cursor, @source_offset, @source_seq,
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
 * host-sleep evidence into silence intervals for one session. Bounds reuse the shared
 * NOT-169 derivation (deriveAttemptIntervals) over the session's workflow events so
 * they stay consistent with the rest of the execution analysis; a missing boundary
 * yields `unavailable` (never fabricated). Sleep windows derive from `host.suspended`
 * payloads as [detectedAt − suspendedMs, detectedAt), where suspendedMs prefers the
 * monotonic-clock `unelapsedMs` portion and falls back to the whole `wallGapMs` (tagged
 * `host_sleep_approximated`) when unelapsedMs is absent — wallGapMs includes time the
 * host was awake, so using it whole would overrun into other categories.
 */
export function getSessionSilenceIntervals(
  workerSessionId: string,
  opts?: { thresholdMs?: number }
): SessionSilenceReadModel {
  const ordered = listWorkflowEventsForSessionOrdered(workerSessionId);
  const bounds = deriveAttemptIntervals({
    events: ordered.map(({ event, rowid }) => ({ type: event.type, ts: event.ts, rowid })),
  }).agentProcess;
  const startedMs = bounds.startMs;
  const completedMs = bounds.endMs;

  const sleeps: SleepWindow[] = [];
  let sleepApproximated = false;
  for (const { event } of ordered) {
    if (event.type !== "host.suspended") continue;
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = event.payloadJson ? JSON.parse(event.payloadJson) : {};
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const detected = typeof payload.detectedAt === "string" ? Date.parse(payload.detectedAt) : NaN;
    const unelapsed = typeof payload.unelapsedMs === "number" ? payload.unelapsedMs : NaN;
    const wallGap = typeof payload.wallGapMs === "number" ? payload.wallGapMs : NaN;
    const suspendedMs =
      Number.isFinite(unelapsed) && unelapsed > 0
        ? unelapsed
        : Number.isFinite(wallGap) && wallGap > 0
          ? wallGap
          : NaN;
    if (!Number.isFinite(detected) || !Number.isFinite(suspendedMs) || suspendedMs <= 0) continue;
    if (!(Number.isFinite(unelapsed) && unelapsed > 0)) sleepApproximated = true;
    sleeps.push({ startMs: detected - suspendedMs, endMs: detected });
  }

  const rows = listSessionActivityEvents(workerSessionId);
  const activities: SilenceActivityPoint[] = [];
  for (const row of rows) {
    const ms = Date.parse(row.observedAt);
    if (!Number.isFinite(ms)) continue;
    activities.push({ observedMs: ms, kind: row.activityKind, callId: row.callId });
  }

  const derived = deriveSilenceIntervals({
    processStartMs: startedMs,
    processEndMs: completedMs,
    processQuality: bounds.quality,
    processReasons: bounds.reasons,
    activities,
    sleepWindows: sleeps,
    thresholdMs: opts?.thresholdMs ?? silenceThresholdMs(),
  });
  const reasons = sleepApproximated && derived.quality !== "unavailable"
    ? [...new Set([...derived.reasons, "host_sleep_approximated"])]
    : derived.reasons;
  return {
    intervals: sleepApproximated
      ? derived.intervals.map((iv) => iv.category === "host_suspended"
          ? { ...iv, reasons: [...new Set([...iv.reasons, "host_sleep_approximated"])] }
          : iv)
      : derived.intervals,
    quality: derived.quality,
    reasons,
    workerSessionId,
    processStartMs: startedMs,
    processEndMs: completedMs,
  };
}

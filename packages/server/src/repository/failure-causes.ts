// packages/server/src/repository/failure-causes.ts
//
// NOT-171: append-only normalized failure-cause evidence. Rows are derived from
// (never a replacement for) worker_sessions.error_json, spawn logs, and
// workflow events: writers INSERT only, nothing here UPDATEs or DELETEs, and
// backfill-on-read marks legacy derivations quality "inferred".
import type { FailureCause } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface FailureCauseRow {
  id: string;
  issue_id: string;
  worker_session_id: string | null;
  workflow_instance_id: string | null;
  workflow_event_id: string | null;
  event_cursor: number | null;
  code: string;
  domain: string;
  primary_flag: number;
  confidence: string;
  evidence_source: string;
  occurred_at: string | null;
  raw_reason: string;
  log_path: string | null;
  quality: string;
  created_at: string;
}

function rowToCause(row: FailureCauseRow): FailureCause {
  return {
    code: row.code as FailureCause["code"],
    domain: row.domain as FailureCause["domain"],
    primary: row.primary_flag === 1,
    confidence: row.confidence as FailureCause["confidence"],
    evidenceSource: row.evidence_source as FailureCause["evidenceSource"],
    occurredAt: row.occurred_at,
    eventCursor: row.event_cursor,
    rawReason: row.raw_reason,
    sessionId: row.worker_session_id,
    logPath: row.log_path,
    eventId: row.workflow_event_id,
    eventType: null,
    quality: row.quality as FailureCause["quality"],
  };
}

export interface RecordFailureCauseInput {
  issueId: string;
  cause: FailureCause;
  workflowInstanceId?: string | null;
}

/**
 * Persist one attempt's classified causes. Insert-only and idempotent per
 * (session, event, code): a retried emit never duplicates rows and never
 * rewrites them. `eventType` is intentionally not persisted — the workflow
 * event row it references already carries it.
 */
export function recordFailureCauses(inputs: RecordFailureCauseInput[]): void {
  if (inputs.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const existing = new Set(
    db
      .prepare(
        `SELECT COALESCE(worker_session_id, '') || '|' || COALESCE(workflow_event_id, '') || '|' || code AS k
         FROM failure_causes
         WHERE issue_id = ?`
      )
      .all(inputs[0]!.issueId)
      .map((r) => (r as { k: string }).k)
  );
  const insert = db.prepare(`
    INSERT INTO failure_causes (
      id, issue_id, worker_session_id, workflow_instance_id, workflow_event_id,
      event_cursor, code, domain, primary_flag, confidence, evidence_source,
      occurred_at, raw_reason, log_path, quality, created_at
    ) VALUES (
      @id, @issue_id, @worker_session_id, @workflow_instance_id, @workflow_event_id,
      @event_cursor, @code, @domain, @primary_flag, @confidence, @evidence_source,
      @occurred_at, @raw_reason, @log_path, @quality, @created_at
    )
  `);
  const tx = db.transaction(() => {
    for (const { issueId, cause, workflowInstanceId } of inputs) {
      const key = `${cause.sessionId ?? ""}|${cause.eventId ?? ""}|${cause.code}`;
      if (existing.has(key)) continue;
      existing.add(key);
      insert.run({
        id: uuid(),
        issue_id: issueId,
        worker_session_id: cause.sessionId,
        workflow_instance_id: workflowInstanceId ?? null,
        workflow_event_id: cause.eventId,
        event_cursor: cause.eventCursor,
        code: cause.code,
        domain: cause.domain,
        primary_flag: cause.primary ? 1 : 0,
        confidence: cause.confidence,
        evidence_source: cause.evidenceSource,
        occurred_at: cause.occurredAt,
        raw_reason: cause.rawReason,
        log_path: cause.logPath,
        quality: cause.quality,
        created_at: now,
      });
    }
  });
  tx();
}

/** Per-attempt cause history in deterministic order (cursor, then code). */
export function listFailureCausesForSession(workerSessionId: string): FailureCause[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM failure_causes
       WHERE worker_session_id = ?
       ORDER BY COALESCE(event_cursor, 9223372036854775807) ASC, code ASC, created_at ASC`
    )
    .all(workerSessionId) as FailureCauseRow[];
  return rows.map(rowToCause);
}

/** Every persisted cause for an issue, oldest first. */
export function listFailureCausesForIssue(issueId: string): FailureCause[] {
  const rows = getDb()
    .prepare("SELECT * FROM failure_causes WHERE issue_id = ? ORDER BY created_at ASC, code ASC")
    .all(issueId) as FailureCauseRow[];
  return rows.map(rowToCause);
}

/**
 * Per-issue first cause for the later API ticket: the earliest persisted
 * primary cause (durable cursor order), or null when nothing was recorded yet.
 */
export function firstFailureCauseForIssue(issueId: string): FailureCause | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM failure_causes
       WHERE issue_id = ? AND primary_flag = 1
       ORDER BY COALESCE(event_cursor, 9223372036854775807) ASC, created_at ASC
       LIMIT 1`
    )
    .get(issueId) as FailureCauseRow | undefined;
  return row ? rowToCause(row) : null;
}

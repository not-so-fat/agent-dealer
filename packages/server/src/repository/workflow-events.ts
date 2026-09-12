import type {
  WorkflowEvent,
  WorkflowEventType,
  WorkflowInstance,
  WorkflowInstanceOutcome,
} from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

// NOT-59: the workflow-instance lifecycle (start / complete / at-most-one-active
// enforcement) — the coordinator kernel is the only runtime writer.

interface WorkflowInstanceRow {
  id: string;
  issue_id: string;
  workflow_version: string;
  started_at: string;
  completed_at: string | null;
  outcome: string | null;
}

function rowToInstance(row: WorkflowInstanceRow): WorkflowInstance {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowVersion: row.workflow_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome as WorkflowInstanceOutcome | null,
  };
}

/** Raised when an issue already has a running workflow instance (partial unique index). */
export class WorkflowAlreadyActiveError extends Error {
  constructor(issueId: string) {
    super(`Issue ${issueId} already has an active workflow instance`);
    this.name = "WorkflowAlreadyActiveError";
  }
}

/**
 * Starts a workflow instance. The `idx_workflow_instances_one_active` partial unique index
 * guarantees at most one active instance per issue (PRD §2.1); a concurrent second start
 * fails the INSERT, which is rethrown as WorkflowAlreadyActiveError.
 */
export function startWorkflowInstance(issueId: string, workflowVersion: string): WorkflowInstance {
  const db = getDb();
  const now = new Date().toISOString();
  const row: WorkflowInstanceRow = {
    id: uuid(),
    issue_id: issueId,
    workflow_version: workflowVersion,
    started_at: now,
    completed_at: null,
    outcome: null,
  };
  try {
    db.prepare(`
      INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, completed_at, outcome)
      VALUES (@id, @issue_id, @workflow_version, @started_at, @completed_at, @outcome)
    `).run(row);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      throw new WorkflowAlreadyActiveError(issueId);
    }
    throw err;
  }
  return rowToInstance(row);
}

export function completeWorkflowInstance(
  id: string,
  outcome: WorkflowInstanceOutcome
): WorkflowInstance {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE workflow_instances SET completed_at = ?, outcome = ? WHERE id = ? AND completed_at IS NULL")
    .run(now, outcome, id);
  const row = getDb().prepare("SELECT * FROM workflow_instances WHERE id = ?").get(id) as
    | WorkflowInstanceRow
    | undefined;
  if (!row) throw new Error(`Workflow instance not found: ${id}`);
  return rowToInstance(row);
}

export function getWorkflowInstance(id: string): WorkflowInstance | null {
  const row = getDb().prepare("SELECT * FROM workflow_instances WHERE id = ?").get(id) as
    | WorkflowInstanceRow
    | undefined;
  return row ? rowToInstance(row) : null;
}

/** The single running instance for an issue, or null. */
export function getActiveWorkflowInstance(issueId: string): WorkflowInstance | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM workflow_instances WHERE issue_id = ? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get(issueId) as WorkflowInstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

export function listWorkflowInstancesForIssue(issueId: string): WorkflowInstance[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_instances WHERE issue_id = ? ORDER BY started_at ASC")
    .all(issueId) as WorkflowInstanceRow[];
  return rows.map(rowToInstance);
}

interface WorkflowEventRow {
  id: string;
  issue_id: string;
  workflow_instance_id: string | null;
  worker_session_id: string | null;
  type: string;
  actor_type: string;
  actor_ref: string | null;
  stage: string;
  round: number | null;
  payload_json: string | null;
  artifact_ref: string | null;
  idempotency_key: string | null;
  causation_event_id: string | null;
  ts: string;
}

function rowToEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowInstanceId: row.workflow_instance_id,
    workerSessionId: row.worker_session_id,
    type: row.type as WorkflowEventType,
    actorType: row.actor_type as WorkflowEvent["actorType"],
    actorRef: row.actor_ref,
    stage: row.stage,
    round: row.round,
    payloadJson: row.payload_json,
    artifactRef: row.artifact_ref,
    idempotencyKey: row.idempotency_key,
    causationEventId: row.causation_event_id,
    ts: row.ts,
  };
}

export interface AppendWorkflowEventInput {
  issueId: string;
  workflowInstanceId?: string | null;
  workerSessionId?: string | null;
  type: WorkflowEventType;
  actorType: WorkflowEvent["actorType"];
  actorRef?: string | null;
  stage: string;
  round?: number | null;
  payload?: unknown;
  artifactRef?: string | null;
  idempotencyKey?: string | null;
  causationEventId?: string | null;
}

export function appendWorkflowEvent(input: AppendWorkflowEventInput): WorkflowEvent {
  const db = getDb();
  const row: WorkflowEventRow = {
    id: uuid(),
    issue_id: input.issueId,
    workflow_instance_id: input.workflowInstanceId ?? null,
    worker_session_id: input.workerSessionId ?? null,
    type: input.type,
    actor_type: input.actorType,
    actor_ref: input.actorRef ?? null,
    stage: input.stage,
    round: input.round ?? null,
    payload_json: input.payload !== undefined ? JSON.stringify(input.payload) : null,
    artifact_ref: input.artifactRef ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    causation_event_id: input.causationEventId ?? null,
    ts: new Date().toISOString(),
  };
  // Idempotent on the provider-native key: a repeated delivery is a no-op that returns
  // the event already recorded for that key, not a duplicate row (PRD §9.3).
  const info = db
    .prepare(`
      INSERT INTO workflow_events (
        id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
        stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
      ) VALUES (
        @id, @issue_id, @workflow_instance_id, @worker_session_id, @type, @actor_type, @actor_ref,
        @stage, @round, @payload_json, @artifact_ref, @idempotency_key, @causation_event_id, @ts
      )
      ON CONFLICT DO NOTHING
    `)
    .run(row);

  if (info.changes === 0 && input.idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM workflow_events WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as WorkflowEventRow;
    return rowToEvent(existing);
  }
  return rowToEvent(row);
}

export function listWorkflowEventsForIssue(issueId: string): WorkflowEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_events WHERE issue_id = ? ORDER BY ts ASC")
    .all(issueId) as WorkflowEventRow[];
  return rows.map(rowToEvent);
}

/**
 * `guidance.added` markdown for an issue, added after `sinceTs` (exclusive) — the raw
 * material for NOT-64's guidance injection. `sinceTs` is null for an issue's very first
 * session (nothing has been shown yet, so every guidance event so far applies).
 */
export function listGuidanceMarkdownForIssue(issueId: string, sinceTs: string | null): string[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM workflow_events WHERE issue_id = ? AND type = 'guidance.added' AND ts > ? ORDER BY ts ASC"
    )
    .all(issueId, sinceTs ?? "") as WorkflowEventRow[];
  return rows
    .map((row) => {
      try {
        return (JSON.parse(row.payload_json ?? "{}") as { markdown?: string }).markdown ?? null;
      } catch {
        return null;
      }
    })
    .filter((m): m is string => !!m);
}

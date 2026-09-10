import type { WorkflowEvent, WorkflowEventType, WorkflowInstance, WorkflowInstanceOutcome } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

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

/** Throws (via the unique partial index) if an active instance already exists for this issue. */
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
  db.prepare(`
    INSERT INTO workflow_instances (id, issue_id, workflow_version, started_at, completed_at, outcome)
    VALUES (@id, @issue_id, @workflow_version, @started_at, @completed_at, @outcome)
  `).run(row);
  return rowToInstance(row);
}

export function completeWorkflowInstance(id: string, outcome: WorkflowInstanceOutcome): WorkflowInstance {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE workflow_instances SET completed_at = ?, outcome = ? WHERE id = ?")
    .run(now, outcome, id);
  const row = getDb().prepare("SELECT * FROM workflow_instances WHERE id = ?").get(id) as
    | WorkflowInstanceRow
    | undefined;
  if (!row) throw new Error(`Workflow instance vanished: ${id}`);
  return rowToInstance(row);
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
  db.prepare(`
    INSERT INTO workflow_events (
      id, issue_id, workflow_instance_id, worker_session_id, type, actor_type, actor_ref,
      stage, round, payload_json, artifact_ref, idempotency_key, causation_event_id, ts
    ) VALUES (
      @id, @issue_id, @workflow_instance_id, @worker_session_id, @type, @actor_type, @actor_ref,
      @stage, @round, @payload_json, @artifact_ref, @idempotency_key, @causation_event_id, @ts
    )
  `).run(row);
  return rowToEvent(row);
}

export function listWorkflowEventsForIssue(issueId: string): WorkflowEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM workflow_events WHERE issue_id = ? ORDER BY ts ASC")
    .all(issueId) as WorkflowEventRow[];
  return rows.map(rowToEvent);
}

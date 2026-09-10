import type { WorkflowEvent, WorkflowEventType } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

// NOT-58 foundation: `workflow_instances` stays in the schema as a declared contract,
// but nothing starts a workflow yet — the instance lifecycle (start / complete /
// at-most-one-active enforcement) lands with the coordinator kernel in NOT-59.

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

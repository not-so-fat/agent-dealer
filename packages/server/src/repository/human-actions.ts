import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface HumanActionRow {
  id: string;
  issue_id: string;
  workflow_instance_id: string | null;
  action_type: string;
  reason: string;
  question: string;
  evidence_json: string | null;
  response_options_json: string | null;
  continuation_preview_json: string | null;
  request_id: string | null;
  status: string;
  resolution_json: string | null;
  resolved_by: string | null;
  requested_at: string;
  resolved_at: string | null;
}

function rowToAction(row: HumanActionRow): HumanAction {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowInstanceId: row.workflow_instance_id,
    actionType: row.action_type as HumanActionType,
    reason: row.reason,
    question: row.question,
    evidenceJson: row.evidence_json,
    responseOptionsJson: row.response_options_json,
    continuationPreviewJson: row.continuation_preview_json,
    requestId: row.request_id,
    status: row.status as HumanAction["status"],
    resolutionJson: row.resolution_json,
    resolvedBy: row.resolved_by,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

export interface CreateHumanActionInput {
  issueId: string;
  workflowInstanceId?: string | null;
  actionType: HumanActionType;
  reason: string;
  question: string;
  evidence?: unknown;
  responseOptions?: unknown;
  continuationPreview?: unknown;
  /** Deck's correlation id for the INTERACTION_REQUIRED response that raised this
   * action, when Deck supplied one (NOT-93). */
  requestId?: string | null;
}

export function createHumanAction(input: CreateHumanActionInput): HumanAction {
  const db = getDb();
  const now = new Date().toISOString();
  const row: HumanActionRow = {
    id: uuid(),
    issue_id: input.issueId,
    workflow_instance_id: input.workflowInstanceId ?? null,
    action_type: input.actionType,
    reason: input.reason,
    question: input.question,
    evidence_json: input.evidence !== undefined ? JSON.stringify(input.evidence) : null,
    response_options_json:
      input.responseOptions !== undefined ? JSON.stringify(input.responseOptions) : null,
    continuation_preview_json:
      input.continuationPreview !== undefined ? JSON.stringify(input.continuationPreview) : null,
    request_id: input.requestId ?? null,
    status: "open",
    resolution_json: null,
    resolved_by: null,
    requested_at: now,
    resolved_at: null,
  };
  db.prepare(`
    INSERT INTO human_actions (
      id, issue_id, workflow_instance_id, action_type, reason, question, evidence_json,
      response_options_json, continuation_preview_json, request_id, status, resolution_json, resolved_by,
      requested_at, resolved_at
    ) VALUES (
      @id, @issue_id, @workflow_instance_id, @action_type, @reason, @question, @evidence_json,
      @response_options_json, @continuation_preview_json, @request_id, @status, @resolution_json, @resolved_by,
      @requested_at, @resolved_at
    )
  `).run(row);
  return rowToAction(row);
}

export function resolveHumanAction(id: string, resolvedBy: string, resolution: unknown): HumanAction {
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      UPDATE human_actions SET
        status = 'resolved', resolution_json = ?, resolved_by = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'
    `)
    .run(JSON.stringify(resolution), resolvedBy, now, id);
  const row = getDb().prepare("SELECT * FROM human_actions WHERE id = ?").get(id) as
    | HumanActionRow
    | undefined;
  if (!row) throw new Error(`Human action not found: ${id}`);
  if (row.status !== "resolved") throw new Error(`Human action already resolved or missing: ${id}`);
  return rowToAction(row);
}

export function getHumanAction(id: string): HumanAction | null {
  const row = getDb().prepare("SELECT * FROM human_actions WHERE id = ?").get(id) as HumanActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function listOpenHumanActions(): HumanAction[] {
  const rows = getDb()
    .prepare("SELECT * FROM human_actions WHERE status = 'open' ORDER BY requested_at ASC")
    .all() as HumanActionRow[];
  return rows.map(rowToAction);
}

/** The one open action of this type for the issue, if any — used to make re-raising a
 * pre-start action (e.g. product_scope_decision) idempotent instead of piling up
 * duplicates across repeated calls. */
export function findOpenHumanAction(issueId: string, actionType: HumanActionType): HumanAction | null {
  const row = getDb()
    .prepare("SELECT * FROM human_actions WHERE issue_id = ? AND action_type = ? AND status = 'open' ORDER BY requested_at ASC LIMIT 1")
    .get(issueId, actionType) as HumanActionRow | undefined;
  return row ? rowToAction(row) : null;
}

/** Dedupe key for a repeated Deck INTERACTION_REQUIRED signal that names a request id
 * (NOT-93) — a second signal for the same request must land on the one open action it
 * already raised, never a duplicate. Full duplicate-delivery/race-proofing across
 * concurrent writers is NOT-91's job; this is a plain read-then-create check. */
export function findOpenHumanActionByRequestId(
  issueId: string,
  actionType: HumanActionType,
  requestId: string
): HumanAction | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM human_actions WHERE issue_id = ? AND action_type = ? AND request_id = ? AND status = 'open' ORDER BY requested_at ASC LIMIT 1"
    )
    .get(issueId, actionType, requestId) as HumanActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function listHumanActionsForIssue(issueId: string): HumanAction[] {
  const rows = getDb()
    .prepare("SELECT * FROM human_actions WHERE issue_id = ? ORDER BY requested_at ASC")
    .all(issueId) as HumanActionRow[];
  return rows.map(rowToAction);
}

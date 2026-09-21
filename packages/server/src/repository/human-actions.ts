import type { HumanAction, HumanActionType } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

interface HumanActionRow {
  id: string;
  issue_id: string | null;
  run_id: string | null;
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
    runId: row.run_id,
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
  /** Exactly one of issueId/runId must be set — an Issue-scoped action (the coordinator
   * kernel) or a Run-scoped action (outbound-draft delivery parking, NOT-95). */
  issueId?: string;
  runId?: string;
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
  if (Boolean(input.issueId) === Boolean(input.runId)) {
    throw new Error("createHumanAction requires exactly one of issueId or runId");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const row: HumanActionRow = {
    id: uuid(),
    issue_id: input.issueId ?? null,
    run_id: input.runId ?? null,
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
  // ON CONFLICT's target must repeat the partial index's predicate verbatim (schema.sql's
  // idx_human_actions_open_request) — a bare `ON CONFLICT (issue_id, action_type,
  // request_id)` throws SQLITE_ERROR against a partial unique index. A request_id-less
  // insert (the vast majority of action types) never matches this partial index at all, so
  // it always proceeds as a plain insert.
  const info = db.prepare(`
    INSERT INTO human_actions (
      id, issue_id, run_id, workflow_instance_id, action_type, reason, question, evidence_json,
      response_options_json, continuation_preview_json, request_id, status, resolution_json, resolved_by,
      requested_at, resolved_at
    ) VALUES (
      @id, @issue_id, @run_id, @workflow_instance_id, @action_type, @reason, @question, @evidence_json,
      @response_options_json, @continuation_preview_json, @request_id, @status, @resolution_json, @resolved_by,
      @requested_at, @resolved_at
    )
    ON CONFLICT (issue_id, action_type, request_id) WHERE status = 'open' AND request_id IS NOT NULL DO NOTHING
  `).run(row);

  if (info.changes === 0 && input.requestId && input.issueId) {
    // Lost the race to dedupe onto an already-open action for this exact request — return
    // the winner, never a phantom row this insert never actually created. (The partial
    // index's NULL-issue_id rows — Run-scoped actions — never collide with each other at
    // all under standard SQL NULL semantics, so this race is only reachable Issue-scoped.)
    const existing = findOpenHumanActionByRequestId(input.issueId, input.actionType, input.requestId);
    if (existing) return existing;
  }
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
 * already raised, never a duplicate. Callers (reflect-trigger.ts, commands.ts) still read
 * this first to decide whether to raise at all; the actual race-proofing against a
 * concurrent duplicate insert is `createHumanAction`'s own `ON CONFLICT ... DO NOTHING`
 * against `idx_human_actions_open_request` (NOT-91) — this function alone is not atomic. */
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

/**
 * NOT-221: refresh an open action's operator-facing text after a failed lease push —
 * the action stays open (nothing resolved) but must show the freshly observed remote
 * tip instead of the stale pin. Only touches open rows; returns null when the action is
 * already resolved or missing so the caller never rewrites history.
 */
export function updateOpenHumanAction(
  id: string,
  patch: { reason?: string; question?: string; evidence?: unknown }
): HumanAction | null {
  const current = getHumanAction(id);
  if (!current || current.status !== "open") return null;
  getDb()
    .prepare(
      `UPDATE human_actions SET
        reason = COALESCE(?, reason),
        question = COALESCE(?, question),
        evidence_json = COALESCE(?, evidence_json)
      WHERE id = ? AND status = 'open'`
    )
    .run(
      patch.reason ?? null,
      patch.question ?? null,
      patch.evidence !== undefined ? JSON.stringify(patch.evidence) : null,
      id
    );
  return getHumanAction(id);
}

/** Run-scoped equivalent of `findOpenHumanAction` (NOT-95 — outbound-draft delivery
 * parking has no Issue). */
export function findOpenHumanActionForRun(runId: string, actionType: HumanActionType): HumanAction | null {
  const row = getDb()
    .prepare("SELECT * FROM human_actions WHERE run_id = ? AND action_type = ? AND status = 'open' ORDER BY requested_at ASC LIMIT 1")
    .get(runId, actionType) as HumanActionRow | undefined;
  return row ? rowToAction(row) : null;
}

/** Run-scoped equivalent of `listHumanActionsForIssue` (NOT-95). */
export function listHumanActionsForRun(runId: string): HumanAction[] {
  const rows = getDb()
    .prepare("SELECT * FROM human_actions WHERE run_id = ? ORDER BY requested_at ASC")
    .all(runId) as HumanActionRow[];
  return rows.map(rowToAction);
}

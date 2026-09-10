// packages/server/src/repository/work-items.ts
//
// The coordinator kernel's durable work-item / outbox (NOT-59). A coordinator command
// enqueues exactly one next work item in the same transaction as its state transition and
// workflow event; a leased effect worker claims it (CAS), refreshes a heartbeat, and its
// structured completion is applied in a second transaction. Lease expiry, attempt count,
// backoff, idempotency key and dead-lettering all live here — not on `worker_sessions`.
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

export type WorkItemKind = "developer" | "reviewer";
export type WorkItemStatus = "pending" | "leased" | "done" | "failed" | "dead";

export interface WorkItem {
  id: string;
  issueId: string;
  workflowInstanceId: string;
  workerSessionId: string | null;
  kind: WorkItemKind;
  round: number;
  payloadJson: string | null;
  status: WorkItemStatus;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  availableAt: string;
  idempotencyKey: string | null;
  resultJson: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkItemRow {
  id: string;
  issue_id: string;
  workflow_instance_id: string;
  worker_session_id: string | null;
  kind: string;
  round: number;
  payload_json: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  available_at: string;
  idempotency_key: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    issueId: row.issue_id,
    workflowInstanceId: row.workflow_instance_id,
    workerSessionId: row.worker_session_id,
    kind: row.kind as WorkItemKind,
    round: row.round,
    payloadJson: row.payload_json,
    status: row.status as WorkItemStatus,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    availableAt: row.available_at,
    idempotencyKey: row.idempotency_key,
    resultJson: row.result_json,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EnqueueWorkItemInput {
  issueId: string;
  workflowInstanceId: string;
  kind: WorkItemKind;
  round: number;
  payload?: unknown;
  /** Provider/transition-native key — a retried enqueue for the same key is a no-op. */
  idempotencyKey?: string | null;
  maxAttempts?: number;
}

/**
 * Enqueues a work item, idempotent on `idempotencyKey`: a retried callback, poll, or
 * restart that re-enqueues the same next effect returns the existing row instead of
 * creating a duplicate. The `idx_work_items_one_active` partial unique index additionally
 * rejects a second non-terminal item for the same workflow instance.
 */
export function enqueueWorkItem(input: EnqueueWorkItemInput): WorkItem {
  const db = getDb();
  const now = new Date().toISOString();
  const row: WorkItemRow = {
    id: uuid(),
    issue_id: input.issueId,
    workflow_instance_id: input.workflowInstanceId,
    worker_session_id: null,
    kind: input.kind,
    round: input.round,
    payload_json: input.payload !== undefined ? JSON.stringify(input.payload) : null,
    status: "pending",
    attempt_count: 0,
    max_attempts: input.maxAttempts ?? 3,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    available_at: now,
    idempotency_key: input.idempotencyKey ?? null,
    result_json: null,
    error_json: null,
    created_at: now,
    updated_at: now,
  };
  const info = db
    .prepare(`
      INSERT INTO work_items (
        id, issue_id, workflow_instance_id, worker_session_id, kind, round, payload_json,
        status, attempt_count, max_attempts, lease_owner, lease_expires_at, heartbeat_at,
        available_at, idempotency_key, result_json, error_json, created_at, updated_at
      ) VALUES (
        @id, @issue_id, @workflow_instance_id, @worker_session_id, @kind, @round, @payload_json,
        @status, @attempt_count, @max_attempts, @lease_owner, @lease_expires_at, @heartbeat_at,
        @available_at, @idempotency_key, @result_json, @error_json, @created_at, @updated_at
      )
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    `)
    .run(row);

  if (info.changes === 0 && input.idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM work_items WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as WorkItemRow;
    return rowToWorkItem(existing);
  }
  return rowToWorkItem(row);
}

export function getWorkItem(id: string): WorkItem | null {
  const row = getDb().prepare("SELECT * FROM work_items WHERE id = ?").get(id) as
    | WorkItemRow
    | undefined;
  return row ? rowToWorkItem(row) : null;
}

export function listWorkItemsForIssue(issueId: string): WorkItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM work_items WHERE issue_id = ? ORDER BY created_at ASC")
    .all(issueId) as WorkItemRow[];
  return rows.map(rowToWorkItem);
}

export interface ClaimOpts {
  leaseMs: number;
}

/**
 * Compare-and-set claim of the oldest claimable work item: `pending` and past its backoff
 * gate. Two concurrent dispatchers racing the same row: only the `WHERE ... status =
 * 'pending'` guard that wins flips it, so a work item is never run twice. Bumps
 * `attempt_count` at claim time so an expired lease costs an attempt like any failure.
 */
export function claimWorkItem(leaseOwner: string, opts: ClaimOpts): WorkItem | null {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresIso = new Date(now + opts.leaseMs).toISOString();
  const row = getDb()
    .prepare(`
      UPDATE work_items SET
        status = 'leased',
        lease_owner = @lease_owner,
        lease_expires_at = @expires,
        heartbeat_at = @now,
        attempt_count = attempt_count + 1,
        updated_at = @now
      WHERE id = (
        SELECT id FROM work_items
        WHERE status = 'pending' AND available_at <= @now
        ORDER BY created_at ASC
        LIMIT 1
      ) AND status = 'pending'
      RETURNING *
    `)
    .get({ lease_owner: leaseOwner, expires: expiresIso, now: nowIso }) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

/** Records the effect worker's session on the work item before it starts running. */
export function bindWorkItemSession(id: string, workerSessionId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE work_items SET worker_session_id = ?, updated_at = ? WHERE id = ?")
    .run(workerSessionId, now, id);
}

/** Extends the lease. Returns false if this owner no longer holds it (reclaimed/expired). */
export function refreshHeartbeat(id: string, leaseOwner: string, opts: ClaimOpts): boolean {
  const now = Date.now();
  const info = getDb()
    .prepare(`
      UPDATE work_items SET heartbeat_at = @now, lease_expires_at = @expires, updated_at = @now
      WHERE id = @id AND status = 'leased' AND lease_owner = @owner
    `)
    .run({
      id,
      owner: leaseOwner,
      now: new Date(now).toISOString(),
      expires: new Date(now + opts.leaseMs).toISOString(),
    });
  return info.changes > 0;
}

/**
 * Terminal success. Only a still-`leased` item is completed: an item reclaimed after a
 * lease expiry (now `pending` or re-run by another worker) is left alone, so a late
 * completion from a stale worker is a no-op. Returns the completed item, or null.
 */
export function completeWorkItem(id: string, result: unknown): WorkItem | null {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      "UPDATE work_items SET status = 'done', result_json = ?, updated_at = ? WHERE id = ? AND status = 'leased'"
    )
    .run(JSON.stringify(result), now, id);
  if (info.changes === 0) return null;
  return getWorkItem(id);
}

export interface FailOpts {
  backoffMs: number;
}

export interface FailResult {
  dead: boolean;
  item: WorkItem;
}

/**
 * A failed effect. If the attempt cap is reached the item is dead-lettered (`dead`);
 * otherwise it returns to `pending` behind a backoff gate for another attempt. Expired
 * leases route through the same policy (see reclaimExpiredWorkItems).
 */
export function failWorkItem(id: string, error: unknown, opts: FailOpts): FailResult {
  const item = getWorkItem(id);
  if (!item) throw new Error(`Work item not found: ${id}`);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const dead = item.attemptCount >= item.maxAttempts;
  getDb()
    .prepare(`
      UPDATE work_items SET
        status = @status,
        error_json = @error,
        available_at = @available_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = @now
      WHERE id = @id
    `)
    .run({
      id,
      status: dead ? "dead" : "pending",
      error: JSON.stringify(error),
      available_at: dead ? item.availableAt : new Date(now + opts.backoffMs).toISOString(),
      now: nowIso,
    });
  return { dead, item: getWorkItem(id)! };
}

export interface ReclaimOpts {
  /** Startup recovery: every `leased` row is orphaned (its worker died with the process). */
  includeAllLeased?: boolean;
}

export interface ReclaimResult {
  /** Requeued for another attempt. */
  reclaimed: WorkItem[];
  /** Attempt cap reached — the coordinator must route these to a human action. */
  deadLettered: WorkItem[];
}

/**
 * Reclaims leased work whose worker is gone: on the periodic tick, items past
 * `lease_expires_at`; on startup (`includeAllLeased`), every leased item. Each reclaimed
 * item follows the same bounded retry/escalation policy as an ordinary failure — past the
 * attempt cap it is dead-lettered, otherwise requeued.
 */
export function reclaimExpiredWorkItems(nowMs: number, opts: ReclaimOpts = {}): ReclaimResult {
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();
  const rows = db
    .prepare(
      opts.includeAllLeased
        ? "SELECT * FROM work_items WHERE status = 'leased'"
        : "SELECT * FROM work_items WHERE status = 'leased' AND lease_expires_at < ?"
    )
    .all(...(opts.includeAllLeased ? [] : [nowIso])) as WorkItemRow[];

  const reclaimed: WorkItem[] = [];
  const deadLettered: WorkItem[] = [];
  for (const row of rows) {
    const item = rowToWorkItem(row);
    const dead = item.attemptCount >= item.maxAttempts;
    db.prepare(`
      UPDATE work_items SET
        status = @status,
        lease_owner = NULL,
        lease_expires_at = NULL,
        error_json = @error,
        updated_at = @now
      WHERE id = @id AND status = 'leased'
    `).run({
      id: item.id,
      status: dead ? "dead" : "pending",
      error: JSON.stringify({ reason: "lease expired — worker presumed dead" }),
      now: nowIso,
    });
    (dead ? deadLettered : reclaimed).push(getWorkItem(item.id)!);
  }
  return { reclaimed, deadLettered };
}

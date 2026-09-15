// packages/server/src/repository/work-items.ts
//
// The coordinator kernel's durable work-item / outbox (NOT-59). A coordinator command
// enqueues exactly one next work item in the same transaction as its state transition and
// workflow event; a leased effect worker claims it, refreshes a heartbeat, and its
// structured completion is applied in a second transaction. Lease expiry, attempt count,
// backoff, idempotency key and dead-lettering all live here — not on `worker_sessions`.
//
// Every mutation a leased worker makes is fenced on `lease_token`: a token is minted on
// each claim/reclaim, so a slow attempt A that resumes after its lease was reclaimed and
// re-leased to attempt B can neither commit stale output nor clear B's live lease — its
// CAS simply matches zero rows.
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";

export type WorkItemKind = "developer" | "reviewer";
export type WorkItemStatus = "pending" | "leased" | "done" | "dead" | "cancelled";

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
  /** Fencing token for the current lease; null unless `status = 'leased'`. */
  leaseToken: string | null;
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
  lease_token: string | null;
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
    leaseToken: row.lease_token,
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

/** The attempt cap is reached — the next failure/expiry must dead-letter, not retry. */
export function attemptCapReached(item: WorkItem): boolean {
  return item.attemptCount >= item.maxAttempts;
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
    lease_token: null,
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
        status, attempt_count, max_attempts, lease_owner, lease_token, lease_expires_at,
        heartbeat_at, available_at, idempotency_key, result_json, error_json, created_at, updated_at
      ) VALUES (
        @id, @issue_id, @workflow_instance_id, @worker_session_id, @kind, @round, @payload_json,
        @status, @attempt_count, @max_attempts, @lease_owner, @lease_token, @lease_expires_at,
        @heartbeat_at, @available_at, @idempotency_key, @result_json, @error_json, @created_at, @updated_at
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
 * `attempt_count` at claim time so an expired lease costs an attempt like any failure, and
 * mints a fresh `lease_token` that every later mutation by this attempt must present.
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
        lease_token = @lease_token,
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
    .get({ lease_owner: leaseOwner, lease_token: uuid(), expires: expiresIso, now: nowIso }) as
    | WorkItemRow
    | undefined;
  return row ? rowToWorkItem(row) : null;
}

/**
 * Binds the effect worker's session to the item, fenced on the lease token, inside the
 * same transaction that creates and starts the session. Returns false when this attempt no
 * longer holds the lease — the caller must roll the session creation back rather than
 * overwrite a newer attempt's binding.
 */
export function bindWorkItemSession(
  id: string,
  workerSessionId: string,
  leaseToken: string
): boolean {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      "UPDATE work_items SET worker_session_id = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND lease_token = ?"
    )
    .run(workerSessionId, now, id, leaseToken);
  return info.changes > 0;
}

/** Extends the lease. Returns false if this token no longer holds it (reclaimed/expired). */
export function refreshHeartbeat(id: string, leaseToken: string, opts: ClaimOpts): boolean {
  const now = Date.now();
  const info = getDb()
    .prepare(`
      UPDATE work_items SET heartbeat_at = @now, lease_expires_at = @expires, updated_at = @now
      WHERE id = @id AND status = 'leased' AND lease_token = @token
    `)
    .run({
      id,
      token: leaseToken,
      now: new Date(now).toISOString(),
      expires: new Date(now + opts.leaseMs).toISOString(),
    });
  return info.changes > 0;
}

export interface FinishInput {
  status: "done" | "dead";
  result?: unknown;
  error?: unknown;
  /**
   * Recovery guard: also require `lease_expires_at < this ISO time`. A heartbeat that
   * renewed the lease after recovery snapshotted the item pushes the expiry past this
   * cutoff, so the CAS matches nothing and the now-healthy attempt is left alone.
   */
  onlyIfExpiredBefore?: string;
}

/**
 * Compare-and-set a leased item to a terminal state, fenced on the lease token. Returns
 * the updated item, or null when this attempt no longer holds the lease (reclaimed, a peer
 * already finished it, or — with `onlyIfExpiredBefore` — the lease was renewed). This is
 * the ONLY path to `done`/`dead`, so a duplicate completion or a recovery race can never
 * re-advance the workflow.
 */
export function finishWorkItem(
  id: string,
  leaseToken: string,
  input: FinishInput
): WorkItem | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(`
      UPDATE work_items SET
        status = @status,
        result_json = @result,
        error_json = @error,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = @now
      WHERE id = @id AND status = 'leased' AND lease_token = @token
        AND (@expired_before IS NULL OR lease_expires_at < @expired_before)
      RETURNING *
    `)
    .get({
      id,
      token: leaseToken,
      status: input.status,
      result: input.result !== undefined ? JSON.stringify(input.result) : null,
      error: input.error !== undefined ? JSON.stringify(input.error) : null,
      expired_before: input.onlyIfExpiredBefore ?? null,
      now,
    }) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

export interface RequeueOpts {
  backoffMs: number;
  /** Recovery guard — see FinishInput.onlyIfExpiredBefore. */
  onlyIfExpiredBefore?: string;
}

export interface DeferWorkItemOpts {
  availableAt: string;
  error: unknown;
  /** Undo the claim-time attempt_count bump — usage-cap deferral must not spend attempts. */
  revertAttemptCount?: boolean;
  payloadJson?: string;
  /** Recovery guard — see FinishInput.onlyIfExpiredBefore. */
  onlyIfExpiredBefore?: string;
}

/**
 * Returns a leased item to `pending` behind a usage-cap gate, optionally undoing the claim
 * attempt_count bump. Fenced on the lease token like requeueWorkItem, and optionally on
 * `lease_expires_at` for recovery's stale-lease reclaim.
 */
export function deferWorkItem(
  id: string,
  leaseToken: string,
  opts: DeferWorkItemOpts
): WorkItem | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(`
      UPDATE work_items SET
        status = 'pending',
        error_json = @error,
        available_at = @available_at,
        attempt_count = CASE WHEN @revert = 1 THEN MAX(0, attempt_count - 1) ELSE attempt_count END,
        payload_json = COALESCE(@payload_json, payload_json),
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = @now
      WHERE id = @id AND status = 'leased' AND lease_token = @token
        AND (@expired_before IS NULL OR lease_expires_at < @expired_before)
      RETURNING *
    `)
    .get({
      id,
      token: leaseToken,
      error: JSON.stringify(opts.error),
      available_at: opts.availableAt,
      revert: opts.revertAttemptCount ? 1 : 0,
      payload_json: opts.payloadJson ?? null,
      expired_before: opts.onlyIfExpiredBefore ?? null,
      now,
    }) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

/**
 * Returns a leased item to `pending` behind a backoff gate for another attempt, fenced on
 * the lease token. Returns false when the token no longer holds the lease (a concurrent
 * completion won, or the lease was renewed). Same backoff policy as a reclaimed expiry.
 */
export function requeueWorkItem(
  id: string,
  leaseToken: string,
  error: unknown,
  opts: RequeueOpts
): boolean {
  const now = Date.now();
  const info = getDb()
    .prepare(`
      UPDATE work_items SET
        status = 'pending',
        error_json = @error,
        available_at = @available_at,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = @now
      WHERE id = @id AND status = 'leased' AND lease_token = @token
        AND (@expired_before IS NULL OR lease_expires_at < @expired_before)
    `)
    .run({
      id,
      token: leaseToken,
      error: JSON.stringify(error),
      available_at: new Date(now + opts.backoffMs).toISOString(),
      expired_before: opts.onlyIfExpiredBefore ?? null,
      now: new Date(now).toISOString(),
    });
  return info.changes > 0;
}

/**
 * Force-terminalizes a still-in-flight item to `cancelled` (issue abort, NOT-83) —
 * deliberately NOT lease-token-fenced, unlike every other terminal transition in this
 * file: an abort is an operator override of whatever attempt currently holds the lease,
 * not a completion by that attempt. Once `status` flips, the in-flight attempt's own
 * token-fenced `finishWorkItem`/`refreshHeartbeat` calls stop matching (`WHERE status =
 * 'leased' AND lease_token = ?`) on their own, so no other write path needs to change.
 */
export function cancelWorkItem(id: string): WorkItem | null {
  const now = new Date().toISOString();
  const row = getDb()
    .prepare(`
      UPDATE work_items SET
        status = 'cancelled',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = @now
      WHERE id = @id AND status IN ('pending', 'leased')
      RETURNING *
    `)
    .get({ id, now }) as WorkItemRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

/**
 * Leased items whose lease has expired (no heartbeat for `leaseMs`). Read-only — the
 * caller reclaims each one with a token-fenced, `onlyIfExpiredBefore`-guarded
 * `requeueWorkItem` / `finishWorkItem` inside a transaction, so a worker that heartbeats or
 * completes concurrently with recovery still keeps/wins its lease.
 */
export function listExpiredLeases(nowMs: number): WorkItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM work_items WHERE status = 'leased' AND lease_expires_at < ?")
    .all(new Date(nowMs).toISOString()) as WorkItemRow[];
  return rows.map(rowToWorkItem);
}

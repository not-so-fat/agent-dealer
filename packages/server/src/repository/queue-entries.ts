// packages/server/src/repository/queue-entries.ts
//
// NOT-103: durable operator-owned issue admission queue (order + wait_reason).

import type { QueueEntry, QueueEntryState } from "@agent-dealer/shared";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { getActiveWorkflowInstance } from "./workflow-events.js";
import { getIssue } from "./issues.js";

export type QueueEntryView = QueueEntry & {
  title?: string | null;
  issueStatus?: string | null;
};

interface QueueEntryRow {
  id: string;
  issue_id: string;
  position: number;
  enqueued_at: string;
  state: string;
  wait_reason: string | null;
  wait_reason_at: string | null;
  issue_title?: string | null;
  issue_status?: string | null;
}

function rowToEntry(row: QueueEntryRow): QueueEntryView {
  return {
    id: row.id,
    issueId: row.issue_id,
    position: row.position,
    enqueuedAt: row.enqueued_at,
    state: row.state as QueueEntryState,
    waitReason: row.wait_reason,
    waitReasonAt: row.wait_reason_at,
    ...(row.issue_title !== undefined
      ? { title: row.issue_title ?? null, issueStatus: row.issue_status ?? null }
      : {}),
  };
}

export function getQueueEntry(id: string): QueueEntry | null {
  const row = getDb().prepare("SELECT * FROM queue_entries WHERE id = ?").get(id) as
    | QueueEntryRow
    | undefined;
  return row ? rowToEntry(row) : null;
}

export function getQueuedEntryForIssue(issueId: string): QueueEntry | null {
  const row = getDb()
    .prepare("SELECT * FROM queue_entries WHERE issue_id = ? AND state = 'queued'")
    .get(issueId) as QueueEntryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/** Ordered live queue (state=queued only), with issue title/status for display. */
export function listQueuedEntries(): QueueEntryView[] {
  const rows = getDb()
    .prepare(
      `
      SELECT q.*, i.title AS issue_title, i.status AS issue_status
      FROM queue_entries q
      LEFT JOIN issues i ON i.id = q.issue_id
      WHERE q.state = 'queued'
      ORDER BY q.position ASC, q.enqueued_at ASC
    `
    )
    .all() as QueueEntryRow[];
  return rows.map(rowToEntry);
}

/**
 * Append at the end. Rejects terminal issues, active workflows, and duplicate queued rows.
 * Partial unique index: ON CONFLICT must repeat the WHERE predicate.
 */
export function enqueueIssue(issueId: string): QueueEntry {
  const issue = getIssue(issueId);
  if (!issue) throw Object.assign(new Error("Issue not found"), { code: 404 });
  if (issue.status === "done" || issue.status === "closed") {
    throw Object.assign(new Error(`Issue is ${issue.status} — cannot enqueue`), { code: 409 });
  }
  if (getActiveWorkflowInstance(issueId)) {
    throw Object.assign(new Error("Issue already has an active workflow — cannot enqueue"), {
      code: 409,
    });
  }
  const existing = getQueuedEntryForIssue(issueId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const maxPos = getDb()
    .prepare("SELECT COALESCE(MAX(position), 0) AS m FROM queue_entries WHERE state = 'queued'")
    .get() as { m: number };
  const id = uuid();
  const position = maxPos.m + 1;
  // Partial unique index requires the WHERE predicate on ON CONFLICT (SQLite).
  const info = getDb()
    .prepare(
      `
      INSERT INTO queue_entries (id, issue_id, position, enqueued_at, state, wait_reason, wait_reason_at)
      VALUES (?, ?, ?, ?, 'queued', NULL, NULL)
      ON CONFLICT(issue_id) WHERE state = 'queued' DO NOTHING
    `
    )
    .run(id, issueId, position, now);
  if (info.changes === 0) {
    const raced = getQueuedEntryForIssue(issueId);
    if (raced) return raced;
    throw new Error("enqueue failed without creating a row");
  }
  return getQueueEntry(id)!;
}

/** Operator dequeue — marks removed (keeps history row). Returns the removed entry or null. */
export function dequeueIssue(issueId: string): QueueEntry | null {
  const entry = getQueuedEntryForIssue(issueId);
  if (!entry) return null;
  getDb()
    .prepare(
      "UPDATE queue_entries SET state = 'removed', wait_reason = NULL, wait_reason_at = NULL WHERE id = ?"
    )
    .run(entry.id);
  return getQueueEntry(entry.id);
}

/** Force-admit / successful admit — no-op when not queued. */
export function markQueueEntryAdmitted(issueId: string): QueueEntry | null {
  const entry = getQueuedEntryForIssue(issueId);
  if (!entry) return null;
  getDb()
    .prepare(
      `
      UPDATE queue_entries
      SET state = 'admitted', wait_reason = NULL, wait_reason_at = NULL
      WHERE issue_id = ? AND state = 'queued'
    `
    )
    .run(issueId);
  return getQueueEntry(entry.id);
}

/** Issue closed / done while still queued. */
export function markQueueEntryRemoved(issueId: string): void {
  getDb()
    .prepare("UPDATE queue_entries SET state = 'removed' WHERE issue_id = ? AND state = 'queued'")
    .run(issueId);
}

/**
 * Persist wait_reason only when it changes (avoids write churn every coordinator tick).
 * Returns true when a write occurred.
 */
export function setQueueWaitReason(entryId: string, reason: string | null): boolean {
  const row = getDb()
    .prepare("SELECT wait_reason FROM queue_entries WHERE id = ? AND state = 'queued'")
    .get(entryId) as { wait_reason: string | null } | undefined;
  if (!row) return false;
  if (row.wait_reason === reason) return false;
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE queue_entries SET wait_reason = ?, wait_reason_at = ? WHERE id = ?")
    .run(reason, reason !== null ? now : null, entryId);
  return true;
}

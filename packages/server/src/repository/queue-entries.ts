// packages/server/src/repository/queue-entries.ts
//
// NOT-103: durable operator-owned issue admission queue (order + wait_reason).

import type { QueueEntry, QueueEntryState, QueueMoveTarget } from "@agent-dealer/shared";
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

/** `created: false` means the issue was already queued and this call changed nothing. */
export type EnqueueOutcome = { entry: QueueEntry; created: boolean };

/**
 * Append at the end. Rejects terminal issues, active workflows, and duplicate queued rows.
 * Partial unique index: ON CONFLICT must repeat the WHERE predicate.
 */
export function enqueueIssue(issueId: string): QueueEntry {
  return enqueueIssueWithOutcome(issueId).entry;
}

/**
 * The same append, reporting whether it actually wrote a row. Enqueue is idempotent, so the
 * caller cannot infer a mutation from a returned entry — a re-import of an already-queued
 * issue gets the same `QueueEntry` back with nothing changed. Callers that *report* to a
 * human (NOT-141: `POST /api/issues`, and the CLI hint it feeds) must use this one, or they
 * announce a queue action that did not happen.
 */
export function enqueueIssueWithOutcome(issueId: string): EnqueueOutcome {
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
  if (existing) return { entry: existing, created: false };

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
    if (raced) return { entry: raced, created: false };
    throw new Error("enqueue failed without creating a row");
  }
  return { entry: getQueueEntry(id)!, created: true };
}

/**
 * Single position-computation path: write 1-based ranks for the given order.
 * Callers must already hold a DB transaction when they need atomic reorder + lookup.
 */
function applyQueuedOrder(ordered: QueueEntry[]): void {
  const setPosition = getDb().prepare("UPDATE queue_entries SET position = ? WHERE id = ?");
  ordered.forEach((entry, index) => setPosition.run(index + 1, entry.id));
}

function buildOrderAfterMove(
  entry: QueueEntry,
  without: QueueEntry[],
  to: QueueMoveTarget
): QueueEntry[] {
  if (to === "top") return [entry, ...without];
  if (to === "bottom") return [...without, entry];
  if ("before" in to) {
    const idx = without.findIndex((e) => e.issueId === to.before);
    if (idx < 0) {
      throw Object.assign(new Error("Reference issue is not in the queue"), { code: 409 });
    }
    return [...without.slice(0, idx), entry, ...without.slice(idx)];
  }
  const idx = without.findIndex((e) => e.issueId === to.after);
  if (idx < 0) {
    throw Object.assign(new Error("Reference issue is not in the queue"), { code: 409 });
  }
  return [...without.slice(0, idx + 1), entry, ...without.slice(idx + 1)];
}

/**
 * NOT-112: move a queued entry relative to the live queue (top / bottom / before / after).
 * Only `queued` entries are orderable. Throws `{ code: 404 }` when the issue is not queued
 * (missing or already admitted) and `{ code: 409 }` when a relative reference is gone.
 */
export function moveQueueEntry(issueId: string, to: QueueMoveTarget): QueueEntry {
  const db = getDb();
  return db.transaction(() => {
    const entry = getQueuedEntryForIssue(issueId);
    if (!entry) {
      throw Object.assign(new Error("Issue is not in the queue"), { code: 404 });
    }
    const without = listQueuedEntries().filter((e) => e.issueId !== issueId);
    applyQueuedOrder(buildOrderAfterMove(entry, without, to));
    return getQueueEntry(entry.id)!;
  })();
}

/**
 * NOT-118 Start: move to front. Thin wrapper over the shared renumber path — returns null
 * when the issue is not queued (Start's enqueue step normally prevents that).
 */
export function moveQueueEntryToTop(issueId: string): QueueEntry | null {
  try {
    return moveQueueEntry(issueId, "top");
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
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

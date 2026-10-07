// packages/server/src/coordinator/delete-issue.ts
//
// NOT-365: Dealer-local hard delete — the destructive counterpart to Close issue
// (NOT-239) and Abort workflow. Close retains history/evidence as `closed` work;
// Delete permanently removes the local issue row and every issue-scoped row plus
// Dealer-owned blobs/logs, and never touches the linked Linear ticket (this
// module makes no Linear or GitHub call — `source = linear` only changes the
// confirmation copy in the UI).
//
// Eligibility: only `ready`, `done`, or `closed` issues with no active workflow
// instance, no running worker session, no leased/pending work item, no active
// authority attempt, and no session-recorded worktree path that still exists on
// disk. Anything else answers 409 naming the exact blocker and changes nothing.
//
// Deletion itself is one SQLite transaction (foreign keys stay enforced —
// deletes run child-first with the self-referencing `causation_event_id` nulled
// first). Dealer-owned file paths are collected inside that transaction, and
// removed from disk only after the commit: each path is canonicalized and must
// be contained by AGENT_DEALER_HOME, otherwise it is reported as a residual
// path instead of being followed. A cleanup failure never resurrects the row —
// the record deletion still succeeds with explicit `residualPaths`.
import fs from "node:fs";
import path from "node:path";
import { getDb, getDataDir } from "../db/index.js";
import { getIssue } from "../repository/issues.js";
import { getQueuedEntryForIssue } from "../repository/queue-entries.js";
import { getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { getActiveWorkerSessionForIssue } from "../repository/worker-sessions.js";
import { listWorkItemsForIssue } from "../repository/work-items.js";
import { getSourceAttachmentsDir } from "../paths.js";

export type DeleteIssueResult =
  | { ok: true; removedQueueEntry: boolean; residualPaths: string[] }
  | { ok: false; code: number; error: string };

/** Issue-scoped tables the delete transaction must empty — kept in sync with
 * schema.sql plus the incremental tables in db/index.ts migrate(). `issues`
 * itself is deleted last; `review_publications` is reached through its work
 * items (its PK is the work-item id). */
export const ISSUE_SCOPED_TABLES = [
  "issue_source_attachments",
  "artifacts",
  "authority_attempts",
  "failure_causes",
  "session_activity_events",
  "findings",
  "human_actions",
  "queue_entries",
  "review_publications",
  "usage_events",
  "workflow_events",
  "work_items",
  "worker_sessions",
  "workflow_instances",
  "issues",
] as const;

const ACTIVE_AUTHORITY_STATUSES = ["acquiring", "active"];

function countIssueRows(table: string, issueId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE issue_id = ?`)
    .get(issueId) as { n: number };
  return row.n;
}

/** Authority attempts name the issue in their owner key, not an issue_id
 * column: `owner_id` is the issue id itself (reflect) or `${issueId}:${kind}`
 * (developer/reviewer). Issue ids are UUID/hex-shaped — no GLOB metacharacters
 * — so a `GLOB '<id>:*'` suffix match is exact. */
function listActiveAuthorityAttemptsForIssue(issueId: string): Array<{ id: string; status: string }> {
  return getDb()
    .prepare(
      `SELECT id, status FROM authority_attempts
       WHERE status IN ('acquiring', 'active')
         AND (owner_id = ? OR owner_id GLOB (? || ':*'))`
    )
    .all(issueId, issueId) as Array<{ id: string; status: string }>;
}

/** Session-recorded checkout paths that still exist on disk — a live checkout,
 * a leftover a failure preserved, or any other on-disk worktree the delete must
 * not orphan. Existence is checked with lstat semantics (no following): a
 * dangling symlink still names a blocker, and reporting the recorded path never
 * resolves it to somewhere else. */
function existingWorktreePaths(issueId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT worktree_path AS p FROM worker_sessions
       WHERE issue_id = ? AND worktree_path IS NOT NULL AND worktree_path != ''`
    )
    .all(issueId) as Array<{ p: string }>;
  return rows.map((r) => r.p).filter((p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

function guard(issueId: string): string | null {
  const issue = getIssue(issueId);
  if (!issue) return null;
  if (issue.status !== "ready" && issue.status !== "done" && issue.status !== "closed") {
    return (
      `Cannot delete an issue that is ${issue.status} — ` +
      `only ready, done, or closed issues can be deleted from Dealer; ` +
      `close or abort it and let it fully settle first`
    );
  }
  // Leased/pending work before the instance that owns it: when both are live
  // the concrete item (with its lease state) is the more exact blocker.
  const liveItems = listWorkItemsForIssue(issueId).filter(
    (w) => w.status === "pending" || w.status === "leased"
  );
  if (liveItems.length > 0) {
    const kinds = liveItems.map((w) => `${w.status} work item ${w.id}`).join(", ");
    return (
      `Cannot delete issue with ${kinds} — ` +
      `abort the workflow and let it fully settle first`
    );
  }
  const instance = getActiveWorkflowInstance(issueId);
  if (instance) {
    return (
      `Cannot delete issue with an active workflow instance ${instance.id} — ` +
      `abort the workflow and let it fully settle first`
    );
  }
  const running = getActiveWorkerSessionForIssue(issueId);
  if (running) {
    return (
      `Cannot delete issue with a running worker session ${running.id} — ` +
      `abort the workflow and let it fully settle first`
    );
  }
  const authorities = listActiveAuthorityAttemptsForIssue(issueId);
  if (authorities.length > 0) {
    const names = authorities.map((a) => `${a.status} authority attempt ${a.id}`).join(", ");
    return `Cannot delete issue with ${names} — wait for the attempt to settle first`;
  }
  const worktrees = existingWorktreePaths(issueId);
  if (worktrees.length > 0) {
    return (
      `Cannot delete issue with an existing worktree at ${worktrees[0]} — ` +
      `remove the checkout before deleting`
    );
  }
  return null;
}

/** Dealer-owned file paths for the issue, read inside the delete transaction
 * before the rows disappear: source-attachment blobs, artifact blobs, worker
 * session logs, and failure-cause log pointers — plus the issue's own
 * source-attachments directory (retained history per NOT-364, until now). */
function collectDealerPaths(issueId: string): string[] {
  const db = getDb();
  const paths: string[] = [];
  const blobRows = db
    .prepare(`SELECT blob_path AS p FROM issue_source_attachments WHERE issue_id = ? AND blob_path IS NOT NULL`)
    .all(issueId) as Array<{ p: string }>;
  const artifactRows = db
    .prepare(`SELECT blob_path AS p FROM artifacts WHERE issue_id = ? AND blob_path IS NOT NULL`)
    .all(issueId) as Array<{ p: string }>;
  const logRows = db
    .prepare(`SELECT log_path AS p FROM worker_sessions WHERE issue_id = ? AND log_path IS NOT NULL`)
    .all(issueId) as Array<{ p: string }>;
  const failureLogRows = db
    .prepare(`SELECT log_path AS p FROM failure_causes WHERE issue_id = ? AND log_path IS NOT NULL`)
    .all(issueId) as Array<{ p: string }>;
  for (const row of [...blobRows, ...artifactRows, ...logRows, ...failureLogRows]) {
    if (row.p) paths.push(row.p);
  }
  paths.push(path.join(getSourceAttachmentsDir(), issueId));
  return [...new Set(paths)];
}

/** Remove one collected path after the commit. Canonicalizes (resolving
 * symlinks) and removes only paths contained by AGENT_DEALER_HOME; anything
 * else — `..` escapes, absolute paths elsewhere, symlinks pointing out — is
 * left untouched and returned as a residual. Returns the residual path, or null
 * when removed (or already gone). */
export function removeDealerPathContained(rawPath: string, homeDir: string): string | null {
  let resolved: string;
  try {
    // realpath resolves symlinks AND `..`: a live in-home symlink pointing
    // outside resolves outside and is refused below, never followed.
    resolved = fs.realpathSync(rawPath);
    // Canonicalize the home root as well: on macOS the temp dir (and a
    // custom AGENT_DEALER_HOME under it) resolves through a
    // `/var -> /private/var` symlink, so comparing a realpath'd candidate
    // against an unresolved home would misread owned files as outside.
    let home: string;
    try {
      home = fs.realpathSync(homeDir);
    } catch {
      home = path.resolve(homeDir);
    }
    if (resolved !== home && !resolved.startsWith(home + path.sep)) {
      return rawPath;
    }
  } catch {
    // Nothing exists at (part of) this path — judge it purely lexically
    // against the unresolved home, which resolve() can compare without
    // seeing through symlinks. A `..` escape that was never created still
    // reads as outside; a never-created in-root path (e.g. an issue's
    // source-attachment dir with no attachments) is already clean.
    resolved = path.resolve(rawPath);
    const homeLexical = path.resolve(homeDir);
    if (resolved !== homeLexical && !resolved.startsWith(homeLexical + path.sep)) {
      return rawPath;
    }
    return null;
  }
  // Already gone is already clean — only real removals and real failures report.
  try {
    const st = fs.lstatSync(resolved);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.rmSync(resolved, { force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return rawPath;
  }
  return null;
}

/**
 * NOT-365: hard-delete an eligible Dealer-local issue. Makes no Linear or
 * GitHub call — the linked source ticket is untouched by construction.
 *
 * Guard failures answer 409 with the exact blocker and change no row or file.
 * The row deletion is one transaction; file cleanup runs after the commit and
 * reports anything it could not (or would not) remove as `residualPaths`
 * without resurrecting the row.
 */
export function deleteDealerIssue(issueId: string): DeleteIssueResult {
  const issue = getIssue(issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };

  const blocked = guard(issueId);
  if (blocked) return { ok: false, code: 409, error: blocked };

  const homeDir = getDataDir();
  let collected: string[] = [];
  let removedQueueEntry = false;
  try {
    const tx = getDb().transaction((): { paths: string[]; queued: boolean } => {
      // Re-check inside the transaction: an admission racing this delete must
      // fail closed instead of landing rows the delete then orphans.
      const fresh = getIssue(issueId);
      if (!fresh) throw Object.assign(new Error("Issue not found"), { code: 404 });
      const raced = guard(issueId);
      if (raced) throw Object.assign(new Error(raced), { code: 409 });
      const paths = collectDealerPaths(issueId);
      const queued = getQueuedEntryForIssue(issueId) != null;
      const db = getDb();
      // The self-referencing causation edge must go first: siblings commit in
      // the same statement, but row-by-row FK checks can see a parent vanish
      // before its child does.
      db.prepare(`UPDATE workflow_events SET causation_event_id = NULL WHERE issue_id = ?`).run(issueId);
      db.prepare(
        `DELETE FROM review_publications WHERE work_item_id IN (SELECT id FROM work_items WHERE issue_id = ?)`
      ).run(issueId);
      db.prepare(`DELETE FROM workflow_events WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM usage_events WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM work_items WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM human_actions WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM artifacts WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM issue_source_attachments WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM authority_attempts WHERE owner_id = ? OR owner_id GLOB (? || ':*')`).run(issueId, issueId);
      db.prepare(`DELETE FROM failure_causes WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM session_activity_events WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM worker_sessions WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM workflow_instances WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM queue_entries WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM findings WHERE issue_id = ?`).run(issueId);
      db.prepare(`DELETE FROM issues WHERE id = ?`).run(issueId);
      return { paths, queued };
    });
    const out = tx();
    collected = out.paths;
    removedQueueEntry = out.queued;
  } catch (err) {
    const code = (err as { code?: number }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 404 || code === 409) return { ok: false, code, error: message };
    throw err;
  }

  const residualPaths: string[] = [];
  for (const p of collected) {
    const residual = removeDealerPathContained(p, homeDir);
    if (residual) residualPaths.push(residual);
  }
  return { ok: true, removedQueueEntry, residualPaths };
}

/** Test helper: remaining row counts per issue-scoped table (0 post-delete). */
export function countIssueScopedRows(issueId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ISSUE_SCOPED_TABLES) {
    if (table === "review_publications") {
      const row = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM review_publications
           WHERE work_item_id IN (SELECT id FROM work_items WHERE issue_id = ?)`
        )
        .get(issueId) as { n: number };
      counts[table] = row.n;
    } else if (table === "authority_attempts") {
      const row = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM authority_attempts
           WHERE owner_id = ? OR owner_id GLOB (? || ':*')`
        )
        .get(issueId, issueId) as { n: number };
      counts[table] = row.n;
    } else if (table === "issues") {
      counts[table] = getIssue(issueId) ? 1 : 0;
    } else {
      counts[table] = countIssueRows(table, issueId);
    }
  }
  return counts;
}

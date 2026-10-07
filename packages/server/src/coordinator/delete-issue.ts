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
// authority attempt, and no existing or preserved worktree — recorded or not
// (deterministic session paths, branch-holding checkouts, and evidence-recorded
// paths all count). Anything else answers 409 naming the exact blocker and
// changes nothing.
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
import type { GitHubRepoIdentity, WorkerSessionRole } from "@agent-dealer/shared";
import { looksLikeLocalRepoPath, parseGitHubRepoInput } from "@agent-dealer/shared";
import { WORKTREES_DIR_NAME } from "../adapters/git-worktree.js";
import { managedWorktreePath, managedWorktreesRoot } from "../adapters/managed-repo.js";
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

/** Branch checked out in `dir`, read purely from the filesystem (no git binary,
 * no network): a linked worktree carries a `.git` *file* pointing at its gitdir
 * whose HEAD names the branch; a full checkout carries a `.git` directory. A
 * detached HEAD (reviewer checkouts), a missing `.git`, or anything unreadable
 * reads as null. */
function worktreeBranch(dir: string): string | null {
  try {
    const dotGit = path.join(dir, ".git");
    const st = fs.lstatSync(dotGit);
    let gitDir: string;
    if (st.isDirectory() && !st.isSymbolicLink()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      const content = fs.readFileSync(dotGit, "utf8");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
      if (!match?.[1]) return null;
      gitDir = path.resolve(dir, match[1]);
    } else {
      return null;
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    return /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Immediate child directories of a worktrees root — [] when missing/unreadable. */
function listWorktreeDirs(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) dirs.push(full);
      else if (entry.isSymbolicLink() && fs.statSync(full).isDirectory()) dirs.push(full);
    } catch {
      /* raced away — not a checkout */
    }
  }
  return dirs;
}

/** Absolute `worktreePath` values recorded in one human-action evidence blob
 * (e.g. a rejected push's preserved checkout). Relative strings are in-repo
 * pointers, never checkouts — only absolute paths qualify. An unparseable blob
 * contributes nothing. */
function worktreePathsFromActionEvidence(evidenceJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "worktreePath" && typeof value === "string" && path.isAbsolute(value)) {
          found.push(value);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(parsed);
  return found;
}

/** Checkout paths that still exist on disk — recorded or not. Four sources:
 * (1) `worker_sessions.worktree_path` rows; (2) the deterministic role-worktree
 * path for each of the issue's session ids in the managed and legacy-local
 * layouts — developer-effect creates or reuses the checkout *before*
 * patchRunningSession records it, so an ensureWorktreeDeps throw or a
 * salvage-checkpoint conflict return leaves an on-disk checkout no row names;
 * (3) any checkout under the issue's worktrees roots whose HEAD still sits on
 * issue.branch (a reused leftover under another session's name); (4) absolute
 * `worktreePath` values recorded in the issue's human-action evidence (e.g. a
 * rejected push's preserved checkout). Existence is checked with lstat semantics
 * (no following): a dangling symlink still names a blocker, and reporting a path
 * never resolves it elsewhere. Pure filesystem reads — no git binary, no
 * network — so the guard's sync in-transaction re-check stays safe. */
function existingWorktreePaths(issueId: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (candidate: string): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    try {
      fs.lstatSync(candidate);
      found.push(candidate);
    } catch {
      /* gone */
    }
  };

  const rows = getDb()
    .prepare(
      `SELECT DISTINCT worktree_path AS p FROM worker_sessions
       WHERE issue_id = ? AND worktree_path IS NOT NULL AND worktree_path != ''`
    )
    .all(issueId) as Array<{ p: string }>;
  for (const row of rows) consider(row.p);

  const issue = getIssue(issueId);
  if (!issue) return found;

  const sessions = getDb()
    .prepare(`SELECT id, role FROM worker_sessions WHERE issue_id = ?`)
    .all(issueId) as Array<{ id: string; role: WorkerSessionRole }>;
  let identity: GitHubRepoIdentity | null = null;
  try {
    identity = parseGitHubRepoInput(issue.repo).identity;
  } catch {
    identity = null;
  }
  const legacyRoot = looksLikeLocalRepoPath(issue.repo)
    ? path.join(issue.repo, WORKTREES_DIR_NAME)
    : null;
  if (identity) {
    for (const session of sessions) {
      consider(managedWorktreePath(identity, session.id, session.role));
    }
  }
  if (legacyRoot) {
    for (const session of sessions) {
      consider(path.join(legacyRoot, `${session.id}-${session.role}`));
    }
  }

  if (issue.branch) {
    const roots = [
      ...(identity ? [managedWorktreesRoot(identity)] : []),
      ...(legacyRoot ? [legacyRoot] : []),
    ];
    for (const root of roots) {
      for (const dir of listWorktreeDirs(root)) {
        if (worktreeBranch(dir) === issue.branch) consider(dir);
      }
    }
  }

  const evidenceRows = getDb()
    .prepare(
      `SELECT evidence_json AS e FROM human_actions WHERE issue_id = ? AND evidence_json IS NOT NULL`
    )
    .all(issueId) as Array<{ e: string }>;
  for (const row of evidenceRows) {
    for (const candidate of worktreePathsFromActionEvidence(row.e)) consider(candidate);
  }

  return found;
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

/** Remove one collected path after the commit. Removes only strict descendants
 * of AGENT_DEALER_HOME; anything else — `..` escapes, absolute paths elsewhere,
 * symlinks pointing out, and the home root itself — is left untouched and
 * returned as a residual. An in-home symlink resolving in-home is unlinked
 * itself, never followed into its target. Returns the residual path, or null
 * when removed (or already gone). */
export function removeDealerPathContained(rawPath: string, homeDir: string): string | null {
  // Lexical gate first: the raw path itself must name a strict descendant of
  // the home — an absolute path elsewhere, a `..` escape, or the home root
  // itself (a corrupted or blank blob path resolving there must never wipe the
  // whole Dealer home) is refused before anything is followed or removed. A
  // collected link outside the home pointing in is refused here too: neither
  // the link nor its target is ours to remove.
  const lexical = path.resolve(rawPath);
  const homeLexical = path.resolve(homeDir);
  if (!lexical.startsWith(homeLexical + path.sep)) {
    return rawPath;
  }
  // Existence/canonical gate: realpath resolves symlinks AND `..` — a live
  // in-home symlink pointing outside resolves outside and is refused below,
  // never followed. Canonicalize the home root as well: on macOS the temp dir
  // (and a custom AGENT_DEALER_HOME under it) resolves through a
  // `/var -> /private/var` symlink, so comparing a realpath'd candidate
  // against an unresolved home would misread owned files as outside.
  let resolved: string;
  try {
    resolved = fs.realpathSync(rawPath);
  } catch {
    // Nothing exists at (part of) this path — and the lexical gate above
    // already proved it names an in-root location (e.g. an issue's
    // source-attachment dir with no attachments) — so it is already clean.
    return null;
  }
  let home: string;
  try {
    home = fs.realpathSync(homeDir);
  } catch {
    home = homeLexical;
  }
  if (!resolved.startsWith(home + path.sep)) {
    return rawPath;
  }
  // Already gone is already clean — only real removals and real failures report.
  try {
    if (fs.lstatSync(rawPath).isSymbolicLink()) {
      // An in-home link whose target resolved in-home above: remove the link
      // itself, never the file it points at.
      fs.unlinkSync(rawPath);
    } else {
      const st = fs.lstatSync(resolved);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        fs.rmSync(resolved, { recursive: true, force: true });
      } else {
        fs.rmSync(resolved, { force: true });
      }
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

import { getDb } from "../db/index.js";
import { listIssues } from "../repository/issues.js";
import { advanceIssue, type CoordinatorDeps } from "./session-lifecycle.js";
import { removeWorktree, isWorktreeClean, pruneWorktrees } from "../adapters/git-worktree.js";
import { createHumanAction } from "../repository/human-actions.js";
import type { WorkerSession } from "@agent-dealer/shared";

/** Advances every issue that has a queued session. Safe to call on a timer. */
export async function pollAndDispatch(deps?: CoordinatorDeps): Promise<void> {
  const active = listIssues(["ready", "developing", "reviewing", "repairing"]);
  for (const issue of active) {
    await advanceIssue(issue.id, deps).catch((err) => {
      // A single issue's failure must not stop the poll loop from advancing others.
      console.error(`advanceIssue(${issue.id}) failed:`, err);
    });
  }
}

export interface ReconcileResult {
  reconciled: string[];
}

/** Marks `running` worker_sessions with a stale heartbeat as failed — crash recovery. */
export function reconcileStaleSessions(staleThresholdMs: number): ReconcileResult {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
  const stale = db
    .prepare("SELECT id FROM worker_sessions WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)")
    .all(cutoff) as Array<{ id: string }>;

  const now = new Date().toISOString();
  const reconciled: string[] = [];
  for (const row of stale) {
    db.prepare("UPDATE worker_sessions SET status = 'failed', completed_at = ?, updated_at = ?, error_json = ? WHERE id = ?").run(
      now,
      now,
      JSON.stringify({ reason: "stale heartbeat — process presumed dead" }),
      row.id
    );
    reconciled.push(row.id);
  }
  return { reconciled };
}

/**
 * Crash recovery for a leftover worktree: a missing path is a no-op, a clean checkout
 * is pruned, a dirty/unpushed developer worktree is preserved and escalated — never
 * force-removed, since it may hold unrecovered work.
 */
export async function recoverWorktree(session: WorkerSession, issueId: string): Promise<"removed" | "escalated" | "missing"> {
  if (!session.worktreePath) return "missing";
  const fs = await import("node:fs");
  if (!fs.existsSync(session.worktreePath)) return "missing";

  const clean = await isWorktreeClean(session.worktreePath).catch(() => false);
  if (clean) {
    await removeWorktree({ repo: session.worktreePath, path: session.worktreePath, force: false }).catch(() => undefined);
    return "removed";
  }
  createHumanAction({
    issueId,
    actionType: "policy_escalation",
    reason: `Recovered a dirty worktree at ${session.worktreePath} from session ${session.id} — preserved, not removed.`,
    question: "This worktree has uncommitted or unpushed changes from a crashed session. Inspect and resolve manually.",
    evidence: { worktreePath: session.worktreePath, sessionId: session.id },
  });
  return "escalated";
}

export async function pruneCleanWorktreesForRepo(repo: string): Promise<void> {
  await pruneWorktrees(repo).catch(() => undefined);
}

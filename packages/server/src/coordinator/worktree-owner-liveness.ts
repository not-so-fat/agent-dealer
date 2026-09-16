// packages/server/src/coordinator/worktree-owner-liveness.ts
//
// NOT-127: before resolveDeveloperWorktree reuses or conflicts on a leftover, ask whether
// the session that owns that path still has a live CLI. Filesystem clean/dirty alone is
// wrong in both directions when the predecessor was wrongly presumed dead (NOT-124): a
// clean leftover gets adopted while an agent is mid-run; a dirty leftover escalates as a
// worktree conflict when the "conflict" is just the live owner's WIP.
import fs from "node:fs";
import { getDb } from "../db/index.js";
import {
  sessionIdFromRoleWorktreePath,
  type WorktreeOwnerLiveness,
} from "../adapters/git-worktree.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import type { WorkerSession } from "@agent-dealer/shared";
import { processLiveness } from "./process-liveness.js";

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Every worker_session that may own this coordinator-managed worktree path.
 *
 * Basename id (`<id>-developer`) is not enough on its own: after a dead-and-clean *reuse*,
 * the directory keeps the predecessor's name while the successor's `worktree_path` also
 * points there. Preferring only the basename then hides the live successor and lets the
 * next retry adopt (or mis-escalate) the tree — the exact NOT-127 failure, one hop later.
 */
export function listWorkerSessionsOwningWorktree(worktreePath: string): WorkerSession[] {
  const seen = new Set<string>();
  const out: WorkerSession[] = [];
  const push = (s: WorkerSession | null): void => {
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
  };

  const fromPath = sessionIdFromRoleWorktreePath(worktreePath);
  if (fromPath) push(getWorkerSession(fromPath));

  const real = tryRealpath(worktreePath);
  const rows = getDb()
    .prepare(
      `SELECT id FROM worker_sessions
       WHERE worktree_path = ? OR worktree_path = ?
       ORDER BY created_at DESC`
    )
    .all(worktreePath, real) as Array<{ id: string }>;
  for (const row of rows) push(getWorkerSession(row.id));

  return out;
}

/** First candidate from {@link listWorkerSessionsOwningWorktree} — tests that only need one row. */
export function findWorkerSessionOwningWorktree(worktreePath: string): WorkerSession | null {
  const all = listWorkerSessionsOwningWorktree(worktreePath);
  return all[0] ?? null;
}

function sessionLooksLive(session: WorkerSession): boolean {
  const verdict = processLiveness(
    session.processPid,
    session.processOwner,
    session.processStartedAt ?? null
  );

  if (session.status === "running") {
    // Dead pid → the process is gone even if the row hasn't been completed yet.
    if (verdict === "dead") return false;
    // alive or unknown (including running with no pid yet, pre-spawn) → still owns the tree.
    return true;
  }

  // Terminal session whose recorded pid still answers alive (wrongly presumed dead).
  return verdict === "alive";
}

/**
 * Live owner → block adoption. Dead / unknown / no session → filesystem clean/dirty path.
 *
 * Returns alive if **any** candidate session for this path is live — basename predecessor
 * and every `worktree_path` match (see {@link listWorkerSessionsOwningWorktree}).
 */
export function checkDeveloperWorktreeOwnerLiveness(worktreePath: string): WorktreeOwnerLiveness {
  const candidates = listWorkerSessionsOwningWorktree(worktreePath);
  for (const session of candidates) {
    if (sessionLooksLive(session)) {
      return { state: "alive", sessionId: session.id };
    }
  }
  return { state: "dead" };
}

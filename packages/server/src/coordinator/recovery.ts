// packages/server/src/coordinator/recovery.ts
//
// Startup + periodic recovery for the coordinator kernel. A process crash can leave a work
// item `leased` with no live worker; recovery reclaims it and routes it through the *same*
// bounded retry/escalation policy as an observed failure — it never merely rewrites a
// status (design §"Durable dispatch and recovery"). Mirrors recoverOrphanedRuns() in
// queue/dispatcher.ts, for the issue-centric kernel.
import { getDb } from "../db/index.js";
import { completeSession } from "../repository/worker-sessions.js";
import { reclaimExpiredWorkItems } from "../repository/work-items.js";
import { applyCompletion } from "./commands.js";

export interface RecoverResult {
  /** Work items requeued for another attempt. */
  reclaimed: string[];
  /** Work items past the attempt cap — routed to a human action via the normal routing. */
  deadLettered: string[];
}

/**
 * @param opts.now      current epoch ms (injectable for tests)
 * @param opts.startup  true on server boot: every `leased` item is orphaned regardless of
 *                      its lease expiry, because the worker died with the process.
 */
export function recoverCoordinator(opts?: { now?: number; startup?: boolean }): RecoverResult {
  const now = opts?.now ?? Date.now();
  const { reclaimed, deadLettered } = reclaimExpiredWorkItems(now, {
    includeAllLeased: opts?.startup ?? true,
  });

  // Fail any worker_session left `running` for a reclaimed/dead item — its process is gone.
  const touched = [...reclaimed, ...deadLettered];
  for (const item of touched) {
    if (!item.workerSessionId) continue;
    const row = getDb()
      .prepare("SELECT status FROM worker_sessions WHERE id = ?")
      .get(item.workerSessionId) as { status: string } | undefined;
    if (row?.status === "running") {
      completeSession(item.workerSessionId, {
        status: "failed",
        errorJson: JSON.stringify({ reason: "recovered — worker process presumed dead" }),
      });
    }
  }

  // A dead-lettered item follows the ordinary failure route → attempts_exhausted /
  // policy_escalation, so the issue lands in needs_human rather than silently stalling.
  for (const item of deadLettered) {
    applyCompletion(item.id, { kind: "session_failed" });
  }

  return { reclaimed: reclaimed.map((i) => i.id), deadLettered: deadLettered.map((i) => i.id) };
}

// packages/server/src/coordinator/recovery.ts
//
// Startup + periodic recovery for the coordinator kernel. A process crash can leave a work
// item `leased` with no live worker; recovery reclaims it and routes it through the *same*
// bounded retry/escalation policy as an observed failure — never merely a status rewrite
// (design §"Durable dispatch and recovery"). Mirrors recoverOrphanedRuns() in
// queue/dispatcher.ts, for the issue-centric kernel.
//
// Each candidate is reclaimed in its OWN transaction: the CAS is fenced on the lease token
// it was observed with, so a worker completing concurrently with recovery still wins; a
// dead-lettered item is CAS'd to `dead` and routed together, so a crash can never leave a
// `dead` item with no next effect; and one item that fails to route never rolls back the
// recovery of the others.
import { getDb } from "../db/index.js";
import { getIssue } from "../repository/issues.js";
import { getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { completeSession } from "../repository/worker-sessions.js";
import {
  attemptCapReached,
  finishWorkItem,
  listExpiredLeases,
  requeueWorkItem,
} from "../repository/work-items.js";
import { routeAppliedOutcome } from "./commands.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface RecoverResult {
  /** Work items requeued for another attempt. */
  reclaimed: string[];
  /** Work items past the attempt cap — dead-lettered and routed to a human action. */
  deadLettered: string[];
}

/** Fail a worker_session still `running` for an item whose worker is gone. */
function failOrphanSession(workerSessionId: string | null): void {
  if (!workerSessionId) return;
  const row = getDb()
    .prepare("SELECT status FROM worker_sessions WHERE id = ?")
    .get(workerSessionId) as { status: string } | undefined;
  if (row?.status === "running") {
    completeSession(workerSessionId, {
      status: "failed",
      errorJson: JSON.stringify({ reason: "recovered — worker process presumed dead" }),
    });
  }
}

/**
 * @param opts.now      current epoch ms (injectable for tests)
 * @param opts.startup  true on server boot: every `leased` item is orphaned regardless of
 *                      its lease expiry, because the worker died with the process. Defaults
 *                      to false so a periodic tick never steals a healthy in-flight lease.
 */
export function recoverCoordinator(opts?: { now?: number; startup?: boolean }): RecoverResult {
  const now = opts?.now ?? Date.now();
  const backoffMs = num("COORDINATOR_FAIL_BACKOFF_MS", 10_000);
  const candidates = listExpiredLeases(now, { includeAllLeased: opts?.startup ?? false });

  const reclaimed: string[] = [];
  const deadLettered: string[] = [];

  for (const item of candidates) {
    if (!item.leaseToken) continue;
    const token = item.leaseToken;
    try {
      const kind = getDb().transaction((): "reclaimed" | "dead" | "lost" => {
        if (!attemptCapReached(item)) {
          if (!requeueWorkItem(item.id, token, { reason: "lease expired" }, { backoffMs })) {
            return "lost"; // a concurrent completion won the CAS
          }
          failOrphanSession(item.workerSessionId);
          return "reclaimed";
        }

        const dead = finishWorkItem(item.id, token, {
          status: "dead",
          error: { reason: "lease expired after the attempt cap" },
        });
        if (!dead) return "lost";
        failOrphanSession(item.workerSessionId);

        const issue = getIssue(dead.issueId);
        const instance = getActiveWorkflowInstance(dead.issueId);
        if (issue && instance && instance.id === dead.workflowInstanceId) {
          routeAppliedOutcome(issue, instance, dead, { kind: "session_failed" });
        }
        return "dead";
      })();
      if (kind === "reclaimed") reclaimed.push(item.id);
      else if (kind === "dead") deadLettered.push(item.id);
    } catch (err) {
      // One item's routing failure must not abort recovery of the rest — it stays leased
      // and the next recovery pass retries it.
      console.error("[coordinator] recoverCoordinator", item.id, err);
    }
  }

  return { reclaimed, deadLettered };
}

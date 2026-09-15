// packages/server/src/coordinator/recovery.ts
//
// Startup + periodic recovery for the coordinator kernel. A crash can leave a work item
// `leased` with no live worker; once its lease expires (no heartbeat for `leaseMs`)
// recovery reclaims it and routes it through the *same* bounded retry/escalation policy as
// an observed failure — never merely a status rewrite (design §"Durable dispatch and
// recovery"). Mirrors recoverOrphanedRuns() in queue/dispatcher.ts, for the kernel.
//
// Each candidate is reclaimed in its OWN transaction. The reclaim CAS is fenced on both
// the lease token AND `lease_expires_at < now`, so a worker that heartbeats or completes
// between recovery's read-only snapshot and its write keeps/wins its lease. A dead-lettered
// item is CAS'd to `dead` and routed together, so a crash can't strand it with no next
// effect; and one item that fails to route never rolls back the others.
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
import { recoverStrandedAutoMerges } from "./auto-merge.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface RecoverResult {
  /** Work items requeued for another attempt. */
  reclaimed: string[];
  /** Work items past the attempt cap — dead-lettered and routed to a human action. */
  deadLettered: string[];
  /** Issues whose auto-merge park was finalized after a crash (NOT-102). */
  autoMergesFinalized: string[];
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
 * @param opts.now  current epoch ms (injectable for tests). Recovery reclaims every lease
 *                  whose `lease_expires_at` is before this — the recovery latency for an
 *                  orphaned item is bounded by `COORDINATOR_LEASE_MS`.
 */
export function recoverCoordinator(opts?: { now?: number }): RecoverResult {
  const now = opts?.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const backoffMs = num("COORDINATOR_FAIL_BACKOFF_MS", 10_000);
  const candidates = listExpiredLeases(now);

  const reclaimed: string[] = [];
  const deadLettered: string[] = [];

  for (const item of candidates) {
    if (!item.leaseToken) continue;
    const token = item.leaseToken;
    try {
      const kind = getDb().transaction((): "reclaimed" | "dead" | "lost" => {
        if (!attemptCapReached(item)) {
          const ok = requeueWorkItem(
            item.id,
            token,
            { reason: "lease expired" },
            { backoffMs, onlyIfExpiredBefore: nowIso }
          );
          if (!ok) return "lost"; // completed or heartbeated concurrently
          failOrphanSession(item.workerSessionId);
          return "reclaimed";
        }

        const dead = finishWorkItem(item.id, token, {
          status: "dead",
          error: { reason: "lease expired after the attempt cap" },
          onlyIfExpiredBefore: nowIso,
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

  return {
    reclaimed,
    deadLettered,
    autoMergesFinalized: recoverStrandedAutoMerges().finalized,
  };
}

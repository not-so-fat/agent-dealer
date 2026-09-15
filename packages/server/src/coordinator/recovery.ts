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
import { getIssue, transitionIssue } from "../repository/issues.js";
import { appendWorkflowEvent, getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { completeSession, getWorkerSession } from "../repository/worker-sessions.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import {
  attemptCapReached,
  deferWorkItem,
  finishWorkItem,
  listExpiredLeases,
  requeueWorkItem,
  type WorkItem,
} from "../repository/work-items.js";
import { routeAppliedOutcome } from "./commands.js";
import { recoverStrandedAutoMerges } from "./auto-merge.js";
import { workerSessionPayload } from "./session-progress.js";
import { PRESUMED_DEAD_REASON } from "./failure-reason.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface RecoverResult {
  /** Work items requeued for another attempt. */
  reclaimed: string[];
  /** Work items past the attempt cap — dead-lettered and routed to a human action. */
  deadLettered: string[];
  /** Issues whose auto-merge park was finalized after a crash (NOT-102). */
  autoMergesFinalized: string[];
  /** Expired leases deferred (not spent) because the runtime is known usage-capped (NOT-111). */
  deferredForCap: string[];
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
      errorJson: JSON.stringify({ reason: PRESUMED_DEAD_REASON }),
    });
  }
}

/**
 * Timeline-visible failure for a soft reclaim (under attempt cap). Does not change issue
 * status — the item is requeued — but operators need the presumed-dead reason on the
 * timeline the same way worker.deferred surfaces a cap reason (NOT-113).
 */
function emitPresumedDeadFailed(item: WorkItem): void {
  failOrphanSession(item.workerSessionId);
  const issue = getIssue(item.issueId);
  const instance = getActiveWorkflowInstance(item.issueId);
  if (!issue || !instance || instance.id !== item.workflowInstanceId) return;
  const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
  const role = item.kind === "developer" ? "developer" : "reviewer";
  appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: item.workerSessionId,
    type: "worker.failed",
    actorType: role,
    stage: issue.status,
    round: item.round,
    payload: {
      ...workerSessionPayload({
        runtime: session?.runtime,
        model: session?.model,
        sessionId: item.workerSessionId ?? "",
        worktreePath: session?.worktreePath,
      }),
      outcome: "session_failed",
      reason: PRESUMED_DEAD_REASON,
    },
  });
}

/**
 * A crashed-worker lease belongs to a runtime known usage-capped (its own runner observed
 * the cap and wrote runtime_availability, but the coordinator crashed before applying the
 * usage_capped completion) — defer it like a live deferral instead of spending an
 * attempt/infra retry on it.
 */
function deferExpiredLeaseForCap(item: WorkItem, token: string, nowIso: string): boolean {
  const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
  if (!session?.runtime) return false;
  const avail = runtimeAvailability(session.runtime);
  if (avail.available) return false;

  const deferred = deferWorkItem(item.id, token, {
    availableAt: avail.until,
    error: { kind: "usage_capped", until: avail.until, reason: avail.reason },
    revertAttemptCount: true,
    onlyIfExpiredBefore: nowIso,
  });
  if (!deferred) return false;
  failOrphanSession(item.workerSessionId);

  const issue = getIssue(deferred.issueId);
  const instance = getActiveWorkflowInstance(deferred.issueId);
  if (issue && instance && instance.id === deferred.workflowInstanceId) {
    const role = deferred.kind === "developer" ? "developer" : "reviewer";
    appendWorkflowEvent({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      workerSessionId: deferred.workerSessionId,
      type: "worker.deferred",
      actorType: role,
      stage: issue.status,
      round: deferred.round,
      payload: {
        ...workerSessionPayload({
          runtime: session.runtime,
          model: session.model,
          sessionId: deferred.workerSessionId ?? "",
          worktreePath: session.worktreePath,
        }),
        reason: avail.reason,
        until: avail.until,
        outcome: "usage_capped",
      },
    });
    const untilLabel = new Date(avail.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    transitionIssue(issue.id, issue.status, {
      currentOwner: role,
      currentIntent: `${role === "developer" ? "Developer" : "Reviewer"} deferred — ${avail.reason} (until ${untilLabel})`,
    });
  }
  return true;
}

/**
 * @param opts.now  current epoch ms (injectable for tests). Recovery reclaims every lease
 *                  whose `lease_expires_at` is before this — the recovery latency for an
 *                  orphaned item is bounded by `COORDINATOR_LEASE_MS`.
 */
export async function recoverCoordinator(opts?: { now?: number }): Promise<RecoverResult> {
  const now = opts?.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const backoffMs = num("COORDINATOR_FAIL_BACKOFF_MS", 10_000);
  const candidates = listExpiredLeases(now);

  const reclaimed: string[] = [];
  const deadLettered: string[] = [];
  const deferredForCap: string[] = [];

  for (const item of candidates) {
    if (!item.leaseToken) continue;
    const token = item.leaseToken;
    try {
      const kind = getDb().transaction((): "reclaimed" | "dead" | "lost" | "deferred" => {
        if (deferExpiredLeaseForCap(item, token, nowIso)) return "deferred";

        if (!attemptCapReached(item)) {
          const ok = requeueWorkItem(
            item.id,
            token,
            { reason: "lease expired" },
            { backoffMs, onlyIfExpiredBefore: nowIso }
          );
          if (!ok) return "lost"; // completed or heartbeated concurrently
          emitPresumedDeadFailed(item);
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
          // errorJson already has PRESUMED_DEAD_REASON; attach the same on the outcome so
          // worker.failed payload reason is set even if the session row was missing.
          routeAppliedOutcome(issue, instance, dead, {
            kind: "session_failed",
            reason: PRESUMED_DEAD_REASON,
          });
        }
        return "dead";
      })();
      if (kind === "reclaimed") reclaimed.push(item.id);
      else if (kind === "dead") deadLettered.push(item.id);
      else if (kind === "deferred") deferredForCap.push(item.id);
    } catch (err) {
      // One item's routing failure must not abort recovery of the rest — it stays leased
      // and the next recovery pass retries it.
      console.error("[coordinator] recoverCoordinator", item.id, err);
    }
  }

  const stranded = await recoverStrandedAutoMerges();
  return {
    reclaimed,
    deadLettered,
    deferredForCap,
    autoMergesFinalized: stranded.finalized,
  };
}

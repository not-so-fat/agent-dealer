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
  type WorkItem,
} from "../repository/work-items.js";
import { listOpenAcquiringAuthorityAttempts, revokeOpenActiveAuthorityAttempts } from "../repository/authority-attempts.js";
import { revokeAuthority } from "../adapters/execution-authority.js";
import { resolveAcquiringAttempts } from "../adapters/authority-lifecycle.js";
import { routeAppliedOutcome } from "./commands.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface RecoverResult {
  /** Work items requeued for another attempt. */
  reclaimed: string[];
  /** Work items past the attempt cap — dead-lettered and routed to a human action. */
  deadLettered: string[];
}

/** Revokes (best-effort, fire-and-forget) whatever `authority_attempts` rows are still open
 * for a reclaimed/dead-lettered work item. The ledger's owner_id for a developer/reviewer
 * attempt is `${issueId}:${kind}` — stable across that item's own retry rollover, never the
 * work-item row's own UUID (NOT-91 review, round 5: keying on the work-item id let a fresh
 * enqueued retry item see no predecessor and mint beside one that was never actually
 * resolved). An `active` row (known authorityId) revokes immediately; an `acquiring` row with
 * none yet is resolved via its stored idempotencyKey rather than dropped on a guess (NOT-91
 * review, round 3) — also fire-and-forget, since recovery's own CAS loop must stay
 * synchronous and not block on Deck's availability. */
function revokeStaleAuthoritiesForItem(item: WorkItem): void {
  const ownerId = `${item.issueId}:${item.kind}`;
  for (const row of revokeOpenActiveAuthorityAttempts(item.kind, ownerId)) {
    if (row.authorityId) revokeAuthority(row.authorityId).catch(() => {});
  }
  const acquiring = listOpenAcquiringAuthorityAttempts(item.kind, ownerId);
  if (acquiring.length > 0) resolveAcquiringAttempts(acquiring).catch(() => {});
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
      if (kind === "reclaimed" || kind === "dead") {
        if (kind === "reclaimed") reclaimed.push(item.id);
        else deadLettered.push(item.id);
        // Worker death (NOT-91): whatever execution authority this attempt held has no
        // further legitimate use once its lease is reclaimed or it's dead-lettered — revoke
        // it rather than let it sit live until TTL. Fire-and-forget: revokeAuthority is
        // already best-effort/never-throws, and recovery's own CAS loop must stay
        // synchronous and not block on Deck's availability.
        revokeStaleAuthoritiesForItem(item);
      }
    } catch (err) {
      // One item's routing failure must not abort recovery of the rest — it stays leased
      // and the next recovery pass retries it.
      console.error("[coordinator] recoverCoordinator", item.id, err);
    }
  }

  return { reclaimed, deadLettered };
}

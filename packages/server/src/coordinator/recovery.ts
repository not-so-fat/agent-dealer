// packages/server/src/coordinator/recovery.ts
//
// Startup + periodic recovery for the coordinator kernel. A crash can leave a work item
// `leased` with no live worker; once its lease expires (no heartbeat for `leaseMs`)
// recovery reclaims it and routes it through the *same* bounded retry/escalation policy as
// an observed failure — never merely a status rewrite (design §"Durable dispatch and
// recovery"). Mirrors recoverOrphanedRuns() in queue/dispatcher.ts, for the kernel.
//
// An expired lease is a *suspicion*, not a verdict (NOT-124/125). Before reclaiming, two
// gates ask whether the worker is actually gone: the spawned CLI's pid is checked for
// liveness, and a wall-clock jump that outran the monotonic clock (the host slept) buys
// every pre-jump lease one grace window. Both only ever BLOCK a reclaim — neither can
// cause one, and neither replaces the lease-token CAS that fences the write itself.
//
// Each candidate is reclaimed in its OWN transaction. The reclaim CAS is fenced on both
// the lease token AND `lease_expires_at < now`, so a worker that heartbeats or completes
// between recovery's read-only snapshot and its write keeps/wins its lease. A dead-lettered
// item is CAS'd to `dead` and routed together, so a crash can't strand it with no next
// effect; and one item that fails to route never rolls back the others.
import { getDb } from "../db/index.js";
import { getIssue, transitionIssue } from "../repository/issues.js";
import { appendWorkflowEvent, getActiveWorkflowInstance } from "../repository/workflow-events.js";
import type { WorkerSession } from "@agent-dealer/shared";
import { completeSession, getWorkerSession } from "../repository/worker-sessions.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import {
  attemptCapReached,
  deferWorkItem,
  finishWorkItem,
  listExpiredLeases,
  refreshHeartbeat,
  requeueWorkItem,
  type WorkItem,
} from "../repository/work-items.js";
import { activeClockJumpGrace, type ClockJump } from "./clock-jump.js";
import { processLiveness, terminateWorkerProcess } from "./process-liveness.js";
import { maxAliveHoldMsFor } from "./session-timeouts.js";
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
  /** Expired leases left alone because their spawned CLI is verifiably still running (NOT-124). */
  heldAlive: string[];
  /**
   * Reclaimed despite a live CLI, because the hold ran past `maxAliveHoldMsFor` (NOT-131).
   * The CLI is killed first — this is the bound that stops a hung worker holding a lease
   * forever now that an "alive" verdict survives a coordinator restart.
   */
  heldAliveExpired: string[];
  /**
   * Reclaims that could NOT confirm the predecessor's CLI was stopped (NOT-131): another
   * host, or a row written before the start-time evidence existed. An orphan may still be
   * running for these, so they are surfaced rather than silently assumed clean.
   */
  unverifiedOrphans: string[];
  /** Expired leases left alone because the host was suspended across them (NOT-125). */
  heldAcrossClockJump: string[];
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
 * A lease that expired at or before the moment a clock jump was detected was healthy when
 * the host went down — the gap was suspension, not silence, so it is not evidence of a dead
 * worker (NOT-125). Leases that expired *after* the jump elapsed in real time and are
 * reclaimed normally.
 */
function protectedByClockJump(item: WorkItem, grace: ClockJump | null): boolean {
  if (!grace || !item.leaseExpiresAt) return false;
  return Date.parse(item.leaseExpiresAt) <= grace.detectedAt;
}

/**
 * Has this session been held alive past the point any healthy run could still be going
 * (NOT-131)?
 *
 * The session's own wall clock is a `setTimeout` inside `spawnCli`, in the process that
 * spawned it. After a restart that timer is gone, so an "alive" verdict — which NOT-131
 * makes survive restarts — would otherwise re-extend a hung CLI's lease on every tick and
 * the item would never resolve. Measured from `started_at` (falling back to `created_at`,
 * so there is no branch that holds forever) against a ceiling that is generously larger
 * than the role's timeout, because `started_at` predates the spawn itself.
 */
function aliveHoldExpired(session: WorkerSession | null, now: number): boolean {
  if (!session) return false; // no session row: nothing was ever held on liveness evidence
  const since = Date.parse(session.startedAt ?? session.createdAt);
  if (!Number.isFinite(since)) return false;
  return now - since > maxAliveHoldMsFor(session.role);
}

/**
 * @param opts.now  current epoch ms (injectable for tests). Recovery reclaims every lease
 *                  whose `lease_expires_at` is before this — the recovery latency for an
 *                  orphaned item is bounded by `COORDINATOR_LEASE_MS`.
 * @param opts.clockJump  overrides the ambient clock-jump grace window (tests). Pass `null`
 *                  to force plain timestamp behaviour.
 */
export async function recoverCoordinator(opts?: {
  now?: number;
  clockJump?: ClockJump | null;
}): Promise<RecoverResult> {
  const now = opts?.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const backoffMs = num("COORDINATOR_FAIL_BACKOFF_MS", 10_000);
  const leaseMs = num("COORDINATOR_LEASE_MS", 60_000);
  const grace = opts?.clockJump !== undefined ? opts.clockJump : activeClockJumpGrace(now);
  const candidates = listExpiredLeases(now);

  const reclaimed: string[] = [];
  const deadLettered: string[] = [];
  const deferredForCap: string[] = [];
  const heldAlive: string[] = [];
  const heldAliveExpired: string[] = [];
  const unverifiedOrphans: string[] = [];
  const heldAcrossClockJump: string[] = [];

  for (const item of candidates) {
    if (!item.leaseToken) continue;
    const token = item.leaseToken;

    // NOT-124: the lease says this worker stopped heartbeating; the pid says whether it
    // stopped running. Only the second one is evidence. A live CLI gets its lease extended
    // — the heartbeat timer that should have done so was frozen by the host, not by a
    // crash, and leaving the lease expired would just re-raise this candidate every tick.
    //
    // NOT-131: the verdict now survives a coordinator restart, because `process_started_at`
    // identifies the pid rather than merely naming it. That is what stops a restart from
    // reclaiming every live worker — and it is also why the hold below must be bounded.
    const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
    let aliveButCapped = false;
    const liveness = processLiveness(
      session?.processPid ?? null,
      session?.processOwner ?? null,
      session?.processStartedAt ?? null
    );

    if (liveness === "alive") {
      // NOT-131: the CLI's own wall clock (`spawnCli`'s setTimeout) died with the process
      // that spawned it, so nothing but this bound will ever stop a hung-but-breathing
      // worker. Honouring "alive" forever would trade a destructive reclaim for a permanent
      // stall — strictly the worse failure, and the one this module's own comment warns of.
      const heldTooLong = aliveHoldExpired(session, now);
      if (!heldTooLong) {
        // Token-fenced like every other write here: a false return means this attempt already
        // lost its lease to a peer, in which case there is nothing here to reclaim either.
        if (refreshHeartbeat(item.id, token, { leaseMs })) {
          heldAlive.push(item.id);
          console.warn(
            `[coordinator] lease expired but worker pid ${session?.processPid} is alive — extending`,
            { workItemId: item.id, workerSessionId: item.workerSessionId }
          );
        }
        continue;
      }
      aliveButCapped = true;
    }

    // NOT-125: no usable pid (or a dead one) is not enough when the host itself was
    // suspended across this lease — the CLI may have finished cleanly while the coordinator
    // was frozen mid-publish. Hold pre-jump leases for one grace window; a worker that is
    // genuinely gone is still reclaimed once it passes.
    //
    // Checked before the ceiling above takes effect, and deliberately so: a host that slept
    // burned this session's wall-clock budget without the CLI running for any of it, so the
    // ceiling can fire on a perfectly healthy run. One grace window is enough for the
    // resumed heartbeat to renew the lease and drop the item from the candidate set.
    if (protectedByClockJump(item, grace)) {
      heldAcrossClockJump.push(item.id);
      continue;
    }

    if (aliveButCapped) {
      heldAliveExpired.push(item.id);
      console.warn(
        `[coordinator] worker pid ${session?.processPid} still alive past its session ceiling — reclaiming`,
        {
          workItemId: item.id,
          workerSessionId: item.workerSessionId,
          startedAt: session?.startedAt,
          maxHoldMs: maxAliveHoldMsFor(session?.role ?? null),
        }
      );
    }

    // NOT-131 AC 2: never two live agents on one issue. Everything below reclaims the item,
    // and a later tick will spawn a successor into the same worktree — so the predecessor's
    // CLI must be gone *first*. NOT-126 kills it from the AbortController, but that lives in
    // the memory of the process that spawned it, which in the restart case is the process
    // that just died. This is the out-of-process equivalent, and it is deliberately outside
    // the transaction below: signalling is not rollback-able.
    //
    // A pid we cannot identify is never signalled (`canSignalWorkerProcess`) — a wrong
    // verdict costs one redundant attempt, a wrong kill takes out an unrelated program.
    if (session?.processPid) {
      const stopped = await terminateWorkerProcess(
        session.processPid,
        session.processOwner,
        session.processStartedAt
      ).catch((err) => {
        console.error("[coordinator] terminateWorkerProcess", item.id, err);
        return "failed" as const;
      });
      if (stopped !== "stopped") {
        unverifiedOrphans.push(item.id);
        console.warn(
          `[coordinator] could not confirm worker pid ${session.processPid} is stopped (${stopped}) — ` +
            "a successor may run alongside it",
          { workItemId: item.id, workerSessionId: item.workerSessionId }
        );
      }
    }

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

  if (heldAcrossClockJump.length) {
    // The operator-facing half of NOT-125's AC: "laptop slept" must read differently from
    // "worker hung", and it is exactly these items that would have been wrongly failed.
    console.warn(
      `[coordinator] clock jump absorbed — holding ${heldAcrossClockJump.length} lease(s) that predate it`,
      {
        unelapsedMs: grace?.unelapsedMs,
        wallGapMs: grace?.wallGapMs,
        graceUntil: grace ? new Date(grace.graceUntil).toISOString() : undefined,
        workItemIds: heldAcrossClockJump,
      }
    );
  }

  const stranded = await recoverStrandedAutoMerges();
  return {
    reclaimed,
    deadLettered,
    deferredForCap,
    heldAlive,
    heldAliveExpired,
    unverifiedOrphans,
    heldAcrossClockJump,
    autoMergesFinalized: stranded.finalized,
  };
}

// packages/server/src/coordinator/recovery.ts
//
// Startup + periodic recovery for the coordinator kernel. A crash can leave a work item
// `leased` with no live worker; once its lease expires (no heartbeat for `leaseMs`)
// recovery reclaims it and routes it through the *same* bounded retry/escalation policy as
// an observed failure — never merely a status rewrite (design §"Durable dispatch and
// recovery"). Mirrors recoverOrphanedRuns() in queue/dispatcher.ts, for the kernel.
//
// NOT-128: "the same policy" means the same *budget*. A presumed-dead reclaim is a host- or
// coordinator-level failure, so it spends `issues.infra_attempts` (bounded by
// `max_infra_attempts`, exhaustion escalating through routing's policy_escalation) and
// refunds the claim-time `attempt_count` bump. Three sleeping-laptop reclaims used to burn a
// ticket's entire developer allowance and dump it on a human, even though the agent never
// failed once — `attempt_count` is no longer load-bearing on this path at all.
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
import { canTransitionIssue } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { getIssue, incrementIssueInfraAttempts, transitionIssue } from "../repository/issues.js";
import { appendWorkflowEvent, getActiveWorkflowInstance } from "../repository/workflow-events.js";
import type { WorkerSession } from "@agent-dealer/shared";
import { completeSession, getWorkerSession } from "../repository/worker-sessions.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import {
  deferWorkItem,
  finishWorkItem,
  listExpiredLeases,
  refreshHeartbeat,
  requeueWorkItem,
  type WorkItem,
} from "../repository/work-items.js";
import { infraAttemptsRemain } from "./routing.js";
import { activeClockJumpGrace, type ClockJump } from "./clock-jump.js";
import { inspectWorkerProcess, terminateWorkerProcess } from "./process-liveness.js";
import { maxAliveHoldMsFor } from "./session-timeouts.js";
import { emitHostSuspended } from "./agent-boundaries.js";
import { routeAppliedOutcome } from "./commands.js";
import { recoverStrandedAutoMerges } from "./auto-merge.js";
import { workerSessionPayload } from "./session-progress.js";
import { PRESUMED_DEAD_REASON, presumedDeadReclaimReason } from "./failure-reason.js";
import {
  baseRefCandidates,
  developerBranchName,
  hasPublishableWork,
  inspectBranchProgress,
  type PublishableBranch,
} from "./branch-progress.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export interface RecoverResult {
  /** Work items requeued for another (full) attempt. */
  reclaimed: string[];
  /** Reclaims re-pointed at the no-agent publish path because the branch already had
   * commits (NOT-129) — disjoint from `reclaimed`. */
  republished: string[];
  /** Work items past the issue's infra-attempt limit — dead-lettered and routed to a human
   * action. Never bounded by `attempt_count`: the agent didn't fail (NOT-128). */
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

/** Commits the reclaim is about to republish, by branch state (0 when there is nothing). */
function republishCommits(republish: PublishableBranch | null): number {
  if (republish === null) return 0;
  return republish.state === "unpushed" ? republish.unpushed : republish.ahead;
}

/**
 * The prose reason for one reclaim, resolved once per item so the timeline event, the next
 * session's `retryReason` prompt and the work item's `error_json` all say the same thing.
 */
function reclaimReason(item: WorkItem, republish: PublishableBranch | null): string {
  const role = item.kind === "developer" ? "developer" : "reviewer";
  return presumedDeadReclaimReason(
    role,
    republish
      ? {
          branch: republish.branch,
          commits: republishCommits(republish),
          alreadyPushed: republish.state === "published",
        }
      : null
  );
}

/**
 * Timeline-visible failure for a soft reclaim (infra budget remaining). Does not change issue
 * status — the item is requeued — but operators need the presumed-dead reason on the
 * timeline the same way worker.deferred surfaces a cap reason (NOT-113).
 *
 * `republish` (NOT-129) makes the two shapes of reclaim distinguishable: "we're just
 * republishing what it already did" must not look like "the agent is redoing this". Both the
 * prose reason and the machine-readable `recovery`/`branchState` fields carry it, and the
 * republish case additionally rewrites the issue's live intent — during the three-hour
 * NOT-121 window nothing on screen said which of the two was happening.
 */
function emitPresumedDeadFailed(item: WorkItem, republish: PublishableBranch | null, reason: string): void {
  failOrphanSession(item.workerSessionId);
  const issue = getIssue(item.issueId);
  const instance = getActiveWorkflowInstance(item.issueId);
  if (!issue || !instance || instance.id !== item.workflowInstanceId) return;
  const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
  const role = item.kind === "developer" ? "developer" : "reviewer";
  const alreadyPushed = republish?.state === "published";
  const commits = republishCommits(republish);
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
      reason,
      recovery: republish ? "republish" : "rerun",
      ...(republish ? { branchState: republish.state, branch: republish.branch, commits } : {}),
    },
  });

  // The live intent is cosmetic; the reclaim is not. Only stages with a legal self-loop are
  // touched, so a status that cannot re-enter itself can never throw here and roll back the
  // requeue that shares this transaction.
  if (!republish || !canTransitionIssue(issue.status, issue.status)) return;
  transitionIssue(issue.id, issue.status, {
    currentOwner: role,
    currentIntent: alreadyPushed
      ? `Re-verifying the PR for ${republish.branch} (no agent) — recovered attempt`
      : `Republishing ${commits} recovered commit${commits === 1 ? "" : "s"} (no agent)`,
  });
}

/**
 * Should this reclaim republish the branch instead of re-running the agent (NOT-129)?
 *
 * Called OUTSIDE the reclaim transaction: git is async and the reclaim is a synchronous
 * SQLite transaction. That is safe because the answer is advisory — the reclaim CAS is still
 * fenced on the lease token, so an attempt that heartbeats in the meantime keeps its lease
 * and this result is simply discarded. The branch can only have gained commits by then,
 * never lost them, so a stale read can under-report work, never invent it.
 */
async function republishTargetFor(item: WorkItem): Promise<PublishableBranch | null> {
  // Reviewer items publish nothing of their own, and an item whose infra budget is spent goes
  // to a human rather than to any next attempt.
  if (item.kind !== "developer") return null;
  const issue = getIssue(item.issueId);
  if (!issue || !infraAttemptsRemain(issue)) return null;
  const progress = await inspectBranchProgress({
    repo: issue.repo,
    branch: developerBranchName(issue),
    baseRefs: baseRefCandidates(issue),
  });
  return hasPublishableWork(progress) ? progress : null;
}

/**
 * Payload for the requeued attempt. Always carries `retryReason` so the next session opens
 * with the presumed-dead cause (NOT-128) the way every routed infra retry does — an in-place
 * requeue used to be the one retry that told the next agent nothing about why it was running.
 * When there is something to republish the item is additionally re-pointed at
 * developer-effect's no-agent publish path (NOT-129). Either way the frozen
 * execution-profile snapshot the original enqueue put on the payload is preserved — a
 * publishOnly item still opens a worker_session, so it still needs one.
 */
function reclaimPayloadJson(item: WorkItem, reason: string, republish: PublishableBranch | null): string {
  let payload: Record<string, unknown> = {};
  try {
    if (item.payloadJson) payload = JSON.parse(item.payloadJson) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return JSON.stringify({
    ...payload,
    retryReason: reason,
    ...(republish ? { publishOnly: true, branch: republish.branch } : {}),
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
  const republished: string[] = [];
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
    // One probe, reused for both the hold decision and the kill authorization below — two
    // separate probes could disagree, and a `ps` hiccup between them would kill a healthy
    // worker (see WorkerProcessCheck).
    const probe = inspectWorkerProcess(
      session?.processPid ?? null,
      session?.processOwner ?? null,
      session?.processStartedAt ?? null
    );

    if (probe.verdict === "alive") {
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
      // NOT-169: durable sleep evidence, one idempotent host.suspended per affected
      // session/jump. Observational only — the hold decision above is unchanged, and a
      // failure here never fails, retries, or reassigns the item.
      try {
        const issue = getIssue(item.issueId);
        const instance = getActiveWorkflowInstance(item.issueId);
        if (issue && instance && instance.id === item.workflowInstanceId && item.workerSessionId && grace) {
          const role = item.kind === "developer" ? "developer" : "reviewer";
          emitHostSuspended({
            issueId: issue.id,
            workflowInstanceId: instance.id,
            workerSessionId: item.workerSessionId,
            role,
            stage: issue.status,
            round: item.round,
            detectedAt: grace.detectedAt,
            graceUntil: grace.graceUntil,
            wallGapMs: grace.wallGapMs,
            unelapsedMs: grace.unelapsedMs,
            unobservedMs: grace.unobservedMs,
          });
        }
      } catch {
        // evidence must never change recovery decisions
      }
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
    // A pid this probe did not positively identify is never signalled — a wrong verdict
    // costs one redundant attempt, a wrong kill takes out an unrelated program on the
    // developer's machine.
    if (session?.processPid) {
      const stopped = await terminateWorkerProcess(session.processPid, probe.signalable).catch((err) => {
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
    // NOT-129: the session is not the unit of progress, the branch is. A dead attempt that
    // already committed is republished (push + PR + checks, no agent) rather than redone
    // from zero by a fresh ~40-minute session. Resolved before the transaction below — see
    // republishTargetFor for why doing this outside the CAS is safe.
    //
    // Read *after* the kill above, deliberately: a predecessor CLI still running could land
    // another commit between the read and the requeue, and the republish would then push a
    // branch state nobody inspected. Once the pid is confirmed stopped, what git reports is
    // what the successor will publish.
    const republish = await republishTargetFor(item);
    const reason = reclaimReason(item, republish);

    try {
      const kind = getDb().transaction((): "reclaimed" | "republished" | "dead" | "lost" | "deferred" => {
        if (deferExpiredLeaseForCap(item, token, nowIso)) return "deferred";

        // NOT-128: which budget bounds this loop. A presumed-dead reclaim is an infra
        // failure — the same bucket routing.ts puts an observed `session_failed` in — so it
        // is bounded by `max_infra_attempts` and charged to `issues.infra_attempts`, and the
        // claim-time `attempt_count` bump is refunded (the NOT-111 precedent). Read inside
        // the transaction: the snapshot `item` is from before the CAS, and a concurrent route
        // may have spent the budget since.
        //
        // No issue row at all can only mean it was deleted out from under the queue: there is
        // no budget to consult and no issue to escalate onto, so requeue (the harmless half)
        // and spend nothing.
        const budgetIssue = getIssue(item.issueId);
        if (!budgetIssue || infraAttemptsRemain(budgetIssue)) {
          const ok = requeueWorkItem(
            item.id,
            token,
            { reason },
            {
              backoffMs,
              onlyIfExpiredBefore: nowIso,
              revertAttemptCount: true,
              payloadJson: reclaimPayloadJson(item, reason, republish),
            }
          );
          if (!ok) return "lost"; // completed or heartbeated concurrently
          emitPresumedDeadFailed(item, republish, reason);
          // After the requeue, never before: an infra attempt is only spent once the reclaim
          // has actually happened, and the CAS above is what decides that.
          if (budgetIssue) incrementIssueInfraAttempts(budgetIssue.id);
          return republish ? "republished" : "reclaimed";
        }

        const dead = finishWorkItem(item.id, token, {
          status: "dead",
          error: { reason: `${PRESUMED_DEAD_REASON} (infra-attempt limit reached)` },
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
      else if (kind === "republished") republished.push(item.id);
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

  if (republished.length) {
    console.warn(
      `[coordinator] ${republished.length} reclaim(s) routed to republish — branch already had commits, no new agent session`,
      { workItemIds: republished }
    );
  }

  const stranded = await recoverStrandedAutoMerges();
  return {
    reclaimed,
    republished,
    deadLettered,
    deferredForCap,
    heldAlive,
    heldAliveExpired,
    unverifiedOrphans,
    heldAcrossClockJump,
    autoMergesFinalized: stranded.finalized,
  };
}

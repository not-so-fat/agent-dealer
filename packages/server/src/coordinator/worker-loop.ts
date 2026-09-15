// packages/server/src/coordinator/worker-loop.ts
//
// The leased effect worker + its poll loop. A dispatcher claims a queued work item with a
// compare-and-set (so concurrent dispatchers never run one twice), records a running
// worker_session, keeps a token-fenced heartbeat while the effect handler runs, then
// applies the structured completion transactionally. Bounded concurrency; non-overlapping
// polling.
//
// NOT-59 exports startCoordinatorLoop/stopCoordinatorLoop but does NOT wire them into the
// server — index.ts integration lands with NOT-60.
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { getAgent } from "../repository/agents.js";
import { getIssue } from "../repository/issues.js";
import {
  getWorkflowInstance,
  getActiveWorkflowInstance,
  appendWorkflowEvent,
} from "../repository/workflow-events.js";
import {
  createWorkerSession,
  startSession,
  heartbeatSession,
  completeSession,
} from "../repository/worker-sessions.js";
import {
  attemptCapReached,
  bindWorkItemSession,
  claimWorkItem,
  finishWorkItem,
  getWorkItem,
  refreshHeartbeat,
  requeueWorkItem,
  type WorkItem,
  type WorkItemKind,
} from "../repository/work-items.js";
import { applyCompletion, routeAppliedOutcome, routeCapEscalation } from "./commands.js";
import { getEffectHandler } from "./effect-registry.js";
import { parseProfileSnapshot } from "@agent-dealer/shared";
import { buildProfileSnapshot, serializeProfileSnapshot } from "./profile-snapshot.js";
import type { DeveloperOutcome, ReviewerOutcome } from "./routing.js";
import { recoverStrandedAutoMerges } from "./auto-merge.js";
import { workerSessionPayload } from "./session-progress.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import { deferLeasedWorkItemForUsageCap, type UsageCappedOutcome } from "./usage-cap-defer.js";

const num = (name: string, dflt: number): number => Number(process.env[name] ?? dflt);

export const coordinatorConfig = {
  get maxConcurrency(): number {
    return num("MAX_COORDINATOR_CONCURRENCY", 2);
  },
  get leaseMs(): number {
    return num("COORDINATOR_LEASE_MS", 60_000);
  },
  get heartbeatMs(): number {
    return num("COORDINATOR_HEARTBEAT_MS", 15_000);
  },
  get failBackoffMs(): number {
    return num("COORDINATOR_FAIL_BACKOFF_MS", 10_000);
  },
  get pollIntervalMs(): number {
    return num("COORDINATOR_POLL_INTERVAL_MS", 3_000);
  },
};

const roleFor: Record<WorkItemKind, "developer" | "reviewer"> = {
  developer: "developer",
  reviewer: "reviewer",
};

// Keyed by lease token, not work-item id: recovery can requeue an expired item while its
// zombie handler is still unwinding, and a later tick may re-claim the same id. Keying by
// the per-attempt token keeps the two tracked separately, so the concurrency bound holds
// and drainCoordinator awaits both.
const active = new Map<string, Promise<void>>();

/** Visible for tests — the number of effect attempts this process is running. */
export function activeAttemptCount(): number {
  return active.size;
}

function isFailureOutcome(outcome: DeveloperOutcome | ReviewerOutcome): boolean {
  return outcome.kind === "session_failed" || outcome.kind === "publish_failed";
}

/** `timed_out` is the only outcome meaning the agent process itself hit its wall clock —
 * every other kind (no_pr, dirty_worktree, checks_failed, ...) is a session that ran to
 * completion and handed off a (possibly unwanted) verified result. */
function isTimedOutOutcome(outcome: DeveloperOutcome | ReviewerOutcome): boolean {
  return outcome.kind === "timed_out";
}

/** completeSession is bookkeeping — its failure must never re-route or revive a work item. */
function safeCompleteSession(sessionId: string, status: "done" | "failed" | "timed_out" | "cancelled", error?: unknown): void {
  try {
    completeSession(sessionId, {
      status,
      errorJson: error !== undefined ? JSON.stringify(error) : undefined,
    });
  } catch (err) {
    console.error("[coordinator] completeSession", sessionId, err);
  }
}

/**
 * A failed effect (handler threw, or lost its lease mid-run). One transaction, fenced on
 * the lease token: either requeue with backoff, or — at the attempt cap — CAS to `dead`
 * AND route it as `session_failed` together, so a crash can't strand the workflow with a
 * dead item and no next effect.
 */
function handleEffectFailure(itemId: string, leaseToken: string, error: unknown): void {
  getDb().transaction(() => {
    const item = getWorkItem(itemId);
    if (!item || item.status !== "leased") return; // already reclaimed / finished by a peer

    if (!attemptCapReached(item)) {
      requeueWorkItem(itemId, leaseToken, error, { backoffMs: coordinatorConfig.failBackoffMs });
      return;
    }

    const dead = finishWorkItem(itemId, leaseToken, { status: "dead", error });
    if (!dead) return; // a peer won the CAS

    const issue = getIssue(dead.issueId);
    const instance = getActiveWorkflowInstance(dead.issueId);
    if (issue && instance && instance.id === dead.workflowInstanceId) {
      routeAppliedOutcome(issue, instance, dead, { kind: "session_failed" });
    }
  })();
}

async function processWorkItem(claimed: WorkItem): Promise<void> {
  const leaseToken = claimed.leaseToken;
  if (!leaseToken) return; // not actually leased — defensive

  const issue = getIssue(claimed.issueId);
  const instance = getWorkflowInstance(claimed.workflowInstanceId);
  if (!issue || !instance) {
    handleEffectFailure(claimed.id, leaseToken, { reason: "issue or workflow instance vanished" });
    return;
  }

  let payload: { inputSha?: string | null; profileSnapshot?: string | null } = {};
  try {
    if (claimed.payloadJson) payload = JSON.parse(claimed.payloadJson);
  } catch {
    payload = {};
  }
  const inputSha = payload.inputSha ?? null;

  // The execution-profile snapshot was frozen into the work-item payload when the item
  // was *queued* (commands.ts), so a profile edit between enqueue and claim can never
  // change this session (design §"Immutable execution-profile snapshot" / NOT-60
  // acceptance criteria). Fall back to a live resolve only for a legacy item queued
  // before the snapshot was carried on the payload.
  const role = roleFor[claimed.kind];
  const agentId = claimed.kind === "developer" ? issue.developerAgentId : issue.reviewerAgentId;
  let snapshot = parseProfileSnapshot(payload.profileSnapshot);
  if (!snapshot) {
    const agent = agentId ? getAgent(agentId) : null;
    snapshot = agent ? buildProfileSnapshot(agent, role) : null;
  }

  const runtime = snapshot?.runtime ?? null;
  if (runtime) {
    const avail = runtimeAvailability(runtime);
    if (!avail.available) {
      const cap: UsageCappedOutcome = {
        kind: "usage_capped",
        until: avail.until,
        reason: avail.reason,
      };
      const deferResult = deferLeasedWorkItemForUsageCap(claimed, leaseToken, cap, issue, instance);
      if (deferResult.deferred) return;
      if (deferResult.escalated) {
        getDb().transaction(() => {
          const finished = finishWorkItem(claimed.id, leaseToken, { status: "done", result: cap });
          if (finished) routeCapEscalation(issue, instance, finished, cap);
        })();
      }
      return;
    }
  }

  // Create + bind + start the session
  // leaves a running session that recovery (which keys off work_items) cannot locate. The
  // bind is fenced on the lease token: if this attempt lost its lease between claim and
  // here, the transaction rolls back (session creation undone) and the attempt is dropped.
  let session;
  try {
    session = getDb().transaction(() => {
      const s = createWorkerSession({
        issueId: claimed.issueId,
        role,
        round: claimed.round,
        agentId,
        runtime: snapshot?.runtime ?? null,
        model: snapshot?.model ?? null,
        budgetJson: snapshot?.budgetJson ?? null,
        inputSha,
        metadataJson: JSON.stringify({ workItemId: claimed.id }),
        profileSnapshotJson: snapshot ? serializeProfileSnapshot(snapshot) : null,
      });
      if (!bindWorkItemSession(claimed.id, s.id, leaseToken)) {
        throw new Error("lease lost before session setup");
      }
      startSession(s.id);
      // NOT-109: attribute start to the role (not system) so Issue Detail shows
      // "Developer started" / "Reviewer started" with a role badge, and carry runtime /
      // model / session id for ops debugging.
      appendWorkflowEvent({
        issueId: claimed.issueId,
        workflowInstanceId: instance.id,
        workerSessionId: s.id,
        type: "worker.started",
        actorType: role,
        stage: issue.status,
        round: claimed.round,
        payload: workerSessionPayload({
          runtime: snapshot?.runtime ?? null,
          model: snapshot?.model ?? null,
          sessionId: s.id,
        }),
      });
      return s;
    })();
  } catch (err) {
    console.error("[coordinator] session setup", claimed.id, err);
    return; // lost the lease — recovery will reprocess the item when the lease expires
  }

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (refreshHeartbeat(claimed.id, leaseToken, { leaseMs: coordinatorConfig.leaseMs })) {
      heartbeatSession(session.id);
    } else {
      controller.abort();
    }
  }, coordinatorConfig.heartbeatMs);

  let outcome: DeveloperOutcome | ReviewerOutcome;
  try {
    outcome = await getEffectHandler(claimed.kind)({
      workItem: { ...claimed, workerSessionId: session.id },
      issue,
      instance,
      signal: controller.signal,
    });
  } catch (err) {
    clearInterval(heartbeat);
    try {
      handleEffectFailure(claimed.id, leaseToken, { error: String(err) });
    } catch (routeErr) {
      // routing threw — leave the item leased for recovery to retry
      console.error("[coordinator] handleEffectFailure", claimed.id, routeErr);
    }
    safeCompleteSession(session.id, "failed", { error: String(err) });
    return;
  }
  clearInterval(heartbeat);

  // The completion CAS is fenced on leaseToken and is the only path to a terminal state —
  // a duplicate or a reclaimed-then-late completion applies nothing.
  const result = await applyCompletion(claimed.id, leaseToken, outcome);
  if (!result.applied) {
    safeCompleteSession(session.id, "cancelled", { reason: result.reason });
    return;
  }
  if (result.triggerReflect) {
    const { triggerIssueReflect } = await import("./reflect-trigger.js");
    void triggerIssueReflect(claimed.issueId).catch(() => {});
  }
  const sessionStatus =
    outcome.kind === "usage_capped"
      ? "done"
      : isTimedOutOutcome(outcome)
        ? "timed_out"
        : isFailureOutcome(outcome)
          ? "failed"
          : "done";
  safeCompleteSession(session.id, sessionStatus);
}

/**
 * Claims and starts as many work items as free concurrency slots allow, then returns the
 * count started. Not awaited internally — each item runs to completion in the background
 * and is tracked in `active`.
 */
export async function runCoordinatorTick(opts?: { leaseOwner?: string }): Promise<number> {
  // NOT-102: finish auto-merges parked before a crash (no in-memory pendingAutoMerge left).
  await recoverStrandedAutoMerges();
  const leaseOwner = opts?.leaseOwner ?? `loop-${process.pid}-${uuid().slice(0, 8)}`;
  let started = 0;
  while (active.size < coordinatorConfig.maxConcurrency) {
    const item = claimWorkItem(leaseOwner, { leaseMs: coordinatorConfig.leaseMs });
    if (!item || !item.leaseToken) break;
    const key = item.leaseToken;
    const job = processWorkItem(item)
      .catch((err) => console.error("[coordinator] processWorkItem", item.id, err))
      .finally(() => active.delete(key));
    active.set(key, job);
    started++;
  }
  return started;
}

/** Awaits every in-flight work item — for tests and graceful shutdown. */
export async function drainCoordinator(): Promise<void> {
  await Promise.all([...active.values()]);
}

let loopTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startCoordinatorLoop(): void {
  if (loopTimer) return;
  const leaseOwner = `loop-${process.pid}-${uuid().slice(0, 8)}`;
  loopTimer = setInterval(() => {
    if (ticking) return; // non-overlapping polling
    ticking = true;
    runCoordinatorTick({ leaseOwner })
      .catch((err) => console.error("[coordinator] tick", err))
      .finally(() => {
        ticking = false;
      });
  }, coordinatorConfig.pollIntervalMs);
}

export function stopCoordinatorLoop(): void {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  ticking = false;
}

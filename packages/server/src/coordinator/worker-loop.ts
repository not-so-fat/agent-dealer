// packages/server/src/coordinator/worker-loop.ts
//
// The leased effect worker + its poll loop. A dispatcher claims a queued work item with a
// compare-and-set (so concurrent dispatchers never run one twice), records a running
// worker_session, keeps a heartbeat while the effect handler runs, then applies the
// structured completion transactionally. Bounded concurrency; non-overlapping polling.
//
// NOT-59 exports startCoordinatorLoop/stopCoordinatorLoop but does NOT wire them into the
// server — index.ts integration lands with NOT-60.
import { v4 as uuid } from "uuid";
import { getIssue } from "../repository/issues.js";
import { getWorkflowInstance, appendWorkflowEvent } from "../repository/workflow-events.js";
import {
  createWorkerSession,
  startSession,
  heartbeatSession,
  completeSession,
} from "../repository/worker-sessions.js";
import {
  bindWorkItemSession,
  claimWorkItem,
  failWorkItem,
  refreshHeartbeat,
  type WorkItem,
  type WorkItemKind,
} from "../repository/work-items.js";
import { applyCompletion } from "./commands.js";
import { getEffectHandler } from "./effect-registry.js";

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

const active = new Map<string, Promise<void>>();

/** Visible for tests — the in-flight work-item ids this process is running. */
export function activeWorkItemIds(): string[] {
  return [...active.keys()];
}

async function processWorkItem(item: WorkItem, leaseOwner: string): Promise<void> {
  const issue = getIssue(item.issueId);
  const instance = getWorkflowInstance(item.workflowInstanceId);
  if (!issue || !instance) {
    failWorkItem(item.id, { reason: "issue or workflow instance vanished" }, {
      backoffMs: coordinatorConfig.failBackoffMs,
    });
    return;
  }

  let inputSha: string | null = null;
  try {
    inputSha = item.payloadJson ? (JSON.parse(item.payloadJson).inputSha ?? null) : null;
  } catch {
    inputSha = null;
  }

  const session = createWorkerSession({
    issueId: item.issueId,
    role: roleFor[item.kind],
    round: item.round,
    agentId: item.kind === "developer" ? issue.developerAgentId : issue.reviewerAgentId,
    runtime: null,
    inputSha,
    metadataJson: JSON.stringify({ workItemId: item.id }),
  });
  startSession(session.id);
  bindWorkItemSession(item.id, session.id);
  appendWorkflowEvent({
    issueId: item.issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.started",
    actorType: "system",
    stage: issue.status,
    round: item.round,
  });

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    const held = refreshHeartbeat(item.id, leaseOwner, { leaseMs: coordinatorConfig.leaseMs });
    if (held) {
      heartbeatSession(session.id);
    } else {
      controller.abort();
    }
  }, coordinatorConfig.heartbeatMs);

  try {
    const handler = getEffectHandler(item.kind);
    const outcome = await handler({
      workItem: { ...item, workerSessionId: session.id },
      issue,
      instance,
      signal: controller.signal,
    });
    clearInterval(heartbeat);
    const result = applyCompletion(item.id, outcome);
    if (!result.applied) {
      // The lease was reclaimed mid-flight (or already applied) — this run's output is
      // discarded and the requeued item, if any, is reprocessed by another worker.
      completeSession(session.id, {
        status: "cancelled",
        errorJson: JSON.stringify({ reason: `completion not applied: ${result.reason}` }),
      });
      return;
    }
    completeSession(session.id, {
      status:
        outcome.kind === "session_failed" || outcome.kind === "publish_failed" ? "failed" : "done",
    });
  } catch (err) {
    clearInterval(heartbeat);
    const { dead } = failWorkItem(item.id, { error: String(err) }, {
      backoffMs: coordinatorConfig.failBackoffMs,
    });
    completeSession(session.id, { status: "failed", errorJson: JSON.stringify({ error: String(err) }) });
    if (dead) {
      // A dead-lettered work item still routes through the retry/escalation policy.
      applyCompletion(item.id, { kind: "session_failed" });
    }
  }
}

/**
 * Claims and starts as many work items as free concurrency slots allow, then returns the
 * count started. Not awaited internally — each item runs to completion in the background
 * and is tracked in `active`.
 */
export async function runCoordinatorTick(opts?: { leaseOwner?: string }): Promise<number> {
  const leaseOwner = opts?.leaseOwner ?? `loop-${process.pid}-${uuid().slice(0, 8)}`;
  let started = 0;
  while (active.size < coordinatorConfig.maxConcurrency) {
    const item = claimWorkItem(leaseOwner, { leaseMs: coordinatorConfig.leaseMs });
    if (!item) break;
    const job = processWorkItem(item, leaseOwner)
      .catch((err) => console.error("[coordinator] processWorkItem", item.id, err))
      .finally(() => active.delete(item.id));
    active.set(item.id, job);
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

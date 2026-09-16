// packages/server/src/coordinator/admission.ts
//
// NOT-103: when to call startWorkflowCore on which queued issue.
// Order (queue_entries) + eligibility rules + CapacityPolicy — not a second execution engine.
//
// NOT-118: this is also the *only* entry point a route may use to start an issue
// (`startIssueViaQueue`). Manual Start moves the entry to the front and admits it when a
// slot is free — it never bypasses the queue. The single ungated exception is a human
// action resolving into startWorkflowCore (commands.ts).

import type { AgentProfile, Issue, IssueStatus, WorkflowInstance } from "@agent-dealer/shared";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { healthForAgent } from "../adapters/agent-health.js";
import { getDb } from "../db/index.js";
import { getAgent } from "../repository/agents.js";
import { getIssue, listIssues } from "../repository/issues.js";
import {
  enqueueIssue,
  getQueuedEntryForIssue,
  listQueuedEntries,
  markQueueEntryAdmitted,
  markQueueEntryRemoved,
  moveQueueEntryToTop,
  setQueueWaitReason,
  type QueueEntryView,
} from "../repository/queue-entries.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import { getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { listWorkItemsForIssue, type WorkItem } from "../repository/work-items.js";
import {
  activeWorkflowConflictMessage,
  checkIssueReadiness,
  startWorkflowCore,
  StartPreconditionError,
} from "./commands.js";

/** Statuses that occupy an admission slot (Decision 2). */
export const occupyingStatuses = new Set<IssueStatus>(["developing", "reviewing", "repairing"]);

export type ActiveIssueRef = { id: string; status: IssueStatus };

/**
 * Single swappable capacity function. Only `sequential` is wired (freeSlots = 1 − occupying).
 * Parallel `fixed(N)` / per-repo limits plug in here later — no other capacity code paths.
 */
export type CapacityPolicy = (activeIssues: ActiveIssueRef[]) => number;

export const sequentialCapacityPolicy: CapacityPolicy = (activeIssues) => {
  const occupying = activeIssues.filter((i) => occupyingStatuses.has(i.status)).length;
  return Math.max(0, 1 - occupying);
};

let capacityPolicy: CapacityPolicy = sequentialCapacityPolicy;

/** Test / future parallel wiring — swap the single CapacityPolicy function. */
export function setCapacityPolicyForTests(policy: CapacityPolicy): void {
  capacityPolicy = policy;
}

export function resetCapacityPolicyForTests(): void {
  capacityPolicy = sequentialCapacityPolicy;
}

export function countOccupyingIssues(): number {
  return listOccupyingIssues().length;
}

function listOccupyingIssues(): ActiveIssueRef[] {
  return listIssues([...occupyingStatuses]).map((i) => ({ id: i.id, status: i.status }));
}

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

/** Shared per-`admitNext()` context — see `defaultAgentHealth` for why deckOnline lives here. */
export type EligibilityContext = { deckOnline: boolean };

export type EligibilityRule = (
  issue: Issue,
  ctx: EligibilityContext
) => EligibilityResult | Promise<EligibilityResult>;

export type AgentHealthCheck = (agent: AgentProfile) => Promise<EligibilityResult>;

let healthChecker: AgentHealthCheck | null = null;

/** Tests inject a pure checker so admission does not hit real CLIs. */
export function setAdmissionHealthCheckerForTests(checker: AgentHealthCheck | null): void {
  healthChecker = checker;
}

async function defaultAgentHealth(agent: AgentProfile, deckOnline: boolean): Promise<EligibilityResult> {
  const health = await healthForAgent(agent, deckOnline);
  // usage_capped is owned by runtimeAvailable — keep agentsHealthy for CLI/workspace/deck.
  const nonCap = health.issues.filter((i) => i.code !== "usage_capped");
  if (nonCap.length > 0) {
    return {
      ok: false,
      reason: `agent unhealthy: ${agent.name} — ${nonCap.map((i) => i.message).join("; ")}`,
    };
  }
  return { ok: true };
}

async function checkAgentsHealthy(issue: Issue, ctx: EligibilityContext): Promise<EligibilityResult> {
  const check = healthChecker ?? ((agent: AgentProfile) => defaultAgentHealth(agent, ctx.deckOnline));
  for (const role of ["developer", "reviewer"] as const) {
    const agentId = role === "developer" ? issue.developerAgentId : issue.reviewerAgentId;
    if (!agentId) return { ok: false, reason: `missing ${role} agent` };
    const agent = getAgent(agentId);
    if (!agent) return { ok: false, reason: `${role} agent not found` };
    const result = await check(agent);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Status must be startable (`ready`, or `needs_human` with no active workflow) and
 * checkIssueReadiness must pass — never open product_scope_decision.
 */
function issueReadinessRule(issue: Issue): EligibilityResult {
  if (issue.status !== "ready" && issue.status !== "needs_human") {
    return { ok: false, reason: `issue status is ${issue.status} — not startable` };
  }
  if (getActiveWorkflowInstance(issue.id)) {
    return { ok: false, reason: "issue already has an active workflow" };
  }
  const readiness = checkIssueReadiness(issue);
  if (!readiness.ok) {
    if (readiness.missing.includes("acceptance criteria") && readiness.missing.length === 1) {
      return { ok: false, reason: "missing acceptance criteria" };
    }
    return { ok: false, reason: `missing ${readiness.missing.join(", ")}` };
  }
  return { ok: true };
}

function runtimeAvailableRule(issue: Issue): EligibilityResult {
  for (const role of ["developer", "reviewer"] as const) {
    const agentId = role === "developer" ? issue.developerAgentId : issue.reviewerAgentId;
    if (!agentId) continue;
    const agent = getAgent(agentId);
    if (!agent) continue;
    const avail = runtimeAvailability(agent.runtime);
    if (!avail.available) {
      return {
        ok: false,
        reason: `runtime capped: ${agent.runtime} until ${avail.until} (${avail.reason})`,
      };
    }
  }
  return { ok: true };
}

/** Initial eligibility rules — NOT-104 adds blockedByDependency here, not new machinery. */
export const defaultEligibilityRules: EligibilityRule[] = [
  issueReadinessRule,
  checkAgentsHealthy,
  runtimeAvailableRule,
];

let eligibilityRules: EligibilityRule[] = defaultEligibilityRules;

export function setEligibilityRulesForTests(rules: EligibilityRule[]): void {
  eligibilityRules = rules;
}

export function resetEligibilityRulesForTests(): void {
  eligibilityRules = defaultEligibilityRules;
}

async function evaluateEligibility(issue: Issue, ctx: EligibilityContext): Promise<EligibilityResult> {
  for (const rule of eligibilityRules) {
    const result = await rule(issue, ctx);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Level-triggered admission: if a free slot exists, walk queued entries in position order,
 * record wait_reason on ineligible ones (skip-ahead), and admit the first eligible via
 * startWorkflowCore (which force-admits the queue entry in the same transaction).
 *
 * Queue housekeeping (closed / already-running → leave queued) always runs, even when
 * capacity is full — otherwise a start that bypassed admitNext could leave a stale row.
 */
export type AdmittedIssue = { issueId: string; instance: WorkflowInstance; workItem: WorkItem };

export async function admitNext(): Promise<AdmittedIssue | null> {
  const freeSlots = capacityPolicy(listOccupyingIssues());
  const entries = listQueuedEntries();

  // Housekeeping pass — independent of free slots.
  for (const entry of entries) {
    const issue = getIssue(entry.issueId);
    if (!issue || issue.status === "done" || issue.status === "closed") {
      markQueueEntryRemoved(entry.issueId);
      continue;
    }
    if (getActiveWorkflowInstance(entry.issueId)) {
      markQueueEntryAdmitted(entry.issueId);
    }
  }

  if (freeSlots <= 0) return null;

  // Re-list after housekeeping so admitted/removed rows are gone.
  const remaining = listQueuedEntries();
  if (remaining.length === 0) return null;

  // One deck-health check per tick, shared across every queued entry and role. Each
  // agent's health check otherwise re-hits agent-deck's uncached /health endpoint per
  // entry per role; with several issues queued and agent-deck slow/unreachable that
  // serially stalls this loop, which worker-loop runs before any real work dispatch.
  const ctx: EligibilityContext = { deckOnline: await checkAgentDeckHealth() };

  for (const entry of remaining) {
    const issue = getIssue(entry.issueId);
    if (!issue) {
      markQueueEntryRemoved(entry.issueId);
      continue;
    }

    const eligibility = await evaluateEligibility(issue, ctx);
    if (!eligibility.ok) {
      setQueueWaitReason(entry.id, eligibility.reason);
      continue;
    }

    try {
      const started = getDb().transaction(() => {
        // Dequeue race: operator may have removed the entry during async eligibility checks.
        if (!getQueuedEntryForIssue(entry.issueId)) {
          throw new StartPreconditionError(409, "queue entry no longer queued");
        }
        // Re-check capacity inside the txn so a concurrent Manual Start cannot double-admit.
        if (capacityPolicy(listOccupyingIssues()) <= 0) {
          throw new StartPreconditionError(409, "no free admission slots");
        }
        // Force-admit lives inside startWorkflowCore — single owner for start-path-queue-sync.
        return startWorkflowCore(entry.issueId);
      })();
      return { issueId: entry.issueId, ...started };
    } catch (err) {
      const message =
        err instanceof StartPreconditionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Entry was dequeued — nothing to record; try the next entry.
      if (message.includes("no longer queued")) continue;
      // Capacity exhausted mid-walk (concurrent Manual Start) — stop; do not write wait reasons.
      if (message.includes("no free admission slots")) return null;
      setQueueWaitReason(entry.id, message);
    }
  }
  return null;
}

/**
 * NOT-118 read-time wait reason. `admitNext` returns before evaluating anything when no
 * slot is free, so a full system would otherwise leave every queued entry with no reason
 * (or a stale one from an earlier tick). Derived on read instead of written every tick.
 */
export function slotWaitReason(): string | null {
  const running = listIssues([...occupyingStatuses]);
  if (capacityPolicy(running.map((i) => ({ id: i.id, status: i.status }))) > 0) return null;
  const titles = running.map((i) => i.title).join(", ");
  return titles ? `waiting for slot — running: ${titles}` : "waiting for slot";
}

/**
 * The queue as operators read it: 1-based positions (rank, not the raw stored column, which
 * legacy rows may have left sparse) and the current blocker per entry. While capacity is
 * full that blocker *is* the missing slot, so the derived reason wins over whatever an
 * earlier tick persisted; once a slot frees, the entry's own reason (missing acceptance
 * criteria, unhealthy agent, capped runtime) surfaces again on the next tick.
 */
export function listQueuedEntriesForRead(): QueueEntryView[] {
  const slotReason = slotWaitReason();
  return listQueuedEntries().map((entry, index) => ({
    ...entry,
    position: index + 1,
    waitReason: slotReason ?? entry.waitReason,
  }));
}

export function queueStatusForIssue(
  issueId: string
): { position: number; waitReason: string | null } | null {
  const entry = listQueuedEntriesForRead().find((e) => e.issueId === issueId);
  return entry ? { position: entry.position, waitReason: entry.waitReason } : null;
}

export type StartIssueOutcome =
  | { state: "admitted"; instance: WorkflowInstance; workItem: WorkItem }
  | { state: "queued"; position: number; waitReason: string | null }
  | { state: "error"; code: number; error: string };

/** The round-1 developer item an admitted start enqueued, for a start that raced a tick. */
function developerWorkItemFor(issueId: string, instanceId: string): WorkItem | null {
  return (
    listWorkItemsForIssue(issueId).find(
      (w) => w.workflowInstanceId === instanceId && w.kind === "developer"
    ) ?? null
  );
}

/**
 * NOT-118 Start: make sure the issue is queued, move its entry to position 1, then admit
 * synchronously so an idle system still starts immediately. There is no "start now, skip
 * the queue" escape hatch — when no slot is free (or the issue isn't eligible yet) it waits
 * at the top of the queue with a reason, and is the next one admitted.
 *
 * Every route/CLI/agent start path goes through here. The one ungated exception is a human
 * action resuming a workflow (resolveHumanActionAndAdvance → startWorkflowCore), which may
 * briefly exceed capacity by design (NOT-103 decision 5).
 */
export async function startIssueViaQueue(issueId: string): Promise<StartIssueOutcome> {
  const issue = getIssue(issueId);
  if (!issue) return { state: "error", code: 404, error: "Issue not found" };
  if (getActiveWorkflowInstance(issueId)) {
    return { state: "error", code: 409, error: activeWorkflowConflictMessage(issueId) };
  }
  if (issue.status !== "ready" && issue.status !== "needs_human") {
    return { state: "error", code: 409, error: `Issue is ${issue.status} — not startable` };
  }

  try {
    enqueueIssue(issueId); // idempotent when it is already queued
  } catch (err) {
    // Only reachable if the issue turned terminal / started between the checks above and
    // here; enqueueIssue tags those with an HTTP code.
    const code = (err as { code?: number }).code ?? 409;
    return { state: "error", code, error: err instanceof Error ? err.message : String(err) };
  }
  moveQueueEntryToTop(issueId);

  const admitted = await admitNext();
  if (admitted?.issueId === issueId) {
    return { state: "admitted", instance: admitted.instance, workItem: admitted.workItem };
  }

  const queued = queueStatusForIssue(issueId);
  if (queued) return { state: "queued", ...queued };

  // No longer queued and not admitted by this call — a concurrent coordinator tick admitted
  // it between the enqueue and the walk, or an operator dequeued it mid-flight.
  const instance = getActiveWorkflowInstance(issueId);
  const workItem = instance ? developerWorkItemFor(issueId, instance.id) : null;
  if (instance && workItem) return { state: "admitted", instance, workItem };
  return { state: "error", code: 409, error: "Issue left the queue before it could start" };
}

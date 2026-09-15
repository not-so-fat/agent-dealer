// packages/server/src/coordinator/admission.ts
//
// NOT-103: when to call startWorkflowCore on which queued issue.
// Order (queue_entries) + eligibility rules + CapacityPolicy — not a second execution engine.

import type { AgentProfile, Issue, IssueStatus } from "@agent-dealer/shared";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { healthForAgent } from "../adapters/agent-health.js";
import { getDb } from "../db/index.js";
import { getAgent } from "../repository/agents.js";
import { getIssue, listIssues } from "../repository/issues.js";
import {
  getQueuedEntryForIssue,
  listQueuedEntries,
  markQueueEntryAdmitted,
  markQueueEntryRemoved,
  setQueueWaitReason,
} from "../repository/queue-entries.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";
import { getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { checkIssueReadiness, startWorkflowCore, StartPreconditionError } from "./commands.js";

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
export async function admitNext(): Promise<{ issueId: string } | null> {
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
      getDb().transaction(() => {
        // Dequeue race: operator may have removed the entry during async eligibility checks.
        if (!getQueuedEntryForIssue(entry.issueId)) {
          throw new StartPreconditionError(409, "queue entry no longer queued");
        }
        // Re-check capacity inside the txn so a concurrent Manual Start cannot double-admit.
        if (capacityPolicy(listOccupyingIssues()) <= 0) {
          throw new StartPreconditionError(409, "no free admission slots");
        }
        // Force-admit lives inside startWorkflowCore — single owner for start-path-queue-sync.
        startWorkflowCore(entry.issueId);
      })();
      return { issueId: entry.issueId };
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

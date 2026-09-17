// packages/server/src/coordinator/usage-cap-defer.ts
//
// NOT-111: shared deferral path — requeue a leased work item until runtime availability
// returns, without spending infra attempts or (when reverting) the claim attempt_count bump.
//
// NOT-136 reuses it for a second blocker of exactly the same shape: an unreachable Agent
// Deck. Both mean "nothing was attempted and nothing is wrong with the work" — the only
// differences are what sets the retry time (a cap reports its own reset; a dead dependency
// gets exponential backoff) and how the wait reads on the timeline.

import type { Issue, WorkflowInstance, WorkflowEventType } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { transitionIssue } from "../repository/issues.js";
import { deferWorkItem, getWorkItem, type WorkItem, type WorkItemKind } from "../repository/work-items.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import { deckOutageBackoffMs, deckOutageDeferralCeilingMs } from "./deck-outage-config.js";
import { usageCapDeferralCeilingMs } from "./usage-cap-config.js";
import { workerSessionPayload } from "./session-progress.js";

export interface UsageCappedOutcome {
  kind: "usage_capped";
  until: string;
  reason: string;
  evidence?: unknown;
  /** NOT-117: when the deferred session left commits, carry infra-retry framing for resume. */
  resume?: { retryReason: string };
}

/** NOT-136: Agent Deck preflight found nothing listening. No `until` — see deckOutageBackoffMs. */
export interface DeckUnavailableOutcome {
  kind: "deck_unavailable";
  reason: string;
  evidence?: unknown;
}

export type DeferralOutcome = UsageCappedOutcome | DeckUnavailableOutcome;

const roleFor: Record<WorkItemKind, "developer" | "reviewer"> = {
  developer: "developer",
  reviewer: "reviewer",
};

function roleNoun(role: "developer" | "reviewer"): string {
  return role === "developer" ? "Developer" : "Reviewer";
}

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function usageCapDeferralStartedAt(payload: Record<string, unknown>): string | null {
  const v = payload.usageCapDeferredAt;
  return typeof v === "string" && v ? v : null;
}

export function deckOutageDeferralStartedAt(payload: Record<string, unknown>): string | null {
  const v = payload.deckUnavailableSince;
  return typeof v === "string" && v ? v : null;
}

/** How many times this item has already waited on the deck — drives the backoff curve. */
export function deckOutageDeferralCount(payload: Record<string, unknown>): number {
  const v = payload.deckUnavailableDeferrals;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function deferralCeilingExceeded(firstDeferredAt: string, nowMs = Date.now()): boolean {
  const start = Date.parse(firstDeferredAt);
  if (!Number.isFinite(start)) return false;
  return nowMs - start >= usageCapDeferralCeilingMs();
}

export function deckOutageCeilingExceeded(firstDeferredAt: string, nowMs = Date.now()): boolean {
  const start = Date.parse(firstDeferredAt);
  if (!Number.isFinite(start)) return false;
  return nowMs - start >= deckOutageDeferralCeilingMs();
}

export interface DeferWorkItemResult {
  deferred: boolean;
  escalated: boolean;
  reason?: "lease_lost" | "not_found";
}

/** One deferral: requeue behind `until`, emit worker.deferred, refresh the live intent. */
function applyDeferral(
  live: WorkItem,
  leaseToken: string,
  issue: Issue,
  instance: WorkflowInstance,
  spec: {
    until: string;
    reason: string;
    outcome: DeferralOutcome["kind"];
    error: unknown;
    payloadJson: string;
    intent: (role: "developer" | "reviewer", untilLabel: string) => string;
  }
): DeferWorkItemResult {
  const updated = deferWorkItem(live.id, leaseToken, {
    availableAt: spec.until,
    error: spec.error,
    revertAttemptCount: true,
    payloadJson: spec.payloadJson,
  });
  if (!updated) return { deferred: false, escalated: false, reason: "lease_lost" };

  const role = roleFor[live.kind];
  const session = live.workerSessionId ? getWorkerSession(live.workerSessionId) : null;
  appendWorkflowEvent({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    workerSessionId: live.workerSessionId,
    type: "worker.deferred",
    actorType: role,
    stage: issue.status,
    round: live.round,
    payload: {
      ...workerSessionPayload({
        runtime: session?.runtime ?? null,
        model: session?.model ?? null,
        sessionId: live.workerSessionId ?? "",
        worktreePath: session?.worktreePath,
      }),
      reason: spec.reason,
      until: spec.until,
      outcome: spec.outcome,
    },
  });

  transitionIssue(issue.id, issue.status, {
    currentOwner: role,
    currentIntent: spec.intent(role, timeLabel(spec.until)),
  });

  return { deferred: true, escalated: false };
}

/** The leased item must still be ours before anything is written. */
function liveLeasedItem(itemId: string, leaseToken: string): WorkItem | null {
  const live = getWorkItem(itemId);
  if (!live || live.status !== "leased" || live.leaseToken !== leaseToken) return null;
  return live;
}

/**
 * Requeue a leased item for usage-cap deferral, emit worker.deferred, and refresh intent.
 * When the per-item deferral ceiling is exceeded, returns escalated=true so the caller can
 * route to policy_escalation instead.
 */
export function deferLeasedWorkItemForUsageCap(
  item: WorkItem,
  leaseToken: string,
  cap: UsageCappedOutcome,
  issue: Issue,
  instance: WorkflowInstance
): DeferWorkItemResult {
  return getDb().transaction(() => {
    const live = liveLeasedItem(item.id, leaseToken);
    if (!live) return { deferred: false, escalated: false, reason: "lease_lost" as const };

    const payload = parsePayload(live.payloadJson);
    const firstDeferredAt = usageCapDeferralStartedAt(payload) ?? new Date().toISOString();
    if (deferralCeilingExceeded(firstDeferredAt)) {
      return { deferred: false, escalated: true };
    }

    return applyDeferral(live, leaseToken, issue, instance, {
      until: cap.until,
      reason: cap.reason,
      outcome: "usage_capped",
      error: { kind: "usage_capped", until: cap.until, reason: cap.reason, evidence: cap.evidence },
      payloadJson: JSON.stringify({
        ...payload,
        usageCapDeferredAt: firstDeferredAt,
        ...(cap.resume?.retryReason ? { retryReason: cap.resume.retryReason } : {}),
      }),
      intent: (role, untilLabel) => `${roleNoun(role)} deferred — ${cap.reason} (until ${untilLabel})`,
    });
  })();
}

/**
 * NOT-136: the same deferral for an unreachable Agent Deck. The retry time is computed here
 * (not supplied by the caller) so the backoff curve has a single owner and counts *this
 * item's* consecutive waits — an effect that only sees one failed preflight cannot know it.
 */
export function deferLeasedWorkItemForDeckOutage(
  item: WorkItem,
  leaseToken: string,
  outage: DeckUnavailableOutcome,
  issue: Issue,
  instance: WorkflowInstance,
  nowMs = Date.now()
): DeferWorkItemResult {
  return getDb().transaction(() => {
    const live = liveLeasedItem(item.id, leaseToken);
    if (!live) return { deferred: false, escalated: false, reason: "lease_lost" as const };

    const payload = parsePayload(live.payloadJson);
    const firstDeferredAt = deckOutageDeferralStartedAt(payload) ?? new Date(nowMs).toISOString();
    if (deckOutageCeilingExceeded(firstDeferredAt, nowMs)) {
      return { deferred: false, escalated: true };
    }

    const priorDeferrals = deckOutageDeferralCount(payload);
    const until = new Date(nowMs + deckOutageBackoffMs(priorDeferrals)).toISOString();

    return applyDeferral(live, leaseToken, issue, instance, {
      until,
      reason: outage.reason,
      outcome: "deck_unavailable",
      error: { kind: "deck_unavailable", until, reason: outage.reason, evidence: outage.evidence },
      payloadJson: JSON.stringify({
        ...payload,
        deckUnavailableSince: firstDeferredAt,
        deckUnavailableDeferrals: priorDeferrals + 1,
      }),
      intent: (_role, untilLabel) => `Waiting for Agent Deck — ${outage.reason} (retrying ${untilLabel})`,
    });
  })();
}

export function formatCapEscalationReason(cap: UsageCappedOutcome, firstDeferredAt: string): string {
  const hours = Math.round(usageCapDeferralCeilingMs() / 3_600_000);
  return `${cap.reason} Work deferred for over ${hours}h (since ${firstDeferredAt}).`;
}

export function formatDeckOutageEscalationReason(
  outage: DeckUnavailableOutcome,
  firstDeferredAt: string
): string {
  const hours = Math.round(deckOutageDeferralCeilingMs() / 3_600_000);
  return `${outage.reason} Agent Deck has been unreachable for over ${hours}h (since ${firstDeferredAt}).`;
}

/** Event types for a cap escalation after the deferral ceiling — mirrors worker.failed routing. */
export function capEscalationEvents(): WorkflowEventType[] {
  return ["worker.failed"];
}

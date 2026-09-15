// packages/server/src/coordinator/usage-cap-defer.ts
//
// NOT-111: shared deferral path — requeue a leased work item until runtime availability
// returns, without spending infra attempts or (when reverting) the claim attempt_count bump.

import type { Issue, WorkflowInstance, WorkflowEventType } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { transitionIssue } from "../repository/issues.js";
import { deferWorkItem, getWorkItem, type WorkItem, type WorkItemKind } from "../repository/work-items.js";
import { getWorkerSession } from "../repository/worker-sessions.js";
import { usageCapDeferralCeilingMs } from "./usage-cap-config.js";
import { workerSessionPayload } from "./session-progress.js";

export interface UsageCappedOutcome {
  kind: "usage_capped";
  until: string;
  reason: string;
  evidence?: unknown;
}

const roleFor: Record<WorkItemKind, "developer" | "reviewer"> = {
  developer: "developer",
  reviewer: "reviewer",
};

function parsePayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function usageCapDeferralStartedAt(payload: Record<string, unknown>): string | null {
  const v = payload.usageCapDeferredAt;
  return typeof v === "string" && v ? v : null;
}

export function deferralCeilingExceeded(firstDeferredAt: string, nowMs = Date.now()): boolean {
  const start = Date.parse(firstDeferredAt);
  if (!Number.isFinite(start)) return false;
  return nowMs - start >= usageCapDeferralCeilingMs();
}

export interface DeferWorkItemResult {
  deferred: boolean;
  escalated: boolean;
  reason?: "lease_lost" | "not_found";
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
    const live = getWorkItem(item.id);
    if (!live || live.status !== "leased" || live.leaseToken !== leaseToken) {
      return { deferred: false, escalated: false, reason: "lease_lost" as const };
    }

    const payload = parsePayload(live.payloadJson);
    const firstDeferredAt = usageCapDeferralStartedAt(payload) ?? new Date().toISOString();
    if (deferralCeilingExceeded(firstDeferredAt)) {
      return { deferred: false, escalated: true };
    }

    const mergedPayload = {
      ...payload,
      usageCapDeferredAt: firstDeferredAt,
    };

    const updated = deferWorkItem(live.id, leaseToken, {
      availableAt: cap.until,
      error: { kind: "usage_capped", until: cap.until, reason: cap.reason, evidence: cap.evidence },
      revertAttemptCount: true,
      payloadJson: JSON.stringify(mergedPayload),
    });
    if (!updated) return { deferred: false, escalated: false, reason: "lease_lost" as const };

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
        reason: cap.reason,
        until: cap.until,
        outcome: "usage_capped",
      },
    });

    const untilLabel = new Date(cap.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    transitionIssue(issue.id, issue.status, {
      currentOwner: role,
      currentIntent: `${role === "developer" ? "Developer" : "Reviewer"} deferred — ${cap.reason} (until ${untilLabel})`,
    });

    return { deferred: true, escalated: false };
  })();
}

export function formatCapEscalationReason(cap: UsageCappedOutcome, firstDeferredAt: string): string {
  const hours = Math.round(usageCapDeferralCeilingMs() / 3_600_000);
  return `${cap.reason} Work deferred for over ${hours}h (since ${firstDeferredAt}).`;
}

/** Event types for a cap escalation after the deferral ceiling — mirrors worker.failed routing. */
export function capEscalationEvents(): WorkflowEventType[] {
  return ["worker.failed"];
}

// packages/server/src/coordinator/commands.ts
//
// The coordinator kernel's write path. Every command is one short SQLite transaction that
// records the validated issue transition, the workflow event(s), and exactly one next
// durable effect (a queued work item, a human action, or workflow completion) together —
// so a process crash at any point either applies the whole step or none of it, and a
// duplicate delivery is a no-op. The effect *work* itself runs elsewhere, through a leased
// worker whose structured result comes back into applyCompletion.
import type {
  HumanAction,
  HumanActionType,
  Issue,
  WorkflowInstance,
  WorkflowEventType,
} from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import {
  getIssue,
  incrementIssueRound,
  incrementIssueInfraAttempts,
  resetIssueInfraAttempts,
  grantReviewRetry,
  transitionIssue,
  type TransitionIssuePatch,
} from "../repository/issues.js";
import {
  appendWorkflowEvent,
  completeWorkflowInstance,
  getActiveWorkflowInstance,
  getWorkflowInstance,
  startWorkflowInstance,
  WorkflowAlreadyActiveError,
} from "../repository/workflow-events.js";
import {
  createHumanAction,
  findOpenHumanAction,
  getHumanAction,
  listHumanActionsForIssue,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { reconcileFinding } from "../repository/findings.js";
import { getAgent } from "../repository/agents.js";
import { githubIssuesSync } from "../adapters/agent-health.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import {
  cancelWorkItem,
  enqueueWorkItem,
  finishWorkItem,
  getWorkItem,
  listWorkItemsForIssue,
  type WorkItem,
  type WorkItemKind,
} from "../repository/work-items.js";
import { completeSession, getWorkerSession, listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { killRunProcess } from "../runners/spawn-cli.js";
import { buildProfileSnapshot, serializeProfileSnapshot } from "./profile-snapshot.js";
import { workerSessionPayload } from "./session-progress.js";
import { reasonForWorkerFailedEvent } from "./failure-reason.js";
import {
  routeDeveloperOutcome,
  routeReviewerOutcome,
  type DeveloperOutcome,
  type ReviewerOutcome,
} from "./routing.js";
import { projectDeveloperRoute, projectReviewerRoute, type IssueProjection } from "./projection.js";
import { parseHumanResolution, resolveHumanActionOutcome, type HumanResolution } from "./human-resolution.js";
import { AUTO_MERGE_INTENT, finalizeAutoMerge } from "./auto-merge.js";
import {
  capEscalationEvents,
  deferLeasedWorkItemForUsageCap,
  formatCapEscalationReason,
  usageCapDeferralStartedAt,
  type UsageCappedOutcome,
} from "./usage-cap-defer.js";
import { markQueueEntryAdmitted } from "../repository/queue-entries.js";

export const WORKFLOW_VERSION = "dev_reviewer_v1";

/** NOT-103 queue admission reads the same cap state as the coordinator deferral path. */
export { runtimeAvailability } from "../repository/runtime-availability.js";

/**
 * The frozen issue-level snapshot design §"Prepare task snapshot" requires: written once,
 * at workflow start, so a later edit to the issue (were an edit route to ever exist) can
 * never change what a queued or running session sees. Persisted as an artifact — the
 * developer prompt builder (NOT-61) reads this instead of live issue fields.
 */
export const TASK_SNAPSHOT_ARTIFACT_KIND = "task_snapshot";

export interface TaskSnapshotContent {
  title: string;
  description: string;
  acceptanceCriteria: string;
  repo: string;
  baseBranch: string;
  workflowVersion: string;
}

/** Reads the frozen snapshot back; falls back to live issue fields for an item queued before NOT-61. */
export function getTaskSnapshot(issue: Issue): TaskSnapshotContent {
  const artifact = latestIssueArtifact(issue.id, TASK_SNAPSHOT_ARTIFACT_KIND);
  if (artifact?.contentJson) {
    try {
      return JSON.parse(artifact.contentJson) as TaskSnapshotContent;
    } catch {
      // fall through to the live-field fallback below
    }
  }
  return {
    title: issue.title,
    description: issue.description ?? "",
    acceptanceCriteria: issue.acceptanceCriteria ?? "",
    repo: issue.repo,
    baseBranch: issue.baseBranch,
    workflowVersion: WORKFLOW_VERSION,
  };
}

function freezeTaskSnapshot(issue: Issue): void {
  createIssueArtifact({
    issueId: issue.id,
    kind: TASK_SNAPSHOT_ARTIFACT_KIND,
    author: "system",
    content: {
      title: issue.title,
      description: issue.description ?? "",
      acceptanceCriteria: issue.acceptanceCriteria ?? "",
      repo: issue.repo,
      baseBranch: issue.baseBranch,
      workflowVersion: WORKFLOW_VERSION,
    } satisfies TaskSnapshotContent,
  });
}

/**
 * Freeze the role's execution profile at the moment the work item is enqueued (NOT-60):
 * an edit to the agent profile after this — even before a dispatcher claims the item —
 * never changes the eventual session. The worker loop consumes this off the payload and
 * only falls back to a live resolve for a legacy item queued before snapshots were carried.
 */
function queuedProfileSnapshot(issue: Issue, kind: WorkItemKind): string | null {
  const agentId = kind === "developer" ? issue.developerAgentId : issue.reviewerAgentId;
  const agent = agentId ? getAgent(agentId) : null;
  return agent ? serializeProfileSnapshot(buildProfileSnapshot(agent, kind)) : null;
}

export type StartResult =
  | { ok: true; instance: WorkflowInstance; workItem: WorkItem }
  | { ok: "needs_scope_decision"; action: HumanAction }
  | { ok: false; code: number; error: string };

const REQUIRED_FIELDS: Array<[keyof Issue, string]> = [
  ["title", "title"],
  ["repo", "repo"],
  ["developerAgentId", "developer profile"],
  ["reviewerAgentId", "reviewer profile"],
];

export class StartPreconditionError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

export interface IssueReadiness {
  ok: boolean;
  missing: string[];
}

/**
 * Pure readiness check reused by startWorkflowCore's hard precondition (throws below)
 * and by GET /api/issues/:id's read-only `readiness` field, so "what makes an issue
 * startable" has exactly one definition instead of drifting between the write and
 * read paths.
 */
export function checkIssueReadiness(issue: Issue): IssueReadiness {
  const missing: string[] = [];
  for (const [field, label] of REQUIRED_FIELDS) {
    const value = issue[field];
    if (value === null || value === undefined || String(value).trim() === "") {
      missing.push(label);
    }
  }
  if (!issue.acceptanceCriteria || !issue.acceptanceCriteria.trim()) {
    missing.push("acceptance criteria");
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Close a stale pre-start `product_scope_decision` that was opened when acceptance criteria
 * were missing, then later filled in (PATCH / resolve-by-start). Shared by Manual Start,
 * admission, and any other startWorkflowCore caller so a gate never stays open beside a
 * running workflow (resolving it later would enqueue a second developer work item).
 */
function clearStaleProductScopeDecision(issue: Issue): void {
  const openScopeDecision = findOpenHumanAction(issue.id, "product_scope_decision");
  if (!openScopeDecision) return;
  resolveHumanAction(openScopeDecision.id, "system", { choice: "resume" });
  appendWorkflowEvent({
    issueId: issue.id,
    type: "human_action.resolved",
    actorType: "system",
    stage: issue.status,
    payload: { actionType: "product_scope_decision", choice: "resume" },
  });
}

/**
 * The instance + `workflow.started` event + issue transition + round-1 developer work item,
 * all as unconditional writes. Throws on any precondition failure so a caller that runs this
 * inside its own transaction (see resolveHumanActionAndAdvance / admitNext) rolls the whole
 * step back. Must be called within a transaction.
 *
 * Exported for NOT-103 admission — callers must already have verified readiness so they
 * never open a `product_scope_decision` (that path lives only on startWorkflow). Opening
 * the gate stays on startWorkflow; clearing a stale gate after AC lands lives here so
 * admitNext cannot leave it dangling.
 */
export function startWorkflowCore(issueId: string): { instance: WorkflowInstance; workItem: WorkItem } {
  const issue = getIssue(issueId);
  if (!issue) throw new StartPreconditionError(404, "Issue not found");
  if (issue.status !== "ready" && issue.status !== "needs_human") {
    throw new StartPreconditionError(409, `Issue is ${issue.status} — not startable`);
  }
  if (getActiveWorkflowInstance(issueId)) {
    // A bare 409 here is a dead end for a caller (UI hides Start in this state, but the CLI/
    // API do not) — if a human action is already open, name it so the operator resolves that
    // instead of retrying Start against the same active instance (ticket: Start must not be
    // the only visible control that fails with an opaque conflict while a human gate is open).
    const openAction = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
    throw new StartPreconditionError(
      409,
      openAction
        ? `Issue already has an active workflow — resolve the open ${openAction.actionType} first (POST /api/human-actions/${openAction.id}/resolve): ${openAction.question}`
        : "Issue already has an active workflow"
    );
  }
  const readiness = checkIssueReadiness(issue);
  if (!readiness.ok) {
    throw new StartPreconditionError(400, `Missing required field(s): ${readiness.missing.join(", ")}`);
  }

  // Criteria were added since a pre-start gate opened — close it in the same txn as start.
  clearStaleProductScopeDecision(issue);

  const instance = startWorkflowInstance(issueId, WORKFLOW_VERSION);
  freezeTaskSnapshot(issue);
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    type: "workflow.started",
    actorType: "system",
    stage: issue.status,
    round: 1,
  });
  transitionIssue(issueId, "developing", {
    currentOwner: "developer",
    currentIntent: "Developer implementing round 1",
  });
  const workItem = enqueueWorkItem({
    issueId,
    workflowInstanceId: instance.id,
    kind: "developer",
    round: 1,
    payload: { profileSnapshot: queuedProfileSnapshot(issue, "developer") },
    idempotencyKey: `${instance.id}:developer:1`,
  });
  // NOT-103: every successful start is a force-admit — keep queue state in sync whether
  // the caller was startWorkflow, admitNext, or product_scope_decision resolve.
  markQueueEntryAdmitted(issueId);
  return { instance, workItem };
}

/**
 * Starts the issue's one `dev_reviewer_v1` workflow in a single transaction. A second call
 * while an instance is active is **rejected with 409** (not a resume-by-id — callers must
 * not assume the PRD §8 "returns its active instance" behaviour until the API layer adds
 * it). Missing acceptance criteria opens a `product_scope_decision` instead of starting.
 */
export function startWorkflow(issueId: string): StartResult {
  const issue = getIssue(issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };

  const preStart = (issue.status === "ready" || issue.status === "needs_human") && !getActiveWorkflowInstance(issueId);
  // Idempotent lookup when AC is still missing — return the existing gate rather than
  // creating a duplicate. Stale-gate cleanup after AC lands lives in startWorkflowCore.
  const openScopeDecision = preStart ? findOpenHumanAction(issueId, "product_scope_decision") : null;

  // Refuse before enqueueing a developer round when `gh` cannot open the draft PR —
  // that path otherwise burns a full agent session and lands as adapter_failure.
  if (preStart) {
    const ghIssues = githubIssuesSync();
    if (ghIssues.length > 0) {
      return { ok: false, code: 409, error: ghIssues[0]!.message };
    }
  }

  // PRD §6.1: if required product intent cannot be normalized without guessing, ask.
  if (preStart && (!issue.acceptanceCriteria || !issue.acceptanceCriteria.trim())) {
    // Idempotent: a repeated pre-criteria /start must return the action already open,
    // never pile up a duplicate every time it's called.
    if (openScopeDecision) return { ok: "needs_scope_decision", action: openScopeDecision };
    const action = createHumanAction({
      issueId,
      actionType: "product_scope_decision",
      reason: "The issue has no acceptance criteria — development needs a testable target.",
      question: "Add acceptance criteria (or an accepted task snapshot), then start the workflow.",
      responseOptions: [{ choice: "resume", label: "Acceptance criteria added — start" }],
    });
    return { ok: "needs_scope_decision", action };
  }

  try {
    // Stale product_scope_decision cleanup lives in startWorkflowCore so admitNext shares it.
    const result = getDb().transaction(() => startWorkflowCore(issueId))();
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof StartPreconditionError) return { ok: false, code: err.code, error: err.message };
    if (err instanceof WorkflowAlreadyActiveError) return { ok: false, code: 409, error: err.message };
    throw err;
  }
}

export type ApplyResult =
  | {
      applied: true;
      issueStatus: Issue["status"];
      nextWorkItemId: string | null;
      humanActionId: string | null;
      instanceCompleted: boolean;
      /** Set when auto-merge completed successfully — caller may fire reflect. */
      triggerReflect?: boolean;
      /** Internal: routing parked for auto-merge; applyCompletion finalizes outside the txn. */
      pendingAutoMerge?: boolean;
    }
  | { applied: false; reason: "already_terminal" | "lease_lost" | "no_active_instance" | "not_found" };

/**
 * Applies a leased effect's structured completion in one transaction: the item is
 * CAS-marked `done` (fenced on `leaseToken` — the ONLY path to a terminal state), then the
 * routing decision is projected onto the issue, the workflow events appended, and exactly
 * one next effect created. If the CAS matches nothing — a duplicate delivery, or a slow
 * worker whose lease was reclaimed and re-run — nothing is applied.
 *
 * When the issue opted into auto-merge and the reviewer approved, a second step runs
 * *after* the transaction (so `gh` never holds the write lock): merge the PR, then mark
 * done or escalate on failure (NOT-102).
 */
export async function applyCompletion(
  workItemId: string,
  leaseToken: string,
  outcome: DeveloperOutcome | ReviewerOutcome
): Promise<ApplyResult> {
  if (outcome.kind === "usage_capped") {
    return applyUsageCapCompletion(workItemId, leaseToken, outcome);
  }

  const routed = getDb().transaction((): ApplyResult => {
    const before = getWorkItem(workItemId);
    if (!before) return { applied: false, reason: "not_found" };
    if (before.status === "done" || before.status === "dead" || before.status === "cancelled") {
      return { applied: false, reason: "already_terminal" };
    }

    const issue = getIssue(before.issueId);
    if (!issue) return { applied: false, reason: "not_found" };
    const instance = getActiveWorkflowInstance(before.issueId);
    if (!instance || instance.id !== before.workflowInstanceId) {
      return { applied: false, reason: "no_active_instance" };
    }

    const item = finishWorkItem(workItemId, leaseToken, { status: "done", result: outcome });
    if (!item) return { applied: false, reason: "lease_lost" };

    return routeAppliedOutcome(issue, instance, item, outcome);
  })();

  if (routed.applied && routed.pendingAutoMerge) {
    // Await async `gh` merge outside the routing txn — never block the event loop with spawnSync.
    return finalizeAutoMerge(getWorkItem(workItemId)!.issueId);
  }
  return routed;
}

function parseWorkItemPayload(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** NOT-111: defer without finishing the work item or spending infra/attempt budgets. */
function applyUsageCapCompletion(
  workItemId: string,
  leaseToken: string,
  cap: UsageCappedOutcome
): ApplyResult {
  return getDb().transaction((): ApplyResult => {
    const before = getWorkItem(workItemId);
    if (!before) return { applied: false, reason: "not_found" };
    if (before.status === "done" || before.status === "dead" || before.status === "cancelled") {
      return { applied: false, reason: "already_terminal" };
    }

    const issue = getIssue(before.issueId);
    if (!issue) return { applied: false, reason: "not_found" };
    const instance = getActiveWorkflowInstance(before.issueId);
    if (!instance || instance.id !== before.workflowInstanceId) {
      return { applied: false, reason: "no_active_instance" };
    }

    const deferResult = deferLeasedWorkItemForUsageCap(before, leaseToken, cap, issue, instance);
    if (deferResult.deferred) {
      const issueNow = getIssue(issue.id)!;
      return {
        applied: true,
        issueStatus: issueNow.status,
        nextWorkItemId: before.id,
        humanActionId: null,
        instanceCompleted: false,
      };
    }
    if (deferResult.escalated) {
      const item = finishWorkItem(workItemId, leaseToken, { status: "done", result: cap });
      if (!item) return { applied: false, reason: "lease_lost" };
      return routeCapEscalation(issue, instance, item, cap);
    }
    return { applied: false, reason: "lease_lost" };
  })();
}

/**
 * Deferral ceiling exceeded — escalate with cap evidence without spending infra attempts.
 * Used when applyCompletion or the worker loop cannot defer any longer.
 */
export function routeCapEscalation(
  issue: Issue,
  instance: WorkflowInstance,
  item: WorkItem,
  cap: UsageCappedOutcome
): ApplyResult {
  const payload = parseWorkItemPayload(item.payloadJson);
  const firstDeferredAt = usageCapDeferralStartedAt(payload) ?? new Date().toISOString();
  const reason = formatCapEscalationReason(cap, firstDeferredAt);
  const role = item.kind === "developer" ? "developer" : "reviewer";

  const ev = eventEmitter(issue, instance, item.workerSessionId, "needs_human", issue.currentRound);
  for (const type of capEscalationEvents()) {
    const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
    ev.emit(type, {
      actorType: role,
      payload: {
        ...workerSessionPayload({
          runtime: session?.runtime,
          model: session?.model,
          sessionId: item.workerSessionId ?? "",
          worktreePath: session?.worktreePath,
        }),
        outcome: "usage_capped",
        until: cap.until,
        reason: cap.reason,
        evidence: cap.evidence,
      },
    });
  }

  applyProjectionTransition(
    issue,
    {
      issueStatus: "needs_human",
      currentOwner: "human",
      currentIntent: reason,
      events: capEscalationEvents(),
    },
    {}
  );

  const action = createHumanAction({
    issueId: issue.id,
    workflowInstanceId: instance.id,
    actionType: "policy_escalation",
    reason,
    question: questionFor("policy_escalation", reason),
    evidence: { usageCap: cap, firstDeferredAt },
    responseOptions: responseOptionsFor("policy_escalation"),
  });
  ev.emit("human_action.requested", { payload: { actionType: "policy_escalation", actionId: action.id } });

  return {
    applied: true,
    issueStatus: "needs_human",
    nextWorkItemId: null,
    humanActionId: action.id,
    instanceCompleted: false,
  };
}

export function routeAppliedOutcome(
  issue: Issue,
  instance: WorkflowInstance,
  item: WorkItem,
  outcome: DeveloperOutcome | ReviewerOutcome
): ApplyResult {
  return item.kind === "developer"
    ? applyDeveloper(issue, instance, item, outcome as DeveloperOutcome)
    : applyReviewer(issue, instance, item, outcome as ReviewerOutcome);
}

interface EventEmitter {
  emit: (type: WorkflowEventType, opts?: EmitOpts) => void;
}
interface EmitOpts {
  actorType?: "system" | "developer" | "reviewer" | "human";
  payload?: unknown;
  artifactRef?: string | null;
}

function eventEmitter(
  issue: Issue,
  instance: WorkflowInstance,
  workerSessionId: string | null,
  stage: string,
  round: number
): EventEmitter {
  let causation: string | null = null;
  return {
    emit(type, opts) {
      const evt = appendWorkflowEvent({
        issueId: issue.id,
        workflowInstanceId: instance.id,
        workerSessionId,
        type,
        actorType: opts?.actorType ?? (type.startsWith("worker.") ? "developer" : "system"),
        stage,
        round,
        payload: opts?.payload,
        artifactRef: opts?.artifactRef ?? null,
        causationEventId: causation,
      });
      causation = evt.id;
    },
  };
}

function applyProjectionTransition(issue: Issue, projection: IssueProjection, patch: TransitionIssuePatch): void {
  transitionIssue(issue.id, projection.issueStatus, {
    currentOwner: projection.currentOwner,
    currentIntent: projection.currentIntent,
    ...patch,
  });
}

function applyDeveloper(
  issue: Issue,
  instance: WorkflowInstance,
  item: WorkItem,
  outcome: DeveloperOutcome
): ApplyResult {
  const route = routeDeveloperOutcome(outcome, {
    currentRound: issue.currentRound,
    maxReviewRounds: issue.maxReviewRounds,
    infraAttempts: issue.infraAttempts,
    maxInfraAttempts: issue.maxInfraAttempts,
  });
  const { projection, effect, advance } = projectDeveloperRoute(route, issue.status, issue.currentRound);

  const ev = eventEmitter(issue, instance, item.workerSessionId, projection.issueStatus, issue.currentRound);

  const patch: TransitionIssuePatch = {};
  for (const type of projection.events) {
    if (type === "pull_request.opened" && outcome.kind === "clean_handoff") {
      ev.emit("pull_request.opened", {
        actorType: "system",
        payload: {
          prNumber: outcome.prNumber,
          prUrl: outcome.prUrl,
          headSha: outcome.headSha,
          baseSha: outcome.baseSha,
          branch: outcome.branch,
        },
        artifactRef: outcome.prUrl,
      });
      patch.branch = outcome.branch;
      patch.headSha = outcome.headSha;
      patch.baseSha = outcome.baseSha;
      patch.prNumber = outcome.prNumber;
      patch.prUrl = outcome.prUrl;
    } else if (type === "worker.completed" || type === "worker.failed") {
      // NOT-109: finish events use the developer role badge (same as worker.started).
      // NOT-113: worker.failed carries a human-readable reason (same pattern as worker.deferred).
      const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
      const payload: Record<string, unknown> = {
        ...workerSessionPayload({
          runtime: session?.runtime,
          model: session?.model,
          sessionId: item.workerSessionId ?? session?.id ?? "",
          worktreePath: session?.worktreePath,
        }),
        outcome: outcome.kind,
      };
      if (type === "worker.failed") {
        payload.reason = reasonForWorkerFailedEvent({
          outcome,
          routeReason: "reason" in route ? route.reason : null,
          sessionErrorJson: session?.errorJson,
          logPath: session?.logPath,
        });
      }
      ev.emit(type, {
        actorType: "developer",
        payload,
      });
    } else {
      ev.emit(type);
    }
  }

  applyProjectionTransition(issue, projection, patch);
  if (advance === "review") incrementIssueRound(issue.id);
  else if (advance === "infra") incrementIssueInfraAttempts(issue.id);
  const issueNow = getIssue(issue.id)!;

  return applyEffect(issue, instance, effect, route, issueNow, ev, item.id);
}

function applyReviewer(
  issue: Issue,
  instance: WorkflowInstance,
  item: WorkItem,
  outcome: ReviewerOutcome
): ApplyResult {
  const route = routeReviewerOutcome(
    outcome,
    {
      currentRound: issue.currentRound,
      maxReviewRounds: issue.maxReviewRounds,
      infraAttempts: issue.infraAttempts,
      maxInfraAttempts: issue.maxInfraAttempts,
      autoMerge: issue.autoMerge,
    },
    issue.headSha!
  );
  const hasVerdict = outcome.kind === "verdict";
  const { projection, effect, advance } = projectReviewerRoute(route, issue.currentRound, hasVerdict);

  const ev = eventEmitter(issue, instance, item.workerSessionId, projection.issueStatus, issue.currentRound);

  const patch: TransitionIssuePatch = {};
  for (const type of projection.events) {
    if (type === "review.submitted" && outcome.kind === "verdict") {
      ev.emit("review.submitted", { actorType: "reviewer", payload: outcome.result });
    } else if (type === "worker.completed" || type === "worker.failed") {
      const session = item.workerSessionId ? getWorkerSession(item.workerSessionId) : null;
      const payload: Record<string, unknown> = {
        ...workerSessionPayload({
          runtime: session?.runtime,
          model: session?.model,
          sessionId: item.workerSessionId ?? session?.id ?? "",
          worktreePath: session?.worktreePath,
        }),
        outcome: outcome.kind,
      };
      if (type === "worker.failed") {
        payload.reason = reasonForWorkerFailedEvent({
          outcome,
          routeReason: "reason" in route ? route.reason : null,
          sessionErrorJson: session?.errorJson,
          logPath: session?.logPath,
        });
      }
      ev.emit(type, {
        actorType: "reviewer",
        payload,
      });
    } else {
      ev.emit(type);
    }
  }
  // Record the newly observed head whenever the outcome IS a stale report — whether it's
  // being retried (retry_reviewer_at_new_head) or the infra budget is exhausted on this
  // very stale event (human_action). Gating on route.next alone missed the exhausted
  // case, leaving issue.headSha pointing at the stale pinned SHA a human "resume" would
  // then re-queue, going stale again immediately and escalating forever.
  if (outcome.kind === "stale") {
    patch.headSha = outcome.currentHeadSha;
  }

  // Thread reviewer findings across rounds (PRD §6.4) — every blocking/non-blocking finding.
  if (outcome.kind === "verdict") {
    for (const f of outcome.result.findings) {
      reconcileFinding({
        issueId: issue.id,
        fingerprint: f.fingerprint,
        severity: f.severity,
        title: f.title,
        rationale: f.rationale,
        file: f.file ?? null,
        line: f.line ?? null,
        round: issue.currentRound,
      });
    }
  }

  applyProjectionTransition(issue, projection, patch);
  if (advance === "review") incrementIssueRound(issue.id);
  else if (advance === "infra") incrementIssueInfraAttempts(issue.id);
  const issueNow = getIssue(issue.id)!;

  return applyEffect(issue, instance, effect, route, issueNow, ev, item.id, outcome);
}

type AnyRoute =
  | ReturnType<typeof routeDeveloperOutcome>
  | ReturnType<typeof routeReviewerOutcome>;

/** Every route that spends an infra attempt (projection.ts's advance === "infra") repeats
 * the same round/head, so its enqueue needs a suffix the plain round/head key doesn't
 * provide to avoid colliding with the previous (terminal) attempt's key.
 * retry_reviewer_at_new_head belongs here too — a head that cycles A→B→A would otherwise
 * re-derive attempt A's ORIGINAL key (same round, same head) and collide with that
 * now-terminal work item, leaving the issue "reviewing" with no pending item. */
function isInfraRetry(route: AnyRoute): boolean {
  return (
    route.next === "retry_developer" ||
    route.next === "retry_publish" ||
    route.next === "retry_reviewer" ||
    route.next === "retry_reviewer_at_new_head"
  );
}

function applyEffect(
  issue: Issue,
  instance: WorkflowInstance,
  effect: ReturnType<typeof projectDeveloperRoute>["effect"],
  route: AnyRoute,
  issueNow: Issue,
  ev: EventEmitter,
  causativeItemId: string,
  reviewerOutcome?: ReviewerOutcome
): ApplyResult {
  const base = {
    applied: true as const,
    issueStatus: issueNow.status,
    nextWorkItemId: null as string | null,
    humanActionId: null as string | null,
    instanceCompleted: false,
  };

  if (effect.kind === "enqueue") {
    const kind = effect.workItem;
    const headSuffix = effect.atHeadSha ? `:${effect.atHeadSha}` : "";
    // Keyed on the causative (just-completed) work item's own id, not the infraAttempts
    // counter — that counter RESETS on a human policy_escalation:resume, so a post-resume
    // retry can re-derive the exact (round, infraAttempts) pair an earlier, now-terminal,
    // pre-escalation retry already used. A work-item id is a UUID, so keying on it can
    // never collide, regardless of any counter reset (reported and reproduced by the
    // reviewer: fail→retry→exhaust→resume→fail previously returned the stale pre-escalation
    // row instead of enqueueing a new one, stranding the issue with zero pending work).
    const attemptSuffix = isInfraRetry(route) ? `:retry-of:${causativeItemId}` : "";
    if (route.next === "retry_developer_with_findings") ev.emit("repair.started");
    const next = enqueueWorkItem({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      kind,
      round: issueNow.currentRound,
      payload: {
        ...(effect.atHeadSha ? { inputSha: effect.atHeadSha } : {}),
        ...(effect.retryReason ? { retryReason: effect.retryReason } : {}),
        ...(effect.publishOnly ? { publishOnly: true } : {}),
        ...(effect.branch ? { branch: effect.branch } : {}),
        profileSnapshot: queuedProfileSnapshot(issue, kind),
      },
      idempotencyKey: `${instance.id}:${kind}:${issueNow.currentRound}${headSuffix}${attemptSuffix}`,
    });
    return { ...base, nextWorkItemId: next.id };
  }

  if (effect.kind === "human_action") {
    const actionType = effect.actionType as HumanActionType;
    // A reviewer-side infra exhaustion (session_failed/publish_failed — not a verdict) is
    // the flavor where nothing is wrong with the code/PR itself; the reviewer's own attempt
    // just couldn't proceed. Tag the continuation so resolving "resume" can re-queue a
    // fresh REVIEWER at the still-valid pinned head instead of defaulting to a developer
    // round (which would be a wasted, unrelated re-implementation).
    const resumeAsReviewer =
      actionType === "policy_escalation" &&
      reviewerOutcome !== undefined &&
      reviewerOutcome.kind !== "verdict";
    const action = createHumanAction({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      actionType,
      reason: effect.reason,
      question: questionFor(actionType, effect.reason, resumeAsReviewer),
      evidence: reviewerOutcome?.kind === "verdict" ? { review: reviewerOutcome.result } : undefined,
      // issueNow.headSha, not issue.headSha: a stale outcome that itself exhausted the
      // infra budget already patched the newly observed head onto the issue above — the
      // pre-transition issue param would still carry the stale SHA a "resume" must not reuse.
      continuationPreview: resumeAsReviewer ? { resumeRole: "reviewer", resumeHeadSha: issueNow.headSha } : undefined,
      responseOptions: responseOptionsFor(actionType, resumeAsReviewer),
    });
    if (actionType === "final_review") ev.emit("final_review.requested");
    ev.emit("human_action.requested", { payload: { actionType, actionId: action.id } });
    return { ...base, humanActionId: action.id };
  }

  if (effect.kind === "auto_merge") {
    return { ...base, pendingAutoMerge: true };
  }

  return base;
}

function questionFor(actionType: HumanActionType, reason: string, resumeAsReviewer = false): string {
  switch (actionType) {
    case "final_review":
      return "Accept and merge this work, send it back for another repair round, or close it?";
    case "attempts_exhausted":
      return "The review-round limit is reached. Retry with a fresh round, or close the issue?";
    case "policy_escalation":
      return resumeAsReviewer
        ? `${reason} Retry the review, or close the issue?`
        : `${reason} Resume development, or close the issue?`;
    case "product_scope_decision":
      return `${reason} Provide the missing decision to resume.`;
    case "deck_interaction_required":
      // Never raised through applyEffect after NOT-106 Step 2 (launch-fixed decks). Kept
      // for HumanActionType totality; ops still resolve legacy open actions via
      // resolveHumanActionAndAdvance / human-resolution.
      throw new Error("deck_interaction_required is not raised through applyEffect");
    case "reflection_interaction_required":
      // Never actually raised through applyEffect — reflect-trigger.ts creates this action
      // type directly with its own question text (NOT-94). Case exists only so this
      // function stays total over HumanActionType.
      throw new Error("reflection_interaction_required is not raised through applyEffect");
    case "outbound_delivery_interaction_required":
      // Never actually raised through applyEffect — approve-deliver.ts creates this
      // Run-scoped action type directly with its own question text (NOT-95). Case exists
      // only so this function stays total over HumanActionType.
      throw new Error("outbound_delivery_interaction_required is not raised through applyEffect");
  }
}

/** Exported for db/migrate-to-issues.ts, which must populate the same response options on
 * a migrated final_review/attempts_exhausted action — otherwise the UI parses a null
 * response_options_json as no options and renders nothing to resolve it with. */
export function responseOptionsFor(
  actionType: HumanActionType,
  resumeAsReviewer = false
): Array<{ choice: string; label: string }> {
  switch (actionType) {
    case "final_review":
      return [
        { choice: "complete", label: "Accept — merge & mark done" },
        { choice: "repair", label: "Another repair round" },
        { choice: "close", label: "Close without accepting" },
      ];
    case "attempts_exhausted":
      return [
        { choice: "retry", label: "Retry — another round" },
        { choice: "close", label: "Close" },
      ];
    case "policy_escalation":
      return [
        { choice: "resume", label: resumeAsReviewer ? "Retry review" : "Resume development" },
        { choice: "close", label: "Close" },
      ];
    case "product_scope_decision":
      return [{ choice: "resume", label: "Resume development" }];
    case "deck_interaction_required":
      // Never raised through applyEffect after NOT-106 Step 2 — see questionFor.
      throw new Error("deck_interaction_required is not raised through applyEffect");
    case "reflection_interaction_required":
      // Never actually raised through applyEffect — see questionFor's identical case.
      throw new Error("reflection_interaction_required is not raised through applyEffect");
    case "outbound_delivery_interaction_required":
      // Never actually raised through applyEffect — see questionFor's identical case.
      throw new Error("outbound_delivery_interaction_required is not raised through applyEffect");
  }
}

/** The shape `applyEffect` writes into a policy_escalation's `continuationPreview` for a
 * reviewer-origin infra exhaustion — read back by resolveHumanActionAndAdvance's "resume". */
interface ResumeContinuation {
  resumeRole?: "developer" | "reviewer";
  resumeHeadSha?: string | null;
}

function parseContinuationPreview(json: string | null): ResumeContinuation | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ResumeContinuation;
  } catch {
    return null;
  }
}

export type ResolveResult =
  | {
      ok: true;
      issueStatus: Issue["status"];
      nextWorkItemId: string | null;
      instanceCompleted: boolean;
      restarted: boolean;
      /** True after a successful merge-to-done (auto-merge or final_review:complete).
       * Reflect is a best-effort network call and cannot run inside this transaction, so the
       * caller (routes/human-actions.ts) triggers it after this result is returned. */
      triggerReflect: boolean;
      /** Internal: final_review:complete parked for undraft+merge; use
       * `resolveHumanActionAndAdvanceAsync` (or await finalizeAutoMerge) to finish. */
      pendingMerge?: boolean;
    }
  | { ok: false; code: number; error: string };

/**
 * Resolves an open human action and applies its workflow outcome in one transaction:
 * PRD §6.3's continue / repair / complete / close. A pre-start `product_scope_decision`
 * (no active instance) is resolved and the workflow started fresh.
 *
 * `final_review:complete` parks for undraft+merge (same finalize as auto-merge) and
 * returns `pendingMerge: true` — callers that need the merge to finish must use
 * `resolveHumanActionAndAdvanceAsync` (HTTP/CLI) rather than this sync entry point alone.
 */
export function resolveHumanActionAndAdvance(
  actionId: string,
  resolvedBy: string,
  choice: string
): ResolveResult {
  const action = getHumanAction(actionId);
  if (!action) return { ok: false, code: 404, error: "Human action not found" };
  if (action.status !== "open") return { ok: false, code: 409, error: "Human action already resolved" };

  const resolution = parseHumanResolution(action.actionType, choice);
  if (!resolution) {
    return { ok: false, code: 400, error: `Invalid choice "${choice}" for ${action.actionType}` };
  }
  // parseHumanResolution already rejects every Run-scoped action type (NOT-95) above, so
  // every action reaching here is Issue-scoped — this narrows action.issueId for TS.
  if (!action.issueId) return { ok: false, code: 500, error: "Human action has no issue" };

  const issue = getIssue(action.issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };
  const instance = getActiveWorkflowInstance(action.issueId);

  // NOT-102: human accept must undraft+merge (never mark done while leaving a draft PR).
  // Park like auto-merge, then the async wrapper runs finalizeAutoMerge outside this txn.
  if (instance && resolution.actionType === "final_review" && resolution.choice === "complete") {
    return getDb().transaction((): ResolveResult => {
      resolveHumanAction(actionId, resolvedBy, { choice });
      appendWorkflowEvent({
        issueId: issue.id,
        workflowInstanceId: instance.id,
        type: "human_action.resolved",
        actorType: "human",
        actorRef: resolvedBy,
        stage: "final_review",
        round: issue.currentRound,
        payload: { actionType: "final_review", choice: "complete", pendingMerge: true },
      });
      transitionIssue(issue.id, "final_review", {
        currentOwner: "system",
        currentIntent: AUTO_MERGE_INTENT,
      });
      return {
        ok: true,
        issueStatus: "final_review",
        nextWorkItemId: null,
        instanceCompleted: false,
        restarted: false,
        triggerReflect: false,
        pendingMerge: true,
      };
    })();
  }

  // Pre-start product_scope_decision: resolve the action AND start the workflow in one
  // transaction. If the start still can't proceed (criteria not actually added), the whole
  // step rolls back and the action stays open — never a resolved action with no workflow.
  if (!instance) {
    // A migration-imported final_review/attempts_exhausted action: its workflow_instance_id
    // points at the completed legacy_v0 instance the cutover created (design
    // §"Migration and cutover"), never an active one — resolveHumanActionOutcome's normal
    // path (below) assumes an active instance to advance and cannot apply here.
    if (action.actionType === "final_review" || action.actionType === "attempts_exhausted") {
      return resolveLegacyTerminalAction(action, issue, resolvedBy, resolution);
    }
    if (action.actionType !== "product_scope_decision") {
      return { ok: false, code: 409, error: "No active workflow for this action" };
    }
    try {
      return getDb().transaction((): ResolveResult => {
        resolveHumanAction(actionId, resolvedBy, { choice });
        appendWorkflowEvent({
          issueId: issue.id,
          type: "human_action.resolved",
          actorType: "human",
          actorRef: resolvedBy,
          stage: issue.status,
          payload: { actionType: action.actionType, choice },
        });
        const { workItem } = startWorkflowCore(issue.id);
        return {
          ok: true,
          issueStatus: getIssue(issue.id)!.status,
          nextWorkItemId: workItem.id,
          instanceCompleted: false,
          restarted: true,
          triggerReflect: false,
        };
      })();
    } catch (err) {
      if (err instanceof StartPreconditionError) {
        return {
          ok: false,
          code: err.code === 400 ? 409 : err.code,
          error: `Cannot start the workflow yet: ${err.message}. Add acceptance criteria, then resolve.`,
        };
      }
      throw err;
    }
  }

  const outcome = resolveHumanActionOutcome(resolution);

  // A reviewer-origin infra escalation (session_failed/publish_failed exhausted) tagged
  // its continuation with where to resume: nothing was wrong with the code/PR, only the
  // reviewer session/publish attempt kept failing, so "resume" must re-queue a reviewer
  // at the still-valid pinned head — not default to an unrelated developer round.
  const continuation = parseContinuationPreview(action.continuationPreviewJson);
  const resumeAsReviewer =
    (action.actionType === "policy_escalation" || action.actionType === "deck_interaction_required") &&
    resolution.choice === "resume" &&
    continuation?.resumeRole === "reviewer" &&
    !!continuation.resumeHeadSha;

  // "review"/"review_grant" advance current_round before the next session is queued;
  // "infra"/"none" queue at the round current_round is already at. Computed up front so
  // currentIntent's round number matches the round the queued work item actually carries
  // (previously this always said currentRound + 1, which was wrong for infra/none).
  const nextRound =
    outcome.roundKind === "review" || outcome.roundKind === "review_grant" ? issue.currentRound + 1 : issue.currentRound;
  const resumeStatus = resumeAsReviewer ? "reviewing" : outcome.issueStatus;

  return getDb().transaction((): ResolveResult => {
    resolveHumanAction(actionId, resolvedBy, { choice });
    // stage must be the status this resolution actually lands on (resumeStatus), not the
    // generic developer-resume outcome.issueStatus — otherwise a reviewer resume's own
    // human_action.resolved/repair.started events would be recorded under "developing"
    // even though the issue transitions to "reviewing".
    const ev = eventEmitter(issue, instance, null, resumeStatus, issue.currentRound);
    ev.emit("human_action.resolved", {
      actorType: "human",
      payload: { actionType: action.actionType, choice },
    });

    transitionIssue(issue.id, resumeStatus, {
      currentOwner:
        resumeStatus === "done" || resumeStatus === "closed" ? "system" : resumeAsReviewer ? "reviewer" : "developer",
      currentIntent:
        resumeStatus === "done"
          ? "Complete"
          : resumeStatus === "closed"
            ? "Closed"
            : resumeAsReviewer
              ? `Reviewer re-evaluating at ${continuation!.resumeHeadSha!.slice(0, 8)}`
              : `Developer implementing round ${nextRound}`,
    });

    if (outcome.workflowOutcome) {
      completeWorkflowInstance(instance.id, outcome.workflowOutcome);
      ev.emit(outcome.workflowOutcome === "done" ? "issue.completed" : "issue.closed");
      return {
        ok: true,
        issueStatus: getIssue(issue.id)!.status,
        nextWorkItemId: null,
        instanceCompleted: true,
        restarted: false,
        triggerReflect: outcome.triggerReflect === true,
      };
    }

    // Another round: spend the budget this resolution's roundKind names, then queue the
    // resumed effect — a reviewer at the pinned head for a reviewer-origin infra
    // escalation, a fresh developer round otherwise.
    switch (outcome.roundKind) {
      case "review_grant":
        grantReviewRetry(issue.id);
        break;
      case "review":
        incrementIssueRound(issue.id);
        break;
      case "infra":
        resetIssueInfraAttempts(issue.id);
        break;
      case "none":
      case undefined:
        break;
    }
    const issueNow = getIssue(issue.id)!;
    // A reviewer resume is a retry of the review, not a repair round — mirrors
    // projection.ts's own retry_reviewer, which likewise emits no "started" marker.
    if (!resumeAsReviewer) ev.emit("repair.started");
    // Keyed on the resolved human action, not the round/attempt counters: a
    // "infra" resume resets infra_attempts to 0 every time, so a counter-based key would
    // collide across repeated escalate→resume cycles within the same round.
    const next = resumeAsReviewer
      ? enqueueWorkItem({
          issueId: issue.id,
          workflowInstanceId: instance.id,
          kind: "reviewer",
          round: issueNow.currentRound,
          payload: { inputSha: continuation!.resumeHeadSha, profileSnapshot: queuedProfileSnapshot(issue, "reviewer") },
          idempotencyKey: `${instance.id}:reviewer:resume:${action.id}`,
        })
      : enqueueWorkItem({
          issueId: issue.id,
          workflowInstanceId: instance.id,
          kind: "developer",
          round: issueNow.currentRound,
          payload: { profileSnapshot: queuedProfileSnapshot(issue, "developer") },
          idempotencyKey: `${instance.id}:developer:resume:${action.id}`,
        });
    return {
      ok: true,
      issueStatus: getIssue(issue.id)!.status,
      nextWorkItemId: next.id,
      instanceCompleted: false,
      restarted: false,
      triggerReflect: false,
    };
  })();
}

/**
 * HTTP/CLI entry: same as `resolveHumanActionAndAdvance`, but when `final_review:complete`
 * parks for merge, awaits undraft+merge (`finalizeAutoMerge`) before returning.
 */
export async function resolveHumanActionAndAdvanceAsync(
  actionId: string,
  resolvedBy: string,
  choice: string
): Promise<ResolveResult> {
  const result = resolveHumanActionAndAdvance(actionId, resolvedBy, choice);
  if (!result.ok || !result.pendingMerge) return result;

  const action = getHumanAction(actionId);
  if (!action?.issueId) {
    return { ok: false, code: 500, error: "Human action missing issue after merge park" };
  }

  const merged = await finalizeAutoMerge(action.issueId);
  return {
    ok: true,
    issueStatus: merged.issueStatus,
    nextWorkItemId: null,
    instanceCompleted: merged.instanceCompleted,
    restarted: false,
    triggerReflect: merged.triggerReflect,
  };
}

/**
 * Resolves a migration-imported final_review/attempts_exhausted action whose
 * `workflowInstanceId` points at the completed `legacy_v0` instance the NOT-66 cutover
 * created — never an active one, so resolveHumanActionOutcome's normal path (which assumes
 * an active instance to advance a round within, or complete) does not apply. Design
 * §"Migration and cutover": these actions are "resolved as legacy terminal decisions or
 * followed by an explicit new workflow start—they never reactivate legacy_v0." This never
 * queues a work item and never touches legacy_v0's completed_at/outcome (already set at
 * migration time); "repair"/"retry" only moves the issue to (or leaves it at) `needs_human`,
 * from which `POST /api/issues/:id/start` can begin a genuinely new `dev_reviewer_v1`
 * instance — that request is a deliberate separate step, not something this resolution
 * triggers itself.
 */
function resolveLegacyTerminalAction(
  action: HumanAction,
  issue: Issue,
  resolvedBy: string,
  resolution: HumanResolution
): ResolveResult {
  let nextStatus: Issue["status"];
  if (resolution.choice === "close") {
    nextStatus = "closed";
  } else if (resolution.actionType === "final_review" && resolution.choice === "complete") {
    nextStatus = "done";
  } else if (resolution.actionType === "final_review" && resolution.choice === "repair") {
    nextStatus = "needs_human";
  } else if (resolution.actionType === "attempts_exhausted" && resolution.choice === "retry") {
    nextStatus = "needs_human"; // already the issue's current status for a migrated attempts_exhausted action
  } else {
    // Unreachable given parseHumanResolution already validated `resolution` against this
    // exact action type's choices — defense in depth, matching resolveHumanActionOutcome's
    // own "every branch explicit" convention.
    return { ok: false, code: 400, error: `Invalid choice "${resolution.choice}" for ${resolution.actionType}` };
  }

  // Referenced for audit continuity in the emitted event only — never completed again or
  // otherwise mutated; it was already terminal when the migration created it.
  const historicalInstance = action.workflowInstanceId ? getWorkflowInstance(action.workflowInstanceId) : null;

  return getDb().transaction((): ResolveResult => {
    resolveHumanAction(action.id, resolvedBy, { choice: resolution.choice });
    appendWorkflowEvent({
      issueId: issue.id,
      workflowInstanceId: historicalInstance?.id ?? null,
      type: "human_action.resolved",
      actorType: "human",
      actorRef: resolvedBy,
      stage: nextStatus,
      payload: { actionType: action.actionType, choice: resolution.choice, legacyTerminalResolution: true },
    });
    if (nextStatus !== issue.status) {
      transitionIssue(issue.id, nextStatus, {
        // needs_human still means a human owns getting this issue moving again (an
        // explicit new workflow start) — matching the migration's own owner:"human" for
        // that status, not "system", which would wrongly claim nothing is waiting on a
        // person.
        currentOwner: nextStatus === "needs_human" ? "human" : "system",
        currentIntent:
          nextStatus === "done"
            ? "Complete"
            : nextStatus === "closed"
              ? "Closed"
              : "Awaiting an explicit new workflow start",
      });
    }
    return {
      ok: true,
      issueStatus: getIssue(issue.id)!.status,
      nextWorkItemId: null,
      instanceCompleted: false,
      restarted: false,
      triggerReflect: false,
    };
  })();
}

export type AbortResult =
  | { ok: true; issueStatus: Issue["status"]; alreadyClosed: boolean }
  | { ok: false; code: number; error: string };

export interface AbortIssueDeps {
  killProcess: (sessionId: string) => boolean;
}

const defaultAbortDeps: AbortIssueDeps = { killProcess: killRunProcess };

interface AbortTxResult {
  alreadyClosed: boolean;
  issueStatus: Issue["status"];
  runningSessionIds: string[];
}

/**
 * NOT-83: the operator escape hatch for one issue. Idempotent — a repeated call once the
 * issue is already `done`/`closed` returns that state with no new event
 * (ISSUE_STATUS_TRANSITIONS has no outgoing edges from either, so transitionIssue would
 * otherwise throw). That terminal re-check is done INSIDE the transaction (re-reading the
 * issue there, not trusting the pre-transaction read above it) — otherwise two concurrent
 * aborts on the same issue could both pass the outer check and the loser would crash on
 * `transitionIssue`'s "closed → closed" instead of returning `alreadyClosed: true`.
 * Otherwise, one transaction terminalizes every durable piece of the workflow (work item,
 * open human actions, worker sessions, the issue itself, and — if one is active — the
 * workflow instance), and only after that commits does it reach outside the DB to SIGTERM a
 * still-running session's child process. Fencing a late completion needs no extra code
 * here: cancelWorkItem flips the item off `leased`/`pending`, so the in-flight attempt's
 * own lease-token-fenced finishWorkItem CAS simply stops matching when it eventually calls
 * applyCompletion.
 */
export function abortIssue(issueId: string, resolvedBy: string, deps: AbortIssueDeps = defaultAbortDeps): AbortResult {
  if (!getIssue(issueId)) return { ok: false, code: 404, error: "Issue not found" };

  const tx = getDb().transaction((): AbortTxResult => {
    const issue = getIssue(issueId)!;
    if (issue.status === "done" || issue.status === "closed") {
      return { alreadyClosed: true, issueStatus: issue.status, runningSessionIds: [] };
    }

    const instance = getActiveWorkflowInstance(issueId);

    for (const item of listWorkItemsForIssue(issueId)) {
      if (item.status === "pending" || item.status === "leased") {
        cancelWorkItem(item.id);
      }
    }

    for (const action of listHumanActionsForIssue(issueId)) {
      if (action.status === "open") {
        resolveHumanAction(action.id, resolvedBy, { reason: "aborted_by_user" });
      }
    }

    const running: string[] = [];
    for (const session of listWorkerSessionsForIssue(issueId)) {
      if (session.status === "queued" || session.status === "running") {
        if (session.status === "running") running.push(session.id);
        completeSession(session.id, {
          status: "cancelled",
          errorJson: JSON.stringify({ reason: "aborted_by_user" }),
        });
      }
    }

    transitionIssue(issueId, "closed", { currentOwner: "system", currentIntent: "Aborted by operator" });
    if (instance) completeWorkflowInstance(instance.id, "closed");
    appendWorkflowEvent({
      issueId,
      workflowInstanceId: instance?.id ?? null,
      type: "issue.closed",
      actorType: "human",
      actorRef: resolvedBy,
      stage: "closed",
      payload: { reason: "aborted_by_user" },
    });

    return { alreadyClosed: false, issueStatus: "closed", runningSessionIds: running };
  })();

  // Outside the transaction, per the ticket contract: terminating a child process is not
  // a DB write, and must happen only once the abort itself is durably committed.
  for (const sessionId of tx.runningSessionIds) deps.killProcess(sessionId);

  return { ok: true, issueStatus: tx.issueStatus, alreadyClosed: tx.alreadyClosed };
}

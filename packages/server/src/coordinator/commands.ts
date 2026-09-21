// packages/server/src/coordinator/commands.ts
//
// The coordinator kernel's write path. Every command is one short SQLite transaction that
// records the validated issue transition, the workflow event(s), and exactly one next
// durable effect (a queued work item, a human action, or workflow completion) together —
// so a process crash at any point either applies the whole step or none of it, and a
// duplicate delivery is a no-op. The effect *work* itself runs elsewhere, through a leased
// worker whose structured result comes back into applyCompletion.
import fs from "node:fs";
import type {
  HumanAction,
  HumanActionType,
  Issue,
  WorkflowEvent,
  WorkflowInstance,
  WorkflowEventType,
} from "@agent-dealer/shared";
import { canTransitionIssue } from "@agent-dealer/shared";
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
  listWorkflowEventsForIssue,
  startWorkflowInstance,
  WorkflowAlreadyActiveError,
} from "../repository/workflow-events.js";
import {
  createHumanAction,
  findOpenHumanAction,
  getHumanAction,
  listHumanActionsForIssue,
  resolveHumanAction,
  updateOpenHumanAction,
} from "../repository/human-actions.js";
import { pushLeaseToSha, readRemoteTip } from "../adapters/git-worktree.js";
import { ensureIssueRepoCheckout } from "../adapters/managed-repo.js";
import { reconcileFinding, resolveFindingsAbsentFromRound } from "../repository/findings.js";
import { normalizeReviewerResult } from "./reviewer-result.js";
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
import { recordCausesForWorkerFailedEvent } from "./failure-cause.js";
import {
  routeDeveloperOutcome,
  routeReviewerOutcome,
  type DeveloperOutcome,
  type ReviewerOutcome,
} from "./routing.js";
import type { ReviewerResult } from "./reviewer-result.js";
import { projectDeveloperRoute, projectReviewerRoute, type IssueProjection } from "./projection.js";
import {
  MERGE_FAILURE_EVIDENCE_KEY,
  MERGE_FAILURE_RESPONSE_OPTIONS,
  PUSH_DIVERGENCE_EVIDENCE_KEY,
  PUSH_DIVERGENCE_RESPONSE_OPTIONS,
  parseHumanResolution,
  resolveHumanActionOutcome,
  type HumanResolution,
  type PushDivergenceEvidence,
} from "./human-resolution.js";
import { AUTO_MERGE_INTENT, finalizeAutoMerge } from "./auto-merge.js";
import { externalMergeStateForIssue, type ExternalMergeState } from "./external-merge.js";
import {
  detectNonConvergence,
  formatNonConvergenceReason,
  reviewHistoryFromEvents,
  type NonConvergence,
} from "./non-convergence.js";
import {
  capEscalationEvents,
  deferLeasedWorkItemForBaseFetch,
  deferLeasedWorkItemForDeckOutage,
  deferLeasedWorkItemForUsageCap,
  formatCapEscalationReason,
  usageCapDeferralStartedAt,
  type BaseFetchFailedOutcome,
  type DeckUnavailableOutcome,
  type DeferralOutcome,
  type DeferWorkItemResult,
  type UsageCappedOutcome,
} from "./usage-cap-defer.js";
import { markQueueEntryAdmitted } from "../repository/queue-entries.js";
import { getWorkflow } from "./workflows/registry.js";
import { DEV_REVIEWER_V1_VERSION } from "./workflows/dev-reviewer-v1.js";

/** Default start template — resolved through the workflow registry (NOT-70). */
export const WORKFLOW_VERSION = getWorkflow(DEV_REVIEWER_V1_VERSION).version;

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

/**
 * NOT-185: an issue parked at `attempts_exhausted` may be re-scoped (PATCH) before it is
 * retried. True only while the workflow is active, the issue is `needs_human` with that
 * action open, and no work item is pending or leased — so no session can be reading the
 * snapshot an edit would supersede.
 */
export function canEditParkedIssue(issue: Issue): boolean {
  if (issue.status !== "needs_human") return false;
  if (!getActiveWorkflowInstance(issue.id)) return false;
  if (!findOpenHumanAction(issue.id, "attempts_exhausted")) return false;
  return !listWorkItemsForIssue(issue.id).some((w) => w.status === "pending" || w.status === "leased");
}

/** Re-freezes the snapshot when the operator edited title/description/criteria; returns the changed fields (empty = no-op). */
function refreshTaskSnapshotIfEdited(issue: Issue): string[] {
  const frozen = getTaskSnapshot(issue);
  const changed: string[] = [];
  if (frozen.title !== issue.title) changed.push("title");
  if (frozen.description !== (issue.description ?? "")) changed.push("description");
  if (frozen.acceptanceCriteria !== (issue.acceptanceCriteria ?? "")) changed.push("acceptanceCriteria");
  if (changed.length > 0) freezeTaskSnapshot(issue);
  return changed;
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
 * A bare 409 for "already running" is a dead end for a caller (the UI hides Start in this
 * state, but the CLI/API do not) — if a human action is already open, name it so the
 * operator resolves that instead of retrying Start against the same active instance.
 * Shared by startWorkflowCore and the admission-gated Start entry point.
 */
export function activeWorkflowConflictMessage(issueId: string): string {
  const openAction = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
  return openAction
    ? `Issue already has an active workflow — resolve the open ${openAction.actionType} first (POST /api/human-actions/${openAction.id}/resolve): ${openAction.question}`
    : "Issue already has an active workflow";
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
    throw new StartPreconditionError(409, activeWorkflowConflictMessage(issueId));
  }
  const readiness = checkIssueReadiness(issue);
  if (!readiness.ok) {
    throw new StartPreconditionError(400, `Missing required field(s): ${readiness.missing.join(", ")}`);
  }

  // Criteria were added since a pre-start gate opened — close it in the same txn as start.
  clearStaleProductScopeDecision(issue);

  const template = getWorkflow(WORKFLOW_VERSION);
  const instance = startWorkflowInstance(issueId, template.version);
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
 * Starts the issue's one `dev_reviewer_v1` workflow in a single transaction, with **no
 * admission gate**. NOT-118 removed the route that called this: every operator/agent entry
 * point now goes through `startIssueViaQueue` (admission), so this is the internal
 * force-start used by human-action resume-shaped paths and by tests.
 *
 * A second call while an instance is active is **rejected with 409** (not a resume-by-id —
 * callers must not assume the PRD §8 "returns its active instance" behaviour until the API
 * layer adds it). Missing acceptance criteria is a plain precondition failure: the pre-start
 * `product_scope_decision` gate is gone (NOT-118 — an under-specified issue waits in the
 * queue with a wait reason instead of opening a human action nobody asked for).
 */
export function startWorkflow(issueId: string): StartResult {
  const issue = getIssue(issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };

  // Refuse before enqueueing a developer round when `gh` cannot open the draft PR —
  // that path otherwise burns a full agent session and lands as adapter_failure.
  const preStart = (issue.status === "ready" || issue.status === "needs_human") && !getActiveWorkflowInstance(issueId);
  if (preStart) {
    const ghIssues = githubIssuesSync();
    if (ghIssues.length > 0) {
      return { ok: false, code: 409, error: ghIssues[0]!.message };
    }
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
  // NOT-136: same shape as a usage cap — the work item goes back on the queue behind an
  // availability window instead of being finished and routed as a failed attempt.
  if (outcome.kind === "deck_unavailable") {
    return applyDeckOutageCompletion(workItemId, leaseToken, outcome);
  }
  // NOT-197: same shape as a deck outage — the start never happened (no branch, no
  // spawn), so the work item waits for the network instead of spending an attempt.
  if (outcome.kind === "base_fetch_failed") {
    return applyBaseFetchDeferralCompletion(workItemId, leaseToken, outcome);
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

/**
 * NOT-111 / NOT-136: defer without finishing the work item or spending infra/attempt
 * budgets. Shared by both blockers — only `defer` and `escalate` differ.
 *
 * `escalate` is optional because only a usage cap has a ceiling: a deck outage always stays
 * retryable, so its `defer` never reports `escalated` and there is nothing to route.
 */
function applyDeferralCompletion(
  workItemId: string,
  leaseToken: string,
  result: DeferralOutcome,
  defer: (item: WorkItem, issue: Issue, instance: WorkflowInstance) => DeferWorkItemResult,
  escalate?: (issue: Issue, instance: WorkflowInstance, item: WorkItem) => ApplyResult
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

    const deferResult = defer(before, issue, instance);
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
    if (deferResult.escalated && escalate) {
      const item = finishWorkItem(workItemId, leaseToken, { status: "done", result });
      if (!item) return { applied: false, reason: "lease_lost" };
      return escalate(issue, instance, item);
    }
    return { applied: false, reason: "lease_lost" };
  })();
}

function applyUsageCapCompletion(
  workItemId: string,
  leaseToken: string,
  cap: UsageCappedOutcome
): ApplyResult {
  return applyDeferralCompletion(
    workItemId,
    leaseToken,
    cap,
    (item, issue, instance) => deferLeasedWorkItemForUsageCap(item, leaseToken, cap, issue, instance),
    (issue, instance, item) => routeCapEscalation(issue, instance, item, cap)
  );
}

/** NOT-136: no escalation arm — the item waits for the deck for as long as it takes. */
function applyDeckOutageCompletion(
  workItemId: string,
  leaseToken: string,
  outage: DeckUnavailableOutcome
): ApplyResult {
  return applyDeferralCompletion(workItemId, leaseToken, outage, (item, issue, instance) =>
    deferLeasedWorkItemForDeckOutage(item, leaseToken, outage, issue, instance)
  );
}

/** NOT-197: no escalation arm — the item waits for the network for as long as it takes. */
function applyBaseFetchDeferralCompletion(
  workItemId: string,
  leaseToken: string,
  failure: BaseFetchFailedOutcome
): ApplyResult {
  return applyDeferralCompletion(workItemId, leaseToken, failure, (item, issue, instance) =>
    deferLeasedWorkItemForBaseFetch(item, leaseToken, failure, issue, instance)
  );
}

/**
 * Deferral ceiling exceeded — escalate with cap evidence without spending infra attempts.
 * Used when applyCompletion or the worker loop cannot defer any longer.
 *
 * Only the usage cap comes here. A deck outage (NOT-136) has no ceiling: escalating it would
 * strand an issue that the deck's return would otherwise unblock on its own.
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
  emit: (type: WorkflowEventType, opts?: EmitOpts) => WorkflowEvent;
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
      return evt;
    },
  };
}

/**
 * NOT-169: a publishOnly work item runs the no-agent publish path (no CLI spawn, no
 * agent.started/agent.completed). Its worker terminal event carries `publishOnly: true`
 * so a publish-only recovery is distinguishable from an agent retry in the timeline
 * and in interval derivation.
 */
function isPublishOnlyItem(item: WorkItem): boolean {
  try {
    if (!item.payloadJson) return false;
    return (JSON.parse(item.payloadJson) as { publishOnly?: unknown }).publishOnly === true;
  } catch {
    return false;
  }
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
        // NOT-169: distinguish a no-agent publish-only recovery from an agent retry.
        ...(isPublishOnlyItem(item) ? { publishOnly: true } : {}),
      };
      if (type === "worker.failed") {
        // Do not read session.errorJson here — worker-loop writes it only *after*
        // applyCompletion. Reason comes from outcome / logPath / route (same sources
        // the eventual errorJson is built from).
        payload.reason = reasonForWorkerFailedEvent({
          outcome,
          routeReason: "reason" in route ? route.reason : null,
          logPath: session?.logPath,
          runtime: session?.runtime ?? undefined,
        });
      }
      const emitted = ev.emit(type, {
        actorType: "developer",
        payload,
      });
      if (type === "worker.failed") {
        // NOT-171: normalized cause evidence, same classifier as recovery. Append-only;
        // the event payload reason and session errorJson stay untouched.
        recordCausesForWorkerFailedEvent({
          issueId: issue.id,
          workflowInstanceId: instance.id,
          event: emitted,
          outcomeKind: outcome.kind,
          outcomeReason: "reason" in outcome ? (outcome.reason ?? null) : null,
          routeReason: "reason" in route ? route.reason : null,
          // NOT-171: observed failures are never presumed-dead reclaims — not even
          // for publish-only items. The recovery flag (and its coordinator_crash /
          // host_sleep signal) comes only from the recovery path
          // (recovery.ts emitPresumedDeadFailed), which always carries the
          // presumed-dead marker. Passing "republish" here demoted real
          // publish/auth/provider causes to consequences.
          recovery: null,
        });
      }
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
  let route: ReturnType<typeof routeReviewerOutcome> = routeReviewerOutcome(
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
  // NOT-184: a repair loop that keeps finding new blocking issues on the same file is not
  // converging — hand it to a human instead of queuing another developer round.
  let nonConvergence: NonConvergence | null = null;
  if (outcome.kind === "verdict" && route.next === "retry_developer_with_findings") {
    nonConvergence = findNonConvergence(issue, instance, outcome.result);
    if (nonConvergence) {
      route = {
        next: "human_action",
        actionType: "policy_escalation",
        reason: formatNonConvergenceReason(nonConvergence),
      };
    }
  }
  const hasVerdict = outcome.kind === "verdict";
  // Normalize before emit/finding reconcile so remapped blocking findings (NOT-150) persist.
  const verdictResult =
    outcome.kind === "verdict" ? normalizeReviewerResult(outcome.result) : null;
  const { projection, effect, advance } = projectReviewerRoute(route, issue.currentRound, hasVerdict);

  const ev = eventEmitter(issue, instance, item.workerSessionId, projection.issueStatus, issue.currentRound);

  const patch: TransitionIssuePatch = {};
  for (const type of projection.events) {
    if (type === "review.submitted" && verdictResult) {
      ev.emit("review.submitted", { actorType: "reviewer", payload: verdictResult });
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
        // NOT-169: publishOnly items never reach the reviewer path today, but keep the
        // marker symmetric so a future no-agent reviewer retry is distinguishable too.
        ...(isPublishOnlyItem(item) ? { publishOnly: true } : {}),
      };
      if (type === "worker.failed") {
        // See applyDeveloper: session.errorJson is not written until after applyCompletion.
        payload.reason = reasonForWorkerFailedEvent({
          outcome,
          routeReason: "reason" in route ? route.reason : null,
          logPath: session?.logPath,
          runtime: session?.runtime ?? undefined,
        });
      }
      const emitted = ev.emit(type, {
        actorType: "reviewer",
        payload,
      });
      if (type === "worker.failed") {
        // NOT-171: see applyDeveloper — observed failures never carry the recovery flag.
        recordCausesForWorkerFailedEvent({
          issueId: issue.id,
          workflowInstanceId: instance.id,
          event: emitted,
          outcomeKind: outcome.kind,
          outcomeReason: "reason" in outcome ? (outcome.reason ?? null) : null,
          routeReason: "reason" in route ? route.reason : null,
          recovery: null,
        });
      }
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
  if (verdictResult) {
    for (const f of verdictResult.findings) {
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
    // A completed review that no longer reports a finding closes it. Compared against the
    // normalized findings just reconciled above; failed, stale and verdict-less outcomes
    // never reach here, so they resolve nothing.
    resolveFindingsAbsentFromRound(
      issue.id,
      verdictResult.findings.map((f) => f.fingerprint)
    );
  }

  applyProjectionTransition(issue, projection, patch);
  if (advance === "review") incrementIssueRound(issue.id);
  else if (advance === "infra") incrementIssueInfraAttempts(issue.id);
  const issueNow = getIssue(issue.id)!;

  return applyEffect(issue, instance, effect, route, issueNow, ev, item.id, outcome, nonConvergence);
}

/** Rounds at or before the latest non-convergence escalation are spent — a human already saw them. */
function findNonConvergence(issue: Issue, instance: WorkflowInstance, result: ReviewerResult): NonConvergence | null {
  let floorRound = 0;
  for (const action of listHumanActionsForIssue(issue.id)) {
    if (action.workflowInstanceId !== instance.id || !action.evidenceJson) continue;
    try {
      const evidence = JSON.parse(action.evidenceJson) as { nonConvergence?: { throughRound?: number } };
      floorRound = Math.max(floorRound, evidence.nonConvergence?.throughRound ?? 0);
    } catch {
      // unreadable evidence cannot name a floor
    }
  }
  const history = reviewHistoryFromEvents(listWorkflowEventsForIssue(issue.id), instance.id, {
    round: issue.currentRound,
    result,
  });
  return detectNonConvergence(history, issue.currentRound, floorRound);
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
  reviewerOutcome?: ReviewerOutcome,
  nonConvergence?: NonConvergence | null
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
    // NOT-221: a rejected push carries its divergence facts on the effect — stored as
    // action evidence so push_with_lease can later push the exact recorded SHAs.
    const pushDivergence =
      actionType === "policy_escalation" && !resumeAsReviewer
        ? (effect.pushDivergence ?? null)
        : null;
    const action = createHumanAction({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      actionType,
      reason: effect.reason,
      question: questionFor(actionType, effect.reason, resumeAsReviewer, false, pushDivergence),
      evidence:
        reviewerOutcome?.kind === "verdict"
          ? { review: reviewerOutcome.result, ...(nonConvergence ? { nonConvergence } : {}) }
          : pushDivergence
            ? { [PUSH_DIVERGENCE_EVIDENCE_KEY]: pushDivergence }
            : undefined,
      // issueNow.headSha, not issue.headSha: a stale outcome that itself exhausted the
      // infra budget already patched the newly observed head onto the issue above — the
      // pre-transition issue param would still carry the stale SHA a "resume" must not reuse.
      continuationPreview: resumeAsReviewer
        ? { resumeRole: "reviewer", resumeHeadSha: issueNow.headSha }
        : nonConvergence
          ? { resumeRole: "developer", advanceRound: true }
          : undefined,
      responseOptions: responseOptionsFor(actionType, resumeAsReviewer, {
        pushDivergence: pushDivergence ?? undefined,
      }),
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

/**
 * NOT-194: true when the action is a merge-failure escalation (evidence carries
 * `mergeFailure: true`). Pre-NOT-194 open merge-failure actions have no such evidence and
 * read as ordinary policy_escalations — that is what keeps their `resume` path working.
 */
export function isMergeFailureAction(action: { evidenceJson: string | null }): boolean {
  if (!action.evidenceJson) return false;
  try {
    return (JSON.parse(action.evidenceJson) as Record<string, unknown>)[MERGE_FAILURE_EVIDENCE_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * NOT-221: parses the diverged-push facts off a policy_escalation's evidence. Null for
 * every other action — including behind-only push evidence and legacy pre-NOT-221
 * `unpushed_commit` escalations, which carry no structured facts at all.
 */
export function parsePushDivergenceEvidence(action: {
  evidenceJson: string | null;
}): PushDivergenceEvidence | null {
  if (!action.evidenceJson) return null;
  try {
    const evidence = JSON.parse(action.evidenceJson) as Record<string, unknown>;
    const facts = evidence[PUSH_DIVERGENCE_EVIDENCE_KEY] as PushDivergenceEvidence | undefined;
    if (!facts || typeof facts !== "object") return null;
    if (typeof facts.branch !== "string" || typeof facts.localSha !== "string") return null;
    if (typeof facts.remoteSha !== "string") return null;
    if (facts.relationship !== "diverged" && facts.relationship !== "behind") return null;
    return facts;
  } catch {
    return null;
  }
}

/**
 * NOT-221: true when the action is a diverged-push escalation (evidence carries
 * `pushDivergence` with relationship "diverged"). Pre-NOT-221 open unpushed_commit
 * actions have no such evidence and read as ordinary policy_escalations — that is what
 * keeps their `resume` path working.
 */
export function isPushDivergenceAction(action: { evidenceJson: string | null }): boolean {
  return parsePushDivergenceEvidence(action)?.relationship === "diverged";
}

function shortPushSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** NOT-221: true only for a diverged push — behind-only rejections keep resume/close. */
function isDivergedPush(pushDivergence: PushDivergenceEvidence | null | undefined): boolean {
  return pushDivergence?.relationship === "diverged";
}

function questionFor(
  actionType: HumanActionType,
  reason: string,
  resumeAsReviewer = false,
  mergeFailure = false,
  pushDivergence: PushDivergenceEvidence | null = null
): string {
  switch (actionType) {
    case "final_review":
      return "Merge this work, send it back for another repair round, or close it?";
    case "attempts_exhausted":
      return "The review-round limit is reached. Retry with a fresh round, or close the issue?";
    case "policy_escalation":
      if (mergeFailure) return `${reason} Retry the merge, queue another repair round, or close the issue?`;
      // NOT-221: the confirmation names the exact SHAs the lease-pinned push will use so
      // the operator reviews the pin before one-clicking it.
      if (isDivergedPush(pushDivergence)) {
        const facts = pushDivergence!;
        return (
          `${reason} Push local ${shortPushSha(facts.localSha)} to origin/${facts.branch} ` +
          `with a lease pinned at remote ${shortPushSha(facts.remoteSha)} ` +
          `(local ${facts.ahead} commit(s) ahead, remote ${facts.behind} commit(s) ahead), ` +
          `resume development, or close the issue?`
        );
      }
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
  resumeAsReviewer = false,
  opts: { mergeFailure?: boolean; pushDivergence?: PushDivergenceEvidence | null } = {}
): Array<{ choice: string; label: string }> {
  switch (actionType) {
    case "final_review":
      return [
        { choice: "merge", label: "Merge" },
        { choice: "repair", label: "Another repair round" },
        { choice: "close", label: "Close" },
      ];
    case "attempts_exhausted":
      return [
        { choice: "retry", label: "Retry — another round" },
        { choice: "close", label: "Close" },
      ];
    case "policy_escalation":
      // NOT-194: a merge failure after approval offers retry/repair/close — never resume.
      if (opts.mergeFailure) return [...MERGE_FAILURE_RESPONSE_OPTIONS];
      // NOT-221: a diverged push offers the lease-pinned push alongside resume/close;
      // behind-only (and every other) escalation keeps resume/close only.
      if (isDivergedPush(opts.pushDivergence)) return [...PUSH_DIVERGENCE_RESPONSE_OPTIONS];
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
  /** NOT-184: the escalation left the round un-advanced; resuming spends it like a repair round. */
  advanceRound?: boolean;
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
 *
 * NOT-196: a `close` choice finishes as `done` instead of `closed` when
 * `opts.externalMergeState` is "merged" — the PR landed outside Dealer, so the work is
 * landed and dependents must be released. Any other state (or no pre-read at all)
 * keeps today's `closed`. The `gh` read itself lives in the async wrapper
 * (`resolveHumanActionAndAdvanceAsync`), never inside this transaction.
 */
export function resolveHumanActionAndAdvance(
  actionId: string,
  resolvedBy: string,
  choice: string,
  opts?: { externalMergeState?: ExternalMergeState }
): ResolveResult {
  const action = getHumanAction(actionId);
  if (!action) return { ok: false, code: 404, error: "Human action not found" };
  if (action.status !== "open") return { ok: false, code: 409, error: "Human action already resolved" };

  const resolution = parseHumanResolution(action.actionType, choice);
  if (!resolution) {
    return { ok: false, code: 400, error: `Invalid choice "${choice}" for ${action.actionType}` };
  }
  // NOT-194: narrow policy_escalation choices per action. A merge-failure action offers
  // retry_merge/repair/close only (resume would re-run development on approved work);
  // every other policy_escalation keeps resume/close only. Pre-NOT-194 open merge-failure
  // actions carry no mergeFailure evidence, so they still accept resume here.
  // NOT-221: same per-action narrowing for a diverged push — push_with_lease/resume/close
  // only; behind-only and legacy unpushed_commit actions keep resume/close only.
  if (resolution.actionType === "policy_escalation") {
    const mergeFailure = isMergeFailureAction(action);
    const divergedPush = !mergeFailure && isPushDivergenceAction(action);
    const allowed = mergeFailure
      ? ["retry_merge", "repair", "close"]
      : divergedPush
        ? ["push_with_lease", "resume", "close"]
        : ["resume", "close"];
    if (!allowed.includes(resolution.choice)) {
      return {
        ok: false,
        code: 400,
        error: `Invalid choice "${choice}" for ${mergeFailure ? "a merge-failure" : divergedPush ? "a diverged-push" : "this"} policy_escalation`,
      };
    }
    // push_with_lease runs git before anything resolves (a failed lease must leave the
    // action open), so it can only complete through resolveHumanActionAndAdvanceAsync —
    // the sync entry point rejects it the way human-resolution's outcome map would.
    if (resolution.choice === "push_with_lease") {
      return {
        ok: false,
        code: 409,
        error: "push_with_lease requires the async resolver: the lease push runs before the action resolves",
      };
    }
  }
  // parseHumanResolution already rejects every Run-scoped action type (NOT-95) above, so
  // every action reaching here is Issue-scoped — this narrows action.issueId for TS.
  if (!action.issueId) return { ok: false, code: 500, error: "Human action has no issue" };

  const issue = getIssue(action.issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };
  const instance = getActiveWorkflowInstance(action.issueId);

  // NOT-102 / NOT-150: human Merge (or legacy "complete") must undraft+merge.
  // Park like auto-merge, then the async wrapper runs finalizeAutoMerge outside this txn.
  // NOT-194: a merge-failure retry_merge parks the same way — the old action is resolved
  // first, so a second failure escalates exactly one fresh action with the new reason.
  if (
    instance &&
    ((resolution.actionType === "final_review" &&
      (resolution.choice === "merge" || resolution.choice === "complete")) ||
      (resolution.actionType === "policy_escalation" && resolution.choice === "retry_merge"))
  ) {
    return getDb().transaction((): ResolveResult => {
      resolveHumanAction(actionId, resolvedBy, { choice });
      appendWorkflowEvent({
        issueId: issue.id,
        workflowInstanceId: instance.id,
        type: "human_action.resolved",
        actorType: "human",
        actorRef: resolvedBy,
        stage: resolution.actionType === "final_review" ? "final_review" : issue.status,
        round: issue.currentRound,
        payload: { actionType: action.actionType, choice: resolution.choice, pendingMerge: true },
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
  // NOT-184: a non-convergence escalation stopped before the repair round it would have
  // queued, so resuming spends that round too (the floor in findNonConvergence then needs
  // three fresh rounds before it can fire again).
  const advancesRound = resolution.choice === "resume" && continuation?.advanceRound === true;
  const nextRound =
    outcome.roundKind === "review" || outcome.roundKind === "review_grant" || advancesRound
      ? issue.currentRound + 1
      : issue.currentRound;
  const resumeStatus = resumeAsReviewer ? "reviewing" : outcome.issueStatus;

  // NOT-196: a close on an issue whose PR is MERGED on GitHub lands as done — the
  // code is on the base branch, so dependents must be released. Only a confirmed merge
  // upgrades; open / closed-unmerged / unreadable ("unknown") / no pre-read all stay
  // closed. The PR number gates the upgrade so a merged state can never apply to an
  // issue that never had a PR, and the status-machine gate keeps it to statuses with
  // a →done edge (close actions park at needs_human/final_review, both of which have
  // one) so the upgrade can never throw inside the transaction.
  const prMerged =
    outcome.workflowOutcome === "closed" && opts?.externalMergeState === "merged" && issue.prNumber != null;
  const externallyMerged = prMerged && canTransitionIssue(issue.status, "done");
  const closeHasPr = outcome.workflowOutcome === "closed" && issue.prNumber != null;
  // Extra audit keys on the close resolution only — every other outcome keeps today's
  // exact payload.
  const closeResolutionExtra: Record<string, unknown> = !closeHasPr
    ? {}
    : externallyMerged
      ? { prNumber: issue.prNumber, prState: "MERGED", externalMerge: true }
      : opts?.externalMergeState === "unknown"
        ? { prNumber: issue.prNumber, prMergeStateUnknown: true }
        : prMerged
          ? {
              prNumber: issue.prNumber,
              prState: "MERGED",
              doneTransitionBlocked: `no ${issue.status} → done edge`,
            }
          : {};

  return getDb().transaction((): ResolveResult => {
    resolveHumanAction(actionId, resolvedBy, { choice });
    // stage must be the status this resolution actually lands on (finalStatus), not the
    // generic developer-resume outcome.issueStatus — otherwise a reviewer resume's own
    // human_action.resolved/repair.started events would be recorded under "developing"
    // even though the issue transitions to "reviewing".
    const finalStatus = externallyMerged ? "done" : resumeStatus;
    const ev = eventEmitter(issue, instance, null, finalStatus, issue.currentRound);
    ev.emit("human_action.resolved", {
      actorType: "human",
      payload: { actionType: action.actionType, choice, ...closeResolutionExtra },
    });

    transitionIssue(issue.id, finalStatus, {
      currentOwner:
        finalStatus === "done" || finalStatus === "closed" ? "system" : resumeAsReviewer ? "reviewer" : "developer",
      currentIntent:
        finalStatus === "done"
          ? externallyMerged
            ? "Merged outside Dealer"
            : "Complete"
          : finalStatus === "closed"
            ? "Closed"
            : resumeAsReviewer
              ? `Reviewer re-evaluating at ${continuation!.resumeHeadSha!.slice(0, 8)}`
              : `Developer implementing round ${nextRound}`,
    });

    if (outcome.workflowOutcome) {
      const finalOutcome = externallyMerged ? "done" : outcome.workflowOutcome;
      completeWorkflowInstance(instance.id, finalOutcome);
      if (externallyMerged) {
        ev.emit("issue.completed", {
          payload: { externalMerge: true, prNumber: issue.prNumber, prState: "MERGED" },
        });
      } else if (finalOutcome === "done") {
        ev.emit("issue.completed");
      } else if (opts?.externalMergeState === "unknown" && issue.prNumber != null) {
        ev.emit("issue.closed", {
          payload: { prNumber: issue.prNumber, prMergeStateUnknown: true },
        });
      } else if (prMerged) {
        ev.emit("issue.closed", {
          payload: {
            prNumber: issue.prNumber,
            prState: "MERGED",
            doneTransitionBlocked: `no ${issue.status} → done edge`,
          },
        });
      } else {
        ev.emit("issue.closed");
      }
      return {
        ok: true,
        issueStatus: getIssue(issue.id)!.status,
        nextWorkItemId: null,
        instanceCompleted: true,
        restarted: false,
        triggerReflect: outcome.triggerReflect === true || externallyMerged,
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
        if (advancesRound) incrementIssueRound(issue.id);
        break;
      case "none":
      case undefined:
        break;
    }
    const issueNow = getIssue(issue.id)!;
    // NOT-185: freeze before queuing so the next developer prompt and the reviewer both
    // read the re-scoped task. An unedited issue writes nothing.
    if (action.actionType === "attempts_exhausted" && resolution.choice === "retry") {
      const changedFields = refreshTaskSnapshotIfEdited(issueNow);
      if (changedFields.length > 0) {
        ev.emit("task_snapshot.refreshed", { actorType: "human", payload: { actionId: action.id, changedFields } });
      }
    }
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
  // NOT-221: the lease push runs before anything resolves — a failed lease must leave
  // the action open with the fresh tip, which the sync core below cannot do.
  if (choice === "push_with_lease") {
    return resolvePushWithLeaseAsync(actionId, resolvedBy);
  }
  // NOT-196: the `gh` PR-state read runs here, outside any DB transaction — the sync
  // core below only consumes the pre-read state. Only close choices on issues with a
  // PR number pay for the call; anything unreadable resolves to "unknown" (or
  // undefined when there is nothing to check), both of which keep today's `closed`.
  const externalMergeState = await preReadExternalMergeState(actionId, choice);
  const result = resolveHumanActionAndAdvance(actionId, resolvedBy, choice, { externalMergeState });
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
 * NOT-221: resolves a diverged-push `push_with_lease` choice. The lease-pinned push
 * runs FIRST, from the preserved worktree (or the issue checkout when that is gone):
 * the pin is the exact remote tip the operator reviewed, so a moved origin fails the
 * push and nothing is published. Only a successful push resolves the action — then the
 * workflow continues at PR/checks verification via a publish-only developer work item
 * at the current round (no review round spent, no new agent round), exactly the path a
 * post-push `adapter_failure` retry would have taken.
 */
async function resolvePushWithLeaseAsync(actionId: string, resolvedBy: string): Promise<ResolveResult> {
  const action = getHumanAction(actionId);
  if (!action) return { ok: false, code: 404, error: "Human action not found" };
  if (action.status !== "open") return { ok: false, code: 409, error: "Human action already resolved" };
  if (action.actionType !== "policy_escalation") {
    return { ok: false, code: 400, error: `Invalid choice "push_with_lease" for ${action.actionType}` };
  }
  const facts = parsePushDivergenceEvidence(action);
  if (!facts || facts.relationship !== "diverged") {
    return {
      ok: false,
      code: 400,
      error: 'Invalid choice "push_with_lease" for a non-diverged policy_escalation',
    };
  }
  if (!action.issueId) return { ok: false, code: 500, error: "Human action has no issue" };
  const issue = getIssue(action.issueId);
  if (!issue) return { ok: false, code: 404, error: "Issue not found" };
  const instance = getActiveWorkflowInstance(action.issueId);
  if (!instance) return { ok: false, code: 409, error: "No active workflow for this action" };

  // Prefer the preserved worktree the push originally ran from — its object store
  // provably holds the recorded local SHA. Fall back to the issue checkout (which shares
  // refs with coordinator worktrees) when the worktree is gone.
  let cwd: string | null = facts.worktreePath && fs.existsSync(facts.worktreePath) ? facts.worktreePath : null;
  if (!cwd) {
    try {
      cwd = (await ensureIssueRepoCheckout(issue.repo)).repoPath;
    } catch (err) {
      return {
        ok: false,
        code: 409,
        error: `Push with lease could not run: the preserved worktree is gone and the issue checkout failed: ${(err as Error).message}`,
      };
    }
  }

  const pushed = await pushLeaseToSha({
    cwd,
    branch: facts.branch,
    localSha: facts.localSha,
    remoteSha: facts.remoteSha,
  });
  if (!pushed.ok) {
    // The pin no longer matches: origin moved (or is unreachable) and git published
    // nothing. Keep the original pin — refreshing it would publish over remote commits
    // the operator never reviewed — and surface the freshly observed tip on the
    // still-open action instead.
    const tip = await readRemoteTip({ cwd, branch: facts.branch });
    const leaseError = pushed.reason.replace(/\s+/g, " ").trim().slice(0, 300);
    const tipText =
      tip && tip !== facts.remoteSha
        ? `origin/${facts.branch} is now at ${tip}`
        : tip
          ? `origin/${facts.branch} is still at the recorded pin ${shortPushSha(facts.remoteSha)} (the remote may be unreachable)`
          : `origin/${facts.branch} could not be resolved`;
    const suffix =
      ` Push with lease failed (${leaseError}). ${tipText}, so nothing was published — ` +
      `re-check the remote tip, then retry, resume, or close.`;
    updateOpenHumanAction(actionId, {
      reason: `${action.reason}${suffix}`,
      question: `${action.question}${suffix}`,
      evidence: {
        [PUSH_DIVERGENCE_EVIDENCE_KEY]: {
          ...facts,
          ...(tip && tip !== facts.remoteSha ? { observedRemoteSha: tip } : {}),
          lastLeaseError: leaseError,
        },
      },
    });
    return {
      ok: false,
      code: 409,
      error: `Push with lease failed: ${leaseError}. ${tipText}; the action stays open.`,
    };
  }

  return getDb().transaction((): ResolveResult => {
    resolveHumanAction(actionId, resolvedBy, { choice: "push_with_lease" });
    const ev = eventEmitter(issue, instance, null, "developing", issue.currentRound);
    ev.emit("human_action.resolved", {
      actorType: "human",
      payload: { actionType: action.actionType, choice: "push_with_lease" },
    });
    ev.emit("branch.pushed", {
      actorType: "developer",
      payload: {
        branch: facts.branch,
        localSha: facts.localSha,
        leasePin: facts.remoteSha,
        withLease: true,
      },
    });
    transitionIssue(issue.id, "developing", {
      currentOwner: "developer",
      currentIntent: `Publishing ${facts.branch} with lease (no agent) — verifying PR/checks`,
    });
    // Publish-only continuation at the current round: the commits are already on the
    // remote, so the work item redoes gh/PR/checks only — no repair round is consumed
    // and no agent is spawned.
    const next = enqueueWorkItem({
      issueId: issue.id,
      workflowInstanceId: instance.id,
      kind: "developer",
      round: issue.currentRound,
      payload: {
        publishOnly: true,
        branch: facts.branch,
        profileSnapshot: queuedProfileSnapshot(issue, "developer"),
      },
      idempotencyKey: `${instance.id}:developer:push-with-lease:${action.id}`,
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
  } else if (
    resolution.actionType === "final_review" &&
    (resolution.choice === "merge" || resolution.choice === "complete")
  ) {
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
export function abortIssue(
  issueId: string,
  resolvedBy: string,
  deps: AbortIssueDeps = defaultAbortDeps,
  opts?: { externalMergeState?: ExternalMergeState }
): AbortResult {
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

    // NOT-196: aborting an issue whose PR already merged outside Dealer lands it as
    // done so dependents are released. Only a confirmed merge upgrades — an unreadable
    // state ("unknown") or no PR keeps today's `closed`, with the unknown case noted
    // in the event. The PR number gates the upgrade, as in the resolve path, and the
    // status-machine gate keeps it to statuses with a →done edge (abort, unlike the
    // resolve path, can fire from any status — e.g. developing — where no such edge
    // exists; there the abort stays closed but the event still names the merged PR so
    // the operator can see why, and a follow-up could add the edge).
    const prMerged = opts?.externalMergeState === "merged" && issue.prNumber != null;
    const externallyMerged = prMerged && canTransitionIssue(issue.status, "done");
    const finalStatus = externallyMerged ? "done" : "closed";
    transitionIssue(issueId, finalStatus, {
      currentOwner: "system",
      currentIntent: externallyMerged ? "Merged outside Dealer" : "Aborted by operator",
    });
    if (instance) completeWorkflowInstance(instance.id, externallyMerged ? "done" : "closed");
    appendWorkflowEvent({
      issueId,
      workflowInstanceId: instance?.id ?? null,
      type: externallyMerged ? "issue.completed" : "issue.closed",
      actorType: "human",
      actorRef: resolvedBy,
      stage: finalStatus,
      payload: externallyMerged
        ? { reason: "aborted_by_user", externalMerge: true, prNumber: issue.prNumber, prState: "MERGED" }
        : prMerged
          ? {
              reason: "aborted_by_user",
              prNumber: issue.prNumber,
              prState: "MERGED",
              doneTransitionBlocked: `no ${issue.status} → done edge`,
            }
          : opts?.externalMergeState === "unknown" && issue.prNumber != null
            ? { reason: "aborted_by_user", prNumber: issue.prNumber, prMergeStateUnknown: true }
            : { reason: "aborted_by_user" },
    });

    return { alreadyClosed: false, issueStatus: finalStatus, runningSessionIds: running };
  })();

  // Outside the transaction, per the ticket contract: terminating a child process is not
  // a DB write, and must happen only once the abort itself is durably committed.
  for (const sessionId of tx.runningSessionIds) deps.killProcess(sessionId);

  return { ok: true, issueStatus: tx.issueStatus, alreadyClosed: tx.alreadyClosed };
}

/**
 * NOT-196 HTTP/CLI entry for abort: same as `abortIssue`, but pre-reads the PR merge
 * state outside the transaction first so an externally-merged PR lands the issue as
 * `done`. Issues without a PR number skip the `gh` call entirely.
 */
export async function abortIssueAsync(
  issueId: string,
  resolvedBy: string,
  deps: AbortIssueDeps = defaultAbortDeps
): Promise<AbortResult> {
  let externalMergeState: ExternalMergeState | undefined;
  try {
    const issue = getIssue(issueId);
    if (issue && issue.prNumber != null) {
      externalMergeState = await externalMergeStateForIssue(issue);
    }
  } catch {
    externalMergeState = undefined;
  }
  return abortIssue(issueId, resolvedBy, deps, { externalMergeState });
}

/**
 * NOT-196 pre-read for the async close entry: returns a PR merge state only when this
 * resolution is a `close` choice on an issue that actually has a PR number — otherwise
 * undefined, which keeps the sync core on today's behavior with no `gh` call. Never
 * throws: lookup failures mean "nothing to check".
 */
async function preReadExternalMergeState(
  actionId: string,
  choice: string
): Promise<ExternalMergeState | undefined> {
  try {
    const action = getHumanAction(actionId);
    if (!action || action.status !== "open" || !action.issueId) return undefined;
    const resolution = parseHumanResolution(action.actionType, choice);
    if (!resolution || resolution.choice !== "close") return undefined;
    const issue = getIssue(action.issueId);
    if (!issue || issue.prNumber == null) return undefined;
    return await externalMergeStateForIssue(issue);
  } catch {
    return undefined;
  }
}

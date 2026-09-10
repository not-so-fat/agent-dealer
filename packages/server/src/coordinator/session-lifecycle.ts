// packages/server/src/coordinator/session-lifecycle.ts
import path from "node:path";
import os from "node:os";
import { v4 as uuid } from "uuid";
import type { Issue, WorkerSession } from "@agent-dealer/shared";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import { createWorkerSession, claimQueuedSession, completeSession, listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { startWorkflowInstance, appendWorkflowEvent } from "../repository/workflow-events.js";
import { createHumanAction } from "../repository/human-actions.js";
import { reconcileFinding, listFindingsForIssue } from "../repository/findings.js";
import { addWorktree, removeWorktree, isWorktreeClean, mergeBase } from "../adapters/git-worktree.js";
import { viewPr, publishReview } from "../adapters/github.js";
import { spawnDeveloperSession, spawnReviewerSession } from "./spawn.js";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";
import { parseReviewerResult } from "./reviewer-result.js";
import { routeDeveloperOutcome, routeReviewerOutcome, type DeveloperOutcome, type ReviewerOutcome } from "./routing.js";

export interface CoordinatorDeps {
  worktree: {
    addWorktree: typeof addWorktree;
    removeWorktree: typeof removeWorktree;
    isWorktreeClean: typeof isWorktreeClean;
    mergeBase: typeof mergeBase;
  };
  github: {
    viewPr: typeof viewPr;
    publishReview: typeof publishReview;
  };
  spawnDeveloper: typeof spawnDeveloperSession;
  spawnReviewer: typeof spawnReviewerSession;
}

export const defaultCoordinatorDeps: CoordinatorDeps = {
  worktree: { addWorktree, removeWorktree, isWorktreeClean, mergeBase },
  github: { viewPr, publishReview },
  spawnDeveloper: spawnDeveloperSession,
  spawnReviewer: spawnReviewerSession,
};

function worktreePathFor(issue: Issue, role: "developer" | "reviewer", round: number): string {
  return path.join(os.tmpdir(), "agent-dealer-worktrees", issue.id, `${role}-r${round}`);
}

export async function startIssueWorkflow(issueId: string, deps: CoordinatorDeps = defaultCoordinatorDeps): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);

  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  appendWorkflowEvent({ issueId, workflowInstanceId: instance.id, type: "workflow.started", actorType: "system", stage: "ready" });

  const updated = transitionIssue(issueId, "developing", { currentOwner: "developer", currentIntent: "Developer implementing round 1" });

  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: issue.developerAgentId,
    runtime: "claude_code",
  });
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instance.id,
    workerSessionId: session.id,
    type: "worker.started",
    actorType: "system",
    stage: updated.status,
    round: 1,
  });
}

/** Claims and runs exactly one queued session for this issue to completion, then routes the outcome. */
export async function advanceIssue(issueId: string, deps: CoordinatorDeps = defaultCoordinatorDeps): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);
  const queued = listWorkerSessionsForIssue(issueId).filter((s) => s.status === "queued");
  const session = queued[queued.length - 1];
  if (!session) return;

  const claimed = claimQueuedSession(session.id);
  if (!claimed) return; // another dispatcher already took it

  const worktreePath = worktreePathFor(issue, session.role === "reviewer" ? "reviewer" : "developer", session.round);

  if (session.role === "developer") {
    await runDeveloperSession(issue, claimed, worktreePath, deps);
  } else {
    await runReviewerSession(issue, claimed, worktreePath, deps);
  }
}

async function runDeveloperSession(
  issue: Issue,
  session: WorkerSession,
  worktreePath: string,
  deps: CoordinatorDeps
): Promise<void> {
  await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: issue.baseBranch, newBranch: `issue-${issue.id}` });

  const priorFindings = listFindingsForIssue(issue.id).filter((f) => f.status === "open" || f.status === "recurring");
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    round: session.round,
    findings: priorFindings.length ? priorFindings : undefined,
  });

  let result;
  try {
    result = await deps.spawnDeveloper(session, prompt);
  } catch {
    result = { exitCode: 1, transcript: "", logPath: "", timedOut: false };
  }

  const sessionStatus = result.exitCode === 0 && !result.timedOut ? "done" : "failed";
  completeSession(session.id, { status: sessionStatus, exitCode: result.exitCode, logPath: result.logPath });
  appendWorkflowEvent({ issueId: issue.id, workerSessionId: session.id, type: "worker.completed", actorType: "developer", stage: issue.status, round: session.round });

  const outcome = await classifyDeveloperOutcome(issue, worktreePath, sessionStatus, deps);
  const routed = routeDeveloperOutcome(outcome, { currentRound: issue.currentRound, maxReviewRounds: issue.maxReviewRounds });

  if (outcome.kind === "clean_handoff") {
    appendWorkflowEvent({ issueId: issue.id, workerSessionId: session.id, type: "pull_request.opened", actorType: "system", stage: issue.status, round: session.round, payload: { prNumber: outcome.prNumber, prUrl: outcome.prUrl, headSha: outcome.headSha } });
  }

  if (routed.next === "spawn_reviewer" && outcome.kind === "clean_handoff") {
    transitionIssue(issue.id, "reviewing", {
      currentOwner: "reviewer",
      currentIntent: "Reviewer evaluating PR",
      headSha: outcome.headSha,
      baseSha: outcome.baseSha,
      prNumber: outcome.prNumber,
      prUrl: outcome.prUrl,
    });
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session.round, agentId: issue.reviewerAgentId, runtime: "claude_code", inputSha: outcome.headSha });
  } else if (routed.next === "retry_developer") {
    incrementIssueRound(issue.id);
    const next = getIssue(issue.id)!;
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
  } else if (routed.next === "human_action") {
    transitionIssue(issue.id, "needs_human", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: routed.actionType, reason: routed.reason, question: routed.reason });
  }

  if (outcome.kind !== "dirty_worktree") {
    await deps.worktree.removeWorktree({ repo: issue.repo, path: worktreePath, force: false }).catch(() => undefined);
  }
}

async function classifyDeveloperOutcome(
  issue: Issue,
  worktreePath: string,
  sessionStatus: "done" | "failed",
  deps: CoordinatorDeps
): Promise<DeveloperOutcome> {
  if (sessionStatus === "failed") return { kind: "session_failed" };
  const clean = await deps.worktree.isWorktreeClean(worktreePath);
  if (!clean) return { kind: "dirty_worktree" };
  try {
    const view = await deps.github.viewPr({ cwd: worktreePath });
    const baseSha = await deps.worktree.mergeBase({ repo: worktreePath, base: view.baseRefName, head: view.headRefName });
    return { kind: "clean_handoff", headSha: view.headRefOid, baseSha, prNumber: view.number, prUrl: view.url };
  } catch {
    return { kind: "no_pr" };
  }
}

async function runReviewerSession(
  issue: Issue,
  session: WorkerSession,
  worktreePath: string,
  deps: CoordinatorDeps
): Promise<void> {
  await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: session.inputSha ?? issue.headSha ?? issue.baseBranch, detach: true });

  const prompt = buildReviewerPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    baseSha: issue.baseSha ?? "",
    headSha: session.inputSha ?? issue.headSha ?? "",
  });

  let result;
  try {
    result = await deps.spawnReviewer(session, prompt);
  } catch {
    result = { exitCode: 1, transcript: "", logPath: "", timedOut: false };
  }

  const sessionStatus = result.exitCode === 0 && !result.timedOut ? "done" : "failed";
  completeSession(session.id, { status: sessionStatus, exitCode: result.exitCode, logPath: result.logPath });
  appendWorkflowEvent({ issueId: issue.id, workerSessionId: session.id, type: "worker.completed", actorType: "reviewer", stage: issue.status, round: session.round });

  const outcome = await classifyReviewerOutcome(issue, session, worktreePath, sessionStatus, result.transcript, deps);
  const routed = routeReviewerOutcome(outcome, { currentRound: issue.currentRound, maxReviewRounds: issue.maxReviewRounds });

  if (outcome.kind === "verdict") {
    appendWorkflowEvent({ issueId: issue.id, workerSessionId: session.id, type: "review.submitted", actorType: "reviewer", stage: issue.status, round: session.round, payload: outcome.result });
    for (const f of outcome.result.findings) {
      reconcileFinding({ issueId: issue.id, fingerprint: f.fingerprint, severity: f.severity, title: f.title, rationale: f.rationale, file: f.file, line: f.line, round: session.round });
    }
  }

  if (routed.next === "final_review") {
    transitionIssue(issue.id, "final_review", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: "final_review", reason: "Reviewer approved the PR", question: "Accept this work?" });
  } else if (routed.next === "retry_developer_with_findings") {
    transitionIssue(issue.id, "repairing", { currentOwner: "developer" });
    incrementIssueRound(issue.id);
    const next = getIssue(issue.id)!;
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
    appendWorkflowEvent({ issueId: issue.id, type: "repair.started", actorType: "system", stage: next.status, round: next.currentRound });
  } else if (routed.next === "retry_reviewer_same_head") {
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session.round, agentId: issue.reviewerAgentId, runtime: "claude_code", inputSha: issue.headSha });
  } else if (routed.next === "human_action") {
    transitionIssue(issue.id, "needs_human", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: routed.actionType, reason: routed.reason, question: routed.reason });
  }

  await deps.worktree.removeWorktree({ repo: issue.repo, path: worktreePath, force: true }).catch(() => undefined);
}

async function classifyReviewerOutcome(
  issue: Issue,
  session: WorkerSession,
  worktreePath: string,
  sessionStatus: "done" | "failed",
  transcript: string,
  deps: CoordinatorDeps
): Promise<ReviewerOutcome> {
  if (sessionStatus === "failed") return { kind: "session_failed" };

  const view = await deps.github.viewPr({ cwd: worktreePath }).catch(() => null);
  if (view && session.inputSha && view.headRefOid !== session.inputSha) {
    return { kind: "stale", currentHeadSha: view.headRefOid };
  }

  const parsed = parseReviewerResult(transcript);
  if (!parsed) return { kind: "session_failed" };

  if (issue.prNumber) {
    const event = parsed.verdict === "approved" ? "APPROVE" : parsed.verdict === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
    const bodyFile = path.join(os.tmpdir(), `review-${uuid()}.md`);
    const fs = await import("node:fs");
    fs.writeFileSync(bodyFile, transcript);
    const published = await deps.github.publishReview({ cwd: worktreePath, prNumber: issue.prNumber, event, bodyFilePath: bodyFile });
    if (!published.ok) return { kind: "publish_failed" };
  }

  return { kind: "verdict", result: parsed };
}

// packages/server/src/coordinator/session-lifecycle.ts
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { v4 as uuid } from "uuid";
import type { Issue, Runtime, WorkerSession } from "@agent-dealer/shared";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import {
  createWorkerSession,
  claimQueuedSession,
  completeSession,
  listWorkerSessionsForIssue,
  setSessionWorktreePath,
} from "../repository/worker-sessions.js";
import { startWorkflowInstance, appendWorkflowEvent } from "../repository/workflow-events.js";
import { createHumanAction } from "../repository/human-actions.js";
import { reconcileFinding, listFindingsForIssue } from "../repository/findings.js";
import { getAgent } from "../repository/agents.js";
import { addWorktree, removeWorktree, isWorktreeClean, mergeBase } from "../adapters/git-worktree.js";
import { viewPr, publishReview } from "../adapters/github.js";
import { spawnDeveloperSession, spawnReviewerSession } from "./spawn.js";
import { buildDeveloperPrompt, buildReviewerPrompt } from "./prompts.js";
import { parseReviewerResult, type ReviewerResult } from "./reviewer-result.js";
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

export interface ResolvedProfile {
  runtime: Runtime;
  model: string | null;
  deckId: string | null;
  playbookId: string | null;
}

/**
 * Resolves the selected agent profile's effective runtime/model/deck at session-creation
 * time so the recorded worker_session snapshots it (later profile edits don't rewrite
 * history). Falls back to claude_code only when no profile is set at all. Exported so
 * other call sites that create worker_sessions (e.g. the human-action resolve route's
 * repair-round restart) resolve the real profile instead of re-hardcoding a runtime.
 */
export function resolveProfile(agentId: string | null): ResolvedProfile {
  const agent = agentId ? getAgent(agentId) : null;
  return {
    runtime: agent?.runtime ?? "claude_code",
    model: agent?.defaultModel ?? agent?.defaultExecuteModel ?? null,
    deckId: agent?.deckId ?? null,
    playbookId: agent?.playbookId ?? null,
  };
}

export async function startIssueWorkflow(issueId: string, _deps: CoordinatorDeps = defaultCoordinatorDeps): Promise<void> {
  const issue = getIssue(issueId);
  if (!issue) throw new Error(`Issue not found: ${issueId}`);

  const instance = startWorkflowInstance(issueId, "dev_reviewer_v1");
  appendWorkflowEvent({ issueId, workflowInstanceId: instance.id, type: "workflow.started", actorType: "system", stage: "ready" });

  // Deciding and recording the branch name here (not just on a successful handoff) means
  // every developer round — including a round 1 that fails after creating the branch —
  // agrees on the same name, so repair rounds always check out the right ref.
  const branch = `issue-${issue.id}`;
  const updated = transitionIssue(issueId, "developing", {
    currentOwner: "developer",
    currentIntent: "Developer implementing round 1",
    branch,
  });

  const profile = resolveProfile(issue.developerAgentId);
  const session = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: issue.developerAgentId,
    runtime: profile.runtime,
    model: profile.model,
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

  const worktreePath = worktreePathFor(issue, claimed.role === "reviewer" ? "reviewer" : "developer", claimed.round);

  if (claimed.role === "developer") {
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
  const branch = issue.branch ?? `issue-${issue.id}`;
  if (session.round === 1) {
    await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: issue.baseBranch, newBranch: branch });
  } else {
    // Repair round: the branch already exists from round 1 (git worktree add -b creates
    // the branch in the repo, independent of that worktree's later removal) — check it
    // out as-is so work continues from the prior head instead of restarting from base.
    await deps.worktree.addWorktree({ repo: issue.repo, path: worktreePath, ref: branch });
  }
  const withPath = setSessionWorktreePath(session.id, worktreePath);

  const priorFindings = listFindingsForIssue(issue.id).filter((f) => f.status === "open" || f.status === "recurring");
  const profile = resolveProfile(issue.developerAgentId);
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    round: session.round,
    findings: priorFindings.length ? priorFindings : undefined,
    worktreePath,
    deckId: profile.deckId,
    playbookId: profile.playbookId,
  });

  let result;
  try {
    result = await deps.spawnDeveloper(withPath, prompt);
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
    const reviewerProfile = resolveProfile(issue.reviewerAgentId);
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session.round, agentId: issue.reviewerAgentId, runtime: reviewerProfile.runtime, model: reviewerProfile.model, inputSha: outcome.headSha });
  } else if (routed.next === "retry_developer") {
    incrementIssueRound(issue.id);
    const next = getIssue(issue.id)!;
    const developerProfile = resolveProfile(issue.developerAgentId);
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: developerProfile.runtime, model: developerProfile.model });
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
  const withPath = setSessionWorktreePath(session.id, worktreePath);

  const reviewerProfile = resolveProfile(issue.reviewerAgentId);
  const prompt = buildReviewerPrompt({
    taskSnapshot: { title: issue.title, description: issue.description ?? "", acceptanceCriteria: issue.acceptanceCriteria ?? "", repo: issue.repo, baseBranch: issue.baseBranch },
    baseSha: issue.baseSha ?? "",
    headSha: session.inputSha ?? issue.headSha ?? "",
    worktreePath,
    deckId: reviewerProfile.deckId,
    playbookId: reviewerProfile.playbookId,
  });

  let result;
  try {
    result = await deps.spawnReviewer(withPath, prompt);
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
    const developerProfile = resolveProfile(issue.developerAgentId);
    createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: developerProfile.runtime, model: developerProfile.model });
    appendWorkflowEvent({ issueId: issue.id, type: "repair.started", actorType: "system", stage: next.status, round: next.currentRound });
  } else if (routed.next === "retry_reviewer_at_new_head") {
    // Record the freshly verified head (never re-queue against the stale one) — the issue
    // stays in "reviewing" (self-loop) throughout, it never actually left that stage.
    transitionIssue(issue.id, "reviewing", { headSha: routed.headSha });
    createWorkerSession({ issueId: issue.id, role: "reviewer", round: session.round, agentId: issue.reviewerAgentId, runtime: reviewerProfile.runtime, model: reviewerProfile.model, inputSha: routed.headSha });
  } else if (routed.next === "human_action") {
    transitionIssue(issue.id, "needs_human", { currentOwner: "human" });
    createHumanAction({ issueId: issue.id, actionType: routed.actionType, reason: routed.reason, question: routed.reason });
  }

  await deps.worktree.removeWorktree({ repo: issue.repo, path: worktreePath, force: true }).catch(() => undefined);
}

/** Renders the coordinator's own normalized review body — never the agent's raw transcript. */
function renderReviewBody(result: ReviewerResult): string {
  const lines = [
    `**Verdict:** ${result.verdict}`,
    ``,
    `**Acceptance criteria:** ${result.acceptanceCriteriaAssessment}`,
    `**Evidence:** ${result.evidenceAssessment}`,
  ];
  if (result.findings.length) {
    lines.push(``, `**Findings:**`);
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      lines.push(`- [${f.severity}] ${f.title}${loc}: ${f.rationale}`);
    }
  }
  if (result.risks.length) {
    lines.push(``, `**Risks:**`);
    for (const r of result.risks) lines.push(`- ${r}`);
  }
  if (result.productScopeQuestion) {
    lines.push(``, `**Product scope question:** ${result.productScopeQuestion}`);
  }
  return lines.join("\n");
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

  // The coordinator is the only component that publishes — the reviewer has no git/GitHub
  // write access (see args.ts), so this is the sole place a review is ever submitted.
  if (issue.prNumber) {
    const event = parsed.verdict === "approved" ? "APPROVE" : parsed.verdict === "changes_requested" ? "REQUEST_CHANGES" : "COMMENT";
    const bodyFile = path.join(os.tmpdir(), `review-${uuid()}.md`);
    fs.writeFileSync(bodyFile, renderReviewBody(parsed));
    try {
      const published = await deps.github.publishReview({ cwd: worktreePath, prNumber: issue.prNumber, event, bodyFilePath: bodyFile });
      if (!published.ok) return { kind: "publish_failed" };
    } finally {
      fs.unlink(bodyFile, () => undefined);
    }
  }

  return { kind: "verdict", result: parsed };
}

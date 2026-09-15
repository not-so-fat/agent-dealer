// packages/server/src/coordinator/auto-merge.ts
//
// NOT-102: after reviewer approve with per-issue autoMerge, merge the PR then mark the
// issue done (skipping final_review). Runs *after* the routing transaction so `gh` never
// holds the SQLite write lock. Merge failures escalate to policy_escalation.
//
// Crash safety: routing parks the issue at final_review / system / AUTO_MERGE_INTENT with
// no human action. recoverStrandedAutoMerges() (startup + coordinator tick) retries
// finalize so a process death cannot leave the issue silently half-done. If `gh` already
// merged before the DB write, a re-run treats "already merged" as success.
//
// Network calls are async (promisify(execFile) + timeout) — never spawnSync on the
// coordinator event loop. A hung `gh` (auth prompt, outage, rate limit) must fail bounded
// and escalate, not freeze every other issue's work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { getIssue, listIssues, transitionIssue } from "../repository/issues.js";
import {
  appendWorkflowEvent,
  completeWorkflowInstance,
  getActiveWorkflowInstance,
} from "../repository/workflow-events.js";
import { createHumanAction } from "../repository/human-actions.js";

const run = promisify(execFile);

/** Bound each `gh` shell-out so a hang cannot freeze the coordinator process. */
export const GH_MERGE_TIMEOUT_MS = 20_000;

export type MergePrResult = { ok: true } | { ok: false; reason: string };

export type MergePr = (opts: { cwd: string; number: number }) => Promise<MergePrResult>;

/** Must match projection.ts's auto_merge currentIntent — recovery keys off this string. */
export const AUTO_MERGE_INTENT = "Auto-merging approved PR";

const ALREADY_MERGED = /already (been )?merged|pull request is not mergeable:.*merged/i;

function ghErrorReason(err: unknown, fallback: string): string {
  const e = err as {
    stderr?: string;
    stdout?: string;
    message?: string;
    killed?: boolean;
    signal?: string | null;
  };
  if (e.killed || e.signal === "SIGTERM") {
    return `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`;
  }
  return (e.stderr || e.stdout || e.message || fallback).trim() || fallback;
}

/** Production: mark draft ready (ignore if already), then squash-merge — async + timed. */
export const realMergePr: MergePr = async ({ cwd, number }) => {
  try {
    await run("gh", ["pr", "ready", String(number)], {
      cwd,
      encoding: "utf8",
      timeout: GH_MERGE_TIMEOUT_MS,
    });
  } catch {
    // Already ready / not a draft — ignore; merge is the authority.
  }
  try {
    await run("gh", ["pr", "merge", String(number), "--squash"], {
      cwd,
      encoding: "utf8",
      timeout: GH_MERGE_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const reason = ghErrorReason(err, "gh pr merge failed");
    // Crash between a successful merge and the done-transition: retry must not escalate.
    if (ALREADY_MERGED.test(reason)) return { ok: true };
    return { ok: false, reason };
  }
};

let mergePrImpl: MergePr = realMergePr;

/** Test hook — inject a fake so unit tests never shell out to `gh`. */
export function setMergePrForTests(fn: MergePr | null): void {
  mergePrImpl = fn ?? realMergePr;
}

export type AutoMergeFinalizeResult = {
  applied: true;
  issueStatus: Issue["status"];
  nextWorkItemId: null;
  humanActionId: string | null;
  instanceCompleted: boolean;
  triggerReflect: boolean;
};

/**
 * Completes an auto-merge parked in `final_review` / system ownership after reviewer
 * approve. Success → done + reflect; failure → needs_human + policy_escalation.
 * The `gh` merge runs outside any DB transaction (async); only the follow-up write is txn'd.
 */
export async function finalizeAutoMerge(issueId: string): Promise<AutoMergeFinalizeResult> {
  const issue = getIssue(issueId);
  if (!issue) {
    throw new Error(`finalizeAutoMerge: issue vanished ${issueId}`);
  }
  const instance = getActiveWorkflowInstance(issueId);
  if (!instance) {
    throw new Error(`finalizeAutoMerge: no active workflow for ${issueId}`);
  }
  if (issue.prNumber == null) {
    return escalateMergeFailure(issue, instance.id, "Reviewer approved but the issue has no PR number to merge.");
  }

  const merge = await mergePrImpl({ cwd: issue.repo, number: issue.prNumber });
  if (!merge.ok) {
    return escalateMergeFailure(issue, instance.id, `Auto-merge failed: ${merge.reason}`);
  }

  return getDb().transaction((): AutoMergeFinalizeResult => {
    const current = getIssue(issueId)!;
    const active = getActiveWorkflowInstance(issueId);
    if (!active) {
      return {
        applied: true,
        issueStatus: current.status,
        nextWorkItemId: null,
        humanActionId: null,
        instanceCompleted: false,
        triggerReflect: false,
      };
    }
    // Already completed by a concurrent recovery tick — do not double-complete.
    if (current.status === "done") {
      return {
        applied: true,
        issueStatus: "done",
        nextWorkItemId: null,
        humanActionId: null,
        instanceCompleted: true,
        triggerReflect: false,
      };
    }
    transitionIssue(issueId, "done", {
      currentOwner: "system",
      currentIntent: "Auto-merged after reviewer approval",
    });
    completeWorkflowInstance(active.id, "done");
    appendWorkflowEvent({
      issueId,
      workflowInstanceId: active.id,
      workerSessionId: null,
      type: "issue.completed",
      actorType: "system",
      stage: "done",
      round: current.currentRound,
      payload: { autoMerge: true, prNumber: current.prNumber },
    });
    return {
      applied: true,
      issueStatus: "done",
      nextWorkItemId: null,
      humanActionId: null,
      instanceCompleted: true,
      triggerReflect: true,
    };
  })();
}

function escalateMergeFailure(
  issue: Issue,
  workflowInstanceId: string,
  reason: string
): AutoMergeFinalizeResult {
  return getDb().transaction((): AutoMergeFinalizeResult => {
    const current = getIssue(issue.id)!;
    // Concurrent recovery already escalated — leave the open action alone.
    if (current.status === "needs_human") {
      return {
        applied: true,
        issueStatus: "needs_human",
        nextWorkItemId: null,
        humanActionId: null,
        instanceCompleted: false,
        triggerReflect: false,
      };
    }
    transitionIssue(issue.id, "needs_human", {
      currentOwner: "human",
      currentIntent: reason,
    });
    const action = createHumanAction({
      issueId: issue.id,
      workflowInstanceId,
      actionType: "policy_escalation",
      reason,
      question: `${reason} Resume development, or close the issue?`,
      responseOptions: [
        { choice: "resume", label: "Resume development" },
        { choice: "close", label: "Close" },
      ],
    });
    appendWorkflowEvent({
      issueId: issue.id,
      workflowInstanceId,
      workerSessionId: null,
      type: "human_action.requested",
      actorType: "system",
      stage: "needs_human",
      round: issue.currentRound,
      payload: { actionType: "policy_escalation", actionId: action.id, autoMergeFailed: true },
    });
    return {
      applied: true,
      issueStatus: "needs_human",
      nextWorkItemId: null,
      humanActionId: action.id,
      instanceCompleted: false,
      triggerReflect: false,
    };
  })();
}

/** Issues parked for auto-merge with no in-memory continuation (process crash / restart). */
export function listStrandedAutoMerges(): Issue[] {
  return listIssues("final_review").filter(
    (i) => i.autoMerge && i.currentOwner === "system" && i.currentIntent === AUTO_MERGE_INTENT
  );
}

/**
 * Retries finalizeAutoMerge for every stranded park. Called from startup recovery and the
 * coordinator poll so a crash after approve cannot leave the issue silently half-done.
 */
export async function recoverStrandedAutoMerges(): Promise<{ finalized: string[]; errors: string[] }> {
  const finalized: string[] = [];
  const errors: string[] = [];
  for (const issue of listStrandedAutoMerges()) {
    try {
      const result = await finalizeAutoMerge(issue.id);
      finalized.push(issue.id);
      if (result.triggerReflect) {
        void import("./reflect-trigger.js").then(({ triggerIssueReflect }) =>
          triggerIssueReflect(issue.id).catch(() => {})
        );
      }
    } catch (err) {
      errors.push(`${issue.id}: ${String(err)}`);
      console.error("[coordinator] recoverStrandedAutoMerges", issue.id, err);
    }
  }
  return { finalized, errors };
}

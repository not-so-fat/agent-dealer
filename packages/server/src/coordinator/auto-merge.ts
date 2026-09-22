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
//
// Concurrency: finalizeAutoMerge is single-flight per issueId (in-process). Success and
// escalate txns are also defensive if a racer already wrote done / needs_human.
//
// NOT-151: issue.repo is a portable GitHub identity after NOT-149 — never pass it to
// execFile as cwd (Node reports that as misleading `spawn gh ENOENT`). Resolve via
// classifyIssueRepo → managed/legacy local path first.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Issue } from "@agent-dealer/shared";
import { classifyIssueRepo } from "../adapters/managed-repo.js";
import { getDb } from "../db/index.js";
import { getIssue, listIssues, transitionIssue } from "../repository/issues.js";
import {
  appendWorkflowEvent,
  completeWorkflowInstance,
  getActiveWorkflowInstance,
} from "../repository/workflow-events.js";
import {
  createHumanAction,
  findOpenHumanAction,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { MERGE_FAILURE_EVIDENCE_KEY, MERGE_FAILURE_RESPONSE_OPTIONS } from "./human-resolution.js";

const run = promisify(execFile);

/** Bound each `gh` shell-out so a hang cannot freeze the coordinator process. */
export const GH_MERGE_TIMEOUT_MS = 20_000;

export type MergePrResult = { ok: true } | { ok: false; reason: string };

export type MergePr = (opts: { cwd: string; number: number }) => Promise<MergePrResult>;

/** Must match projection.ts's auto_merge currentIntent — recovery keys off this string. */
export const AUTO_MERGE_INTENT = "Auto-merging approved PR";

const ALREADY_MERGED = /already (been )?merged|pull request is not mergeable:.*merged/i;

/**
 * Map issue.repo (portable identity or legacy local path) to a real filesystem cwd for
 * `gh pr merge`. Missing managed clones fail closed with a clear reason — never hand the
 * identity string to execFile.
 */
export function resolveAutoMergeCwd(
  repoField: string
): { ok: true; cwd: string } | { ok: false; reason: string } {
  try {
    const classified = classifyIssueRepo(repoField);
    const cwd = classified.repoPath;
    if (classified.kind === "managed") {
      const hasGit =
        fs.existsSync(path.join(cwd, ".git")) || fs.existsSync(path.join(cwd, "HEAD"));
      if (!hasGit) {
        return {
          ok: false,
          reason: `Managed clone missing for ${classified.identity} (${cwd}). Re-run the developer step so Dealer can clone it, or restore the checkout under execution/repos.`,
        };
      }
    }
    return { ok: true, cwd };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when Node killed the child for exceeding `timeout` (promisify(execFile)). */
export function isGhTimeoutError(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null };
  return Boolean(e.killed || e.signal === "SIGTERM");
}

/** True when Node failed to spawn (missing binary *or* missing cwd — both surface ENOENT). */
export function isGhSpawnEnoent(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e.code === "ENOENT") return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("spawn") && msg.includes("enoent");
}

/**
 * Distinguish "cwd is not a real directory" from "gh missing on PATH" — both look like
 * `spawn gh ENOENT` from Node. Prefer checking the cwd on disk over trusting the message.
 */
export function ghSpawnEnoentReason(err: unknown, cwd: string): string | null {
  if (!isGhSpawnEnoent(err)) return null;
  if (!fs.existsSync(cwd)) {
    return `invalid merge cwd (${cwd}) — path does not exist (portable issue.repo must not be used as cwd)`;
  }
  return "gh not on PATH — install GitHub CLI (`gh`) and ensure the daemon can see it";
}

/** Map an execFile failure to a stable reason string (timeout vs stderr/stdout). */
export function ghErrorReason(err: unknown, fallback: string, cwd?: string): string {
  const e = err as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  if (isGhTimeoutError(err)) {
    return `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`;
  }
  if (cwd) {
    const spawnReason = ghSpawnEnoentReason(err, cwd);
    if (spawnReason) return spawnReason;
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
  } catch (err) {
    // Timeout is a hang, not "already ready" — fail closed so we do not burn another 20s on merge.
    if (isGhTimeoutError(err)) {
      return { ok: false, reason: ghErrorReason(err, "gh pr ready failed", cwd) };
    }
    // Bad cwd / missing gh on the ready step would also fail merge — surface now.
    const spawnReason = ghSpawnEnoentReason(err, cwd);
    if (spawnReason) {
      return { ok: false, reason: spawnReason };
    }
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
    const reason = ghErrorReason(err, "gh pr merge failed", cwd);
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
 * In-process single-flight for finalizeAutoMerge. Routing parks at final_review/system
 * *before* the async gh call; the next coordinator tick's recoverStrandedAutoMerges would
 * otherwise start a second finalize while the first is still merging. Concurrent callers
 * for the same issue share one Promise (set synchronously before any await).
 */
const finalizeInflight = new Map<string, Promise<AutoMergeFinalizeResult>>();

/** Test hook — clear single-flight state between cases. */
export function clearFinalizeInflightForTests(): void {
  finalizeInflight.clear();
}

/**
 * Completes an auto-merge parked in `final_review` / system ownership after reviewer
 * approve. Success → done + reflect; failure → needs_human + policy_escalation.
 * The `gh` merge runs outside any DB transaction (async); only the follow-up write is txn'd.
 * Concurrent calls for the same issue coalesce onto one in-flight Promise.
 */
export function finalizeAutoMerge(issueId: string): Promise<AutoMergeFinalizeResult> {
  const existing = finalizeInflight.get(issueId);
  if (existing) return existing;

  const promise = finalizeAutoMergeOnce(issueId).finally(() => {
    if (finalizeInflight.get(issueId) === promise) {
      finalizeInflight.delete(issueId);
    }
  });
  finalizeInflight.set(issueId, promise);
  return promise;
}

async function finalizeAutoMergeOnce(issueId: string): Promise<AutoMergeFinalizeResult> {
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

  const resolvedCwd = resolveAutoMergeCwd(issue.repo);
  if (!resolvedCwd.ok) {
    return escalateMergeFailure(issue, instance.id, `Auto-merge failed: ${resolvedCwd.reason}`);
  }

  const merge = await mergePrImpl({ cwd: resolvedCwd.cwd, number: issue.prNumber });
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
    // A racing failure path may have escalated first; a real merge success must still
    // land on done and dismiss the obsolete policy_escalation (needs_human → done is legal).
    if (current.status === "needs_human") {
      const open = findOpenHumanAction(issueId, "policy_escalation");
      if (open) {
        resolveHumanAction(open.id, "system", {
          choice: "dismissed",
          note: "auto-merge succeeded after concurrent failure escalation",
        });
      }
    }
    transitionIssue(issueId, "done", {
      currentOwner: "system",
      currentIntent: "Merged approved PR",
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
    // Concurrent success already completed — never open a dangling escalation on done.
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
    // Only escalate from the auto-merge park — any other status is a racer or a
    // non-parked issue; do not invent a policy_escalation there.
    if (current.status !== "final_review") {
      return {
        applied: true,
        issueStatus: current.status,
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
    // NOT-194: the work is approved, so "Resume development" is wrong. Offer a merge
    // retry on the current PR head, another repair round (same as final_review:repair),
    // or close. The reason keeps the underlying failure text verbatim so the operator can
    // pick retry vs repair. Evidence marks this as a merge failure for per-action choice
    // narrowing in resolveHumanActionAndAdvance (pre-NOT-194 open actions have no such
    // evidence and still resolve through resume).
    const action = createHumanAction({
      issueId: issue.id,
      workflowInstanceId,
      actionType: "policy_escalation",
      reason,
      question: `${reason} Retry the merge, queue another repair round, or close the issue?`,
      evidence: { [MERGE_FAILURE_EVIDENCE_KEY]: true },
      responseOptions: [...MERGE_FAILURE_RESPONSE_OPTIONS],
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

/** Issues parked for undraft+merge (autoMerge approve *or* human final_review:complete)
 * that are not already being finalized in this process. Keyed by AUTO_MERGE_INTENT —
 * not `autoMerge` — so autoMerge-off human accepts still recover after a crash. */
export function listStrandedAutoMerges(): Issue[] {
  return listIssues("final_review").filter(
    (i) =>
      i.currentOwner === "system" &&
      i.currentIntent === AUTO_MERGE_INTENT &&
      !finalizeInflight.has(i.id)
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

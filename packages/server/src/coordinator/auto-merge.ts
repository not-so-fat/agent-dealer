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
  findOpenHumanActionByRequestId,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { MERGE_FAILURE_EVIDENCE_KEY, MERGE_FAILURE_RESPONSE_OPTIONS } from "./human-resolution.js";
import { isMergeConflictFailure, runMergeConflictSync } from "./merge-conflict-sync.js";
import { triggerLinearPostMerge } from "./linear-merge-verify.js";
import { startBaseAdvancedScan } from "./base-advanced-scan.js";
import { runHeldWork } from "../power/host-awake-lifecycle.js";
import {
  OPERATOR_VERIFICATION_RESPONSE_OPTIONS,
  formatOperatorCriteria,
  getOperatorCriteriaForIssue,
  hasOperatorVerificationForHead,
  operatorVerificationRequestId,
} from "./operator-criteria.js";

const run = promisify(execFile);

/** Bound each `gh` shell-out so a hang cannot freeze the coordinator process. */
export const GH_MERGE_TIMEOUT_MS = 20_000;

/** `alreadyMerged`: GitHub reported the PR merged before this call — not a merge
 * Dealer just made (crash recovery, or a human merged it by hand). */
export type MergePrResult = { ok: true; alreadyMerged?: boolean } | { ok: false; reason: string };

export type MergePr = (opts: { cwd: string; number: number }) => Promise<MergePrResult>;

/** Must match projection.ts's auto_merge currentIntent — recovery keys off this string. */
export const AUTO_MERGE_INTENT = "Auto-merging approved PR";

/**
 * NOT-314: the issue intent while an `[operator]` gate holds the merge. Named
 * verbatim by the ticket: the PR stays unmerged in `needs_human` under this intent
 * until the human records a result or waives the criterion.
 */
export const OPERATOR_VERIFICATION_INTENT = "Operator verification required before merge";

/**
 * NOT-314 fail-closed: the stable request id for the no-head escalation, so
 * repeat finalizes dedupe onto the one open `policy_escalation` instead of
 * stacking a new one per tick.
 */
export const OPERATOR_VERIFICATION_NO_HEAD_REQUEST_ID = "operator-verification-blocked:no-head";

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
    if (ALREADY_MERGED.test(reason)) return { ok: true, alreadyMerged: true };
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
  /** NOT-310: the queued conflict-repair round, when the finalize queued one. */
  nextWorkItemId: string | null;
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

/** NOT-356: whether this process is merging the issue's PR right now. */
export function isAutoMergeInFlight(issueId: string): boolean {
  return finalizeInflight.has(issueId);
}

/** Test hook — clear single-flight state between cases. */
export function clearFinalizeInflightForTests(): void {
  finalizeInflight.clear();
}

/** Test seam: replace finalizeAutoMergeOnce inside the host-awake hold (lifecycle tests). */
let finalizeOnceForTests: ((issueId: string) => Promise<AutoMergeFinalizeResult>) | null = null;

export function setFinalizeAutoMergeOnceForTests(
  fn: ((issueId: string) => Promise<AutoMergeFinalizeResult>) | null
): void {
  finalizeOnceForTests = fn;
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

  // NOT-369: hold idle-sleep for the merge/publish step; release when it settles.
  const promise = runHeldWork(() =>
    (finalizeOnceForTests ?? finalizeAutoMergeOnce)(issueId)
  ).finally(() => {
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

  // NOT-314 seam: this finalize is the single path from reviewer-approve to the
  // `gh` merge — auto-merge-on routes here from applyCompletion, auto-merge-off
  // arrives via final_review:merge / policy_escalation:retry_merge, and crash
  // recovery re-enters through recoverStrandedAutoMerges. An `[operator]`
  // criterion in the frozen snapshot blocks here (PR unmerged, needs_human)
  // until a human records the result for the current head.
  const operatorBlock = gateOperatorVerification(issue.id);
  if (operatorBlock) return operatorBlock;

  const resolvedCwd = resolveAutoMergeCwd(issue.repo);
  if (!resolvedCwd.ok) {
    return escalateMergeFailure(issue, instance.id, `Auto-merge failed: ${resolvedCwd.reason}`);
  }

  let merge = await mergePrImpl({ cwd: resolvedCwd.cwd, number: issue.prNumber });
  // NOT-310: a not-mergeable failure is staleness Dealer can resolve itself —
  // sync the base, re-verify, retry — instead of escalating with no way forward.
  // Anything the sync refuses or cannot fix degrades to today's escalation.
  // retry_merge parks into this same finalize, so it is covered automatically.
  if (!merge.ok && isMergeConflictFailure(merge.reason) && issue.branch) {
    const sync = await runMergeConflictSync({
      issueId: issue.id,
      instanceId: instance.id,
      repo: issue.repo,
      branch: issue.branch,
      baseBranch: issue.baseBranch,
      prNumber: issue.prNumber,
      mergeReason: merge.reason,
      mergePr: mergePrImpl,
    });
    if (sync.outcome === "merged") {
      merge = sync.alreadyMerged ? { ok: true, alreadyMerged: true } : { ok: true };
    } else if (sync.outcome === "repair_queued") {
      return {
        applied: true,
        issueStatus: "repairing",
        nextWorkItemId: sync.workItemId,
        humanActionId: null,
        instanceCompleted: false,
        triggerReflect: false,
      };
    } else if (sync.outcome === "escalate") {
      return escalateMergeFailure(issue, instance.id, sync.reason, sync.evidence);
    } else {
      return escalateMergeFailure(issue, instance.id, `Auto-merge failed: ${merge.reason}`);
    }
  }
  if (!merge.ok) {
    return escalateMergeFailure(issue, instance.id, `Auto-merge failed: ${merge.reason}`);
  }

  const merged = getDb().transaction((): AutoMergeFinalizeResult => {
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
  // NOT-362: the merge landed — confirm the Linear source issue advanced (or
  // advance/flag it). Fire-and-forget: the check's bounded retry window (tens of
  // seconds) must not hold this finalize, which runs while holding the reviewer
  // session and slot. Never touches this issue's status, so it cannot change
  // the merge's result. Runs on every `done` landing, including the
  // already-merged recovery path.
  if (merged.issueStatus === "done") {
    triggerLinearPostMerge(issueId);
  }
  // NOT-356: the base just moved under every other open Dealer PR on this repo +
  // base — probe them and resolve the idle conflicting ones. Background and
  // self-contained: nothing it does can change this merge's result. Only for a
  // merge this call made: a PR GitHub already reports merged (a human merged it,
  // or a crash recovery re-runs the finalize) is not Dealer's merge.
  if (merged.triggerReflect && !merge.alreadyMerged) startBaseAdvancedScan(getIssue(issueId) ?? issue);
  return merged;
}

/**
 * NOT-314: the `[operator]` merge gate. After reviewer approve and before the
 * `gh` merge: when the frozen snapshot holds operator criteria and no result is
 * recorded for the current head (a `verified` artifact or a
 * `operator_verification.waived` event — both head-pinned), the PR stays
 * unmerged and the issue parks in `needs_human` with an `operator_verification`
 * action listing each criterion and its command.
 *
 * Returns null when the merge may proceed (no operator criteria, a recorded
 * result for this head, or no workflow to gate). Idempotent: a second finalize
 * for the same head reuses the open action instead of raising another.
 *
 * Fail-closed: when operator criteria exist, every non-proceed path returns a
 * result (never null), so a missing head SHA or an unexpected status blocks the
 * `gh` merge instead of letting it through.
 */
export function gateOperatorVerification(issueId: string): AutoMergeFinalizeResult | null {
  return getDb().transaction((): AutoMergeFinalizeResult | null => {
    const current = getIssue(issueId);
    if (!current) return null;
    const active = getActiveWorkflowInstance(issueId);
    if (!active) return null;
    const criteria = getOperatorCriteriaForIssue(current);
    if (criteria.length === 0) return null;
    const head = current.headSha;
    if (head && hasOperatorVerificationForHead(issueId, head)) return null;
    if (current.status === "done") return null;
    // Only the auto-merge park (or an already-gated issue) is gated — any other
    // status is a racer or a non-parked issue; do not invent an action there,
    // but do not let the merge through either — park the finalize as a no-op.
    if (current.status !== "final_review" && current.status !== "needs_human") {
      return {
        applied: true,
        issueStatus: current.status,
        nextWorkItemId: null,
        humanActionId: null,
        instanceCompleted: false,
        triggerReflect: false,
      };
    }
    // No head SHA to pin the verification to (no handoff recorded one): the
    // gate cannot name a head, so escalate instead of merging — retry_merge
    // re-enters this same finalize once a head exists and gates normally.
    // Repeat finalizes reuse the one open escalation (no duplicate action or
    // event), and the transition is skipped when already parked
    // (needs_human has no self-loop).
    if (!head) {
      const retry = findOpenHumanActionByRequestId(
        issueId,
        "policy_escalation",
        OPERATOR_VERIFICATION_NO_HEAD_REQUEST_ID
      );
      if (retry) {
        if (current.status !== "needs_human") {
          transitionIssue(issueId, "needs_human", {
            currentOwner: "human",
            currentIntent: OPERATOR_VERIFICATION_INTENT,
          });
        }
        return {
          applied: true,
          issueStatus: "needs_human",
          nextWorkItemId: null,
          humanActionId: retry.id,
          instanceCompleted: false,
          triggerReflect: false,
        };
      }
      const reason =
        `Reviewer approved, but ${criteria.length} acceptance ` +
        `${criteria.length === 1 ? "criterion requires" : "criteria require"} a human operator ` +
        `to verify (tagged [operator] in the frozen task snapshot) and no head SHA is ` +
        `recorded to pin the verification to. The PR stays unmerged.`;
      if (current.status !== "needs_human") {
        transitionIssue(issueId, "needs_human", {
          currentOwner: "human",
          currentIntent: reason,
        });
      }
      const action = createHumanAction({
        issueId,
        workflowInstanceId: active.id,
        actionType: "policy_escalation",
        reason,
        question: `${reason} Retry the merge once a head is recorded, queue another repair round, or close the issue?`,
        evidence: { [MERGE_FAILURE_EVIDENCE_KEY]: true, operatorVerificationBlocked: true },
        responseOptions: [...MERGE_FAILURE_RESPONSE_OPTIONS],
        requestId: OPERATOR_VERIFICATION_NO_HEAD_REQUEST_ID,
      });
      appendWorkflowEvent({
        issueId,
        workflowInstanceId: active.id,
        workerSessionId: null,
        type: "human_action.requested",
        actorType: "system",
        stage: "needs_human",
        round: current.currentRound,
        payload: { actionType: "policy_escalation", actionId: action.id, operatorVerificationBlocked: true },
      });
      return {
        applied: true,
        issueStatus: "needs_human",
        nextWorkItemId: null,
        humanActionId: action.id,
        instanceCompleted: false,
        triggerReflect: false,
      };
    }

    const existing = findOpenHumanAction(issueId, "operator_verification");
    if (existing && operatorActionHeadSha(existing) === head) {
      if (current.status !== "needs_human") {
        transitionIssue(issueId, "needs_human", {
          currentOwner: "human",
          currentIntent: OPERATOR_VERIFICATION_INTENT,
        });
      }
      return {
        applied: true,
        issueStatus: "needs_human",
        nextWorkItemId: null,
        humanActionId: existing.id,
        instanceCompleted: false,
        triggerReflect: false,
      };
    }

    const shortHead = head.slice(0, 8);
    const reason =
      `Reviewer approved ${shortHead}, but ${criteria.length} acceptance ` +
      `${criteria.length === 1 ? "criterion requires" : "criteria require"} a human operator ` +
      `to verify (tagged [operator] in the frozen task snapshot) and no result is recorded ` +
      `for this head. The PR stays unmerged until the result is recorded:\n` +
      formatOperatorCriteria(criteria).join("\n");
    transitionIssue(issueId, "needs_human", {
      currentOwner: "human",
      currentIntent: OPERATOR_VERIFICATION_INTENT,
    });
    // Head-pinned request_id: a concurrent finalize for the same head dedupes
    // onto this action through createHumanAction's open-request conflict path;
    // new commits after the gate get a fresh action with their own commands.
    const action = createHumanAction({
      issueId,
      workflowInstanceId: active.id,
      actionType: "operator_verification",
      reason,
      question:
        `${reason}\n\nPaste the probe output to record verification, waive with a reason, ` +
        `or send the work back for another repair round?`,
      evidence: { operatorVerification: { criteria, headSha: head } },
      responseOptions: [...OPERATOR_VERIFICATION_RESPONSE_OPTIONS],
      requestId: operatorVerificationRequestId(head),
    });
    appendWorkflowEvent({
      issueId,
      workflowInstanceId: active.id,
      workerSessionId: null,
      type: "human_action.requested",
      actorType: "system",
      stage: "needs_human",
      round: current.currentRound,
      payload: { actionType: "operator_verification", actionId: action.id, headSha: head },
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

/** The head SHA an `operator_verification` action gates (null when unreadable). */
function operatorActionHeadSha(action: { evidenceJson: string | null }): string | null {
  if (!action.evidenceJson) return null;
  try {
    const evidence = JSON.parse(action.evidenceJson) as {
      operatorVerification?: { headSha?: unknown };
    };
    const headSha = evidence.operatorVerification?.headSha;
    return typeof headSha === "string" && headSha ? headSha : null;
  } catch {
    return null;
  }
}

function escalateMergeFailure(
  issue: Issue,
  workflowInstanceId: string,
  reason: string,
  evidence: Record<string, unknown> = { [MERGE_FAILURE_EVIDENCE_KEY]: true }
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
      evidence,
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

// packages/server/src/coordinator/merge-conflict-sync.ts
//
// NOT-310: when an approved PR cannot merge because the base moved ("not
// mergeable"), resolve it in the merge path instead of escalating with no way
// forward: bring the PR branch up to date with the base in a coordinator-owned
// worktree, wait for checks, and retry the merge once. A textual conflict aborts
// the sync and queues one developer repair round whose prompt names the base and
// the conflicting files; a still-conflicting merge after that round escalates
// once with the file list.
//
// "Not mergeable" is broader than staleness (branch policy, dismissed
// approvals), so a retry that still fails only earns the repair round when the
// base actually advanced past the synced tip — otherwise the branch is already
// up to date and Dealer escalates directly with the retry's reason instead of
// spending a round on a false "base moved". Note the sync push itself can
// dismiss the approval the merge depended on in repos with dismiss-stale-
// approvals; that retry failure then takes this same direct-escalation path.
//
// NOT-354 adds a second entry point, `checks_wait`: a developer PR that conflicts
// with its base while Dealer waits for CI never gets checks (GitHub creates no
// merge ref), so the developer effect runs this same sync instead of deferring
// "Waiting for CI (queued)" forever. That entry stops at the push (no checks
// poll, no merge retry — the deferred CI wait re-polls the pushed head) and does
// not queue the repair round itself: the effect still holds its work item's
// lease, so applyCompletion queues it through {@link queueConflictRepairRound}
// while finishing that item. One sync per episode there too — a later conflict
// after a checks-wait sync earns the repair round, never a second sync.
//
// NOT-356 adds `base_advanced`: right after Dealer merges a PR, each idle sibling
// PR on the same repo + base that the probe says now conflicts runs this same
// push-only sync (see base-advanced-scan.ts). It shares the checks-wait shape —
// stop at the push, return `synced` / `repair_needed` — and the same one-sync
// bound: a push-only sync of either entry spends the episode's sync.
//
// Bound: at most one automatic sync + one conflict-repair round per
// merge-failure episode. The episode resets on any resolved human action (a
// retry_merge / repair click starts a fresh episode); the repair-spent marker is
// the append-only `auto_merge.conflict_repair_queued` event, which no
// requeue/defer can rewrite the way a work-item payload could be.
//
// Safety: the sync checkout starts at exactly what Dealer pushed (NOT-219 reuse
// semantics) and is removed afterwards; the push is always a plain
// `git push -u origin HEAD:refs/heads/<branch>` — never force, never a lease
// retry, never a rebase. A pre-push hook pins that push to the tip we merged
// onto (see {@link pinnedPushEnv}), so even a hand reset to an ancestor landing
// after the last tip read is refused instead of fast-forwarded over; the
// repository's own pre-push hook is chained and still vetoes the push. An existing checkout holding the branch belongs to
// someone else and fails closed to today's escalation, except our own
// merge-sync leftover from a crashed run (dead owner + clean tree), which is
// adopted. Every refusal or infra failure degrades to today's escalation — the
// sync only ever adds a self-resolution attempt, never removes an outcome.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Issue, IssueStatus } from "@agent-dealer/shared";
import type { MergePr } from "./auto-merge.js";
import type { ConflictRepairDirective } from "./prompts.js";
import {
  MERGE_CONFLICT_FILES_EVIDENCE_KEY,
  MERGE_FAILURE_EVIDENCE_KEY,
} from "./human-resolution.js";
import { getAgent } from "../repository/agents.js";
import { listHumanActionsForIssue, resolveHumanAction } from "../repository/human-actions.js";
import { getActiveWorkerSessionForIssue } from "../repository/worker-sessions.js";
import { getDb } from "../db/index.js";
import { getIssue, incrementIssueRound, transitionIssue } from "../repository/issues.js";
import {
  cancelWorkItem,
  enqueueWorkItem,
  finishWorkItem,
  listWorkItemsForIssue,
  dropReservedWorkItem,
  releaseReservedWorkItem,
  reserveWorkItem,
} from "../repository/work-items.js";
import {
  appendWorkflowEvent,
  getActiveWorkflowInstance,
  listWorkflowEventsForIssue,
} from "../repository/workflow-events.js";
import {
  addWorktree,
  DEFAULT_BASE_FETCH_TIMEOUT_MS,
  fastForwardLocalBranchToSha,
  fetchFreshBase,
  fetchReusedBranch,
  findWorktreeForBranch,
  isAncestor,
  isWorktreeClean,
  pruneWorktrees,
  removeWorktree,
  revParseHead,
  safeRemoveWorktree,
} from "../adapters/git-worktree.js";
import {
  classifyIssueRepo,
  worktreesRootForResolution,
} from "../adapters/managed-repo.js";
import {
  pollPrChecks,
  realGithubAdapter,
  type GithubAdapter,
  type PollChecksResult,
} from "../adapters/github.js";
import { withRepoLock } from "../runners/process-registry.js";
import { checkDeveloperWorktreeOwnerLiveness } from "./worktree-owner-liveness.js";
import { buildProfileSnapshot, serializeProfileSnapshot } from "./profile-snapshot.js";

const run = promisify(execFile);

/** `gh pr merge` wording for a branch that no longer merges cleanly. */
const NOT_MERGEABLE_PATTERN = /not mergeable/i;
/** `gh`'s CONFLICTING mergeable state and conflict failure text. */
const CONFLICT_PATTERN = /conflict/i;

/**
 * Whether a merge-failure reason means "the branch conflicts with the base"
 * (worth a base sync) rather than an infra failure (timeout, missing cwd, auth)
 * or a non-staleness rejection (protected branch, failed checks). Either signal
 * from the ticket — `mergeable = CONFLICTING` or the `gh` message — classifies;
 * the message alone suffices because a failed `gh pr merge` already reports it.
 */
export function isMergeConflictFailure(reason: string): boolean {
  return NOT_MERGEABLE_PATTERN.test(reason) || CONFLICT_PATTERN.test(reason);
}

/** The sync's `git` shell-out, as a seam: production execFiles real git, tests
 * inject a recorder (delegating or fake) to assert exact CLI args. */
export type SyncGitExec = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }
) => Promise<{ stdout: string; stderr: string }>;

/** Failure from {@link defaultSyncGitExec} — `killed` marks a timeout kill, as
 * opposed to git itself exiting nonzero (a merge reporting conflicts). */
export class SyncGitError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  constructor(
    message: string,
    opts: { stdout: string; stderr: string; killed: boolean }
  ) {
    super(message);
    this.name = "SyncGitError";
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.killed = opts.killed;
  }
}

export const defaultSyncGitExec: SyncGitExec = async (args, opts) => {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const detail = stderr.trim() || e.message || `git ${args.join(" ")} failed`;
    throw new SyncGitError(detail, {
      stdout,
      stderr,
      killed: e.killed === true,
    });
  }
};

let gitExecImpl: SyncGitExec = defaultSyncGitExec;

/** Test hook — record or fake the sync's merge/push/abort shell-outs. */
export function setConflictSyncGitExecForTests(exec: SyncGitExec | null): void {
  gitExecImpl = exec ?? defaultSyncGitExec;
}

/** The checks poll only ever needs `checksSnapshot` — the seam takes that
 * narrow slice so tests inject one function, while production passes the full
 * real adapter. */
export type ConflictSyncGithub = Pick<GithubAdapter, "checksSnapshot">;

let githubImpl: ConflictSyncGithub = realGithubAdapter;

/** Test hook — fake the post-push checks poll (never hits real `gh`). */
export function setConflictSyncGithubForTests(adapter: ConflictSyncGithub | null): void {
  githubImpl = adapter ?? realGithubAdapter;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Sync bounds. The checks poll reads the same env as `developerEffectConfig`
 * (one operator-facing knob for "how long CI may take"); the import is not
 * shared because merge-conflict-sync → developer-effect would cycle through
 * commands/auto-merge.
 */
export const mergeSyncConfig = {
  get syncGitTimeoutMs(): number {
    return numEnv("MERGE_SYNC_GIT_TIMEOUT_MS", DEFAULT_BASE_FETCH_TIMEOUT_MS);
  },
  get checksPollTimeoutMs(): number {
    return numEnv("CHECKS_POLL_TIMEOUT_MS", 10 * 60_000);
  },
  get checksPollIntervalMs(): number {
    return numEnv("CHECKS_POLL_INTERVAL_MS", 15_000);
  },
};

/** Cap for the conflicting-file list in escalation text/evidence. */
export const CONFLICTING_FILES_MAX = 20;

/** Coordinator-owned sync checkout infix — adoption + stale-dir removal only
 * ever touch paths under this name, never a worker session's checkout. */
const SYNC_PATH_INFIX = "merge-sync-";

/** Explicit identity for the sync's merge commit — coordinator checkouts must
 * not depend on whatever a worker happened to configure (mirrors the salvage
 * commit in git-worktree.ts). The squash-merge erases it anyway. */
const SYNC_GIT_IDENTITY_ARGS = [
  "-c",
  "user.email=agent-dealer@localhost",
  "-c",
  "user.name=Agent Dealer",
];

export type ConflictSyncOutcome =
  /** The post-sync merge retry succeeded — the caller runs its success txn.
   * `alreadyMerged` carries the retry's provenance (see MergePrResult). */
  | { outcome: "merged"; alreadyMerged?: boolean }
  /** A conflict-repair developer round was queued; the caller reports repairing. */
  | { outcome: "repair_queued"; workItemId: string; round: number }
  /** Escalate with this reason/evidence (repair spent, or sync infra failed). */
  | { outcome: "escalate"; reason: string; evidence: Record<string, unknown> }
  /** The sync was not applicable — the caller escalates exactly as today. NOT-356:
   * `tip_moved` when origin was not the caller's `expectedHeadSha`, `refused` when
   * its `reservePush` guard declined the push. */
  | { outcome: "skipped"; reason: string; code?: "tip_moved" | "refused" }
  /** NOT-354 `checks_wait` only: the base merged cleanly and was pushed. */
  | { outcome: "synced"; headSha: string | null }
  /** NOT-354 `checks_wait` only: a conflict-repair round is due — the caller queues
   * it via {@link queueConflictRepairRound} while finishing its leased item. */
  | { outcome: "repair_needed"; files: string[] };

/** NOT-354: which path asked for the sync — see the module doc. NOT-355's
 * `pre_publish` only ever queues the repair round (the probe never syncs); like
 * `checks_wait` it runs in the developer stage with the lease held. NOT-356's
 * `base_advanced` syncs an idle sibling after Dealer merged another PR. */
export type ConflictSyncEntry = "merge" | "checks_wait" | "pre_publish" | "base_advanced";

/** Entries whose sync stops at the push and never retries a merge. */
const PUSH_ONLY_ENTRIES: ReadonlySet<ConflictSyncEntry> = new Set(["checks_wait", "base_advanced"]);

function parseRepairFiles(payloadJson: string | null): string[] {
  if (!payloadJson) return [];
  try {
    const parsed = JSON.parse(payloadJson) as { files?: unknown };
    return Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Whether a conflict-repair round already ran for this merge-failure episode:
 * the latest `auto_merge.conflict_repair_queued` event for this instance with
 * no `human_action.resolved` after it. A human resolution (retry_merge, repair,
 * or anything else) starts a fresh episode. Returns the spent round's file list
 * for the escalation.
 */
export function conflictRepairSpent(
  issueId: string,
  instanceId: string
): { spent: boolean; files: string[] } {
  const events = listWorkflowEventsForIssue(issueId).filter(
    (e) => e.workflowInstanceId === instanceId
  );
  let lastRepair = -1;
  let lastResolved = -1;
  let files: string[] = [];
  events.forEach((e, index) => {
    if (e.type === "auto_merge.conflict_repair_queued") {
      lastRepair = index;
      files = parseRepairFiles(e.payloadJson);
    } else if (e.type === "human_action.resolved") {
      lastResolved = index;
    }
  });
  return lastRepair > lastResolved
    ? { spent: true, files }
    : { spent: false, files: [] };
}

/**
 * NOT-354: whether a checks-wait sync already pushed the base this episode (same
 * episode rule as {@link conflictRepairSpent}). Merge-entry syncs never count —
 * that path retries the merge in the same call, so it cannot sync twice.
 * NOT-356: a `base_advanced` sync counts too — one push-only sync per episode,
 * whichever path ran it.
 */
export function checksWaitSyncSpent(issueId: string, instanceId: string): boolean {
  const events = listWorkflowEventsForIssue(issueId).filter(
    (e) => e.workflowInstanceId === instanceId
  );
  let lastSync = -1;
  let lastResolved = -1;
  events.forEach((e, index) => {
    if (e.type === "auto_merge.conflict_sync") {
      try {
        const payload = JSON.parse(e.payloadJson ?? "{}") as { outcome?: unknown; entry?: unknown };
        if (
          typeof payload.entry === "string" &&
          PUSH_ONLY_ENTRIES.has(payload.entry as ConflictSyncEntry) &&
          payload.outcome === "synced"
        ) {
          lastSync = index;
        }
      } catch {
        // unreadable audit payload cannot mark a sync
      }
    } else if (e.type === "human_action.resolved") {
      lastResolved = index;
    }
  });
  return lastSync > lastResolved;
}

/**
 * Mirrors commands.ts's `queuedProfileSnapshot` (kept local: auto-merge →
 * commands would close an import cycle — commands already imports auto-merge).
 */
function queuedDeveloperProfileSnapshot(issue: Issue): string | null {
  const agent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
  return agent ? serializeProfileSnapshot(buildProfileSnapshot(agent, "developer")) : null;
}

/** Mirrors commands.ts's `resumeWorkItemKey` collision scan for the same reason. */
function conflictRepairWorkItemKey(issueId: string, instanceId: string, round: number): string {
  const taken = new Set(listWorkItemsForIssue(issueId).map((w) => w.idempotencyKey));
  const base = `${instanceId}:developer:conflict-repair:${round}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}:${n}`)) n++;
  return `${base}:${n}`;
}

function auditSync(
  input: {
    issueId: string;
    instanceId: string;
    branch: string;
    baseBranch: string;
    entry: ConflictSyncEntry;
  },
  outcome: string,
  detail?: Record<string, unknown>
): void {
  try {
    const issue = getIssue(input.issueId);
    appendWorkflowEvent({
      issueId: input.issueId,
      workflowInstanceId: input.instanceId,
      workerSessionId: null,
      type: "auto_merge.conflict_sync",
      actorType: "system",
      stage: input.entry === "merge" ? "final_review" : (issue?.status ?? "developing"),
      round: issue?.currentRound ?? null,
      payload: {
        outcome,
        branch: input.branch,
        baseBranch: input.baseBranch,
        ...(input.entry === "merge" ? {} : { entry: input.entry }),
        ...(detail ?? {}),
      },
    });
  } catch {
    // Audit only — observability must never fail the merge path.
  }
}

function formatFileList(files: string[]): string {
  const shown = files.slice(0, CONFLICTING_FILES_MAX);
  const extra = files.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` (and ${extra} more)` : "");
}

/**
 * Queues the conflict-repair developer round: final_review → repairing (a
 * genuine repair cycle spending a review round, like merge-failure "repair"),
 * with the conflict directive on the work-item payload for exactly this round.
 * Null when the issue left the merge park first (a racer won) — the caller
 * then falls back to today's escalation, which no-ops off-park itself.
 *
 * NOT-354 `checks_wait`: the issue is still in its developer stage (developing
 * or repairing, which it keeps), and `finish` names the leased developer item
 * the CI wait ran in — it is CAS-finished in the same transaction, so a lost
 * lease queues nothing (null). NOT-355 `pre_publish` queues the same way.
 *
 * NOT-356 `base_advanced`: the sibling is idle (no lease, no running session —
 * re-checked here, in the same transaction), so its parked next step is
 * superseded: pending work items (a deferred CI wait, a queued reviewer) are
 * cancelled and its open human gates (final_review, a needs_human escalation) are
 * dismissed. A developer-stage issue keeps its status; a reviewing / final_review /
 * needs_human one moves to repairing. `guard` re-checks the caller's idleness rule
 * inside the transaction (a non-null reason queues nothing).
 */
export function queueConflictRepairRound(input: {
  issueId: string;
  instanceId: string;
  baseBranch: string;
  branch: string;
  files: string[];
  entry?: ConflictSyncEntry;
  finish?: { workItemId: string; leaseToken: string; result: unknown };
  guard?: () => string | null;
}): { id: string; round: number } | null {
  return getDb().transaction(() => {
    const current = getIssue(input.issueId);
    if (!current) return null;
    const baseAdvanced = input.entry === "base_advanced";
    const developerStage =
      input.entry === "checks_wait" ||
      input.entry === "pre_publish" ||
      (baseAdvanced && (current.status === "developing" || current.status === "repairing"));
    const fromStatuses: IssueStatus[] = baseAdvanced
      ? BASE_ADVANCED_STATUSES
      : developerStage
        ? ["developing", "repairing"]
        : ["final_review"];
    if (!fromStatuses.includes(current.status)) return null;
    const active = getActiveWorkflowInstance(input.issueId);
    if (!active || active.id !== input.instanceId) return null;
    if (baseAdvanced) {
      if (!siblingIdle(input.issueId, input.guard)) return null;
      supersedeParkedStep(
        input.issueId,
        `superseded: ${input.baseBranch} advanced and the PR now conflicts; conflict-repair round queued`
      );
    }
    if (
      input.finish &&
      !finishWorkItem(input.finish.workItemId, input.finish.leaseToken, {
        status: "done",
        result: input.finish.result,
      })
    ) {
      return null;
    }
    const toStatus: IssueStatus = developerStage ? current.status : "repairing";
    const round = current.currentRound + 1;
    incrementIssueRound(input.issueId);
    transitionIssue(input.issueId, toStatus, {
      currentOwner: "developer",
      currentIntent: `Resolving merge conflict with ${input.baseBranch} (round ${round})`,
    });
    appendWorkflowEvent({
      issueId: input.issueId,
      workflowInstanceId: active.id,
      workerSessionId: null,
      type: "repair.started",
      actorType: "system",
      stage: toStatus,
      round,
    });
    const directive: ConflictRepairDirective = {
      baseBranch: input.baseBranch,
      branch: input.branch,
      files: input.files,
    };
    const item = enqueueWorkItem({
      issueId: input.issueId,
      workflowInstanceId: active.id,
      kind: "developer",
      round,
      payload: {
        profileSnapshot: queuedDeveloperProfileSnapshot(current),
        conflictRepair: directive,
      },
      idempotencyKey: conflictRepairWorkItemKey(input.issueId, active.id, round),
    });
    appendWorkflowEvent({
      issueId: input.issueId,
      workflowInstanceId: active.id,
      workerSessionId: null,
      type: "auto_merge.conflict_repair_queued",
      actorType: "system",
      stage: toStatus,
      round,
      payload: {
        baseBranch: input.baseBranch,
        branch: input.branch,
        files: input.files,
        round,
        workItemId: item.id,
      },
    });
    return { id: item.id, round };
  })();
}

/** NOT-356: the stages an idle sibling PR can be parked in when its base advances. */
export const BASE_ADVANCED_STATUSES: IssueStatus[] = [
  "developing",
  "repairing",
  "reviewing",
  "final_review",
  "needs_human",
];

/** No leased item, no running worker session, and the caller's guard has no objection. */
function siblingIdle(issueId: string, guard?: () => string | null): boolean {
  if (listWorkItemsForIssue(issueId).some((w) => w.status === "leased")) return false;
  if (getActiveWorkerSessionForIssue(issueId)) return false;
  return !guard?.();
}

/** Cancel the sibling's pending work and dismiss its open human gates. The dismissal
 * writes no `human_action.resolved` event, so it never resets the episode bound. */
function supersedeParkedStep(issueId: string, note: string): void {
  for (const w of listWorkItemsForIssue(issueId)) {
    if (w.status === "pending") cancelWorkItem(w.id);
  }
  for (const action of listHumanActionsForIssue(issueId)) {
    if (action.status === "open") resolveHumanAction(action.id, "system", { choice: "dismissed", note });
  }
}

function publishOnlyPayload(item: { payloadJson: string | null }): Record<string, unknown> | null {
  if (!item.payloadJson) return null;
  try {
    const payload = JSON.parse(item.payloadJson) as Record<string, unknown>;
    return payload.publishOnly === true ? payload : null;
  } catch {
    return null;
  }
}

/** Lease holder of a base-advanced push hold (never a dispatcher's owner). */
const BASE_SYNC_HOLDER = "base-advanced-sync";

/** A {@link reserveBaseSyncPush} hold: the leased item, its token, and whether it is
 * the sibling's own parked item (else a sentinel queued for the hold). */
export type BaseSyncReservation = { id: string; token: string; parked: boolean };

/**
 * NOT-356: hold an idle sibling for a `base_advanced` sync push. Runs right before
 * the push, in one transaction with the caller's idleness/ownership guard, and
 * leases the instance's one pending item to the sync — the parked item itself, or
 * a sentinel when the sibling is parked on a gate with no item. While it is held no
 * dispatcher can claim it and no other item can be queued for the instance
 * (`idx_work_items_one_active`), so no worker can start on the branch while the
 * push is in flight. Nothing else changes until the push lands
 * ({@link commitBaseSyncReservation}); if it does not,
 * {@link cancelBaseSyncReservation} returns the sibling to exactly how it was.
 *
 * A string is the refusal reason when the sibling is no longer idle or left its stage.
 */
export function reserveBaseSyncPush(input: {
  issueId: string;
  instanceId: string;
  branch: string;
  headSha: string | null;
  guard?: () => string | null;
}): BaseSyncReservation | string {
  return getDb().transaction((): BaseSyncReservation | string => {
    const refusal = input.guard?.() ?? null;
    if (refusal) return refusal;
    const current = getIssue(input.issueId);
    if (!current || !BASE_ADVANCED_STATUSES.includes(current.status)) return "issue left its open stage";
    const active = getActiveWorkflowInstance(input.issueId);
    if (!active || active.id !== input.instanceId) return "its workflow instance is no longer active";
    if (!siblingIdle(input.issueId)) return "issue is no longer idle";
    const lease = { leaseMs: 2 * mergeSyncConfig.syncGitTimeoutMs + 60_000 };
    const parked = listWorkItemsForIssue(input.issueId).find(
      (w) => w.status === "pending" && w.workflowInstanceId === active.id
    );
    const item =
      parked ??
      enqueueWorkItem({
        issueId: input.issueId,
        workflowInstanceId: active.id,
        kind: "developer",
        round: current.currentRound,
        // A valid CI wait in its own right, should crash recovery requeue the hold.
        payload: {
          publishOnly: true,
          branch: input.branch,
          profileSnapshot: queuedDeveloperProfileSnapshot(current),
          baseSyncHold: true,
        },
        idempotencyKey: uniqueKey(input.issueId, `${active.id}:developer:base-advanced-hold:${input.headSha ?? current.currentRound}`),
      });
    const token = reserveWorkItem(item.id, BASE_SYNC_HOLDER, lease);
    // Unreachable: the item is pending in this same transaction.
    if (!token) throw new Error(`could not hold work item ${item.id}`);
    return { id: item.id, token, parked: parked != null };
  })();
}

/** Nothing was pushed: hand the parked item back untouched, or drop the sentinel. */
export function cancelBaseSyncReservation(reservation: BaseSyncReservation): void {
  if (reservation.parked) releaseReservedWorkItem(reservation.id, reservation.token);
  else dropReservedWorkItem(reservation.id, reservation.token);
}

/**
 * NOT-356: the clean `base_advanced` sync pushed a new head onto the held sibling,
 * so whatever it was parked on (a reviewer pinned to the old head, a final_review
 * or needs_human gate, a deferred CI wait) is stale. Re-enter the normal checks
 * wait on the pushed head: supersede the parked step and queue a no-agent
 * publish-only developer item at the current round (no round spent) — it verifies
 * the PR, polls CI on the new head, and hands off to review exactly like a NOT-354
 * re-poll. A deferred CI wait's `checksWaitStartedAt` carries over so its ceiling
 * is never reset. A held agent developer round (a repair round not yet started) is
 * handed back instead: it starts from the synced origin tip and runs its own
 * checks wait.
 *
 * Null when the hold was revoked meanwhile (an abort cancelled the item) or the
 * issue left its stage — the hold is then given up and nothing else changes.
 */
export function commitBaseSyncReservation(
  reservation: BaseSyncReservation,
  input: { issueId: string; instanceId: string; baseBranch: string; branch: string; prNumber: number; headSha: string | null }
): { id: string; kept: boolean } | null {
  return getDb().transaction(() => {
    const held = listWorkItemsForIssue(input.issueId).find(
      (w) => w.id === reservation.id && w.status === "leased" && w.leaseToken === reservation.token
    );
    if (!held) return null;
    const current = getIssue(input.issueId);
    const active = getActiveWorkflowInstance(input.issueId);
    if (
      !current ||
      !BASE_ADVANCED_STATUSES.includes(current.status) ||
      active?.id !== input.instanceId ||
      getActiveWorkerSessionForIssue(input.issueId)
    ) {
      cancelBaseSyncReservation(reservation);
      return null;
    }
    if (reservation.parked && held.kind === "developer" && !publishOnlyPayload(held)) {
      releaseReservedWorkItem(reservation.id, reservation.token);
      return { id: held.id, kept: true };
    }
    const priorWait = reservation.parked ? publishOnlyPayload(held) : null;
    dropReservedWorkItem(reservation.id, reservation.token);

    const head = input.headSha ? input.headSha.slice(0, 12) : "the synced head";
    supersedeParkedStep(
      input.issueId,
      `superseded: Dealer synced ${input.baseBranch} into PR #${input.prNumber}; waiting for CI on ${head}`
    );
    const developerStage = current.status === "developing" || current.status === "repairing";
    transitionIssue(input.issueId, developerStage ? current.status : "repairing", {
      currentOwner: "developer",
      currentIntent: `Synced ${input.baseBranch} into PR #${input.prNumber}; waiting for CI on ${head} (no agent)`,
    });
    const item = enqueueWorkItem({
      issueId: input.issueId,
      workflowInstanceId: active.id,
      kind: "developer",
      round: current.currentRound,
      payload: {
        publishOnly: true,
        branch: input.branch,
        profileSnapshot: queuedDeveloperProfileSnapshot(current),
        ...(typeof priorWait?.checksWaitStartedAt === "string"
          ? { checksWaitStartedAt: priorWait.checksWaitStartedAt }
          : {}),
      },
      idempotencyKey: uniqueKey(
        input.issueId,
        `${active.id}:developer:base-advanced-sync:${input.headSha ?? current.currentRound}`
      ),
    });
    return { id: item.id, kept: false };
  })();
}

/** `keyBase`, suffixed until no work item of the issue uses it. */
function uniqueKey(issueId: string, keyBase: string): string {
  const taken = new Set(listWorkItemsForIssue(issueId).map((w) => w.idempotencyKey));
  let key = keyBase;
  for (let n = 2; taken.has(key); n++) key = `${keyBase}:${n}`;
  return key;
}

function tryRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

async function listUnmergedFiles(syncPath: string, timeoutMs: number): Promise<string[]> {
  const { stdout } = await gitExecImpl(["diff", "--name-only", "--diff-filter=U"], {
    cwd: syncPath,
    timeoutMs,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Undo a failed merge. The sync checkout was verified clean with HEAD at the
 * fetched origin tip before the merge, so it carries no unique commits and
 * resetting its uncommitted merge state cannot lose work.
 */
async function abortMergeState(syncPath: string, timeoutMs: number): Promise<void> {
  try {
    await gitExecImpl(["merge", "--abort"], { cwd: syncPath, timeoutMs });
    return;
  } catch {
    // No merge in progress (tool failure before git started merging), or an
    // abort that itself failed — fall through to the equivalent reset.
  }
  await gitExecImpl(["reset", "--hard", "HEAD"], { cwd: syncPath, timeoutMs });
}

/**
 * Whether `origin/<base>` advanced past the synced tip since the sync fetched
 * it. Only a descendant counts — a rewritten base (force-push) is a human
 * call, not new staleness a repair round should merge. A failed re-fetch
 * fails closed to "not advanced": the repair round is the expensive action,
 * so an unreadable base escalates instead of spending it.
 */
async function checkBaseAdvanced(
  repoPath: string,
  baseBranch: string,
  syncedSha: string,
  timeoutMs: number
): Promise<{ advanced: boolean; freshSha: string | null; fetchFailed: boolean }> {
  const fresh = await fetchFreshBase(repoPath, baseBranch, timeoutMs);
  if (!fresh.ok) return { advanced: false, freshSha: null, fetchFailed: true };
  if (fresh.sha === syncedSha) return { advanced: false, freshSha: fresh.sha, fetchFailed: false };
  const advanced = await isAncestor(repoPath, syncedSha, fresh.sha).catch(() => false);
  return { advanced, freshSha: fresh.sha, fetchFailed: false };
}

/** Origin's current tip of `branch` (`sha: null` when the branch is gone),
 * read straight from the remote so no local ref can mask a move. */
async function readRemoteTip(
  cwd: string,
  branch: string,
  timeoutMs: number
): Promise<{ ok: true; sha: string | null } | { ok: false; reason: string }> {
  try {
    const { stdout } = await gitExecImpl(["ls-remote", "origin", `refs/heads/${branch}`], { cwd, timeoutMs });
    const sha = stdout.trim().split(/\s+/)[0];
    return { ok: true, sha: sha ? sha : null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Marker the pinned pre-push hook prints when origin's tip is not the expected one. */
const PINNED_PUSH_REFUSAL = "dealer-sync: origin tip is not the synced tip";

/** Marker the pinned pre-push hook prints when the push's fence was revoked. */
const PINNED_PUSH_FENCED = "dealer-sync: the push was revoked (issue aborted)";

/** Fails the push unless every remote ref it updates is at the expected SHA,
 * then hands the same stdin and arguments to the repository's own pre-push
 * hook (if any), so a repository hook still vetoes the push. Last, as the
 * final step before git sends the update, an armed fence file
 * (`DEALER_SYNC_FENCE`) must still exist — {@link revokeBaseSyncPush} deletes it.
 * Git hands the hook the remote values from the same connection's ref
 * advertisement, and receive-pack only applies the update if the ref still
 * holds that value — so the check-and-update is atomic on origin without any
 * force flag. */
const PINNED_PRE_PUSH_HOOK = `#!/bin/sh
input=$(cat)
if [ -n "$input" ]; then
  printf '%s\\n' "$input" | while read local_ref local_sha remote_ref remote_sha; do
    [ -z "$local_ref" ] && continue
    if [ "$remote_sha" != "$DEALER_SYNC_EXPECTED_REMOTE_SHA" ]; then
      echo "${PINNED_PUSH_REFUSAL} ($remote_ref is at $remote_sha, expected $DEALER_SYNC_EXPECTED_REMOTE_SHA)" >&2
      exit 1
    fi
  done || exit 1
fi
if [ -n "$DEALER_SYNC_REPO_PRE_PUSH" ] && [ -f "$DEALER_SYNC_REPO_PRE_PUSH" ] && [ -x "$DEALER_SYNC_REPO_PRE_PUSH" ]; then
  if [ -n "$input" ]; then printf '%s\\n' "$input"; fi | "$DEALER_SYNC_REPO_PRE_PUSH" "$@"
  status=$?
  [ "$status" -ne 0 ] && exit "$status"
fi
if [ -n "$DEALER_SYNC_FENCE" ] && [ ! -f "$DEALER_SYNC_FENCE" ]; then
  echo "${PINNED_PUSH_FENCED}" >&2
  exit 1
fi
exit 0
`;

/**
 * NOT-356: env that installs {@link PINNED_PRE_PUSH_HOOK} for one push (via
 * `GIT_CONFIG_*`, appended after any inherited entries) and pins it to
 * `expectedSha`. The repository's own pre-push hook — resolved from `cwd`
 * before the override, honoring any `core.hooksPath` — is chained so it still
 * runs. Synchronous so no await sits between the caller's last check and the
 * push. Throws (fail closed) if the hook path cannot be resolved. The caller
 * removes `dir` once the push settles.
 */
function pinnedPushEnv(
  cwd: string,
  expectedSha: string,
  fenced = false
): { env: Record<string, string>; dir: string; fence: string | null } {
  const repoHook = path.resolve(
    cwd,
    execFileSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], { cwd, encoding: "utf8" }).trim()
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-sync-push-"));
  fs.writeFileSync(path.join(dir, "pre-push"), PINNED_PRE_PUSH_HOOK, { mode: 0o755 });
  const fence = fenced ? path.join(dir, "fence") : null;
  if (fence) fs.writeFileSync(fence, "");
  const inherited = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isFinite(inherited) && inherited > 0 ? inherited : 0;
  return {
    dir,
    fence,
    env: {
      ...(fence ? { DEALER_SYNC_FENCE: fence } : {}),
      GIT_CONFIG_COUNT: String(index + 1),
      [`GIT_CONFIG_KEY_${index}`]: "core.hooksPath",
      [`GIT_CONFIG_VALUE_${index}`]: dir,
      DEALER_SYNC_EXPECTED_REMOTE_SHA: expectedSha,
      DEALER_SYNC_REPO_PRE_PUSH: repoHook,
    },
  };
}

/** Fence files of the reserved pushes in flight, by issue. */
const pushFences = new Map<string, string>();

/**
 * NOT-356: revoke an in-flight reserved sync push for the issue (the abort path).
 * The pinned hook then refuses the push if git has not sent it yet; a push that
 * already landed is left to the reservation's own fencing (the aborted item is
 * cancelled, so nothing follows it).
 */
export function revokeBaseSyncPush(issueId: string): void {
  const fence = pushFences.get(issueId);
  if (fence) fs.rmSync(fence, { force: true });
}

/** Best-effort removal of our own sync checkout. `branchPushed: true` is
 * truthful on the abort path (the branch never moved off the fetched origin
 * tip) and safe on the failed-push path (the only unpushed state possible is
 * our own reproducible base merge, which the repair round re-does). */
async function cleanupSyncCheckout(repoPath: string, syncPath: string): Promise<void> {
  try {
    await safeRemoveWorktree({ repo: repoPath, path: syncPath, role: "developer", branchPushed: true });
  } catch {
    // Leave it: the next repair round's worktree resolution reuses or reports it.
  }
}

/**
 * Runs the NOT-310 self-resolution for one not-mergeable failure. See the
 * module doc for the bound, the safety invariant, and the fail-closed shape:
 * every refusal returns `skipped` so the caller escalates exactly as today.
 *
 * `entry` defaults to the merge path; `checks_wait` (NOT-354) and
 * `base_advanced` (NOT-356) need no `mergePr`, and their `mergeReason` is the
 * whole escalation lead-in (there is no "Auto-merge failed" to report).
 */
export async function runMergeConflictSync(opts: {
  issueId: string;
  instanceId: string;
  repo: string;
  branch: string;
  baseBranch: string;
  prNumber: number;
  mergeReason: string;
  mergePr?: MergePr;
  entry?: ConflictSyncEntry;
  /** NOT-356: the origin tip the caller validated; any other tip is not synced. */
  expectedHeadSha?: string;
  /**
   * NOT-356: called after the last await before the push, with the head about to
   * be pushed. A string refuses the push. Otherwise the returned reservation
   * holds the issue for the whole push (see {@link reserveBaseSyncPush}) and the
   * push is fenced against an abort ({@link revokeBaseSyncPush}); its `release`
   * runs once the push finished, told whether it landed.
   */
  reservePush?: (headSha: string | null) => string | { release: (pushed: boolean) => void };
}): Promise<ConflictSyncOutcome> {
  const entry: ConflictSyncEntry = opts.entry ?? "merge";
  // NOT-356: `base_advanced` takes the checks-wait shape (push-only, caller queues).
  const pushOnly = PUSH_ONLY_ENTRIES.has(entry);
  const auditInput = {
    issueId: opts.issueId,
    instanceId: opts.instanceId,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    entry,
  };
  const lead = pushOnly ? opts.mergeReason : `Auto-merge failed: ${opts.mergeReason}`;
  // A merge failure's escalation offers retry_merge; a pre-review conflict has
  // nothing to retry, so it keeps the default policy_escalation choices.
  const escalationEvidence: Record<string, unknown> = pushOnly
    ? entry === "base_advanced"
      ? { baseAdvanced: true }
      : { checksConflict: true }
    : { [MERGE_FAILURE_EVIDENCE_KEY]: true };
  const skip = (reason: string, code?: "tip_moved" | "refused"): ConflictSyncOutcome => {
    auditSync(auditInput, "skipped", { reason, ...(code ? { code } : {}) });
    return code ? { outcome: "skipped", reason, code } : { outcome: "skipped", reason };
  };
  const failed = (detail: string): ConflictSyncOutcome => {
    auditSync(auditInput, "failed", { detail });
    return {
      outcome: "escalate",
      reason: `${lead} (base sync ${opts.baseBranch}: ${detail})`,
      evidence: escalationEvidence,
    };
  };

  // The conflict-repair round already ran for this episode and the merge still
  // conflicts — escalate once with the file list, never sync again.
  const spent = conflictRepairSpent(opts.issueId, opts.instanceId);
  if (spent.spent) {
    auditSync(auditInput, "conflict_spent", { files: spent.files });
    const filesText =
      spent.files.length > 0
        ? `Conflicting files: ${formatFileList(spent.files)}.`
        : "The conflicting files are unknown — the retry failed without a local merge.";
    return {
      outcome: "escalate",
      reason:
        `${lead} ` +
        `Dealer already synced ${opts.baseBranch} and ran one conflict-repair round; ` +
        `the PR still conflicts. ${filesText}`,
      evidence: {
        ...escalationEvidence,
        [MERGE_CONFLICT_FILES_EVIDENCE_KEY]: spent.files,
      },
    };
  }

  // NOT-354: a checks-wait sync already pushed this episode and the PR conflicts
  // again (the base moved under it) — the one repair round re-syncs and resolves,
  // never a second automatic sync.
  if (pushOnly && checksWaitSyncSpent(opts.issueId, opts.instanceId)) {
    auditSync(auditInput, "repair_needed", { files: [], baseMovedAgain: true });
    return { outcome: "repair_needed", files: [] };
  }
  if (!pushOnly && !opts.mergePr) return skip("merge entry requires mergePr");

  if (!opts.branch.trim()) return skip("issue has no branch to sync");
  let repoPath: string;
  let syncPath: string;
  try {
    const resolution = classifyIssueRepo(opts.repo);
    repoPath = resolution.repoPath;
    syncPath = path.join(
      worktreesRootForResolution(resolution),
      `${SYNC_PATH_INFIX}${opts.issueId.slice(0, 8)}`
    );
  } catch (err) {
    return skip(`repo did not classify: ${err instanceof Error ? err.message : String(err)}`);
  }
  const timeoutMs = mergeSyncConfig.syncGitTimeoutMs;

  // An existing checkout holding the branch belongs to someone else — except
  // our own merge-sync leftover from a crashed run, which a dead owner + clean
  // tree lets us adopt instead of failing closed.
  let existing: string | null;
  try {
    existing = await findWorktreeForBranch(repoPath, opts.branch);
  } catch (err) {
    return skip(`could not list worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }
  let adopted = false;
  if (existing) {
    if (tryRealpath(existing) !== tryRealpath(syncPath)) {
      return skip(`branch already checked out at ${existing}`);
    }
    const liveness = checkDeveloperWorktreeOwnerLiveness(existing);
    if (liveness.state === "alive") {
      return skip(
        `sync checkout owned by a live session${liveness.sessionId ? ` (${liveness.sessionId})` : ""}`
      );
    }
    const clean = await isWorktreeClean(existing).catch(() => false);
    if (!clean) return skip("sync checkout is dirty");
    adopted = true;
  }

  // Start at exactly what Dealer pushed (NOT-219 reuse semantics): fetch
  // origin/<branch> and fast-forward the local ref — never merge onto a stale
  // or diverged local branch.
  const reused = await fetchReusedBranch(repoPath, opts.branch, timeoutMs);
  if (!reused.ok) return skip(`fetch origin/${opts.branch} failed: ${reused.reason}`);
  if (reused.remoteSha == null) return skip(`origin/${opts.branch} does not exist`);
  if (opts.expectedHeadSha && reused.remoteSha !== opts.expectedHeadSha) {
    return skip(
      `origin/${opts.branch} moved to ${reused.remoteSha} (expected ${opts.expectedHeadSha})`,
      "tip_moved"
    );
  }
  if (!adopted) {
    const ff = await fastForwardLocalBranchToSha({
      repo: repoPath,
      branch: opts.branch,
      sha: reused.remoteSha,
    });
    if (!ff) return skip(`local ${opts.branch} is ahead of or diverged from origin/${opts.branch}`);
  } else {
    // Never move a checked-out branch's ref — require the adopted checkout's
    // HEAD to already equal the fetched tip (a crashed run's partial merge
    // fails closed instead of being reinterpreted).
    const head = await revParseHead(existing!).catch(() => null);
    if (head !== reused.remoteSha) {
      return skip("adopted sync checkout is not at the fetched tip");
    }
  }
  const base = await fetchFreshBase(repoPath, opts.baseBranch, timeoutMs);
  if (!base.ok) return skip(`fetch origin/${opts.baseBranch} failed: ${base.reason}`);

  if (!adopted) {
    try {
      await withRepoLock(repoPath, async () => {
        // Our deterministic path with no registered checkout (crashed cleanup):
        // it can only hold a previous sync's reproducible state — clear it so
        // the add below cannot collide on the directory.
        if (fs.existsSync(syncPath)) fs.rmSync(syncPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(syncPath), { recursive: true });
        await pruneWorktrees(repoPath);
        await addWorktree({ repo: repoPath, path: syncPath, ref: opts.branch });
      });
    } catch (err) {
      return skip(`could not create sync checkout: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Merge the freshly fetched base. A nonzero exit with unmerged entries is a
  // textual conflict (repair round); a nonzero exit without them — or a
  // timeout kill — is a tool failure (escalate with the detail). HEAD around
  // the merge tells an "Already up to date" no-op from a real sync apart for
  // the retry-failure decision below.
  const headBeforeMerge = await revParseHead(syncPath).catch(() => null);
  let mergeError: SyncGitError | null = null;
  try {
    await gitExecImpl([...SYNC_GIT_IDENTITY_ARGS, "merge", "--no-edit", base.ref], {
      cwd: syncPath,
      timeoutMs,
    });
  } catch (err) {
    mergeError =
      err instanceof SyncGitError
        ? err
        : new SyncGitError(err instanceof Error ? err.message : String(err), {
            stdout: "",
            stderr: "",
            killed: false,
          });
  }
  if (mergeError) {
    const unmerged = await listUnmergedFiles(syncPath, timeoutMs).catch(() => null);
    await abortMergeState(syncPath, timeoutMs).catch(() => {});
    const clean = await isWorktreeClean(syncPath).catch(() => false);
    if (!clean) {
      // Unreachable in practice (the checkout was clean with no unique commits
      // before the merge), but a conflict-marked leftover must never block the
      // repair round's own worktree resolution — drop our checkout entirely.
      try {
        await withRepoLock(repoPath, async () => {
          await removeWorktree({ repo: repoPath, path: syncPath, force: true });
          await pruneWorktrees(repoPath);
        });
      } catch {
        // Leave it; the repair round reports it through the normal path.
      }
    } else {
      await cleanupSyncCheckout(repoPath, syncPath);
    }
    if (mergeError.killed) {
      return failed(`merge of origin/${opts.baseBranch} timed out after ${timeoutMs}ms`);
    }
    if (unmerged === null) {
      return failed(`merge failed and the conflict list was unreadable: ${mergeError.message}`);
    }
    if (unmerged.length === 0) {
      return failed(`merge failed: ${mergeError.message}`);
    }
    if (pushOnly) {
      const files = unmerged.slice(0, CONFLICTING_FILES_MAX);
      auditSync(auditInput, "repair_needed", { files: unmerged });
      return { outcome: "repair_needed", files };
    }
    const queued = queueConflictRepairRound({
      issueId: opts.issueId,
      instanceId: opts.instanceId,
      baseBranch: opts.baseBranch,
      branch: opts.branch,
      files: unmerged.slice(0, CONFLICTING_FILES_MAX),
    });
    if (!queued) return skip("issue left the merge park before the repair round queued");
    auditSync(auditInput, "repair_queued", { files: unmerged });
    return { outcome: "repair_queued", workItemId: queued.id, round: queued.round };
  }
  const headAfterMerge = await revParseHead(syncPath).catch(() => null);
  // Null when a rev-parse failed — unknown, never "unchanged". (A successful
  // merge + push means the branch contains the base either way; only the
  // already-up-to-date claim needs a verified-unchanged HEAD.)
  const mergeChangedHead =
    headBeforeMerge === null || headAfterMerge === null
      ? null
      : headBeforeMerge !== headAfterMerge;

  // NOT-356: re-pin origin's tip right before the push. The plain push rejects
  // divergent or forward movement on its own, but a hand reset to an ancestor
  // of the fetched tip would let our merge fast-forward over it and silently
  // undo the edit — any tip other than the one we merged onto is not ours.
  const tipNow = await readRemoteTip(syncPath, opts.branch, timeoutMs);
  if (!tipNow.ok || tipNow.sha !== reused.remoteSha) {
    await gitExecImpl(["reset", "--hard", reused.remoteSha], { cwd: syncPath, timeoutMs }).catch(() => {});
    await cleanupSyncCheckout(repoPath, syncPath);
    return !tipNow.ok
      ? skip(`could not re-read origin/${opts.branch} before the push: ${tipNow.reason}`)
      : skip(
          `origin/${opts.branch} moved to ${tipNow.sha ?? "(deleted)"} during the sync (fetched ${reused.remoteSha})`,
          "tip_moved"
        );
  }
  // NOT-356: the caller's ownership/idleness rule, checked and reserved at the
  // mutation boundary — after the last await, so nothing can close the issue or
  // start a worker between this check and the push starting, and the
  // reservation keeps it that way until the push is over.
  const reserved = opts.reservePush?.(headAfterMerge) ?? null;
  if (typeof reserved === "string") {
    const refusal = reserved;
    // Drop our unpushed base merge so the branch ref is back at the fetched tip.
    await gitExecImpl(["reset", "--hard", reused.remoteSha], { cwd: syncPath, timeoutMs }).catch(() => {});
    await cleanupSyncCheckout(repoPath, syncPath);
    return skip(refusal, "refused");
  }

  // Plain push, never force — the refspec mirrors pushBranch exactly. The
  // pinned pre-push hook closes the window between the tip read above and the
  // push: origin must still be at the fetched tip inside the push itself.
  let pinned: ReturnType<typeof pinnedPushEnv>;
  try {
    pinned = pinnedPushEnv(syncPath, reused.remoteSha, reserved != null);
  } catch (err) {
    reserved?.release(false);
    await gitExecImpl(["reset", "--hard", reused.remoteSha], { cwd: syncPath, timeoutMs }).catch(() => {});
    await cleanupSyncCheckout(repoPath, syncPath);
    const detail = err instanceof Error ? err.message : String(err);
    return skip(`could not prepare the pinned push: ${detail}`);
  }
  if (pinned.fence) pushFences.set(opts.issueId, pinned.fence);
  let pushed = false;
  try {
    await gitExecImpl(["push", "-u", "origin", `HEAD:refs/heads/${opts.branch}`], {
      cwd: syncPath,
      timeoutMs,
      env: pinned.env,
    });
    pushed = true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stderr = err instanceof SyncGitError ? err.stderr : "";
    if (`${detail}\n${stderr}`.includes(PINNED_PUSH_FENCED)) {
      await gitExecImpl(["reset", "--hard", reused.remoteSha], { cwd: syncPath, timeoutMs }).catch(() => {});
      await cleanupSyncCheckout(repoPath, syncPath);
      return skip(`the push was revoked as it started; nothing was pushed`, "refused");
    }
    if (`${detail}\n${stderr}`.includes(PINNED_PUSH_REFUSAL)) {
      await gitExecImpl(["reset", "--hard", reused.remoteSha], { cwd: syncPath, timeoutMs }).catch(() => {});
      await cleanupSyncCheckout(repoPath, syncPath);
      return skip(
        `origin/${opts.branch} moved off ${reused.remoteSha} as the push started; nothing was pushed`,
        "tip_moved"
      );
    }
    await cleanupSyncCheckout(repoPath, syncPath);
    return failed(`could not push the synced branch: ${detail}`);
  } finally {
    if (pinned.fence && pushFences.get(opts.issueId) === pinned.fence) pushFences.delete(opts.issueId);
    fs.rmSync(pinned.dir, { recursive: true, force: true });
    reserved?.release(pushed);
  }

  // NOT-354: the push-only entries stop at the push — the deferred CI wait
  // re-polls the pushed head through the normal publish-only path.
  if (pushOnly) {
    await cleanupSyncCheckout(repoPath, syncPath);
    auditSync(auditInput, "synced", { baseSha: base.sha, headSha: headAfterMerge, mergeChangedHead });
    return { outcome: "synced", headSha: headAfterMerge };
  }

  // Wait for checks on the new head exactly as the developer effect does, then
  // retry the merge once. A failed/timed-out poll escalates directly — retrying
  // the merge against red or unknown checks cannot succeed.
  let checks: PollChecksResult;
  try {
    checks = await pollPrChecks(githubImpl, {
      cwd: syncPath,
      number: opts.prNumber,
      timeoutMs: mergeSyncConfig.checksPollTimeoutMs,
      intervalMs: mergeSyncConfig.checksPollIntervalMs,
    });
  } catch (err) {
    await cleanupSyncCheckout(repoPath, syncPath);
    const detail = err instanceof Error ? err.message : String(err);
    return failed(`checks poll errored: ${detail}`);
  }
  if (checks === "failure") {
    await cleanupSyncCheckout(repoPath, syncPath);
    return failed(
      `synced ${opts.baseBranch} ${base.sha.slice(0, 12)} but PR checks failed on the merged head`
    );
  }
  if (checks === "timeout") {
    await cleanupSyncCheckout(repoPath, syncPath);
    return failed(
      `synced ${opts.baseBranch} ${base.sha.slice(0, 12)} but timed out waiting for PR checks on the merged head`
    );
  }
  await cleanupSyncCheckout(repoPath, syncPath);

  const retry = await opts.mergePr!({ cwd: repoPath, number: opts.prNumber });
  if (retry.ok) {
    auditSync(auditInput, "merged", { baseSha: base.sha });
    return retry.alreadyMerged ? { outcome: "merged", alreadyMerged: true } : { outcome: "merged" };
  }
  if (isMergeConflictFailure(retry.reason)) {
    // The retry failed the same way. Only a base that actually advanced past
    // the synced tip is new staleness worth a repair round — anything else (a
    // policy block, a dismissed approval, GitHub's stale mergeability cache)
    // is not something a merge-resolve round can fix, so escalate directly
    // with the retry's reason instead of spending a round on a false
    // "base moved". This also covers the "Already up to date" no-op merge:
    // the branch already contains the base, so there is nothing to resolve.
    const advance = await checkBaseAdvanced(repoPath, opts.baseBranch, base.sha, timeoutMs);
    if (!advance.advanced) {
      const short = (sha: string) => sha.slice(0, 12);
      const note = advance.fetchFailed
        ? `could not re-check ${opts.baseBranch} after the retry, so no repair round was queued`
        : advance.freshSha === base.sha
          ? mergeChangedHead === false
            ? `branch already contains ${opts.baseBranch} ${short(base.sha)} — not a staleness conflict`
            : `branch now contains ${opts.baseBranch} ${short(base.sha)} — not a staleness conflict`
          : `${opts.baseBranch} was rewritten since the sync (${short(base.sha)} → ${short(advance.freshSha!)}); needs a human look`;
      auditSync(auditInput, "failed", {
        detail: retry.reason,
        mergeChangedHead,
        baseSha: base.sha,
        freshBaseSha: advance.freshSha,
      });
      return {
        outcome: "escalate",
        reason: `Auto-merge failed: ${retry.reason} (${note})`,
        evidence: { [MERGE_FAILURE_EVIDENCE_KEY]: true },
      };
    }
    // The base moved again under us — the one repair round re-syncs + resolves.
    const queued = queueConflictRepairRound({
      issueId: opts.issueId,
      instanceId: opts.instanceId,
      baseBranch: opts.baseBranch,
      branch: opts.branch,
      files: [],
    });
    if (!queued) return skip("issue left the merge park before the repair round queued");
    auditSync(auditInput, "repair_queued", { files: [], baseMovedAgain: true });
    return { outcome: "repair_queued", workItemId: queued.id, round: queued.round };
  }
  auditSync(auditInput, "failed", { detail: retry.reason });
  return {
    outcome: "escalate",
    reason:
      `Auto-merge failed: ${retry.reason} ` +
      `(after syncing ${opts.baseBranch} ${base.sha.slice(0, 12)})`,
    evidence: { [MERGE_FAILURE_EVIDENCE_KEY]: true },
  };
}

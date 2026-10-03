// packages/server/src/coordinator/base-advanced-scan.ts
//
// NOT-356: when Dealer itself merges a PR, the base branch just moved. Right after
// the merge, probe every other open Dealer PR on the same repo + base for a new
// conflict and resolve the idle ones, instead of discovering the conflict later
// (at their own merge, or never).
//
// Per sibling, in order — each step records one `base.advanced` event naming the
// action and stops:
//   - a running worker session, a leased work item, or its own auto-merge in
//     flight in this process: `active_worker` — its own pre-publish probe
//     (NOT-355), CI-wait check (NOT-354) or merge path (NOT-310) picks the base up.
//     Workflow ownership alone never skips a sibling: an idle PR parked on a
//     needs_human or final_review gate is probed like any other.
//   - origin's tip is not the SHA Dealer last pushed: `hand_edited` — never touched.
//   - the NOT-355 local probe (`git merge-tree --write-tree`, never GitHub's lazily
//     computed mergeable state) against the new base tip: `clean` does nothing more.
//   - `conflict`: the NOT-310/354 push-only sync (`base_advanced` entry, plain
//     push, never force or rebase), conditional on origin still being the probed
//     tip and the sibling still idle right before the push. A clean sync is
//     `synced` and re-enters the normal checks wait on the pushed head (the parked
//     step is superseded by a no-agent publish-only CI wait); a textual conflict
//     queues one conflict-repair round naming the files (`repair_queued`).
//
// Bounds: one sync and one repair round per issue per episode, shared with the
// merge and checks-wait entries. A failure for one sibling — a throw included —
// is recorded and never reaches the merge that triggered the scan, nor the other
// siblings. The scan runs after the merge's success transaction and is not awaited
// by it; scans for one repo + base are serialized so two quick merges cannot sync
// the same sibling twice.
import type { Issue, IssueStatus } from "@agent-dealer/shared";
import {
  DEFAULT_BASE_FETCH_TIMEOUT_MS,
  fetchFreshBase,
  fetchReusedBranch,
  probeBaseConflict,
  type BaseConflictProbe,
} from "../adapters/git-worktree.js";
import { classifyIssueRepo } from "../adapters/managed-repo.js";
import { getDb } from "../db/index.js";
import { getIssue, listIssues } from "../repository/issues.js";
import { getActiveWorkerSessionForIssue } from "../repository/worker-sessions.js";
import { listWorkItemsForIssue } from "../repository/work-items.js";
import { appendWorkflowEvent, getActiveWorkflowInstance } from "../repository/workflow-events.js";
import { isAutoMergeInFlight } from "./auto-merge.js";
import {
  BASE_ADVANCED_STATUSES,
  checksWaitSyncSpent,
  conflictRepairSpent,
  queueChecksWaitAfterBaseSync,
  queueConflictRepairRound,
  runMergeConflictSync,
} from "./merge-conflict-sync.js";

/** Open stages in which an issue can hold a PR Dealer opened. */
const SIBLING_STATUSES: IssueStatus[] = BASE_ADVANCED_STATUSES;

export type BaseAdvancedAction =
  | "clean"
  | "synced"
  | "repair_queued"
  | "active_worker"
  | "hand_edited"
  | "repair_spent"
  | "skipped"
  | "failed";

export type BaseAdvancedProbe = typeof probeBaseConflict;

let probeImpl: BaseAdvancedProbe = probeBaseConflict;

/** Test hook — fake or wrap the per-sibling conflict probe. */
export function setBaseAdvancedProbeForTests(probe: BaseAdvancedProbe | null): void {
  probeImpl = probe ?? probeBaseConflict;
}

/** Tail of the serialized scan chain per repo + base. */
const scanChains = new Map<string, Promise<void>>();

/**
 * Start the sibling scan for a PR Dealer just merged. Never throws and never
 * delays the caller: the work is chained behind any earlier scan for the same
 * repo + base and runs in the background.
 */
export function startBaseAdvancedScan(merged: Issue): void {
  const key = `${merged.repo}\u0000${merged.baseBranch}`;
  const prev = scanChains.get(key) ?? Promise.resolve();
  const next = prev
    .then(() => scanSiblingsAfterMerge(merged))
    .then(
      () => undefined,
      (err) => {
        console.error("[coordinator] base-advanced scan", merged.id, err);
      }
    );
  scanChains.set(key, next);
  void next.finally(() => {
    if (scanChains.get(key) === next) scanChains.delete(key);
  });
}

/** Test hook — resolve once every started scan has finished. */
export async function settleBaseAdvancedScansForTests(): Promise<void> {
  while (scanChains.size > 0) {
    await Promise.all([...scanChains.values()]);
  }
}

export type SiblingScanResult = { issueId: string; action: BaseAdvancedAction };

/**
 * Probe and (when idle and conflicting) resolve every other open Dealer PR on the
 * merged issue's repo + base. Exported for direct tests; production goes through
 * {@link startBaseAdvancedScan}.
 */
export async function scanSiblingsAfterMerge(merged: Issue): Promise<SiblingScanResult[]> {
  const siblings = listIssues(SIBLING_STATUSES).filter(
    (i) =>
      i.id !== merged.id &&
      i.repo === merged.repo &&
      i.baseBranch === merged.baseBranch &&
      i.prNumber != null &&
      Boolean(i.branch)
  );
  if (siblings.length === 0) return [];

  const context = { mergedIssueId: merged.id, mergedPrNumber: merged.prNumber, baseBranch: merged.baseBranch };
  let repoPath: string | null = null;
  let base: { sha: string; ref: string } | null = null;
  let setupFailure: string | null = null;
  try {
    repoPath = classifyIssueRepo(merged.repo).repoPath;
    const fresh = await fetchFreshBase(repoPath, merged.baseBranch, DEFAULT_BASE_FETCH_TIMEOUT_MS);
    if (fresh.ok) base = { sha: fresh.sha, ref: fresh.ref };
    else setupFailure = `fetch origin/${merged.baseBranch} failed: ${fresh.reason}`;
  } catch (err) {
    setupFailure = err instanceof Error ? err.message : String(err);
  }

  const results: SiblingScanResult[] = [];
  for (const sibling of siblings) {
    const record = (action: BaseAdvancedAction, detail?: Record<string, unknown>) => {
      recordBaseAdvanced(sibling.id, { ...context, baseSha: base?.sha ?? null, action, ...(detail ?? {}) });
      results.push({ issueId: sibling.id, action });
    };
    try {
      if (setupFailure || !repoPath || !base) {
        record("skipped", { reason: setupFailure ?? "base did not resolve" });
        continue;
      }
      const { action, detail } = await scanSibling(sibling, repoPath, base);
      record(action, detail);
    } catch (err) {
      record("failed", { reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function scanSibling(
  sibling: Issue,
  repoPath: string,
  base: { sha: string; ref: string }
): Promise<{ action: BaseAdvancedAction; detail?: Record<string, unknown> }> {
  const issue = getIssue(sibling.id);
  const instance = getActiveWorkflowInstance(sibling.id);
  if (!issue || !instance || !SIBLING_STATUSES.includes(issue.status)) {
    return { action: "skipped", detail: { reason: "issue is no longer open" } };
  }
  const branch = issue.branch!;
  const prNumber = issue.prNumber!;
  const busy = activeReason(issue.id);
  if (busy) return { action: "active_worker", detail: { reason: busy } };

  // Start from exactly what Dealer last pushed; anything else is a hand edit.
  const reused = await fetchReusedBranch(repoPath, branch, DEFAULT_BASE_FETCH_TIMEOUT_MS);
  if (!reused.ok) return { action: "skipped", detail: { reason: `fetch origin/${branch} failed: ${reused.reason}` } };
  if (reused.remoteSha == null) return { action: "skipped", detail: { reason: `origin/${branch} does not exist` } };
  const lastPushed = lastDealerPushedSha(issue);
  if (reused.remoteSha !== lastPushed) {
    return { action: "hand_edited", detail: { remoteSha: reused.remoteSha, lastPushedSha: lastPushed } };
  }
  const expectedHeadSha = reused.remoteSha;

  const probe: BaseConflictProbe = await probeImpl({
    worktreePath: repoPath,
    baseRef: base.ref,
    headRef: expectedHeadSha,
  });
  if (probe.state === "clean") return { action: "clean", detail: { probe: "clean", headSha: expectedHeadSha } };
  if (probe.state !== "conflict") {
    return { action: "skipped", detail: { probe: probe.state, reason: probe.reason } };
  }
  const probeDetail = { probe: "conflict", files: probe.files, headSha: expectedHeadSha };

  if (conflictRepairSpent(issue.id, instance.id).spent) {
    return { action: "repair_spent", detail: probeDetail };
  }

  // Every mutation re-checks idleness: a worker may have started since the check above.
  const guard = () => activeReason(issue.id);

  // One push-only sync per episode: a spent sync goes straight to the repair round.
  let files = probe.files;
  if (!checksWaitSyncSpent(issue.id, instance.id)) {
    const sync = await runMergeConflictSync({
      issueId: issue.id,
      instanceId: instance.id,
      repo: issue.repo,
      branch,
      baseBranch: issue.baseBranch,
      prNumber,
      mergeReason: `${issue.baseBranch} advanced and PR #${prNumber} now conflicts with it.`,
      entry: "base_advanced",
      expectedHeadSha,
      beforePush: guard,
    });
    if (sync.outcome === "synced") {
      const wait = queueChecksWaitAfterBaseSync({
        issueId: issue.id,
        instanceId: instance.id,
        baseBranch: issue.baseBranch,
        branch,
        prNumber,
        headSha: sync.headSha,
        guard,
      });
      return {
        action: "synced",
        detail: {
          ...probeDetail,
          syncedHeadSha: sync.headSha,
          ...(wait
            ? { workItemId: wait.id, ...(wait.kept ? { checksWait: "queued developer round" } : {}) }
            : { reason: "issue became busy or left its stage before the checks wait queued" }),
        },
      };
    }
    if (sync.outcome === "skipped" && sync.code === "tip_moved") {
      return { action: "hand_edited", detail: { ...probeDetail, reason: sync.reason } };
    }
    if (sync.outcome === "skipped" && sync.code === "refused") {
      return { action: "active_worker", detail: { ...probeDetail, reason: sync.reason } };
    }
    if (sync.outcome === "escalate" || sync.outcome === "skipped") {
      return { action: sync.outcome === "escalate" ? "failed" : "skipped", detail: { ...probeDetail, reason: sync.reason } };
    }
    if (sync.outcome !== "repair_needed") {
      return { action: "skipped", detail: { ...probeDetail, reason: `unexpected sync outcome ${sync.outcome}` } };
    }
    if (sync.files.length > 0) files = sync.files;
  }

  const queued = queueConflictRepairRound({
    issueId: issue.id,
    instanceId: instance.id,
    baseBranch: issue.baseBranch,
    branch,
    files,
    entry: "base_advanced",
    guard,
  });
  if (!queued) {
    return { action: "skipped", detail: { ...probeDetail, reason: "issue became busy or left its stage before the repair round queued" } };
  }
  return { action: "repair_queued", detail: { ...probeDetail, files, workItemId: queued.id, round: queued.round } };
}

/** Why the sibling is not idle: a running worker session, a leased work item (an
 * effect mid-flight), or its own auto-merge running in this process. */
function activeReason(issueId: string): string | null {
  if (getActiveWorkerSessionForIssue(issueId)) return "a worker session is running";
  if (listWorkItemsForIssue(issueId).some((w) => w.status === "leased")) return "a work item is leased";
  if (isAutoMergeInFlight(issueId)) return "its auto-merge is in flight";
  return null;
}

/** Events that record a head Dealer itself put on origin, and where they carry it. */
const PUSH_EVENT_TYPES = ["checkpoint.observed", "pull_request.opened", "branch.pushed", "auto_merge.conflict_sync"];

/**
 * The single SHA Dealer last pushed to the issue branch: the latest of a developer
 * push checkpoint, a verified handoff, a lease push, or a push-only base sync (in
 * event order). Falls back to the handoff head when no event names one. An older
 * Dealer head is not accepted — a reset back to it is a hand edit too.
 */
function lastDealerPushedSha(issue: Issue): string | null {
  const rows = getDb()
    .prepare(
      `SELECT type, payload_json AS payloadJson FROM workflow_events
       WHERE issue_id = ? AND type IN (${PUSH_EVENT_TYPES.map(() => "?").join(", ")})
       ORDER BY ts ASC, rowid ASC`
    )
    .all(issue.id, ...PUSH_EVENT_TYPES) as Array<{ type: string; payloadJson: string | null }>;
  let last: string | null = null;
  for (const row of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(row.payloadJson ?? "{}") as Record<string, unknown>;
    } catch {
      continue; // unreadable audit payload names no head
    }
    let sha: unknown = null;
    if (row.type === "checkpoint.observed") sha = p.kind === "branch_pushed" ? p.observedSha : null;
    else if (row.type === "pull_request.opened") sha = p.headSha;
    else if (row.type === "branch.pushed") sha = p.newSha ?? p.localSha;
    else if (p.outcome === "synced") sha = p.headSha;
    if (typeof sha === "string" && sha) last = sha;
  }
  return last ?? issue.headSha ?? null;
}

function recordBaseAdvanced(issueId: string, payload: Record<string, unknown>): void {
  try {
    getDb().transaction(() => {
      const issue = getIssue(issueId);
      if (!issue) return;
      const instance = getActiveWorkflowInstance(issueId);
      appendWorkflowEvent({
        issueId,
        workflowInstanceId: instance?.id ?? null,
        workerSessionId: null,
        type: "base.advanced",
        actorType: "system",
        stage: issue.status,
        round: issue.currentRound,
        payload,
      });
    })();
  } catch (err) {
    // Audit only — never fail the scan for a sibling.
    console.error("[coordinator] base.advanced event", issueId, err);
  }
}

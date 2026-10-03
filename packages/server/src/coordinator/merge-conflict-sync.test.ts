// NOT-310: conflict-failure classifier + the conflict-repair episode bound.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310-"));
process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH = "1";
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue } = await import("../repository/issues.js");
const { startWorkflow } = await import("./commands.js");
const { appendWorkflowEvent, getActiveWorkflowInstance } = await import(
  "../repository/workflow-events.js"
);
const { conflictRepairSpent, isMergeConflictFailure } = await import("./merge-conflict-sync.js");

before(() => {
  migrate();
});
beforeEach(() => {
  getDb().exec(`
    DELETE FROM work_items;
    DELETE FROM human_actions;
    DELETE FROM workflow_events;
    DELETE FROM findings;
    DELETE FROM review_publications;
    DELETE FROM worker_sessions;
    DELETE FROM artifacts;
    DELETE FROM usage_events;
    DELETE FROM workflow_instances;
    DELETE FROM issues;
  `);
});

test("isMergeConflictFailure classifies gh conflict text, not infra failures", () => {
  assert.equal(
    isMergeConflictFailure(
      "Pull request #42 is not mergeable: the merge commit cannot be cleanly created"
    ),
    true
  );
  assert.equal(isMergeConflictFailure("merge conflict: CONFLICTING"), true);
  assert.equal(isMergeConflictFailure("CONFLICTING"), true);
  // Deliberately broad: a policy "not mergeable" still enters the sync, which
  // then escalates directly once the branch proves up to date (integration:
  // "up-to-date branch that stays not mergeable").
  assert.equal(
    isMergeConflictFailure("Pull request #42 is not mergeable: base branch policy prohibits the merge"),
    true
  );
  assert.equal(isMergeConflictFailure("required status checks failed"), false);
  assert.equal(isMergeConflictFailure("gh timed out after 20000ms"), false);
  assert.equal(isMergeConflictFailure("protected branch"), false);
  assert.equal(isMergeConflictFailure("Managed clone missing for github.com/a/b (/x)"), false);
  assert.equal(
    isMergeConflictFailure("gh not on PATH — install GitHub CLI (`gh`) and ensure the daemon can see it"),
    false
  );
  assert.equal(
    isMergeConflictFailure("invalid merge cwd (/x) — path does not exist (portable issue.repo must not be used as cwd)"),
    false
  );
});

function newIssueWithWorkflow(): { issueId: string; instanceId: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310bound-repo-"));
  const issueId = createIssue({
    title: "Bound me",
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: true,
  }).id;
  startWorkflow(issueId);
  return { issueId, instanceId: getActiveWorkflowInstance(issueId)!.id };
}

function emitRepairQueued(issueId: string, instanceId: string, files: unknown): void {
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: null,
    type: "auto_merge.conflict_repair_queued",
    actorType: "system",
    stage: "repairing",
    round: 2,
    payload: { baseBranch: "main", branch: "issue-1", files, round: 2, workItemId: "w" },
  });
}

function emitResolved(issueId: string, instanceId: string): void {
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: instanceId,
    workerSessionId: null,
    type: "human_action.resolved",
    actorType: "human",
    stage: "needs_human",
    round: 2,
    payload: { actionType: "policy_escalation", choice: "retry_merge" },
  });
}

test("conflictRepairSpent is false with no repair event", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
});

test("conflictRepairSpent is true after a repair round queued, carrying its files", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitRepairQueued(issueId, instanceId, ["shared.txt"]);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: true, files: ["shared.txt"] });
});

test("conflictRepairSpent resets on a later human resolution (fresh episode)", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitRepairQueued(issueId, instanceId, ["shared.txt"]);
  emitResolved(issueId, instanceId);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
});

test("conflictRepairSpent stays spent when the repair queued after the last resolution", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  emitResolved(issueId, instanceId);
  emitRepairQueued(issueId, instanceId, []);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: true, files: [] });
});

test("conflictRepairSpent ignores other issues/instances and malformed file lists", () => {
  const { issueId, instanceId } = newIssueWithWorkflow();
  const other = newIssueWithWorkflow();
  emitRepairQueued(other.issueId, other.instanceId, ["other.txt"]);
  assert.deepEqual(conflictRepairSpent(issueId, instanceId), { spent: false, files: [] });
  assert.deepEqual(conflictRepairSpent(issueId, other.instanceId), { spent: false, files: [] });
  emitRepairQueued(issueId, instanceId, "not-a-list");
  const spent = conflictRepairSpent(issueId, instanceId);
  assert.equal(spent.spent, true);
  assert.deepEqual(spent.files, []);
});

// ---------------------------------------------------------------------------
// NOT-354: the checks-wait entry — a developer PR that conflicts while Dealer
// waits for CI. Real git (origin + managed clone); the sync's git shell-out is
// recorded so the safety rules are asserted on the exact commands issued.

const { execFileSync } = await import("node:child_process");
const {
  checksWaitSyncSpent,
  defaultSyncGitExec,
  queueConflictRepairRound,
  runMergeConflictSync,
  setConflictSyncGitExecForTests,
} = await import("./merge-conflict-sync.js");
const { claimWorkItem, getWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { getIssue } = await import("../repository/issues.js");

/** origin + clone where `issue-1` is pushed, then origin/main moves. `conflict`
 * makes the base edit the same line of shared.txt the branch edited. */
function initChecksWaitRepos(conflict: boolean): { origin: string; local: string; baseMovedSha: string } {
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not354-origin-"));
  g(origin, "init", "-q", "-b", "main");
  g(origin, "config", "user.email", "test@example.com");
  g(origin, "config", "user.name", "Test");
  fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nline2\n");
  g(origin, "add", ".");
  g(origin, "commit", "-q", "-m", "A base");

  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not354-local-"));
  fs.rmSync(local, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, local]);
  g(local, "config", "user.email", "test@example.com");
  g(local, "config", "user.name", "Test");
  g(local, "checkout", "-q", "-b", "issue-1");
  fs.writeFileSync(path.join(local, "shared.txt"), "line1\nfeature change\n");
  g(local, "add", ".");
  g(local, "commit", "-q", "-m", "B feature");
  g(local, "push", "-q", "-u", "origin", "issue-1");
  g(local, "checkout", "-q", "main");

  if (conflict) fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nbase change\n");
  else fs.writeFileSync(path.join(origin, "other.txt"), "c\n");
  g(origin, "add", ".");
  g(origin, "commit", "-q", "-m", "C base moved (sibling PR merged)");
  return { origin, local, baseMovedSha: g(origin, "rev-parse", "HEAD") };
}

function developingIssueIn(repo: string): { issueId: string; instanceId: string } {
  const issueId = createIssue({
    title: "Conflicting PR",
    description: "d",
    acceptanceCriteria: "It works",
    repo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
  startWorkflow(issueId);
  return { issueId, instanceId: getActiveWorkflowInstance(issueId)!.id };
}

function recordGit(): string[][] {
  const calls: string[][] = [];
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    return defaultSyncGitExec(args, opts);
  });
  return calls;
}

function assertSafeGit(calls: string[][]): void {
  for (const args of calls) {
    assert.ok(!args.includes("rebase"), `never rebase: git ${args.join(" ")}`);
    if (args[0] === "push") {
      assert.ok(
        args.every((a) => !/^(-f|--force)/.test(a) && !a.startsWith("+")),
        `push must never force: git ${args.join(" ")}`
      );
    }
  }
}

function contains(repo: string, sha: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

const CHECKS_WAIT_REASON = "PR #7 conflicts with main (mergeable: CONFLICTING), so its CI cannot start.";

test("NOT-354: checks_wait clean sync merges the base and plain-pushes, then never syncs twice in the episode", async () => {
  const { origin, local, baseMovedSha } = initChecksWaitRepos(false);
  const { issueId, instanceId } = developingIssueIn(local);
  const calls = recordGit();
  try {
    const sync = {
      issueId,
      instanceId,
      repo: local,
      branch: "issue-1",
      baseBranch: "main",
      prNumber: 7,
      mergeReason: CHECKS_WAIT_REASON,
      entry: "checks_wait" as const,
    };
    const first = await runMergeConflictSync(sync);
    assert.equal(first.outcome, "synced");
    const originTip = execFileSync("git", ["rev-parse", "issue-1"], { cwd: origin, encoding: "utf8" }).trim();
    assert.equal(first.outcome === "synced" ? first.headSha : null, originTip, "reports the pushed head");
    assert.equal(contains(origin, baseMovedSha, "issue-1"), true, "origin's branch now contains the moved base");
    assert.equal(calls.filter((a) => a.includes("merge") && a.includes("origin/main")).length, 1);
    assert.deepEqual(
      calls.filter((a) => a[0] === "push"),
      [["push", "-u", "origin", "HEAD:refs/heads/issue-1"]]
    );
    assertSafeGit(calls);
    assert.equal(checksWaitSyncSpent(issueId, instanceId), true);
    const root = path.join(local, ".agent-dealer-worktrees");
    const leftovers = fs.existsSync(root) ? fs.readdirSync(root).filter((e) => e.startsWith("merge-sync-")) : [];
    assert.deepEqual(leftovers, []);

    // The base moved again and the PR conflicts again: the episode's one sync is
    // spent, so the repair round is due — and no git command runs.
    const before = calls.length;
    const second = await runMergeConflictSync(sync);
    assert.deepEqual(second, { outcome: "repair_needed", files: [] });
    assert.equal(calls.length, before, "no second sync");
    assert.equal(getIssue(issueId)!.status, "developing", "the sync itself never moves the issue");
  } finally {
    setConflictSyncGitExecForTests(null);
  }
});

test("NOT-354: checks_wait textual conflict aborts without pushing, one repair round queues on the leased item, then escalates once with the files", async () => {
  const { local, baseMovedSha } = initChecksWaitRepos(true);
  const { issueId, instanceId } = developingIssueIn(local);
  const calls = recordGit();
  try {
    const sync = {
      issueId,
      instanceId,
      repo: local,
      branch: "issue-1",
      baseBranch: "main",
      prNumber: 7,
      mergeReason: CHECKS_WAIT_REASON,
      entry: "checks_wait" as const,
    };
    const first = await runMergeConflictSync(sync);
    assert.deepEqual(first, { outcome: "repair_needed", files: ["shared.txt"] });
    assert.equal(calls.filter((a) => a[0] === "push").length, 0, "a conflicted merge is never pushed");
    assert.equal(contains(local, baseMovedSha, "issue-1"), false, "the merge was aborted");
    assertSafeGit(calls);

    // The developer item the CI wait ran in is still leased; the repair round
    // queues while CAS-finishing it.
    const leased = claimWorkItem("not354-test", { leaseMs: 60_000 })!;
    assert.equal(leased.issueId, issueId);
    assert.equal(
      queueConflictRepairRound({
        issueId,
        instanceId,
        baseBranch: "main",
        branch: "issue-1",
        files: ["shared.txt"],
        entry: "checks_wait",
        finish: { workItemId: leased.id, leaseToken: "stale-token", result: {} },
      }),
      null,
      "a lost lease queues nothing"
    );
    const queued = queueConflictRepairRound({
      issueId,
      instanceId,
      baseBranch: "main",
      branch: "issue-1",
      files: ["shared.txt"],
      entry: "checks_wait",
      finish: { workItemId: leased.id, leaseToken: leased.leaseToken!, result: {} },
    });
    assert.ok(queued);
    assert.equal(getWorkItem(leased.id)!.status, "done");
    const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, queued!.id);
    assert.deepEqual(JSON.parse(pending[0]!.payloadJson!).conflictRepair, {
      baseBranch: "main",
      branch: "issue-1",
      files: ["shared.txt"],
    });
    assert.equal(getIssue(issueId)!.status, "developing", "developing has no repairing edge — the stage is kept");
    assert.equal(getIssue(issueId)!.currentRound, 2);

    // The repair round's CI wait still sees a conflicting PR: escalate with the
    // file list, no second sync.
    const before = calls.length;
    const again = await runMergeConflictSync(sync);
    assert.equal(again.outcome, "escalate");
    if (again.outcome === "escalate") {
      assert.match(again.reason, /^PR #7 conflicts with main/);
      assert.match(again.reason, /shared\.txt/);
      assert.deepEqual(again.evidence.conflictingFiles, ["shared.txt"]);
      assert.equal(again.evidence.mergeFailure, undefined);
    }
    assert.equal(calls.length, before, "no git command once the episode is spent");
  } finally {
    setConflictSyncGitExecForTests(null);
  }
});

// ---------------------------------------------------------------------------
// NOT-356: the `base_advanced` entry — no merge failure triggered it; Dealer just
// merged a sibling PR and the probe says this idle PR now conflicts.

const BASE_ADVANCED_REASON = "main advanced and PR #7 now conflicts with it.";

test("NOT-356: base_advanced clean sync plain-pushes without a merge failure, and spends the episode's one sync", async () => {
  const { origin, local, baseMovedSha } = initChecksWaitRepos(false);
  const { issueId, instanceId } = developingIssueIn(local);
  const calls = recordGit();
  try {
    const sync = {
      issueId,
      instanceId,
      repo: local,
      branch: "issue-1",
      baseBranch: "main",
      prNumber: 7,
      mergeReason: BASE_ADVANCED_REASON,
      entry: "base_advanced" as const,
    };
    // No mergePr: the merge entry would skip without one; this entry never merges.
    const first = await runMergeConflictSync(sync);
    assert.equal(first.outcome, "synced");
    assert.equal(contains(origin, baseMovedSha, "issue-1"), true);
    assert.deepEqual(
      calls.filter((a) => a[0] === "push"),
      [["push", "-u", "origin", "HEAD:refs/heads/issue-1"]]
    );
    assertSafeGit(calls);
    const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
    const audit = listWorkflowEventsForIssue(issueId).filter((e) => e.type === "auto_merge.conflict_sync");
    assert.equal(audit.length, 1);
    assert.equal(JSON.parse(audit[0]!.payloadJson!).entry, "base_advanced");
    assert.equal(checksWaitSyncSpent(issueId, instanceId), true, "a base_advanced sync spends the push-only sync");

    // Neither push-only entry syncs again this episode.
    const before = calls.length;
    assert.deepEqual(await runMergeConflictSync(sync), { outcome: "repair_needed", files: [] });
    assert.deepEqual(await runMergeConflictSync({ ...sync, entry: "checks_wait" }), { outcome: "repair_needed", files: [] });
    assert.equal(calls.length, before, "no second sync");
  } finally {
    setConflictSyncGitExecForTests(null);
  }
});

test("NOT-356: base_advanced conflict returns the files; the repair round supersedes the idle item and refuses a leased one", async () => {
  const { local } = initChecksWaitRepos(true);
  const { issueId, instanceId } = developingIssueIn(local);
  const calls = recordGit();
  try {
    const first = await runMergeConflictSync({
      issueId,
      instanceId,
      repo: local,
      branch: "issue-1",
      baseBranch: "main",
      prNumber: 7,
      mergeReason: BASE_ADVANCED_REASON,
      entry: "base_advanced",
    });
    assert.deepEqual(first, { outcome: "repair_needed", files: ["shared.txt"] });
    assert.equal(calls.filter((a) => a[0] === "push").length, 0);
    assertSafeGit(calls);

    const queue = () =>
      queueConflictRepairRound({
        issueId,
        instanceId,
        baseBranch: "main",
        branch: "issue-1",
        files: ["shared.txt"],
        entry: "base_advanced",
      });
    // A leased item means the issue is not idle — nothing queues.
    const leased = claimWorkItem("not356-test", { leaseMs: 60_000 })!;
    assert.equal(leased.issueId, issueId);
    assert.equal(queue(), null);
    const { requeueWorkItem } = await import("../repository/work-items.js");
    assert.ok(requeueWorkItem(leased.id, leased.leaseToken!, { kind: "test" }, { backoffMs: 0 }));
    const idle = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
    assert.equal(idle.length, 1);

    const queued = queue();
    assert.ok(queued);
    assert.equal(getWorkItem(idle[0]!.id)!.status, "cancelled", "the parked item is superseded");
    const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
    assert.deepEqual(pending.map((i) => i.id), [queued!.id]);
    assert.deepEqual(JSON.parse(pending[0]!.payloadJson!).conflictRepair, {
      baseBranch: "main",
      branch: "issue-1",
      files: ["shared.txt"],
    });
    assert.equal(getIssue(issueId)!.status, "developing");
    assert.equal(conflictRepairSpent(issueId, instanceId).spent, true);
  } finally {
    setConflictSyncGitExecForTests(null);
  }
});

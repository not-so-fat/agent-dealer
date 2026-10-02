// NOT-102 acceptance: auto-merge on/off, merge failure escalation, recent repos.
// NOT-151: portable github.com/… issue.repo must resolve to managed clone cwd, not the identity.
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not102-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue, listRecentRepos } = await import("../repository/issues.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { getActiveWorkflowInstance, listWorkflowEventsForIssue } = await import(
  "../repository/workflow-events.js"
);
const { claimWorkItem, listWorkItemsForIssue } = await import("../repository/work-items.js");
const { startWorkflow, applyCompletion } = await import("./commands.js");
const { ReviewerResult } = await import("./reviewer-result.js");
const { setMergePrForTests, clearFinalizeInflightForTests } = await import("./auto-merge.js");
const { managedRepoPath } = await import("../adapters/managed-repo.js");
const { buildDeveloperPrompt } = await import("./prompts.js");
const {
  defaultSyncGitExec,
  setConflictSyncGithubForTests,
  setConflictSyncGitExecForTests,
} = await import("./merge-conflict-sync.js");

/** Real local checkout so resolveAutoMergeCwd accepts the default legacy repo. */
let fixtureRepo = "";

function initFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not102-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

before(() => {
  migrate();
  fixtureRepo = initFixtureRepo();
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
  clearFinalizeInflightForTests();
  setMergePrForTests(async () => ({ ok: true }));
  setConflictSyncGitExecForTests(null);
  setConflictSyncGithubForTests(null);
});
afterEach(() => {
  setMergePrForTests(null);
  clearFinalizeInflightForTests();
  setConflictSyncGitExecForTests(null);
  setConflictSyncGithubForTests(null);
});

function newIssue(opts: { autoMerge?: boolean; repo?: string } = {}): string {
  return createIssue({
    title: "Coordinate me",
    description: "d",
    acceptanceCriteria: "It works",
    repo: opts.repo ?? fixtureRepo,
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
    autoMerge: opts.autoMerge ?? false,
  }).id;
}

function claim(issueId: string) {
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  return item!;
}

async function complete(issueId: string, outcome: Parameters<typeof applyCompletion>[2]) {
  const item = claim(issueId);
  return applyCompletion(item.id, item.leaseToken!, outcome);
}

const okReview = (verdict: "approved" | "changes_requested" | "escalated") =>
  ReviewerResult.parse({
    verdict,
    baseSha: "b",
    headSha: "h",
    acceptanceCriteriaAssessment: "ok",
    evidenceAssessment: "ok",
    findings: [],
    risks: [],
  });

const cleanHandoff = {
  kind: "clean_handoff",
  branch: "issue-1",
  headSha: "abc123",
  baseSha: "base1",
  prNumber: 42,
  prUrl: "https://gh/pr/42",
} as const;

test("autoMerge off: reviewer approve opens final_review and does not merge yet", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(getIssue(issueId)!.currentOwner, "human");
  assert.ok(listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review"));
  assert.equal(calls.length, 0);
});

test("autoMerge off: final_review complete undrafts+merges then marks done", async () => {
  const { resolveHumanActionAndAdvanceAsync } = await import("./commands.js");
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "done");
    assert.equal(resolved.instanceCompleted, true);
    assert.equal(resolved.triggerReflect, true);
  }
  assert.deepEqual(calls, [{ cwd: fixtureRepo, number: 42 }]);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
});

test("autoMerge off: final_review complete with merge failure escalates (never done with draft)", async () => {
  const { resolveHumanActionAndAdvanceAsync } = await import("./commands.js");
  setMergePrForTests(async () => ({ ok: false, reason: "protected branch" }));

  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  const action = listHumanActionsForIssue(issueId).find((a) => a.actionType === "final_review")!;

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "yusuke", "complete");
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.issueStatus, "needs_human");
    assert.equal(resolved.instanceCompleted, false);
  }
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.match(issue.currentIntent ?? "", /protected branch/);
  assert.ok(listHumanActionsForIssue(issueId).some((a) => a.actionType === "policy_escalation" && a.status === "open"));
});

test("autoMerge on: reviewer approve merges PR, marks done, skips final_review human action", async () => {
  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  const result = await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(result.applied, true);
  if (result.applied) {
    assert.equal(result.instanceCompleted, true);
    assert.equal(result.triggerReflect, true);
  }
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.actionType === "final_review").length,
    0
  );
  assert.deepEqual(calls, [{ cwd: fixtureRepo, number: 42 }]);
  assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "issue.completed"));
});

test("NOT-151: portable github.com repo merges via managed clone path, not identity string", async () => {
  const identity = "github.com/not-so-fat/agent-dealer";
  const managed = managedRepoPath(identity);
  fs.mkdirSync(path.join(managed, ".git"), { recursive: true });

  const calls: Array<{ cwd: string; number: number }> = [];
  setMergePrForTests(async (opts) => {
    calls.push(opts);
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true, repo: identity });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(getIssue(issueId)!.status, "done");
  assert.deepEqual(calls, [{ cwd: managed, number: 42 }]);
  assert.notEqual(calls[0]?.cwd, identity);
});

test("NOT-151: missing managed clone escalates clearly without spawn gh ENOENT", async () => {
  let mergeCalled = false;
  setMergePrForTests(async () => {
    mergeCalled = true;
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true, repo: "github.com/missing/no-clone" });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(mergeCalled, false);
  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.match(issue.currentIntent ?? "", /Managed clone missing/);
  assert.doesNotMatch(issue.currentIntent ?? "", /ENOENT/);
});

test("autoMerge on: merge failure escalates to policy_escalation; issue not left half-done as final_review", async () => {
  setMergePrForTests(async () => ({ ok: false, reason: "required status checks failed" }));

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  assert.equal(issue.currentOwner, "human");
  assert.match(issue.currentIntent ?? "", /Auto-merge failed/);
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action, "expected open policy_escalation after merge failure");
  assert.match(action!.reason, /required status checks failed/);
  assert.ok(getActiveWorkflowInstance(issueId), "workflow stays active for human resume");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length, 0);
});

test("autoMerge on: gh timeout reason escalates (bounded hang must not leave final_review park)", async () => {
  const { GH_MERGE_TIMEOUT_MS } = await import("./auto-merge.js");
  setMergePrForTests(async () => ({
    ok: false,
    reason: `gh timed out after ${GH_MERGE_TIMEOUT_MS}ms`,
  }));

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "needs_human");
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action);
  assert.match(action!.reason, /timed out after/);
});

test("listRecentRepos returns distinct GitHub identities newest-first and skips legacy local paths", () => {
  const base = {
    developerAgentId: BUILTIN_AGENT_CLAUDE_ID,
    reviewerAgentId: BUILTIN_AGENT_CURSOR_ID,
    baseBranch: "main" as const,
    source: "manual" as const,
    acceptanceCriteria: "x",
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
  };
  createIssue({ ...base, title: "legacy", repo: "/repos/legacy-local" });
  createIssue({ ...base, title: "old", repo: "github.com/acme/alpha" });
  const later = createIssue({ ...base, title: "new", repo: "github.com/acme/beta" });
  createIssue({ ...base, title: "alpha again", repo: "github.com/acme/alpha" });
  getDb().prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), later.id);

  const repos = listRecentRepos();
  assert.equal(repos[0], "github.com/acme/beta");
  assert.ok(repos.includes("github.com/acme/alpha"));
  assert.equal(repos.filter((r) => r === "github.com/acme/alpha").length, 1);
  assert.equal(repos.some((r) => r.startsWith("/")), false);
});

test("recoverStrandedAutoMerges finalizes a parked auto-merge after a simulated crash", async () => {
  const { recoverStrandedAutoMerges, AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");

  setMergePrForTests(async () => ({ ok: true }));
  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  // Simulate crash after approve routing parked for auto-merge but before finalize.
  // reviewing → final_review is legal; park with the recovery intent key.
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  // Need a pending reviewer item completed first — simplify: just set park state after handoff
  // left us in reviewing with a pending reviewer. Cancel that path and force the park.
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });

  assert.equal(getIssue(issueId)!.status, "final_review");
  assert.equal(getIssue(issueId)!.currentIntent, AUTO_MERGE_INTENT);
  assert.ok(getActiveWorkflowInstance(issueId));

  const recovered = await recoverStrandedAutoMerges();
  assert.ok(recovered.finalized.includes(issueId));
  assert.equal(getIssue(issueId)!.status, "done");
});

test("recoverStrandedAutoMerges recovers human-complete park even when autoMerge is off", async () => {
  const { recoverStrandedAutoMerges, AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");

  setMergePrForTests(async () => ({ ok: true }));
  const issueId = newIssue({ autoMerge: false });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });

  const recovered = await recoverStrandedAutoMerges();
  assert.ok(recovered.finalized.includes(issueId));
  assert.equal(getIssue(issueId)!.status, "done");
});

/** Park an auto-merge issue at final_review/system/AUTO_MERGE_INTENT with an active workflow. */
async function parkForAutoMerge(issueId: string): Promise<void> {
  const { AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  transitionIssue(issueId, "reviewing", { currentOwner: "reviewer", currentIntent: "reviewing" });
  getDb().exec("DELETE FROM work_items");
  transitionIssue(issueId, "final_review", {
    currentOwner: "system",
    currentIntent: AUTO_MERGE_INTENT,
    prNumber: 42,
    prUrl: "https://gh/pr/42",
  });
}

test("concurrent finalizeAutoMerge calls coalesce: one merge, done, no dangling policy_escalation", async () => {
  const { finalizeAutoMerge, recoverStrandedAutoMerges } = await import("./auto-merge.js");

  let merges = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setMergePrForTests(async () => {
    merges += 1;
    await gate;
    return { ok: true };
  });

  const issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const p1 = finalizeAutoMerge(issueId);
  const p2 = finalizeAutoMerge(issueId);
  const p3 = recoverStrandedAutoMerges();
  // Give the first finalize a chance to register inflight before recover lists stranded.
  await Promise.resolve();
  release();
  const [r1, r2, recovered] = await Promise.all([p1, p2, p3]);

  assert.equal(merges, 1, "concurrent callers must share one gh merge");
  assert.equal(r1.issueStatus, "done");
  assert.equal(r2.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "must not leave an open policy_escalation on a done issue"
  );
  // recover may skip (inflight filter) or coalesce — either way no error and issue is done.
  assert.equal(recovered.errors.length, 0);
});

test("success txn dismisses stale needs_human policy_escalation from a racing failure", async () => {
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  const { createHumanAction } = await import("../repository/human-actions.js");

  let issueId = "";
  setMergePrForTests(async () => {
    // Simulate a racing escalateMergeFailure that wrote needs_human + open action
    // before this success path's DB transaction runs.
    const inst = getActiveWorkflowInstance(issueId)!;
    transitionIssue(issueId, "needs_human", {
      currentOwner: "human",
      currentIntent: "Auto-merge failed: transient rate limit",
    });
    createHumanAction({
      issueId,
      workflowInstanceId: inst.id,
      actionType: "policy_escalation",
      reason: "Auto-merge failed: transient rate limit",
      question: "Auto-merge failed: transient rate limit Resume development, or close the issue?",
      responseOptions: [
        { choice: "resume", label: "Resume development" },
        { choice: "close", label: "Close" },
      ],
    });
    return { ok: true };
  });

  issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const result = await finalizeAutoMerge(issueId);
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  const open = listHumanActionsForIssue(issueId).filter(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.equal(open.length, 0, "stale policy_escalation must be resolved on success");
  const resolved = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "resolved"
  );
  assert.ok(resolved, "expected the racing escalation to be marked resolved");
});

/** NOT-310: origin + local clone where branch `issue-1` (commit B) is behind a moved
 * base (commit C). With `conflict`, C edits the same line of shared.txt that B
 * touched; otherwise C adds an unrelated file and merges cleanly. */
function initNot310Repos(opts: { conflict: boolean }): {
  origin: string;
  local: string;
  baseMovedSha: string;
} {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310-origin-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: origin });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: origin });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: origin });
  fs.writeFileSync(path.join(origin, "base.txt"), "v1\n");
  fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nline2\n");
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync("git", ["commit", "-m", "A base"], { cwd: origin });

  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310-local-"));
  fs.rmSync(local, { recursive: true, force: true });
  execFileSync("git", ["clone", origin, local]);
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: local });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: local });
  execFileSync("git", ["checkout", "-b", "issue-1"], { cwd: local });
  fs.writeFileSync(path.join(local, "shared.txt"), "line1\nfeature change\n");
  execFileSync("git", ["add", "."], { cwd: local });
  execFileSync("git", ["commit", "-m", "B feature"], { cwd: local });
  execFileSync("git", ["push", "-u", "origin", "issue-1"], { cwd: local });
  // Like a production managed clone, the main checkout rests on the base — the
  // issue branch must not be checked out anywhere for the sync to proceed.
  execFileSync("git", ["checkout", "-q", "main"], { cwd: local });

  if (opts.conflict) {
    fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nbase change\n");
  } else {
    fs.writeFileSync(path.join(origin, "other.txt"), "c\n");
  }
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync("git", ["commit", "-m", "C base moved"], { cwd: origin });
  const baseMovedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin, encoding: "utf8" }).trim();
  return { origin, local, baseMovedSha };
}

function branchContains(repo: string, sha: string, branch: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, branch], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

const NOT_MERGEABLE = "Pull request #42 is not mergeable: the merge commit cannot be cleanly created";

test("NOT-310: cleanly-mergeable base syncs, pushes without force, polls checks, merges untouched", async () => {
  const { origin, local, baseMovedSha } = initNot310Repos({ conflict: false });
  const gitArgs: string[][] = [];
  setConflictSyncGitExecForTests(async (args, opts) => {
    gitArgs.push(args);
    return defaultSyncGitExec(args, opts);
  });
  let checksPolls = 0;
  setConflictSyncGithubForTests({
    checksSnapshot: async () => {
      checksPolls += 1;
      return "success";
    },
  });
  const mergeCalls: Array<{ cwd: string; number: number }> = [];
  let merges = 0;
  setMergePrForTests(async (opts) => {
    mergeCalls.push(opts);
    merges += 1;
    return merges === 1 ? { ok: false, reason: NOT_MERGEABLE } : { ok: true };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(merges, 2, "one failing merge plus one post-sync retry");
  assert.deepEqual(mergeCalls, [
    { cwd: local, number: 42 },
    { cwd: local, number: 42 },
  ]);
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(getActiveWorkflowInstance(issueId), null);
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "no human action when the sync resolves the staleness"
  );
  assert.ok(checksPolls >= 1, "expected the checks poll to run after the sync push");
  // The sync merged the moved base and pushed it: origin's branch contains C.
  assert.equal(branchContains(origin, baseMovedSha, "issue-1"), true);
  // No force-push anywhere in the new path.
  const pushes = gitArgs.filter((a) => a[0] === "push");
  assert.ok(pushes.length >= 1, "expected at least one push");
  for (const args of pushes) {
    assert.ok(
      args.every((a) => !/^(-f|--force)/.test(a)),
      `push must never force: ${args.join(" ")}`
    );
  }
  assert.ok(
    gitArgs.some((a) => a.includes("merge") && a.includes("origin/main")),
    "expected a merge of the fetched base"
  );
  const root = path.join(local, ".agent-dealer-worktrees");
  const leftovers = fs.existsSync(root) ? fs.readdirSync(root).filter((e) => e.startsWith("merge-sync-")) : [];
  assert.deepEqual(leftovers, []);
});

test("NOT-310: retry_merge runs the same conflict sync (commands.ts retry path)", async () => {
  const { resolveHumanActionAndAdvanceAsync } = await import("./commands.js");
  const { cancelWorkItem } = await import("../repository/work-items.js");
  const { createHumanAction } = await import("../repository/human-actions.js");
  const { transitionIssue } = await import("../repository/issues.js");
  const { origin, local, baseMovedSha } = initNot310Repos({ conflict: false });
  setConflictSyncGithubForTests({ checksSnapshot: async () => "success" });
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return merges === 1 ? { ok: false, reason: NOT_MERGEABLE } : { ok: true };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  // Park like a merge failure did: drop the pending reviewer round, go
  // needs_human with a merge-failure action offering retry_merge.
  for (const item of listWorkItemsForIssue(issueId)) {
    if (item.status === "pending" || item.status === "leased") cancelWorkItem(item.id);
  }
  transitionIssue(issueId, "needs_human", {
    currentOwner: "human",
    currentIntent: `Auto-merge failed: ${NOT_MERGEABLE}`,
  });
  const action = createHumanAction({
    issueId,
    workflowInstanceId: getActiveWorkflowInstance(issueId)!.id,
    actionType: "policy_escalation",
    reason: `Auto-merge failed: ${NOT_MERGEABLE}`,
    question: `Auto-merge failed: ${NOT_MERGEABLE} Retry the merge, queue another repair round, or close the issue?`,
    evidence: { mergeFailure: true },
    responseOptions: [
      { choice: "retry_merge", label: "Retry merge" },
      { choice: "repair", label: "Another repair round" },
      { choice: "close", label: "Close" },
    ],
  });

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "retry_merge");
  assert.equal(resolved.ok, true);
  assert.equal(merges, 2, "retry_merge must sync + retry, not just re-run gh");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
  assert.equal(branchContains(origin, baseMovedSha, "issue-1"), true);
});

test("NOT-310: textual conflict aborts the sync and queues a conflict-repair round, no human action yet", async () => {
  const { local, baseMovedSha } = initNot310Repos({ conflict: true });
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return { ok: false, reason: NOT_MERGEABLE };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(merges, 1);
  assert.equal(getIssue(issueId)!.status, "repairing");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "no human action is opened before the conflict-repair round runs"
  );
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, "developer");
  const payload = JSON.parse(pending[0]!.payloadJson!) as {
    conflictRepair?: { baseBranch: string; branch: string; files: string[] };
  };
  assert.deepEqual(payload.conflictRepair, { baseBranch: "main", branch: "issue-1", files: ["shared.txt"] });
  const prompt = buildDeveloperPrompt({
    taskSnapshot: { title: "t", description: "d", acceptanceCriteria: "a", repo: local, baseBranch: "main" },
    round: pending[0]!.round,
    conflictRepair: payload.conflictRepair,
  });
  assert.ok(prompt.includes("main"), "repair prompt names the base branch");
  assert.ok(prompt.includes("shared.txt"), "repair prompt names the conflicting files");
  // The worktree merge was aborted: the branch still lacks the moved base ...
  assert.equal(branchContains(local, baseMovedSha, "issue-1"), false);
  // ... and no merge-sync checkout is left behind.
  const root = path.join(local, ".agent-dealer-worktrees");
  const leftovers = fs.existsSync(root) ? fs.readdirSync(root).filter((e) => e.startsWith("merge-sync-")) : [];
  assert.deepEqual(leftovers, []);
});

test("NOT-310: still conflicting after the conflict-repair round escalates once, listing files", async () => {
  const { local } = initNot310Repos({ conflict: true });
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return { ok: false, reason: NOT_MERGEABLE };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });
  assert.equal(getIssue(issueId)!.status, "repairing");

  // The conflict-repair round runs and hands off; the reviewer approves again.
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(merges, 2);
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length, 0);
  const open = listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
  assert.equal(open.length, 1, "exactly one policy_escalation exists");
  assert.equal(open[0]!.actionType, "policy_escalation");
  assert.match(open[0]!.reason, /shared\.txt/);
  assert.deepEqual(JSON.parse(open[0]!.responseOptionsJson!), [
    { choice: "retry_merge", label: "Retry merge" },
    { choice: "repair", label: "Another repair round" },
    { choice: "close", label: "Close" },
  ]);
  const evidence = JSON.parse(open[0]!.evidenceJson!) as Record<string, unknown>;
  assert.equal(evidence.mergeFailure, true);
  assert.deepEqual(evidence.conflictingFiles, ["shared.txt"]);
});

test("escalate txn no-ops when a racing success already marked the issue done", async () => {
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  const { transitionIssue } = await import("../repository/issues.js");
  const { completeWorkflowInstance } = await import("../repository/workflow-events.js");

  let issueId = "";
  setMergePrForTests(async () => {
    // Simulate a racing success that completed the issue before this failure path escalates.
    const inst = getActiveWorkflowInstance(issueId)!;
    transitionIssue(issueId, "done", {
      currentOwner: "system",
      currentIntent: "Auto-merged after reviewer approval",
    });
    completeWorkflowInstance(inst.id, "done");
    return { ok: false, reason: "transient rate limit" };
  });

  issueId = newIssue({ autoMerge: true });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await parkForAutoMerge(issueId);

  const result = await finalizeAutoMerge(issueId);
  assert.equal(result.issueStatus, "done");
  assert.equal(getIssue(issueId)!.status, "done");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0,
    "must not open policy_escalation on an already-done issue"
  );
});

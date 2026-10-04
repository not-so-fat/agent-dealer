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
 * touched; otherwise C adds an unrelated file and merges cleanly. With
 * `upToDate`, C lands before the branch is cut, so the branch already contains
 * the base tip (a "not mergeable" failure there is a policy block, not
 * staleness) — the conflict flag is then meaningless and must be false. */
function initNot310Repos(opts: { conflict: boolean; upToDate?: boolean }): {
  origin: string;
  local: string;
  baseMovedSha: string;
} {
  assert.equal(
    opts.upToDate === true && opts.conflict === true,
    false,
    "upToDate fixtures cannot also conflict"
  );
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not310-origin-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: origin });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: origin });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: origin });
  fs.writeFileSync(path.join(origin, "base.txt"), "v1\n");
  fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nline2\n");
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync("git", ["commit", "-m", "A base"], { cwd: origin });

  const commitC = () => {
    if (opts.conflict) {
      fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nbase change\n");
    } else {
      fs.writeFileSync(path.join(origin, "other.txt"), "c\n");
    }
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["commit", "-m", "C base moved"], { cwd: origin });
  };
  if (opts.upToDate) commitC();

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

  if (!opts.upToDate) commitC();
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

test("NOT-310: up-to-date branch that stays not mergeable escalates directly, no repair round", async () => {
  const { local, baseMovedSha } = initNot310Repos({ conflict: false, upToDate: true });
  setConflictSyncGithubForTests({ checksSnapshot: async () => "success" });
  const policyReason = "Pull request #42 is not mergeable: base branch policy prohibits the merge";
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return { ok: false, reason: policyReason };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(merges, 2, "failing merge plus one post-sync retry");
  assert.equal(getIssue(issueId)!.status, "needs_human");
  assert.equal(
    listWorkItemsForIssue(issueId).filter((i) => i.status === "pending").length,
    0,
    "a policy block must not spend a conflict-repair round"
  );
  const open = listHumanActionsForIssue(issueId).filter((a) => a.status === "open");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.actionType, "policy_escalation");
  assert.match(open[0]!.reason, /base branch policy prohibits the merge/);
  assert.match(open[0]!.reason, /already contains main .* — not a staleness conflict/);
  const evidence = JSON.parse(open[0]!.evidenceJson!) as Record<string, unknown>;
  assert.equal(evidence.mergeFailure, true);
  assert.ok(!("conflictingFiles" in evidence), "no file list when nothing conflicted");
  assert.equal(branchContains(local, baseMovedSha, "issue-1"), true);
});

test("NOT-310: base advancing during the checks poll still earns the repair round", async () => {
  const { origin, local } = initNot310Repos({ conflict: false });
  // D lands on origin/main while the sync poll runs — a genuine new conflict.
  let advanced = false;
  setConflictSyncGithubForTests({
    checksSnapshot: async () => {
      if (!advanced) {
        advanced = true;
        fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nbase change\n");
        execFileSync("git", ["add", "."], { cwd: origin });
        execFileSync("git", ["commit", "-m", "D base moved again"], { cwd: origin });
      }
      return "success";
    },
  });
  let merges = 0;
  setMergePrForTests(async () => {
    merges += 1;
    return { ok: false, reason: NOT_MERGEABLE };
  });

  const issueId = newIssue({ autoMerge: true, repo: local });
  startWorkflow(issueId);
  await complete(issueId, cleanHandoff);
  await complete(issueId, { kind: "verdict", result: okReview("approved") });

  assert.equal(merges, 2);
  assert.equal(getIssue(issueId)!.status, "repairing");
  assert.equal(listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length, 0);
  const pending = listWorkItemsForIssue(issueId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  const payload = JSON.parse(pending[0]!.payloadJson!) as {
    conflictRepair?: { baseBranch: string; branch: string; files: string[] };
  };
  assert.deepEqual(payload.conflictRepair, { baseBranch: "main", branch: "issue-1", files: [] });
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

// ---------------------------------------------------------------------------
// NOT-356: after Dealer merges a PR, the other open Dealer PRs on the same repo +
// base are probed against the new base tip and the idle conflicting ones synced.

const { settleBaseAdvancedScansForTests, setBaseAdvancedProbeForTests } = await import("./base-advanced-scan.js");
const { probeBaseConflict, observeGitCommands } = await import("../adapters/git-worktree.js");

/** origin + clone with one pushed branch per sibling. A `conflict` sibling edits the
 * line of shared.txt the merged PR also edits; a clean one adds its own file.
 * `landMergedPr` lands that merged PR's change on origin/main. */
function initSiblingRepos(siblings: Array<{ branch: string; conflict: boolean }>): {
  origin: string;
  local: string;
  heads: Record<string, string>;
  landMergedPr: () => string;
} {
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not356-origin-"));
  g(origin, "init", "-q", "-b", "main");
  g(origin, "config", "user.email", "test@example.com");
  g(origin, "config", "user.name", "Test");
  fs.writeFileSync(path.join(origin, "shared.txt"), "line1\nline2\n");
  g(origin, "add", ".");
  g(origin, "commit", "-q", "-m", "A base");

  const local = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not356-local-"));
  fs.rmSync(local, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, local]);
  g(local, "config", "user.email", "test@example.com");
  g(local, "config", "user.name", "Test");
  const heads: Record<string, string> = {};
  for (const s of siblings) {
    g(local, "checkout", "-q", "-b", s.branch, "main");
    if (s.conflict) fs.writeFileSync(path.join(local, "shared.txt"), `line1\n${s.branch} change\n`);
    else fs.writeFileSync(path.join(local, `${s.branch}.txt`), "own file\n");
    g(local, "add", ".");
    g(local, "commit", "-q", "-m", `${s.branch} feature`);
    g(local, "push", "-q", "-u", "origin", s.branch);
    heads[s.branch] = g(local, "rev-parse", "HEAD");
    g(local, "checkout", "-q", "main");
  }
  let landed = 0;
  const landMergedPr = () => {
    landed += 1;
    fs.writeFileSync(path.join(origin, "shared.txt"), `line1\nmerged change ${landed}\n`);
    g(origin, "add", ".");
    g(origin, "commit", "-q", "-m", `merged sibling PR ${landed}`);
    return g(origin, "rev-parse", "HEAD");
  };
  return { origin, local, heads, landMergedPr };
}

function originTip(origin: string, branch: string): string {
  return execFileSync("git", ["rev-parse", branch], { cwd: origin, encoding: "utf8" }).trim();
}

/** The merged issue: handed off and parked for auto-merge. Set up before siblings
 * (parkForAutoMerge clears every work item). */
async function parkedMergeIn(repo: string): Promise<string> {
  const issueId = newIssue({ autoMerge: true, repo });
  startWorkflow(issueId);
  await complete(issueId, { ...cleanHandoff, branch: "merged-pr" });
  await parkForAutoMerge(issueId);
  return issueId;
}

/** The developer effect's durable proof that Dealer pushed `sha` to the branch. */
async function recordDealerPush(issueId: string, branch: string, sha: string): Promise<void> {
  const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
  appendWorkflowEvent({
    issueId,
    workflowInstanceId: getActiveWorkflowInstance(issueId)!.id,
    workerSessionId: null,
    type: "checkpoint.observed",
    actorType: "developer",
    stage: getIssue(issueId)!.status,
    payload: { kind: "branch_pushed", observedSha: sha, branch },
  });
}

/** An idle sibling: Dealer pushed `pushedSha` (default: the handed-off head), then
 * handed off at `headSha`; its reviewer round still queued. */
async function idleSiblingIn(
  repo: string,
  branch: string,
  headSha: string,
  prNumber: number,
  pushedSha: string = headSha
): Promise<string> {
  const issueId = newIssue({ autoMerge: false, repo });
  startWorkflow(issueId);
  await recordDealerPush(issueId, branch, pushedSha);
  // Hold back earlier siblings' queued reviewer rounds so the claim gets this issue's item.
  const held = getDb()
    .prepare("SELECT id, available_at FROM work_items WHERE issue_id != ? AND status = 'pending'")
    .all(issueId) as Array<{ id: string; available_at: string }>;
  const setAvailable = getDb().prepare("UPDATE work_items SET available_at = ? WHERE id = ?");
  for (const h of held) setAvailable.run("9999-01-01T00:00:00.000Z", h.id);
  try {
    await complete(issueId, { ...cleanHandoff, branch, headSha, prNumber, prUrl: `https://gh/pr/${prNumber}` });
  } finally {
    for (const h of held) setAvailable.run(h.available_at, h.id);
  }
  assert.equal(getIssue(issueId)!.status, "reviewing");
  return issueId;
}

function baseAdvancedEvents(issueId: string): Array<Record<string, unknown>> {
  return listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "base.advanced")
    .map((e) => JSON.parse(e.payloadJson!) as Record<string, unknown>);
}

function syncEvents(issueId: string): Array<Record<string, unknown>> {
  return listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "auto_merge.conflict_sync")
    .map((e) => JSON.parse(e.payloadJson!) as Record<string, unknown>);
}

/** Every git command: the sync's seam plus git-worktree's runner (fetch/probe/worktree). */
function recordAllGit(): { calls: string[][]; stop: () => void } {
  const calls: string[][] = [];
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    return defaultSyncGitExec(args, opts);
  });
  const stop = observeGitCommands((args) => {
    calls.push([...args]);
  });
  return { calls, stop };
}

function assertNoForceNoRebase(calls: string[][]): void {
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

const syncMerges = (calls: string[][]) => calls.filter((a) => a.includes("merge") && a.includes("--no-edit"));

afterEach(() => {
  setBaseAdvancedProbeForTests(null);
});

test("NOT-356: an idle sibling that now conflicts is probed, synced, and sent one repair round naming the files", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-a", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-a", heads["sib-a"]!, 43);
  const reviewerItem = listWorkItemsForIssue(siblingId).find((i) => i.status === "pending")!;
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    const result = await finalizeAutoMerge(mergedId);
    assert.equal(result.issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  const events = baseAdvancedEvents(siblingId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.action, "repair_queued");
  assert.equal(events[0]!.probe, "conflict");
  assert.deepEqual(events[0]!.files, ["shared.txt"]);
  assert.equal(events[0]!.mergedIssueId, mergedId);
  // The local merge-tree probe ran against the fetched base, not GitHub's mergeable state.
  assert.ok(calls.some((a) => a[0] === "merge-tree" && a.includes("--write-tree") && a.includes(heads["sib-a"]!)));
  // runMergeConflictSync ran through its base_advanced entry.
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.entry, e.outcome]),
    [["base_advanced", "repair_needed"]]
  );
  assert.equal(syncMerges(calls).length, 1);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "a conflicted sync pushes nothing");
  assertNoForceNoRebase(calls);
  assert.equal(originTip(origin, "sib-a"), heads["sib-a"]);

  const sibling = getIssue(siblingId)!;
  assert.equal(sibling.status, "repairing");
  assert.equal(
    listWorkItemsForIssue(siblingId).find((i) => i.id === reviewerItem.id)!.status,
    "cancelled",
    "the stale reviewer round is superseded"
  );
  const pending = listWorkItemsForIssue(siblingId).filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, "developer");
  assert.deepEqual(JSON.parse(pending[0]!.payloadJson!).conflictRepair, {
    baseBranch: "main",
    branch: "sib-a",
    files: ["shared.txt"],
  });
  assert.equal(listHumanActionsForIssue(siblingId).filter((a) => a.status === "open").length, 0);
});

test("NOT-356: a sibling that does not conflict gets only a base.advanced event", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-clean", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-clean", heads["sib-clean"]!, 44);
  const before = listWorkflowEventsForIssue(siblingId).length;
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  const after = listWorkflowEventsForIssue(siblingId).slice(before);
  assert.deepEqual(after.map((e) => e.type), ["base.advanced"], "nothing but the event");
  assert.equal(JSON.parse(after[0]!.payloadJson!).action, "clean");
  assert.equal(syncMerges(calls).length, 0, "no sync");
  assert.equal(calls.filter((a) => a[0] === "push").length, 0);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
  assert.equal(listWorkItemsForIssue(siblingId).filter((i) => i.status === "pending").length, 1);
  assert.equal(originTip(origin, "sib-clean"), heads["sib-clean"]);
});

test("NOT-356: a sibling with an active worker session is left alone with a base.advanced event", async () => {
  const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-busy", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-busy", heads["sib-busy"]!, 45);
  const session = createWorkerSession({
    issueId: siblingId,
    role: "reviewer",
    round: 1,
    agentId: null,
    runtime: null,
  });
  assert.ok(startSession(session.id));
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.deepEqual(baseAdvancedEvents(siblingId).map((e) => e.action), ["active_worker"]);
  assert.deepEqual(syncEvents(siblingId), []);
  assert.equal(syncMerges(calls).length, 0);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
  assert.equal(originTip(origin, "sib-busy"), heads["sib-busy"]);
});

test("NOT-356: a sibling whose remote tip is not Dealer's last push is skipped and nothing is pushed", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-hand", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-hand", heads["sib-hand"]!, 46);
  // A human pushes onto the PR branch by hand.
  const g = (...args: string[]) => execFileSync("git", args, { cwd: local, encoding: "utf8" }).trim();
  g("checkout", "-q", "sib-hand");
  fs.writeFileSync(path.join(local, "hand.txt"), "by hand\n");
  g("add", ".");
  g("commit", "-q", "-m", "hand edit");
  g("push", "-q", "origin", "sib-hand");
  const handTip = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["hand_edited"]);
  assert.equal(events[0]!.remoteSha, handTip);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed");
  assert.equal(calls.filter((a) => a[0] === "merge-tree").length, 0, "not even probed");
  assert.deepEqual(syncEvents(siblingId), []);
  assert.equal(originTip(origin, "sib-hand"), handTip);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: a sibling whose probe throws never changes the merge result, and the rest are still processed", async () => {
  const { local, heads, landMergedPr } = initSiblingRepos([
    { branch: "sib-throw", conflict: true },
    { branch: "sib-next", conflict: true },
  ]);
  const mergedId = await parkedMergeIn(local);
  const throwingId = await idleSiblingIn(local, "sib-throw", heads["sib-throw"]!, 47);
  const nextId = await idleSiblingIn(local, "sib-next", heads["sib-next"]!, 48);
  setBaseAdvancedProbeForTests(async (opts) => {
    if (opts.headRef === heads["sib-throw"]) throw new Error("probe exploded");
    return probeBaseConflict(opts);
  });
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  const result = await finalizeAutoMerge(mergedId);
  assert.deepEqual(result, {
    applied: true,
    issueStatus: "done",
    nextWorkItemId: null,
    humanActionId: null,
    instanceCompleted: true,
    triggerReflect: true,
  });
  await settleBaseAdvancedScansForTests();

  assert.equal(getIssue(mergedId)!.status, "done");
  const thrown = baseAdvancedEvents(throwingId);
  assert.deepEqual(thrown.map((e) => e.action), ["failed"]);
  assert.match(String(thrown[0]!.reason), /probe exploded/);
  assert.equal(getIssue(throwingId)!.status, "reviewing", "the failing sibling is left as it was");
  assert.deepEqual(baseAdvancedEvents(nextId).map((e) => e.action), ["repair_queued"]);
  assert.equal(getIssue(nextId)!.status, "repairing");
});

test("NOT-356: a second Dealer merge in the same episode never syncs or repairs the sibling again", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-twice", conflict: true }]);
  const firstMerge = await parkedMergeIn(local);
  const secondMerge = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-twice", heads["sib-twice"]!, 49);
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(firstMerge)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
    assert.equal(getIssue(siblingId)!.status, "repairing");
    assert.equal(getIssue(siblingId)!.currentRound, 2);
    assert.equal((await finalizeAutoMerge(secondMerge)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.deepEqual(baseAdvancedEvents(siblingId).map((e) => e.action), ["repair_queued", "repair_spent"]);
  assert.equal(syncMerges(calls).length, 1, "one sync per issue per episode");
  assert.equal(syncEvents(siblingId).length, 1);
  assert.equal(
    listWorkflowEventsForIssue(siblingId).filter((e) => e.type === "auto_merge.conflict_repair_queued").length,
    1,
    "one repair round per episode"
  );
  assert.equal(getIssue(siblingId)!.currentRound, 2);
  assertNoForceNoRebase(calls);
  assert.equal(originTip(origin, "sib-twice"), heads["sib-twice"]);
});

/** Run one Dealer merge of `mergedId` (landing its change on origin/main) and wait
 * for the sibling scan it starts, recording every git command. */
async function mergeAndScan(mergedId: string, landMergedPr: () => string): Promise<string[][]> {
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const { calls, stop } = recordAllGit();
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }
  return calls;
}

test("NOT-356: a clean sync re-enters the checks wait on the pushed head, superseding the stale reviewer", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-sync", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-sync", heads["sib-sync"]!, 50);
  const reviewerItem = listWorkItemsForIssue(siblingId).find((i) => i.status === "pending")!;
  const roundBefore = getIssue(siblingId)!.currentRound;
  // The probe reports a conflict GitHub could not see yet; the sync then merges cleanly.
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  const calls = await mergeAndScan(mergedId, landMergedPr);

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["synced"]);
  const synced = originTip(origin, "sib-sync");
  assert.notEqual(synced, heads["sib-sync"]);
  assert.equal(events[0]!.syncedHeadSha, synced);
  const pushes = calls.filter((a) => a[0] === "push");
  assert.deepEqual(pushes, [["push", "-u", "origin", "HEAD:refs/heads/sib-sync"]]);
  assertNoForceNoRebase(calls);

  const sibling = getIssue(siblingId)!;
  assert.equal(sibling.status, "repairing");
  assert.equal(sibling.currentOwner, "developer");
  assert.equal(sibling.currentRound, roundBefore, "re-entering the checks wait spends no round");
  assert.match(sibling.currentIntent ?? "", /waiting for CI on/);
  const items = listWorkItemsForIssue(siblingId);
  assert.equal(items.find((i) => i.id === reviewerItem.id)!.status, "cancelled", "no review of the stale head");
  const pending = items.filter((i) => i.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, "developer");
  assert.equal(pending[0]!.id, events[0]!.workItemId);
  const payload = JSON.parse(pending[0]!.payloadJson!);
  assert.equal(payload.publishOnly, true, "a no-agent CI wait on the pushed head");
  assert.equal(payload.branch, "sib-sync");
  assert.equal(payload.conflictRepair, undefined);
});

test("NOT-356: an origin reset to an older Dealer head is a hand edit, not Dealer's last push", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-old", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-old", heads["sib-old"]!, 51);
  // Dealer later pushed a newer head (a base sync) onto the branch ...
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  g(local, "checkout", "-q", "sib-old");
  fs.writeFileSync(path.join(local, "later.txt"), "dealer sync\n");
  g(local, "add", ".");
  g(local, "commit", "-q", "-m", "dealer sync");
  g(local, "push", "-q", "origin", "sib-old");
  const newer = g(local, "rev-parse", "HEAD");
  g(local, "checkout", "-q", "main");
  const { appendWorkflowEvent } = await import("../repository/workflow-events.js");
  appendWorkflowEvent({
    issueId: siblingId,
    workflowInstanceId: getActiveWorkflowInstance(siblingId)!.id,
    workerSessionId: null,
    type: "auto_merge.conflict_sync",
    actorType: "system",
    stage: "reviewing",
    payload: { outcome: "synced", entry: "base_advanced", branch: "sib-old", baseBranch: "main", headSha: newer },
  });
  // ... and a human reset origin back to the older Dealer handoff head.
  g(origin, "update-ref", "refs/heads/sib-old", heads["sib-old"]!);

  const calls = await mergeAndScan(mergedId, landMergedPr);

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["hand_edited"]);
  assert.equal(events[0]!.remoteSha, heads["sib-old"]);
  assert.equal(events[0]!.lastPushedSha, newer);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0);
  assert.equal(calls.filter((a) => a[0] === "merge-tree").length, 0);
  assert.equal(originTip(origin, "sib-old"), heads["sib-old"]);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: an external push accepted by a publish-only clean handoff is still a hand edit", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-ext", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  // Dealer pushed its head; then someone pushed outside the coordinator, and the
  // publish-only retry accepted origin and handed off at that observed head.
  const g = (...args: string[]) => execFileSync("git", args, { cwd: local, encoding: "utf8" }).trim();
  g("checkout", "-q", "sib-ext");
  fs.writeFileSync(path.join(local, "hand.txt"), "by hand\n");
  g("add", ".");
  g("commit", "-q", "-m", "hand edit");
  g("push", "-q", "origin", "sib-ext");
  const handTip = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  const siblingId = await idleSiblingIn(local, "sib-ext", handTip, 54, heads["sib-ext"]!);
  assert.equal(getIssue(siblingId)!.headSha, handTip, "the handoff recorded the observed head");
  assert.equal(
    JSON.parse(listWorkflowEventsForIssue(siblingId).find((e) => e.type === "pull_request.opened")!.payloadJson!).headSha,
    handTip
  );

  const calls = await mergeAndScan(mergedId, landMergedPr);

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["hand_edited"]);
  assert.equal(events[0]!.remoteSha, handTip);
  assert.equal(events[0]!.lastPushedSha, heads["sib-ext"]);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed");
  assert.equal(calls.filter((a) => a[0] === "merge-tree").length, 0, "not even probed");
  assert.deepEqual(syncEvents(siblingId), []);
  assert.equal(originTip(origin, "sib-ext"), handTip);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: a hand push after the ownership check is never synced or pushed over", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-race", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-race", heads["sib-race"]!, 52);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: local, encoding: "utf8" }).trim();
  let handTip = "";
  // The human push lands between the validated fetch and the sync's own fetch.
  setBaseAdvancedProbeForTests(async (opts) => {
    const result = await probeBaseConflict(opts);
    g("checkout", "-q", "-B", "hand", heads["sib-race"]!);
    fs.writeFileSync(path.join(local, "hand.txt"), "by hand\n");
    g("add", ".");
    g("commit", "-q", "-m", "hand edit");
    g("push", "-q", "origin", "HEAD:refs/heads/sib-race");
    handTip = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    return result;
  });
  const calls = await mergeAndScan(mergedId, landMergedPr);

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["hand_edited"]);
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "tip_moved"]]
  );
  assert.equal(syncMerges(calls).length, 0, "the moved tip is never merged");
  assert.equal(calls.filter((a) => a[0] === "push").length, 0);
  assert.equal(originTip(origin, "sib-race"), handTip);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: a hand push during a conflicted sync merge never queues the repair round", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-textual", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-textual", heads["sib-textual"]!, 59);
  const reviewerItem = listWorkItemsForIssue(siblingId).find((i) => i.status === "pending")!;
  const g = (...args: string[]) => execFileSync("git", args, { cwd: local, encoding: "utf8" }).trim();
  let handTip = "";
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const calls: string[][] = [];
  // The human push lands while the sync's merge reports the textual conflict.
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    try {
      return await defaultSyncGitExec(args, opts);
    } finally {
      if (args.includes("merge") && args.includes("--no-edit")) {
        g("checkout", "-q", "-B", "hand", heads["sib-textual"]!);
        fs.writeFileSync(path.join(local, "hand.txt"), "by hand\n");
        g("add", ".");
        g("commit", "-q", "-m", "hand edit");
        g("push", "-q", "origin", "HEAD:refs/heads/sib-textual");
        handTip = g("rev-parse", "HEAD");
        g("checkout", "-q", "main");
      }
    }
  });
  const { finalizeAutoMerge } = await import("./auto-merge.js");
  assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
  await settleBaseAdvancedScansForTests();

  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.entry, e.outcome]),
    [["base_advanced", "repair_needed"]]
  );
  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["hand_edited"]);
  assert.equal(events[0]!.remoteSha, handTip);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0);
  assert.equal(originTip(origin, "sib-textual"), handTip);
  assert.equal(
    listWorkflowEventsForIssue(siblingId).filter((e) => e.type === "auto_merge.conflict_repair_queued").length,
    0,
    "no repair round was queued"
  );
  assert.equal(listWorkItemsForIssue(siblingId).find((i) => i.id === reviewerItem.id)!.status, "pending");
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: a hand reset to an older tip after the sync fetch is never fast-forwarded over", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-reset", conflict: false }]);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: local, encoding: "utf8" }).trim();
  // A second Dealer commit, so the human has an ancestor to reset back to.
  g("checkout", "-q", "sib-reset");
  fs.writeFileSync(path.join(local, "second.txt"), "second\n");
  g("add", ".");
  g("commit", "-q", "-m", "second commit");
  g("push", "-q", "origin", "sib-reset");
  const dealerTip = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  const olderTip = heads["sib-reset"]!;
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-reset", dealerTip, 55);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const calls: string[][] = [];
  // The human resets origin back to the ancestor after the sync fetched and
  // merged: Dealer's merge commit would now be a valid fast-forward.
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    const out = await defaultSyncGitExec(args, opts);
    if (args.includes("merge") && args.includes("--no-edit")) {
      execFileSync("git", ["update-ref", "refs/heads/sib-reset", olderTip], { cwd: origin });
    }
    return out;
  });
  const stop = observeGitCommands((args) => {
    calls.push([...args]);
  });
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.equal(syncMerges(calls).length, 1, "the sync merged onto the validated tip");
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "no branch-changing push");
  assert.equal(originTip(origin, "sib-reset"), olderTip, "the hand reset stands");
  assert.deepEqual(baseAdvancedEvents(siblingId).map((e) => e.action), ["hand_edited"]);
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "tip_moved"]]
  );
  assertNoForceNoRebase(calls);
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

/** Installs `body` as the repository's pre-push hook, via `core.hooksPath`
 * when given. */
function installRepoPrePushHook(local: string, body: string, hooksPath?: string): void {
  let dir: string;
  if (hooksPath) {
    execFileSync("git", ["config", "core.hooksPath", hooksPath], { cwd: local });
    dir = hooksPath;
  } else {
    dir = path.resolve(
      local,
      execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: local, encoding: "utf8" }).trim()
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pre-push"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test("NOT-356: the sync push still runs the repository's pre-push hook", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-hook", conflict: false }]);
  const hookLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dealer-hook-log-")), "log");
  installRepoPrePushHook(
    local,
    `echo "args $1" >> "${hookLog}"\ncat >> "${hookLog}"\nexit 0`,
    fs.mkdtempSync(path.join(os.tmpdir(), "dealer-repo-hooks-"))
  );
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-hook", heads["sib-hook"]!, 57);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  const calls = await mergeAndScan(mergedId, landMergedPr);

  assert.deepEqual(baseAdvancedEvents(siblingId).map((e) => e.action), ["synced"]);
  const synced = originTip(origin, "sib-hook");
  assert.notEqual(synced, heads["sib-hook"]);
  const log = fs.readFileSync(hookLog, "utf8");
  assert.match(log, /^args origin$/m, "the repository hook got git's arguments");
  assert.match(
    log,
    new RegExp(`^HEAD ${synced} refs/heads/sib-hook ${heads["sib-hook"]}$`, "m"),
    "the repository hook got git's ref lines on stdin"
  );
  assertNoForceNoRebase(calls);
});

test("NOT-356: a repository pre-push hook that rejects still stops the sync push", async () => {
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-veto", conflict: false }]);
  installRepoPrePushHook(local, `echo "repo policy: no pushes" >&2\nexit 1`);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-veto", heads["sib-veto"]!, 58);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  const calls = await mergeAndScan(mergedId, landMergedPr);

  assert.equal(syncMerges(calls).length, 1);
  assert.deepEqual(
    calls.filter((a) => a[0] === "push"),
    [["push", "-u", "origin", "HEAD:refs/heads/sib-veto"]],
    "one plain push attempt, vetoed by the repository hook"
  );
  assert.equal(originTip(origin, "sib-veto"), heads["sib-veto"], "nothing was published");
  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["failed"]);
  assert.match(String(events[0]!.reason), /repo policy: no pushes/);
  assertNoForceNoRebase(calls);
});

test("NOT-356: a worker that starts during the sync blocks the push and leaves the branch as it was", async () => {
  const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-late", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-late", heads["sib-late"]!, 53);
  setBaseAdvancedProbeForTests(async () => {
    const session = createWorkerSession({ issueId: siblingId, role: "reviewer", round: 1, agentId: null, runtime: null });
    assert.ok(startSession(session.id));
    return { state: "conflict", files: ["shared.txt"] } as never;
  });
  const calls = await mergeAndScan(mergedId, landMergedPr);

  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["active_worker"]);
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "refused"]]
  );
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed under a live worker");
  assert.equal(originTip(origin, "sib-late"), heads["sib-late"]);
  assert.equal(
    execFileSync("git", ["rev-parse", "refs/heads/sib-late"], { cwd: local, encoding: "utf8" }).trim(),
    heads["sib-late"],
    "the unpushed base merge is dropped from the local branch"
  );
  assert.equal(getIssue(siblingId)!.status, "reviewing");
  assert.equal(listWorkItemsForIssue(siblingId).filter((i) => i.status === "pending").length, 1);
});

test("NOT-356: a sibling aborted after the sync merge but before the push is never pushed", async () => {
  const { abortIssue } = await import("./commands.js");
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-abort", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-abort", heads["sib-abort"]!, 56);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const calls: string[][] = [];
  // The operator aborts the sibling while the sync's base merge runs: work and
  // sessions are cancelled and the workflow completes, so no worker is active.
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    const out = await defaultSyncGitExec(args, opts);
    if (args.includes("merge") && args.includes("--no-edit")) {
      const aborted = abortIssue(siblingId, "operator", { killProcess: () => true });
      assert.ok(aborted.ok);
    }
    return out;
  });
  const stop = observeGitCommands((args) => {
    calls.push([...args]);
  });
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.equal(syncMerges(calls).length, 1, "the abort landed after the sync merge");
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed to the closed issue");
  assert.equal(originTip(origin, "sib-abort"), heads["sib-abort"]);
  assert.equal(getIssue(siblingId)!.status, "closed");
  const events = baseAdvancedEvents(siblingId);
  assert.deepEqual(events.map((e) => e.action), ["skipped"]);
  assert.match(String(events[0]!.reason), /left its open stage|workflow instance/);
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "refused"]]
  );
  assertNoForceNoRebase(calls);
});

test("NOT-356: a sibling aborted while the pre-push tip re-read runs is never pushed", async () => {
  const { abortIssue } = await import("./commands.js");
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-late-abort", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-late-abort", heads["sib-late-abort"]!, 57);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const calls: string[][] = [];
  // The abort lands during the last await before the push: the ls-remote that
  // re-pins origin's tip after the base merge, which itself still succeeds.
  let merged = false;
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    const out = await defaultSyncGitExec(args, opts);
    if (args.includes("merge") && args.includes("--no-edit")) merged = true;
    if (merged && args[0] === "ls-remote") {
      const aborted = abortIssue(siblingId, "operator", { killProcess: () => true });
      assert.ok(aborted.ok);
    }
    return out;
  });
  const stop = observeGitCommands((args) => {
    calls.push([...args]);
  });
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.equal(syncMerges(calls).length, 1);
  assert.ok(calls.some((a) => a[0] === "ls-remote"), "the abort landed in the pre-push tip re-read");
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed to the closed issue");
  assert.equal(originTip(origin, "sib-late-abort"), heads["sib-late-abort"]);
  assert.equal(getIssue(siblingId)!.status, "closed");
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "refused"]]
  );
  assertNoForceNoRebase(calls);
});

test("NOT-356: a worker that starts during the pre-push tip re-read blocks the push", async () => {
  const { createWorkerSession, startSession } = await import("../repository/worker-sessions.js");
  const { origin, local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-late-worker", conflict: false }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-late-worker", heads["sib-late-worker"]!, 58);
  setBaseAdvancedProbeForTests(async () => ({ state: "conflict", files: ["shared.txt"] }) as never);
  setMergePrForTests(async () => {
    landMergedPr();
    return { ok: true };
  });
  const calls: string[][] = [];
  let merged = false;
  setConflictSyncGitExecForTests(async (args, opts) => {
    calls.push(args);
    const out = await defaultSyncGitExec(args, opts);
    if (args.includes("merge") && args.includes("--no-edit")) merged = true;
    if (merged && args[0] === "ls-remote") {
      const session = createWorkerSession({ issueId: siblingId, role: "reviewer", round: 1, agentId: null, runtime: null });
      assert.ok(startSession(session.id));
    }
    return out;
  });
  const stop = observeGitCommands((args) => {
    calls.push([...args]);
  });
  try {
    const { finalizeAutoMerge } = await import("./auto-merge.js");
    assert.equal((await finalizeAutoMerge(mergedId)).issueStatus, "done");
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.equal(syncMerges(calls).length, 1);
  assert.equal(calls.filter((a) => a[0] === "push").length, 0, "nothing pushed under a live worker");
  assert.equal(originTip(origin, "sib-late-worker"), heads["sib-late-worker"]);
  assert.deepEqual(
    syncEvents(siblingId).map((e) => [e.outcome, e.code]),
    [["skipped", "refused"]]
  );
  assertNoForceNoRebase(calls);
});

test("NOT-356: a PR GitHub already reports merged (a hand merge found by recovery) starts no sibling scan", async () => {
  const { local, heads, landMergedPr } = initSiblingRepos([{ branch: "sib-ext", conflict: true }]);
  const mergedId = await parkedMergeIn(local);
  const siblingId = await idleSiblingIn(local, "sib-ext", heads["sib-ext"]!, 61);
  const before = listWorkflowEventsForIssue(siblingId).length;
  // A human merged the parked PR by hand; the recovery finalize finds it merged.
  landMergedPr();
  setMergePrForTests(async () => ({ ok: true, alreadyMerged: true }));
  const { calls, stop } = recordAllGit();
  try {
    const { recoverStrandedAutoMerges } = await import("./auto-merge.js");
    await recoverStrandedAutoMerges();
    await settleBaseAdvancedScansForTests();
  } finally {
    stop();
  }

  assert.equal(getIssue(mergedId)!.status, "done", "recovery still completes the issue");
  assert.deepEqual(listWorkflowEventsForIssue(siblingId).slice(before), [], "the sibling is untouched");
  assert.deepEqual(calls, [], "no probe, sync or push");
  assert.equal(getIssue(siblingId)!.status, "reviewing");
});

test("NOT-356: idle siblings parked on a needs_human gate or a stranded auto-merge are probed and repaired", async () => {
  const { transitionIssue } = await import("../repository/issues.js");
  const { createHumanAction } = await import("../repository/human-actions.js");
  const { cancelWorkItem } = await import("../repository/work-items.js");
  const { AUTO_MERGE_INTENT } = await import("./auto-merge.js");
  const { local, heads, landMergedPr } = initSiblingRepos([
    { branch: "sib-human", conflict: true },
    { branch: "sib-park", conflict: true },
  ]);
  const mergedId = await parkedMergeIn(local);
  const humanId = await idleSiblingIn(local, "sib-human", heads["sib-human"]!, 54);
  const parkId = await idleSiblingIn(local, "sib-park", heads["sib-park"]!, 55);
  for (const id of [humanId, parkId]) {
    for (const w of listWorkItemsForIssue(id)) if (w.status === "pending") cancelWorkItem(w.id);
  }
  transitionIssue(humanId, "needs_human", { currentOwner: "human", currentIntent: "waiting on a human" });
  createHumanAction({
    issueId: humanId,
    workflowInstanceId: getActiveWorkflowInstance(humanId)!.id,
    actionType: "policy_escalation",
    reason: "waiting on a human",
    question: "?",
  });
  transitionIssue(parkId, "final_review", { currentOwner: "system", currentIntent: AUTO_MERGE_INTENT });

  await mergeAndScan(mergedId, landMergedPr);

  for (const id of [humanId, parkId]) {
    assert.deepEqual(baseAdvancedEvents(id).map((e) => e.action), ["repair_queued"]);
    assert.equal(getIssue(id)!.status, "repairing");
    assert.equal(listHumanActionsForIssue(id).filter((a) => a.status === "open").length, 0);
    const pending = listWorkItemsForIssue(id).filter((i) => i.status === "pending");
    assert.equal(pending.length, 1);
    assert.ok(JSON.parse(pending[0]!.payloadJson!).conflictRepair);
  }
});

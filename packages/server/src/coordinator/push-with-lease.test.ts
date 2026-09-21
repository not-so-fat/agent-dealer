// NOT-221: a diverged `unpushed_commit` escalation offers Push with lease / Resume
// development / Close (never lease-pushing silently). Resolving push_with_lease with
// origin still at the recorded pin publishes the exact local SHA, emits branch.pushed,
// and continues at PR/checks verification via a publish-only work item without spending
// a repair round. Resolving after origin moved publishes nothing, leaves the action
// open, and surfaces the new remote tip. Behind-only and other escalations never list
// the option.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not221-"));

const { migrate, getDb } = await import("../db/index.js");
const { BUILTIN_AGENT_CLAUDE_ID, BUILTIN_AGENT_CURSOR_ID } = await import("@agent-dealer/shared");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listHumanActionsForIssue, getHumanAction } = await import("../repository/human-actions.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { claimWorkItem, getWorkItem } = await import("../repository/work-items.js");
const {
  startWorkflow,
  applyCompletion,
  responseOptionsFor,
  resolveHumanActionAndAdvance,
  resolveHumanActionAndAdvanceAsync,
} = await import("./commands.js");

function git(cwd: string, args: string[]): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8" })).trim();
}

/** A work repo pushing to a local bare origin, with deterministic user identity. */
function initWorkRepo(originDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not221-work-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["remote", "add", "origin", originDir]);
  return dir;
}

function commitFile(cwd: string, name: string, content: string): string {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", name]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function initBareOrigin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not221-origin-"));
  git(dir, ["init", "--bare", "origin.git"]);
  return path.join(dir, "origin.git");
}

interface DivergedFixture {
  workDir: string;
  originDir: string;
  branch: string;
  localSha: string;
  remoteSha: string;
}

/** Builds a genuinely diverged branch: local + remote each hold a unique commit. */
function initDiverged(branch: string): DivergedFixture {
  const originDir = initBareOrigin();
  const workDir = initWorkRepo(originDir);
  commitFile(workDir, "base.txt", "base\n");
  git(workDir, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  git(workDir, ["checkout", "-b", branch]);
  const localSha = commitFile(workDir, "local.txt", "local\n");

  const writer = initWorkRepo(originDir);
  git(writer, ["fetch", "origin", branch]);
  git(writer, ["checkout", "-b", branch, `origin/${branch}`]);
  const remoteSha = commitFile(writer, "remote.txt", "remote\n");
  git(writer, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  git(workDir, ["fetch", "origin"]);
  assert.notEqual(localSha, remoteSha);
  return { workDir, originDir, branch, localSha, remoteSha };
}

/** Pushes one more commit to origin's branch from an independent checkout. */
function advanceOrigin(fixture: DivergedFixture): string {
  const writer = initWorkRepo(fixture.originDir);
  git(writer, ["fetch", "origin", fixture.branch]);
  git(writer, ["checkout", "-b", fixture.branch, `origin/${fixture.branch}`]);
  const tip = commitFile(writer, "remote2.txt", "remote2\n");
  git(writer, ["push", "origin", `HEAD:refs/heads/${fixture.branch}`]);
  return tip;
}

function originTip(fixture: DivergedFixture): string {
  return git(fixture.workDir, ["ls-remote", "origin", `refs/heads/${fixture.branch}`]).split(/\s+/)[0]!;
}

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

function newIssue(repo: string): string {
  return createIssue({
    title: "Coordinate me",
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
}

async function escalateUnpushed(
  issueId: string,
  outcome: Parameters<typeof applyCompletion>[2]
) {
  const started = startWorkflow(issueId);
  assert.equal(started.ok, true);
  const item = claimWorkItem(`test-${issueId}`, { leaseMs: 60_000 });
  assert.ok(item && item.issueId === issueId, "expected to lease this issue's work item");
  const applied = await applyCompletion(item!.id, item!.leaseToken!, outcome);
  assert.equal(applied.applied, true);
  const action = listHumanActionsForIssue(issueId).find(
    (a) => a.actionType === "policy_escalation" && a.status === "open"
  );
  assert.ok(action, "expected open policy_escalation after unpushed_commit");
  return action!;
}

function divergedOutcome(
  fixture: DivergedFixture,
  relationship: "diverged" | "behind" = "diverged"
): Extract<Parameters<typeof applyCompletion>[2], { kind: "unpushed_commit" }> {
  return {
    kind: "unpushed_commit",
    reason: "rejected: non-fast-forward",
    recoveryCommands: ["git push --force-with-lease=..."],
    branch: fixture.branch,
    pushFacts: {
      localSha: fixture.localSha,
      remoteSha: fixture.remoteSha,
      ahead: 1,
      behind: 1,
      relationship,
      summary: "diverged",
      recoveryCommands: ["git push --force-with-lease=..."],
    },
    worktreePath: fixture.workDir,
  };
}

test("diverged unpushed lists push_with_lease/resume/close with SHAs in the question", async () => {
  const fixture = initDiverged("issue-diverged");
  const issueId = newIssue(fixture.workDir);
  const action = await escalateUnpushed(issueId, divergedOutcome(fixture));

  assert.deepEqual(JSON.parse(action.responseOptionsJson!), [
    { choice: "push_with_lease", label: "Push with lease" },
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);
  // Confirmation text names the pins: short local/remote SHAs plus ahead/behind counts.
  assert.match(action.question, new RegExp(fixture.localSha.slice(0, 12)));
  assert.match(action.question, new RegExp(fixture.remoteSha.slice(0, 12)));
  assert.match(action.question, /local 1 commit\(s\) ahead, remote 1 commit\(s\) ahead/);

  const evidence = JSON.parse(action.evidenceJson!) as Record<string, unknown>;
  assert.deepEqual(evidence["pushDivergence"], {
    branch: fixture.branch,
    localSha: fixture.localSha,
    remoteSha: fixture.remoteSha,
    ahead: 1,
    behind: 1,
    relationship: "diverged",
    worktreePath: fixture.workDir,
  });
});

test("behind-only and fact-less unpushed escalations list resume/close only", async () => {
  const fixture = initDiverged("issue-behind");
  const behindId = newIssue(fixture.workDir);
  const behind = await escalateUnpushed(behindId, divergedOutcome(fixture, "behind"));
  assert.deepEqual(JSON.parse(behind.responseOptionsJson!), [
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);
  assert.match(behind.question, /Resume development, or close the issue\?/);

  const legacyId = newIssue(fixture.workDir);
  const legacy = await escalateUnpushed(legacyId, {
    kind: "unpushed_commit",
    reason: "rejected: non-fast-forward",
  });
  assert.deepEqual(JSON.parse(legacy.responseOptionsJson!), [
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);
});

test("non-push escalations never list push_with_lease", async () => {
  const fixture = initDiverged("issue-other");
  const issueId = newIssue(fixture.workDir);
  const action = await escalateUnpushed(issueId, {
    kind: "dirty_worktree",
    reason: "uncommitted changes",
  });
  assert.deepEqual(JSON.parse(action.responseOptionsJson!), [
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);

  assert.deepEqual(responseOptionsFor("policy_escalation"), [
    { choice: "resume", label: "Resume development" },
    { choice: "close", label: "Close" },
  ]);
  assert.deepEqual(
    responseOptionsFor("policy_escalation", false, {
      pushDivergence: {
        branch: "b",
        localSha: "l",
        remoteSha: "r",
        ahead: 1,
        behind: 1,
        relationship: "behind",
      },
    }),
    [
      { choice: "resume", label: "Resume development" },
      { choice: "close", label: "Close" },
    ]
  );
});

test("push_with_lease at the recorded pin pushes, emits branch.pushed, and queues publish-only", async () => {
  const fixture = initDiverged("issue-lease-ok");
  const issueId = newIssue(fixture.workDir);
  const roundBefore = getIssue(issueId)!.currentRound;
  const action = await escalateUnpushed(issueId, divergedOutcome(fixture));

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "push_with_lease");
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  // The exact recorded local SHA landed on origin; no repair round was consumed.
  assert.equal(originTip(fixture), fixture.localSha);
  assert.equal(resolved.issueStatus, "developing");
  assert.equal(getIssue(issueId)!.status, "developing");
  assert.equal(getIssue(issueId)!.currentRound, roundBefore);

  // Publish-only continuation at the same round — PR/checks verification, no agent spawn.
  assert.ok(resolved.nextWorkItemId, "expected a queued publish-only work item");
  const next = getWorkItem(resolved.nextWorkItemId!);
  assert.equal(next!.kind, "developer");
  assert.equal(next!.round, roundBefore);
  assert.deepEqual(
    { publishOnly: JSON.parse(next!.payloadJson!).publishOnly, branch: JSON.parse(next!.payloadJson!).branch },
    { publishOnly: true, branch: fixture.branch }
  );

  const types = listWorkflowEventsForIssue(issueId).map((e) => e.type);
  assert.ok(types.includes("branch.pushed"), "expected a branch.pushed event");
  assert.ok(types.includes("human_action.resolved"), "expected a human_action.resolved event");
  assert.equal(getHumanAction(action.id)!.status, "resolved");
  assert.equal(
    listHumanActionsForIssue(issueId).filter((a) => a.status === "open").length,
    0
  );
});

test("push_with_lease after origin moved leaves the action open with the new tip", async () => {
  const fixture = initDiverged("issue-lease-stale");
  const issueId = newIssue(fixture.workDir);
  const action = await escalateUnpushed(issueId, divergedOutcome(fixture));

  const newTip = advanceOrigin(fixture);
  assert.notEqual(newTip, fixture.remoteSha);

  const resolved = await resolveHumanActionAndAdvanceAsync(action.id, "op", "push_with_lease");
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.code, 409);
  assert.match(resolved.error, new RegExp(newTip));

  // Nothing was published: origin still carries the newer tip, not our local SHA.
  assert.equal(originTip(fixture), newTip);

  // The action stays open and now shows the fresh tip; the original pin is untouched.
  const reopened = getHumanAction(action.id)!;
  assert.equal(reopened.status, "open");
  assert.match(reopened.reason, new RegExp(newTip));
  const evidence = JSON.parse(reopened.evidenceJson!)["pushDivergence"] as Record<string, unknown>;
  assert.equal(evidence["remoteSha"], fixture.remoteSha);
  assert.equal(evidence["observedRemoteSha"], newTip);
  assert.equal(getIssue(issueId)!.status, "needs_human");
});

test("push_with_lease is rejected on non-diverged actions and via the sync resolver", async () => {
  const fixture = initDiverged("issue-lease-reject");
  const behindId = newIssue(fixture.workDir);
  const behind = await escalateUnpushed(behindId, divergedOutcome(fixture, "behind"));
  const behindResolved = await resolveHumanActionAndAdvanceAsync(behind.id, "op", "push_with_lease");
  assert.equal(behindResolved.ok, false);
  if (!behindResolved.ok) assert.equal(behindResolved.code, 400);
  assert.equal(getHumanAction(behind.id)!.status, "open");

  const divergedId = newIssue(fixture.workDir);
  const diverged = await escalateUnpushed(divergedId, divergedOutcome(fixture));
  const sync = resolveHumanActionAndAdvance(diverged.id, "op", "push_with_lease");
  assert.equal(sync.ok, false);
  if (!sync.ok) assert.equal(sync.code, 409);
  assert.equal(getHumanAction(diverged.id)!.status, "open");
});

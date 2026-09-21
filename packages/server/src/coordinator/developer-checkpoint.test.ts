// packages/server/src/coordinator/developer-checkpoint.test.ts
//
// NOT-172: checkpoint/reuse evidence through the real developer effect —
// salvage vs normal commits, verification receipts, pushes, reused vs cold
// retries, and coordinator-only publish recovery with zero agent waste.
//
// Real git (temp repo + bare "origin"), faked agent spawn and GitHub, driven
// end to end through the coordinator (startWorkflow → tick), with waste/retry
// derivation over the recorded rows.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-home-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.HEAD_RECONCILE_TIMEOUT_MS = "60";
process.env.HEAD_RECONCILE_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { createWorkerSession, startSession, listWorkerSessionsForIssue } = await import(
  "../repository/worker-sessions.js"
);
const { listWorkItemsForIssue, claimWorkItem, bindWorkItemSession } = await import(
  "../repository/work-items.js"
);
const { listUsageEventsForIssue } = await import("../repository/usage-events.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { realDeveloperSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
const { recoverCoordinator } = await import("./recovery.js");
const {
  deriveAttemptWaste,
  deriveFirstCheckpoint,
  deriveRetrySummary,
  listAgentBoundariesForIssue,
  listCheckpointsForIssue,
  listPublishOnlySessionsForIssue,
  listReuseForIssue,
} = await import("./attempt-waste.js");
type SpawnFn = typeof realDeveloperSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM review_publications; DELETE FROM work_items");
  resetEffectHandlers();
});
after(() => resetEffectHandlers());

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";
const okDeckCallTool = async (_name: string, _args: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ id: TEST_DECK_ID, name: "test-deck" }) }],
});

async function makeIssue(): Promise<string> {
  const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", deckId: TEST_DECK_ID });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", deckId: TEST_DECK_ID });
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: 3,
    source: "manual",
  }).id;
}

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

function fakeGithub(opts: { checks?: "success" | "failure" } = {}): GithubFn {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  let nextNumber = 100;
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  return {
    async viewPr({ branch, number }) {
      if (!branch) throw new Error("viewPr requires an explicit branch (NOT-82)");
      const pr = prs.get(branch);
      if (!pr) return null;
      if (number != null && number !== pr.number) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
    },
    async createDraftPr({ base, head }) {
      if (!head) throw new Error("createDraftPr requires an explicit --head (NOT-82)");
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(head, { number, url, base });
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return opts.checks ?? "success";
    },
    async publishReview() {
      throw new Error("publishReview is unused by the developer effect");
    },
  };
}

/** A spawn log carrying provider usage — the tokens/cost the attempt burned. */
function usageLog(tokensIn: number, tokensOut: number, costUsd: number | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-log-"));
  const logPath = path.join(dir, "session.ndjson");
  const result: Record<string, unknown> = { type: "result", usage: { input_tokens: tokensIn, output_tokens: tokensOut } };
  if (costUsd !== null) result.total_cost_usd = costUsd;
  fs.writeFileSync(logPath, `${JSON.stringify(result)}\n`);
  return logPath;
}

/** Claude-shaped green suite feeding the verification-receipt miner. */
function verificationLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-checkpoint-log-"));
  const logPath = path.join(dir, "session.ndjson");
  fs.writeFileSync(
    logPath,
    [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run test:unit" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "711/711 tests passed\n" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
  return logPath;
}

function commitFile(cwd: string, file: string, message = "implement"): void {
  fs.writeFileSync(path.join(cwd, file), "implemented\n");
  git(cwd, "add", ".");
  git(cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", message);
}

function checkpointPayloads(issueId: string, kind: string): Record<string, unknown>[] {
  return listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "checkpoint.observed")
    .map((e) => JSON.parse(e.payloadJson!) as Record<string, unknown>)
    .filter((p) => p.kind === kind);
}

function reusePayloads(issueId: string): Record<string, unknown>[] {
  return listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "retry.reused")
    .map((e) => JSON.parse(e.payloadJson!) as Record<string, unknown>);
}

// A failed session followed by a successful retry reports the first attempt's
// runtime/tokens as waste and identifies the reused commit.
test("NOT-172: failed attempt waste + commit reuse on the retry", async () => {
  const issueId = await makeIssue();
  let call = 0;
  const flakySpawn: SpawnFn = async (input) => {
    call++;
    commitFile(input.cwd, `feature-${call}.txt`);
    if (call === 1) {
      return { exitCode: 1, transcript: "boom", logPath: usageLog(100, 50, 0.42), timedOut: false };
    }
    return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: usageLog(200, 60, 0.5), timedOut: false };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: flakySpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "developing", "the crash retries on the infra budget");
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing", "the retry completes the handoff");

  const dev = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  assert.equal(dev.length, 2);
  assert.equal(dev[0]!.status, "failed");
  assert.equal(dev[1]!.status, "done");

  // The retry reuses the prior attempt's commit (branch left behind, tip ahead).
  const reuse = reusePayloads(issueId);
  assert.equal(reuse.length, 1, "exactly one reuse record, on the retry");
  assert.deepEqual(reuse[0]!.kinds, ["commit"]);

  // Waste derivation: the first attempt's runtime/tokens count, the later
  // success does not erase them.
  const usages = listUsageEventsForIssue(issueId).map((u) => ({
    workerSessionId: u.workerSessionId,
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    costUsd: u.costUsd,
    durationMs: u.durationMs,
  }));
  const waste = deriveAttemptWaste({
    sessions: dev.map((s) => ({ id: s.id, role: s.role, status: s.status, errorJson: s.errorJson, createdAt: s.createdAt })),
    usages,
    agentBoundaries: listAgentBoundariesForIssue(issueId),
    publishOnlySessionIds: listPublishOnlySessionsForIssue(issueId),
  });
  assert.equal(waste.failedAttempts, 1);
  assert.equal(waste.tokensIn.value, 100);
  assert.equal(waste.tokensOut.value, 50);
  assert.equal(waste.costUsd.value, 0.42);
  assert.ok((waste.runtimeMs.value ?? 0) >= 0);
  assert.equal(waste.runtimeMs.known, 1);

  const summary = deriveRetrySummary({
    sessions: dev.map((s) => ({ id: s.id, role: s.role, status: s.status, errorJson: s.errorJson, createdAt: s.createdAt })),
    reuse: listReuseForIssue(issueId),
  });
  assert.equal(summary.retries, 1);
  assert.equal(summary.reused, 1);
  assert.equal(summary.cold, 0);

  // First checkpoint: the failed attempt already left a commit behind.
  const first = deriveFirstCheckpoint({
    workflowStartedAt: listWorkflowEventsForIssue(issueId).find((e) => e.type === "workflow.started")?.ts ?? null,
    checkpoints: listCheckpointsForIssue(issueId),
  });
  assert.equal(first.quality, "exact");
  assert.ok((first.msSinceWorkflowStart ?? -1) >= 0);
});

// Salvage commits and normal commits carry distinct durable evidence.
test("NOT-172: salvage tip records a salvage-origin commit checkpoint", async () => {
  const issueId = await makeIssue();
  const crashingDirtySpawn: SpawnFn = async (input) => {
    fs.writeFileSync(path.join(input.cwd, "half-done.txt"), "oops\n");
    return { exitCode: 1, transcript: "boom", logPath: "/dev/null", timedOut: false };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: crashingDirtySpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const branch = `issue-${issueId}`;
  const tip = git(repo, "rev-parse", branch);
  const commits = checkpointPayloads(issueId, "commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]!.origin, "salvage");
  assert.equal(commits[0]!.observedSha, tip, "the checkpoint vouches for the salvaged tip");
});

// A clean handoff records commit, verification receipt, and push checkpoints.
test("NOT-172: clean handoff records commit, receipt, and branch-pushed checkpoints", async () => {
  const issueId = await makeIssue();
  const logPath = verificationLog();
  const greenSpawn: SpawnFn = async (input) => {
    commitFile(input.cwd, "feature.txt");
    return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath, timedOut: false };
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: greenSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.ok(issue.headSha);

  const commits = checkpointPayloads(issueId, "commit");
  assert.equal(commits.length, 1, "first commit detected once");
  assert.equal(commits[0]!.observedSha, issue.headSha);

  const receipts = checkpointPayloads(issueId, "verification_receipt");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.observedSha, issue.headSha);

  const pushes = checkpointPayloads(issueId, "branch_pushed");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.observedSha, issue.headSha);
  assert.equal(pushes[0]!.branch, `issue-${issueId}`);

  // The sampling/read model is read-only: no stray files, no extra commits.
  assert.equal(git(repo, "rev-parse", `issue-${issueId}`), issue.headSha);
});

// A retry with nothing to reuse is an explicit cold retry.
test("NOT-172: an empty retry records cold, not reused", async () => {
  const issueId = await makeIssue();
  const noopSpawn: SpawnFn = async () => ({ exitCode: 0, transcript: "", logPath: "/dev/null", timedOut: false });
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: noopSpawn, github: fakeGithub() })
  );
  startWorkflow(issueId);
  await pump(1);
  await pump(1);

  const dev = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  assert.equal(dev.length, 2);
  const reuse = reusePayloads(issueId);
  assert.equal(reuse.length, 1);
  assert.deepEqual(reuse[0]!.kinds, [], "no worktree, commit, or receipt to reuse");
  const summary = deriveRetrySummary({
    sessions: dev.map((s) => ({ id: s.id, role: s.role, status: s.status, errorJson: s.errorJson, createdAt: s.createdAt })),
    reuse: listReuseForIssue(issueId),
  });
  assert.equal(summary.cold, 1);
  assert.equal(summary.reused, 0);
  assert.equal(listCheckpointsForIssue(issueId).length, 0, "nothing durable happened");
});

// A coordinator-only republish records retry/reuse with zero agent-process waste.
test("NOT-172: publish-only recovery reuses without spawning and wastes no agent runtime", async () => {
  const issueId = await makeIssue();
  const branch = `issue-${issueId}`;
  startWorkflow(issueId);
  const item = listWorkItemsForIssue(issueId).find((i) => i.kind === "developer")!;
  const claimed = claimWorkItem("crashed-attempt", { leaseMs: 60_000 })!;
  const victim = createWorkerSession({ issueId, role: "developer", round: 1, agentId: getIssue(issueId)!.developerAgentId, runtime: "claude_code" });
  startSession(victim.id);
  assert.equal(bindWorkItemSession(item.id, victim.id, claimed.leaseToken!), true);

  // The dead attempt committed, then died before the coordinator could push.
  const wt = path.join(os.tmpdir(), `dealer-checkpoint-wt-${Math.random().toString(36).slice(2)}`);
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "main");
  commitFile(wt, "card-delete.ts");
  const sha = git(wt, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", wt);

  const res = await recoverCoordinator({ now: Date.now() + 3_600_000 });
  assert.deepEqual(res.republished, [item.id]);

  const forbiddenSpawn: SpawnFn = async () => {
    throw new Error("a republish must never spawn an agent session");
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { spawn: forbiddenSpawn, github: fakeGithub(), deckCallTool: okDeckCallTool })
  );
  await pump(1);
  assert.equal(getIssue(issueId)!.status, "reviewing");

  const dev = listWorkerSessionsForIssue(issueId).filter((s) => s.role === "developer");
  assert.equal(dev.length, 2);
  const publishSession = dev[1]!;
  const reuse = reusePayloads(issueId);
  assert.equal(reuse.length, 1);
  assert.deepEqual(reuse[0]!.kinds, ["publish_only"]);

  // Zero agent-process waste by structure: no spawn, no usage row, no agent interval.
  assert.equal(
    listUsageEventsForIssue(issueId).filter((u) => u.workerSessionId === publishSession.id).length,
    0
  );
  assert.deepEqual(
    listWorkflowEventsForIssue(issueId)
      .filter((e) => e.workerSessionId === publishSession.id)
      .map((e) => e.type)
      .filter((t) => t === "agent.started" || t === "agent.completed"),
    []
  );
  const pushes = checkpointPayloads(issueId, "branch_pushed");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.observedSha, sha);

  const waste = deriveAttemptWaste({
    sessions: dev.map((s) => ({ id: s.id, role: s.role, status: s.status, errorJson: s.errorJson, createdAt: s.createdAt })),
    usages: listUsageEventsForIssue(issueId).map((u) => ({
      workerSessionId: u.workerSessionId,
      tokensIn: u.tokensIn,
      tokensOut: u.tokensOut,
      costUsd: u.costUsd,
      durationMs: u.durationMs,
    })),
    agentBoundaries: listAgentBoundariesForIssue(issueId),
    publishOnlySessionIds: listPublishOnlySessionsForIssue(issueId),
  });
  assert.equal(waste.publishOnlyAttempts, 0, "the publish succeeded — nothing failed");
  const summary = deriveRetrySummary({
    sessions: dev.map((s) => ({ id: s.id, role: s.role, status: s.status, errorJson: s.errorJson, createdAt: s.createdAt })),
    reuse: listReuseForIssue(issueId),
  });
  assert.equal(summary.publishOnly, 1);
});

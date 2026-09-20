// packages/server/src/coordinator/muse-developer.integration.test.ts
//
// NOT-181 acceptance: a `muse_code` developer profile goes through the real coordinator
// (startWorkflow → tick → routing) and the real developer effect — real git worktree, real push,
// real spawn of a *fake Muse process* (fixtures/fake-muse.mjs), fake GitHub. No paid service is
// ever called. Scenarios are picked with FAKE_MUSE_SCENARIO; the invocation is recorded to a file.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-home-"));
process.env.AGENT_DEALER_SKIP_AGENT_HEALTH = "1";
process.env.MAX_COORDINATOR_CONCURRENCY = "1";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.HEAD_RECONCILE_TIMEOUT_MS = "60";
process.env.HEAD_RECONCILE_INTERVAL_MS = "10";
process.env.USAGE_CAP_FALLBACK_COOLDOWN_MS = "60000";
const FAKE_MUSE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-muse.mjs");
process.env.MUSE_CLI = FAKE_MUSE;
const RECORD = path.join(process.env.AGENT_DEALER_HOME, "muse-invocation.json");
process.env.FAKE_MUSE_RECORD = RECORD;

const { migrate, getDb } = await import("../db/index.js");
const { MUSE_CODE_CONTRIBUTOR_MODEL, parseProfileSnapshot } = await import("@agent-dealer/shared");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { listWorkerSessionsForIssue } = await import("../repository/worker-sessions.js");
const { listWorkItemsForIssue } = await import("../repository/work-items.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { listHumanActionsForIssue } = await import("../repository/human-actions.js");
const { listUsageEventsForIssue } = await import("../repository/usage-events.js");
const { listWorkflowEventsForIssue } = await import("../repository/workflow-events.js");
const { runtimeAvailability } = await import("../repository/runtime-availability.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { realDeveloperSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
const { runMuseDeveloperSession, MUSE_ATTEMPT_ROOT } = await import("./muse-spawn.js");
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items; DELETE FROM runtime_availability");
  fs.rmSync(RECORD, { force: true });
  delete process.env.FAKE_MUSE_SCENARIO;
});
after(() => {
  resetEffectHandlers();
  delete process.env.DEVELOPER_TIMEOUT_MS;
});

const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";
let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

function makeMuseIssue(opts: { maxInfraAttempts?: number } = {}): string {
  // The Agents form still asks for a deck; Muse must ignore it (no MCP, no deck).
  const dev = createAgent({ name: `muse-${Math.random()}`, runtime: "muse_code", deckId: TEST_DECK_ID });
  const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "codex_local", deckId: TEST_DECK_ID });
  return createIssue({
    title: "Add widget",
    description: "Build the widget.",
    acceptanceCriteria: "Widget renders.",
    repo,
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 3,
    maxInfraAttempts: opts.maxInfraAttempts ?? 3,
    source: "manual",
  }).id;
}

/** Same in-memory GitHub as developer-effect.test.ts: real git tells it the head SHA. */
function fakeGithub(): GithubFn {
  const prs = new Map<string, { number: number; url: string; base: string }>();
  let next = 200;
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  return {
    async viewPr({ branch, number }) {
      if (!branch) throw new Error("explicit branch required");
      const pr = prs.get(branch);
      if (!pr || (number != null && number !== pr.number)) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
    },
    async createDraftPr({ base, head }) {
      const number = next++;
      const url = `https://github.com/o/r/pull/${number}`;
      prs.set(head!, { number, url, base });
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview() {
      throw new Error("unused");
    },
  };
}

/** A deck call would mean a Muse worker got Agent Deck — it must never happen. */
const forbiddenDeckCallTool = async () => {
  throw new Error("Agent Deck must not be called for a Muse Code worker");
};

function registerMuseDeveloper(): void {
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: forbiddenDeckCallTool, spawn: realDeveloperSpawn, github: fakeGithub() })
  );
}

async function pump(max = 1): Promise<void> {
  for (let i = 0; i < max; i++) {
    await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
  }
}

function recorded(): {
  argv: string[];
  cwd: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  noAutoUpdate: string;
  settings: string;
  authLinked: boolean;
  porcelain: string;
} {
  return JSON.parse(fs.readFileSync(RECORD, "utf8"));
}

test("fake-Muse developer session goes admission → verified branch → draft PR, with a frozen muse_code snapshot", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success";
  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "reviewing");
  assert.equal(issue.branch, `issue-${issueId}`);
  assert.ok(issue.prNumber);
  assert.ok(git(repo, "ls-remote", "origin", `refs/heads/${issue.branch}`).length > 0);
  assert.equal(git(remote, "show", `${issue.branch}:feature.txt`), "implemented");
  // The per-attempt config dir was excluded from `git add .` and never reached the pushed tree.
  assert.equal(git(remote, "ls-tree", "-r", "--name-only", issue.branch!).includes(MUSE_ATTEMPT_ROOT), false);

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "done");
  assert.equal(dev.runtime, "muse_code");
  const snapshot = parseProfileSnapshot(dev.profileSnapshotJson)!;
  assert.equal(snapshot.runtime, "muse_code");
  assert.equal(snapshot.model, MUSE_CODE_CONTRIBUTOR_MODEL);

  const conclusion = listArtifactsForIssue(issueId).find((a) => a.kind === "implementation_conclusion")!;
  assert.match(String((JSON.parse(conclusion.contentJson!) as { text: string }).text), /added the widget/);
});

test("the spawn is the pinned developer posture with per-attempt config under the worktree and no MCP or deck", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success";
  startWorkflow(issueId);
  await pump();

  const rec = recorded();
  assert.equal(rec.argv[0], "exec");
  for (const expected of ["--json", "--no-foreign-personal-context", "--disable-web-tools"]) {
    assert.ok(rec.argv.includes(expected), expected);
  }
  assert.equal(rec.argv[rec.argv.indexOf("--model") + 1], MUSE_CODE_CONTRIBUTOR_MODEL);
  assert.equal(rec.argv[rec.argv.indexOf("--approval-mode") + 1], "never");
  assert.equal(rec.argv[rec.argv.indexOf("--sandbox-network") + 1], "restricted");
  assert.equal(rec.argv[rec.argv.indexOf("--max-model-steps") + 1], "300");
  for (const forbidden of ["--yolo", "--disable-sandbox", "--trust-workspace", "--mcp-config", "--agents"]) {
    assert.ok(!rec.argv.includes(forbidden), forbidden);
  }
  assert.equal(rec.noAutoUpdate, "1");
  // Config and data live under the worktree the session runs in.
  assert.ok(rec.xdgConfigHome.startsWith(path.join(rec.cwd, MUSE_ATTEMPT_ROOT)), rec.xdgConfigHome);
  assert.ok(rec.xdgDataHome.startsWith(path.join(rec.cwd, MUSE_ATTEMPT_ROOT)), rec.xdgDataHome);
  const settings = JSON.parse(rec.settings) as Record<string, unknown>;
  assert.equal("mcpServers" in settings, false, "no MCP servers");
  assert.deepEqual(settings.run, { workflow_trigger_mode: "off", subagent_delegation_mode: "off" });
  // The config dir is invisible to git, so the worktree was porcelain-clean at spawn time.
  assert.equal(rec.porcelain, "");
});

test("usage events record muse_code, the confirmed model, duration and tokens; cost stays null", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success";
  startWorkflow(issueId);
  await pump();

  const [usage] = listUsageEventsForIssue(issueId);
  assert.equal(usage!.runtime, "muse_code");
  assert.equal(usage!.model, MUSE_CODE_CONTRIBUTOR_MODEL);
  assert.ok(usage!.durationMs! > 0);
  assert.equal(usage!.tokensIn, 1000);
  assert.equal(usage!.tokensOut, 200);
  assert.equal(usage!.costUsd, null);
});

test("tokens are null (not zero) when Muse reports no usage", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success-no-usage";
  startWorkflow(issueId);
  await pump();

  assert.equal(getIssue(issueId)!.status, "reviewing");
  const [usage] = listUsageEventsForIssue(issueId);
  assert.equal(usage!.runtime, "muse_code");
  assert.equal(usage!.model, MUSE_CODE_CONTRIBUTOR_MODEL);
  assert.equal(usage!.tokensIn, null);
  assert.equal(usage!.tokensOut, null);
  assert.equal(usage!.costUsd, null);
});

test("auth failure takes the infra-retry path without spending a review round", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "auth";
  startWorkflow(issueId);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.status, "developing");
  assert.equal(issue.currentRound, 1, "no review round spent");
  assert.equal(issue.infraAttempts, 1, "one infra attempt spent");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");
  assert.match(dev.errorJson ?? "", /Muse Code auth required/);
  const retry = listWorkItemsForIssue(issueId).find((w) => w.status === "pending");
  assert.ok(retry, "a fresh developer attempt is queued");
  assert.equal(listUsageEventsForIssue(issueId).length, 1, "the failed spawn still records usage");
});

test("a usage cap defers the work item and records Muse availability, spending no attempt", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "usage-cap";
  startWorkflow(issueId);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.infraAttempts, 0);
  assert.equal(issue.currentRound, 1);
  const item = listWorkItemsForIssue(issueId)[0]!;
  assert.equal(item.status, "pending");
  assert.ok(Date.parse(item.availableAt) > Date.now());
  assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "worker.deferred"));
  const availability = runtimeAvailability("muse_code");
  assert.equal(availability.available, false, "muse_code is marked unavailable");
  assert.match(availability.available ? "" : availability.reason, /muse_code usage capped/);
});

test("a timeout follows the existing timeout path (infra retry, no review round)", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "hang";
  process.env.DEVELOPER_TIMEOUT_MS = "600";
  try {
    startWorkflow(issueId);
    await pump();
  } finally {
    delete process.env.DEVELOPER_TIMEOUT_MS;
  }

  const issue = getIssue(issueId)!;
  assert.equal(issue.currentRound, 1);
  assert.equal(issue.infraAttempts, 1);
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "timed_out");
});

test("a run whose server-confirmed model differs is a failed session, not a handoff", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "wrong-model";
  startWorkflow(issueId);
  await pump();

  const issue = getIssue(issueId)!;
  assert.equal(issue.currentRound, 1);
  assert.equal(issue.infraAttempts, 1);
  assert.notEqual(issue.status, "reviewing");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");
  assert.equal(listUsageEventsForIssue(issueId)[0]!.model, "some-other-model", "the model that ran is recorded");
});

for (const [scenario, tool] of [
  ["cron", "cron_create"],
  ["cron-list", "cron_list"],
] as const) {
  test(`a session that called ${tool} fails as muse_cron_used and escalates to the operator`, async () => {
    const issueId = makeMuseIssue();
    registerMuseDeveloper();
    process.env.FAKE_MUSE_SCENARIO = scenario;
    startWorkflow(issueId);
    await pump();

    const issue = getIssue(issueId)!;
    assert.equal(issue.status, "needs_human");
    assert.equal(issue.infraAttempts, 0, "no retry: the same model would get the same tool");
    assert.equal(issue.branch, null, "nothing was pushed or handed off");
    assert.equal(git(repo, "ls-remote", "origin", `refs/heads/issue-${issueId}`), "");

    const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
    assert.equal(dev.status, "failed");
    assert.match(dev.errorJson ?? "", /muse_cron_used/);
    const action = listHumanActionsForIssue(issueId).find((a) => a.status === "open");
    assert.equal(action?.actionType, "policy_escalation");
    assert.match(action?.reason ?? JSON.stringify(action), /muse_cron_used/);
    assert.ok(listWorkflowEventsForIssue(issueId).some((e) => e.type === "worker.failed"));
    // The worktree is kept for inspection, without the per-attempt Muse config.
    assert.equal(fs.existsSync(path.join(dev.worktreePath!, MUSE_ATTEMPT_ROOT)), false);
    assert.equal(listUsageEventsForIssue(issueId).length, 1, "the spend is still recorded");
  });
}

// ── per-attempt config cleanup, on the spawn itself ────────────────────────────────────────────

function scratchWorktree(): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-wt-"));
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "T");
  fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "init");
  return wt;
}

for (const scenario of ["success", "auth", "usage-cap", "cron"]) {
  test(`per-attempt Muse config is removed after a ${scenario} session`, async () => {
    const wt = scratchWorktree();
    try {
      process.env.FAKE_MUSE_SCENARIO = scenario;
      const result = await runMuseDeveloperSession({
        sessionId: "00000000-0000-4000-8000-000000000001",
        runtime: "muse_code",
        policy: { worktreeWrite: true } as never,
        model: MUSE_CODE_CONTRIBUTOR_MODEL,
        prompt: "Implement it",
        cwd: wt,
        timeoutMs: 20_000,
        logPath: path.join(wt, "..", `muse-log-${scenario}-${Date.now()}.ndjson`),
      });
      const rec = recorded();
      assert.ok(rec.xdgConfigHome.startsWith(path.join(wt, MUSE_ATTEMPT_ROOT)), "config was written under the worktree");
      assert.equal(fs.existsSync(path.join(wt, MUSE_ATTEMPT_ROOT)), false);
      assert.equal(fs.existsSync(rec.xdgConfigHome), false);
      assert.equal(fs.existsSync(rec.xdgDataHome), false);
      assert.ok(result.muse);
      fs.rmSync(result.logPath, { force: true });
      if (result.muse.rawLogPath) fs.rmSync(result.muse.rawLogPath, { force: true });
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
}

test("per-attempt Muse config is removed when the process cannot be started", async () => {
  const wt = scratchWorktree();
  const prev = process.env.MUSE_CLI;
  process.env.MUSE_CLI = path.join(wt, "no-such-muse");
  try {
    await assert.rejects(
      runMuseDeveloperSession({
        sessionId: "00000000-0000-4000-8000-000000000002",
        runtime: "muse_code",
        policy: { worktreeWrite: true } as never,
        model: MUSE_CODE_CONTRIBUTOR_MODEL,
        prompt: "Implement it",
        cwd: wt,
        timeoutMs: 5_000,
        logPath: path.join(wt, "..", `muse-log-enoent-${Date.now()}.ndjson`),
      })
    );
    assert.equal(fs.existsSync(path.join(wt, MUSE_ATTEMPT_ROOT)), false);
  } finally {
    process.env.MUSE_CLI = prev;
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

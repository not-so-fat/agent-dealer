// Eval-owned check for muse-06 (NOT-176), copied into packages/server/src/coordinator/ at verification time.
// Not part of the worker's held-out tests: it covers the surface those tests do not, that
// developer-effect.ts and reviewer-effect.ts forward the frozen snapshot effort into the spawn input.
// It is behavioral: a real coordinator run over a temp git repo with fake spawn/GitHub, then the
// captured spawn input is asserted. A profile edit after queueing must not change the forwarded value.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-evalfx-home-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.HEAD_RECONCILE_TIMEOUT_MS = "60";
process.env.HEAD_RECONCILE_INTERVAL_MS = "10";
process.env.REVIEWER_TIMEOUT_MS = "5000";
process.env.REVIEWER_PUBLISH_WAIT_ATTEMPTS = "3";
process.env.REVIEWER_PUBLISH_WAIT_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent, updateAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { runReviewerEffect } = await import("./reviewer-effect.js");
const { realDeveloperSpawn, realReviewerSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
type DevSpawn = typeof realDeveloperSpawn;
type RevSpawn = typeof realReviewerSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
after(() => resetEffectHandlers());

let repo: string;
let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-evalfx-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-evalfx-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

async function pump(max = 20): Promise<void> {
  for (let i = 0; i < max; i++) {
    const started = await runCoordinatorTick({ leaseOwner: "pump" });
    await drainCoordinator();
    if (started === 0) return;
  }
}

function fakeGithub(): GithubFn {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 100;
  const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const adapter = {
    async viewPr({ cwd, branch, number }: { cwd: string; branch?: string; number?: number }) {
      const b = branch ?? (number != null ? branchByNumber.get(number) : currentBranch(cwd));
      const pr = b ? prsByBranch.get(b) : undefined;
      if (!b || !pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: b, headRefOid: remoteHead(b), isDraft: true };
    },
    async createDraftPr({ cwd, base, head }: { cwd: string; base: string; head?: string }) {
      const b = head ?? currentBranch(cwd);
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prsByBranch.set(b, { number, url, base });
      branchByNumber.set(number, b);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview({ event }: { event: string }) {
      return { ok: true, event, usedCommentFallback: false };
    },
  };
  return adapter as unknown as GithubFn;
}

test("developer and reviewer effects forward the frozen snapshot effort, not a later profile value", async () => {
  const dev = createAgent({ name: "evalfx-dev", runtime: "claude_code", workspaceRoot: repo, defaultEffort: "high" });
  const rev = createAgent({ name: "evalfx-rev", runtime: "claude_code", workspaceRoot: repo, defaultEffort: "low" });
  const issueId = createIssue({
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

  const seen: { developer: unknown[]; reviewer: unknown[] } = { developer: [], reviewer: [] };
  const developerSpawn: DevSpawn = async (input) => {
    seen.developer.push((input as { effort?: unknown }).effort);
    fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
    git(input.cwd, "add", ".");
    git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
    return { exitCode: 0, transcript: "Implementation conclusion: done.", logPath: "/dev/null", timedOut: false };
  };
  const reviewerSpawn: RevSpawn = async (input) => {
    seen.reviewer.push((input as { effort?: unknown }).effort);
    const baseSha = input.prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
    const headSha = input.prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
    const body = {
      verdict: "approved",
      baseSha,
      headSha,
      acceptanceCriteriaAssessment: "ok",
      evidenceAssessment: "ok",
      findings: [],
      risks: [],
    };
    return { exitCode: 0, transcript: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`, logPath: "/dev/null", timedOut: false };
  };

  const github = fakeGithub();
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx, { spawn: developerSpawn, github }));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx, { spawn: reviewerSpawn, github }));
  startWorkflow(issueId);
  // The developer item is queued now, so a later profile edit must not reach its session. (The reviewer
  // item is queued only after the developer finishes, which is when its snapshot is frozen.)
  updateAgent(dev.id, { defaultEffort: "medium" });
  await pump(1);
  updateAgent(rev.id, { defaultEffort: "medium" });
  await pump(1);

  assert.equal(getIssue(issueId)!.status, "final_review", "developer then reviewer both ran");
  assert.deepEqual(seen.developer, ["high"], "developer spawn received the frozen effort");
  assert.deepEqual(seen.reviewer, ["low"], "reviewer spawn received the frozen effort");
  getDb().exec("DELETE FROM review_publications; DELETE FROM work_items;");
});

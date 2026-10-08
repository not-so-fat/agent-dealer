// packages/server/src/coordinator/visual-qa-collection.test.ts
//
// NOT-381: coordinator-side visual-QA collection — artifact persistence, safe
// screenshot storage, transient-dir removal, rejection evidence, and the
// developer-to-reviewer handoff of the validated receipt.
//
// Direct `collectDeveloperVisualQa` tests use synthetic issue/session ids (the
// artifacts table carries no FKs); the closing integration test drives a real
// git repository + bare remote end to end through the coordinator.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-home-"));
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.REVIEWER_TIMEOUT_MS = "5000";
process.env.REVIEWER_PUBLISH_WAIT_ATTEMPTS = "3";
process.env.REVIEWER_PUBLISH_WAIT_INTERVAL_MS = "10";

const { migrate, getDb } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { createIssue, getIssue } = await import("../repository/issues.js");
const { createWorkerSession } = await import("../repository/worker-sessions.js");
const { listArtifactsForIssue } = await import("../repository/artifacts-for-issue.js");
const { latestIssueArtifact } = await import("../repository/artifacts.js");
const { startWorkflow } = await import("./commands.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./effect-registry.js");
const { runCoordinatorTick, drainCoordinator } = await import("./worker-loop.js");
const { runDeveloperEffect } = await import("./developer-effect.js");
const { runReviewerEffect } = await import("./reviewer-effect.js");
const { realDeveloperSpawn, realReviewerSpawn } = await import("./spawn.js");
const { realGithubAdapter } = await import("../adapters/github.js");
const {
  VISUAL_QA_DIR_NAME,
  VISUAL_QA_RECEIPT_KIND,
  VISUAL_QA_REJECTED_KIND,
  collectDeveloperVisualQa,
  readLatestVisualQa,
} = await import("./visual-qa.js");
type SpawnFn = typeof realDeveloperSpawn;
type ReviewerSpawnFn = typeof realReviewerSpawn;
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
beforeEach(() => getDb().exec("DELETE FROM review_publications; DELETE FROM work_items"));
after(() => resetEffectHandlers());

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";

function writeWorktree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-wt-"));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return dir;
}

function verifiedConclusion(head: string): string {
  return [
    `Implemented the widget.`,
    ``,
    `Visual QA: verified`,
    `head: ${head}`,
    `app: real (no mocks)`,
    `scenario: /widgets/new — fill the form and submit`,
    `viewports: 1440x900, 390x800`,
    `commands: npm run dev; capture via chromium headless screenshot`,
    `screenshots: ${VISUAL_QA_DIR_NAME}/desktop-1440x900.png, ${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
    ``,
  ].join("\n");
}

// Artifacts FK-reference issues + worker_sessions, so direct collection tests
// build real rows (synthetic UUIDs violate the constraint).
function freshIds(): { issueId: string; sessionId: string } {
  const dev = createAgent({ name: `dev-${randomUUID()}`, runtime: "claude_code", deckId: TEST_DECK_ID });
  const rev = createAgent({ name: `rev-${randomUUID()}`, runtime: "claude_code", deckId: TEST_DECK_ID });
  const issueId = createIssue({
    title: "t",
    description: "d",
    acceptanceCriteria: "a",
    repo: "github.com/acme/app",
    baseBranch: "main",
    developerAgentId: dev.id,
    reviewerAgentId: rev.id,
    maxReviewRounds: 1,
    maxInfraAttempts: 1,
    source: "manual",
  }).id;
  const sessionId = createWorkerSession({
    issueId,
    role: "developer",
    round: 1,
    agentId: dev.id,
    runtime: "claude_code",
  }).id;
  return { issueId, sessionId };
}

function receiptContent(issueId: string) {
  const art = latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND);
  assert.ok(art?.contentJson, "expected a visual_qa_receipt artifact");
  return JSON.parse(art.contentJson!) as {
    status: string;
    headSha: string | null;
    screenshots: Array<{ fileName: string; blobPath: string; sizeBytes: number; sha256: string }>;
    capability: string | null;
  };
}

function rejectedContent(issueId: string) {
  const art = latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND);
  assert.ok(art?.contentJson, "expected a visual_qa_rejected artifact");
  return JSON.parse(art.contentJson!) as { status: string | null; reason: string; expectedHeadSha: string };
}

// Direct collection: acceptance.

test("NOT-381: verified receipt copies screenshots to issue storage, persists blob refs, removes the worktree dir", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "desktop-bytes",
    [`${VISUAL_QA_DIR_NAME}/mobile-390x800.png`]: "mobile-bytes",
    "feature.txt": "implemented",
  });
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: verifiedConclusion(HEAD_A),
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "receipt");
    assert.equal((result as { status: string }).status, "verified");

    const content = receiptContent(issueId);
    assert.equal(content.status, "verified");
    assert.equal(content.headSha, HEAD_A);
    assert.equal(content.screenshots.length, 2);
    for (const ref of content.screenshots) {
      assert.ok(fs.existsSync(ref.blobPath), `blob must exist: ${ref.blobPath}`);
      assert.ok(ref.blobPath.includes(issueId), "blob is namespaced to the issue");
      assert.ok(ref.sizeBytes > 0);
      assert.match(ref.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(fs.readFileSync(content.screenshots[0]!.blobPath, "utf8"), "desktop-bytes");
    assert.equal(fs.readFileSync(content.screenshots[1]!.blobPath, "utf8"), "mobile-bytes");

    // The transient directory is gone; the rest of the worktree is untouched.
    assert.equal(fs.existsSync(path.join(dir, VISUAL_QA_DIR_NAME)), false);
    assert.equal(fs.readFileSync(path.join(dir, "feature.txt"), "utf8"), "implemented");

    // The reviewer read path surfaces the same receipt.
    const latest = readLatestVisualQa(issueId);
    assert.ok(latest && latest.kind === "receipt");
    assert.equal(latest.content.headSha, HEAD_A);

    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: no Visual QA line collects nothing and persists nothing", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: "Implemented the widget, no screenshots.",
      expectedHeadSha: HEAD_A,
    });
    assert.deepEqual(result, { kind: "none" });
    assert.equal(listArtifactsForIssue(issueId).length, 0);
    assert.equal(readLatestVisualQa(issueId), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Direct collection: every rejection fails loudly.

test("NOT-381: SHA mismatch rejects loudly and keeps the files for inspection", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: verifiedConclusion(HEAD_B),
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /bound to bbbbbbbb but the developer handoff is aaaaaaaa/);
    const rejected = rejectedContent(issueId);
    assert.equal(rejected.status, "verified");
    assert.match(rejected.reason, /bound to bbbbbbbb but the developer handoff is aaaaaaaa/);
    assert.equal(rejected.expectedHeadSha, HEAD_A);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
    // Rejected files stay put for inspection (the dir is git-excluded upstream).
    assert.equal(fs.existsSync(path.join(dir, VISUAL_QA_DIR_NAME, "desktop-1440x900.png")), true);
    const latest = readLatestVisualQa(issueId);
    assert.ok(latest && latest.kind === "rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: missing screenshot file rejects loudly", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: verifiedConclusion(HEAD_A),
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /screenshot is missing/);
    assert.match((result as { reason: string }).reason, /mobile-390x800\.png/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: screenshot symlink rejects loudly", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({
    [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x",
    "real.png": "x",
  });
  fs.symlinkSync(path.join(dir, "real.png"), path.join(dir, VISUAL_QA_DIR_NAME, "mobile-390x800.png"));
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: verifiedConclusion(HEAD_A),
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /is a symlink, refusing/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: symlinked artifact directory rejects loudly and stores no blobs", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ "keep.txt": "x" });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-out-"));
  try {
    fs.writeFileSync(path.join(outside, "desktop-1440x900.png"), "outside-bytes");
    fs.writeFileSync(path.join(outside, "mobile-390x800.png"), "outside-bytes");
    fs.symlinkSync(outside, path.join(dir, VISUAL_QA_DIR_NAME));
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: verifiedConclusion(HEAD_A),
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /visual-artifact directory is a symlink, refusing/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("NOT-381: symlinked subdirectory rejects loudly and stores no blobs", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-out-"));
  try {
    fs.writeFileSync(path.join(outside, "mobile-390x800.png"), "outside-bytes");
    fs.symlinkSync(outside, path.join(dir, VISUAL_QA_DIR_NAME, "sub"));
    const conclusion = verifiedConclusion(HEAD_A).replace(
      `${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
      `${VISUAL_QA_DIR_NAME}/sub/mobile-390x800.png`
    );
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion,
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /traverses a symlink, refusing/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("NOT-381: screenshot path traversal rejects loudly", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ "evil.png": "x", [`${VISUAL_QA_DIR_NAME}/desktop-1440x900.png`]: "x" });
  try {
    const conclusion = verifiedConclusion(HEAD_A).replace(
      `${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
      "../evil.png"
    );
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion,
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /escapes the visual-artifact directory/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: missing required verified fields reject loudly", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: `Visual QA: verified\nhead: ${HEAD_A}\napp: real\n`,
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /scenario\/path/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: unknown status rejects loudly", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: "Done.\n\nVisual QA: done\n",
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /unknown Visual QA status/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Direct collection: unavailable / not_required states.

test("NOT-381: unavailable persists the concrete failed capability with no screenshot artifacts", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: `Tried the probe.\n\nVisual QA: unavailable\nhead: ${HEAD_A}\ncapability: browser launch: chromium binary not found\n`,
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "receipt");
    assert.equal((result as { status: string }).status, "unavailable");
    const content = receiptContent(issueId);
    assert.equal(content.status, "unavailable");
    assert.equal(content.capability, "browser launch: chromium binary not found");
    assert.deepEqual(content.screenshots, []);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: unavailable without a capability rejects loudly (never normalized into a pass)", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: "Visual QA: not run\n",
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "rejected");
    assert.match((result as { reason: string }).reason, /names no failed capability/);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_RECEIPT_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: not_required persists with no screenshot artifacts even when the worker names files", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({ [`${VISUAL_QA_DIR_NAME}/stray.png`]: "x" });
  try {
    const result = collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: `No UI changed.\n\nVisual QA: not_required\nscreenshots: ${VISUAL_QA_DIR_NAME}/stray.png\n`,
      expectedHeadSha: HEAD_A,
    });
    assert.equal(result.kind, "receipt");
    assert.equal((result as { status: string }).status, "not_required");
    const content = receiptContent(issueId);
    assert.deepEqual(content.screenshots, []);
    assert.equal(latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NOT-381: readLatestVisualQa prefers the newest record across kinds (tie prefers the rejection)", () => {
  const { issueId, sessionId } = freshIds();
  const dir = writeWorktree({});
  try {
    // Receipt first, then a newer rejection for a later attempt.
    collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: "Visual QA: not_required\n",
      expectedHeadSha: HEAD_A,
    });
    const first = readLatestVisualQa(issueId);
    assert.ok(first && first.kind === "receipt");
    collectDeveloperVisualQa({
      issueId,
      sessionId,
      worktreePath: dir,
      conclusion: `Visual QA: verified\nhead: ${HEAD_B}\napp: real\nscenario: x\nviewports: 1440x900\ncommands: y\nscreenshots: ${VISUAL_QA_DIR_NAME}/a.png\n`,
      expectedHeadSha: HEAD_A,
    });
    const second = readLatestVisualQa(issueId);
    assert.ok(second && second.kind === "rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Developer-to-reviewer integration: the exact branch's real head, desktop +
// mobile screenshots, a validated receipt bound to the published PR head, a
// clean worktree (no committed screenshots), and the receipt in the reviewer
// input.

let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-visqa-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

const okDeckCallTool = async (name: string, _args: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ id: TEST_DECK_ID, name: "test-deck" }),
    },
  ],
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

function fakeGithub(): GithubFn {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 100;
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const adapter: GithubFn = {
    async viewPr({ branch, number }) {
      const resolved = branch ?? (number != null ? branchByNumber.get(number) : undefined);
      if (!resolved) return null;
      const pr = prsByBranch.get(resolved);
      if (!pr) return null;
      if (number != null && number !== pr.number) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: resolved, headRefOid: remoteHead(resolved), isDraft: true };
    },
    async createDraftPr({ base, head }) {
      if (!head) throw new Error("fakeGithub.createDraftPr requires an explicit --head");
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prsByBranch.set(head, { number, url, base });
      branchByNumber.set(number, head);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview() {
      return { ok: true, event: "APPROVE" as const, usedCommentFallback: false };
    },
  };
  return adapter;
}

/** The worker implements, captures desktop + mobile at the final HEAD, and
 * closes with a structured receipt naming that exact SHA. */
const visualSpawn: SpawnFn = async (input) => {
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement");
  const head = git(input.cwd, "rev-parse", "HEAD");
  const visualDir = path.join(input.cwd, VISUAL_QA_DIR_NAME);
  fs.mkdirSync(visualDir, { recursive: true });
  fs.writeFileSync(path.join(visualDir, "desktop-1440x900.png"), "desktop-bytes");
  fs.writeFileSync(path.join(visualDir, "mobile-390x800.png"), "mobile-bytes");
  const transcript = [
    `Implemented the widget with real-app visual verification.`,
    ``,
    `Visual QA: verified`,
    `head: ${head}`,
    `app: real (no mocks)`,
    `scenario: /widgets/new — fill the form and submit`,
    `viewports: 1440x900, 390x800`,
    `commands: npm run dev:api & npm run dev:web -- --port 4321; capture via chromium headless screenshot`,
    `screenshots: ${VISUAL_QA_DIR_NAME}/desktop-1440x900.png, ${VISUAL_QA_DIR_NAME}/mobile-390x800.png`,
    ``,
  ].join("\n");
  return { exitCode: 0, transcript, logPath: "/dev/null", timedOut: false };
};

function shasFromPrompt(prompt: string): { baseSha: string; headSha: string } {
  const baseSha = prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
  const headSha = prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
  if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
  return { baseSha, headSha };
}

test("NOT-381: developer screenshots hand off a validated receipt bound to the PR head into the reviewer input", async () => {
  const issueId = await makeIssue();
  const reviewerPrompts: string[] = [];
  const approvingSpawn: ReviewerSpawnFn = async (input) => {
    reviewerPrompts.push(input.prompt);
    const { baseSha, headSha } = shasFromPrompt(input.prompt);
    const body = {
      verdict: "approved",
      baseSha,
      headSha,
      acceptanceCriteriaAssessment: "Met.",
      evidenceAssessment: "Visual receipt bound to this head; code reviewed.",
      findings: [],
      risks: [],
    };
    return { exitCode: 0, transcript: `Review done.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`, logPath: "/dev/null", timedOut: false };
  };
  // One shared in-memory PR store across both handlers — the reviewer looks
  // the PR up by number, so a second store would miss.
  const github = fakeGithub();
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool: okDeckCallTool, spawn: visualSpawn, github })
  );
  registerEffectHandler("reviewer", (ctx) =>
    runReviewerEffect(ctx, { deckCallTool: okDeckCallTool, spawn: approvingSpawn, github })
  );
  startWorkflow(issueId);
  await pump(1);

  // Developer handed off cleanly at the published PR head.
  const afterDev = getIssue(issueId)!;
  assert.equal(afterDev.status, "reviewing");
  assert.ok(afterDev.headSha);
  const prHead = afterDev.headSha!;
  assert.ok(afterDev.prNumber);

  // The receipt names the exact PR head and both screenshot blob references
  // exist in Dealer storage.
  const content = receiptContent(issueId);
  assert.equal(content.status, "verified");
  assert.equal(content.headSha, prHead);
  assert.equal(content.screenshots.length, 2);
  const blobBytes = content.screenshots.map((s) => {
    assert.ok(fs.existsSync(s.blobPath), `blob must exist: ${s.blobPath}`);
    return fs.readFileSync(s.blobPath, "utf8");
  });
  assert.deepEqual(blobBytes.sort(), ["desktop-bytes", "mobile-bytes"]);
  assert.equal(latestIssueArtifact(issueId, VISUAL_QA_REJECTED_KIND), null);

  // Clean worktree state: screenshots were never committed — the pushed branch
  // tree carries no visual-artifact directory.
  const branch = `issue-${issueId}`;
  const tree = git(repo, "ls-tree", "-r", branch, "--name-only");
  assert.doesNotMatch(tree, new RegExp(VISUAL_QA_DIR_NAME));
  assert.match(tree, /feature\.txt/);
  assert.equal(git(remote, "rev-parse", branch), prHead);

  await pump(1);
  assert.equal(reviewerPrompts.length, 1, "reviewer ran exactly once");
  const reviewerPrompt = reviewerPrompts[0]!;
  assert.match(reviewerPrompt, /## Visual QA \(developer receipt — SHA-bound to this head\)/);
  assert.ok(reviewerPrompt.includes(prHead), "reviewer input names the exact PR head");
  assert.match(reviewerPrompt, /desktop-1440x900\.png/);
  assert.match(reviewerPrompt, /mobile-390x800\.png/);
  assert.match(reviewerPrompt, /real \(no mocks\)/);
  assert.match(reviewerPrompt, /1440x900, 390x800/);
});

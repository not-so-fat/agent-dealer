// packages/server/src/dev-review-cli-happy-path.integration.test.ts
//
// NOT-79 acceptance test: the ticket's required scenario — an agent-operated Dev-review
// issue driven start-to-finish through the *public CLI/API surface only* (no repository
// function called directly to advance the workflow, no browser). A real Fastify app (the
// same route registration as index.ts) and a real, timer-driven coordinator loop run
// in-process against a real Git repository + bare remote; the CLI itself runs as a
// genuine separate `tsx` process per command, exactly as an operator or another coding
// agent would invoke it, talking over real HTTP to an ephemeral port recorded in
// run.json. Only the two things that would otherwise cost money or need a live external
// service are faked: the agent CLI session (`spawn`) and GitHub (`github`) — the
// confirmed NOT-61/62 scope — plus Agent Deck's execution-authority mint/verify, faked
// here for the same reason (NOT-87 introduced a real network dependency on a running
// Agent Deck backend that a hermetic test must not require). Everything else — routing,
// git, worktrees, the authority ledger, PR/SHA verification, findings, human actions — is
// exercised for real.
//
// A real local dogfood run (real coding agents, a real Agent Deck backend, a real PR
// against a disposable target repo) is tracked separately — this test proves the wiring
// is correct with controlled fixtures, per the ticket's two-part acceptance criteria.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { GithubAdapter, ReviewEvent } from "./adapters/github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(repoRoot, "packages", "cli", "src", "bin.ts");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not79-home-"));
process.env.AGENT_DEALER_HOME = home;
process.env.MAX_COORDINATOR_CONCURRENCY = "2";
process.env.COORDINATOR_HEARTBEAT_MS = "20";
process.env.COORDINATOR_POLL_INTERVAL_MS = "50";
process.env.COORDINATOR_FAIL_BACKOFF_MS = "0";
process.env.CHECKS_POLL_TIMEOUT_MS = "60";
process.env.CHECKS_POLL_INTERVAL_MS = "10";
process.env.DEVELOPER_TIMEOUT_MS = "10000";
process.env.REVIEWER_TIMEOUT_MS = "10000";
process.env.REVIEWER_PUBLISH_WAIT_ATTEMPTS = "3";
process.env.REVIEWER_PUBLISH_WAIT_INTERVAL_MS = "10";

const Fastify = (await import("fastify")).default;
const cors = (await import("@fastify/cors")).default;
const { migrate } = await import("./db/index.js");
const { createAgent } = await import("./repository/agents.js");
const { getIssue } = await import("./repository/issues.js");
const { listWorkItemsForIssue } = await import("./repository/work-items.js");
const { registerRoutes } = await import("./routes/index.js");
const { registerIssueRoutes } = await import("./routes/issues.js");
const { registerHumanActionRoutes } = await import("./routes/human-actions.js");
const { registerEffectHandler, resetEffectHandlers } = await import("./coordinator/effect-registry.js");
const { runDeveloperEffect } = await import("./coordinator/developer-effect.js");
const { runReviewerEffect } = await import("./coordinator/reviewer-effect.js");
const { startCoordinatorLoop, stopCoordinatorLoop } = await import("./coordinator/worker-loop.js");
type DeveloperDeps = Parameters<typeof runDeveloperEffect>[1];
type ReviewerDeps = Parameters<typeof runReviewerEffect>[1];
type SpawnFn = NonNullable<DeveloperDeps>["spawn"];
type ReviewerSpawnFn = NonNullable<ReviewerDeps>["spawn"];
type GithubFn = GithubAdapter;

const DECK_ID = "6e825b59-13de-4ddd-ab7e-55ab5a1c279c";

before(() => migrate());
after(() => {
  stopCoordinatorLoop();
  resetEffectHandlers();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let remote: string;

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not79-repo-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  remote = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-not79-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A genuine first commit — proves the developer worker actually ran, not a no-op. */
const devSpawn: SpawnFn = async (input) => {
  assert.ok(input.mcpConfigPath, "a deckId-bearing profile must hand the worker a materialized Agent Deck MCP config");
  fs.writeFileSync(path.join(input.cwd, "feature.txt"), "implemented v1\n");
  git(input.cwd, "add", ".");
  git(input.cwd, "-c", "user.email=agent@test", "-c", "user.name=Agent", "commit", "-q", "-m", "implement widget");
  return { exitCode: 0, transcript: "Implementation conclusion: added the widget.", logPath: "/dev/null", timedOut: false };
};

function shasFromPrompt(prompt: string): { baseSha: string; headSha: string } {
  const baseSha = prompt.match(/"baseSha" to exactly "([0-9a-f]+)"/)?.[1];
  const headSha = prompt.match(/"headSha" to exactly "([0-9a-f]+)"/)?.[1];
  if (!baseSha || !headSha) throw new Error("could not extract SHAs from reviewer prompt");
  return { baseSha, headSha };
}

function reviewerTranscript(baseSha: string, headSha: string): string {
  const body = {
    verdict: "approved",
    baseSha,
    headSha,
    acceptanceCriteriaAssessment: "Met.",
    evidenceAssessment: "Evidence checked.",
    findings: [],
    risks: [],
  };
  return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

const reviewerSpawn: ReviewerSpawnFn = async (input) => {
  assert.ok(input.mcpConfigPath, "a deckId-bearing profile must hand the worker a materialized Agent Deck MCP config");
  const { baseSha, headSha } = shasFromPrompt(input.prompt);
  return { exitCode: 0, transcript: reviewerTranscript(baseSha, headSha), logPath: "/dev/null", timedOut: false };
};

/** In-memory PR store — real git tells it the branch/head, nothing hits real GitHub. */
function fakeGithub(): GithubFn {
  const prsByBranch = new Map<string, { number: number; url: string; base: string }>();
  const branchByNumber = new Map<number, string>();
  let nextNumber = 900;
  const currentBranch = (cwd: string) => git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const remoteHead = (branch: string) => git(remote, "rev-parse", branch);
  const adapter: GithubAdapter = {
    async viewPr({ cwd, number }) {
      const branch = number != null ? branchByNumber.get(number) : currentBranch(cwd);
      if (!branch) return null;
      const pr = prsByBranch.get(branch);
      if (!pr) return null;
      return { number: pr.number, url: pr.url, baseRefName: pr.base, headRefName: branch, headRefOid: remoteHead(branch), isDraft: true };
    },
    async createDraftPr({ cwd, base }) {
      const branch = currentBranch(cwd);
      const number = nextNumber++;
      const url = `https://github.com/o/r/pull/${number}`;
      prsByBranch.set(branch, { number, url, base });
      branchByNumber.set(number, branch);
      return { ok: true, number, url };
    },
    async checksSnapshot() {
      return "success";
    },
    async publishReview({ event }) {
      const finalEvent: ReviewEvent = event;
      return { ok: true, event: finalEvent, usedCommentFallback: false };
    },
  };
  return adapter;
}

/** Tracks every get_bound_deck verify so the test can prove the profile's deckId reached
 * the launch deck-connection path, not just the profile snapshot. */
const deckVerifyCalls: string[] = [];
const fixtureDeckCallTool = async (name: string) => {
  assert.equal(name, "get_bound_deck");
  deckVerifyCalls.push(name);
  return { content: [{ type: "text", text: JSON.stringify({ id: DECK_ID }) }] };
};

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate an ephemeral port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the actual CLI entrypoint (`bin.ts`) as a separate process, exactly like an
 * operator or coding agent invoking `agent-dealer <args>` — the "public CLI surface"
 * this ticket requires, not an in-process call to the command's implementation. */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_DEALER_HOME: home, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function cliJson(result: CliResult): unknown {
  assert.equal(result.code, 0, `CLI call failed (exit ${result.code}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test(
  "agent-operated CLI: discover profiles, create + start a Dev-review issue, watch the real coordinator drive it to a pending action, resolve it, and observe done — with Agent Deck authority evidence",
  { timeout: 60_000 },
  async () => {
    // Two fixture-registered agent profiles, each bound to the same test deck — proves
    // "Verify the selected Agent Deck ID reaches the worker profile snapshot and bind
    // evidence" (NOT-79 acceptance criteria), not just that the workflow completes.
    const dev = createAgent({ name: `dev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo, deckId: DECK_ID }, "test-deck");
    const rev = createAgent({ name: `rev-${Math.random()}`, runtime: "claude_code", workspaceRoot: repo, deckId: DECK_ID }, "test-deck");

    // One shared in-memory PR store — the developer opens the PR, and the reviewer must
    // see the SAME one via its own `viewPr` lookup (two independent fakes would each see
    // an empty store and the reviewer would never find a PR to publish against).
    const github = fakeGithub();
    registerEffectHandler("developer", (ctx) =>
      runDeveloperEffect(ctx, { spawn: devSpawn, github, deckCallTool: fixtureDeckCallTool })
    );
    registerEffectHandler("reviewer", (ctx) =>
      runReviewerEffect(ctx, { spawn: reviewerSpawn, github, deckCallTool: fixtureDeckCallTool })
    );

    const app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    await registerRoutes(app);
    await registerIssueRoutes(app);
    await registerHumanActionRoutes(app);
    const port = await getEphemeralPort();
    await app.listen({ port, host: "127.0.0.1" });
    after(() => app.close());

    // The CLI resolves its API base from run.json exactly the way a real `agent-dealer
    // start` daemon would leave it — writing it directly here lets the CLI hit this
    // in-process app over real HTTP without going through the full daemon lifecycle.
    fs.writeFileSync(
      path.join(home, "run.json"),
      JSON.stringify({ host: "127.0.0.1", port, serverPid: process.pid, cliPid: process.pid, startedAt: new Date().toISOString() }, null, 2)
    );

    startCoordinatorLoop();

    // 1. Discover profiles from only the CLI — no ambient knowledge of the IDs just created.
    const agents = cliJson(await runCli(["agent", "list"])) as { agents: Array<{ id: string; deckId: string | null; deckName: string | null }> };
    const devFromCli = agents.agents.find((a) => a.id === dev.id);
    const revFromCli = agents.agents.find((a) => a.id === rev.id);
    assert.ok(devFromCli && revFromCli, "both fixture profiles must be discoverable via `agent list`");
    assert.equal(devFromCli!.deckId, DECK_ID);
    assert.equal(revFromCli!.deckId, DECK_ID);

    // 2. Create the issue from the CLI.
    const created = cliJson(
      await runCli([
        "issue",
        "create",
        "--title",
        "Add widget",
        "--repo",
        repo,
        "--developer-agent",
        devFromCli!.id,
        "--reviewer-agent",
        revFromCli!.id,
        "--acceptance-criteria",
        "Widget renders.",
        "--base-branch",
        "main",
      ])
    ) as { id: string; status: string };
    const issueId = created.id;
    assert.equal(created.status, "ready");

    // 3. Discover it again via `issue list` — the CLI's own listing, not the create response.
    const listed = cliJson(await runCli(["issue", "list", "--status", "ready"])) as Array<{ id: string }>;
    assert.ok(listed.some((i) => i.id === issueId), "the newly created issue must be discoverable via `issue list`");

    // 4. Start it from the CLI.
    const started = cliJson(await runCli(["issue", "start", issueId])) as { instance: { id: string } };
    assert.ok(started.instance?.id);

    // 5-6. The real, timer-driven coordinator loop (not a manual pump) now runs the
    // developer worker, verifies + records the PR/SHA evidence, and runs the reviewer
    // worker — all against real git and the fixture effect handlers registered above.
    const reachedFinalReview = await waitUntil(async () => {
      const shown = cliJson(await runCli(["issue", "show", issueId])) as { issue: { status: string } };
      return shown.issue.status === "final_review";
    }, 20_000);
    assert.ok(reachedFinalReview, "the coordinator loop must drive the issue to final_review without any manual pump");

    // 7. List the pending human action and its valid choices from the CLI, then resolve it.
    const actions = cliJson(await runCli(["action", "list"])) as Array<{
      id: string;
      issueId: string;
      actionType: string;
      status: string;
      choices: Array<{ choice: string; label: string }>;
    }>;
    const finalReviewAction = actions.find((a) => a.issueId === issueId && a.actionType === "final_review" && a.status === "open");
    assert.ok(finalReviewAction, "the open final_review human action must be listable via `action list`");
    assert.ok(
      finalReviewAction!.choices.some((c) => c.choice === "complete"),
      "the CLI must expose the action's valid choices, including `complete`"
    );

    const resolved = cliJson(
      await runCli(["action", "resolve", finalReviewAction!.id, "--choice", "complete", "--by", "cli-agent"])
    ) as { issueStatus: string };
    assert.equal(resolved.issueStatus, "done");

    // 8. Final state, including sessions/artifacts/usage/evidence, all via the CLI.
    const final = cliJson(await runCli(["issue", "show", issueId, "--include", "evidence"])) as {
      issue: { status: string; headSha: string | null; prNumber: number | null; prUrl: string | null };
      evidence: { workerSessions: Array<{ role: string; status: string }>; artifacts: unknown[]; usageEvents: unknown[] };
    };
    assert.equal(final.issue.status, "done");
    assert.ok(final.issue.prNumber != null && final.issue.prUrl, "PR evidence must be visible on the finished issue");
    assert.ok(final.issue.headSha, "head SHA evidence must be visible on the finished issue");

    const devSessions = final.evidence.workerSessions.filter((s) => s.role === "developer");
    const revSessions = final.evidence.workerSessions.filter((s) => s.role === "reviewer");
    assert.equal(devSessions.length, 1);
    assert.equal(revSessions.length, 1);
    assert.ok(devSessions.every((s) => s.status === "done") && revSessions.every((s) => s.status === "done"));
    assert.ok(final.evidence.artifacts.length > 0, "evidence artifacts (transcripts/checks) must be visible");

    // Real git ground truth: the branch on the bare remote carries the developer's commit,
    // and the issue's own recorded headSha matches it exactly.
    const branch = `issue-${issueId}`;
    const remoteHead = git(remote, "rev-parse", branch);
    assert.equal(final.issue.headSha, remoteHead);

    // Agent Deck bind evidence: get_bound_deck verify was invoked for both developer and
    // reviewer sessions under the launch-fixed deck path (NOT-106).
    assert.equal(deckVerifyCalls.length, 2);
    assert.ok(deckVerifyCalls.every((n) => n === "get_bound_deck"));

    // Sanity: the work items this scenario actually created are exactly one developer
    // round and one reviewer round — a genuine single-pass happy path, no repair loop.
    const workItems = listWorkItemsForIssue(issueId);
    assert.equal(workItems.filter((w) => w.kind === "developer").length, 1);
    assert.equal(workItems.filter((w) => w.kind === "reviewer").length, 1);

    // Repository-level ground truth for the same issue the CLI reported on — the CLI's
    // view and the coordinator's own state must agree.
    assert.equal(getIssue(issueId)!.status, "done");
  }
);

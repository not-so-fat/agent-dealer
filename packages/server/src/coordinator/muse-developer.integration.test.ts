// packages/server/src/coordinator/muse-developer.integration.test.ts
//
// NOT-278 acceptance: a `muse_code` developer profile with a deck goes through the real
// coordinator (startWorkflow → tick → routing) and the real developer effect — deck preflight,
// real git worktree, real push, real spawn of a *fake Muse process* (fixtures/fake-muse.mjs)
// on the isolated exec lane, fake GitHub. No paid service is ever called. Scenarios are picked
// with FAKE_MUSE_SCENARIO; the invocation is recorded to a file.
//
// The per-attempt Muse home lives under the Dealer-owned worker MCP config root (outside the
// worktree and outside OS temp — the temp roots are refused, so every fixture root here is a
// home scratch dir). The serve lane is never used for a deck-enabled Muse turn.
import { test, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME_SCRATCH = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-it-"));
process.env.AGENT_DEALER_HOME = path.join(HOME_SCRATCH, "dealer-home");
fs.mkdirSync(process.env.AGENT_DEALER_HOME, { recursive: true });
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
const { runMuseDeveloperSession } = await import("./muse-spawn.js");
const { getAgentDeckMcpUrl } = await import("../adapters/agent-deck.js");
const { getWorkerMcpConfigDir } = await import("../paths.js");
const { assertMuseSettings } = await import("../runners/muse-config.js");
type GithubFn = typeof realGithubAdapter;

before(() => migrate());
beforeEach(() => {
  getDb().exec("DELETE FROM work_items; DELETE FROM runtime_availability");
  fs.rmSync(RECORD, { force: true });
  delete process.env.FAKE_MUSE_SCENARIO;
  saveEnv();
  // Deterministic credentials: no saved login under this config home, so the attempt uses the
  // fake API key on stdin — unless a test creates muse/auth.json below it (the symlink path).
  // The sentinel vars prove the child receives exactly the approved environment.
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(HOME_SCRATCH, "cfg-"));
  process.env.META_API_KEY = FAKE_API_KEY;
  process.env.MUSE_SENTINEL = "must-not-reach-child";
  process.env.CODEX_HOME = path.join(HOME_SCRATCH, "codex-home-sentinel");
  process.env.DEALER_MUSE_SENTINEL = "must-not-reach-child";
});
afterEach(() => restoreEnv());
after(() => {
  resetEffectHandlers();
  delete process.env.DEVELOPER_TIMEOUT_MS;
  restoreEnv();
  fs.rmSync(HOME_SCRATCH, { recursive: true, force: true });
});

/** Fake API key for the stdin-delivery path — assertions require it to appear nowhere. */
const FAKE_API_KEY = "mk-test-fake-key-0123456789abcdef";

const MANAGED_ENV = ["XDG_CONFIG_HOME", "META_API_KEY", "MUSE_SENTINEL", "CODEX_HOME", "DEALER_MUSE_SENTINEL"] as const;
let savedEnv: Record<string, string | undefined> = {};
function saveEnv(): void {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
}
function restoreEnv(): void {
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const TEST_DECK_ID = "00000000-0000-4000-a000-000000000099";
/** The MCP endpoint the spawn binds: the configured endpoint, always ending in `/mcp`. */
function expectedMcpUrl(): string {
  return `${getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "")}/mcp`;
}
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

function makeMuseIssue(opts: { maxInfraAttempts?: number; deckId?: string | null } = {}): string {
  // The Agents form requires a deck; the Muse developer session receives it on the exec lane.
  const dev = createAgent({
    name: `muse-${Math.random()}`,
    runtime: "muse_code",
    ...(opts.deckId === null ? {} : { deckId: opts.deckId ?? TEST_DECK_ID }),
  });
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

/** Live deck preflight stub: the test deck answers as bound (same shape as the real MCP tool). */
function museDeckCallTool(deckId: string = TEST_DECK_ID) {
  return async (name: string, _args: Record<string, unknown>) => {
    if (name !== "get_bound_deck") throw new Error(`unexpected deck call ${name}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ id: deckId, name: "test-deck" }) }],
    };
  };
}

function registerMuseDeveloper(deckCallTool: (name: string, args: Record<string, unknown>) => Promise<unknown> = museDeckCallTool()): void {
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, { deckCallTool, spawn: realDeveloperSpawn, github: fakeGithub() })
  );
}

/** Spawn wrapper that counts invocations — proves preflight failures never reach a child process. */
function countingSpawn(counter: { count: number }): typeof realDeveloperSpawn {
  return async (input) => {
    counter.count += 1;
    return realDeveloperSpawn(input);
  };
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
  authSymlink: boolean;
  apiKeyStdin: boolean;
  stdinBytes: number;
  envLeak: Record<string, boolean>;
  porcelain: string;
} {
  return JSON.parse(fs.readFileSync(RECORD, "utf8"));
}

/** The captured settings file: exactly one required agent-deck server, accepted by the guard. */
function expectDeckSettings(rec: ReturnType<typeof recorded>, deckId: string = TEST_DECK_ID): Record<string, any> {
  const settings = JSON.parse(rec.settings) as Record<string, any>;
  assert.deepEqual(Object.keys(settings).sort(), ["mcpServers", "run", "runtime_capabilities", "schema_version"]);
  assert.deepEqual(Object.keys(settings.mcpServers), ["agent-deck"]);
  const server = settings.mcpServers["agent-deck"];
  assert.equal(server.type, "streamable-http");
  assert.equal(server.url, expectedMcpUrl());
  assert.equal(server.mode, "required");
  assert.deepEqual(server.headers, {
    "x-agent-deck-deck-id": deckId,
    "x-agent-deck-workspace": fs.realpathSync(rec.cwd),
  });
  assert.equal("enabled_tools" in server, false, "developers are unfiltered: no allowlist claim");
  assert.equal("disabled_tools" in server, false, "developers are unfiltered: no denylist claim");
  assertMuseSettings(
    settings,
    { url: expectedMcpUrl(), deckId, workspace: fs.realpathSync(rec.cwd) },
    "developer"
  );
  return settings;
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

  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "done");
  assert.equal(dev.runtime, "muse_code");
  const snapshot = parseProfileSnapshot(dev.profileSnapshotJson)!;
  assert.equal(snapshot.runtime, "muse_code");
  assert.equal(snapshot.model, MUSE_CODE_CONTRIBUTOR_MODEL);

  const conclusion = listArtifactsForIssue(issueId).find((a) => a.kind === "implementation_conclusion")!;
  assert.match(String((JSON.parse(conclusion.contentJson!) as { text: string }).text), /added the widget/);
});

test("the turn runs the isolated exec lane (never serve) with the required agent-deck server and the exact environment", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success";
  startWorkflow(issueId);
  await pump();

  const rec = recorded();
  // Exec lane, not the shared serve host: the serve protocol has no per-session MCP identity and
  // could never produce a per-attempt settings file — the binary itself ran here.
  assert.equal(rec.argv[0], "exec");
  for (const expected of ["--json", "--no-foreign-personal-context", "--disable-web-tools", "--api-key-stdin"]) {
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
  // Per-attempt config lives under the Dealer-owned worker MCP config root — outside the
  // worktree and outside OS temp — and is removed after the session.
  const mcpRoot = fs.realpathSync(getWorkerMcpConfigDir());
  assert.ok(rec.xdgConfigHome.startsWith(`${mcpRoot}${path.sep}`), rec.xdgConfigHome);
  assert.ok(rec.xdgDataHome.startsWith(`${mcpRoot}${path.sep}`), rec.xdgDataHome);
  assert.ok(!rec.xdgConfigHome.startsWith(rec.cwd), "config is not under the worktree");
  assert.equal(fs.existsSync(rec.xdgConfigHome), false, "per-attempt config removed after success");
  assert.equal(fs.existsSync(rec.xdgDataHome), false, "per-attempt data removed after success");
  expectDeckSettings(rec);
  // Exact environment: ambient secrets and sentinels never reached the child.
  assert.deepEqual(rec.envLeak, {
    META_API_KEY: false,
    MUSE_SENTINEL: false,
    CODEX_HOME: false,
    DEALER_MUSE_SENTINEL: false,
  });
  // API-key auth travels on stdin only: the key is in neither argv, env, settings, nor the record.
  assert.equal(rec.apiKeyStdin, true);
  assert.equal(rec.stdinBytes, FAKE_API_KEY.length + 1);
  assert.equal(rec.authLinked, false, "api-key auth links no auth file");
  const recordRaw = fs.readFileSync(RECORD, "utf8");
  assert.ok(!recordRaw.includes(FAKE_API_KEY), "record holds a stdin length, never the key");
  assert.ok(!rec.settings.includes(FAKE_API_KEY), "settings hold no key");
  // The config dir is outside the worktree, so the worktree was porcelain-clean at spawn time.
  assert.equal(rec.porcelain, "");
});

test("saved-login auth is symlinked, never copied, and carries no stdin key", async () => {
  const operatorAuthDir = path.join(process.env.XDG_CONFIG_HOME!, "muse");
  fs.mkdirSync(operatorAuthDir, { recursive: true });
  const operatorAuth = path.join(operatorAuthDir, "auth.json");
  fs.writeFileSync(operatorAuth, '{"token":"operator-owned"}');

  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "success";
  startWorkflow(issueId);
  await pump();

  assert.equal(getIssue(issueId)!.status, "reviewing");
  const rec = recorded();
  assert.equal(rec.authLinked, true);
  assert.equal(rec.authSymlink, true, "the login is linked, never copied");
  assert.equal(rec.apiKeyStdin, false);
  assert.equal(rec.stdinBytes, 0, "no key on stdin for saved-login auth");
  assert.equal(fs.existsSync(rec.xdgConfigHome), false, "per-attempt config (and link) removed");
  assert.equal(fs.readFileSync(operatorAuth, "utf8"), '{"token":"operator-owned"}', "operator credentials untouched");
  expectDeckSettings(rec);
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
  const rec = recorded();
  assert.equal(fs.existsSync(rec.xdgConfigHome), false, "per-attempt config removed after auth failure");
});

test("a usage cap defers the work item and records Muse availability, spending no attempt", async () => {
  const issueId = makeMuseIssue();
  registerMuseDeveloper();
  process.env.FAKE_MUSE_SCENARIO = "usage-cap";
  startWorkflow(issueId);
  await pump();

  const issue = getIssue(issueId)!;
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
  const rec = recorded();
  assert.equal(fs.existsSync(rec.xdgConfigHome), false, "per-attempt config removed after timeout");
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
    // The worktree is kept for inspection; the per-attempt config outside it is removed.
    const rec = recorded();
    assert.equal(fs.existsSync(rec.xdgConfigHome), false);
    assert.equal(fs.existsSync(rec.xdgDataHome), false);
    assert.equal(listUsageEventsForIssue(issueId).length, 1, "the spend is still recorded");
  });
}

// ── deck admission: Muse is fail-closed without a deck, like every runtime ───────────────────

test("a Muse developer profile without deckId fails as deck_failure before any Muse process starts", async () => {
  const issueId = makeMuseIssue({ deckId: null });
  const spawnCounter = { count: 0 };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, {
      deckCallTool: museDeckCallTool(),
      spawn: countingSpawn(spawnCounter),
      github: fakeGithub(),
    })
  );
  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  assert.equal(spawnCounter.count, 0, "no spawn without a deck");
  assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");
  assert.match(dev.errorJson ?? "", /deck/i);
  assert.notEqual(getIssue(issueId)!.status, "reviewing");
});

test("an unreachable deck waits as deck_unavailable without spawning", async () => {
  const issueId = makeMuseIssue();
  const spawnCounter = { count: 0 };
  const unreachable = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1110"), { code: "ECONNREFUSED" });
  };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, {
      deckCallTool: unreachable,
      spawn: countingSpawn(spawnCounter),
      github: fakeGithub(),
    })
  );
  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  assert.equal(spawnCounter.count, 0, "no spawn while the deck is unreachable");
  assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "cancelled", "a deck wait is a cancellation, never a crash");
});

test("a responding but wrong deck fails as deck_failure without spawning", async () => {
  const issueId = makeMuseIssue();
  const spawnCounter = { count: 0 };
  registerEffectHandler("developer", (ctx) =>
    runDeveloperEffect(ctx, {
      deckCallTool: museDeckCallTool("some-other-deck-id"),
      spawn: countingSpawn(spawnCounter),
      github: fakeGithub(),
    })
  );
  assert.equal(startWorkflow(issueId).ok, true);
  await pump();

  assert.equal(spawnCounter.count, 0, "no spawn on a deck mismatch");
  assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  const dev = listWorkerSessionsForIssue(issueId).find((s) => s.role === "developer")!;
  assert.equal(dev.status, "failed");
  assert.match(dev.errorJson ?? "", /deck/i);
});

// ── per-attempt config cleanup, on the spawn itself ────────────────────────────────────────────

function scratchWorktree(): string {
  const wt = fs.mkdtempSync(path.join(HOME_SCRATCH, "dealer-muse-wt-"));
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.email", "t@example.com");
  git(wt, "config", "user.name", "T");
  fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "init");
  return wt;
}

/** Direct spawn input on a scratch worktree: the deck comes from the frozen profile value. */
function directInput(wt: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    runtime: "muse_code",
    policy: { worktreeWrite: true } as never,
    model: MUSE_CODE_CONTRIBUTOR_MODEL,
    deckId: TEST_DECK_ID,
    agentDeckUrl: "http://127.0.0.1:1110/mcp",
    prompt: "Implement it",
    cwd: wt,
    timeoutMs: 20_000,
    logPath: path.join(HOME_SCRATCH, `muse-log-${sessionId}.ndjson`),
    ...extra,
  } as Parameters<typeof runMuseDeveloperSession>[0];
}

for (const scenario of ["success", "auth", "usage-cap", "cron"]) {
  test(`per-attempt Muse config is removed after a ${scenario} session`, async () => {
    const wt = scratchWorktree();
    try {
      process.env.FAKE_MUSE_SCENARIO = scenario;
      const result = await runMuseDeveloperSession(
        directInput(wt, "00000000-0000-4000-8000-000000000001")
      );
      const rec = recorded();
      const mcpRoot = fs.realpathSync(getWorkerMcpConfigDir());
      assert.ok(rec.xdgConfigHome.startsWith(`${mcpRoot}${path.sep}`), "config was written outside the worktree and outside temp");
      assert.equal(fs.existsSync(rec.xdgConfigHome), false);
      assert.equal(fs.existsSync(rec.xdgDataHome), false);
      assert.deepEqual(rec.envLeak, {
        META_API_KEY: false,
        MUSE_SENTINEL: false,
        CODEX_HOME: false,
        DEALER_MUSE_SENTINEL: false,
      });
      assert.ok(!fs.readFileSync(RECORD, "utf8").includes(FAKE_API_KEY), "no key in the record");
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
  const before = new Set(fs.readdirSync(getWorkerMcpConfigDir()));
  try {
    await assert.rejects(
      runMuseDeveloperSession(directInput(wt, "00000000-0000-4000-8000-000000000002"))
    );
    assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  } finally {
    process.env.MUSE_CLI = prev;
    fs.rmSync(wt, { recursive: true, force: true });
  }
  const after = new Set(fs.readdirSync(getWorkerMcpConfigDir()));
  assert.deepEqual([...after].filter((e) => !before.has(e)), [], "no stranded attempt dir");
});

test("an aborted session still removes the per-attempt config", async () => {
  const wt = scratchWorktree();
  const controller = new AbortController();
  try {
    process.env.FAKE_MUSE_SCENARIO = "hang";
    const pending = runMuseDeveloperSession(
      directInput(wt, "00000000-0000-4000-8000-000000000003", {
        timeoutMs: 30_000,
        signal: controller.signal,
      })
    );
    setTimeout(() => controller.abort(), 500);
    await pending;
    const rec = recorded();
    assert.equal(fs.existsSync(rec.xdgConfigHome), false, "per-attempt config removed after abort");
  } finally {
    delete process.env.FAKE_MUSE_SCENARIO;
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("missing credentials fail before spawn: nothing is written and no process starts", async () => {
  const wt = scratchWorktree();
  const savedKey = process.env.META_API_KEY;
  const savedCfg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(HOME_SCRATCH, "cfg-noauth-"));
  delete process.env.META_API_KEY;
  try {
    await assert.rejects(
      runMuseDeveloperSession(directInput(wt, "00000000-0000-4000-8000-000000000004")),
      /Muse Code auth required/
    );
    assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  } finally {
    if (savedKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = savedKey;
    process.env.XDG_CONFIG_HOME = savedCfg;
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test("a missing deckId fails before spawn: nothing is written and no process starts", async () => {
  const wt = scratchWorktree();
  try {
    await assert.rejects(
      runMuseDeveloperSession(directInput(wt, "00000000-0000-4000-8000-000000000005", { deckId: null })),
      /deckId/
    );
    assert.equal(fs.existsSync(RECORD), false, "no Muse process ever started");
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

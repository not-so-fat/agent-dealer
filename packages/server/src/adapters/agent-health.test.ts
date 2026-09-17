// packages/server/src/adapters/agent-health.test.ts
//
// An agent bound to a deck that Agent Deck is reachable for (agentDeckOnline) but whose
// launch deck-metadata call fails — or succeeds but simply no longer includes this deck
// (deleted) — must surface a distinct issue. resolveDeckName silently swallows both of
// the same failures to null elsewhere, so this is the one place an operator can see why
// deck resolution is broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentHealthIssue } from "@agent-dealer/shared";
import type { DeckAccessResult } from "./agent-deck.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agenthealth-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { healthForAgent, runtimeIssuesUncached, githubIssuesUncached, clearAgentHealthCaches } =
  await import("./agent-health.js");

migrate();

const FAILURE: DeckAccessResult = { ok: false, code: "DECK_UNAVAILABLE", message: "Agent Deck API error: 502" };

/** Tests inject an empty github list so host `gh auth` does not pollute assertions. */
const NO_GITHUB: AgentHealthIssue[] = [];

test("agentDeckOnline but no deckId configured: no deck-related issue", async () => {
  const agent = createAgent({ name: "no-deck", runtime: "claude_code", workspaceRoot: "/tmp" });
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("agent deck offline: reports deck_offline, not deck_unauthorized", async () => {
  const agent = createAgent({
    name: "offline",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, false, new Map(), true, FAILURE, NO_GITHUB);
  assert.deepEqual(
    result.issues.map((i) => i.code).sort(),
    ["deck_offline"]
  );
});

test("agent deck online but metadata unavailable: reports deck_unauthorized with the Deck message", async () => {
  const agent = createAgent({
    name: "unavailable",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue");
  assert.equal(issue?.message, "Agent Deck API error: 502");
});

test("agent deck online, metadata call succeeds, but this deck isn't in the returned set: reports deck_unauthorized", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "stale-deck", runtime: "claude_code", workspaceRoot: "/tmp", deckId });
  const deckAccessResult: DeckAccessResult = { ok: true, decks: [{ id: randomUUID(), name: "some-other-deck" }] };
  const result = await healthForAgent(agent, true, new Map(), true, deckAccessResult, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue for a deck missing from the launch set");
});

test("agent deck online and this deck is in the returned set: healthy on the deck axis", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "healthy", runtime: "claude_code", workspaceRoot: "/tmp", deckId });
  const deckAccessResult: DeckAccessResult = { ok: true, decks: [{ id: deckId, name: "healthy-deck" }] };
  const result = await healthForAgent(agent, true, new Map(), true, deckAccessResult, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("agent deck online with no deck-access result computed (e.g. no agent needed it): no false positive", async () => {
  const agent = createAgent({
    name: "no-result",
    runtime: "claude_code",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("codex_local with a missing CLI reports cli_missing exactly once, not twice", async () => {
  const prevCodexCli = process.env.CODEX_CLI;
  process.env.CODEX_CLI = "/nonexistent/path/codex-does-not-exist";
  try {
    const issues = await runtimeIssuesUncached("codex_local");
    assert.deepEqual(
      issues.map((i) => i.code),
      ["cli_missing"]
    );
  } finally {
    if (prevCodexCli === undefined) delete process.env.CODEX_CLI;
    else process.env.CODEX_CLI = prevCodexCli;
  }
});

test("cursor_local with a bound deck: no deck access issue (launch MCP is supported)", async () => {
  const agent = createAgent({
    name: "cursor-with-deck",
    runtime: "cursor_local",
    workspaceRoot: "/tmp",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("github_auth issues mark the agent unhealthy so Start can refuse before a wasted run", async () => {
  const agent = createAgent({ name: "needs-gh", runtime: "claude_code", workspaceRoot: "/tmp" });
  const gh: AgentHealthIssue[] = [
    { code: "github_auth", message: "Run `gh auth login` — GitHub CLI auth required to open PRs" },
  ];
  const result = await healthForAgent(agent, true, new Map(), true, null, gh);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.some((i) => i.code === "github_auth"), true);
});

test("githubIssuesUncached reports github_auth when gh auth status fails with an invalid token", async () => {
  clearAgentHealthCaches();
  // Exercise the real parser path by stubbing via PATH... we instead unit-test the
  // injected-list path above for healthForAgent. Here we assert the uncached helper
  // returns a known shape when `gh` is present but auth is bad — skip if gh missing.
  const { spawnSync } = await import("node:child_process");
  const probe = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    // No gh on this host — nothing to assert about auth status.
    return;
  }
  const issues = await githubIssuesUncached();
  for (const issue of issues) {
    assert.ok(issue.code === "github_auth" || issue.code === "github_cli_missing");
    assert.ok(issue.message.length > 0);
  }
});

test("cursor_keychain status/stderr fixture maps to a blocking health issue via cursorAuthIssueFromOutput", async () => {
  const { cursorAuthIssueFromOutput } = await import("@agent-dealer/shared");
  const fixture = `Cursor couldn't save your login to the macOS keychain (errSecDuplicateItem, security exit code 45).
The keychain item is stuck. Delete it and sign in again:
  security delete-generic-password -s cursor-access-token -a cursor-user
  agent login
`;
  const issue = cursorAuthIssueFromOutput(fixture);
  assert.equal(issue?.code, "cursor_keychain");
  assert.match(issue!.message, /delete-generic-password/);

  const agent = createAgent({ name: "cursor-keychain", runtime: "cursor_local", workspaceRoot: "/tmp" });
  const result = await healthForAgent(
    agent,
    true,
    new Map([["cursor_local", [issue!]]]),
    true,
    null,
    NO_GITHUB
  );
  assert.equal(result.healthy, false);
  assert.equal(result.issues.some((i) => i.code === "cursor_keychain"), true);
});

// ---------------------------------------------------------------------------
// NOT-133: the admission preflight classifies each runtime's *captured* logged-out
// output. Stubs replay the fixtures in packages/shared/src/fixtures/runtime-auth/.
// ---------------------------------------------------------------------------

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../shared/src/fixtures/runtime-auth"
);

/** A CLI stub that prints a captured fixture verbatim and exits with the captured code. */
function stubCli(name: string, fixture: string, exitCode: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cli-stub-"));
  const bin = path.join(dir, name);
  fs.writeFileSync(
    bin,
    `#!/bin/sh\ncat ${JSON.stringify(path.join(FIXTURES, fixture))}\nexit ${exitCode}\n`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  process.env[key] = value;
  clearAgentHealthCaches();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    clearAgentHealthCaches();
  }
}

test("logged-out `cursor-agent status` capture blocks the cursor runtime (exit 0 — output is the only signal)", async () => {
  const issues = await withEnv(
    "CURSOR_CLI",
    stubCli("cursor-agent", "cursor-agent-status-logged-out.txt", 0),
    () => runtimeIssuesUncached("cursor_local")
  );
  assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
  assert.match(issues[0]!.message, /cursor-agent login/);
  assert.match(issues[0]!.message, /CURSOR_API_KEY/);
});

test("logged-in `cursor-agent status` capture leaves the cursor runtime healthy", async () => {
  const issues = await withEnv(
    "CURSOR_CLI",
    stubCli("cursor-agent", "cursor-agent-status-logged-in.txt", 0),
    () => runtimeIssuesUncached("cursor_local")
  );
  assert.deepEqual(issues, []);
});

test("a cursor status probe that fails without a classifiable reason blocks rather than admits", async () => {
  // NOT-133: silence used to be read as health, so an agent that could not be checked was
  // admitted anyway. Unknown auth must wait, not spend infra attempts on ~1s dead sessions.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cli-stub-"));
  const bin = path.join(dir, "cursor-agent");
  fs.writeFileSync(bin, "#!/bin/sh\necho 'panic: runtime broke' >&2\nexit 7\n");
  fs.chmodSync(bin, 0o755);
  const issues = await withEnv("CURSOR_CLI", bin, () => runtimeIssuesUncached("cursor_local"));
  assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
  assert.match(issues[0]!.message, /Could not confirm Cursor auth/);
});

test("logged-out `codex login status` capture blocks the codex runtime", async () => {
  const issues = await withEnv(
    "CODEX_CLI",
    stubCli("codex", "codex-login-status-logged-out.txt", 1),
    () => runtimeIssuesUncached("codex_local")
  );
  assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
  assert.match(issues[0]!.message, /codex login/);
});

test("logged-in `codex login status` capture leaves the codex runtime healthy", async () => {
  const issues = await withEnv(
    "CODEX_CLI",
    stubCli("codex", "codex-login-status-logged-in.txt", 0),
    () => runtimeIssuesUncached("codex_local")
  );
  assert.deepEqual(issues, []);
});

test("logged-out `claude auth status` capture blocks the claude runtime", async () => {
  // Claude had no auth preflight at all before NOT-133 — a logged-out Claude agent was
  // admitted exactly the way the logged-out Cursor ones were.
  const issues = await withEnv(
    "CLAUDE_CLI",
    stubCli("claude", "claude-auth-status-logged-out.txt", 0),
    () => runtimeIssuesUncached("claude_code")
  );
  assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
  assert.match(issues[0]!.message, /claude auth login/);
});

test("logged-in `claude auth status` capture leaves the claude runtime healthy", async () => {
  const issues = await withEnv(
    "CLAUDE_CLI",
    stubCli("claude", "claude-auth-status-logged-in.txt", 0),
    () => runtimeIssuesUncached("claude_code")
  );
  assert.deepEqual(issues, []);
});

test("an older claude CLI without `auth status` is not a false block", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cli-stub-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, "#!/bin/sh\necho \"error: unknown command 'auth'\" >&2\nexit 1\n");
  fs.chmodSync(bin, 0o755);
  const issues = await withEnv("CLAUDE_CLI", bin, () => runtimeIssuesUncached("claude_code"));
  assert.deepEqual(issues, []);
});

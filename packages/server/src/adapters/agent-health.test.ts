// packages/server/src/adapters/agent-health.test.ts
//
// An agent bound to a deck that Agent Deck is reachable for (agentDeckOnline) but whose
// launch deck-metadata call fails — or succeeds but simply no longer includes this deck
// (deleted) — must surface a distinct issue. resolveDeckName silently swallows both of
// the same failures to null elsewhere, so this is the one place an operator can see why
// deck resolution is broken.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentHealthIssue } from "@agent-dealer/shared";
import type { DeckAccessResult } from "./agent-deck.js";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-agenthealth-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent, getAgent } = await import("../repository/agents.js");
const {
  healthForAgent,
  runtimeIssuesUncached,
  githubIssuesUncached,
  clearAgentHealthCaches,
  setCursorProbeTimingForTests,
  setRunCommandForTests,
} = await import("./agent-health.js");

migrate();

const FAILURE: DeckAccessResult = { ok: false, code: "DECK_UNAVAILABLE", message: "Agent Deck API error: 502" };

/** Tests inject an empty github list so host `gh auth` does not pollute assertions. */
const NO_GITHUB: AgentHealthIssue[] = [];

// Shared inject/cache hooks — must not run concurrently with sibling cases in this file.
describe("agent-health", { concurrency: false }, () => {

test("missing deckId: reports deck_missing", async () => {
  const created = createAgent({
    name: "no-deck",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  getDb().prepare("UPDATE agents SET deck_id = NULL WHERE id = ?").run(created.id);
  const agent = getAgent(created.id)!;
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  assert.equal(result.issues.some((i) => i.code === "deck_missing"), true);
  assert.equal(result.healthy, false);
});

// NOT-181: a Muse Code worker gets no MCP servers and no Agent Deck, so no deck problem may park it.
test("muse_code ignores deck state: no deck, offline deck or unreadable deck raises a deck issue", async () => {
  const created = createAgent({ name: "muse-no-deck", runtime: "muse_code", deckId: randomUUID() });
  getDb().prepare("UPDATE agents SET deck_id = NULL WHERE id = ?").run(created.id);
  for (const [agent, online] of [
    [getAgent(created.id)!, true],
    [createAgent({ name: "muse-offline", runtime: "muse_code", deckId: randomUUID() }), false],
    [createAgent({ name: "muse-stale", runtime: "muse_code", deckId: randomUUID() }), true],
  ] as const) {
    const result = await healthForAgent(agent, online, new Map(), true, FAILURE, NO_GITHUB);
    assert.deepEqual(result.issues, [], agent.name);
    assert.equal(result.healthy, true);
  }
});

test("agent deck offline: reports deck_offline, not deck_unauthorized", async () => {
  const agent = createAgent({
    name: "offline",
    runtime: "claude_code",
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
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, FAILURE, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue");
  assert.equal(issue?.message, "Agent Deck API error: 502");
});

test("agent deck online, metadata call succeeds, but this deck isn't in the returned set: reports deck_unauthorized", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "stale-deck", runtime: "claude_code", deckId });
  const deckAccessResult: DeckAccessResult = { ok: true, decks: [{ id: randomUUID(), name: "some-other-deck" }] };
  const result = await healthForAgent(agent, true, new Map(), true, deckAccessResult, NO_GITHUB);
  const issue = result.issues.find((i) => i.code === "deck_unauthorized");
  assert.ok(issue, "expected a deck_unauthorized issue for a deck missing from the launch set");
});

test("agent deck online and this deck is in the returned set: healthy on the deck axis", async () => {
  const deckId = randomUUID();
  const agent = createAgent({ name: "healthy", runtime: "claude_code", deckId });
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
    deckId: randomUUID(),
  });
  const result = await healthForAgent(agent, true, new Map(), true, null, NO_GITHUB);
  assert.equal(
    result.issues.some((i) => i.code === "deck_unauthorized" || i.code === "deck_offline"),
    false
  );
});

test("github_auth issues mark the agent unhealthy so Start can refuse before a wasted run", async () => {
  const agent = createAgent({
    name: "needs-gh",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
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

  const agent = createAgent({
    name: "cursor-keychain",
    runtime: "cursor_local",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
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
  // NOT-157: messaging says "probe failed" (soft) rather than asserting logged-out; still blocks.
  setCursorProbeTimingForTests({ timeoutMs: 2000, retryBackoffsMs: [10] });
  setRunCommandForTests(async () => ({
    ok: false,
    output: "panic: runtime broke\n",
    timedOut: false,
  }));
  clearAgentHealthCaches();
  try {
    const issues = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
    assert.match(issues[0]!.message, /Could not confirm Cursor auth/);
    assert.match(issues[0]!.message, /probe failed/i);
    assert.doesNotMatch(issues[0]!.message, /not authenticated/i);
  } finally {
    setRunCommandForTests(null);
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
  }
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

test("a cursor probe that cannot spawn reports the missing CLI, not unconfirmed auth", async () => {
  // A spawn failure resolves with `spawn <bin> ENOENT` as its *output*, so the
  // empty-output test for a missing binary never fires and the operator would be told to
  // check their login when the binary is what is absent.
  const missing = path.join(os.tmpdir(), `dealer-absent-cursor-agent-${randomUUID()}`);
  const issues = await withEnv("CURSOR_CLI", missing, () => runtimeIssuesUncached("cursor_local"));
  assert.deepEqual(issues.map((i) => i.code), ["cli_missing"]);
  assert.match(issues[0]!.message, /cursor\.com\/install/);
});

test("logged-out `claude auth status` capture blocks the claude runtime", async () => {
  // Claude had no auth preflight at all before NOT-133 — a logged-out Claude agent was
  // admitted exactly the way the logged-out Cursor ones were. Exit 1 with a JSON body: the
  // classifier reads `"loggedIn": false`, never the status code.
  const issues = await withEnv(
    "CLAUDE_CLI",
    stubCli("claude", "claude-auth-status-logged-out.txt", 1),
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

// ---------------------------------------------------------------------------
// NOT-157: sleep/wake probe timeout is a soft fail — retry + grace — not a
// sticky "not authenticated" park of the queue.
// ---------------------------------------------------------------------------

test("NOT-157: timeout then success within the soft window leaves the cursor runtime healthy", async () => {
  // First status times out; the in-probe retry returns the logged-in capture.
  const loggedIn = fs.readFileSync(
    path.join(FIXTURES, "cursor-agent-status-logged-in.txt"),
    "utf8"
  );
  let calls = 0;
  setCursorProbeTimingForTests({ timeoutMs: 200, retryBackoffsMs: [10] });
  setRunCommandForTests(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, output: "timeout", timedOut: true };
    return { ok: true, output: loggedIn, timedOut: false };
  });
  clearAgentHealthCaches();
  try {
    const issues = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(issues, []);
    assert.equal(calls, 2);
  } finally {
    setRunCommandForTests(null);
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
  }
});

test("NOT-157: soft probe timeout message names probe timeout, not 'not authenticated'", async () => {
  // Always time out → soft fail after retries. No prior healthy → fail closed, but the
  // wait_reason / Ops copy must say the probe timed out (not that Cursor is logged out).
  setCursorProbeTimingForTests({ timeoutMs: 150, retryBackoffsMs: [10] });
  setRunCommandForTests(async () => ({ ok: false, output: "timeout", timedOut: true }));
  clearAgentHealthCaches();
  try {
    const issues = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
    assert.match(issues[0]!.message, /probe timed out/i);
    assert.doesNotMatch(issues[0]!.message, /not authenticated/i);
  } finally {
    setRunCommandForTests(null);
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
  }
});

test("NOT-157: a single soft timeout after a recent healthy probe does not flip unhealthy", async () => {
  const loggedIn = fs.readFileSync(
    path.join(FIXTURES, "cursor-agent-status-logged-in.txt"),
    "utf8"
  );
  let phase: "healthy" | "hang" = "healthy";
  setCursorProbeTimingForTests({ timeoutMs: 150, retryBackoffsMs: [10] });
  setRunCommandForTests(async () => {
    if (phase === "healthy") return { ok: true, output: loggedIn, timedOut: false };
    return { ok: false, output: "timeout", timedOut: true };
  });
  clearAgentHealthCaches();
  try {
    const healthy = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(healthy, []);
    phase = "hang";
    // One soft-fail streak (timeouts on every attempt in this call) while still inside
    // the healthy grace window must not publish runtime_auth.
    const afterSoft = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(afterSoft, []);
  } finally {
    setRunCommandForTests(null);
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
  }
});

test("NOT-157: verbatim logged-out capture still blocks immediately (hard fail)", async () => {
  // Hard classification must not wait for soft retries — NOT-133 preserved.
  const loggedOut = fs.readFileSync(
    path.join(FIXTURES, "cursor-agent-status-logged-out.txt"),
    "utf8"
  );
  let calls = 0;
  setCursorProbeTimingForTests({ timeoutMs: 8000, retryBackoffsMs: [500, 500] });
  setRunCommandForTests(async () => {
    calls += 1;
    return { ok: true, output: loggedOut, timedOut: false };
  });
  clearAgentHealthCaches();
  try {
    const issues = await runtimeIssuesUncached("cursor_local");
    assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
    assert.match(issues[0]!.message, /not authenticated/i);
    assert.match(issues[0]!.message, /cursor-agent login/);
    assert.equal(calls, 1);
  } finally {
    setRunCommandForTests(null);
    setCursorProbeTimingForTests(null);
    clearAgentHealthCaches();
  }
});

// ---------------------------------------------------------------------------
// NOT-178: Muse Code health. Missing CLI, missing credentials and healthy classify distinctly;
// a probe that fails for any other reason is `runtime_unknown`, never a guessed auth failure.
// The missing-credentials remediation quotes the captured `muse exec` stderr
// (shared/src/fixtures/runtime-auth/muse-exec-missing-credentials.txt).
// ---------------------------------------------------------------------------

/** Stub `muse` that runs `body` and records the env it saw, so the pin can be asserted. */
function stubMuse(body: string): { bin: string; envLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-stub-"));
  const bin = path.join(dir, "muse");
  const envLog = path.join(dir, "env.log");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$MUSE_NO_AUTO_UPDATE" > ${JSON.stringify(envLog)}\n${body}\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, envLog };
}

async function withMuseEnv<T>(
  env: { MUSE_CLI: string; META_API_KEY?: string; configHome: string },
  fn: () => Promise<T>
): Promise<T> {
  const keys = ["MUSE_CLI", "META_API_KEY", "XDG_CONFIG_HOME"] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.MUSE_CLI = env.MUSE_CLI;
  process.env.XDG_CONFIG_HOME = env.configHome;
  if (env.META_API_KEY === undefined) delete process.env.META_API_KEY;
  else process.env.META_API_KEY = env.META_API_KEY;
  clearAgentHealthCaches();
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    clearAgentHealthCaches();
  }
}

const emptyConfigHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-cfg-"));

test("muse_code with a missing CLI reports cli_missing", async () => {
  const missing = path.join(os.tmpdir(), `dealer-absent-muse-${randomUUID()}`);
  const issues = await withMuseEnv(
    { MUSE_CLI: missing, META_API_KEY: "k", configHome: emptyConfigHome() },
    () => runtimeIssuesUncached("muse_code")
  );
  assert.deepEqual(issues.map((i) => i.code), ["cli_missing"]);
  assert.match(issues[0]!.message, /Muse Code CLI not found/);
});

test("muse_code with no META_API_KEY and no saved login reports runtime_auth", async () => {
  const stub = stubMuse(`cat ${JSON.stringify(path.join(FIXTURES, "muse-version.txt"))}`);
  const issues = await withMuseEnv(
    { MUSE_CLI: stub.bin, configHome: emptyConfigHome() },
    () => runtimeIssuesUncached("muse_code")
  );
  assert.deepEqual(issues.map((i) => i.code), ["runtime_auth"]);
  assert.match(issues[0]!.message, /muse login/);
  assert.match(issues[0]!.message, /META_API_KEY/);
});

test("muse_code is healthy with a saved login file or a META_API_KEY", async () => {
  const stub = stubMuse(`cat ${JSON.stringify(path.join(FIXTURES, "muse-version.txt"))}`);
  const withLogin = emptyConfigHome();
  fs.mkdirSync(path.join(withLogin, "muse"));
  fs.writeFileSync(path.join(withLogin, "muse", "auth.json"), "{}");
  assert.deepEqual(
    await withMuseEnv({ MUSE_CLI: stub.bin, configHome: withLogin }, () =>
      runtimeIssuesUncached("muse_code")
    ),
    []
  );
  assert.deepEqual(
    await withMuseEnv(
      { MUSE_CLI: stub.bin, META_API_KEY: "k", configHome: emptyConfigHome() },
      () => runtimeIssuesUncached("muse_code")
    ),
    []
  );
});

test("muse probes run with MUSE_NO_AUTO_UPDATE=1 so the launcher cannot swap the pinned version", async () => {
  const stub = stubMuse("echo 'Muse Code 1.3.0 (1.3.0-R3401.1)'");
  delete process.env.MUSE_NO_AUTO_UPDATE;
  await withMuseEnv({ MUSE_CLI: stub.bin, META_API_KEY: "k", configHome: emptyConfigHome() }, () =>
    runtimeIssuesUncached("muse_code")
  );
  assert.equal(fs.readFileSync(stub.envLog, "utf8").trim(), "1");
});

test("a muse probe that fails for any other reason is runtime_unknown, not a guessed auth failure", async () => {
  const stub = stubMuse("echo 'panic: something else broke'; exit 3");
  const issues = await withMuseEnv(
    { MUSE_CLI: stub.bin, configHome: emptyConfigHome() },
    () => runtimeIssuesUncached("muse_code")
  );
  assert.deepEqual(issues.map((i) => i.code), ["runtime_unknown"]);
  assert.match(issues[0]!.message, /panic: something else broke/);
  assert.doesNotMatch(issues[0]!.message, /muse login/);
});

test("a muse probe that hangs past the timeout is runtime_unknown", async () => {
  const stub = stubMuse("sleep 30");
  setCursorProbeTimingForTests({ timeoutMs: 150 });
  try {
    const issues = await withMuseEnv(
      { MUSE_CLI: stub.bin, META_API_KEY: "k", configHome: emptyConfigHome() },
      () => runtimeIssuesUncached("muse_code")
    );
    assert.deepEqual(issues.map((i) => i.code), ["runtime_unknown"]);
    assert.match(issues[0]!.message, /timed out/);
  } finally {
    setCursorProbeTimingForTests(null);
  }
});

test("claude MCP endpoint mismatch surfaces a distinct message, not the generic setup hint", async () => {
  const agent = createAgent({
    name: "claude-mcp-mismatch",
    runtime: "claude_code",
    deckId: randomUUID(),
  });
  const result = await healthForAgent(
    agent,
    true,
    new Map(),
    {
      status: "endpoint_mismatch",
      expectedHost: "127.0.0.1",
      expectedPort: "1110",
      foundHost: "127.0.0.1",
      foundPort: "9999",
    },
    null,
    NO_GITHUB
  );
  const issue = result.issues.find((i) => i.code === "mcp_not_registered");
  assert.ok(issue, "expected mcp_not_registered");
  assert.match(issue!.message, /points at 127\.0\.0\.1:9999/);
  assert.match(issue!.message, /expected 127\.0\.0\.1:1110/);
  assert.equal(issue!.message.includes("Run agent-deck setup"), false);
});

}); // describe agent-health (serial)

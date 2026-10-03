// NOT-307: Muse idle-wiring units — env parsing, session-log progress source,
// arrival-stamped normalized events, and the five-field stall metadata object.
// The full `runMuseDeveloperSession` needs a Muse binary + credentials, so these
// test the pure pieces it wires together (plus the parser contract it relies on).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MUSE_CODE_CONTRIBUTOR_MODEL } from "@agent-dealer/shared";
import {
  parseMuseRun,
  isMuseTerminalStdoutLine,
  createMusePrimaryTerminalMatcher,
} from "../runners/muse-code-jsonl.js";
import {
  museIdleTimeoutMs,
  museTerminalGraceMs,
  DEFAULT_MUSE_IDLE_TIMEOUT_MS,
  DEFAULT_MUSE_TERMINAL_GRACE_MS,
} from "./session-timeouts.js";
import {
  museIdleMinutes,
  museStallMetadata,
  runMuseDeveloperSession,
  sessionLogActivityMs,
  writeMuseNormalizedLog,
} from "./muse-spawn.js";

const MODEL = "muse-spark-1.3-contributor";

// ── MUSE_IDLE_TIMEOUT_MS parsing ─────────────────────────────────────────────

function withIdleEnv(raw: string | undefined, fn: () => void): void {
  withEnv("MUSE_IDLE_TIMEOUT_MS", raw, fn);
}

function withEnv(name: string, raw: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  try {
    if (raw === undefined) delete process.env[name];
    else process.env[name] = raw;
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("museIdleTimeoutMs defaults to 30 minutes when unset or blank", () => {
  withIdleEnv(undefined, () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("   ", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  assert.equal(DEFAULT_MUSE_IDLE_TIMEOUT_MS, 30 * 60_000);
});

test("museIdleTimeoutMs accepts an explicit bound", () => {
  withIdleEnv("600000", () => assert.equal(museIdleTimeoutMs(), 600_000));
});

test("MUSE_IDLE_TIMEOUT_MS=0 disables the watchdog", () => {
  withIdleEnv("0", () => assert.equal(museIdleTimeoutMs(), undefined));
});

test("non-numeric or negative MUSE_IDLE_TIMEOUT_MS falls back to the default", () => {
  withIdleEnv("soon", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("NaN", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("-1", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("Infinity", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
});

test("invalid MUSE_IDLE_TIMEOUT_MS logs a warning naming the value", () => {
  const prev = process.env.MUSE_IDLE_TIMEOUT_MS;
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    process.env.MUSE_IDLE_TIMEOUT_MS = "soon";
    assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS);
  } finally {
    console.warn = orig;
    if (prev === undefined) delete process.env.MUSE_IDLE_TIMEOUT_MS;
    else process.env.MUSE_IDLE_TIMEOUT_MS = prev;
  }
  assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`);
  assert.match(String(warnings[0][0]), /MUSE_IDLE_TIMEOUT_MS/);
});

// ── session-log progress source ──────────────────────────────────────────────

function writeSessionLog(dataDir: string, sessionId: string): string {
  const dir = path.join(dataDir, "muse", "sessions", "2026", "10", "01", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "{}\n");
  return file;
}

test("sessionLogActivityMs returns the session.jsonl mtime once it exists", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-progress-"));
  const sid = "11111111-1111-4111-8111-111111111111";
  assert.equal(sessionLogActivityMs(dataDir, sid), null, "absent before the child starts");
  const file = writeSessionLog(dataDir, sid);
  const got = sessionLogActivityMs(dataDir, sid);
  assert.ok(typeof got === "number", `expected mtime, got ${got}`);
  assert.ok(Math.abs(got - fs.statSync(file).mtimeMs) < 1, "reads the live mtime");
});

test("sessionLogActivityMs is null for a missing tree and never throws", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-progress-"));
  assert.equal(sessionLogActivityMs(dataDir, "no-such-session"), null);
  assert.equal(sessionLogActivityMs(path.join(dataDir, "missing"), "x"), null);
});

// ── idle minutes ─────────────────────────────────────────────────────────────

test("museIdleMinutes measures silence from last activity, else the bound", () => {
  const last = new Date(Date.now() - 20 * 60_000).toISOString();
  assert.equal(museIdleMinutes({ lastActivityAt: last, idleTimeoutMs: 1_200_000 }), 20);
  assert.equal(
    museIdleMinutes({ lastActivityAt: null, idleTimeoutMs: 1_200_000 }),
    20,
    "silent since spawn was killed after exactly the bound"
  );
  assert.equal(
    museIdleMinutes({ lastActivityAt: null, idleTimeoutMs: undefined }),
    null,
    "disabled watchdog has no idle kill to explain"
  );
});

// ── stall metadata object ────────────────────────────────────────────────────

test("museStallMetadata carries stall-evidence fields including lingeredAfterTerminal", () => {
  assert.deepEqual(
    museStallMetadata({
      lastActivityAt: "2026-10-01T19:00:00.000Z",
      toolCallCount: 24,
      lastToolName: "npm_test",
      firstOutputMs: 1234,
      idleTimedOut: true,
      lingeredAfterTerminal: false,
    }),
    {
      lastActivityAt: "2026-10-01T19:00:00.000Z",
      toolCallCount: 24,
      lastToolName: "npm_test",
      firstOutputMs: 1234,
      idleTimedOut: true,
      lingeredAfterTerminal: false,
    }
  );
});

// ── arrival-stamped normalized events ────────────────────────────────────────

function env(payloadType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ payload_type: payloadType, payload, stream: { kind: "session", id: "s1" } });
}

function timedStdout(): string {
  return [
    env("run.model.configured", { run_stream: { kind: "run", id: "r1" } }),
    env("task.lifecycle.side_effect_intent", {
      run_stream: { kind: "run", id: "r1" },
      event: { operation: "tool:read_file", idempotency_key: "tool:c1", task_id: "t1" },
    }),
    env("tool.result", { call_id: "c1", correlation_facts: { tool_name: "read_file", outcome: "success" } }),
    env("task.lifecycle.side_effect_intent", {
      run_stream: { kind: "run", id: "r1" },
      event: { operation: "tool:npm_test", idempotency_key: "tool:c2", task_id: "t2" },
    }),
    env("run.terminal.completed", { run_stream: { kind: "run", id: "r1" }, text: "done", reason: "" }),
  ].join("\n");
}

const baseInput = {
  stdout: timedStdout(),
  stderr: "",
  exitCode: 0,
  expectedModel: MODEL,
};

test("arrival times stamp every event; tool_call carries durationMs for the completed call", () => {
  const t0 = Date.UTC(2026, 9, 1, 19, 0, 0);
  // lineTs is parallel to stdout lines: intent c1 at +1s, result at +61s, intent c2 at +62s.
  const lineTs = [t0, t0 + 1_000, t0 + 61_000, t0 + 62_000, t0 + 63_000];
  const r = parseMuseRun({ ...baseInput, lineTs, now: new Date(t0 + 64_000).toISOString() });
  const tools = r.events.filter((e) => e.type === "tool_call");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "read_file");
  assert.equal(tools[0].ts, new Date(t0 + 1_000).toISOString());
  assert.equal(tools[0].durationMs, 60_000, "result arrival minus intent arrival");
  assert.equal(tools[1].name, "npm_test");
  assert.equal(tools[1].ts, new Date(t0 + 62_000).toISOString());
  assert.equal("durationMs" in tools[1], false, "a bare intent (no result) carries no duration");
  for (const e of r.events) {
    assert.ok(typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)), `every event has ts: ${JSON.stringify(e).slice(0, 120)}`);
  }
});

test("without arrival times or now the parser output stays byte-stable (no ts)", () => {
  const r = parseMuseRun({ ...baseInput });
  const tools = r.events.filter((e) => e.type === "tool_call");
  assert.deepEqual(
    tools.map((t) => ({ type: t.type, name: t.name })),
    [
      { type: "tool_call", name: "read_file" },
      { type: "tool_call", name: "npm_test" },
    ]
  );
  for (const e of r.events) assert.equal("ts" in e, false);
});

test("now alone stamps every event when the stream gave no usable time", () => {
  const now = "2026-10-01T19:05:00.000Z";
  const r = parseMuseRun({ ...baseInput, now });
  assert.ok(r.events.length > 0);
  for (const e of r.events) assert.equal(e.ts, now);
  const tools = r.events.filter((e) => e.type === "tool_call");
  for (const t of tools) assert.equal("durationMs" in t, false);
});

test("the written ndjson carries ts on every event and durationMs on completed tool calls", () => {
  const t0 = Date.UTC(2026, 9, 1, 19, 0, 0);
  const lineTs = [t0, t0 + 1_000, t0 + 61_000, t0 + 62_000, t0 + 63_000];
  const r = parseMuseRun({ ...baseInput, lineTs, now: new Date(t0 + 64_000).toISOString() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-ndjson-"));
  const logPath = path.join(dir, "session.ndjson");
  // What runMuseDeveloperSession writes: the result event embeds the session summary.
  const summary = {
    firstOutputMs: 900,
    lastActivityAt: new Date(t0 + 63_000).toISOString(),
    idleTimedOut: false,
    lingeredAfterTerminal: false,
    toolCallCount: r.tools.length,
    lastToolName: "npm_test",
  };
  const events = r.events.map((e) =>
    e.type === "result" ? { ...e, muse: { ...summary } } : e
  );
  writeMuseNormalizedLog(logPath, events, "");
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, events.length);
  const read = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const e of read) {
    assert.ok(typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts as string)), "ts on every written event");
  }
  const tools = read.filter((e) => e.type === "tool_call");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].durationMs, 60_000);
  assert.equal("durationMs" in (tools[1] as Record<string, unknown>), false);
  const result = read.find((e) => e.type === "result") as Record<string, unknown>;
  const muse = result.muse as Record<string, unknown>;
  assert.equal(muse.firstOutputMs, 900);
  assert.equal(muse.toolCallCount, 2);
  assert.equal(muse.lastToolName, "npm_test");
  assert.equal(muse.idleTimedOut, false);
  assert.equal(muse.lingeredAfterTerminal, false);
  assert.equal(muse.lastActivityAt, new Date(t0 + 63_000).toISOString());
});

// ── MUSE_TERMINAL_GRACE_MS parsing ───────────────────────────────────────────

test("museTerminalGraceMs defaults to 30 seconds when unset or blank", () => {
  withEnv("MUSE_TERMINAL_GRACE_MS", undefined, () =>
    assert.equal(museTerminalGraceMs(), DEFAULT_MUSE_TERMINAL_GRACE_MS)
  );
  withEnv("MUSE_TERMINAL_GRACE_MS", "", () => assert.equal(museTerminalGraceMs(), DEFAULT_MUSE_TERMINAL_GRACE_MS));
  withEnv("MUSE_TERMINAL_GRACE_MS", "   ", () =>
    assert.equal(museTerminalGraceMs(), DEFAULT_MUSE_TERMINAL_GRACE_MS)
  );
  assert.equal(DEFAULT_MUSE_TERMINAL_GRACE_MS, 30_000);
});

test("MUSE_TERMINAL_GRACE_MS=0 disables the post-terminal kill", () => {
  withEnv("MUSE_TERMINAL_GRACE_MS", "0", () => assert.equal(museTerminalGraceMs(), undefined));
});

test("isMuseTerminalStdoutLine matches completed and failed envelopes only", () => {
  assert.equal(
    isMuseTerminalStdoutLine(
      JSON.stringify({ payload_type: "run.terminal.failed", payload: { terminal: "failed", reason: "x" } })
    ),
    true
  );
  assert.equal(
    isMuseTerminalStdoutLine(JSON.stringify({ payload_type: "run.terminal.completed", payload: {} })),
    true
  );
  assert.equal(isMuseTerminalStdoutLine(JSON.stringify({ payload_type: "tool.result", payload: {} })), false);
  assert.equal(isMuseTerminalStdoutLine("not json"), false);
});

// ── NOT-342: linger after terminal, through the Muse spawn ───────────────────

const FAKE_MUSE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-muse.mjs");
const LINGER_HOME = fs.mkdtempSync(path.join(os.homedir(), ".dealer-muse-linger-"));
after(() => {
  fs.rmSync(LINGER_HOME, { recursive: true, force: true });
});

function lingerScratchWorktree(): string {
  const wt = fs.mkdtempSync(path.join(LINGER_HOME, "wt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wt });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: wt });
  execFileSync("git", ["config", "user.name", "T"], { cwd: wt });
  fs.writeFileSync(path.join(wt, "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init"], {
    cwd: wt,
  });
  return wt;
}

async function runLingeringMuse(opts: {
  scenario: string;
  graceMs: string;
  timeoutMs: number;
  sessionId: string;
}): Promise<{
  timedOut: boolean;
  lingeredAfterTerminal: boolean | undefined;
  museLingeredAfterTerminal: boolean | undefined;
  failureMessage: string | null;
  failureKind: string | null;
  elapsedMs: number;
  logPath: string;
}> {
  const keys = [
    "MUSE_CLI",
    "FAKE_MUSE_SCENARIO",
    "META_API_KEY",
    "AGENT_DEALER_HOME",
    "MUSE_TERMINAL_GRACE_MS",
    "MUSE_IDLE_TIMEOUT_MS",
  ] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const wt = lingerScratchWorktree();
  const dealerHome = fs.mkdtempSync(path.join(LINGER_HOME, "home-"));
  const startedAt = Date.now();
  try {
    process.env.MUSE_CLI = FAKE_MUSE;
    process.env.FAKE_MUSE_SCENARIO = opts.scenario;
    process.env.META_API_KEY = "mk-test-linger-key";
    process.env.AGENT_DEALER_HOME = dealerHome;
    process.env.MUSE_TERMINAL_GRACE_MS = opts.graceMs;
    process.env.MUSE_IDLE_TIMEOUT_MS = "0";
    const result = await runMuseDeveloperSession({
      sessionId: opts.sessionId,
      runtime: "muse_code",
      policy: { worktreeWrite: true } as never,
      model: MUSE_CODE_CONTRIBUTOR_MODEL,
      deckId: "00000000-0000-4000-a000-000000000099",
      agentDeckUrl: "http://127.0.0.1:1110/mcp",
      prompt: "Implement it",
      cwd: wt,
      timeoutMs: opts.timeoutMs,
      logPath: path.join(dealerHome, `muse-${opts.sessionId}.ndjson`),
    });
    return {
      timedOut: result.timedOut,
      // Assert top-level and muse summary separately — a regression that drops
      // either field must fail (do not coalesce with ??).
      lingeredAfterTerminal: result.lingeredAfterTerminal,
      museLingeredAfterTerminal: result.muse?.lingeredAfterTerminal,
      failureMessage: result.muse?.failure?.message ?? null,
      failureKind: result.muse?.failure?.kind ?? null,
      elapsedMs: Date.now() - startedAt,
      logPath: result.logPath,
    };
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(dealerHome, { recursive: true, force: true });
  }
}

test(
  "a Muse transport-error that lingers is recorded as a failure, not a timeout",
  { timeout: 15_000 },
  async () => {
    const out = await runLingeringMuse({
      scenario: "transport-linger",
      graceMs: "200",
      timeoutMs: 20_000,
      sessionId: "00000000-0000-4000-8000-000000000342",
    });
    assert.ok(out.elapsedMs < 5_000, `settled on the grace, took ${out.elapsedMs}ms`);
    assert.equal(out.timedOut, false);
    assert.equal(out.lingeredAfterTerminal, true);
    assert.equal(out.museLingeredAfterTerminal, true);
    assert.match(out.failureMessage ?? "", /transport error/);
  }
);

test("a completed Muse run that lingers is still a completion, not a timeout", { timeout: 15_000 }, async () => {
  const out = await runLingeringMuse({
    scenario: "completed-linger",
    graceMs: "200",
    timeoutMs: 20_000,
    sessionId: "00000000-0000-4000-8000-000000000344",
  });
  assert.equal(out.timedOut, false);
  assert.equal(out.lingeredAfterTerminal, true);
  assert.equal(out.museLingeredAfterTerminal, true);
  assert.equal(out.failureMessage, null);
});

test("MUSE_TERMINAL_GRACE_MS=0 leaves a lingering Muse child to the wall clock", { timeout: 15_000 }, async () => {
  const out = await runLingeringMuse({
    scenario: "transport-linger",
    graceMs: "0",
    timeoutMs: 500,
    sessionId: "00000000-0000-4000-8000-000000000343",
  });
  assert.equal(out.lingeredAfterTerminal, false);
  assert.equal(out.museLingeredAfterTerminal, false);
  assert.equal(out.timedOut, true, "without the grace, the wall clock still kills");
});

// NOT-342 repair: a cron run's terminal must not arm the 30s grace and SIGTERM the
// still-working primary. The child has no primary terminal — only the wall clock kills.
test(
  "a cron terminal before the primary does not arm terminal grace",
  { timeout: 15_000 },
  async () => {
    const out = await runLingeringMuse({
      scenario: "cron-terminal-then-primary-linger",
      graceMs: "200",
      timeoutMs: 800,
      sessionId: "00000000-0000-4000-8000-000000000345",
    });
    assert.equal(out.lingeredAfterTerminal, false, "cron terminal must not linger-kill");
    assert.equal(out.museLingeredAfterTerminal, false);
    assert.equal(out.timedOut, true, "wall clock still owns the kill when primary never terminals");
    assert.notEqual(out.failureKind, "malformed_stream");
  }
);

test("createMusePrimaryTerminalMatcher is what Muse wires for terminalGrace", () => {
  // Sanity: the factory exists and matches the shape spawnCli expects.
  const m = createMusePrimaryTerminalMatcher();
  assert.equal(typeof m.isTerminalLine, "function");
  assert.equal(typeof m.sawPrimaryTerminal, "function");
  assert.equal(m.sawPrimaryTerminal(), false);
});

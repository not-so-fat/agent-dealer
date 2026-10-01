// NOT-307: Muse idle-wiring units — env parsing, session-log progress source,
// arrival-stamped normalized events, and the five-field stall metadata object.
// The full `runMuseDeveloperSession` needs a Muse binary + credentials, so these
// test the pure pieces it wires together (plus the parser contract it relies on).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMuseRun } from "../runners/muse-code-jsonl.js";
import { museIdleTimeoutMs, DEFAULT_MUSE_IDLE_TIMEOUT_MS } from "./session-timeouts.js";
import {
  museIdleMinutes,
  museStallMetadata,
  sessionLogActivityMs,
  writeMuseNormalizedLog,
} from "./muse-spawn.js";

const MODEL = "muse-spark-1.3-contributor";

// ── MUSE_IDLE_TIMEOUT_MS parsing ─────────────────────────────────────────────

function withIdleEnv(raw: string | undefined, fn: () => void): void {
  const prev = process.env.MUSE_IDLE_TIMEOUT_MS;
  try {
    if (raw === undefined) delete process.env.MUSE_IDLE_TIMEOUT_MS;
    else process.env.MUSE_IDLE_TIMEOUT_MS = raw;
    fn();
  } finally {
    if (prev === undefined) delete process.env.MUSE_IDLE_TIMEOUT_MS;
    else process.env.MUSE_IDLE_TIMEOUT_MS = prev;
  }
}

test("museIdleTimeoutMs defaults to 20 minutes when unset or blank", () => {
  withIdleEnv(undefined, () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  withIdleEnv("   ", () => assert.equal(museIdleTimeoutMs(), DEFAULT_MUSE_IDLE_TIMEOUT_MS));
  assert.equal(DEFAULT_MUSE_IDLE_TIMEOUT_MS, 20 * 60_000);
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

test("museStallMetadata carries exactly the five worker_sessions fields", () => {
  assert.deepEqual(
    museStallMetadata({
      lastActivityAt: "2026-10-01T19:00:00.000Z",
      toolCallCount: 24,
      lastToolName: "npm_test",
      firstOutputMs: 1234,
      idleTimedOut: true,
    }),
    {
      lastActivityAt: "2026-10-01T19:00:00.000Z",
      toolCallCount: 24,
      lastToolName: "npm_test",
      firstOutputMs: 1234,
      idleTimedOut: true,
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
  assert.equal(muse.lastActivityAt, new Date(t0 + 63_000).toISOString());
});

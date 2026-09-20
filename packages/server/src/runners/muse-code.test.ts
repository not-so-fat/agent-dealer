import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMuseDeveloperInvocation } from "./muse-code-args.js";
import { parseMuseRun, type MuseFailureKind } from "./muse-code-jsonl.js";
import { extractResultText, extractSessionId, extractUsage } from "./stream-json.js";

// NOT-179: developer argv + JSONL parser, table-driven over the sanitized NOT-177 fixtures.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "muse-code");
const MODEL = "muse-spark-1.3-contributor";
const SESSION = "0b6c3f0e-4c2a-4f0e-9d3b-2f6f1a9a7c11";

interface ManifestEntry {
  fixture: string;
  exit_code: string;
  stderr?: string;
}
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { probes: ManifestEntry[] };
const sessionLog = readFileSync(join(DIR, "session-log-usage-excerpt.jsonl"), "utf8");

function fixture(name: string, opts: { sessionLog?: string; expectedModel?: string } = {}) {
  const entry = manifest.probes.find((p) => p.fixture === `${name}.jsonl`);
  assert.ok(entry, `manifest entry for ${name}`);
  return parseMuseRun({
    stdout: readFileSync(join(DIR, `${name}.jsonl`), "utf8"),
    stderr: entry.stderr ?? "",
    exitCode: Number(entry.exit_code),
    sessionLog: opts.sessionLog,
    expectedModel: opts.expectedModel ?? MODEL,
  });
}

// ── argv ────────────────────────────────────────────────────────────────────────────────────

const baseOpts = { model: MODEL, maxModelSteps: 40, sessionId: SESSION, prompt: "Implement NOT-1" };

test("developer argv matches the pinned contract exactly", () => {
  const inv = buildMuseDeveloperInvocation(baseOpts);
  assert.equal(inv.command, "muse");
  assert.deepEqual(inv.args, [
    "exec",
    "--json",
    "--no-foreign-personal-context",
    "--model",
    MODEL,
    "--approval-mode",
    "never",
    "--approval-judge",
    "off",
    "--sandbox-network",
    "restricted",
    "--disable-web-tools",
    "--session-id",
    SESSION,
    "--max-model-steps",
    "40",
    "Implement NOT-1",
  ]);
  assert.deepEqual(inv.env, { MUSE_NO_AUTO_UPDATE: "1" });
});

test("developer argv is deterministic", () => {
  assert.deepEqual(buildMuseDeveloperInvocation(baseOpts), buildMuseDeveloperInvocation({ ...baseOpts }));
});

test("developer argv never carries sandbox/approval/trust bypasses or reviewer/orchestration flags", () => {
  const args = buildMuseDeveloperInvocation(baseOpts).args;
  for (const flag of [
    "--yolo",
    "--disable-sandbox",
    "--disable-approval",
    "--trust-workspace",
    "-w",
    "--worktree",
    "--preset",
    "--agents",
    "--permission-profile",
    "--disable-write",
    "--disable-shell",
    "--no-session-log",
  ]) {
    assert.equal(args.includes(flag), false, flag);
  }
});

test("developer argv keeps the prompt as one trailing argument", () => {
  const prompt = 'multi word "quoted" prompt\nwith newline';
  const args = buildMuseDeveloperInvocation({ ...baseOpts, prompt }).args;
  assert.equal(args.at(-1), prompt);
  assert.equal(args.filter((a) => a === prompt).length, 1);
});

for (const [name, patch] of [
  ["empty model", { model: "  " }],
  ["zero steps", { maxModelSteps: 0 }],
  ["fractional steps", { maxModelSteps: 2.5 }],
  ["non-uuid session id", { sessionId: "not-a-uuid" }],
  ["empty prompt", { prompt: " " }],
  ["dash-leading prompt", { prompt: "--yolo" }],
] as const) {
  test(`developer argv rejects ${name}`, () => {
    assert.throws(() => buildMuseDeveloperInvocation({ ...baseOpts, ...patch }), /muse:/);
  });
}

// ── extraction ──────────────────────────────────────────────────────────────────────────────

test("completed run: final text, session id, tools, model, usage and no failure", () => {
  const r = fixture("02-tool-success", { sessionLog });
  assert.equal(r.terminal, "completed");
  assert.equal(r.failure, null);
  assert.ok(r.finalText && r.finalText.length > 0);
  assert.match(r.sessionId ?? "", /^<id-\d+>$/);
  assert.equal(r.confirmedModel, MODEL);
  assert.deepEqual(
    r.tools.map((t) => [t.name, t.outcome]),
    [["read_file", "success"]]
  );
  assert.deepEqual(r.usage, {
    inputTokens: 17770 + 19151 + 19374 + 19647,
    outputTokens: 228 + 176 + 134 + 39,
    cacheReadTokens: 5105 + 17649 + 19057 + 19313,
    cacheWriteTokens: 0,
    reasoningTokens: 159 + 106 + 28 + 26,
    modelDurationMs: 11317 + 2344 + 11383 + 2448,
    costUsd: null,
  });
});

test("exit 0 with failed tool calls is still a completed turn, with the failure recorded", () => {
  const r = fixture("02-tool-failure", { sessionLog });
  assert.equal(r.exitCode, 0);
  assert.equal(r.terminal, "completed");
  assert.equal(r.failure, null);
  assert.equal(r.finalText, "FAILED");
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0]!.name, "read_file");
  assert.equal(r.tools[0]!.outcome, "failure");
  assert.match(r.tools[0]!.error ?? "", /No such file or directory/);
});

test("tool activity covers intent-less results and MCP names", () => {
  const dev = fixture("11-recommended-developer", { sessionLog });
  assert.deepEqual(
    dev.tools.map((t) => t.name),
    ["mcp__agent_deck__get_bound_deck", "write_file", "bash"]
  );
  assert.ok(dev.tools.every((t) => t.outcome === "success"));
  assert.equal(dev.finalText?.startsWith("DONE "), true);
});

test("a second run inside the process is counted, and the first run's text wins", () => {
  const r = fixture("09-cron-disable-attempt", { sessionLog });
  assert.equal(r.runCount, 2);
  assert.equal(r.finalText?.startsWith("Scheduled "), true);
  assert.deepEqual(
    r.tools.map((t) => t.name),
    ["cron_create", "bash"]
  );
});

test("session id comes from stream.id of the session stream", () => {
  const line = JSON.stringify({
    stream: { kind: "session", id: SESSION },
    payload_type: "run.terminal.completed",
    payload: { terminal: "completed", text: "ok", reason: null },
  });
  const r = parseMuseRun({ stdout: line, exitCode: 0, sessionLog, expectedModel: MODEL });
  assert.equal(r.sessionId, SESSION);
});

test("normalized events feed the existing extractors", () => {
  const r = fixture("02-tool-success", { sessionLog });
  assert.equal(extractResultText(r.events), r.finalText);
  assert.equal(extractSessionId(r.events), r.sessionId);
  const usage = extractUsage(r.events, "plan", "codex_local");
  assert.equal(usage.inputTokens, r.usage.inputTokens);
  assert.equal(usage.outputTokens, r.usage.outputTokens);
  assert.equal(usage.cacheReadTokens, r.usage.cacheReadTokens);
  assert.equal(usage.model, MODEL);
  assert.equal(usage.totalCostUsd, undefined);
  assert.deepEqual(
    r.events.filter((e) => e.type === "tool_call"),
    [{ type: "tool_call", name: "read_file" }]
  );
  assert.equal(r.events.find((e) => e.type === "result")?.is_error, undefined);
});

// ── usage / cost stay null ──────────────────────────────────────────────────────────────────

test("without a session log tokens and cost are null, not derived from the exit code", () => {
  const r = fixture("02-tool-success");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.usage, {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    modelDurationMs: null,
    costUsd: null,
  });
  const result = r.events.find((e) => e.type === "result");
  assert.equal("usage" in (result ?? {}), false);
});

test("usage fields missing from a model_completed event stay null individually", () => {
  const log = JSON.stringify({
    payload_type: "runtime.session",
    payload: { event: { kind: "model_completed", usage: { input_tokens: 10 }, model: MODEL } },
  });
  const r = parseMuseRun({
    stdout: readFileSync(join(DIR, "02-tool-success.jsonl"), "utf8"),
    exitCode: 0,
    sessionLog: log,
    expectedModel: MODEL,
  });
  assert.equal(r.failure, null);
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.usage.outputTokens, null);
  assert.equal(r.usage.cacheReadTokens, null);
  assert.equal(r.usage.modelDurationMs, null);
  assert.equal(r.usage.costUsd, null);
});

// ── model confirmation ──────────────────────────────────────────────────────────────────────

test("a server-confirmed model different from the configured one is a failure", () => {
  const r = fixture("02-tool-success", { sessionLog, expectedModel: "muse-spark-9.9" });
  assert.equal(r.terminal, "completed");
  assert.equal(r.failure?.kind, "model_mismatch");
  assert.match(r.failure?.message ?? "", /muse-spark-9\.9.*muse-spark-1\.3-contributor/);
  assert.equal(r.events.find((e) => e.type === "result")?.is_error, true);
});

test("an unconfirmed model (no model_completed) is a failure even at exit 0", () => {
  const r = fixture("01-exec-success");
  assert.equal(r.exitCode, 0);
  assert.equal(r.confirmedModel, null);
  assert.equal(r.failure?.kind, "model_mismatch");
});

// ── failure classification ──────────────────────────────────────────────────────────────────

const failureTable: Array<[string, string, MuseFailureKind]> = [
  ["max model steps", "04-max-model-steps", "max_steps"],
  ["missing credentials (stderr only)", "10-auth-missing", "auth"],
  ["rejected api key (stderr only)", "10-auth-bad-key", "auth"],
  ["401 with warm catalog", "10-auth-rejected-401-mock", "auth"],
  ["401 with cold catalog", "10-auth-rejected-401-mock-cold", "auth"],
  ["429 with cold catalog", "10-rate-limit-429-mock-cold", "usage_cap"],
  ["429 retry loop killed by watchdog", "10-rate-limit-429-mock", "usage_cap"],
  ["sigterm without terminal event", "10-sigterm", "other"],
];

for (const [name, file, kind] of failureTable) {
  test(`classifies ${name} as ${kind}`, () => {
    const r = fixture(file, { sessionLog });
    assert.equal(r.failure?.kind, kind);
    assert.ok(r.failure?.message);
    assert.equal(r.events.find((e) => e.type === "result")?.is_error, true);
  });
}

test("auth, usage-cap, max-step and other stay distinguishable, without token guesses", () => {
  const kinds = failureTable.map(([, file]) => fixture(file).failure?.kind);
  assert.deepEqual(new Set(kinds), new Set(["max_steps", "auth", "usage_cap", "other"]));
  assert.equal(fixture("10-auth-missing").usage.inputTokens, null);
});

test("max-step failure keeps the tool activity that happened before the cap", () => {
  const r = fixture("04-max-model-steps");
  assert.equal(r.terminal, "failed");
  assert.equal(r.tools.length, 2);
  assert.equal(r.finalText, null);
});

test("the 429 retry loop sets rateLimited; a clean run does not", () => {
  assert.equal(fixture("10-rate-limit-429-mock").rateLimited, true);
  assert.equal(fixture("02-tool-success").rateLimited, false);
});

test("a rate-limited run that still completes is not classified as a cap", () => {
  const status = JSON.stringify({
    stream: { kind: "session", id: SESSION },
    payload_type: "task.lifecycle.status",
    payload: { event: { details: { facets: [{ kind: "external_attempt", error_kind: "rate_limited", http_status: 429 }] } } },
  });
  const done = JSON.stringify({
    stream: { kind: "session", id: SESSION },
    payload_type: "run.terminal.completed",
    payload: { terminal: "completed", text: "ok", reason: null },
  });
  const r = parseMuseRun({ stdout: `${status}\n${done}\n`, exitCode: 0, sessionLog, expectedModel: MODEL });
  assert.equal(r.rateLimited, true);
  assert.equal(r.failure, null);
});

// ── malformed streams ───────────────────────────────────────────────────────────────────────

const malformedTable: Array<[string, string, number | null]> = [
  ["non-JSON line", `not json\n${JSON.stringify({ payload_type: "x", payload: {} })}`, 0],
  ["truncated JSON line", '{"payload_type":"run.terminal.completed","payload":{"terminal":"comp', 0],
  ["JSON that is not an envelope", '{"hello":"world"}', 0],
  ["empty stdout at exit 0", "", 0],
  ["envelopes but no terminal at exit 0", JSON.stringify({ payload_type: "run.model.configured", payload: {} }), 0],
];

for (const [name, stdout, exitCode] of malformedTable) {
  test(`classifies ${name} as malformed_stream`, () => {
    const r = parseMuseRun({ stdout, exitCode, sessionLog, expectedModel: MODEL });
    assert.equal(r.failure?.kind, "malformed_stream");
  });
}

test("a non-JSON line outranks a later terminal event", () => {
  const r = parseMuseRun({
    stdout: `garbage\n${JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "ok" } })}`,
    exitCode: 0,
    sessionLog,
    expectedModel: MODEL,
  });
  assert.equal(r.failure?.kind, "malformed_stream");
});

test("empty stdout with a non-zero exit is other, not malformed", () => {
  const r = parseMuseRun({ stdout: "", stderr: "boom\nsecond", exitCode: 3, expectedModel: MODEL });
  assert.equal(r.failure?.kind, "other");
  assert.equal(r.failure?.message, "boom");
});

test("completed terminal with a non-zero exit is other", () => {
  const r = parseMuseRun({
    stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { terminal: "completed", text: "ok" } }),
    exitCode: 1,
    sessionLog,
    expectedModel: MODEL,
  });
  assert.equal(r.failure?.kind, "other");
});

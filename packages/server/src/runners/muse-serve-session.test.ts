// packages/server/src/runners/muse-serve-session.test.ts
//
// NOT-270: serve execution lane — fake-host coverage only, never a live
// model call. The fake replays the stable MSP shapes (session/start,
// turn/start ack, turn/completed with TokenUsage, session/read history,
// usage/changed + usage/read with the NOT-269 sanitized window/weekly
// pair). All payload values are synthetic stand-ins, never account data.
//
// Covered:
// - a real turn through the owned host returns transcript/tools/usage/model;
// - session/start carries modelId + denyUnmatched approval + workspaceRoot;
// - the same host is observed afterwards (5H+1W rows written, newest-wins);
// - pre-admission failures admit nothing (exec fallback stays safe);
// - failed/cancelled/timeout terminals map honestly; turn/cancel is sent;
// - concurrent turns share one host (no second execution host);
// - the exec allowlist refuses resume/steer/prompt; the read-only allowlist
//   still refuses session/start (capacity reads stay non-billable);
// - shutdown releases the child (no leak) without a wedged-host SIGKILL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-serve-"));

import { MuseCapacityHost } from "../capacity/muse-host.js";
import {
  assertMuseExecMethod,
  assertMuseReadOnlyMethod,
  museUuidv7,
} from "../capacity/muse.js";
import { foldServeViewItems, runMuseServeTurn } from "./muse-serve-session.js";

const { migrate } = await import("../db/index.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);

const FAKE = new URL("../capacity/fixtures/fake-muse-serve.mjs", import.meta.url).pathname;

beforeEach(async () => {
  migrate();
  clearAllCapacitySnapshots();
});

function hostOpts(mode: string, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    command: process.execPath,
    args: [FAKE],
    env: {
      META_API_KEY: "test-fake-key",
      FAKE_MSP_MODE: mode,
      FAKE_MSP_NOW_MS: String(now),
      ...((extra.env as Record<string, string> | undefined) ?? {}),
    },
    timeoutMs: (extra.timeoutMs as number | undefined) ?? 10_000,
  };
}

function recordLines(recordPath: string): Array<{ method: string | null; id: unknown; params: unknown }> {
  if (!fs.existsSync(recordPath)) return [];
  return fs
    .readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { method: string | null; id: unknown; params: unknown });
}

test("serve turn returns transcript, tools, usage, and confirmed model", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  try {
    const turn = await runMuseServeTurn({
      host,
      prompt: "do the thing",
      model: "test-model-x",
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-")),
      timeoutMs: 10_000,
    });
    assert.equal(turn.admitted, true);
    assert.equal(turn.terminal, "completed");
    assert.equal(turn.failure, null);
    assert.equal(turn.timedOut, false);
    assert.equal(turn.finalText, "serve-lane reply text");
    assert.equal(turn.confirmedModel, "test-model-x");
    assert.deepEqual(
      turn.tools.map((t) => ({ name: t.name, outcome: t.outcome })),
      [{ name: "read", outcome: "success" }]
    );
    assert.equal(turn.usage.inputTokens, 120);
    assert.equal(turn.usage.outputTokens, 45);
    assert.equal(turn.durationMs, 1500);
    assert.ok(turn.sessionId);
  } finally {
    await host.shutdown();
  }
});

test("session/start carries model, denyUnmatched approval, workspace, UUIDv7 commandIds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-record-"));
  const recordPath = path.join(dir, "record.jsonl");
  const host = new MuseCapacityHost(
    hostOpts("serve-turn-full", { env: { FAKE_MSP_RECORD: recordPath } })
  );
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-"));
  try {
    const turn = await runMuseServeTurn({
      host,
      prompt: "do the thing",
      model: "test-model-x",
      cwd,
      timeoutMs: 10_000,
    });
    assert.equal(turn.admitted, true);
    const lines = recordLines(recordPath);
    const starts = lines.filter((l) => l.method === "session/start");
    assert.equal(starts.length, 1);
    const params = starts[0]!.params as Record<string, unknown>;
    assert.equal(params.modelId, "test-model-x");
    assert.equal(params.approvalMode, "denyUnmatched");
    assert.equal(params.workspaceRoot, cwd);
    const uuidv7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(String(params.commandId), uuidv7);
    const turnStarts = lines.filter((l) => l.method === "turn/start");
    assert.equal(turnStarts.length, 1);
    const turnParams = turnStarts[0]!.params as Record<string, unknown>;
    assert.deepEqual(turnParams.input, [{ type: "text", text: "do the thing" }]);
    assert.match(String(turnParams.commandId), uuidv7);
    // No resume, steer, prompt, or approval-write method is ever sent.
    const methods = new Set(lines.map((l) => l.method));
    assert.ok(!methods.has("session/resume"), "no resume on the execution lane");
    assert.ok(!methods.has("turn/steer"), "no steering on the execution lane");
    assert.ok(!methods.has("session/prompt"), "no prompt method on the execution lane");
  } finally {
    await host.shutdown();
  }
});

test("real turn observes the host: final read writes the 5H+1W pair", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  try {
    // Fresh host is unobserved: missing, no known windows (only the
    // missing sentinel — failures never sit beside valid windows).
    const before = await host.readUsage();
    assert.equal(before.status, "missing");
    const beforeKeys = listCapacitySnapshots("muse_code").map((w) => w.windowKey);
    assert.ok(!beforeKeys.includes("rolling_all_models"), "no 5H before observation");
    assert.ok(!beforeKeys.includes("weekly_all_models"), "no 1W before observation");
    // The real turn is the observation.
    const turn = await runMuseServeTurn({
      host,
      prompt: "do the thing",
      model: "test-model-x",
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-")),
      timeoutMs: 10_000,
    });
    assert.equal(turn.admitted, true);
    // The session-boundary final read on the same host now observes.
    const after = await host.readUsage();
    assert.equal(after.status, "observed");
    assert.deepEqual(
      listCapacitySnapshots("muse_code")
        .map((w) => w.windowKey)
        .sort(),
      ["rolling_all_models", "weekly_all_models"]
    );
  } finally {
    await host.shutdown();
  }
});

test("pre-admission failures admit nothing (exec fallback stays safe)", async () => {
  for (const mode of ["serve-turn-rejected", "serve-session-start-error"]) {
    const host = new MuseCapacityHost(hostOpts(mode));
    try {
      let admittedFlag = false;
      const turn = await runMuseServeTurn({
        host,
        prompt: "do the thing",
        model: "test-model-x",
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-")),
        timeoutMs: 5_000,
        onAdmitted: () => {
          admittedFlag = true;
        },
      });
      assert.equal(turn.admitted, false, mode);
      assert.equal(admittedFlag, false, `${mode} must not fire onAdmitted`);
      assert.equal(turn.terminal, null, mode);
    } finally {
      await host.shutdown();
    }
  }
});

test("failed turn maps stepLimit and still folds history", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-failed"));
  try {
    let admittedFlag = false;
    const turn = await runMuseServeTurn({
      host,
      prompt: "do the thing",
      model: "test-model-x",
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-")),
      timeoutMs: 10_000,
      onAdmitted: () => {
        admittedFlag = true;
      },
    });
    assert.equal(turn.admitted, true);
    assert.equal(admittedFlag, true);
    assert.equal(turn.terminal, "failed");
    assert.equal(turn.failure?.kind, "max_steps");
    assert.equal(turn.finalText, "serve-lane reply text");
  } finally {
    await host.shutdown();
  }
});

test("timeout cancels the turn and reports cancelled honestly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-record-"));
  const recordPath = path.join(dir, "record.jsonl");
  const host = new MuseCapacityHost(
    hostOpts("serve-turn-hang", { env: { FAKE_MSP_RECORD: recordPath } })
  );
  try {
    const turn = await runMuseServeTurn({
      host,
      prompt: "do the thing",
      model: "test-model-x",
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-")),
      timeoutMs: 500,
    });
    assert.equal(turn.admitted, true);
    assert.equal(turn.timedOut, true);
    assert.equal(turn.terminal, "cancelled");
    assert.equal(turn.failure?.kind, "other");
    const methods = recordLines(recordPath).map((l) => l.method);
    assert.ok(methods.includes("turn/cancel"), "timeout sends turn/cancel");
  } finally {
    await host.shutdown();
  }
});

test("concurrent turns share one host connection", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-"));
    const [a, b] = await Promise.all([
      runMuseServeTurn({ host, prompt: "first", model: "test-model-x", cwd, timeoutMs: 10_000 }),
      runMuseServeTurn({ host, prompt: "second", model: "test-model-x", cwd, timeoutMs: 10_000 }),
    ]);
    assert.equal(a.admitted, true);
    assert.equal(b.admitted, true);
    assert.equal(a.finalText, "serve-lane reply text");
    assert.equal(b.finalText, "serve-lane reply text");
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(host.connectionEpoch, 1, "no second execution host per concurrent request");
  } finally {
    await host.shutdown();
  }
});

test("exec allowlist admits the lane and refuses resume/steer/prompt; read-only still refuses session/start", () => {
  assertMuseExecMethod("session/start");
  assertMuseExecMethod("turn/start");
  assertMuseExecMethod("turn/cancel");
  assertMuseExecMethod("session/read");
  for (const m of ["session/resume", "turn/steer", "session/prompt", "exec", "usage/write"]) {
    assert.throws(() => assertMuseExecMethod(m), /refusing non-execution method/);
  }
  // A capacity read by itself still sends no session, prompt, turn, or tool.
  for (const m of ["session/start", "turn/start", "turn/cancel", "session/read"]) {
    assert.throws(() => assertMuseReadOnlyMethod(m), /refusing non-read method/);
  }
});

test("museUuidv7 emits UUIDv7", () => {
  const a = museUuidv7();
  const b = museUuidv7();
  const uuidv7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(a, uuidv7);
  assert.match(b, uuidv7);
  assert.notEqual(a, b);
});

test("foldServeViewItems skips other turns and unknown kinds", () => {
  const folded = foldServeViewItems(
    [
      { kind: "agentMessage", text: "mine", turnId: "t1" },
      { kind: "agentMessage", text: "theirs", turnId: "t2" },
      { kind: "future-kind", text: "ignored", turnId: "t1" },
      { kind: "toolCall", tool: "cron_create", callId: "c1", status: "failed", failureReason: "denied", turnId: "t1" },
      { kind: "toolCall", tool: "read", callId: "c2", status: "inProgress", turnId: "t1" },
      "junk",
      null,
    ],
    "t1"
  );
  assert.equal(folded.finalText, "mine");
  assert.deepEqual(
    folded.tools.map((t) => ({ name: t.name, outcome: t.outcome, error: t.error })),
    [
      { name: "cron_create", outcome: "failure", error: "denied" },
      { name: "read", outcome: null, error: null },
    ]
  );
});

test("shutdown releases a well-behaved host without hanging", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  assert.equal(await host.ensureStarted(), true);
  assert.equal(host.isConnected(), true);
  const start = Date.now();
  await host.shutdown();
  const elapsed = Date.now() - start;
  assert.equal(host.isConnected(), false, "no leaked host process");
  assert.ok(elapsed < 2000, `graceful host exits on SIGTERM without the wedged-host path (took ${elapsed}ms)`);
});

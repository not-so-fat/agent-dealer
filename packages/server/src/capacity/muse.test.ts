// packages/server/src/capacity/muse.test.ts
//
// NOT-247: Muse serve adapter — fake-subprocess coverage only, never a live
// Muse request. A fake stable MSP server returns window + weekly usage (two
// independent snapshots with correct remaining percents and reset times), the
// rolling label derives from `windowDurationMins` (never hardcoded),
// failure modes map to explicit N/A reasons without touching runtime health,
// and the recorded protocol traffic proves the client runs the
// initialize → initialized → usage/read handshake and never sends a prompt.
// NOT-263: the fake enforces the stable contract (no `--protocol` argv,
// handshake order, `usage.window` field names).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-cap-"));

import {
  assertMuseReadOnlyMethod,
  createMuseCapacityAdapter,
  MSP_FORBIDDEN_MODEL_METHODS,
  MUSE_CLIENT_INFO,
  MUSE_SERVE_ARGV,
  museRefreshThrottleMs,
  museUsageToReadings,
  maybeRefreshMuseCapacityFromServe,
  normalizeMuseResetsAt,
  normalizeMuseUnavailable,
  readMuseCapacity,
  refreshMuseCapacityFromServe,
  requestMuseUsage,
  resetMuseCapacityRefreshState,
} from "./muse.js";
import { normalizeAdapterWindow } from "./adapter.js";
const { migrate } = await import("../db/index.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);
const {
  clearAllRuntimeAvailability,
  runtimeAvailability,
} = await import("../repository/runtime-availability.js");
const { refreshCapacityFromAdapters } = await import("./service.js");

const FAKE = new URL("./fixtures/fake-muse-serve.mjs", import.meta.url).pathname;

before(() => {
  migrate();
});

function fakeOpts(mode: string, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    now,
    opts: {
      command: process.execPath,
      args: [FAKE],
      env: {
        META_API_KEY: "test-fake-key",
        FAKE_MSP_MODE: mode,
        FAKE_MSP_NOW_MS: String(now),
        ...((extra.env as Record<string, string> | undefined) ?? {}),
      },
      timeoutMs: (extra.timeoutMs as number | undefined) ?? 10_000,
      nowMs: now,
    },
  };
}

test("serve argv is the shipping contract: no --protocol flag", () => {
  assert.deepEqual([...MUSE_SERVE_ARGV], ["serve"]);
  assert.ok(!MUSE_SERVE_ARGV.includes("--protocol"), "muse serve takes no --protocol flag");
});

test("handshake identity matches the stable clientInfo shape", () => {
  assert.match(MUSE_CLIENT_INFO.name, /^[a-z0-9_]+$/);
  assert.ok(MUSE_CLIENT_INFO.version.length > 0, "versioned client identity required");
});

test("usage windows keep identity, percent, duration, and reset", () => {
  const now = Date.now();
  const parsed = museUsageToReadings(
    {
      protocol: "msp/1.3",
      usage: {
        observedAtMs: now,
        tier: "contributor",
        window: { usedPercent: 60, resetsAtMs: now + 2 * 3600_000, windowDurationMins: 300 },
        weekly: { usedPercent: 25, resetsAtMs: now + 3 * 24 * 3600_000 },
      },
    },
    new Date(now).toISOString()
  );
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 2);
  const rolling = parsed.windows.find((w) => w.windowKey === "rolling_all_models")!;
  assert.equal(rolling.providerBucket, "all_models");
  assert.equal(rolling.durationMinutes, 300);
  assert.equal(rolling.usedPercent, 60);
  assert.equal(rolling.resetAt, new Date(now + 2 * 3600_000).toISOString());
  assert.equal(rolling.observedAt, new Date(now).toISOString());
  const normalized = normalizeAdapterWindow("muse_code", rolling, now);
  assert.equal(normalized.displayLabel, "5H");
  assert.equal(normalized.remainingPercent, 40);
  const weekly = parsed.windows.find((w) => w.windowKey === "weekly_all_models")!;
  assert.equal(normalizeAdapterWindow("muse_code", weekly, now).displayLabel, "1W");
  assert.equal(normalizeAdapterWindow("muse_code", weekly, now).remainingPercent, 75);
});

test("legacy rolling spelling maps to the same snapshot", () => {
  const now = Date.now();
  const parsed = museUsageToReadings(
    {
      usage: {
        observedAtMs: now,
        rolling: { usedPercent: 60, resetsAtMs: now + 2 * 3600_000, windowDurationMins: 300 },
      },
    },
    new Date(now).toISOString()
  );
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]!.windowKey, "rolling_all_models");
});

test("rolling label derives from windowDurationMins, never a hardcoded 5H", () => {
  const now = Date.now();
  const parsed = museUsageToReadings(
    {
      usage: {
        observedAtMs: now,
        window: { usedPercent: 10, resetsAtMs: now + 6 * 3600_000, windowDurationMins: 720 },
      },
    },
    new Date(now).toISOString()
  );
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  const normalized = normalizeAdapterWindow("muse_code", parsed.windows[0]!, now);
  assert.equal(normalized.displayLabel, "12H");
  assert.equal(normalized.remainingPercent, 90);
});

test("payloads without an observation read null, not empty", () => {
  assert.equal(museUsageToReadings(null), null);
  assert.equal(museUsageToReadings({ nonsense: true }), null);
  assert.equal(museUsageToReadings({ protocol: "msp/1.3" }), null);
  assert.equal(museUsageToReadings({ usage: null }), null);
  assert.equal(
    museUsageToReadings({ usage: { observedAtMs: Date.now() } })!.windows.length,
    0
  );
  assert.equal(
    museUsageToReadings({ usage: { observedAtMs: Date.now(), window: { windowDurationMins: 300 } } })!
      .windows.length,
    0
  );
});

test("resetsAtMs accepts ms, seconds, and ISO; rejects garbage", () => {
  const iso = "2026-09-20T12:00:00.000Z";
  const epochMs = Date.parse(iso);
  assert.equal(normalizeMuseResetsAt(epochMs), iso);
  assert.equal(normalizeMuseResetsAt(Math.floor(epochMs / 1000)), iso);
  assert.equal(normalizeMuseResetsAt(iso), iso);
  assert.equal(normalizeMuseResetsAt("garbage"), null);
  assert.equal(normalizeMuseResetsAt(null), null);
  assert.equal(normalizeMuseResetsAt(-5), null);
});

test("only the handshake and usage/read can be sent; session prompts throw before write", () => {
  assertMuseReadOnlyMethod("initialize");
  assertMuseReadOnlyMethod("initialized");
  assertMuseReadOnlyMethod("usage/read");
  for (const m of ["session/start", "session/prompt", "session/resume", "exec", "usage/write"]) {
    assert.throws(() => assertMuseReadOnlyMethod(m), /refusing non-read method/);
  }
  // The forbidden list is the billable surface the allowlist must refuse.
  assert.ok(MSP_FORBIDDEN_MODEL_METHODS.length > 0);
  for (const m of MSP_FORBIDDEN_MODEL_METHODS) {
    assert.throws(() => assertMuseReadOnlyMethod(m), /refusing non-read method/);
  }
});

test("unavailable normalization maps sentinel reasons without payload data", () => {
  const missing = normalizeMuseUnavailable("missing");
  assert.equal(missing.windowKey, "muse_account_usage");
  assert.equal(missing.unavailableReason, "missing");
  assert.equal(missing.remainingPercent, null);
  assert.equal(normalizeMuseUnavailable("unsupported").unavailableReason, "unsupported");
  assert.equal(normalizeMuseUnavailable("unparsable").unavailableReason, "unparsable");
});

test("fake MSP rolling+weekly usage becomes two snapshots end to end", async () => {
  clearAllCapacitySnapshots();
  const { now, opts } = fakeOpts("full");
  const snap = await refreshCapacityFromAdapters([createMuseCapacityAdapter(opts)], now);
  const muse = snap.runtimes.find((r) => r.runtime === "muse_code")!;
  assert.ok(muse, "muse_code entry exists");
  assert.equal(muse.unavailableReason, null);
  assert.equal(muse.windows.length, 2);
  const rolling = muse.windows.find((w) => w.windowKey === "rolling_all_models")!;
  const weekly = muse.windows.find((w) => w.windowKey === "weekly_all_models")!;
  assert.equal(rolling.displayLabel, "5H");
  assert.equal(rolling.remainingPercent, 40);
  assert.equal(rolling.resetAt, new Date(now + 2 * 3600_000).toISOString());
  assert.equal(weekly.displayLabel, "1W");
  assert.equal(weekly.remainingPercent, 75);
  assert.equal(weekly.resetAt, new Date(now + 3 * 24 * 3600_000).toISOString());
  assert.notEqual(rolling.resetAt, weekly.resetAt);
  const served = JSON.stringify(muse);
  assert.ok(!served.includes("contributor"), "no tier metadata reaches the browser shape");
});

test("usage/changed notifications are consumed while the connection is alive", async () => {
  const { opts } = fakeOpts("full");
  const read = await requestMuseUsage(opts);
  assert.equal(read.failure, null);
  assert.equal(read.updates.length, 1);
});

test("protocol traffic is the stable handshake then exactly one usage/read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-record-"));
  const recordPath = path.join(dir, "methods.jsonl");
  const { opts } = fakeOpts("full", { env: { FAKE_MSP_RECORD: recordPath } });
  await readMuseCapacity(opts);
  const lines = fs
    .readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; params?: { clientInfo?: Record<string, unknown> } });
  const methods = lines.map((l) => String(l.method));
  assert.deepEqual(methods, ["initialize", "initialized", "usage/read"]);
  const init = lines[0]!;
  assert.equal(init.params?.clientInfo?.name, MUSE_CLIENT_INFO.name);
  assert.match(String(init.params?.clientInfo?.name ?? ""), /^[a-z0-9_]+$/);
  assert.equal(init.params?.clientInfo?.version, MUSE_CLIENT_INFO.version);
  for (const m of methods) {
    assert.ok(!/session|prompt|exec|message|turn|thread/i.test(m), `billable method ${m}`);
  }
});

test("fake rejects the removed --protocol argv like the shipped binary", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const result = await readMuseCapacity({
    command: process.execPath,
    args: [FAKE, "--protocol", "msp/1.3"],
    env: { META_API_KEY: "test-fake-key", FAKE_MSP_MODE: "full" },
    timeoutMs: 10_000,
    nowMs: now,
  });
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0]!.windowKey, "muse_account_usage");
  assert.equal(result.unavailable[0]!.reason, "missing");
});

test("fake requires initialize before usage/read", async () => {
  const child = spawn(process.execPath, [FAKE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_MSP_MODE: "full", META_API_KEY: "test-fake-key" },
  });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fake response")), 5000);
      timer.unref?.();
      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, idx));
        }
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: "bare-read", method: "usage/read", params: {} })}\n`);
    });
    const msg = JSON.parse(first) as { error?: { message?: string } };
    assert.ok(msg.error, "bare usage/read is rejected before the handshake");
    assert.match(String(msg.error?.message ?? ""), /initialize/i);
  } finally {
    child.kill();
  }
});

test("a malformed sibling window does not sink the good one", async () => {
  clearAllCapacitySnapshots();
  const { opts } = fakeOpts("partial-bad-weekly");
  const result = await readMuseCapacity(opts);
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0]!.windowKey, "rolling_all_models");
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0]!.windowKey, "weekly_all_models");
  assert.equal(result.unavailable[0]!.reason, "unparsable");
});

async function expectUnavailable(
  mode: string,
  reason: "missing" | "unparsable" | "unsupported",
  extra: Record<string, unknown> = {}
): Promise<void> {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  const { now, opts } = fakeOpts(mode, extra);
  const result = await readMuseCapacity(opts);
  assert.equal(result.runtime, "muse_code");
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0]!.windowKey, "muse_account_usage");
  assert.equal(result.unavailable[0]!.reason, reason);
  // Runtime health is untouched: no availability row, still available.
  assert.equal(runtimeAvailability("muse_code", now).available, true);
}

test("failure modes return explicit N/A without affecting runtime health", async () => {
  await expectUnavailable("crash", "missing");
  await expectUnavailable("auth-error", "missing");
  await expectUnavailable("exit-nonzero", "missing");
  await expectUnavailable("hang", "missing", { timeoutMs: 300 });
  await expectUnavailable("missing", "missing");
  await expectUnavailable("malformed", "unparsable");
  await expectUnavailable("no-method", "unsupported");
});

test("missing binary reads unsupported without throwing", async () => {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  const now = Date.now();
  const result = await readMuseCapacity({
    command: "/nonexistent/muse-xyz",
    timeoutMs: 2000,
    nowMs: now,
    env: { META_API_KEY: "test-fake-key" },
  });
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable[0]!.reason, "unsupported");
  assert.equal(runtimeAvailability("muse_code", now).available, true);
});

test("no credential short-circuits to missing without spawning", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const noAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-noauth-"));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_MSP_MODE: "full" };
  delete env.META_API_KEY;
  const result = await readMuseCapacity({
    // Would report `unsupported` if ever spawned — `missing` proves it was not.
    command: "/nonexistent/muse-xyz",
    timeoutMs: 2000,
    nowMs: now,
    env,
    authFilePath: path.join(noAuthDir, "auth.json"),
  });
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable[0]!.reason, "missing");
});

test("a successful refresh clears the failure sentinel", async () => {
  clearAllCapacitySnapshots();
  await refreshMuseCapacityFromServe(fakeOpts("crash").opts);
  assert.deepEqual(
    listCapacitySnapshots("muse_code").map((w) => w.windowKey),
    ["muse_account_usage"]
  );
  const snap = await refreshMuseCapacityFromServe(fakeOpts("full").opts);
  const keys = listCapacitySnapshots("muse_code")
    .map((w) => w.windowKey)
    .sort();
  assert.deepEqual(keys, ["rolling_all_models", "weekly_all_models"]);
  const muse = snap.runtimes.find((r) => r.runtime === "muse_code")!;
  assert.ok(muse);
  assert.equal(muse.windows.length, 2);
  assert.equal(muse.unavailableReason, null);
});

test("a read with every window unparsable clears the stale sentinel", async () => {
  clearAllCapacitySnapshots();
  await refreshMuseCapacityFromServe(fakeOpts("crash").opts);
  assert.deepEqual(
    listCapacitySnapshots("muse_code").map((w) => w.windowKey),
    ["muse_account_usage"]
  );
  const result = await readMuseCapacity(fakeOpts("all-bad-windows").opts);
  assert.equal(result.windows.length, 0);
  assert.ok(result.unavailable.length > 0);
  assert.ok(result.unavailable.every((u) => u.windowKey !== "muse_account_usage"));
  await refreshMuseCapacityFromServe(fakeOpts("all-bad-windows").opts);
  const keys = listCapacitySnapshots("muse_code").map((w) => w.windowKey);
  assert.ok(!keys.includes("muse_account_usage"), `stale sentinel cleared, got ${keys}`);
  assert.ok(keys.length > 0, "per-window unparsable rows persist");
});

test("production refresh is throttled and can be disabled", async () => {
  clearAllCapacitySnapshots();
  resetMuseCapacityRefreshState();
  const { opts } = fakeOpts("full");
  try {
    assert.equal(museRefreshThrottleMs(), 5 * 60 * 1000);
    const first = await maybeRefreshMuseCapacityFromServe(opts);
    assert.ok(first, "first refresh runs");
    assert.equal(await maybeRefreshMuseCapacityFromServe(opts), null, "second refresh throttled");
    process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS = "off";
    resetMuseCapacityRefreshState();
    assert.equal(await maybeRefreshMuseCapacityFromServe(opts), null, "refresh disabled");
    process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS = "garbage";
    assert.equal(museRefreshThrottleMs(), 5 * 60 * 1000);
  } finally {
    delete process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS;
    resetMuseCapacityRefreshState();
  }
});

test("no token, tier, or raw account payload reaches the adapter output", async () => {
  const { opts } = fakeOpts("full");
  const result = await readMuseCapacity(opts);
  const raw = JSON.stringify(result);
  for (const secret of ["token", "Bearer", "auth.json", "sk-", "password", "contributor"]) {
    assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
  const refs = result.windows.map((w) => w.evidenceRef);
  assert.ok(refs.every((r) => r === "muse-serve:usage/read"));
});

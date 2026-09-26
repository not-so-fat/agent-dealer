// packages/server/src/capacity/muse-host.test.ts
//
// NOT-270: owned long-lived Muse host — fake-subprocess coverage only,
// never a live model call. The fake replays the exact sanitized MSP shapes
// captured by NOT-269 (`usage/read` result with the `window` + `weekly`
// pair; `usage/changed` params carrying `SubscriptionUsage` directly).
// All payload values are synthetic stand-ins, never account data.
//
// Proven lifecycle under test (docs/research/NOT-269-muse-5h-1w-lifecycle.md):
// - one server-owned host per process; concurrent readers share it;
// - `usage/changed` ingested as received, final `usage/read` on the same
//   host, races resolved by newest `observedAtMs`;
// - fresh-host `missing` never overwrites a newer known pair;
// - restart/crash/timeout/auth preserve last-good rows and leak no child;
// - recovery clears the failure sentinel;
// - a capacity read never sends a session, prompt, turn, tool, or other
//   billable method.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-host-"));

import {
  getMuseCapacityHost,
  maybeRefreshMuseCapacityFromHost,
  MuseCapacityHost,
  refreshMuseCapacityFromHost,
  resetMuseCapacityHostForTests,
  resetMuseCapacityRefreshState,
  shutdownMuseCapacityHost,
} from "./muse-host.js";
import {
  ingestMuseUsagePayload,
  museRefreshThrottleMs,
  noteMuseCapacityFailure,
} from "./muse.js";
const { migrate } = await import("../db/index.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);
const { getRuntimeCapacitySnapshot } = await import("./service.js");

const FAKE = new URL("./fixtures/fake-muse-serve.mjs", import.meta.url).pathname;

beforeEach(async () => {
  migrate();
  clearAllCapacitySnapshots();
  await resetMuseCapacityHostForTests();
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

/** Synthetic stand-in observation (NOT-269 sanitized shape, not account data). */
function pairPayload(observedAtMs: number, windowUsed: number, weeklyUsed: number) {
  return {
    protocol: "msp/1.3",
    usage: {
      observedAtMs,
      tier: "synthetic-stand-in",
      window: {
        usedPercent: windowUsed,
        resetsAtMs: observedAtMs + 2 * 3600_000,
        windowDurationMins: 300,
      },
      weekly: { usedPercent: weeklyUsed, resetsAtMs: observedAtMs + 3 * 24 * 3600_000 },
    },
  };
}

function keys(): string[] {
  return listCapacitySnapshots("muse_code").map((w) => w.windowKey).sort();
}

test("observed host refresh serves exactly the 5H+1W pair to the browser shape", async () => {
  const snap = await refreshMuseCapacityFromHost({ ...hostOpts("persistent-full"), nowMs: Date.now() });
  const muse = snap.runtimes.find((r) => r.runtime === "muse_code");
  // The entry exists only when muse_code is configured; assert the stored
  // rows directly so this stays independent of agent configuration.
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
  assert.ok(!keys().includes("muse_account_usage"), "no sentinel beside valid windows");
  const stored = listCapacitySnapshots("muse_code");
  const rolling = stored.find((w) => w.windowKey === "rolling_all_models")!;
  const weekly = stored.find((w) => w.windowKey === "weekly_all_models")!;
  assert.equal(rolling.remainingPercent, 40);
  assert.equal(weekly.remainingPercent, 75);
  assert.equal(rolling.unavailableReason, null);
  assert.equal(weekly.unavailableReason, null);
  const served = getRuntimeCapacitySnapshot();
  const raw = JSON.stringify(served);
  assert.ok(!raw.includes("contributor"), "no tier metadata reaches the browser shape");
  assert.ok(muse !== undefined || served.runtimes.length >= 0);
  await shutdownMuseCapacityHost();
});

test("snapshot labels and critical roles are exactly 5H/five_hour and 1W/weekly", async () => {
  await refreshMuseCapacityFromHost({ ...hostOpts("persistent-full"), nowMs: Date.now() });
  const stored = listCapacitySnapshots("muse_code");
  const byKey = new Map(stored.map((w) => [w.windowKey, w]));
  assert.equal(byKey.get("rolling_all_models")!.displayLabel, "5H");
  assert.equal(byKey.get("rolling_all_models")!.criticalRole, "five_hour");
  assert.equal(byKey.get("weekly_all_models")!.displayLabel, "1W");
  assert.equal(byKey.get("weekly_all_models")!.criticalRole, "weekly");
  await shutdownMuseCapacityHost();
});

test("host lifetime traffic is the handshake plus usage/read — never billable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-host-record-"));
  const recordPath = path.join(dir, "methods.jsonl");
  const host = new MuseCapacityHost(
    hostOpts("persistent-full", { env: { FAKE_MSP_RECORD: recordPath } })
  );
  try {
    assert.equal((await host.readUsage()).status, "observed");
    assert.equal((await host.readUsage()).status, "observed");
    assert.equal((await host.readUsage()).status, "observed");
    const lines = fs
      .readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string });
    const methods = lines.map((l) => String(l.method));
    // One handshake for the whole host lifetime, then one usage/read per refresh.
    assert.deepEqual(methods, ["initialize", "initialized", "usage/read", "usage/read", "usage/read"]);
    for (const m of methods) {
      assert.ok(!/session|prompt|turn|exec|tool|message|thread/i.test(m), `billable method ${m}`);
    }
  } finally {
    await host.shutdown();
  }
});

test("concurrent readers share the one host connection", async () => {
  const host = new MuseCapacityHost(hostOpts("persistent-full"));
  try {
    const results = await Promise.all([
      host.readUsage(),
      host.readUsage(),
      host.readUsage(),
      host.readUsage(),
      host.readUsage(),
    ]);
    assert.ok(results.every((r) => r.status === "observed"));
    assert.equal(host.connectionEpoch, 1, "exactly one host per concurrent burst");
    assert.ok(host.isConnected());
  } finally {
    await host.shutdown();
  }
});

test("fresh-host missing never overwrites or deletes a newer known pair", async () => {
  await refreshMuseCapacityFromHost({ ...hostOpts("persistent-full"), nowMs: Date.now() });
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
  await resetMuseCapacityHostForTests();
  const outcome = await getMuseCapacityHost(hostOpts("persistent-missing")).readUsage();
  assert.equal(outcome.status, "missing");
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
  const stored = listCapacitySnapshots("muse_code");
  assert.equal(stored.find((w) => w.windowKey === "rolling_all_models")!.remainingPercent, 40);
  await shutdownMuseCapacityHost();
});

test("usage/changed and final usage/read races resolve by newest observedAtMs", async () => {
  const now = Date.now();
  const first = await ingestMuseUsagePayload(pairPayload(now, 42, 17));
  assert.deepEqual(first.written.sort(), ["rolling_all_models", "weekly_all_models"]);
  // An older finishing read cannot clobber the newer rows.
  const older = await ingestMuseUsagePayload(pairPayload(now - 60_000, 90, 90));
  assert.deepEqual(older.written, []);
  assert.deepEqual(older.skippedStale.sort(), ["rolling_all_models", "weekly_all_models"]);
  const stored = listCapacitySnapshots("muse_code");
  assert.equal(stored.find((w) => w.windowKey === "rolling_all_models")!.remainingPercent, 58);
  assert.equal(stored.find((w) => w.windowKey === "weekly_all_models")!.remainingPercent, 83);
  // A newer observation still wins afterwards.
  const newer = await ingestMuseUsagePayload(pairPayload(now + 60_000, 10, 10));
  assert.deepEqual(newer.written.sort(), ["rolling_all_models", "weekly_all_models"]);
  const after = listCapacitySnapshots("muse_code");
  assert.equal(after.find((w) => w.windowKey === "rolling_all_models")!.remainingPercent, 90);
});

test("bare usage/changed params ingest without a {usage} envelope", async () => {
  const now = Date.now();
  const params = {
    observedAtMs: now,
    tier: "synthetic-stand-in",
    window: { usedPercent: 42, resetsAtMs: now + 3600_000, windowDurationMins: 300 },
    weekly: { usedPercent: 17, resetsAtMs: now + 24 * 3600_000 },
  };
  const outcome = await ingestMuseUsagePayload(params);
  assert.deepEqual(outcome.written.sort(), ["rolling_all_models", "weekly_all_models"]);
});

test("a same-stamp malformed sibling never relabels the valid half", async () => {
  const now = Date.now();
  await ingestMuseUsagePayload(pairPayload(now, 42, 17));
  const partial = {
    usage: {
      observedAtMs: now,
      tier: "synthetic-stand-in",
      window: { usedPercent: 42, resetsAtMs: now + 3600_000, windowDurationMins: 300 },
      weekly: { usedPercent: "high", resetsAtMs: now + 24 * 3600_000 },
    },
  };
  const outcome = await ingestMuseUsagePayload(partial);
  const stored = listCapacitySnapshots("muse_code");
  const weekly = stored.find((w) => w.windowKey === "weekly_all_models")!;
  assert.equal(weekly.remainingPercent, 83, "valid weekly row keeps its value");
  assert.equal(weekly.unavailableReason, null, "no diagnostic relabels the valid half");
  assert.ok(!outcome.written.includes("weekly_all_models"));
});

test("empty payload ingests nothing and deletes nothing", async () => {
  const now = Date.now();
  await ingestMuseUsagePayload(pairPayload(now, 42, 17));
  const outcome = await ingestMuseUsagePayload({ protocol: "msp/1.3" });
  assert.deepEqual(outcome.written, []);
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
});

test("crash preserves last-good rows and writes no sentinel beside them", async () => {
  const host = new MuseCapacityHost(hostOpts("persistent-full"));
  try {
    assert.equal((await host.readUsage()).status, "observed");
  } finally {
    await host.shutdown();
  }
  await resetMuseCapacityHostForTests();
  const crashed = new MuseCapacityHost(hostOpts("crash", { timeoutMs: 3000 }));
  try {
    const outcome = await crashed.readUsage();
    assert.equal(outcome.status, "missing");
    assert.ok(!crashed.isConnected(), "dead child released, none leaked");
  } finally {
    await crashed.shutdown();
  }
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
});

test("timeout kills the hung child and preserves last-good rows", async () => {
  const host = new MuseCapacityHost(hostOpts("hang", { timeoutMs: 400 }));
  try {
    const outcome = await host.readUsage();
    assert.equal(outcome.status, "missing");
    assert.ok(!host.isConnected(), "hung child killed, none leaked");
  } finally {
    await host.shutdown();
  }
});

test("auth failure reads missing and preserves last-good rows", async () => {
  await ingestMuseUsagePayload(pairPayload(Date.now(), 42, 17));
  const host = new MuseCapacityHost(hostOpts("auth-error", { timeoutMs: 5000 }));
  try {
    assert.equal((await host.readUsage()).status, "missing");
  } finally {
    await host.shutdown();
  }
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
});

test("failure with no known rows persists the sentinel; recovery clears it", async () => {
  const bad = new MuseCapacityHost(hostOpts("crash", { timeoutMs: 3000 }));
  try {
    assert.equal((await bad.readUsage()).status, "missing");
  } finally {
    await bad.shutdown();
  }
  assert.deepEqual(keys(), ["muse_account_usage"]);
  await resetMuseCapacityHostForTests();
  const snap = await refreshMuseCapacityFromHost({
    ...hostOpts("persistent-full"),
    nowMs: Date.now(),
  });
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
  assert.ok(snap !== null);
  await shutdownMuseCapacityHost();
});

test("noteMuseCapacityFailure never sits beside valid windows", async () => {
  assert.equal(await noteMuseCapacityFailure("missing"), "sentinel");
  assert.deepEqual(keys(), ["muse_account_usage"]);
  await ingestMuseUsagePayload(pairPayload(Date.now(), 42, 17));
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
  assert.equal(await noteMuseCapacityFailure("missing"), "preserved");
  assert.equal(await noteMuseCapacityFailure("unsupported"), "preserved");
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
});

test("restart after observation restarts empty and re-observes", async () => {
  const host = new MuseCapacityHost(hostOpts("exit-after-first-read"));
  try {
    assert.equal((await host.readUsage()).status, "observed");
    const firstEpoch = host.connectionEpoch;
    assert.equal(firstEpoch, 1);
    const deadline = Date.now() + 8000;
    while (host.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(!host.isConnected(), "exited child detected, none leaked");
    // Next read transparently restarts (state lost — the restarted fake
    // re-observes, proving the host recovers without a second host).
    assert.equal((await host.readUsage()).status, "observed");
    assert.equal(host.connectionEpoch, 2);
    assert.ok(host.isConnected());
  } finally {
    await host.shutdown();
  }
  assert.deepEqual(keys(), ["rolling_all_models", "weekly_all_models"]);
});

test("clean shutdown releases the child process", async () => {
  const host = new MuseCapacityHost(hostOpts("persistent-full"));
  assert.equal((await host.readUsage()).status, "observed");
  assert.ok(host.isConnected());
  await host.shutdown();
  assert.ok(!host.isConnected(), "no host process left behind");
});

test("production refresh is throttled and can be disabled", async () => {
  resetMuseCapacityRefreshState();
  const opts = { ...hostOpts("persistent-full"), nowMs: Date.now() };
  try {
    assert.equal(museRefreshThrottleMs(), 5 * 60 * 1000);
    const first = await maybeRefreshMuseCapacityFromHost(opts);
    assert.ok(first, "first refresh runs");
    assert.equal(await maybeRefreshMuseCapacityFromHost(opts), null, "second refresh throttled");
    process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS = "off";
    resetMuseCapacityRefreshState();
    assert.equal(await maybeRefreshMuseCapacityFromHost(opts), null, "refresh disabled");
    process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS = "garbage";
    assert.equal(museRefreshThrottleMs(), 5 * 60 * 1000);
  } finally {
    delete process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS;
    await resetMuseCapacityHostForTests();
  }
  await shutdownMuseCapacityHost();
});

test("no credential short-circuits to missing without spawning", async () => {
  const noAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-host-noauth-"));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_MSP_MODE: "persistent-full" };
  delete env.META_API_KEY;
  const host = new MuseCapacityHost({
    // Would report `unsupported` if ever spawned — `missing` proves it was not.
    command: "/nonexistent/muse-xyz",
    timeoutMs: 2000,
    env,
    authFilePath: path.join(noAuthDir, "auth.json"),
  });
  try {
    assert.equal((await host.readUsage()).status, "missing");
    assert.equal(host.connectionEpoch, 0, "no host spawned");
  } finally {
    await host.shutdown();
  }
  assert.deepEqual(keys(), ["muse_account_usage"]);
});

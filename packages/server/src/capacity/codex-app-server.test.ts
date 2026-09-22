// packages/server/src/capacity/codex-app-server.test.ts
//
// NOT-246: Codex App Server adapter — fake-subprocess coverage only, never a
// live provider request. A fake JSONL server returns 300-minute and
// 10,080-minute windows (separate 5H/1W snapshots), multiple
// `rateLimitsByLimitId` buckets stay distinguishable, failure modes map to
// explicit N/A reasons without touching runtime health, and the recorded
// protocol traffic proves the client never starts a model turn.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-codex-cap-"));

import {
  assertReadOnlyMethod,
  CODEX_CLIENT_VERSION,
  codexRateLimitsToReadings,
  createCodexAppServerAdapter,
  normalizeCodexResetsAt,
  readCodexAppServerCapacity,
  readCodexRateLimits,
  refreshCodexCapacityFromAppServer,
  refreshCodexCapacityIfStale,
} from "./codex-app-server.js";
import { normalizeAdapterWindow } from "./adapter.js";
const { migrate } = await import("../db/index.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);
const { createAgent } = await import("../repository/agents.js");
const {
  clearAllRuntimeAvailability,
  runtimeAvailability,
} = await import("../repository/runtime-availability.js");
const { refreshCapacityFromAdapters } = await import("./service.js");

const FAKE = new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).pathname;

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
        FAKE_CODEX_MODE: mode,
        FAKE_CODEX_NOW_MS: String(now),
        ...(extra.env as Record<string, string> | undefined),
      },
      timeoutMs: (extra.timeoutMs as number | undefined) ?? 10_000,
      nowMs: now,
    },
  };
}

test("rateLimits windows keep identity, percent, duration, and reset", () => {
  const now = Date.now();
  const parsed = codexRateLimitsToReadings(
    {
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 7200 },
        secondary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: new Date(now + 3 * 86400_000).toISOString() },
      },
    },
    new Date(now).toISOString()
  );
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 2);
  const primary = parsed.windows.find((w) => w.providerBucket === "primary")!;
  assert.equal(primary.windowKey, "codex_rate_limit_primary");
  assert.equal(primary.durationMinutes, 300);
  assert.equal(primary.usedPercent, 40);
  assert.equal(primary.resetAt, new Date((Math.floor(now / 1000) + 7200) * 1000).toISOString());
  const normalized = normalizeAdapterWindow("codex_local", primary, now);
  assert.equal(normalized.displayLabel, "5H");
  assert.equal(normalized.remainingPercent, 60);
  const secondary = parsed.windows.find((w) => w.providerBucket === "secondary")!;
  assert.equal(normalizeAdapterWindow("codex_local", secondary, now).displayLabel, "1W");
  assert.equal(normalizeAdapterWindow("codex_local", secondary, now).remainingPercent, 87.5);
});

test("rateLimitsByLimitId buckets never overwrite each other or rateLimits", () => {
  const parsed = codexRateLimitsToReadings({
    rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      team_a: {
        limitId: "team_a",
        limitName: "Team A",
        primary: { usedPercent: 70, windowDurationMins: 300 },
        secondary: { usedPercent: 5, windowDurationMins: 10080 },
      },
      team_b: {
        limitId: "team_b",
        limitName: "Team B",
        primary: { usedPercent: 90, windowDurationMins: 300 },
        secondary: { usedPercent: 25, windowDurationMins: 10080 },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 5);
  const keys = parsed.windows.map((w) => w.windowKey);
  assert.equal(new Set(keys).size, 5);
  assert.ok(keys.includes("codex_rate_limit_primary"));
  assert.ok(keys.includes("codex_limit_team_a_primary"));
  assert.ok(keys.includes("codex_limit_team_a_secondary"));
  assert.ok(keys.includes("codex_limit_team_b_primary"));
  assert.ok(keys.includes("codex_limit_team_b_secondary"));
  const aPrimary = parsed.windows.find((w) => w.windowKey === "codex_limit_team_a_primary")!;
  assert.equal(aPrimary.providerBucket, "team_a/primary");
  assert.equal(aPrimary.providerLabel, "Team A");
  assert.equal(aPrimary.usedPercent, 70);
});

test("nested bucket windows keep per-limit identity when limitId is only the map key", () => {
  const parsed = codexRateLimitsToReadings({
    rateLimitsByLimitId: {
      legacy_key: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]!.windowKey, "codex_limit_legacy_key_primary");
  assert.equal(parsed.windows[0]!.providerBucket, "legacy_key/primary");
});

test("flat legacy buckets without nested windows still parse", () => {
  const parsed = codexRateLimitsToReadings({
    rateLimitsByLimitId: {
      flat_bucket: { usedPercent: 33, windowDurationMins: 300 },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]!.windowKey, "codex_limit_flat_bucket");
  assert.equal(parsed.windows[0]!.providerBucket, "flat_bucket");
});

test("resetsAt accepts epoch seconds, ms, and ISO; rejects garbage", () => {
  const iso = "2026-09-20T12:00:00.000Z";
  const epochSec = Math.floor(Date.parse(iso) / 1000);
  assert.equal(normalizeCodexResetsAt(epochSec), iso);
  assert.equal(normalizeCodexResetsAt(epochSec * 1000), iso);
  assert.equal(normalizeCodexResetsAt(iso), iso);
  assert.equal(normalizeCodexResetsAt("garbage"), null);
  assert.equal(normalizeCodexResetsAt(null), null);
  assert.equal(normalizeCodexResetsAt(-5), null);
});

test("payloads without a usable window read unparsable, not empty", () => {
  assert.equal(codexRateLimitsToReadings(null), null);
  assert.equal(codexRateLimitsToReadings({ nonsense: true }), null);
  assert.equal(
    codexRateLimitsToReadings({ rateLimits: { primary: { windowDurationMins: 300 } } }),
    null
  );
});

test("only read methods can be sent; model turns throw before write", () => {
  assertReadOnlyMethod("initialize");
  assertReadOnlyMethod("account/rateLimits/read");
  for (const m of ["turn/start", "thread/start", "thread/resume", "account/read"]) {
    assert.throws(() => assertReadOnlyMethod(m), /refusing non-read method/);
  }
});

test("fake server 300/10080-min windows become 5H/1W snapshots end to end", async () => {
  clearAllCapacitySnapshots();
  const { now, opts } = fakeOpts("ok");
  const snap = await refreshCapacityFromAdapters([createCodexAppServerAdapter(opts)], now);
  const codex = snap.runtimes.find((r) => r.runtime === "codex_local")!;
  assert.ok(codex, "codex_local entry exists");
  assert.equal(codex.unavailableReason, null);
  // primary + secondary + two nested limit buckets × (primary + secondary).
  assert.equal(codex.windows.length, 6);
  const fiveHour = codex.windows.find((w) => w.windowKey === "codex_rate_limit_primary")!;
  const weekly = codex.windows.find((w) => w.windowKey === "codex_rate_limit_secondary")!;
  assert.equal(fiveHour.displayLabel, "5H");
  assert.equal(fiveHour.remainingPercent, 60);
  assert.equal(fiveHour.resetAt, new Date(Math.floor((now + 2 * 3600_000) / 1000) * 1000).toISOString());
  assert.equal(weekly.displayLabel, "1W");
  assert.equal(weekly.remainingPercent, 87.5);
  assert.equal(weekly.resetAt, new Date(Math.floor((now + 3 * 86400_000) / 1000) * 1000).toISOString());
  const mainPrimary = codex.windows.find((w) => w.windowKey === "codex_limit_main_primary")!;
  assert.equal(mainPrimary.providerBucket, "main/primary");
  assert.equal(mainPrimary.displayLabel, "5H");
  assert.equal(mainPrimary.remainingPercent, 30);
  assert.equal(
    mainPrimary.resetAt,
    new Date(Math.floor((now + 1 * 3600_000) / 1000) * 1000).toISOString()
  );
  const mainSecondary = codex.windows.find((w) => w.windowKey === "codex_limit_main_secondary")!;
  assert.equal(mainSecondary.providerBucket, "main/secondary");
  assert.equal(mainSecondary.displayLabel, "1W");
  assert.equal(mainSecondary.remainingPercent, 95);
  const extraPrimary = codex.windows.find((w) => w.windowKey === "codex_limit_extra_primary")!;
  assert.equal(extraPrimary.remainingPercent, 10);
  const extraSecondary = codex.windows.find((w) => w.windowKey === "codex_limit_extra_secondary")!;
  assert.equal(extraSecondary.remainingPercent, 75);
});

test("initialize handshake carries a versioned client identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-codex-handshake-"));
  const recordPath = path.join(dir, "methods.jsonl");
  const { opts } = fakeOpts("ok", { env: { FAKE_CODEX_RECORD: recordPath } });
  await readCodexRateLimits(opts);
  const lines = fs
    .readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method: string; params?: { clientInfo?: Record<string, unknown> } });
  const init = lines.find((l) => l.method === "initialize");
  assert.ok(init, "handshake recorded");
  assert.equal(init.params?.clientInfo?.name, "agent-dealer");
  assert.equal(init.params?.clientInfo?.version, CODEX_CLIENT_VERSION);
});

test("a successful refresh clears a previously stored failure sentinel", async () => {
  clearAllCapacitySnapshots();
  const crashed = fakeOpts("crash");
  await refreshCodexCapacityFromAppServer(crashed.opts);
  const sentinel = listCapacitySnapshots("codex_local").find(
    (w) => w.windowKey === "codex_account_rate_limits"
  );
  assert.ok(sentinel, "failure sentinel stored");
  assert.equal(sentinel.unavailableReason, "missing");
  const { opts } = fakeOpts("ok");
  await refreshCodexCapacityFromAppServer(opts);
  const rows = listCapacitySnapshots("codex_local");
  assert.ok(
    !rows.some((w) => w.windowKey === "codex_account_rate_limits"),
    "stale N/A sentinel cleared next to fresh windows"
  );
  assert.equal(rows.length, 6);
});

test("stale Codex snapshots refresh on demand; fresh ones short-circuit", async () => {
  clearAllCapacitySnapshots();
  createAgent({
    name: "codex-on-demand",
    runtime: "codex_local",
    deckId: "33333333-3333-4333-8333-333333333333",
  });
  const { now, opts } = fakeOpts("ok");
  await refreshCodexCapacityIfStale(now, opts);
  assert.equal(listCapacitySnapshots("codex_local").length, 6);
  // Fresh snapshots short-circuit before any spawn: a bogus binary would fail,
  // so reaching here unchanged proves no subprocess ran.
  await refreshCodexCapacityIfStale(Date.now(), {
    command: "/nonexistent/codex-app-server-xyz",
    timeoutMs: 2000,
  });
  assert.equal(listCapacitySnapshots("codex_local").length, 6);
});

test("concurrent stale refreshes share one result without corrupting snapshots", async () => {
  clearAllCapacitySnapshots();
  const { now, opts } = fakeOpts("ok");
  await Promise.all([refreshCodexCapacityIfStale(now, opts), refreshCodexCapacityIfStale(now, opts)]);
  assert.equal(listCapacitySnapshots("codex_local").length, 6);
});

test("refresh opt-out performs no read and stores nothing", async () => {
  clearAllCapacitySnapshots();
  process.env.AGENT_DEALER_CODEX_CAPACITY_REFRESH = "off";
  try {
    const { now, opts } = fakeOpts("ok");
    await refreshCodexCapacityIfStale(now, opts);
    assert.equal(listCapacitySnapshots("codex_local").length, 0);
  } finally {
    delete process.env.AGENT_DEALER_CODEX_CAPACITY_REFRESH;
  }
});

test("updated notifications are consumed while the connection is alive", async () => {
  const { opts } = fakeOpts("ok");
  const read = await readCodexRateLimits(opts);
  assert.equal(read.failure, null);
  assert.equal(read.updates.length, 1);
});

test("protocol traffic is read-only: no thread, turn, or exec method", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-codex-record-"));
  const recordPath = path.join(dir, "methods.jsonl");
  const { opts } = fakeOpts("ok", { env: { FAKE_CODEX_RECORD: recordPath } });
  await readCodexAppServerCapacity(opts);
  const methods = fs
    .readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => String(JSON.parse(l).method));
  assert.ok(methods.length >= 2, `expected handshake + read, got ${methods}`);
  for (const m of methods) {
    assert.ok(
      ["initialize", "initialized", "account/rateLimits/read"].includes(m),
      `unexpected method ${m}`
    );
    assert.ok(!/thread|turn|exec|message/i.test(m), `billable method ${m}`);
  }
});

async function expectUnavailable(
  mode: string,
  reason: "missing" | "unparsable" | "unsupported",
  extra: Record<string, unknown> = {}
): Promise<void> {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  const { now, opts } = fakeOpts(mode, extra);
  const result = await readCodexAppServerCapacity(opts);
  assert.equal(result.runtime, "codex_local");
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable.length, 1);
  assert.equal(result.unavailable[0]!.windowKey, "codex_account_rate_limits");
  assert.equal(result.unavailable[0]!.reason, reason);
  // Runtime health is untouched: no availability row, still available.
  assert.equal(runtimeAvailability("codex_local", now).available, true);
}

test("failure modes return explicit N/A without affecting runtime health", async () => {
  await expectUnavailable("crash", "missing");
  await expectUnavailable("auth-error", "missing");
  await expectUnavailable("exit-nonzero", "missing");
  await expectUnavailable("hang", "missing", { timeoutMs: 300 });
  await expectUnavailable("malformed", "unparsable");
  await expectUnavailable("no-method", "unsupported");
});

test("missing binary reads missing without throwing", async () => {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  const now = Date.now();
  const result = await readCodexAppServerCapacity({
    command: "/nonexistent/codex-app-server-xyz",
    timeoutMs: 2000,
    nowMs: now,
  });
  assert.equal(result.windows.length, 0);
  assert.equal(result.unavailable[0]!.reason, "missing");
  assert.equal(runtimeAvailability("codex_local", now).available, true);
});

test("no token or raw account payload reaches the adapter output", async () => {
  const { opts } = fakeOpts("ok");
  const result = await readCodexAppServerCapacity(opts);
  const raw = JSON.stringify(result);
  for (const secret of ["token", "Bearer", "auth.json", "sk-", "password"]) {
    assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
  const refs = result.windows.map((w) => w.evidenceRef);
  assert.ok(refs.every((r) => r === "codex-app-server:account/rateLimits/read"));
});

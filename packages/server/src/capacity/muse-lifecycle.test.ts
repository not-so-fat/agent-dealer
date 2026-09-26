// packages/server/src/capacity/muse-lifecycle.test.ts
//
// NOT-269: deterministic lifecycle contract for Muse 5H/1W acquisition.
// Evidence: docs/research/NOT-269-muse-5h-1w-lifecycle.md (Muse Code 1.4.0,
// stable schema fingerprint sha256:36466f63…, live fresh-host + session-log +
// echo-exec probes). Fake-subprocess coverage only — never a live provider
// request, never account data: all payload values below are synthetic
// redacted stand-ins (obviously-fake percents), asserting shapes and the
// user contract (Muse primary capacity is exactly 5H + 1W).
//
// Proven rules encoded here:
// - a conforming observation always carries the window+weekly pair;
// - a partial observation never fabricates the missing half;
// - the first observation arrives as a `usage/changed` notification;
// - a fresh/unobserved host reads `missing` (restart is fresh — the client
//   holds no cross-process usage state);
// - resume/turn methods are refused before write, so refresh can never
//   manufacture a billable call.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertMuseReadOnlyMethod,
  museUsageToReadings,
  readMuseCapacity,
  requestMuseUsage,
} from "./muse.js";
import { normalizeAdapterWindow } from "./adapter.js";

const FAKE = new URL("./fixtures/fake-muse-serve.mjs", import.meta.url).pathname;

function fakeOpts(mode: string) {
  const now = Date.now();
  return {
    command: process.execPath,
    args: [FAKE],
    env: { META_API_KEY: "test-fake-key", FAKE_MSP_MODE: mode, FAKE_MSP_NOW_MS: String(now) },
    timeoutMs: 10_000,
    nowMs: now,
  };
}

/** Synthetic redacted stand-in for a conforming observation (not account data). */
function syntheticFullPair(now: number) {
  return {
    protocol: "msp/1.3",
    usage: {
      observedAtMs: now,
      tier: "synthetic-stand-in",
      window: { usedPercent: 42, resetsAtMs: now + 2 * 3600_000, windowDurationMins: 300 },
      weekly: { usedPercent: 17, resetsAtMs: now + 3 * 24 * 3600_000 },
    },
  };
}

test("lifecycle: a full observation carries exactly the 5H+1W pair", () => {
  const now = Date.now();
  const parsed = museUsageToReadings(syntheticFullPair(now), new Date(now).toISOString());
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 2);
  const labels = parsed.windows
    .map((w) => normalizeAdapterWindow("muse_code", w, now).displayLabel)
    .sort();
  assert.deepEqual(labels, ["1W", "5H"]);
  const rolling = parsed.windows.find((w) => w.windowKey === "rolling_all_models")!;
  const weekly = parsed.windows.find((w) => w.windowKey === "weekly_all_models")!;
  assert.equal(normalizeAdapterWindow("muse_code", rolling, now).remainingPercent, 58);
  assert.equal(normalizeAdapterWindow("muse_code", weekly, now).remainingPercent, 83);
  assert.equal(rolling.criticalRole, "five_hour");
  assert.equal(weekly.criticalRole, "weekly");
});

test("lifecycle: a partial observation never fabricates the missing half", () => {
  const now = Date.now();
  const parsed = museUsageToReadings(
    {
      usage: {
        observedAtMs: now,
        window: { usedPercent: 42, resetsAtMs: now + 3600_000, windowDurationMins: 300 },
      },
    },
    new Date(now).toISOString()
  );
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]!.windowKey, "rolling_all_models");
});

test("lifecycle: the first observation arrives as usage/changed with the pair", async () => {
  const read = await requestMuseUsage(fakeOpts("full"));
  assert.equal(read.failure, null);
  assert.equal(read.updates.length, 1);
  // Stable schema refs SubscriptionUsage directly at
  // /notifications/usage/changed/params — not wrapped in {usage}.
  const params = read.updates[0] as Record<string, unknown>;
  assert.ok(params && typeof params === "object");
  assert.deepEqual(Object.keys(params).sort(), ["observedAtMs", "tier", "weekly", "window"]);
});

test("lifecycle: a fresh host with no observation reads missing — twice", async () => {
  for (let i = 0; i < 2; i++) {
    const result = await readMuseCapacity(fakeOpts("missing"));
    assert.equal(result.windows.length, 0);
    assert.equal(result.unavailable.length, 1);
    assert.equal(result.unavailable[0]!.windowKey, "muse_account_usage");
    assert.equal(result.unavailable[0]!.reason, "missing");
  }
});

test("lifecycle: refresh can never manufacture a session, turn, or prompt", () => {
  for (const m of ["session/start", "session/resume", "session/prompt", "turn/start", "exec"]) {
    assert.throws(() => assertMuseReadOnlyMethod(m), /refusing non-read method/);
  }
});

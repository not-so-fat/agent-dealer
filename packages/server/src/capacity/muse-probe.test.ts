// Default-on one-hour Muse capacity fallback. Fake MSP host only: no live
// provider request and no paid model call in this suite.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-probe-"));

import { MuseCapacityHost } from "./muse-host.js";
import {
  hasFreshMuseCapacityPair,
  isMusePaidFallbackEnabled,
  maybeProbeMuseCapacity,
  MUSE_CAPACITY_PROBE_SERVE_ARGV,
  MUSE_CAPACITY_REFRESH_ENV,
  resetMuseCapacityProbeStateForTests,
  runMuseCapacityProbe,
} from "./muse-probe.js";
import { ingestMuseUsagePayload } from "./muse.js";

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { clearAllCapacitySnapshots, listCapacitySnapshots } = await import(
  "../repository/runtime-capacity.js"
);

const FAKE = new URL("./fixtures/fake-muse-serve.mjs", import.meta.url).pathname;

function hostOpts(mode: string, extraEnv: Record<string, string> = {}) {
  const now = Date.now();
  return {
    command: process.execPath,
    args: [FAKE],
    env: {
      META_API_KEY: "test-fake-key",
      FAKE_MSP_MODE: mode,
      FAKE_MSP_NOW_MS: String(now),
      ...extraEnv,
    },
    timeoutMs: 10_000,
  };
}

function payload(nowMs: number, roles: "both" | "five_hour" = "both") {
  return {
    usage: {
      observedAtMs: nowMs,
      tier: "synthetic",
      window: {
        usedPercent: 25,
        resetsAtMs: nowMs + 2 * 3600_000,
        windowDurationMins: 300,
      },
      ...(roles === "both"
        ? { weekly: { usedPercent: 40, resetsAtMs: nowMs + 3 * 24 * 3600_000 } }
        : {}),
    },
  };
}

function recordedMethods(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => String((JSON.parse(line) as { method?: unknown }).method ?? ""));
}

beforeEach(() => {
  migrate();
  clearAllCapacitySnapshots();
  resetMuseCapacityProbeStateForTests();
  delete process.env[MUSE_CAPACITY_REFRESH_ENV];
  delete process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS;
  const existing = createAgent({
    name: `muse-probe-${Date.now()}-${Math.random()}`,
    runtime: "muse_code",
    deckId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(existing.runtime, "muse_code");
});

test("fallback defaults on; explicit off and unrecognized values disable spending", async () => {
  for (const value of [undefined, "", "paid-after-1h"] as const) {
    if (value === undefined) delete process.env[MUSE_CAPACITY_REFRESH_ENV];
    else process.env[MUSE_CAPACITY_REFRESH_ENV] = value;
    assert.equal(isMusePaidFallbackEnabled(), true);
  }
  for (const value of ["off", "auto", "paid-after-1h "] as const) {
    process.env[MUSE_CAPACITY_REFRESH_ENV] = value;
    assert.equal(isMusePaidFallbackEnabled(), false);
    assert.deepEqual(await maybeProbeMuseCapacity(Date.now()), {
      probed: false,
      reason: "disabled",
    });
  }
});

test("legacy refresh off remains no-spend unless paid fallback is explicitly enabled", () => {
  process.env.AGENT_DEALER_MUSE_CAPACITY_REFRESH_MS = "off";
  delete process.env[MUSE_CAPACITY_REFRESH_ENV];
  assert.equal(isMusePaidFallbackEnabled(), false);
  process.env[MUSE_CAPACITY_REFRESH_ENV] = "paid-after-1h";
  assert.equal(isMusePaidFallbackEnabled(), true);
});

test("a complete pair under one hour suppresses the fallback", async () => {
  const now = Date.now();
  await ingestMuseUsagePayload(payload(now - 59 * 60_000));
  assert.equal(hasFreshMuseCapacityPair(now), true);
  assert.deepEqual(await maybeProbeMuseCapacity(now), { probed: false, reason: "fresh" });
});

test("one missing half triggers one minimal turn and stores exactly 5H plus 1W", async () => {
  const now = Date.now();
  await ingestMuseUsagePayload(payload(now - 5 * 60_000, "five_hour"));
  assert.equal(hasFreshMuseCapacityPair(now), false, "a fresh half is not a complete pair");
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  try {
    const outcome = await maybeProbeMuseCapacity(now, { host, timeoutMs: 10_000 });
    assert.equal(outcome.probed, true);
    assert.equal(outcome.reason, "completed");
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.windowsUpdated?.sort(), ["rolling_all_models", "weekly_all_models"]);
    const roles = listCapacitySnapshots("muse_code")
      .filter((w) => w.criticalRole !== null)
      .map((w) => w.criticalRole)
      .sort();
    assert.deepEqual(roles, ["five_hour", "weekly"]);
  } finally {
    await host.shutdown();
  }
});

test("concurrent stale readers single-flight one turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-muse-probe-record-"));
  const record = path.join(dir, "methods.jsonl");
  const host = new MuseCapacityHost(
    hostOpts("serve-turn-full", { FAKE_MSP_RECORD: record })
  );
  try {
    const now = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => maybeProbeMuseCapacity(now, { host, timeoutMs: 10_000 }))
    );
    assert.equal(outcomes.filter((o) => o.reason === "completed").length, 1);
    assert.equal(outcomes.filter((o) => o.reason === "shared").length, 4);
    assert.ok(outcomes.every((o) => o.probed && o.ok));
    assert.equal(recordedMethods(record).filter((m) => m === "turn/start").length, 1);
  } finally {
    await host.shutdown();
  }
});

test("failed admission preserves rows and enters hourly backoff", async () => {
  const now = Date.now();
  await ingestMuseUsagePayload(payload(now - 61 * 60_000));
  const before = listCapacitySnapshots("muse_code").map((w) => ({
    key: w.windowKey,
    remaining: w.remainingPercent,
    observedAt: w.observedAt,
  }));
  const host = new MuseCapacityHost(hostOpts("serve-turn-rejected"));
  try {
    const first = await maybeProbeMuseCapacity(now, { host, timeoutMs: 10_000 });
    assert.equal(first.probed, true);
    assert.equal(first.ok, false);
    assert.equal(first.failureKind, "unadmitted");
    assert.deepEqual(await maybeProbeMuseCapacity(now + 60_000, { host, timeoutMs: 10_000 }), {
      probed: false,
      reason: "backoff",
    });
    assert.deepEqual(
      listCapacitySnapshots("muse_code").map((w) => ({
        key: w.windowKey,
        remaining: w.remainingPercent,
        observedAt: w.observedAt,
      })),
      before
    );
  } finally {
    await host.shutdown();
  }
});

test("production probe host disables shell/write and keeps restricted network", () => {
  assert.deepEqual([...MUSE_CAPACITY_PROBE_SERVE_ARGV], [
    "serve",
    "--sandbox-network",
    "restricted",
    "--disable-write",
    "--disable-shell",
  ]);
});

test("direct probe success requires the complete pair", async () => {
  const host = new MuseCapacityHost(hostOpts("serve-turn-full"));
  try {
    const result = await runMuseCapacityProbe(Date.now(), { host, timeoutMs: 10_000 });
    assert.equal(result.ok, true);
    assert.equal(result.admitted, true);
    assert.equal(result.failureKind, null);
  } finally {
    await host.shutdown();
  }
});

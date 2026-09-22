// packages/server/src/capacity/service.test.ts
//
// NOT-245: one entry per configured runtime account; multiple independently
// resetting windows; stale/unsupported/missing/past-reset all read N/A with
// distinct reasons.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-cap-svc-"));

const { migrate } = await import("../db/index.js");
const { createAgent } = await import("../repository/agents.js");
const { clearAllCapacitySnapshots } = await import("../repository/runtime-capacity.js");
const {
  fixtureMultiWindowAdapter,
  fixtureStaleAdapter,
  fixtureUnsupportedAdapter,
} = await import("./adapter.js");
const {
  configuredCapacityRuntimes,
  getRuntimeCapacitySnapshot,
  refreshCapacityFromAdapters,
} = await import("./service.js");

before(() => {
  migrate();
});

function seedAgents(): void {
  // Two profiles sharing one runtime account (claude_code) plus one cursor profile.
  createAgent({
    name: "cap-a",
    runtime: "claude_code",
    deckId: "11111111-1111-4111-8111-111111111111",
  });
  createAgent({
    name: "cap-b",
    runtime: "claude_code",
    deckId: "22222222-2222-4222-8222-222222222222",
  });
  createAgent({
    name: "cap-c",
    runtime: "cursor_local",
    deckId: "33333333-3333-4333-8333-333333333333",
  });
}

test("two profiles sharing one runtime produce one capacity entry", async () => {
  clearAllCapacitySnapshots();
  seedAgents();
  // Builtin seeded agents may add runtimes; the point is claude_code appears
  // once despite two profiles sharing the account.
  const configured = configuredCapacityRuntimes();
  assert.ok(configured.includes("claude_code"));
  assert.ok(configured.includes("cursor_local"));
  assert.equal(configured.filter((r) => r === "claude_code").length, 1);
  const now = Date.now();
  const snap = await refreshCapacityFromAdapters(
    [fixtureMultiWindowAdapter(now), fixtureUnsupportedAdapter(now)],
    now
  );
  assert.equal(snap.runtimes.filter((r) => r.runtime === "claude_code").length, 1);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.unavailableReason, null);
  assert.equal(claude.windows.length, 2);
  assert.ok(claude.windows.every((w) => w.unavailableReason === null));
});

test("multiple windows reset independently with normalized percents", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const snap = await refreshCapacityFromAdapters([fixtureMultiWindowAdapter(now)], now);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  const fiveHour = claude.windows.find((w) => w.windowKey === "five_hour")!;
  const weekly = claude.windows.find((w) => w.windowKey === "weekly")!;
  // 50% used → 50 remaining; 0.35 fraction → 65 remaining.
  assert.equal(fiveHour.remainingPercent, 50);
  assert.equal(weekly.remainingPercent, 65);
  assert.equal(fiveHour.displayLabel, "5H");
  assert.equal(weekly.displayLabel, "1W");
  assert.notEqual(fiveHour.resetAt, weekly.resetAt);
});

test("stale, unsupported, and missing render N/A with distinct reasons", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const snap = await refreshCapacityFromAdapters(
    [fixtureStaleAdapter(now), fixtureUnsupportedAdapter(now)],
    now
  );
  const codex = snap.runtimes.find((r) => r.runtime === "codex_local")!;
  assert.equal(codex.windows[0].remainingPercent, null);
  assert.equal(codex.windows[0].unavailableReason, "expired");
  assert.equal(codex.unavailableReason, "expired");
  const cursor = snap.runtimes.find((r) => r.runtime === "cursor_local")!;
  assert.equal(cursor.unavailableReason, "unsupported");
  // Configured but never observed → missing.
  const fresh = getRuntimeCapacitySnapshot(now);
  const claude = fresh.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows.length, 0);
  assert.equal(claude.unavailableReason, "missing");
});

test("a payload without a usable scale reads N/A (unparsable)", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const { recordCapacitySnapshots } = await import("../repository/runtime-capacity.js");
  const { normalizeAdapterWindow } = await import("./adapter.js");
  const normalized = normalizeAdapterWindow(
    "claude_code",
    {
      windowKey: "weekly",
      providerBucket: "all_models",
      durationMinutes: 10080,
      providerLabel: "weekly",
      usedValue: 12,
      usedUnit: "credits",
      resetAt: new Date(now + 3600_000).toISOString(),
      observedAt: new Date(now - 60_000).toISOString(),
      source: "experimental_api",
    },
    now
  );
  assert.equal(normalized.remainingPercent, null);
  assert.equal(normalized.unavailableReason, "unparsable");
  recordCapacitySnapshots("claude_code", [
    {
      windowKey: normalized.windowKey,
      providerBucket: normalized.providerBucket,
      durationMinutes: normalized.durationMinutes,
      displayLabel: normalized.displayLabel,
      usedValue: normalized.usedValue,
      usedUnit: normalized.usedUnit,
      remainingPercent: normalized.remainingPercent,
      resetAt: normalized.resetAt,
      observedAt: normalized.observedAt,
      freshUntil: normalized.freshUntil,
      expiresAt: normalized.expiresAt,
      source: normalized.source,
      unavailableReason: normalized.unavailableReason,
    },
  ]);
  const snap = getRuntimeCapacitySnapshot(now);
  const claude = snap.runtimes.find((r) => r.runtime === "claude_code")!;
  assert.equal(claude.windows[0].remainingPercent, null);
  assert.equal(claude.windows[0].unavailableReason, "unparsable");
  assert.equal(claude.unavailableReason, "unparsable");
});

test("a past reset time is never presented as current capacity", async () => {
  clearAllCapacitySnapshots();
  const now = Date.now();
  const { recordCapacitySnapshots } = await import("../repository/runtime-capacity.js");
  recordCapacitySnapshots("muse_code", [
    {
      windowKey: "weekly",
      providerBucket: "all_models",
      durationMinutes: 10080,
      displayLabel: "1W",
      usedValue: 10,
      usedUnit: "percent",
      remainingPercent: 90,
      resetAt: new Date(now - 1000).toISOString(),
      observedAt: new Date(now - 60_000).toISOString(),
      freshUntil: new Date(now + 600_000).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
      source: "supported_protocol",
    },
  ]);
  const snap = getRuntimeCapacitySnapshot(now);
  const muse = snap.runtimes.find((r) => r.runtime === "muse_code")!;
  assert.equal(muse.windows[0].remainingPercent, null);
  assert.equal(muse.windows[0].unavailableReason, "expired");
  assert.equal(muse.unavailableReason, "expired");
});

// packages/server/src/repository/runtime-capacity.test.ts
//
// NOT-245: capacity snapshots persist per (runtime, window) without touching
// the NOT-111 hard-cap table.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-capacity-"));

const { migrate } = await import("../db/index.js");
const {
  capacityRuntimes,
  clearAllCapacitySnapshots,
  listAllCapacitySnapshots,
  listCapacitySnapshots,
  recordCapacitySnapshots,
} = await import("./runtime-capacity.js");
const { clearAllRuntimeAvailability, recordRuntimeAvailability, runtimeAvailability } =
  await import("./runtime-availability.js");

before(() => {
  migrate();
});

function nowIso(): string {
  return new Date().toISOString();
}

test("upserts per (runtime, window) and keeps sibling windows on partial writes", () => {
  clearAllCapacitySnapshots();
  recordCapacitySnapshots("claude_code", [
    {
      windowKey: "weekly",
      providerBucket: "all_models",
      durationMinutes: 10080,
      displayLabel: "1W",
      usedValue: 35,
      usedUnit: "percent",
      remainingPercent: 65,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
      observedAt: nowIso(),
      source: "supported_protocol",
    },
    {
      windowKey: "five_hour",
      providerBucket: "all_models",
      durationMinutes: 300,
      displayLabel: "5H",
      usedValue: 0.5,
      usedUnit: "fraction",
      remainingPercent: 50,
      resetAt: new Date(Date.now() + 1800_000).toISOString(),
      observedAt: nowIso(),
      source: "supported_protocol",
      criticalRole: "five_hour",
    },
  ]);
  // Partial re-observation updates one window and leaves the sibling alone.
  recordCapacitySnapshots("claude_code", [
    {
      windowKey: "weekly",
      providerBucket: "all_models",
      durationMinutes: 10080,
      displayLabel: "1W",
      usedValue: 40,
      usedUnit: "percent",
      remainingPercent: 60,
      observedAt: nowIso(),
      source: "supported_protocol",
    },
  ]);
  const windows = listCapacitySnapshots("claude_code");
  assert.equal(windows.length, 2);
  assert.equal(windows.find((w) => w.windowKey === "weekly")?.remainingPercent, 60);
  assert.equal(windows.find((w) => w.windowKey === "five_hour")?.remainingPercent, 50);
  // criticalRole round-trips through the DB; a window that never set it reads null.
  assert.equal(windows.find((w) => w.windowKey === "five_hour")?.criticalRole, "five_hour");
  assert.equal(windows.find((w) => w.windowKey === "weekly")?.criticalRole, null);
  assert.deepEqual(capacityRuntimes(), ["claude_code"]);
  assert.equal(listAllCapacitySnapshots().length, 2);
});

test("capacity writes never weaken runtime_availability hard caps", () => {
  clearAllCapacitySnapshots();
  clearAllRuntimeAvailability();
  recordRuntimeAvailability({
    runtime: "codex_local",
    unavailableUntil: new Date(Date.now() + 3600_000).toISOString(),
    reason: "cap observed",
  });
  recordCapacitySnapshots("codex_local", [
    {
      windowKey: "weekly",
      providerBucket: "all_models",
      displayLabel: "weekly",
      remainingPercent: 80,
      observedAt: nowIso(),
      source: "observed_event",
    },
  ]);
  const cap = runtimeAvailability("codex_local");
  assert.equal(cap.available, false);
  clearAllCapacitySnapshots();
  // Clearing capacity must not clear the hard cap.
  assert.equal(runtimeAvailability("codex_local").available, false);
  clearAllRuntimeAvailability();
});

// packages/server/src/repository/admission-settings.test.ts
//
// NOT-215: validation, persistence, and ceiling clamping of `maxActiveIssues`.
// NOT-378: the configurable range widens to 1–5 with a five-process default ceiling.

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-admission-settings-"));

const { migrate, getDb } = await import("../db/index.js");
const {
  ADMISSION_MAX_ACTIVE_ISSUES_KEY,
  DEFAULT_MAX_ACTIVE_ISSUES,
  MAX_ACTIVE_ISSUES_HARD_MAX,
  getMaxActiveIssues,
  setMaxActiveIssues,
  getEffectiveMaxActiveIssues,
  admissionLimitOptions,
  workerSpawnCeiling,
} = await import("./admission-settings.js");
const { coordinatorConfig } = await import("../coordinator/worker-loop.js");
const { maxConcurrentSpawns } = await import("../runners/process-registry.js");

before(() => migrate());

const savedEnv = {
  MAX_COORDINATOR_CONCURRENCY: process.env.MAX_COORDINATOR_CONCURRENCY,
  MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS,
};

beforeEach(() => {
  getDb().prepare("DELETE FROM intake_settings WHERE key = ?").run(ADMISSION_MAX_ACTIVE_ISSUES_KEY);
  delete process.env.MAX_COORDINATOR_CONCURRENCY;
  delete process.env.MAX_CONCURRENT_RUNS;
});

afterEach(() => {
  getDb().prepare("DELETE FROM intake_settings WHERE key = ?").run(ADMISSION_MAX_ACTIVE_ISSUES_KEY);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("NOT-378: the default stays 1 while the hard maximum widens to 5", () => {
  assert.equal(DEFAULT_MAX_ACTIVE_ISSUES, 1);
  assert.equal(MAX_ACTIVE_ISSUES_HARD_MAX, 5);
  assert.equal(getMaxActiveIssues(), 1);
  assert.equal(getEffectiveMaxActiveIssues(), 1);
});

test("persisted value survives re-read (page reload / server restart read the same DB row)", () => {
  assert.equal(setMaxActiveIssues(5), 5);
  assert.equal(getMaxActiveIssues(), 5);
  assert.equal(getEffectiveMaxActiveIssues(), 5);
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(ADMISSION_MAX_ACTIVE_ISSUES_KEY) as { value_json: string };
  assert.equal(row.value_json, "5");
});

test("every integer 1–5 persists and reads back", () => {
  for (const value of [1, 2, 3, 4, 5]) {
    assert.equal(setMaxActiveIssues(value), value);
    assert.equal(getMaxActiveIssues(), value);
    assert.equal(getEffectiveMaxActiveIssues(), value);
  }
});

test("an existing persisted value (e.g. 2) is unchanged after upgrade", () => {
  getDb()
    .prepare(
      "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
    )
    .run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, "2");
  assert.equal(getMaxActiveIssues(), 2);
  assert.equal(getEffectiveMaxActiveIssues(), 2);
  assert.deepEqual(admissionLimitOptions(), [1, 2, 3, 4, 5]);
});

test("corrupt or out-of-range stored values fall back to the default", () => {
  const upsert = getDb().prepare(
    "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  );
  upsert.run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, "not-json");
  assert.equal(getMaxActiveIssues(), 1);
  upsert.run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, "99");
  assert.equal(getMaxActiveIssues(), 1);
  upsert.run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, "0");
  assert.equal(getMaxActiveIssues(), 1);
  upsert.run(ADMISSION_MAX_ACTIVE_ISSUES_KEY, "6");
  assert.equal(getMaxActiveIssues(), 1);
});

test("validation rejects non-integers and values outside 1..5", () => {
  for (const bad of [0, 6, 99, 1.5, NaN, "x", null, undefined, {}]) {
    assert.throws(() => setMaxActiveIssues(bad), /maxActiveIssues/, `rejects ${String(bad)}`);
  }
  assert.equal(getMaxActiveIssues(), 1, "a rejected write leaves the stored value alone");
});

test("range rejection names the exact 1–5 bounds", () => {
  assert.throws(
    () => setMaxActiveIssues(0),
    /maxActiveIssues must be between 1 and 5/
  );
  assert.throws(
    () => setMaxActiveIssues(6),
    /maxActiveIssues must be between 1 and 5/
  );
  assert.throws(
    () => setMaxActiveIssues(1.5),
    /maxActiveIssues must be an integer/
  );
});

test("values above the worker/spawn ceiling are rejected, never silently stored", () => {
  process.env.MAX_COORDINATOR_CONCURRENCY = "1";
  assert.equal(workerSpawnCeiling(), 1);
  assert.deepEqual(admissionLimitOptions(), [1]);
  assert.throws(
    () => setMaxActiveIssues(2),
    /maxActiveIssues 2 exceeds the effective worker\/spawn ceiling of 1/
  );
  assert.equal(getMaxActiveIssues(), 1);
});

test("NOT-378: the default ceiling is 5 with options 1–5 and no overrides", () => {
  assert.equal(workerSpawnCeiling(), 5);
  assert.deepEqual(admissionLimitOptions(), [1, 2, 3, 4, 5]);
});

test("NOT-378: a lower coordinator bound clamps the ceiling and options to 3", () => {
  process.env.MAX_COORDINATOR_CONCURRENCY = "3";
  assert.equal(workerSpawnCeiling(), 3);
  assert.deepEqual(admissionLimitOptions(), [1, 2, 3]);
  assert.equal(setMaxActiveIssues(3), 3);
  assert.throws(
    () => setMaxActiveIssues(4),
    /maxActiveIssues 4 exceeds the effective worker\/spawn ceiling of 3/
  );
  assert.equal(getMaxActiveIssues(), 3, "a rejected write leaves the stored value alone");
});

test("NOT-378: a lower spawn bound clamps the ceiling and options to 2", () => {
  process.env.MAX_CONCURRENT_RUNS = "2";
  assert.equal(workerSpawnCeiling(), 2);
  assert.deepEqual(admissionLimitOptions(), [1, 2]);
  assert.equal(setMaxActiveIssues(2), 2);
  assert.throws(
    () => setMaxActiveIssues(3),
    /maxActiveIssues 3 exceeds the effective worker\/spawn ceiling of 2/
  );
  assert.equal(getMaxActiveIssues(), 2, "a rejected write leaves the stored value alone");
});

test("the ceiling is the lower of the coordinator and spawn bounds", () => {
  assert.equal(workerSpawnCeiling(), 5);
  assert.deepEqual(admissionLimitOptions(), [1, 2, 3, 4, 5]);
  process.env.MAX_COORDINATOR_CONCURRENCY = "3";
  process.env.MAX_CONCURRENT_RUNS = "2";
  assert.equal(workerSpawnCeiling(), 2, "the minimum of the two bounds wins");
  assert.deepEqual(admissionLimitOptions(), [1, 2]);
  process.env.MAX_CONCURRENT_RUNS = "4";
  assert.equal(workerSpawnCeiling(), 3);
  assert.deepEqual(admissionLimitOptions(), [1, 2, 3]);
});

test("the effective limit clamps a persisted value when the ceiling drops below it", () => {
  assert.equal(setMaxActiveIssues(5), 5);
  process.env.MAX_CONCURRENT_RUNS = "1";
  assert.equal(getMaxActiveIssues(), 5, "persisted setting is untouched");
  assert.equal(getEffectiveMaxActiveIssues(), 1, "admission uses the clamped value");
});

test("NOT-378: authoritative runtime defaults agree on the five-process ceiling", () => {
  assert.equal(workerSpawnCeiling(), 5);
  assert.equal(coordinatorConfig.maxConcurrency, 5);
  assert.equal(maxConcurrentSpawns(), 5);
});

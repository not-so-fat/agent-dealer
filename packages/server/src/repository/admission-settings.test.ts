// packages/server/src/repository/admission-settings.test.ts
//
// NOT-215: validation, persistence, and ceiling clamping of `maxActiveIssues`.

import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-admission-settings-"));

const { migrate, getDb } = await import("../db/index.js");
const {
  ADMISSION_MAX_ACTIVE_ISSUES_KEY,
  getMaxActiveIssues,
  setMaxActiveIssues,
  getEffectiveMaxActiveIssues,
  admissionLimitOptions,
  workerSpawnCeiling,
} = await import("./admission-settings.js");

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

test("default is 1 for fresh installations (no stored row)", () => {
  assert.equal(getMaxActiveIssues(), 1);
  assert.equal(getEffectiveMaxActiveIssues(), 1);
});

test("persisted value survives re-read (page reload / server restart read the same DB row)", () => {
  assert.equal(setMaxActiveIssues(2), 2);
  assert.equal(getMaxActiveIssues(), 2);
  assert.equal(getEffectiveMaxActiveIssues(), 2);
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(ADMISSION_MAX_ACTIVE_ISSUES_KEY) as { value_json: string };
  assert.equal(row.value_json, "2");
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
});

test("validation rejects non-integers and values outside 1..2", () => {
  for (const bad of [0, 3, 99, 1.5, NaN, "x", null, undefined, {}]) {
    assert.throws(() => setMaxActiveIssues(bad), /maxActiveIssues/, `rejects ${String(bad)}`);
  }
  assert.equal(getMaxActiveIssues(), 1, "a rejected write leaves the stored value alone");
});

test("values above the worker/spawn ceiling are rejected, never silently stored", () => {
  process.env.MAX_COORDINATOR_CONCURRENCY = "1";
  assert.equal(workerSpawnCeiling(), 1);
  assert.deepEqual(admissionLimitOptions(), [1]);
  assert.throws(() => setMaxActiveIssues(2), /ceiling/);
  assert.equal(getMaxActiveIssues(), 1);
});

test("the ceiling is the lower of the coordinator and spawn bounds", () => {
  assert.equal(workerSpawnCeiling(), 2);
  assert.deepEqual(admissionLimitOptions(), [1, 2]);
  process.env.MAX_CONCURRENT_RUNS = "1";
  assert.equal(workerSpawnCeiling(), 1);
  assert.deepEqual(admissionLimitOptions(), [1]);
});

test("the effective limit clamps a persisted value when the ceiling drops below it", () => {
  assert.equal(setMaxActiveIssues(2), 2);
  process.env.MAX_CONCURRENT_RUNS = "1";
  assert.equal(getMaxActiveIssues(), 2, "persisted setting is untouched");
  assert.equal(getEffectiveMaxActiveIssues(), 1, "admission uses the clamped value");
});

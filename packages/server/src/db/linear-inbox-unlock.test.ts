import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-inbox-unlock-"));
delete process.env.LINEAR_STATE_FILTER;
delete process.env.LINEAR_TEAM_ID;

const { migrate, getDb, closeDb } = await import("./index.js");
const { isLegacyLinearStateFilterDefault } = await import("./index.js");

function readSetting(key: string): unknown {
  const row = getDb()
    .prepare("SELECT value_json FROM intake_settings WHERE key = ?")
    .get(key) as { value_json: string } | undefined;
  assert.ok(row, `expected setting ${key}`);
  return JSON.parse(row!.value_json);
}

function writeSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
    )
    .run(key, JSON.stringify(value));
}

function clearUnlockFlag(): void {
  getDb().prepare("DELETE FROM intake_settings WHERE key = ?").run("linear.inboxUnlockV1");
}

beforeEach(() => {
  closeDb();
  process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-inbox-unlock-"));
  delete process.env.LINEAR_STATE_FILTER;
  migrate();
});

afterEach(() => closeDb());

test("isLegacyLinearStateFilterDefault only matches the pre-unlock [Todo] default", () => {
  assert.equal(isLegacyLinearStateFilterDefault(["Todo"]), true);
  assert.equal(isLegacyLinearStateFilterDefault(["Todo", "Backlog"]), false);
  assert.equal(isLegacyLinearStateFilterDefault(["Backlog", "Todo", "In Progress", "In Review"]), false);
  assert.equal(isLegacyLinearStateFilterDefault("Todo"), false);
});

test("inbox unlock flips legacy assigneeMe true + [Todo] filter once", () => {
  clearUnlockFlag();
  writeSetting("linear.assigneeMe", true);
  writeSetting("linear.stateFilter", ["Todo"]);
  closeDb();
  migrate();

  assert.equal(readSetting("linear.assigneeMe"), false);
  assert.deepEqual(readSetting("linear.stateFilter"), ["Backlog", "Todo", "In Progress", "In Review"]);
  assert.equal(readSetting("linear.inboxUnlockV1"), true);
});

test("inbox unlock preserves customized assigneeMe false and Todo+Backlog filter", () => {
  clearUnlockFlag();
  writeSetting("linear.assigneeMe", false);
  writeSetting("linear.stateFilter", ["Todo", "Backlog"]);
  closeDb();
  migrate();

  assert.equal(readSetting("linear.assigneeMe"), false);
  assert.deepEqual(readSetting("linear.stateFilter"), ["Todo", "Backlog"]);
  assert.equal(readSetting("linear.inboxUnlockV1"), true);
});

test("inbox unlock is a no-op when the flag is already set even if values look legacy", () => {
  writeSetting("linear.inboxUnlockV1", true);
  writeSetting("linear.assigneeMe", true);
  writeSetting("linear.stateFilter", ["Todo"]);
  closeDb();
  migrate();

  assert.equal(readSetting("linear.assigneeMe"), true);
  assert.deepEqual(readSetting("linear.stateFilter"), ["Todo"]);
});

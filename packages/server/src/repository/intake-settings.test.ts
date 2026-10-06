// NOT-361: Linear picker config persistence, env-override precedence, and
// narrow patch (Team / Assignee / Status only — no routing fields).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-intake-settings-"));

const { migrate, getDb } = await import("../db/index.js");
const {
  getLinearIntakeConfigView,
  getPersistedLinearIntakeConfig,
  patchLinearIntakeConfig,
  DEFAULT_LINEAR_STATE_FILTER,
} = await import("./intake-settings.js");

before(() => {
  delete process.env.LINEAR_STATE_FILTER;
  delete process.env.LINEAR_TEAM_ID;
  migrate();
});

afterEach(() => {
  delete process.env.LINEAR_STATE_FILTER;
  delete process.env.LINEAR_TEAM_ID;
  // Reset picker rows to defaults between cases.
  const db = getDb();
  const upsert = db.prepare(
    "INSERT INTO intake_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  );
  upsert.run("linear.stateFilter", JSON.stringify([...DEFAULT_LINEAR_STATE_FILTER]));
  upsert.run("linear.teamId", JSON.stringify(null));
  upsert.run("linear.assigneeMe", JSON.stringify(false));
});

test("patchLinearIntakeConfig round-trips Team, Assignee, and Status through SQLite", () => {
  const saved = patchLinearIntakeConfig({
    stateFilter: ["Todo", "In Progress"],
    teamId: "team-abc",
    assigneeMe: true,
  });
  assert.deepEqual(saved.persisted, {
    stateFilter: ["Todo", "In Progress"],
    teamId: "team-abc",
    assigneeMe: true,
  });
  assert.deepEqual(saved.stateFilter, ["Todo", "In Progress"]);
  assert.equal(saved.teamId, "team-abc");
  assert.equal(saved.assigneeMe, true);
  assert.equal(saved.envOverrides.stateFilter, false);
  assert.equal(saved.envOverrides.teamId, false);

  const again = getLinearIntakeConfigView();
  assert.deepEqual(again.persisted, saved.persisted);

  // syncEnabled stays untouched when patching picker fields.
  const full = getPersistedLinearIntakeConfig();
  assert.equal(typeof full.syncEnabled, "boolean");
});

test("LINEAR_TEAM_ID and LINEAR_STATE_FILTER override effective values and set flags", () => {
  patchLinearIntakeConfig({
    stateFilter: ["Backlog"],
    teamId: "saved-team",
    assigneeMe: false,
  });
  process.env.LINEAR_STATE_FILTER = "Todo, In Review";
  process.env.LINEAR_TEAM_ID = "env-team";

  const view = getLinearIntakeConfigView();
  assert.deepEqual(view.stateFilter, ["Todo", "In Review"]);
  assert.equal(view.teamId, "env-team");
  assert.deepEqual(view.persisted.stateFilter, ["Backlog"]);
  assert.equal(view.persisted.teamId, "saved-team");
  assert.equal(view.envOverrides.stateFilter, true);
  assert.equal(view.envOverrides.teamId, true);

  // A save still writes persisted values; env remains authoritative on read.
  const afterSave = patchLinearIntakeConfig({ stateFilter: ["In Progress"], teamId: "ui-team" });
  assert.deepEqual(afterSave.persisted.stateFilter, ["In Progress"]);
  assert.equal(afterSave.persisted.teamId, "ui-team");
  assert.deepEqual(afterSave.stateFilter, ["Todo", "In Review"]);
  assert.equal(afterSave.teamId, "env-team");
});

test("patchLinearIntakeConfig rejects an empty status list", () => {
  assert.throws(() => patchLinearIntakeConfig({ stateFilter: ["  ", ""] }), /at least one/i);
});

// packages/server/src/coordinator/profile-snapshot.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-snap-"));

const { migrate, getDb } = await import("../db/index.js");
const { createAgent, getAgent, updateAgent } = await import("../repository/agents.js");
const { buildProfileSnapshot } = await import("./profile-snapshot.js");

before(() => migrate());

test("resolves the role-neutral model, falling back to the legacy execute column", () => {
  // NOT-71 removed the write path for the plan/execute columns, so the only way a row
  // carries them now is by predating that change — write them directly to reproduce one.
  const created = createAgent({ name: "legacy", runtime: "claude_code", workspaceRoot: "/repo" });
  getDb()
    .prepare("UPDATE agents SET default_execute_model = ?, default_plan_model = ? WHERE id = ?")
    .run("claude-sonnet-5", "claude-haiku-4-5", created.id);
  const legacy = getAgent(created.id)!;
  assert.equal(buildProfileSnapshot(legacy, "developer").model, "claude-sonnet-5");

  const modern = updateAgent(legacy.id, { defaultModel: "claude-opus-5" })!;
  assert.equal(buildProfileSnapshot(modern, "developer").model, "claude-opus-5");
});

test("developer and reviewer snapshots carry different permission policies", () => {
  const agent = createAgent({ name: "roles", runtime: "claude_code", workspaceRoot: "/repo" });
  const dev = buildProfileSnapshot(agent, "developer");
  const rev = buildProfileSnapshot(agent, "reviewer");
  assert.equal(dev.permissionPolicy.worktreeWrite, true);
  assert.equal(rev.permissionPolicy.worktreeWrite, false);
});

test("playbookIds falls back to the single legacy playbook_id, then honours the multi list", () => {
  const agent = createAgent({
    name: "pb",
    runtime: "claude_code",
    workspaceRoot: "/repo",
    playbookId: "pb_solo",
  });
  assert.deepEqual(buildProfileSnapshot(agent, "developer").playbookIds, ["pb_solo"]);

  const multi = updateAgent(agent.id, { playbookIds: ["pb_a", "pb_b"] })!;
  assert.deepEqual(buildProfileSnapshot(multi, "developer").playbookIds, ["pb_a", "pb_b"]);
});

test("snapshot captures deck, workspace, purpose and external memory refs", () => {
  const agent = createAgent({
    name: "full",
    runtime: "codex_local",
    workspaceRoot: "/work/app",
    purpose: "payments backend",
    externalMemoryRefs: ["vault://a", "  ", "vault://b"],
  });
  const snap = buildProfileSnapshot(agent, "developer");
  assert.equal(snap.workspaceRoot, "/work/app");
  assert.equal(snap.purpose, "payments backend");
  assert.deepEqual(snap.externalMemoryRefs, ["vault://a", "vault://b"]);
  assert.equal(snap.runtime, "codex_local");
  assert.equal(snap.version, 1);
});

test("editing a legacy profile collapses the plan/execute columns instead of stranding them", () => {
  // Reported on PR #59: startEdit read only the role-neutral column, so a legacy profile
  // showed blank controls while the snapshot kept resolving the hidden legacy value.
  const created = createAgent({ name: "collapse", runtime: "claude_code", workspaceRoot: "/repo" });
  getDb()
    .prepare(
      "UPDATE agents SET default_execute_model = ?, default_execute_budget_json = ? WHERE id = ?"
    )
    .run("claude-sonnet-5", JSON.stringify({ maxTurns: 7 }), created.id);

  // An edit that does not mention the defaults must preserve what actually ran...
  const renamed = updateAgent(created.id, { name: "collapse-renamed" })!;
  assert.equal(buildProfileSnapshot(renamed, "developer").model, "claude-sonnet-5");

  // ...by moving it into the role-neutral column, not by leaving the legacy one in place.
  const row = getDb()
    .prepare(
      "SELECT default_model, default_execute_model, default_execute_budget_json FROM agents WHERE id = ?"
    )
    .get(created.id) as {
    default_model: string | null;
    default_execute_model: string | null;
    default_execute_budget_json: string | null;
  };
  assert.equal(row.default_model, "claude-sonnet-5");
  assert.equal(row.default_execute_model, null);
  assert.equal(row.default_execute_budget_json, null);
});

test("switching runtime does not carry the old runtime's legacy model into the new snapshot", () => {
  // Reviewer's repro: a legacy Cursor profile on `auto`, switched to Claude with the model
  // cleared, still produced a Claude snapshot running Cursor's `auto`.
  const created = createAgent({ name: "switch", runtime: "cursor_local", workspaceRoot: "/repo" });
  getDb().prepare("UPDATE agents SET default_execute_model = ? WHERE id = ?").run("auto", created.id);

  const switched = updateAgent(created.id, { runtime: "claude_code", defaultModel: null })!;
  const snap = buildProfileSnapshot(switched, "developer");
  assert.equal(snap.runtime, "claude_code");
  assert.equal(snap.model, null);
});

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
  const created = createAgent({
    name: "legacy",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  getDb()
    .prepare("UPDATE agents SET default_execute_model = ?, default_plan_model = ? WHERE id = ?")
    .run("claude-sonnet-5", "claude-haiku-4-5", created.id);
  const legacy = getAgent(created.id)!;
  assert.equal(buildProfileSnapshot(legacy, "developer").model, "claude-sonnet-5");

  const modern = updateAgent(legacy.id, { defaultModel: "claude-opus-5" })!;
  assert.equal(buildProfileSnapshot(modern, "developer").model, "claude-opus-5");
});

test("developer and reviewer snapshots carry different permission policies", () => {
  const agent = createAgent({
    name: "roles",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  const dev = buildProfileSnapshot(agent, "developer");
  const rev = buildProfileSnapshot(agent, "reviewer");
  assert.equal(dev.permissionPolicy.worktreeWrite, true);
  assert.equal(rev.permissionPolicy.worktreeWrite, false);
});

test("snapshot omits legacy workspace/playbook/memory fields (NOT-149)", () => {
  const agent = createAgent({
    name: "pb",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  // Legacy columns may still exist on the row, but the frozen snapshot must not carry them.
  getDb()
    .prepare(
      "UPDATE agents SET workspace_root = ?, playbook_id = ?, playbook_ids_json = ?, external_memory_refs_json = ? WHERE id = ?"
    )
    .run(
      "/work/app",
      "pb_solo",
      JSON.stringify(["pb_a", "pb_b"]),
      JSON.stringify(["vault://a"]),
      agent.id
    );
  const snap = buildProfileSnapshot(getAgent(agent.id)!, "developer");
  assert.equal("workspaceRoot" in snap, false);
  assert.equal("playbookIds" in snap, false);
  assert.equal("externalMemoryRefs" in snap, false);
  assert.equal(snap.deckId, "00000000-0000-4000-a000-000000000099");
});

test("snapshot captures deck, purpose, and runtime", () => {
  const deckId = "00000000-0000-4000-a000-000000000099";
  const agent = createAgent({
    name: "full",
    runtime: "codex_local",
    purpose: "payments backend",
    deckId,
  });
  const snap = buildProfileSnapshot(agent, "developer");
  assert.equal(snap.deckId, deckId);
  assert.equal(snap.purpose, "payments backend");
  assert.equal(snap.runtime, "codex_local");
  assert.equal(snap.version, 1);
});

test("editing a legacy profile collapses the plan/execute columns instead of stranding them", () => {
  // Reported on PR #59: startEdit read only the role-neutral column, so a legacy profile
  // showed blank controls while the snapshot kept resolving the hidden legacy value.
  const created = createAgent({
    name: "collapse",
    runtime: "claude_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
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
  const created = createAgent({
    name: "switch",
    runtime: "cursor_local",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  getDb().prepare("UPDATE agents SET default_execute_model = ? WHERE id = ?").run("auto", created.id);

  const switched = updateAgent(created.id, { runtime: "claude_code", defaultModel: null })!;
  const snap = buildProfileSnapshot(switched, "developer");
  assert.equal(snap.runtime, "claude_code");
  assert.equal(snap.model, null);
});

test("snapshot freezes defaultEffort alongside the model", () => {
  const agent = createAgent({
    name: "effort",
    runtime: "codex_local",
    defaultModel: "gpt-5",
    defaultEffort: "high",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  const snap = buildProfileSnapshot(agent, "developer");
  assert.equal(snap.effort, "high");
  assert.equal(snap.model, "gpt-5");

  const cleared = updateAgent(agent.id, { defaultEffort: null })!;
  assert.equal(buildProfileSnapshot(cleared, "developer").effort, null);
});

test("a Muse Code profile round-trips through the agent APIs and its frozen snapshot (NOT-178)", async () => {
  const { MUSE_CODE_CONTRIBUTOR_MODEL } = await import("@agent-dealer/shared");
  const { parseProfileSnapshot } = await import("@agent-dealer/shared");
  const created = createAgent({
    name: "muse",
    runtime: "muse_code",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  assert.equal(getAgent(created.id)!.runtime, "muse_code");
  // No model given: the pinned contributor model is stored, not null (Muse would otherwise
  // pick its own profile).
  assert.equal(created.defaultModel, MUSE_CODE_CONTRIBUTOR_MODEL);

  const snap = buildProfileSnapshot(created, "developer");
  assert.equal(snap.runtime, "muse_code");
  assert.equal(snap.model, MUSE_CODE_CONTRIBUTOR_MODEL);
  assert.deepEqual(parseProfileSnapshot(JSON.stringify(snap)), snap);

  // Editing keeps it a Muse profile, and clearing the model re-pins rather than storing null.
  const edited = updateAgent(created.id, { name: "muse-2", defaultModel: null })!;
  assert.equal(edited.runtime, "muse_code");
  assert.equal(edited.defaultModel, MUSE_CODE_CONTRIBUTOR_MODEL);
  assert.equal(edited.name, "muse-2");

  // Switching another runtime to Muse also pins.
  const claude = createAgent({
    name: "to-muse",
    runtime: "claude_code",
    defaultModel: "sonnet",
    deckId: "00000000-0000-4000-a000-000000000099",
  });
  assert.equal(updateAgent(claude.id, { runtime: "muse_code", defaultModel: null })!.defaultModel, MUSE_CODE_CONTRIBUTOR_MODEL);
});

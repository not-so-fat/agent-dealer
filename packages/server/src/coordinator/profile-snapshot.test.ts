// packages/server/src/coordinator/profile-snapshot.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENT_DEALER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dealer-snap-"));

const { migrate } = await import("../db/index.js");
const { createAgent, updateAgent } = await import("../repository/agents.js");
const { buildProfileSnapshot } = await import("./profile-snapshot.js");

before(() => migrate());

test("resolves the role-neutral model, falling back to the legacy execute column", () => {
  const legacy = createAgent({
    name: "legacy",
    runtime: "claude_code",
    workspaceRoot: "/repo",
    defaultExecuteModel: "claude-sonnet-5",
    defaultPlanModel: "claude-haiku-4-5",
  });
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
  assert.equal(rev.permissionPolicy.push, false);
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

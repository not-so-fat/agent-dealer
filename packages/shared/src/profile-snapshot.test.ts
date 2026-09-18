import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProfileSnapshot,
  parsePermissionPolicyOverride,
  parseProfileSnapshot,
  parseStringList,
  resolvePermissionPolicy,
  serializePermissionPolicyOverride,
  serializeStringList,
} from "./profile-snapshot.js";

test("serializeStringList trims, drops blanks, and returns null when empty", () => {
  assert.equal(serializeStringList(["  a ", "", "b"]), JSON.stringify(["a", "b"]));
  assert.equal(serializeStringList([]), null);
  assert.equal(serializeStringList(null), null);
  assert.deepEqual(parseStringList(serializeStringList(["x", "y"])), ["x", "y"]);
  assert.deepEqual(parseStringList("not json"), []);
});

test("resolvePermissionPolicy: override only tightens, never loosens", () => {
  assert.equal(resolvePermissionPolicy("developer", { outboundMutation: false }).outboundMutation, false);
  assert.equal(resolvePermissionPolicy("developer", { outboundMutation: false }).worktreeWrite, true);
  assert.equal(resolvePermissionPolicy("reviewer", { worktreeWrite: true }).worktreeWrite, false);
});

test("permission-policy override serialization round-trips; parse rejects unknown keys", () => {
  assert.equal(
    serializePermissionPolicyOverride({ worktreeWrite: false }),
    JSON.stringify({ worktreeWrite: false })
  );
  assert.equal(serializePermissionPolicyOverride(null), null);
  assert.deepEqual(parsePermissionPolicyOverride(JSON.stringify({ worktreeWrite: false })), {
    worktreeWrite: false,
  });
  // push/openPr are not a recognized override key (never modeled — see PermissionPolicy
  // doc comment) and resolveHumanAction is not overridable either; both are rejected.
  assert.equal(parsePermissionPolicyOverride(JSON.stringify({ push: false })), null);
  assert.equal(parsePermissionPolicyOverride(JSON.stringify({ resolveHumanAction: true })), null);
});

test("parseProfileSnapshot round-trips a valid snapshot and rejects junk", () => {
  const snap: ProfileSnapshot = {
    version: 1,
    agentId: "a1",
    role: "reviewer",
    runtime: "claude_code",
    model: null,
    effort: "medium",
    budgetJson: null,
    permissionPolicy: resolvePermissionPolicy("reviewer", null),
    deckId: "00000000-0000-4000-a000-000000000099",
    purpose: null,
    capturedAt: new Date().toISOString(),
  };
  assert.deepEqual(parseProfileSnapshot(JSON.stringify(snap)), snap);
  assert.equal(parseProfileSnapshot("{}"), null);
  assert.equal(parseProfileSnapshot(null), null);
});

test("parseProfileSnapshot strips legacy workspace/playbook/memory fields (NOT-149)", () => {
  const legacy = {
    version: 1 as const,
    agentId: "a1",
    role: "developer" as const,
    runtime: "codex_local" as const,
    model: "gpt-5",
    budgetJson: null,
    permissionPolicy: resolvePermissionPolicy("developer", null),
    deckId: null,
    workspaceRoot: "/repo",
    playbookIds: ["pb_x"],
    externalMemoryRefs: ["vault://x"],
    purpose: null,
    capturedAt: new Date().toISOString(),
  };
  const parsed = parseProfileSnapshot(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.equal(parsed!.effort, null);
  assert.equal("workspaceRoot" in parsed!, false);
  assert.equal("playbookIds" in parsed!, false);
  assert.equal("externalMemoryRefs" in parsed!, false);
});

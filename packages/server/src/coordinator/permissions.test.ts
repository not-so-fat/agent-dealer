// packages/server/src/coordinator/permissions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializePermissionPolicyOverride } from "@agent-dealer/shared";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";
import {
  assertReviewerReadOnly,
  isReviewerReadOnly,
  resolveSessionPermissionPolicy,
} from "./permissions.js";

test("reviewer role resolves to an all-off policy", () => {
  const p = resolveSessionPermissionPolicy("reviewer", null);
  assert.deepEqual(p, {
    worktreeWrite: false,
    push: false,
    openPr: false,
    publishReview: false,
    outboundMutation: false,
    resolveHumanAction: false,
  });
});

test("developer role grants write/push/openPr by default", () => {
  const p = resolveSessionPermissionPolicy("developer", null);
  assert.equal(p.worktreeWrite, true);
  assert.equal(p.push, true);
  assert.equal(p.openPr, true);
  assert.equal(p.publishReview, false);
});

test("a profile override can only tighten a developer policy, never loosen a reviewer one", () => {
  const tightened = resolveSessionPermissionPolicy(
    "developer",
    serializePermissionPolicyOverride({ push: false })
  );
  assert.equal(tightened.push, false);
  assert.equal(tightened.worktreeWrite, true);

  const loosened = resolveSessionPermissionPolicy(
    "reviewer",
    serializePermissionPolicyOverride({ worktreeWrite: true })
  );
  assert.equal(loosened.worktreeWrite, false, "override cannot raise the reviewer ceiling");
});

test("assertReviewerReadOnly passes for generated reviewer args across every runtime", () => {
  for (const runtime of ["claude_code", "codex_local", "cursor_local"] as const) {
    assert.doesNotThrow(() => assertReviewerReadOnly(buildReviewerArgs(runtime, "review")));
  }
});

test("assertReviewerReadOnly rejects developer args (write tools present)", () => {
  assert.throws(() => assertReviewerReadOnly(buildDeveloperArgs("claude_code", "implement")));
  assert.equal(isReviewerReadOnly(buildDeveloperArgs("codex_local", "implement")), false);
});

test("a tightened developer policy drops the write tools from claude args", () => {
  const policy = resolveSessionPermissionPolicy(
    "developer",
    serializePermissionPolicyOverride({ worktreeWrite: false })
  );
  const args = buildDeveloperArgs("claude_code", "prompt", undefined, policy);
  const tools = args[args.indexOf("--allowedTools") + 1].split(",");
  assert.ok(!tools.includes("Write"));
  assert.ok(!tools.includes("Bash"));
});

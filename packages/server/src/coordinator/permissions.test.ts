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

test("push / open-PR flags gate the corresponding Bash commands for a claude developer", () => {
  const open = buildDeveloperArgs("claude_code", "impl");
  const openDeny = (open[open.indexOf("--disallowedTools") + 1] ?? "");
  assert.ok(!openDeny.includes("git push"), "default developer may push");
  assert.ok(!openDeny.includes("gh pr create"));

  const locked = resolveSessionPermissionPolicy(
    "developer",
    serializePermissionPolicyOverride({ push: false, openPr: false })
  );
  const args = buildDeveloperArgs("claude_code", "impl", undefined, locked);
  const deny = args[args.indexOf("--disallowedTools") + 1];
  assert.match(deny, /Bash\(git push:\*\)/);
  assert.match(deny, /Bash\(gh pr create:\*\)/);
  // Bash itself is still granted (the developer still needs it to build/test).
  assert.ok(args[args.indexOf("--allowedTools") + 1].split(",").includes("Bash"));
});

test("a codex reviewer invocation isolates configured MCP servers via --ignore-user-config", () => {
  // `-c mcp_servers={}` is a no-op (codex merges overrides into config.toml rather than
  // replacing it — verified against the installed CLI); --ignore-user-config skips
  // config.toml, where mcp_servers is defined, entirely.
  const args = buildReviewerArgs("codex_local", "review");
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(!args.includes("-c"), "no longer relies on the disproven -c mcp_servers={} override");
  // a codex developer keeps MCP (deck reads)
  const dev = buildDeveloperArgs("codex_local", "impl");
  assert.ok(!dev.includes("--ignore-user-config"));
});

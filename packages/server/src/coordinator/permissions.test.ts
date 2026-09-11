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
    publishReview: false,
    outboundMutation: false,
    resolveHumanAction: false,
  });
});

test("developer role grants worktree write by default", () => {
  const p = resolveSessionPermissionPolicy("developer", null);
  assert.equal(p.worktreeWrite, true);
  assert.equal(p.publishReview, false);
});

test("a profile override can only tighten a developer policy, never loosen a reviewer one", () => {
  const tightened = resolveSessionPermissionPolicy(
    "developer",
    serializePermissionPolicyOverride({ worktreeWrite: false })
  );
  assert.equal(tightened.worktreeWrite, false);

  const loosened = resolveSessionPermissionPolicy(
    "reviewer",
    serializePermissionPolicyOverride({ worktreeWrite: true })
  );
  assert.equal(loosened.worktreeWrite, false, "override cannot raise the reviewer ceiling");
});

test("PermissionPolicy has no push/openPr field — see profile-snapshot.ts for why", () => {
  // A PR review round proved every push/openPr control we tried (a Bash-argv denylist,
  // then a git-config pushurl redirect) bypassable by the very worker it restricted, once
  // that worker already holds an unrestricted write/Bash grant. Rather than ship a policy
  // field that promises a restriction this layer cannot enforce, it isn't modeled here.
  const p = resolveSessionPermissionPolicy("developer", null);
  assert.ok(!("push" in p));
  assert.ok(!("openPr" in p));
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

test("assertReviewerReadOnly rejects a claude invocation that merely omits write tools from --allowedTools", () => {
  // This is the exact shape NOT-60 shipped before this review round: --allowedTools
  // omits Write/Edit/Bash, but nothing stops the active permission mode / an ambient
  // .claude/settings.json from granting them anyway. The invariant must catch it even
  // though --allowedTools itself "looks" read-only.
  const looksReadOnlyButIsnt = [
    "-p",
    "review the diff",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    "Read,Glob,Grep,Skill",
    "--disallowedTools",
    "mcp__agent-deck__call_service_tool",
  ];
  assert.throws(
    () => assertReviewerReadOnly(looksReadOnlyButIsnt),
    /--tools|--restricted|dontAsk/
  );
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

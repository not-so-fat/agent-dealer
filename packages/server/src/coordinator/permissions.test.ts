// packages/server/src/coordinator/permissions.test.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// NOT-132: the deck-attached column is the one production always takes, and it was the
// one never asserted. args.ts omits codex's --ignore-user-config once a scoped CODEX_HOME
// exists; permissions.ts demanded it unconditionally. Each module's own test passed while
// the composition threw on every real spawn, so this matrix — not a per-runtime one-off —
// is the shape that holds the contract.
const RUNTIMES = ["claude_code", "codex_local", "cursor_local"] as const;

const deckConfigFor = (runtime: (typeof RUNTIMES)[number]): string =>
  runtime === "codex_local"
    ? "/tmp/authz/codex-home"
    : runtime === "cursor_local"
      ? "/tmp/wt/.cursor/mcp.json"
      : "/tmp/authz/claude-mcp.json";

/** Mirrors what materializeWorkerMcpConfig hands realReviewerSpawn (agent-deck-bind.ts). */
const deckContextFor = (runtime: (typeof RUNTIMES)[number]) => {
  if (runtime === "codex_local") {
    // A real directory: the codex branch reads this config to check the send-gate denial,
    // the way codex itself will (NOT-134).
    const home = scopedCodexHome(["call_service_tool"]);
    return { mcpConfigPath: home, mcpEnv: { CODEX_HOME: home } };
  }
  return { mcpConfigPath: deckConfigFor(runtime) };
};

test("assertReviewerReadOnly passes for generated reviewer args across every runtime, deck-attached or not", () => {
  for (const runtime of RUNTIMES) {
    assert.doesNotThrow(
      () => assertReviewerReadOnly(buildReviewerArgs(runtime, "review")),
      `${runtime} without a deck`
    );

    const ctx = deckContextFor(runtime);
    const args = buildReviewerArgs(runtime, "review", undefined, undefined, ctx.mcpConfigPath);
    assert.doesNotThrow(() => assertReviewerReadOnly(args, ctx), `${runtime} with a deck`);
  }
});

test("a codex reviewer with neither --ignore-user-config nor a scoped CODEX_HOME is rejected", () => {
  // The ambient ~/.codex/config.toml mcp_servers table would be live. Passing the args
  // without their spawn context is the strict reading, so it must still throw.
  const codexHome = scopedCodexHome(["call_service_tool"]);
  const args = buildReviewerArgs("codex_local", "review", undefined, undefined, codexHome);
  assert.ok(!args.includes("--ignore-user-config"));
  assert.throws(() => assertReviewerReadOnly(args), /isolate configured MCP servers/);
  assert.equal(isReviewerReadOnly(args), false);
  assert.equal(isReviewerReadOnly(args, { mcpConfigPath: codexHome, mcpEnv: { CODEX_HOME: codexHome } }), true);
});

test("a config path that never reached the spawn env does not count as codex isolation", () => {
  // The whole point of taking a context: CODEX_HOME in the child env is what makes codex
  // skip ~/.codex, so a path alone — or one that disagrees with the env — is not evidence.
  const codexHome = "/tmp/authz/codex-home";
  const args = buildReviewerArgs("codex_local", "review", undefined, undefined, codexHome);
  assert.equal(isReviewerReadOnly(args, { mcpConfigPath: codexHome }), false);
  assert.equal(
    isReviewerReadOnly(args, { mcpConfigPath: codexHome, mcpEnv: { CODEX_HOME: "/tmp/somewhere-else" } }),
    false
  );
  assert.equal(
    isReviewerReadOnly(args, { mcpConfigPath: codexHome, mcpEnv: { SOMETHING_ELSE: codexHome } }),
    false
  );
});

// NOT-134. codex has no --disallowedTools, so the send-gate denial lives in the scoped
// config.toml. Verified live against codex 0.154.0: with `disabled_tools` present the
// session reports NOTOOL and emits no mcp_tool_call; without it the tool is exposed and
// reachable (the call was then refused by codex's own approval policy — an accident of
// that default, not something this codebase expresses, which is exactly why it is
// asserted here).
const tempHomes: string[] = [];
after(() => {
  for (const dir of tempHomes) fs.rmSync(dir, { recursive: true, force: true });
});

function scopedCodexHome(disabledTools: string[] | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  tempHomes.push(dir);
  const denial = disabledTools ? `disabled_tools = ${JSON.stringify(disabledTools)}\n` : "";
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    `[mcp_servers.agent-deck]\nurl = "http://127.0.0.1:1110/mcp"\n${denial}`
  );
  return dir;
}

test("a deck-attached codex reviewer must carry the send-gate denial in its scoped config", () => {
  const args = buildReviewerArgs("codex_local", "review", undefined, undefined, "placeholder");

  const denied = scopedCodexHome(["call_service_tool"]);
  assert.doesNotThrow(() =>
    assertReviewerReadOnly(args, { mcpConfigPath: denied, mcpEnv: { CODEX_HOME: denied } })
  );

  const undenied = scopedCodexHome(null);
  assert.throws(
    () => assertReviewerReadOnly(args, { mcpConfigPath: undenied, mcpEnv: { CODEX_HOME: undenied } }),
    /deny the outbound-mutation tool/
  );

  const wrongTool = scopedCodexHome(["some_other_tool"]);
  assert.throws(
    () => assertReviewerReadOnly(args, { mcpConfigPath: wrongTool, mcpEnv: { CODEX_HOME: wrongTool } }),
    /deny the outbound-mutation tool/
  );
});

test("an unreadable scoped codex config is treated as not denied", () => {
  // An assertion must only ever over-reject: a config we cannot read is not evidence.
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-empty-"));
  tempHomes.push(missing);
  const args = buildReviewerArgs("codex_local", "review", undefined, undefined, "placeholder");
  assert.throws(
    () => assertReviewerReadOnly(args, { mcpConfigPath: missing, mcpEnv: { CODEX_HOME: missing } }),
    /deny the outbound-mutation tool/
  );
});

test("a scoped CODEX_HOME does not excuse a non-read-only codex sandbox", () => {
  // Reaches the codex branch itself: `workspace-write` would trip the earlier generic
  // sandbox check before ever getting here, so use a value only the codex branch rejects.
  const codexHome = "/tmp/authz/codex-home";
  const ctx = { mcpConfigPath: codexHome, mcpEnv: { CODEX_HOME: codexHome } };
  assert.throws(
    () => assertReviewerReadOnly(["exec", "--json", "-s", "danger-full-access", "review"], ctx),
    /read-only sandbox/
  );
  // and the generic writable-sandbox check still fires first for workspace-write
  assert.throws(
    () => assertReviewerReadOnly(["exec", "--json", "-s", "workspace-write", "review"], ctx),
    /writable sandbox/
  );
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

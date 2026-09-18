import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeveloperArgs, buildReviewerArgs } from "./args.js";

test("buildDeveloperArgs for claude_code allows Bash and Write/Edit", () => {
  const args = buildDeveloperArgs("claude_code", "do the task");
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("do the task"));
  const toolsIdx = args.indexOf("--allowedTools");
  assert.ok(toolsIdx >= 0);
  assert.ok(args[toolsIdx + 1].includes("Bash"));
  assert.ok(args[toolsIdx + 1].includes("Write"));
});

test("buildReviewerArgs for claude_code excludes Write/Edit/Bash and denies the send tool", () => {
  const args = buildReviewerArgs("claude_code", "review the diff");
  const toolsIdx = args.indexOf("--allowedTools");
  assert.ok(!args[toolsIdx + 1].includes("Write"));
  assert.ok(!args[toolsIdx + 1].includes("Edit"));
  assert.ok(!args[toolsIdx + 1].split(",").includes("Bash"));
  assert.ok(args.includes("--disallowedTools"));
});

test("buildDeveloperArgs passes model through when given", () => {
  const args = buildDeveloperArgs("claude_code", "prompt", "claude-opus-5");
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("claude-opus-5"));
});

test("buildDeveloperArgs for codex_local uses exec subcommand shape", () => {
  const args = buildDeveloperArgs("codex_local", "do the task");
  assert.equal(args[0], "exec");
  assert.ok(args.includes("workspace-write"));
});

test("buildReviewerArgs for codex_local uses read-only sandbox", () => {
  const args = buildReviewerArgs("codex_local", "review the diff");
  assert.ok(args.includes("read-only"));
});

test("buildDeveloperArgs for cursor_local requests stream-json output", () => {
  const args = buildDeveloperArgs("cursor_local", "do the task");
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
});

test("buildReviewerArgs for cursor_local runs in ask mode", () => {
  const args = buildReviewerArgs("cursor_local", "review the diff");
  assert.ok(args.includes("--mode"));
  assert.ok(args.includes("ask"));
});

test("buildReviewerArgs for claude_code hard-removes write tools via --tools and isolates ambient settings", () => {
  // --allowedTools alone is only an auto-approve hint (a review round proved a tool it
  // omits still falls through to the active permission mode / any ambient
  // .claude/settings.json) — --tools, --restricted, and --permission-mode dontAsk are
  // the load-bearing flags.
  const args = buildReviewerArgs("claude_code", "review the diff");
  const hardTools = args[args.indexOf("--tools") + 1].split(",");
  assert.ok(!hardTools.includes("Write"));
  assert.ok(!hardTools.includes("Edit"));
  assert.ok(!hardTools.includes("Bash"));
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
});

test("buildDeveloperArgs for claude_code makes Bash/Write/Edit available via --tools, still isolates ambient settings", () => {
  const args = buildDeveloperArgs("claude_code", "implement");
  const hardTools = args[args.indexOf("--tools") + 1].split(",");
  assert.ok(hardTools.includes("Write"));
  assert.ok(hardTools.includes("Bash"));
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
});

test("claude allowedTools includes bind_workspace so a deck-equipped agent can bind its cwd", () => {
  const args = buildDeveloperArgs("claude_code", "implement");
  const allowed = args[args.indexOf("--allowedTools") + 1];
  assert.ok(allowed.split(",").includes("mcp__agent-deck__bind_workspace"));
});

test("buildDeveloperArgs for claude_code adds --mcp-config --strict-mcp-config when an authority config path is given, omits it otherwise", () => {
  const withAuthority = buildDeveloperArgs("claude_code", "implement", undefined, undefined, "/tmp/authz/mcp.json");
  assert.equal(withAuthority[withAuthority.indexOf("--mcp-config") + 1], "/tmp/authz/mcp.json");
  assert.ok(withAuthority.includes("--strict-mcp-config"));

  const withoutAuthority = buildDeveloperArgs("claude_code", "implement");
  assert.ok(!withoutAuthority.includes("--mcp-config"));
  assert.ok(!withoutAuthority.includes("--strict-mcp-config"));
});

test("buildReviewerArgs for codex_local keeps MCP config loaded (no --ignore-user-config) once an authority CODEX_HOME is given", () => {
  const withAuthority = buildReviewerArgs("codex_local", "review", undefined, undefined, "/tmp/authz/codex-home");
  assert.ok(!withAuthority.includes("--ignore-user-config"));

  const withoutAuthority = buildReviewerArgs("codex_local", "review");
  assert.ok(withoutAuthority.includes("--ignore-user-config"));
});

test("buildDeveloperArgs for codex_local never adds --ignore-user-config regardless of authority (write role already loads MCP)", () => {
  const withAuthority = buildDeveloperArgs("codex_local", "implement", undefined, undefined, "/tmp/authz/codex-home");
  assert.ok(!withAuthority.includes("--ignore-user-config"));
  const withoutAuthority = buildDeveloperArgs("codex_local", "implement");
  assert.ok(!withoutAuthority.includes("--ignore-user-config"));
});

test("buildDeveloperArgs for cursor_local adds --approve-mcps when mcpConfigPath is set", () => {
  const withPath = buildDeveloperArgs("cursor_local", "implement", undefined, undefined, "/tmp/wt/.cursor/mcp.json");
  assert.ok(withPath.includes("--approve-mcps"));

  const withoutPath = buildDeveloperArgs("cursor_local", "implement");
  assert.ok(!withoutPath.includes("--approve-mcps"));
});

test("buildDeveloperArgs for cursor_local always passes --force (headless MCP tool approval)", () => {
  // --approve-mcps only loads servers; without --force, cursor-agent rejects individual
  // agent-deck tool calls as "User rejected MCP" in -p mode. Prefer --force over --yolo.
  const args = buildDeveloperArgs("cursor_local", "implement", undefined, undefined, "/tmp/wt/.cursor/mcp.json");
  assert.ok(args.includes("--force"));
  assert.ok(!args.includes("--yolo"));
  const reviewer = buildReviewerArgs("cursor_local", "review", undefined, undefined, "/tmp/wt/.cursor/mcp.json");
  assert.ok(reviewer.includes("--force"));
});

test("buildDeveloperArgs for codex_local passes -c model_reasoning_effort when effort is set", () => {
  // Verified against installed Codex CLI (v0.150): `codex exec --strict-config -c
  // model_reasoning_effort=high …` prints `reasoning effort: high` in the session
  // banner; an unrecognized -c key fails under --strict-config.
  const args = buildDeveloperArgs("codex_local", "do the task", "gpt-5", undefined, undefined, "high");
  const cIdx = args.indexOf("-c");
  assert.ok(cIdx >= 0, "expected -c config override");
  assert.equal(args[cIdx + 1], "model_reasoning_effort=high");
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("gpt-5"));
});

test("buildDeveloperArgs for codex_local omits reasoning-effort override when effort is unset", () => {
  const args = buildDeveloperArgs("codex_local", "do the task", "gpt-5");
  assert.ok(!args.includes("-c"));
});

test("buildDeveloperArgs for claude_code passes --effort when effort is set", () => {
  // Flag name taken from `claude --help` (`--effort <level>`: low|medium|high|xhigh|max).
  const args = buildDeveloperArgs("claude_code", "prompt", "claude-opus-5", undefined, undefined, "medium");
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
});

test("buildDeveloperArgs for cursor_local has no separate effort flag (effort lives in model id)", () => {
  const args = buildDeveloperArgs("cursor_local", "prompt", "auto", undefined, undefined, "high");
  assert.ok(!args.includes("--effort"));
  assert.ok(!args.some((a) => a.includes("model_reasoning_effort")));
  assert.ok(!args.includes("-c"));
});

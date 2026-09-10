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

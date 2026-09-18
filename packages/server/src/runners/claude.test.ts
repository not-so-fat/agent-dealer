import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeReflectArgs, DENY_SEND_TOOL } from "./claude-args.js";

function allowedTools(args: string[]): string {
  return args[args.indexOf("--allowedTools") + 1]!;
}

test("reflect denies call_service_tool", () => {
  const args = buildClaudeReflectArgs();
  const i = args.indexOf("--disallowedTools");
  assert.ok(i >= 0);
  assert.equal(args[i + 1], DENY_SEND_TOOL);
  assert.doesNotMatch(allowedTools(args), /call_service_tool/);
});

test("reflect allowlist is read-only and carries the deck read tools", () => {
  const tools = allowedTools(buildClaudeReflectArgs());
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.doesNotMatch(tools, new RegExp(`\\b${tool}\\b`), tool);
  }
  assert.match(tools, /get_playbook/);
  assert.match(tools, /bind_workspace/);
});

test("reflect does not add the deliverable output dir", () => {
  assert.equal(buildClaudeReflectArgs().includes("--add-dir"), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@agent-dealer/shared";
import { buildClaudePhaseArgs, DENY_SEND_TOOL } from "./claude-args.js";

const baseRun = {
  id: "00000000-0000-4000-a000-000000000099",
  source: "manual" as const,
  externalId: null,
  externalLabel: null,
  title: "Test",
  description: null,
  repo: null,
  artifactWorkspace: null,
  agentId: null,
  agentName: null,
  deckId: null,
  deckName: null,
  playbookId: null,
  runtime: "claude_code" as const,
  planModel: null,
  executeModel: null,
  status: "running" as const,
  lineageId: null,
  acceptanceCriteria: null,
  approvalGatesJson: null,
  budgetJson: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function runWithCategory(taskCategory: Run["taskCategory"]): Run {
  return { ...baseRun, taskCategory };
}

function hasDisallowSend(args: string[]): boolean {
  const i = args.indexOf("--disallowedTools");
  return i >= 0 && args[i + 1] === DENY_SEND_TOOL;
}

test("all phases deny call_service_tool", () => {
  for (const mode of ["plan", "execute", "reflect", "qa"] as const) {
    const args = buildClaudePhaseArgs(runWithCategory("code"), mode);
    assert.equal(hasDisallowSend(args), true, mode);
  }
});

test("qa allowlist is read-only", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "qa");
  const i = args.indexOf("--allowedTools");
  assert.equal(args[i + 1], "Read,Glob,Grep,Skill");
});

test("qa forbids mutation tools even for code tasks", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "qa");
  const i = args.indexOf("--allowedTools");
  for (const tool of ["Write", "Edit", "Bash"]) {
    assert.doesNotMatch(args[i + 1], new RegExp(`\\b${tool}\\b`), tool);
  }
  assert.equal(hasDisallowSend(args), true);
});

test("qa does not add the deliverable output dir", () => {
  const args = buildClaudePhaseArgs(runWithCategory("content"), "qa");
  assert.equal(args.includes("--add-dir"), false);
});

test("execute allowlist includes list_service_tools", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "execute");
  const i = args.indexOf("--allowedTools");
  assert.match(args[i + 1], /list_service_tools/);
});

test("communication and email execute omit Bash", () => {
  for (const cat of ["communication", "email"] as const) {
    const args = buildClaudePhaseArgs(runWithCategory(cat), "execute");
    const i = args.indexOf("--allowedTools");
    assert.doesNotMatch(args[i + 1], /\bBash\b/);
  }
});

test("code execute retains Bash", () => {
  const args = buildClaudePhaseArgs(runWithCategory("code"), "execute");
  const i = args.indexOf("--allowedTools");
  assert.match(args[i + 1], /\bBash\b/);
});

import type { Runtime } from "@agent-dealer/shared";

const DECK_READ_TOOLS =
  "mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace,mcp__agent-deck__list_service_tools";
const DENY_SEND_TOOL = "mcp__agent-deck__call_service_tool";

const DEVELOPER_TOOLS = `Read,Write,Edit,Glob,Grep,Bash,Skill,${DECK_READ_TOOLS}`;
/**
 * Read-only: no Bash. The coordinator, not the reviewer, publishes the GitHub review
 * (session-lifecycle.ts renders and posts the validated ReviewerResult) — Bash access
 * would let the reviewer shell out to `gh pr review` itself, duplicating or racing that
 * publish and defeating the "coordinator is the only component that publishes" boundary
 * (spec §Role permissions).
 */
const REVIEWER_TOOLS = `Read,Glob,Grep,Skill,${DECK_READ_TOOLS}`;

export function buildDeveloperArgs(runtime: Runtime, prompt: string, model?: string): string[] {
  if (runtime === "codex_local") {
    return ["exec", "--json", "-s", "workspace-write", ...(model ? ["-m", model] : []), prompt];
  }
  if (runtime === "cursor_local") {
    return [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  return [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    DEVELOPER_TOOLS,
  ];
}

export function buildReviewerArgs(runtime: Runtime, prompt: string, model?: string): string[] {
  if (runtime === "codex_local") {
    return ["exec", "--json", "-s", "read-only", ...(model ? ["-m", model] : []), prompt];
  }
  if (runtime === "cursor_local") {
    return [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      "ask",
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  return [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    REVIEWER_TOOLS,
    "--disallowedTools",
    DENY_SEND_TOOL,
  ];
}

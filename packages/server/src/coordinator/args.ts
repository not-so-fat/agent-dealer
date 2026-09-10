// packages/server/src/coordinator/args.ts
//
// Per-runtime CLI argument + tool-permission generation for developer and reviewer
// worker sessions. Lifted from archive/not-57-full-p0-slice and extended to take a
// resolved PermissionPolicy so a profile can *tighten* a role (never loosen it).
// Pure string building — no spawning — so it is fully unit-testable without a paid CLI.
import type { PermissionPolicy, Runtime, WorkerSessionRole } from "@agent-dealer/shared";
import { roleCeiling } from "@agent-dealer/shared";

const DECK_READ_TOOLS =
  "mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__bind_workspace,mcp__agent-deck__list_service_tools";
const DENY_SEND_TOOL = "mcp__agent-deck__call_service_tool";

const WRITE_TOOLS = "Read,Write,Edit,Glob,Grep,Bash";
const READ_ONLY_TOOLS = "Read,Glob,Grep";

function allowedTools(policy: PermissionPolicy): string {
  const base = policy.worktreeWrite ? WRITE_TOOLS : READ_ONLY_TOOLS;
  return `${base},Skill,${DECK_READ_TOOLS}`;
}

function buildArgs(
  runtime: Runtime,
  policy: PermissionPolicy,
  prompt: string,
  model?: string
): string[] {
  if (runtime === "codex_local") {
    return [
      "exec",
      "--json",
      "-s",
      policy.worktreeWrite ? "workspace-write" : "read-only",
      ...(model ? ["-m", model] : []),
      prompt,
    ];
  }
  if (runtime === "cursor_local") {
    return [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      ...(policy.worktreeWrite ? [] : ["--mode", "ask"]),
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  const args = [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    allowedTools(policy),
  ];
  if (!policy.outboundMutation) args.push("--disallowedTools", DENY_SEND_TOOL);
  return args;
}

export function buildWorkerArgs(opts: {
  runtime: Runtime;
  role: WorkerSessionRole;
  prompt: string;
  model?: string;
  policy?: PermissionPolicy;
}): string[] {
  return buildArgs(opts.runtime, opts.policy ?? roleCeiling(opts.role), opts.prompt, opts.model);
}

export function buildDeveloperArgs(
  runtime: Runtime,
  prompt: string,
  model?: string,
  policy?: PermissionPolicy
): string[] {
  return buildArgs(runtime, policy ?? roleCeiling("developer"), prompt, model);
}

export function buildReviewerArgs(
  runtime: Runtime,
  prompt: string,
  model?: string,
  policy?: PermissionPolicy
): string[] {
  return buildArgs(runtime, policy ?? roleCeiling("reviewer"), prompt, model);
}

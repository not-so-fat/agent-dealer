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

// Built-in tool names (no MCP tools — --tools only governs the built-in set) passed to
// --tools, which is a hard availability list (a name it omits is not nameable by the
// model at all), unlike
// --allowedTools, which only pre-approves matching calls: a tool --allowedTools omits
// is NOT unavailable, it falls through to the active --permission-mode / any
// .claude/settings.json in the worktree/project/home — confirmed against
// https://code.claude.com/docs/en/agent-sdk/permissions and the installed CLI's own
// --help after a PR review round proved the previous allowedTools-only approach let a
// permissive ambient settings file re-grant Write/Edit/Bash regardless. --tools is the
// load-bearing restriction; --allowedTools below is kept so --permission-mode dontAsk
// (which denies anything not pre-approved) still lets the legitimate calls through.
const WRITE_BUILTIN_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Skill";
const READ_ONLY_BUILTIN_TOOLS = "Read,Glob,Grep,Skill";

function claudeToolSets(policy: PermissionPolicy): { builtins: string; allowed: string } {
  const builtins = policy.worktreeWrite ? WRITE_BUILTIN_TOOLS : READ_ONLY_BUILTIN_TOOLS;
  return { builtins, allowed: `${builtins},${DECK_READ_TOOLS}` };
}

function claudeDisallowedTools(policy: PermissionPolicy): string[] {
  // No push/openPr denial here: a Bash-argv prefix denylist over a capability the
  // session already holds unrestricted (Bash) is bypassable by construction — a review
  // round proved it (`git -C`, absolute paths) and then proved the git-config-based
  // follow-up bypassable too (the worker can edit the very config meant to restrict it,
  // or target the remote URL directly instead of the configured remote name). See
  // profile-snapshot.ts's PermissionPolicy doc comment: push/openPr are not modeled as
  // enforceable capabilities here on purpose.
  return policy.outboundMutation ? [] : [DENY_SEND_TOOL];
}

function buildArgs(
  runtime: Runtime,
  policy: PermissionPolicy,
  prompt: string,
  model?: string
): string[] {
  if (runtime === "codex_local") {
    const args = ["exec", "--json", "-s", policy.worktreeWrite ? "workspace-write" : "read-only"];
    // codex's read-only sandbox constrains shell/files but NOT configured MCP/plugin
    // calls, and `-c mcp_servers={}` does NOT clear the loaded table — codex merges CLI
    // overrides into `~/.codex/config.toml` rather than replacing it, so
    // `call_service_tool` (and every other configured server) stays reachable for a
    // reviewer; confirmed directly against the installed CLI (`codex mcp list` shows
    // `agent-deck` enabled with or without that override). `--ignore-user-config` instead
    // skips loading `$CODEX_HOME/config.toml` — where `mcp_servers` is defined — entirely,
    // so a read-only session genuinely has none configured. (A codex *developer* keeps
    // MCP for deck reads; a finer per-tool gate is a NOT-61+ refinement.)
    if (!policy.worktreeWrite) args.push("--ignore-user-config");
    if (model) args.push("-m", model);
    args.push(prompt);
    return args;
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
  const { builtins, allowed } = claudeToolSets(policy);
  const args = [
    ...(model ? ["--model", model] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    builtins,
    "--allowedTools",
    allowed,
    // Ignores user/project/local settings files (so a .claude/settings.json anywhere
    // can't re-grant a tool this invocation omitted) and refuses bypassPermissions.
    "--restricted",
    // Auto-denies any tool call that isn't pre-approved instead of falling through to
    // the ambient permission mode/settings when there's no one to answer a prompt.
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];
  const deny = claudeDisallowedTools(policy);
  if (deny.length) args.push("--disallowedTools", deny.join(","));
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

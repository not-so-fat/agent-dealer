// packages/server/src/coordinator/args.ts
//
// Per-runtime CLI argument + tool-permission generation for developer and reviewer
// worker sessions. Lifted from archive/not-57-full-p0-slice and extended to take a
// resolved PermissionPolicy so a profile can *tighten* a role (never loosen it).
// Pure string building — no spawning — so it is fully unit-testable without a paid CLI.
import type { PermissionPolicy, ReasoningEffort, Runtime, WorkerSessionRole } from "@agent-dealer/shared";
import { roleCeiling } from "@agent-dealer/shared";

// `bind_workspace` is required when a profile carries a deckId — equipping the deck for
// the worker cwd is what makes the session the agent the operator defined. Worktrees live
// under the issue repo so the grant covers that path (git-worktree.ts).
const DECK_READ_TOOLS =
  "mcp__agent-deck__bind_workspace,mcp__agent-deck__get_playbook,mcp__agent-deck__get_bound_deck,mcp__agent-deck__list_service_tools";
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
  model?: string,
  mcpConfigPath?: string,
  effort?: ReasoningEffort | null
): string[] {
  if (runtime === "codex_local") {
    const args = ["exec", "--json", "-s", policy.worktreeWrite ? "workspace-write" : "read-only"];
    // codex's read-only sandbox constrains shell/files but NOT configured MCP/plugin
    // calls, so a read-only session with no deck MCP config must have
    // `--ignore-user-config` to skip `$CODEX_HOME/config.toml` entirely —
    // otherwise the ambient `~/.codex/config.toml` MCP table (if any) stays reachable
    // regardless of role; confirmed directly against the installed CLI (`codex mcp list`
    // shows configured servers enabled with or without a `-c mcp_servers={}` override,
    // since codex merges CLI overrides into the loaded config rather than replacing it).
    // When a deck MCP config *is* wired (mcpConfigPath set), `CODEX_HOME` is pointed at
    // a per-attempt directory whose `config.toml` defines exactly one deck-header MCP
    // server (agent-deck-bind.ts) — `--ignore-user-config` would skip loading that
    // scoped file too, so it is never passed once a deck config exists, for either role.
    if (!policy.worktreeWrite && !mcpConfigPath) args.push("--ignore-user-config");
    if (model) args.push("-m", model);
    // NOT-81: verified against installed Codex — `-c model_reasoning_effort=<tier>` is
    // accepted under `--strict-config` and surfaces as `reasoning effort: <tier>` in the
    // exec session banner. Cursor has no equivalent separate flag.
    if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
    args.push(prompt);
    return args;
  }
  if (runtime === "cursor_local") {
    // Project `.cursor/mcp.json` is written with deck-launch headers (NOT-106). Headless
    // `-p` needs `--approve-mcps` to *load* the server; that does not auto-approve
    // individual MCP tool calls — without `--force`, cursor-agent rejects them as
    // "User rejected MCP: agent-deck-…" (no human to click Approve), which blocks the
    // deck→Linear path (`list_service_tools` / `call_service_tool`). Prefer `--force`
    // over `--yolo` (identical alias) for the clearer flag name. Approving ambient
    // servers under the same name is acceptable — assigned deck, not MCP isolation.
    // Effort: no separate CLI flag; cursor-agent only accepts effort inside a
    // parameterized `--model` id (e.g. `…[effort=high]`). Profile `defaultEffort` is
    // ignored here on purpose.
    return [
      "-p",
      "--force",
      "--trust",
      ...(mcpConfigPath ? ["--approve-mcps"] : []),
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      ...(policy.worktreeWrite ? [] : ["--mode", "ask"]),
      ...(model ? ["--model", model] : []),
      prompt,
    ];
  }
  const { builtins, allowed } = claudeToolSets(policy);
  // `--effort` confirmed via `claude --help` (low|medium|high|xhigh|max). Profile stores
  // the shared low|medium|high subset that also matches Codex.
  const args = [
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
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
  if (mcpConfigPath) {
    // `--strict-mcp-config` makes this file the *only* MCP source for the session —
    // without it claude still merges in any ambient user/project `.mcp.json`, which
    // would defeat the point of a freshly-minted, single-server scoped authority.
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  }
  return args;
}

export function buildWorkerArgs(opts: {
  runtime: Runtime;
  role: WorkerSessionRole;
  prompt: string;
  model?: string;
  effort?: ReasoningEffort | null;
  policy?: PermissionPolicy;
  mcpConfigPath?: string;
}): string[] {
  return buildArgs(
    opts.runtime,
    opts.policy ?? roleCeiling(opts.role),
    opts.prompt,
    opts.model,
    opts.mcpConfigPath,
    opts.effort
  );
}

export function buildDeveloperArgs(
  runtime: Runtime,
  prompt: string,
  model?: string,
  policy?: PermissionPolicy,
  mcpConfigPath?: string,
  effort?: ReasoningEffort | null
): string[] {
  return buildArgs(runtime, policy ?? roleCeiling("developer"), prompt, model, mcpConfigPath, effort);
}

export function buildReviewerArgs(
  runtime: Runtime,
  prompt: string,
  model?: string,
  policy?: PermissionPolicy,
  mcpConfigPath?: string,
  effort?: ReasoningEffort | null
): string[] {
  return buildArgs(runtime, policy ?? roleCeiling("reviewer"), prompt, model, mcpConfigPath, effort);
}

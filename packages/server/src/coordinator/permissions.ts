// packages/server/src/coordinator/permissions.ts
//
// Resolves a worker session's effective PermissionPolicy from its role and the (frozen)
// profile override, and provides the runtime-boundary invariant that a reviewer session
// can never edit files, push, publish a review, or call an outbound-mutation tool
// (ADR 0003 §Role permissions; NOT-60 acceptance criteria).
import type { PermissionPolicy, WorkerSessionRole } from "@agent-dealer/shared";
import { parsePermissionPolicyOverride, resolvePermissionPolicy } from "@agent-dealer/shared";

export { resolvePermissionPolicy };

/** Resolve from the serialized profile override stored on the agent / snapshot. */
export function resolveSessionPermissionPolicy(
  role: WorkerSessionRole,
  permissionPolicyJson: string | null | undefined
): PermissionPolicy {
  return resolvePermissionPolicy(role, parsePermissionPolicyOverride(permissionPolicyJson));
}

const WRITE_TOOL_NAMES = ["Write", "Edit", "Bash", "MultiEdit", "NotebookEdit"];
const OUTBOUND_MUTATION_TOOL = "mcp__agent-deck__call_service_tool";

function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

/**
 * Spawn context the invariant cannot read off `args` alone (NOT-132). Codex takes its MCP
 * configuration from `$CODEX_HOME/config.toml`, not from a flag, so whether the ambient
 * `~/.codex` table is reachable depends on the process env as much as on the argv.
 */
export interface ReviewerSpawnContext {
  /**
   * The attempt's scoped runtime config, as passed to `realReviewerSpawn`. For codex this
   * is a per-attempt `CODEX_HOME` directory (agent-deck-bind.ts).
   */
  mcpConfigPath?: string;
  /**
   * The extra process env the spawn actually applies. For codex this carries `CODEX_HOME`,
   * and `CODEX_HOME` — not the path field — is what creates the isolation: codex resolves
   * config from `$CODEX_HOME`, else `~/.codex` (cli-env.ts). Today
   * `materializeWorkerMcpConfig` returns the two together so they are equal, but that is a
   * property of one function, not a guarantee. Asserting on the path would be trusting a
   * correlate — the same shape of assumption that caused the bug this context exists to
   * fix — so the codex branch below checks the env.
   */
  mcpEnv?: Record<string, string>;
}

/**
 * Invariant check on generated CLI args: throws if a reviewer invocation could write,
 * run shell, or reach an outbound-mutation tool. Used as a spawn preflight and asserted
 * directly in tests so the read-only guarantee cannot silently regress.
 *
 * `ctx` carries the spawn's env-level isolation. Omitting it is the strict reading (no
 * scoped CODEX_HOME), so a caller that forgets it can only ever over-reject, never
 * under-reject.
 */
export function assertReviewerReadOnly(args: string[], ctx: ReviewerSpawnContext = {}): void {
  // Dangerous permission bypasses are never allowed for a reviewer.
  for (const arg of args) {
    if (arg.startsWith("--dangerously")) {
      throw new Error(`reviewer args contain a permission bypass: ${arg}`);
    }
  }

  // Claude: --allowedTools alone is NOT a restriction — it only auto-approves matching
  // calls; a tool it omits is still reachable if the active --permission-mode or any
  // ambient .claude/settings.json would otherwise grant it (confirmed against
  // https://code.claude.com/docs/en/agent-sdk/permissions after a PR review round found
  // exactly this gap). So the load-bearing checks are: --tools (a hard availability
  // list) excludes every write tool, --restricted is present (ignores ambient settings
  // files, refuses bypassPermissions), and --permission-mode is dontAsk (auto-denies
  // anything not pre-approved instead of falling through). --allowedTools/
  // --disallowedTools are checked too, but only as defense-in-depth on top of those.
  const allowedTools = (flagValue(args, "--allowedTools") ?? "").split(",").filter(Boolean);
  const isClaude = allowedTools.length > 0;
  if (isClaude) {
    const hardTools = (flagValue(args, "--tools") ?? "").split(",").filter(Boolean);
    for (const tool of WRITE_TOOL_NAMES) {
      if (hardTools.includes(tool)) throw new Error(`reviewer args make a write tool available: ${tool}`);
      if (allowedTools.includes(tool)) throw new Error(`reviewer args pre-approve a write tool: ${tool}`);
    }
    if (!args.includes("--restricted")) {
      throw new Error("reviewer claude args do not isolate ambient settings (missing --restricted)");
    }
    if (flagValue(args, "--permission-mode") !== "dontAsk") {
      throw new Error("reviewer claude args do not auto-deny un-pre-approved tools (missing --permission-mode dontAsk)");
    }
    const denied = (flagValue(args, "--disallowedTools") ?? "").split(",").filter(Boolean);
    if (allowedTools.includes(OUTBOUND_MUTATION_TOOL) || !denied.includes(OUTBOUND_MUTATION_TOOL)) {
      throw new Error("reviewer args do not deny the outbound-mutation tool");
    }
  }

  // Codex: never a writable sandbox. Cursor: never without ask mode.
  if (args.includes("workspace-write")) {
    throw new Error("reviewer args request a writable sandbox");
  }
  const isCursor = args.includes("--stream-partial-output");
  if (isCursor && !(flagValue(args, "--mode") === "ask")) {
    throw new Error("reviewer cursor args are not constrained to ask mode");
  }
  const isCodex = args[0] === "exec";
  if (isCodex) {
    if (flagValue(args, "-s") !== "read-only") {
      throw new Error("reviewer codex args are not constrained to a read-only sandbox");
    }
    // codex's read-only sandbox does not gate configured MCP/plugin calls, and merging a
    // `-c mcp_servers={}` override does not clear them (verified against the installed
    // CLI). There are exactly two ways to keep the ambient `~/.codex/config.toml`
    // mcp_servers table out of the session, and this invariant must accept both or it
    // rejects the one shape production actually builds (NOT-132):
    //
    //   * `--ignore-user-config` — skips config.toml entirely. What a deckless reviewer
    //     gets, since it needs no MCP server at all.
    //   * a scoped `CODEX_HOME` — codex resolves config from `$CODEX_HOME`, else `~/.codex`
    //     (cli-env.ts), so pointing it at the per-attempt directory means the only
    //     config.toml codex can load is the one defining the single deck-header server.
    //     `--ignore-user-config` is deliberately NOT passed here (args.ts), because it
    //     would skip that scoped file too and leave the reviewer with no deck at all.
    //
    // The second arm checks the env, not `mcpConfigPath`: the env var is what codex reads,
    // so a future config route returning a path without exporting CODEX_HOME would leave
    // `~/.codex/config.toml` live while looking isolated here.
    //
    // Neither present means the ambient table is live: reject.
    const scopedCodexHome =
      ctx.mcpEnv?.CODEX_HOME !== undefined && ctx.mcpEnv.CODEX_HOME === ctx.mcpConfigPath;
    if (!args.includes("--ignore-user-config") && !scopedCodexHome) {
      throw new Error("reviewer codex args do not isolate configured MCP servers");
    }
  }

  if (!isClaude && !isCursor && !isCodex) {
    throw new Error("reviewer args do not constrain the runtime to a read-only mode");
  }
}

export function isReviewerReadOnly(args: string[], ctx: ReviewerSpawnContext = {}): boolean {
  try {
    assertReviewerReadOnly(args, ctx);
    return true;
  } catch {
    return false;
  }
}

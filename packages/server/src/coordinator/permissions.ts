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
 * Invariant check on generated CLI args: throws if a reviewer invocation could write,
 * run shell, or reach an outbound-mutation tool. Used as a spawn preflight and asserted
 * directly in tests so the read-only guarantee cannot silently regress.
 */
export function assertReviewerReadOnly(args: string[]): void {
  // Dangerous permission bypasses are never allowed for a reviewer.
  for (const arg of args) {
    if (arg.startsWith("--dangerously")) {
      throw new Error(`reviewer args contain a permission bypass: ${arg}`);
    }
  }

  // Claude-style: the allowed-tool set must not include a write tool, and the
  // outbound-mutation tool must be explicitly denied.
  const allowed = (flagValue(args, "--allowedTools") ?? "").split(",").filter(Boolean);
  if (allowed.length) {
    for (const tool of WRITE_TOOL_NAMES) {
      if (allowed.includes(tool)) throw new Error(`reviewer args grant a write tool: ${tool}`);
    }
    const denied = (flagValue(args, "--disallowedTools") ?? "").split(",").filter(Boolean);
    if (allowed.includes(OUTBOUND_MUTATION_TOOL) || !denied.includes(OUTBOUND_MUTATION_TOOL)) {
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
    // codex's read-only sandbox does not gate configured MCP/plugin calls.
    if (!args.some((a, i) => a === "-c" && args[i + 1] === "mcp_servers={}")) {
      throw new Error("reviewer codex args do not disable configured MCP servers");
    }
  }

  if (!allowed.length && !isCursor && !isCodex) {
    throw new Error("reviewer args do not constrain the runtime to a read-only mode");
  }
}

export function isReviewerReadOnly(args: string[]): boolean {
  try {
    assertReviewerReadOnly(args);
    return true;
  } catch {
    return false;
  }
}

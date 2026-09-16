// packages/server/src/adapters/codex-scoped-config.ts
//
// The per-attempt codex `config.toml`: the one spelling of the send-gate tool name, the
// builder that writes the scoped `mcp_servers` table, and the reader the spawn preflight
// uses to check it.
//
// These live together, and apart from `agent-deck-bind.ts`, for two reasons. Together,
// because the writer and the reader must agree on one tool name — codex's `disabled_tools`
// is a per-server list, so the entry is the server-side name, NOT claude's namespaced
// `mcp__agent-deck__call_service_tool` (args.ts). Two spellings of one fact is how this
// stack's original bug happened. Apart, because `coordinator/permissions.ts` needs the
// reader to enforce a read-only invariant, and importing the adapter for it would drag the
// deck client, the repository layer, the DB module and the MCP SDK into the invariant
// module and all of its unit tests — for ~15 lines of fs + TOML (NOT-134 review).
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * The send gate (docs/PRD_SEND_GATE.md) as *codex* names it — server-side, unnamespaced.
 */
export const CODEX_SEND_GATE_TOOL = "call_service_tool";

/**
 * The deck reads a worker legitimately needs, in codex's unnamespaced spelling. Mirrors
 * claude's `DECK_READ_TOOLS` (args.ts) one-for-one; the send gate is deliberately absent.
 *
 * These need an explicit `approval_mode` because a non-interactive `codex exec` runs with
 * an approval policy of `never` — there is no human to answer a prompt, so any MCP call
 * that requires approval is refused outright ("MCP tool call requires approval, but
 * approval policy is never"). Without this the deck is configured, reachable, and unusable.
 */
export const CODEX_DECK_READ_TOOLS = [
  "bind_workspace",
  "get_bound_deck",
  "get_playbook",
  "list_service_tools",
] as const;

/**
 * The scoped `mcp_servers` table for one attempt.
 *
 * `disabled_tools` is the only place a codex session's tool surface can be narrowed —
 * codex has no `--disallowedTools` equivalent — so a policy-blind config silently grants
 * whatever the deck exposes. Verified against codex 0.154.0: with the key present the
 * tool is not exposed to the session at all; without it the tool is exposed and reachable.
 * It denies one tool, not the server, so deck reads are unaffected by it.
 *
 * `allowOutboundMutation` is currently unreachable in the `true` direction, and that is
 * deliberate rather than an oversight. Both role ceilings set `outboundMutation: false`
 * (shared/profile-snapshot.ts:50,57) and `resolvePermissionPolicy` can only turn a
 * capability off, never raise the ceiling — so today NO worker session, either role, any
 * runtime, can reach the send gate, and no profile setting re-enables it. The gated send
 * is the only route out (docs/PRD_SEND_GATE.md). claude carries the identical dead branch
 * (`claudeDisallowedTools`, args.ts), so this is parity, not a special case.
 *
 * The parameter exists so the ceiling stays the one place that decides — flip
 * `outboundMutation` there and this follows, rather than needing a second edit here. If
 * you came looking for the profile toggle that turns outbound writes on: there isn't one,
 * by design.
 */
export function codexMcpServersTable(opts: {
  mcpUrl: string;
  headers: Record<string, string>;
  allowOutboundMutation: boolean;
}): Record<string, Record<string, unknown>> {
  return {
    "agent-deck": {
      url: opts.mcpUrl,
      http_headers: opts.headers,
      ...(opts.allowOutboundMutation ? {} : { disabled_tools: [CODEX_SEND_GATE_TOOL] }),
      // Pre-approve exactly the reads, and nothing else. Verified against codex 0.154.0:
      // with these the deck read returns data; without them it is refused by the
      // approval policy even though the server is configured and connected. The send gate
      // is never listed here — it is removed by `disabled_tools` above, and listing it
      // would be the one entry that could undo that.
      tools: Object.fromEntries(
        CODEX_DECK_READ_TOOLS.map((t) => [t, { approval_mode: "approve" }])
      ),
    },
  };
}

/**
 * Does this scoped CODEX_HOME's config.toml deny the send gate on every configured server?
 *
 * Reads the file codex itself will read, rather than trusting whoever wrote it — the spawn
 * preflight needs the fact, not a flag passed alongside it. A missing or unparseable
 * config reads as "not denied": the strict answer, since an assertion must only ever
 * over-reject. No servers at all is denial by absence — there is nothing to call.
 */
export function codexScopedConfigDeniesSendGate(codexHome: string): boolean {
  try {
    const parsed = parseToml(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")) as {
      mcp_servers?: Record<
        string,
        { disabled_tools?: unknown; tools?: Record<string, { approval_mode?: unknown }> }
      >;
    };
    const servers = parsed.mcp_servers ?? {};
    const names = Object.keys(servers);
    if (names.length === 0) return true;
    return names.every((n) => {
      const server = servers[n];
      const denied = server?.disabled_tools;
      if (!Array.isArray(denied) || !denied.includes(CODEX_SEND_GATE_TOOL)) return false;
      // A per-tool approval entry for the send gate would be the one line that could
      // undo the removal above, so it is rejected rather than merely not written —
      // the denial must not depend on nobody having added it.
      return server?.tools?.[CODEX_SEND_GATE_TOOL] === undefined;
    });
  } catch {
    return false;
  }
}

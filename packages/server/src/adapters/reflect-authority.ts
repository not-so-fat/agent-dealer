// packages/server/src/adapters/reflect-authority.ts
//
// Authority-authenticated Agent Deck MCP calls for coordinator-side post-review reflection
// (NOT-94). Reflection runs after the issue's workflow instance is already terminal
// (final_review:complete) — there is no worker/worktree to hand a per-attempt MCP config
// file to (agent-deck-bind.ts's materializeWorkerMcpConfig), so the coordinator process
// itself connects directly to Agent Deck's MCP endpoint carrying the freshly minted
// authority as an `Authorization: Bearer <authorityId>:<authoritySecret>` header — the same
// principal shape a worker's isolated MCP config carries (agent-deck-bind.ts's
// `urlHeaderMcpConfig`), and the same shape `verifyAuthority`'s direct-connect fallback
// there uses. Never `x-agent-deck-client`, dashboard headers, copied workspace grants, or
// agent-admin (NOT-85's threat model).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import {
  assertToolResultOk,
  parseDeckToolResult,
  parseInteractionRequired,
  type DeckToolCaller,
} from "./agent-deck-bind.js";

export type AuthorizedDeckCallResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: "interaction_required";
      reason: string;
      /** Deck's own correlation id for this INTERACTION_REQUIRED response, when supplied —
       * lets the caller dedupe the human action it raises (NOT-93's requestId dedupe). */
      requestId?: string;
    }
  | { ok: false; kind: "infra_failure"; reason: string };

/** One-shot: connect under `authorityId`/`authoritySecret`, run `fn`, always close. */
export async function withAuthorizedDeckClient<T>(
  authorityId: string,
  authoritySecret: string,
  timeoutMs: number,
  fn: (callTool: DeckToolCaller) => Promise<T>
): Promise<T> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${authorityId}:${authoritySecret}` } },
  });
  const client = new Client({ name: "agent-dealer-reflect", version: "0.0.1" });
  await client.connect(transport);
  try {
    const callTool: DeckToolCaller = (name, args) =>
      Promise.race([
        client.callTool({ name, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    return await fn(callTool);
  } finally {
    await client.close();
  }
}

/**
 * Call one Deck MCP tool under authority, translating Deck's typed `INTERACTION_REQUIRED`
 * contract error into an `interaction_required` result (never thrown) so the caller can
 * park the attempt rather than treat it as an ordinary infra failure. Any other thrown
 * error (network, timeout, a different tool error) becomes `infra_failure`. Never throws.
 */
export async function callAuthorizedDeckTool<T = Record<string, unknown>>(opts: {
  authorityId: string;
  authoritySecret: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}): Promise<AuthorizedDeckCallResult<T>> {
  try {
    const result = await withAuthorizedDeckClient(
      opts.authorityId,
      opts.authoritySecret,
      opts.timeoutMs,
      (callTool) => callTool(opts.toolName, opts.arguments)
    );
    const interaction = parseInteractionRequired(result);
    if (interaction) {
      return {
        ok: false,
        kind: "interaction_required",
        reason:
          interaction.message ||
          "Agent Deck requires a control-plane decision before this reflection can continue.",
        requestId: interaction.requestId,
      };
    }
    assertToolResultOk(result, opts.toolName);
    return { ok: true, data: parseDeckToolResult(result) as T };
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: (err as Error).message ?? String(err) };
  }
}

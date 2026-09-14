// packages/server/src/adapters/reflect-authority.ts
//
// Deck-header Agent Deck MCP calls for coordinator-side post-review reflection (NOT-106).
// Reflection runs after the issue's workflow instance is already terminal — there is no
// worker/worktree to hand a per-attempt MCP config to, so the coordinator process itself
// connects with `x-agent-deck-deck-id` (no Authorization).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import {
  assertToolResultOk,
  parseDeckToolResult,
  type DeckToolCaller,
} from "./agent-deck-bind.js";

export type AuthorizedDeckCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "infra_failure"; reason: string };

/** One-shot: connect under the deck header, run `fn`, always close. */
export async function withDeckClient<T>(
  deckId: string,
  timeoutMs: number,
  fn: (callTool: DeckToolCaller) => Promise<T>
): Promise<T> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: { "x-agent-deck-deck-id": deckId } },
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
 * Call one Deck MCP tool under the launch deck header. Never throws — network/timeout/
 * tool errors become `infra_failure`.
 */
export async function callDeckTool<T = Record<string, unknown>>(opts: {
  deckId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}): Promise<AuthorizedDeckCallResult<T>> {
  try {
    const result = await withDeckClient(opts.deckId, opts.timeoutMs, (callTool) =>
      callTool(opts.toolName, opts.arguments)
    );
    assertToolResultOk(result, opts.toolName);
    return { ok: true, data: parseDeckToolResult(result) as T };
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: (err as Error).message ?? String(err) };
  }
}

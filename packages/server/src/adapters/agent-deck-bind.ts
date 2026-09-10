// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session. A generated worktree must not
// inherit the original checkout's path-scoped deck binding, so before any playbook or
// deck-backed tool runs the coordinator binds the selected deck to the *actual* worktree
// path and verifies the effective binding came back as expected (design §"Worktree
// lifecycle and concurrency"). A mismatch or a tool failure returns a structured
// infrastructure outcome — it never throws and there is no silent fallback to an
// unbound/default deck.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAgentDeckMcpUrl } from "./agent-deck.js";

export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type BindVerification =
  | { ok: true; effectiveDeckId: string; summary: string }
  | { ok: false; reason: string };

/** Pull the text payload out of an MCP tool result and JSON-parse it. */
export function parseDeckToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const text = Array.isArray(content)
    ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n").trim()
    : "";
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text) as Record<string, unknown>;
}

function defaultCaller(timeoutMs: number): DeckToolCaller {
  return async (name, args) => {
    const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
    const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`));
    const client = new Client({ name: "agent-dealer-bind", version: "0.0.1" });
    const call = async () => {
      await client.connect(transport);
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await client.close();
      }
    };
    return Promise.race([
      call(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`deck tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  };
}

export async function bindAndVerify(opts: {
  deckId: string;
  worktreePath: string;
  callTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<BindVerification> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);
  const callTool = opts.callTool ?? defaultCaller(timeoutMs);

  try {
    await callTool("bind_workspace", { deckId: opts.deckId, workspaceRoot: opts.worktreePath });
  } catch (err) {
    return { ok: false, reason: `bind_workspace failed: ${(err as Error).message}` };
  }

  let binding: Record<string, unknown>;
  try {
    binding = parseDeckToolResult(await callTool("get_session_binding", {}));
  } catch (err) {
    return { ok: false, reason: `get_session_binding failed: ${(err as Error).message}` };
  }

  const effectiveDeckId = String(binding.effective_deck_id ?? "");
  if (effectiveDeckId !== opts.deckId) {
    return {
      ok: false,
      reason: `effective deck ${effectiveDeckId || "(none)"} does not match requested ${opts.deckId}`,
    };
  }

  // The binding tool does not always echo the workspace; assert it only when present.
  const boundWorkspace =
    typeof binding.workspace_root === "string"
      ? binding.workspace_root
      : typeof binding.effective_workspace_root === "string"
        ? binding.effective_workspace_root
        : null;
  if (boundWorkspace && boundWorkspace !== opts.worktreePath) {
    return {
      ok: false,
      reason: `bound workspace ${boundWorkspace} does not match worktree ${opts.worktreePath}`,
    };
  }

  const summary =
    typeof binding.display_summary === "string"
      ? binding.display_summary
      : `deck ${effectiveDeckId} bound to ${opts.worktreePath}`;
  return { ok: true, effectiveDeckId, summary };
}

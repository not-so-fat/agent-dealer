// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session. A generated worktree must not
// inherit the original checkout's path-scoped deck binding, so before any playbook or
// deck-backed tool runs the coordinator binds the selected deck to the *actual* worktree
// path and verifies the effective binding came back as expected (design §"Worktree
// lifecycle and concurrency"). A mismatch, an error result, or a tool failure returns a
// structured infrastructure outcome — it never throws and there is no silent fallback to
// an unbound/default deck.
//
// `bind_workspace` is session-scoped, so the bind and the verifying `get_session_binding`
// MUST run on one MCP client/session — a fresh client per call would not see the bind.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAgentDeckMcpUrl } from "./agent-deck.js";

/** One tool call within a single connected MCP session. */
export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type BindVerification =
  | { ok: true; effectiveDeckId: string; summary: string }
  | { ok: false; reason: string };

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  return Array.isArray(content)
    ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n").trim()
    : "";
}

/** MCP surfaces tool failures as `{ isError: true }` results, not thrown errors. */
export function assertToolResultOk(result: unknown, name: string): void {
  if ((result as { isError?: boolean } | null)?.isError) {
    throw new Error(`${name} returned an error: ${resultText(result) || "(no detail)"}`);
  }
}

/** Pull the text payload out of a (non-error) MCP tool result and JSON-parse it. */
export function parseDeckToolResult(result: unknown): Record<string, unknown> {
  const text = resultText(result);
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text) as Record<string, unknown>;
}

async function withDeckSession<T>(
  opts: { callTool?: DeckToolCaller; timeoutMs: number },
  fn: (call: DeckToolCaller) => Promise<T>
): Promise<T> {
  if (opts.callTool) return fn(opts.callTool);
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`));
  const client = new Client({ name: "agent-dealer-bind", version: "0.0.1" });
  await client.connect(transport);
  try {
    return await fn((name, args) =>
      Promise.race([
        client.callTool({ name, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`deck tool ${name} timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
        ),
      ])
    );
  } finally {
    await client.close();
  }
}

const WORKSPACE_FIELDS = [
  "workspaceRoot",
  "workspace_root",
  "effectiveWorkspaceRoot",
  "effective_workspace_root",
  "workspace",
];

export async function bindAndVerify(opts: {
  deckId: string;
  worktreePath: string;
  callTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<BindVerification> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);

  try {
    return await withDeckSession({ callTool: opts.callTool, timeoutMs }, async (call) => {
      const bindResult = await call("bind_workspace", {
        deckId: opts.deckId,
        workspaceRoot: opts.worktreePath,
      });
      assertToolResultOk(bindResult, "bind_workspace");

      const bindingResult = await call("get_session_binding", {});
      assertToolResultOk(bindingResult, "get_session_binding");
      const binding = parseDeckToolResult(bindingResult);

      const effectiveDeckId = String(binding.effective_deck_id ?? binding.effectiveDeckId ?? "");
      if (effectiveDeckId !== opts.deckId) {
        return {
          ok: false as const,
          reason: `effective deck ${effectiveDeckId || "(none)"} does not match requested ${opts.deckId}`,
        };
      }

      const boundWorkspace = WORKSPACE_FIELDS.map((f) => binding[f]).find(
        (v): v is string => typeof v === "string" && v.length > 0
      );
      if (boundWorkspace && boundWorkspace !== opts.worktreePath) {
        return {
          ok: false as const,
          reason: `bound workspace ${boundWorkspace} does not match worktree ${opts.worktreePath}`,
        };
      }

      const summary =
        typeof binding.display_summary === "string"
          ? binding.display_summary
          : `deck ${effectiveDeckId} bound to ${opts.worktreePath}`;
      return { ok: true as const, effectiveDeckId, summary };
    });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

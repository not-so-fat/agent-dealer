// packages/server/src/adapters/outbound-delivery.ts
//
// Deck-header delivery of an approved outbound draft (NOT-106 / NOT-95). The coordinator
// connects to Agent Deck's MCP with `x-agent-deck-deck-id` (no Authorization). An ambiguous
// transport failure (request may have reached the provider) is never silently retried.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OutboundToolCall } from "@agent-dealer/shared";
import {
  assertCallServiceToolSuccess,
  extractPermalink,
  getAgentDeckMcpUrl,
  toCallServiceToolPayload,
  type CallServiceToolPayload,
} from "./agent-deck.js";

export type DeliverOutboundResult =
  | { ok: true; toolResult: unknown; permalink?: string }
  /** The call timed out waiting for `call_service_tool`'s response — whether the provider
   * actually received and executed the send is unknown (NOT-95). Never silently auto-retried. */
  | { ok: false; kind: "ambiguous"; reason: string }
  /** Ordinary failure — connection error before the request reached Deck, or a provider-level
   * error. Bounded infra-retry, never parked. */
  | { ok: false; kind: "infra_failure"; reason: string };

const TIMEOUT_MESSAGE_RE = /timed out after \d+ms$/;

/** Thrown for every transport failure, typed by whether the request may already have reached
 * Deck's `call_service_tool` (NOT-95). */
export class OutboundDeliveryTransportError extends Error {
  readonly dispatched: boolean;
  constructor(message: string, dispatched: boolean) {
    super(message);
    this.name = "OutboundDeliveryTransportError";
    this.dispatched = dispatched;
  }
}

/** Connects with the deck header and calls `call_service_tool` exactly once. */
export async function callServiceToolOnDeck(opts: {
  deckId: string;
  payload: CallServiceToolPayload;
  timeoutMs: number;
}): Promise<unknown> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: {
      headers: { "x-agent-deck-deck-id": opts.deckId },
    },
  });
  const client = new Client({ name: "agent-dealer-deliver", version: "0.0.1" });
  const connectAndCall = async () => {
    try {
      await client.connect(transport);
    } catch (e) {
      throw new OutboundDeliveryTransportError(e instanceof Error ? e.message : String(e), false);
    }
    try {
      return await client.callTool({ name: "call_service_tool", arguments: opts.payload });
    } catch (e) {
      throw new OutboundDeliveryTransportError(e instanceof Error ? e.message : String(e), true);
    } finally {
      await client.close().catch(() => {});
    }
  };
  return await Promise.race([
    connectAndCall(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new OutboundDeliveryTransportError(`Outbound deliver timed out after ${opts.timeoutMs}ms`, true)),
        opts.timeoutMs
      )
    ),
  ]);
}

/**
 * Delivers one approved outbound draft under the profile/run deck header. Never throws —
 * failures come back typed so the caller can park only on `ambiguous` (NOT-95).
 */
export async function deliverOutboundDraft(
  deckId: string,
  toolCall: OutboundToolCall,
  opts?: {
    callTool?: (payload: CallServiceToolPayload) => Promise<unknown>;
    timeoutMs?: number;
  }
): Promise<DeliverOutboundResult> {
  const payload = toCallServiceToolPayload(toolCall);
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.DELIVER_TIMEOUT_MS ?? 60_000);

  const callTool =
    opts?.callTool ?? ((p: CallServiceToolPayload) => callServiceToolOnDeck({ deckId, payload: p, timeoutMs }));

  let toolResult: unknown;
  try {
    toolResult = await callTool(payload);
  } catch (err) {
    if (err instanceof OutboundDeliveryTransportError) {
      if (err.dispatched) {
        return { ok: false, kind: "ambiguous", reason: `${err.message} — whether the message was actually sent is unknown` };
      }
      return { ok: false, kind: "infra_failure", reason: err.message };
    }
    const reason = err instanceof Error ? err.message : String(err);
    if (TIMEOUT_MESSAGE_RE.test(reason)) {
      return { ok: false, kind: "ambiguous", reason: `${reason} — whether the message was actually sent is unknown` };
    }
    return { ok: false, kind: "infra_failure", reason };
  }

  try {
    assertCallServiceToolSuccess(toolResult);
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, toolResult, permalink: extractPermalink(toolResult) };
}

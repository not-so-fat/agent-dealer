// packages/server/src/adapters/outbound-delivery.ts
//
// Authority-scoped delivery of an approved outbound draft (NOT-95). Replaces the old bare,
// unauthenticated `bind_workspace` + `call_service_tool` path in agent-deck.ts's
// `deliverOutboundDraft`: the coordinator process connects directly to Agent Deck's MCP
// endpoint carrying this attempt's freshly minted, tool-scoped execution authority as an
// `Authorization: Bearer <authorityId>:<authoritySecret>` header — the same principal shape
// `agent-deck-bind.ts`'s `urlHeaderMcpConfig`/`verifyAuthority` and NOT-94's
// `reflect-authority.ts` already use for their own coordinator-side authority calls. No
// `bind_workspace` — under execution authority the deck/scope is already pinned at mint
// time. Kept in its own module (rather than agent-deck.ts) to avoid a circular import with
// agent-deck-bind.ts, whose `parseInteractionRequired` this needs.
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
import { parseInteractionRequired } from "./agent-deck-bind.js";

export interface DeliveryAuthority {
  authorityId: string;
  authoritySecret: string;
}

export type DeliverOutboundResult =
  | { ok: true; toolResult: unknown; permalink?: string }
  /** Agent Deck returned a typed control-plane requirement minting or calling under
   * execution authority — never retried with the same authority (NOT-95, same reasoning as
   * NOT-87's developer/reviewer outcomes). `requestId` is Deck's own correlation id, when
   * supplied, for dedupe against the human action it raises. */
  | { ok: false; kind: "interaction_required"; reason: string; requestId?: string }
  /** The call timed out waiting for `call_service_tool`'s response — whether the provider
   * (Slack/etc.) actually received and executed the send is genuinely unknown, unlike an
   * ordinary connection failure where the request never reached it (NOT-91). Never silently
   * auto-retried: a blind "retry send" here risks a duplicate provider effect, so this parks
   * for an explicit human decision exactly like `interaction_required`, distinguished only
   * by its reason text. */
  | { ok: false; kind: "ambiguous"; reason: string }
  /** Ordinary failure — a connection error before the request reached Deck, or a
   * provider-level (Slack/etc.) error surfaced through a successful-looking MCP result.
   * Bounded infra-retry (an explicit re-approve or "retry send"), never parked. */
  | { ok: false; kind: "infra_failure"; reason: string };

const TIMEOUT_MESSAGE_RE = /timed out after \d+ms$/;

/** Thrown by `callServiceToolUnderAuthority` for every failure, typed by whether the request
 * may already have reached Deck's `call_service_tool` (NOT-91 review). `dispatched: true`
 * covers a `client.callTool` failure or the race timeout — Deck may already have forwarded
 * the call to the provider before this connection failed, so the effect is unknown. `false`
 * is reserved for a failure before that point (the initial MCP handshake), where the request
 * is known to have never reached Deck at all. */
export class OutboundDeliveryTransportError extends Error {
  readonly dispatched: boolean;
  constructor(message: string, dispatched: boolean) {
    super(message);
    this.name = "OutboundDeliveryTransportError";
    this.dispatched = dispatched;
  }
}

/** Connects with `authority` as the session's only credential and calls `call_service_tool`
 * exactly once. No `bind_workspace`. */
export async function callServiceToolUnderAuthority(opts: {
  authority: DeliveryAuthority;
  payload: CallServiceToolPayload;
  timeoutMs: number;
}): Promise<unknown> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${opts.authority.authorityId}:${opts.authority.authoritySecret}` },
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
 * Delivers one approved outbound draft under an already-minted, tool-scoped execution
 * authority. Never throws — every failure (network/timeout, Deck's typed
 * `INTERACTION_REQUIRED`, or a provider-level error embedded in an otherwise-successful MCP
 * result) comes back as a typed `DeliverOutboundResult`, so the caller (approve-deliver.ts)
 * can distinguish "park for a human decision" from "ordinary failure, safe to bounded-retry"
 * without parsing error messages.
 */
export async function deliverOutboundDraft(
  authority: DeliveryAuthority,
  toolCall: OutboundToolCall,
  opts?: {
    callTool?: (payload: CallServiceToolPayload) => Promise<unknown>;
    timeoutMs?: number;
  }
): Promise<DeliverOutboundResult> {
  const payload = toCallServiceToolPayload(toolCall);
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.DELIVER_TIMEOUT_MS ?? 60_000);

  const callTool =
    opts?.callTool ?? ((p: CallServiceToolPayload) => callServiceToolUnderAuthority({ authority, payload: p, timeoutMs }));

  let toolResult: unknown;
  try {
    toolResult = await callTool(payload);
  } catch (err) {
    if (err instanceof OutboundDeliveryTransportError) {
      // `dispatched` means the request may already have reached Deck's call_service_tool
      // (the callTool phase, or the race timeout) — the provider effect is unknown, so this
      // must never be silently auto-retried. `false` means it failed before that (the MCP
      // handshake) — the request never reached Deck, so it's an ordinary retryable failure.
      if (err.dispatched) {
        return { ok: false, kind: "ambiguous", reason: `${err.message} — whether the message was actually sent is unknown` };
      }
      return { ok: false, kind: "infra_failure", reason: err.message };
    }
    // Legacy shape for callers/tests that inject a plain Error via opts.callTool instead of
    // the typed error above — fall back to the original timeout-text heuristic.
    const reason = err instanceof Error ? err.message : String(err);
    if (TIMEOUT_MESSAGE_RE.test(reason)) {
      return { ok: false, kind: "ambiguous", reason: `${reason} — whether the message was actually sent is unknown` };
    }
    return { ok: false, kind: "infra_failure", reason };
  }

  const interaction = parseInteractionRequired(toolResult);
  if (interaction) {
    return {
      ok: false,
      kind: "interaction_required",
      reason: interaction.message || "Agent Deck requires a control-plane decision before this draft can be delivered.",
      requestId: interaction.requestId,
    };
  }

  try {
    assertCallServiceToolSuccess(toolResult);
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, toolResult, permalink: extractPermalink(toolResult) };
}

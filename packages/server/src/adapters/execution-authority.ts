// packages/server/src/adapters/execution-authority.ts
//
// Mint/revoke short-lived Agent Deck execution authority for one run attempt (NOT-85 §5.2,
// §11; NOT-87). Replaces the legacy, spoofable `x-agent-deck-client` header paths and the
// unauthenticated MCP connections in agent-deck-bind.ts / agent-deck.ts's
// deliverOutboundDraft: every unattended Deck call must now carry a freshly minted
// authority, never a persistent grant copied into a worktree or prompt.
//
// A minted authority is used for exactly one attempt (one mint, one worker spawn or one
// coordinator-side call, then revoke) — callers never reuse an authority across attempts;
// a new attempt always mints again with a new idempotency key (NOT-85 §6.2, §8).
import { getAgentDeckApiUrl } from "./agent-deck.js";
import { getAgentDeckEnrollmentBearer } from "../repository/intake-settings.js";
import type { ExecutionAuthorityErrorCode } from "@agent-dealer/shared";

export interface AllowedTool {
  serviceId: string;
  toolName: string;
}

export interface MintedAuthority {
  authorityId: string;
  authoritySecret: string | null;
  deckId: string;
  audience: "dealer-worker";
  allowedServices: string[];
  allowedTools: AllowedTool[];
  expiresAt: string;
}

export type MintAuthorityResult =
  | { ok: true; authority: MintedAuthority }
  | {
      ok: false;
      code: ExecutionAuthorityErrorCode;
      message: string;
      /** Deck's own correlation id for this INTERACTION_REQUIRED response, when supplied
       * (NOT-85 §11's `AuditCorrelation.requestId`) — lets Dealer correlate/dedupe the
       * human action it raises against Deck's own audit trail (NOT-93). */
      requestId?: string;
    };

export interface MintAuthorityInput {
  runId: string;
  attemptId: string;
  deckId: string;
  /** Milliseconds from now; kept short — one attempt's worth of work, never a session-long grant. */
  ttlMs: number;
  /** Idempotency key scoped to the enrollment — reuse only for a genuine retry of the SAME attempt. */
  idempotencyKey: string;
  toolScopeHint?: AllowedTool[];
}

type DeckContractErrorBody = {
  ok?: boolean;
  error_code?: string;
  message?: string;
  /** Mirrors Deck's `AuditCorrelation` (agent_deck packages/backend/src/execution-authority/types.ts) —
   * only `requestId` is read here, everything else is unused by this client. */
  correlation?: { requestId?: string };
};

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "COORDINATOR_NOT_ENROLLED",
  "ENROLLMENT_REVOKED",
  "RESOURCE_OUT_OF_SCOPE",
  "INTERACTION_REQUIRED",
  "AUTHORITY_EXPIRED",
  "AUTHORITY_REVOKED",
  "INVALID_MINT_REQUEST",
]);

function mapErrorCode(code: string | undefined): ExecutionAuthorityErrorCode {
  if (code && KNOWN_CODES.has(code)) return code as ExecutionAuthorityErrorCode;
  return "DECK_UNAVAILABLE";
}

/** Mint execution authority for one run attempt. Never throws — every failure is a typed result. */
export async function mintAuthority(input: MintAuthorityInput): Promise<MintAuthorityResult> {
  const bearer = getAgentDeckEnrollmentBearer();
  if (!bearer) {
    return {
      ok: false,
      code: "COORDINATOR_NOT_ENROLLED",
      message:
        "Agent Deck coordinator is not enrolled — run `agent-deck coordinator enroll` and set " +
        "AGENT_DECK_COORDINATOR_ID / AGENT_DECK_ENROLLMENT_ID / AGENT_DECK_ENROLLMENT_SECRET.",
    };
  }
  try {
    const res = await fetch(`${getAgentDeckApiUrl()}/api/execution-authority/authorities`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: input.runId,
        attemptId: input.attemptId,
        deckId: input.deckId,
        audience: "dealer-worker",
        idempotencyKey: input.idempotencyKey,
        ttlMs: input.ttlMs,
        ...(input.toolScopeHint ? { toolScopeHint: input.toolScopeHint } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as
      | (DeckContractErrorBody & {
          data?: {
            authority: {
              authorityId: string;
              deckId: string;
              audience: "dealer-worker";
              allowedServices: string[];
              allowedTools: AllowedTool[];
              expiresAt: string;
            };
            authoritySecret: string | null;
            secretIssued: boolean;
          };
        })
      | null;
    if (!res.ok || !json || json.ok === false || !json.data) {
      return {
        ok: false,
        code: mapErrorCode(json?.error_code),
        message: json?.message ?? `mint failed: HTTP ${res.status}`,
        requestId: json?.correlation?.requestId,
      };
    }
    const { authority, authoritySecret } = json.data;
    return {
      ok: true,
      authority: {
        authorityId: authority.authorityId,
        authoritySecret,
        deckId: authority.deckId,
        audience: authority.audience,
        allowedServices: authority.allowedServices,
        allowedTools: authority.allowedTools,
        expiresAt: authority.expiresAt,
      },
    };
  } catch (e) {
    return { ok: false, code: "DECK_UNAVAILABLE", message: String(e) };
  }
}

/** Best-effort — an authority that fails to revoke still expires by TTL (NOT-85 §9). */
export async function revokeAuthority(authorityId: string): Promise<void> {
  const bearer = getAgentDeckEnrollmentBearer();
  if (!bearer) return;
  try {
    await fetch(`${getAgentDeckApiUrl()}/api/execution-authority/authorities/${encodeURIComponent(authorityId)}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best-effort — TTL still bounds exposure
  }
}

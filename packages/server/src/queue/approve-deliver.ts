// packages/server/src/queue/approve-deliver.ts
//
// Sends an approved outbound draft (Slack/email/service tool call) through a short-lived,
// tool-scoped Agent Deck execution authority — one mint, one delivery attempt, one revoke
// (NOT-95). Replaces the old bare `bind_workspace` path: nothing here ever reaches Agent
// Deck without a freshly minted authority narrowed to the draft's exact
// serviceId/toolName. A typed `INTERACTION_REQUIRED` (from mint or from the delivery call
// itself) leaves the draft pending and the run in `review`, and raises a durable
// `outbound_delivery_interaction_required` human action an operator resolves with
// `retry_send` (mints a fresh authority/attempt) or `reject` (no provider call) —
// `resolveOutboundDeliveryAction` below. Every other failure is an ordinary bounded-retry
// failure (a plain re-approve), never parked.
import type { OutboundToolCall, Run } from "@agent-dealer/shared";
import { deliverOutboundDraft, type DeliverOutboundResult, type DeliveryAuthority } from "../adapters/outbound-delivery.js";
import {
  mintAuthority as defaultMintAuthority,
  revokeAuthority as defaultRevokeAuthority,
  type MintAuthorityInput,
  type MintAuthorityResult,
} from "../adapters/execution-authority.js";
import { syncLinearForRun } from "../adapters/linear-sync.js";
import { addArtifact, appendEvent, getRun, transitionRun } from "../repository/runs.js";
import {
  deliverInFlight,
  getPendingOutboundDraft,
  incrementOutboundDeliveryAttempt,
  markOutboundDraftSent,
  patchPendingOutboundBody,
  rejectPendingOutboundDrafts,
  revertOutboundDraftToPending,
  type DeliverFn,
} from "../repository/outbound-drafts.js";
import {
  createHumanAction,
  findOpenHumanActionByRequestIdForRun,
  getHumanAction,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { scheduleReflect } from "./dispatcher.js";

export type ApproveDeliverResult =
  | { ok: true; run: Run; delivered: boolean }
  | { ok: false; code: 400 | 404 | 409 | 502; error: string; errorCode?: string };

/** One attempt's worth of work — long enough to cover mint + one call_service_tool round
 * trip, never a session-long grant (same reasoning as NOT-87's worker authorities). */
const DELIVERY_AUTHORITY_TTL_MS = 5 * 60_000;

function finalizeRunWithoutDelivery(runId: string): Run {
  const updated = transitionRun(runId, "done");
  syncLinearForRun(updated, "done").catch((e) => console.error("[linear-sync] done:", e));
  scheduleReflect(updated, { trigger: "approve" });
  return updated;
}

/** Raises (or dedupes, by Deck's own requestId) the one operator action this attempt's
 * INTERACTION_REQUIRED calls for — never a duplicate for the same underlying signal. */
function parkOnInteractionRequired(
  runId: string,
  draftArtifactId: string,
  toolCall: OutboundToolCall,
  reason: string,
  requestId?: string
): void {
  if (requestId) {
    const existing = findOpenHumanActionByRequestIdForRun(runId, "outbound_delivery_interaction_required", requestId);
    if (existing) return;
  }
  createHumanAction({
    runId,
    actionType: "outbound_delivery_interaction_required",
    reason,
    question: "Agent Deck requires a control-plane decision before this outbound draft can be delivered. Retry the send or reject the draft?",
    evidence: { draftArtifactId, serviceId: toolCall.serviceName, toolName: toolCall.toolName },
    responseOptions: [
      { choice: "retry_send", label: "Retry send" },
      { choice: "reject", label: "Reject draft" },
    ],
    requestId: requestId ?? null,
  });
}

export async function approveRunWithDeliver(
  runId: string,
  deps?: {
    deliver?: DeliverFn;
    mint?: (input: MintAuthorityInput) => Promise<MintAuthorityResult>;
    revoke?: (authorityId: string) => Promise<void>;
    outboundBody?: string;
  }
): Promise<ApproveDeliverResult> {
  const run = getRun(runId);
  if (!run) return { ok: false, code: 404, error: "Not found" };
  if (run.status !== "review") {
    return { ok: false, code: 400, error: "Run must be in review" };
  }
  if (deliverInFlight.has(runId)) {
    return { ok: false, code: 409, error: "Deliver already in progress" };
  }

  let pending = getPendingOutboundDraft(runId);
  if (pending && deps?.outboundBody !== undefined) {
    const trimmed = deps.outboundBody.trim();
    if (!trimmed) {
      return { ok: false, code: 400, error: "Outbound message body cannot be empty" };
    }
    if (trimmed !== pending.content.draft.summary.body) {
      const patched = patchPendingOutboundBody(pending.artifact.id, trimmed);
      if (!patched) {
        return { ok: false, code: 409, error: "Draft already sent or rejected" };
      }
      pending = getPendingOutboundDraft(runId);
    }
  }
  if (!pending) {
    return { ok: true, run: finalizeRunWithoutDelivery(runId), delivered: false };
  }

  if (!run.deckId) {
    return { ok: false, code: 502, error: "No deck bound — cannot deliver outbound draft" };
  }

  const mint = deps?.mint ?? defaultMintAuthority;
  const revoke = deps?.revoke ?? defaultRevokeAuthority;
  const deliver = deps?.deliver ?? deliverOutboundDraft;
  const draftArtifactId = pending.artifact.id;
  const toolCall = pending.content.draft.toolCall;

  deliverInFlight.add(runId);
  try {
    const claimed = markOutboundDraftSent(draftArtifactId);
    if (!claimed) {
      return { ok: false, code: 409, error: "Draft already sent or rejected" };
    }

    // Stable per-draft attemptId + a fresh idempotencyKey per real attempt (mirrors
    // developer-effect.ts's `${workItem.id}:${workItem.attemptCount}`) — a retry after
    // INTERACTION_REQUIRED always mints a genuinely distinct authority.
    const attemptCount = incrementOutboundDeliveryAttempt(draftArtifactId) ?? 1;
    const idempotencyKey = `${draftArtifactId}:${attemptCount}`;

    const minted = await mint({
      runId,
      attemptId: draftArtifactId,
      deckId: run.deckId,
      ttlMs: DELIVERY_AUTHORITY_TTL_MS,
      idempotencyKey,
      // Narrowed to exactly this draft's tool — an off-scope call is denied by Deck.
      toolScopeHint: [{ serviceId: toolCall.serviceName, toolName: toolCall.toolName }],
    });
    if (!minted.ok) {
      revertOutboundDraftToPending(draftArtifactId);
      appendEvent(runId, "deliver_failed", { error: minted.message, errorCode: minted.code });
      if (minted.code === "INTERACTION_REQUIRED") {
        parkOnInteractionRequired(runId, draftArtifactId, toolCall, minted.message, minted.requestId);
      }
      return { ok: false, code: 502, error: minted.message, errorCode: minted.code };
    }
    const { authority: mintedAuthority } = minted;
    if (!mintedAuthority.authoritySecret) {
      // Idempotent remint of a still-live authority never re-issues the secret — this
      // attempt has none to use. Each real attempt mints with a fresh idempotencyKey above,
      // so this should not happen in normal operation; surface as infra rather than
      // silently proceeding secret-less (same guard as agent-deck-bind.ts's
      // acquireWorkerAuthority).
      revertOutboundDraftToPending(draftArtifactId);
      const reason = `authority ${mintedAuthority.authorityId} minted without a secret (idempotent remint)`;
      appendEvent(runId, "deliver_failed", { error: reason, errorCode: "INVALID_MINT_REQUEST" });
      return { ok: false, code: 502, error: reason, errorCode: "INVALID_MINT_REQUEST" };
    }
    const authority: DeliveryAuthority = {
      authorityId: mintedAuthority.authorityId,
      authoritySecret: mintedAuthority.authoritySecret,
    };

    let result: DeliverOutboundResult;
    try {
      result = await deliver(authority, toolCall);
    } finally {
      // Revoke after every settled attempt — success, ordinary failure, or
      // interaction-required all count as "settled" here; a retry always mints fresh.
      await revoke(authority.authorityId);
    }

    if (!result.ok) {
      revertOutboundDraftToPending(draftArtifactId);
      const errorCode = result.kind === "interaction_required" ? "INTERACTION_REQUIRED" : "DELIVERY_FAILED";
      appendEvent(runId, "deliver_failed", { error: result.reason, errorCode });
      if (result.kind === "interaction_required") {
        parkOnInteractionRequired(runId, draftArtifactId, toolCall, result.reason, result.requestId);
      }
      return { ok: false, code: 502, error: result.reason, errorCode };
    }

    addArtifact(
      runId,
      "send_receipt",
      {
        draftArtifactId,
        sentAt: new Date().toISOString(),
        toolResult: result.toolResult as Record<string, unknown>,
        permalink: result.permalink,
      },
      "system"
    );

    return { ok: true, run: finalizeRunWithoutDelivery(runId), delivered: true };
  } finally {
    deliverInFlight.delete(runId);
  }
}

export type ResolveOutboundDeliveryResult =
  | { ok: true; runStatus: string; delivered: boolean }
  | { ok: false; code: number; error: string };

/**
 * Resolves an open `outbound_delivery_interaction_required` action — Run-scoped, so this
 * (like NOT-94's `resolveReflectionInteractionAction`) never goes through
 * `resolveHumanActionAndAdvance`, which assumes an Issue + workflow_instance.
 * `retry_send` re-attempts delivery of the still-pending draft (a fresh authority/attempt);
 * `reject` makes no provider call and finalizes the run without delivering.
 */
export async function resolveOutboundDeliveryAction(
  actionId: string,
  resolvedBy: string,
  choice: string,
  deps?: Parameters<typeof approveRunWithDeliver>[1]
): Promise<ResolveOutboundDeliveryResult> {
  const action = getHumanAction(actionId);
  if (!action) return { ok: false, code: 404, error: "Human action not found" };
  if (action.actionType !== "outbound_delivery_interaction_required") {
    return { ok: false, code: 400, error: `Action ${actionId} is not an outbound_delivery_interaction_required action` };
  }
  if (!action.runId) return { ok: false, code: 500, error: "Human action has no run" };
  if (action.status !== "open") return { ok: false, code: 409, error: "Human action already resolved" };
  if (choice !== "retry_send" && choice !== "reject") {
    return { ok: false, code: 400, error: `Invalid choice "${choice}" for outbound_delivery_interaction_required` };
  }

  resolveHumanAction(actionId, resolvedBy, { choice });

  if (choice === "reject") {
    rejectPendingOutboundDrafts(action.runId);
    const updated = finalizeRunWithoutDelivery(action.runId);
    return { ok: true, runStatus: updated.status, delivered: false };
  }

  // retry_send — the draft is still pending; an ordinary approve re-attempt mints a fresh
  // authority/attempt (a distinct idempotencyKey — see incrementOutboundDeliveryAttempt).
  const result = await approveRunWithDeliver(action.runId, deps);
  if (!result.ok) return { ok: false, code: result.code, error: result.error };
  return { ok: true, runStatus: result.run.status, delivered: result.delivered };
}

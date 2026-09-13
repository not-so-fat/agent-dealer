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
import { acquireAuthorityForAttempt, releaseAuthority } from "../adapters/authority-lifecycle.js";
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
  findOpenHumanActionForRun,
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

/** Who/what resolved a parked `outbound_delivery_interaction_required` action when
 * `finalizeRunWithoutDelivery` auto-closes it — `resolveOutboundDeliveryAction`'s
 * `retry_send` passes the real operator + "retry_send" through; every other caller (a plain
 * `/api/runs/:id/approve`, which carries no operator identity) gets this generic marker. */
const DEFAULT_ACTION_RESOLUTION = { resolvedBy: "system", choice: "resolved_via_approve" } as const;

/**
 * Resolves a run's open `outbound_delivery_interaction_required` action, if any — a no-op
 * otherwise. Any code path that terminalizes a run (finalize-on-success below, but also
 * `/api/runs/:id/retry` and `/api/runs/:id/cancel` in routes/index.ts, which move the run to
 * a terminal status without ever calling `approveRunWithDeliver` again) must call this, or a
 * parked action is left open forever: once the run leaves `review`, `resolveOutboundDeliveryAction`'s
 * `retry_send` 400s on "Run must be in review" and there is no other way to close the item.
 */
export function resolveOpenDeliveryParkForRun(
  runId: string,
  actionResolution: { resolvedBy: string; choice: string }
): void {
  const openAction = findOpenHumanActionForRun(runId, "outbound_delivery_interaction_required");
  if (openAction) {
    resolveHumanAction(openAction.id, actionResolution.resolvedBy, { choice: actionResolution.choice });
  }
}

/**
 * Finalizes a run that has no more delivery work to do (no pending draft, or the pending
 * draft was just sent). Also auto-resolves any still-open `outbound_delivery_interaction_required`
 * action for this run: an operator can clear a park either by resolving it directly
 * (`retry_send`/`reject`) or by simply re-approving from Ops once Deck's control-plane issue
 * is fixed out of band — either path must close the queue item, not just the run.
 */
function finalizeRunWithoutDelivery(
  runId: string,
  actionResolution: { resolvedBy: string; choice: string } = DEFAULT_ACTION_RESOLUTION
): Run {
  resolveOpenDeliveryParkForRun(runId, actionResolution);
  const updated = transitionRun(runId, "done");
  syncLinearForRun(updated, "done").catch((e) => console.error("[linear-sync] done:", e));
  scheduleReflect(updated, { trigger: "approve" });
  return updated;
}

/** Raises the one operator action this run's delivery blockage calls for — at most one
 * open `outbound_delivery_interaction_required` action per run at a time (same idempotent
 * re-raise convention as `product_scope_decision`'s `findOpenHumanAction`), regardless of
 * whether a retry hits the same or a different underlying Deck signal. This also means a
 * `retry_send` that hits INTERACTION_REQUIRED again finds its own (still-open, per
 * `resolveOutboundDeliveryAction` leaving it open on failure) action here and no-ops, rather
 * than piling up a second queue item for the same run. */
function parkOnInteractionRequired(
  runId: string,
  draftArtifactId: string,
  toolCall: OutboundToolCall,
  reason: string,
  requestId?: string
): void {
  const existing = findOpenHumanActionForRun(runId, "outbound_delivery_interaction_required");
  if (existing) return;
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
    /** Who/what to record as having resolved an open `outbound_delivery_interaction_required`
     * action for this run, if one is auto-closed on success (see `finalizeRunWithoutDelivery`).
     * `resolveOutboundDeliveryAction`'s `retry_send` passes the real operator + "retry_send";
     * omitted for a plain approve, which has no operator identity to record. */
    actionResolution?: { resolvedBy: string; choice: string };
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
    return { ok: true, run: finalizeRunWithoutDelivery(runId, deps?.actionResolution), delivered: false };
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
    // INTERACTION_REQUIRED always mints a genuinely distinct authority. Fail closed (never
    // default to attempt 1) if the CAS counter can't be advanced — silently reusing `:1`
    // could collide with a real prior attempt's idempotency key and hit the secret-less
    // remint path instead of mint a fresh authority.
    const attemptCount = incrementOutboundDeliveryAttempt(draftArtifactId);
    if (attemptCount === null) {
      revertOutboundDraftToPending(draftArtifactId);
      const reason = "Could not advance the delivery-attempt counter for this draft.";
      appendEvent(runId, "deliver_failed", { error: reason, errorCode: "INFRA_FAILURE" });
      return { ok: false, code: 502, error: reason, errorCode: "INFRA_FAILURE" };
    }
    const idempotencyKey = `${draftArtifactId}:${attemptCount}`;

    const acquired = await acquireAuthorityForAttempt({
      ownerKind: "outbound_delivery",
      ownerId: runId,
      runId,
      attemptId: draftArtifactId,
      deckId: run.deckId,
      ttlMs: DELIVERY_AUTHORITY_TTL_MS,
      idempotencyKey,
      // Narrowed to exactly this draft's tool — an off-scope call is denied by Deck.
      toolScopeHint: [{ serviceId: toolCall.serviceName, toolName: toolCall.toolName }],
      mint,
      revoke,
    });
    if (!acquired.ok) {
      revertOutboundDraftToPending(draftArtifactId);
      const errorCode = acquired.kind === "interaction_required" ? "INTERACTION_REQUIRED" : "INFRA_FAILURE";
      appendEvent(runId, "deliver_failed", { error: acquired.reason, errorCode });
      if (acquired.kind === "interaction_required") {
        parkOnInteractionRequired(runId, draftArtifactId, toolCall, acquired.reason, acquired.requestId);
      }
      return { ok: false, code: 502, error: acquired.reason, errorCode };
    }
    const { authority: mintedAuthority, attemptRowId } = acquired;
    const authority: DeliveryAuthority = {
      authorityId: mintedAuthority.authorityId,
      authoritySecret: mintedAuthority.authoritySecret!,
    };

    let result: DeliverOutboundResult;
    try {
      result = await deliver(authority, toolCall);
    } finally {
      // Revoke after every settled attempt — success, ordinary failure, or
      // interaction-required all count as "settled" here; a retry always mints fresh.
      await releaseAuthority(attemptRowId, authority.authorityId, revoke);
    }

    if (!result.ok) {
      revertOutboundDraftToPending(draftArtifactId);
      const errorCode =
        result.kind === "interaction_required" ? "INTERACTION_REQUIRED" : result.kind === "ambiguous" ? "AMBIGUOUS_RESULT" : "DELIVERY_FAILED";
      appendEvent(runId, "deliver_failed", { error: result.reason, errorCode });
      // Both park: an ambiguous timeout is never safe to silently bounded-retry (NOT-91) —
      // it needs the same explicit "retry send or reject" human decision as a Deck-side
      // INTERACTION_REQUIRED, distinguished only by the reason text an operator reads.
      if (result.kind === "interaction_required" || result.kind === "ambiguous") {
        parkOnInteractionRequired(runId, draftArtifactId, toolCall, result.reason, "requestId" in result ? result.requestId : undefined);
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

    return { ok: true, run: finalizeRunWithoutDelivery(runId, deps?.actionResolution), delivered: true };
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
 *
 * `reject` is always terminal: no provider call, action resolved immediately, run finalized
 * without delivering.
 *
 * `retry_send` re-attempts delivery of the still-pending draft (a fresh authority/attempt —
 * see `incrementOutboundDeliveryAttempt`). The action is resolved only once that attempt
 * actually *succeeds* — on any failure (an ordinary infra error, or Deck denying again with
 * a fresh INTERACTION_REQUIRED) the action is left open rather than resolved out from under
 * the operator: a resolved-but-failed retry would otherwise vanish from the one shared queue
 * with no way back to the still-blocked run (there is no per-run detail page to link to on
 * the legacy Run model). `approveRunWithDeliver`'s own park dedup
 * (`findOpenHumanActionForRun`) finds this same still-open action on a repeat
 * INTERACTION_REQUIRED and does not raise a second one.
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

  if (choice === "reject") {
    resolveHumanAction(actionId, resolvedBy, { choice });
    rejectPendingOutboundDrafts(action.runId);
    const updated = finalizeRunWithoutDelivery(action.runId);
    return { ok: true, runStatus: updated.status, delivered: false };
  }

  // retry_send — the draft is still pending; an ordinary approve re-attempt mints a fresh
  // authority/attempt (a distinct idempotencyKey — see incrementOutboundDeliveryAttempt).
  // actionResolution carries the real operator identity through to
  // finalizeRunWithoutDelivery's auto-close on success, so this action (not a generic
  // "system" marker) records who actually resolved it and how.
  const result = await approveRunWithDeliver(action.runId, { ...deps, actionResolution: { resolvedBy, choice } });
  if (!result.ok) {
    // Left open on purpose — see the doc comment above. The operator still sees this item
    // in the queue (and can retry again, or reject) instead of it disappearing on failure.
    return { ok: false, code: result.code, error: result.error };
  }
  return { ok: true, runStatus: result.run.status, delivered: result.delivered };
}

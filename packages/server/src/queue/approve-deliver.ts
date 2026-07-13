import type { Run } from "@agent-dealer/shared";
import { deliverOutboundDraft } from "../adapters/agent-deck.js";
import { syncLinearForRun } from "../adapters/linear-sync.js";
import { workspaceForRun } from "../runners/prompts.js";
import {
  addArtifact,
  appendEvent,
  getRun,
  transitionRun,
} from "../repository/runs.js";
import {
  deliverInFlight,
  getPendingOutboundDraft,
  markOutboundDraftSent,
  patchPendingOutboundBody,
  revertOutboundDraftToPending,
  type DeliverFn,
} from "../repository/outbound-drafts.js";
import { scheduleReflect } from "./dispatcher.js";

export type ApproveDeliverResult =
  | { ok: true; run: Run; delivered: boolean }
  | { ok: false; code: 400 | 404 | 409 | 502; error: string };

export async function approveRunWithDeliver(
  runId: string,
  deps?: { deliver?: DeliverFn; outboundBody?: string }
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
    const updated = transitionRun(runId, "done");
    syncLinearForRun(updated, "done").catch((e) => console.error("[linear-sync] done:", e));
    scheduleReflect(updated, { trigger: "approve" });
    return { ok: true, run: updated, delivered: false };
  }

  if (!run.deckId) {
    return { ok: false, code: 502, error: "No deck bound — cannot deliver outbound draft" };
  }

  const deliver = deps?.deliver ?? deliverOutboundDraft;
  deliverInFlight.add(runId);
  try {
    const claimed = markOutboundDraftSent(pending.artifact.id);
    if (!claimed) {
      return { ok: false, code: 409, error: "Draft already sent or rejected" };
    }

    let toolResult: unknown;
    let permalink: string | undefined;
    try {
      const result = await deliver(run.deckId, pending.content.draft.toolCall, {
        workspaceRoot: workspaceForRun(run),
      });
      toolResult = result.toolResult;
      permalink = result.permalink;
    } catch (err) {
      revertOutboundDraftToPending(pending.artifact.id);
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(runId, "deliver_failed", { error: message });
      return { ok: false, code: 502, error: message };
    }

    addArtifact(
      runId,
      "send_receipt",
      {
        draftArtifactId: pending.artifact.id,
        sentAt: new Date().toISOString(),
        toolResult: toolResult as Record<string, unknown>,
        permalink,
      },
      "system"
    );

    const updated = transitionRun(runId, "done");
    syncLinearForRun(updated, "done").catch((e) => console.error("[linear-sync] done:", e));
    scheduleReflect(updated, { trigger: "approve" });
    return { ok: true, run: updated, delivered: true };
  } finally {
    deliverInFlight.delete(runId);
  }
}

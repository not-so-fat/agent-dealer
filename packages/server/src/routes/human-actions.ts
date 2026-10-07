import type { FastifyInstance } from "fastify";
import { getHumanAction, listOpenHumanActions } from "../repository/human-actions.js";
import { resolveHumanActionAndAdvanceAsync } from "../coordinator/commands.js";
import { normalizeResolutionNote } from "../coordinator/human-resolution.js";
import { triggerIssueReflect, resolveReflectionInteractionAction } from "../coordinator/reflect-trigger.js";
import {
  isLinearMergeStaleAction,
  resolveLinearMergeStaleAction,
} from "../coordinator/linear-merge-verify.js";
import { resolveOutboundDeliveryAction } from "../queue/approve-deliver.js";

export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());

  app.post("/api/human-actions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Runtime-validated, not just cast: an untyped body (e.g. resolvedBy as a number) must
    // 400, not throw past `.trim()` into an uncaught 500.
    const body = req.body as Record<string, unknown> | undefined;
    const resolvedBy = typeof body?.resolvedBy === "string" ? body.resolvedBy.trim() : "";
    const choice = typeof body?.choice === "string" ? body.choice.trim() : "";
    if (!resolvedBy || !choice) {
      return reply.status(400).send({ error: "resolvedBy and choice are required" });
    }
    // NOT-272: optional human note for a product_scope_decision resolution — validated
    // the same way as resolvedBy/choice above (present-but-not-a-string 400s, never 500s).
    const normalizedNote = normalizeResolutionNote(body?.note);
    if (!normalizedNote.ok) {
      return reply.status(400).send({ error: normalizedNote.error });
    }

    // Read before resolving — the issue id this action belongs to, needed for the reflect
    // trigger below and stable regardless of how resolution turns out.
    const action = getHumanAction(id);
    if (!action) return reply.status(404).send({ error: "Human action not found" });

    // A reflection control-plane park never carries an active workflow instance to advance
    // (the issue is already `done`) — resolve it directly rather than through
    // resolveHumanActionAndAdvance's workflow state machine, which would 409 on "no active
    // workflow for this action" (NOT-94).
    if (action.actionType === "reflection_interaction_required") {
      const reflectResult = resolveReflectionInteractionAction(id, resolvedBy, choice);
      if (!reflectResult.ok) return reply.status(reflectResult.code).send({ error: reflectResult.error });
      return {
        issueStatus: reflectResult.issueStatus,
        nextWorkItemId: null,
        instanceCompleted: false,
        restarted: false,
      };
    }

    // Outbound-draft delivery parking (NOT-95) is Run-scoped, not Issue-scoped — same
    // reasoning as the reflection branch above: no active workflow instance to advance
    // through resolveHumanActionAndAdvance.
    if (action.actionType === "outbound_delivery_interaction_required") {
      const deliveryResult = await resolveOutboundDeliveryAction(id, resolvedBy, choice);
      if (!deliveryResult.ok) return reply.status(deliveryResult.code).send({ error: deliveryResult.error });
      return { runStatus: deliveryResult.runStatus, delivered: deliveryResult.delivered };
    }

    // NOT-362: the stale-source notice sits on an already-`done` issue with no
    // active workflow to advance — the generic resolver would 409 on "no active
    // workflow for this action" and the notice could never close. Resolve it
    // directly (same shape as the reflection branch above); `recheck` re-runs
    // the post-merge verification fire-and-forget.
    if (action.actionType === "policy_escalation" && isLinearMergeStaleAction(action)) {
      const staleResult = resolveLinearMergeStaleAction(id, resolvedBy, choice);
      if (!staleResult.ok) return reply.status(staleResult.code).send({ error: staleResult.error });
      return {
        issueStatus: staleResult.issueStatus,
        nextWorkItemId: null,
        instanceCompleted: false,
        restarted: false,
      };
    }

    // Awaits undraft+merge when final_review:complete (NOT-102) — sync resolve alone would
    // only park at AUTO_MERGE_INTENT and leave the PR draft.
    const result = await resolveHumanActionAndAdvanceAsync(id, resolvedBy, choice, {
      note: normalizedNote.note,
    });
    if (!result.ok) return reply.status(result.code).send({ error: result.error });

    // NOT-305: completion evidence is a best-effort Deck read (receipts) plus at most
    // one `signal_only` report per failure/correction trigger — resolution has already
    // committed above, so this must not hold the HTTP response hostage behind it: a
    // slow/offline deck would otherwise risk a client timeout on an already-resolved
    // action, whose retry then gets a spurious 409. Fire-and-forget; triggerIssueReflect
    // never throws (it records its own outcome as artifacts), so there is nothing here
    // to await or react to. Fires for every instance-completing resolution (done AND
    // closed): an attempts-exhausted close still owes its actual-use receipts and its
    // exhaustion signal even though no merge follows.
    if (result.instanceCompleted && action.issueId) {
      void triggerIssueReflect(action.issueId).catch(() => {});
    }

    return {
      issueStatus: result.issueStatus,
      nextWorkItemId: result.nextWorkItemId,
      instanceCompleted: result.instanceCompleted,
      restarted: result.restarted,
    };
  });
}

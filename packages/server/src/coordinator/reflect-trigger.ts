// packages/server/src/coordinator/reflect-trigger.ts
//
// NOT-305: issue-completion evidence for the issue-centric coordinator. Fires when a
// workflow instance reaches a terminal outcome (done or closed) — never on an
// automatic per-round repair.
//
// Two durable records, both owned by Dealer:
//
// 1. `playbook_use_receipt` artifacts: one per terminal worker session, naming exactly
//    the playbooks Deck actually observed that session fetch (NOT-304 correlation
//    seam). Recorded for clean runs too — receipts alone are the record then.
// 2. `deck_feedback_signal` artifacts + one `signal_only` Deck feedback record per
//    failure/correction trigger found in durable state: a human retry/correction, an
//    attempts-exhausted outcome, or a recurring blocking review finding. Clean runs
//    with no correction send nothing.
//
// This path never proposes a playbook patch (`kind: update`) and never appends generic
// `Notes` items: Dealer reports the observed failure with actual-use evidence, and Deck
// owns curation, attribution, and patch proposals. Every Deck call runs under the
// launch-fixed deck header (`x-agent-deck-deck-id`) via adapters/reflect-authority.ts —
// no mint, no Authorization. A Deck outage records a retryable/visible status and never
// changes the already-decided issue outcome.
//
// Resolving a legacy `reflection_interaction_required` action still bypasses
// `resolveHumanActionAndAdvance` (issue is already terminal).
import type { Issue } from "@agent-dealer/shared";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { callDeckTool } from "../adapters/reflect-authority.js";
import { getIssue } from "../repository/issues.js";
import { createIssueArtifact } from "../repository/artifacts.js";
import {
  collectPlaybookUseReceiptsForIssue,
  reportDeckFailureSignals,
  type PlaybookFeedbackDeps,
} from "./playbook-feedback.js";
import {
  getHumanAction,
  resolveHumanAction,
} from "../repository/human-actions.js";

export type ReflectDeps = PlaybookFeedbackDeps;

const defaultDeps: ReflectDeps = {
  checkHealth: checkAgentDeckHealth,
  callTool: callDeckTool,
};

/**
 * Records completion evidence for a terminal issue: actual-use receipts for every
 * terminal worker session, then one idempotent `signal_only` Deck report per
 * failure/correction trigger. Never throws — every failure mode is recorded as a
 * `reflect_status`/`playbook_use_receipt` artifact, never as an exception that would
 * undo the already-committed human-action resolution.
 */
export async function triggerIssueReflect(
  issueId: string,
  deps: ReflectDeps = defaultDeps
): Promise<"triggered" | "skipped" | "failed"> {
  const issue = getIssue(issueId);
  if (!issue) return "skipped";

  const receipts = await collectPlaybookUseReceiptsForIssue(issueId, deps);
  const signals = await reportDeckFailureSignals(issueId, deps);

  // A Deck outage during receipt collection is a visible, retryable issue-level
  // status even when no signal candidate exists — otherwise an offline Deck leaves
  // no trace that evidence is still missing. Never changes the issue outcome.
  if (receipts.errors > 0) {
    createIssueArtifact({
      issueId,
      kind: "reflect_status",
      author: "system",
      content: {
        status: "failed",
        reason: "Agent Deck offline — playbook-use receipt collection retryable on a later trigger",
        pendingReceipts: receipts.pending,
      },
    });
  }

  if (receipts.collected > 0 || signals.sent.length > 0) return "triggered";
  if (receipts.errors > 0 || signals.error) return "failed";
  return "skipped";
}

/**
 * Resolves an open `reflection_interaction_required` action. Deliberately bypasses
 * `resolveHumanActionAndAdvance`'s workflow state machine entirely (commands.ts) — that
 * machine requires an active workflow instance to advance, but this action is raised
 * against an issue that is already terminal with no active instance, and resolving it
 * must never reopen the issue or enqueue developer/reviewer work (NOT-94). `retry`
 * starts a brand new correlated evidence-collection attempt with its own new authority;
 * `dismiss` makes no further Deck call.
 */
export function resolveReflectionInteractionAction(
  actionId: string,
  resolvedBy: string,
  choice: string,
  deps: ReflectDeps = defaultDeps
): { ok: true; issueStatus: Issue["status"] } | { ok: false; code: number; error: string } {
  const action = getHumanAction(actionId);
  if (!action) return { ok: false, code: 404, error: "Human action not found" };
  if (action.actionType !== "reflection_interaction_required") {
    return { ok: false, code: 400, error: `Action ${actionId} is not a reflection_interaction_required action` };
  }
  // Always issue-scoped (reflection runs post-completion on an Issue) — narrows for TS.
  if (!action.issueId) return { ok: false, code: 500, error: "Human action has no issue" };
  if (action.status !== "open") return { ok: false, code: 409, error: "Human action already resolved" };
  if (choice !== "retry" && choice !== "dismiss") {
    return { ok: false, code: 400, error: `Invalid choice "${choice}" for reflection_interaction_required` };
  }

  resolveHumanAction(actionId, resolvedBy, { choice });
  if (choice === "retry") {
    void triggerIssueReflect(action.issueId, deps).catch(() => {});
  }
  const issue = getIssue(action.issueId);
  return { ok: true, issueStatus: issue?.status ?? "done" };
}

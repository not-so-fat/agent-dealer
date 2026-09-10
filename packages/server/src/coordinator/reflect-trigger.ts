import { checkAgentDeckHealth, fetchPlaybook, proposePlaybookPatch } from "../adapters/agent-deck.js";
import { appendWorkflowEvent } from "../repository/workflow-events.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { getIssue } from "../repository/issues.js";

/**
 * Fires once per completed workflow instance, only when the human resolves final_review
 * as complete — the closest analog to today's "approve" reflect trigger. Automatic
 * per-round repairs, attempts_exhausted, and policy_escalation never call this.
 */
export async function triggerReflectOnComplete(
  issueId: string,
  developerAgentDeckId: string | null,
  developerAgentPlaybookId: string | null
): Promise<"triggered" | "skipped"> {
  if (!developerAgentDeckId || !developerAgentPlaybookId) return "skipped";

  const issue = getIssue(issueId);
  if (!issue) return "skipped";

  const healthy = await checkAgentDeckHealth().catch(() => false);
  if (!healthy) {
    appendWorkflowEvent({
      issueId,
      type: "issue.completed",
      actorType: "system",
      stage: issue.status,
      payload: { reflect: "skipped", reason: "Agent Deck offline" },
    });
    return "skipped";
  }

  const playbook = await fetchPlaybook(developerAgentPlaybookId);
  const findings = listFindingsForIssue(issueId);
  const resolvedCount = findings.filter((f) => f.status === "resolved").length;

  const rationale = `Issue "${issue.title}" completed with ${findings.length} finding(s) tracked across rounds (${resolvedCount} resolved). Playbook: ${playbook.title}.`;

  const created = await proposePlaybookPatch(developerAgentDeckId, issueId, {
    // ReflectProposalSchema requires ops.min(1); this trigger doesn't spawn a session to
    // derive structured deltas the way runReflect() does, so it records the completion as
    // a single Notes item rather than sending an empty (schema-invalid) ops array.
    ops: [{ op: "add_item", section: "Notes", text: rationale }],
    rationale,
    playbook_id: developerAgentPlaybookId,
  });

  appendWorkflowEvent({
    issueId,
    type: "issue.completed",
    actorType: "system",
    stage: issue.status,
    payload: { reflect: "triggered", patchId: created.id },
  });
  return "triggered";
}

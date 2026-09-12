// packages/server/src/coordinator/reflect-trigger.ts
//
// NOT-64 reflect trigger for the issue-centric coordinator. Fires once, only when a human
// resolves `final_review` as "complete" (design doc §Coordinator step 7) — never on an
// automatic per-round repair, attempts_exhausted, or policy_escalation outcome.
//
// This is deliberately the lightweight of the two shapes `runReflect` (runners/reflect.ts,
// legacy Run-shaped) could take: it does NOT spawn a new agent session. Playbook learning
// needing real judgment is exactly what the legacy `runReflect` uses an LLM for, but doing
// that here would mean building a whole new spawn role (worktree lifecycle, args, prompt)
// for a P0 human-action ticket. Instead this synthesizes the proposal directly from what
// the coordinator already recorded: the developer's final implementation conclusion and
// the review verdicts/findings accumulated across rounds — the "final implementation
// conclusion + review history as input" the design doc calls for, minus the extra spawn.
import { parseStringList } from "@agent-dealer/shared";
import { checkAgentDeckHealth, fetchPlaybook, proposePlaybookPatch } from "../adapters/agent-deck.js";
import { getIssue } from "../repository/issues.js";
import { getAgent } from "../repository/agents.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";

export interface ReflectDeps {
  checkHealth: typeof checkAgentDeckHealth;
  fetchPlaybook: typeof fetchPlaybook;
  proposePatch: typeof proposePlaybookPatch;
}

const defaultDeps: ReflectDeps = {
  checkHealth: checkAgentDeckHealth,
  fetchPlaybook,
  proposePatch: proposePlaybookPatch,
};

function readConclusionExcerpt(issueId: string): string | null {
  const artifact = latestIssueArtifact(issueId, "implementation_conclusion");
  if (!artifact?.contentJson) return null;
  try {
    const text = (JSON.parse(artifact.contentJson) as { text?: string }).text?.trim();
    if (!text) return null;
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return null;
  }
}

function reviewRoundCount(issueId: string): { rounds: number; verdicts: string[] } {
  const verdicts = listWorkflowEventsForIssue(issueId)
    .filter((e) => e.type === "review.submitted")
    .map((e) => {
      try {
        return (JSON.parse(e.payloadJson ?? "{}") as { verdict?: string }).verdict ?? "unknown";
      } catch {
        return "unknown";
      }
    });
  return { rounds: verdicts.length, verdicts };
}

function buildRationale(issueId: string): string {
  const issue = getIssue(issueId)!;
  const findings = listFindingsForIssue(issueId);
  const resolved = findings.filter((f) => f.status === "resolved").length;
  const recurring = findings.filter((f) => f.status === "recurring").length;
  const { rounds, verdicts } = reviewRoundCount(issueId);
  const conclusion = readConclusionExcerpt(issueId);

  const parts = [
    `Issue "${issue.title}" completed after ${rounds} review round(s)${verdicts.length ? ` (${verdicts.join(" → ")})` : ""}.`,
    `${findings.length} finding(s) tracked across rounds (${resolved} resolved, ${recurring} recurring).`,
  ];
  if (conclusion) parts.push(`Final implementation conclusion: ${conclusion}`);
  return parts.join(" ");
}

/**
 * Fires once per completed workflow instance, only on final_review:complete. Never throws —
 * every failure mode (no deck/playbooks configured, Agent Deck offline, a failed patch
 * proposal) is recorded as a `reflect_status`/`playbook_patch` artifact and reported back
 * as a result the caller can log, not an exception that would undo the already-committed
 * human-action resolution.
 */
export async function triggerIssueReflect(
  issueId: string,
  deps: ReflectDeps = defaultDeps
): Promise<"triggered" | "skipped" | "failed"> {
  const issue = getIssue(issueId);
  if (!issue) return "skipped";

  const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
  const deckId = developerAgent?.deckId ?? null;
  const playbookIds = parseStringList(developerAgent?.playbookIdsJson);
  if (!deckId || playbookIds.length === 0) return "skipped";

  const healthy = await deps.checkHealth().catch(() => false);
  if (!healthy) {
    createIssueArtifact({
      issueId,
      kind: "reflect_status",
      author: "system",
      content: { status: "skipped", reason: "Agent Deck offline" },
    });
    return "skipped";
  }

  const rationale = buildRationale(issueId);
  let anySucceeded = false;
  let anyFailed = false;

  for (const playbookId of playbookIds) {
    try {
      const playbook = await deps.fetchPlaybook(playbookId);
      const created = await deps.proposePatch(deckId, issueId, {
        ops: [{ op: "add_item", section: "Notes", text: rationale }],
        rationale,
        playbook_id: playbookId,
      });
      createIssueArtifact({
        issueId,
        kind: "playbook_patch",
        author: "system",
        content: { patchId: created.id, playbookId, playbookTitle: playbook.title, rationale, status: "proposed" },
      });
      anySucceeded = true;
    } catch (err) {
      createIssueArtifact({
        issueId,
        kind: "reflect_status",
        author: "system",
        content: { status: "failed", playbookId, error: String(err) },
      });
      anyFailed = true;
    }
  }

  createIssueArtifact({
    issueId,
    kind: "reflect_status",
    author: "system",
    content: { status: anySucceeded ? (anyFailed ? "partial" : "completed") : "failed", playbookCount: playbookIds.length },
  });
  return anySucceeded ? "triggered" : "failed";
}

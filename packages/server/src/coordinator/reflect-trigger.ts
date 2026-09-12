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
import type { Issue } from "@agent-dealer/shared";
import { parseProfileSnapshot } from "@agent-dealer/shared";
import { checkAgentDeckHealth, fetchPlaybook, proposePlaybookPatch } from "../adapters/agent-deck.js";
import { getIssue } from "../repository/issues.js";
import { getAgent } from "../repository/agents.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { buildProfileSnapshot } from "./profile-snapshot.js";

/**
 * The reflect proposal must target the deck/playbooks the developer actually ran with —
 * not whatever the live, possibly-since-edited agent profile says now. The frozen
 * `profileSnapshotJson` on the issue's most recent developer session is the ground truth
 * (design §"Immutable execution-profile snapshot"); only a session with no snapshot
 * recorded (a legacy/pre-NOT-60 row) falls back to a live profile resolve — via
 * `buildProfileSnapshot`, the SAME function that produces the frozen snapshot in the first
 * place, so the singular-legacy-`playbookId` fallback it already implements
 * (`profilePlaybookIds`) applies here too instead of being reimplemented (and getting
 * missed) a second time.
 */
function resolveReflectTargets(issue: Issue): { deckId: string | null; playbookIds: string[] } {
  const developerSessions = listWorkerSessionsForIssue(issue.id).filter((s) => s.role === "developer");
  const finalSession = developerSessions[developerSessions.length - 1] ?? null;
  const snapshot = finalSession ? parseProfileSnapshot(finalSession.profileSnapshotJson) : null;
  if (snapshot) return { deckId: snapshot.deckId, playbookIds: snapshot.playbookIds };

  const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
  if (!developerAgent) return { deckId: null, playbookIds: [] };
  const fallback = buildProfileSnapshot(developerAgent, "developer");
  return { deckId: fallback.deckId, playbookIds: fallback.playbookIds };
}

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

  const { deckId, playbookIds } = resolveReflectTargets(issue);
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

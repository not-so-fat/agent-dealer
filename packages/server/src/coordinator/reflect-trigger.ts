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
//
// NOT-106: every Deck call this makes (get_playbook, propose_playbook_patch) runs under
// the launch-fixed deck header (`x-agent-deck-deck-id`) via adapters/reflect-authority.ts —
// no mint, no Authorization. Resolving a legacy `reflection_interaction_required` action
// still bypasses `resolveHumanActionAndAdvance` (issue is already `done`).
import type { Issue } from "@agent-dealer/shared";
import { parseProfileSnapshot, parseStringList } from "@agent-dealer/shared";
import { randomUUID } from "node:crypto";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { callDeckTool } from "../adapters/reflect-authority.js";
import { getIssue } from "../repository/issues.js";
import { getAgent } from "../repository/agents.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { listArtifactsForIssueByKind } from "../repository/artifacts-for-issue.js";
import {
  getHumanAction,
  resolveHumanAction,
} from "../repository/human-actions.js";

const REFLECT_TOOL_TIMEOUT_MS = 15_000;

/**
 * Reflect targets the deck the developer actually ran with (frozen snapshot). Playbook
 * ids are no longer on the snapshot (NOT-149) — only dead legacy agent columns still
 * carry them for in-flight profiles. New agents with an empty legacy list skip reflect
 * until a follow-up discovers playbooks dynamically from the Deck.
 */
function resolveReflectTargets(issue: Issue): { deckId: string | null; playbookIds: string[] } {
  const developerSessions = listWorkerSessionsForIssue(issue.id).filter((s) => s.role === "developer");
  const finalSession = developerSessions[developerSessions.length - 1] ?? null;
  const snapshot = finalSession ? parseProfileSnapshot(finalSession.profileSnapshotJson) : null;
  const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
  const deckId = snapshot?.deckId ?? developerAgent?.deckId ?? null;
  if (!developerAgent) return { deckId, playbookIds: [] };
  const fromList = parseStringList(developerAgent.playbookIdsJson);
  if (fromList.length) return { deckId, playbookIds: fromList };
  return { deckId, playbookIds: developerAgent.playbookId ? [developerAgent.playbookId] : [] };
}

export interface ReflectDeps {
  checkHealth: typeof checkAgentDeckHealth;
  callTool: typeof callDeckTool;
}

const defaultDeps: ReflectDeps = {
  checkHealth: checkAgentDeckHealth,
  callTool: callDeckTool,
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
 * Playbook ids this issue already has a `playbook_patch` artifact for, from any earlier
 * reflect attempt (i.e. a prior attempt that parked partway through, before a `retry`).
 * The retry loop skips these instead of re-proposing — otherwise a park on playbook N
 * after playbooks `1..N-1` already succeeded would duplicate their Notes items on retry
 * (PR #21 review finding #1). Reflect fires at most once per issue outside of retries, so
 * every artifact this finds genuinely belongs to this same reflection, never a later
 * unrelated one.
 *
 * NOT-96: queries `playbook_patch` rows by kind directly rather than scanning the
 * newest-first, all-kinds `listArtifactsForIssue` window — on an artifact-heavy issue an
 * older `playbook_patch` could otherwise fall outside that window and get re-proposed.
 */
function alreadyProposedPlaybookIds(issueId: string): Set<string> {
  const ids = new Set<string>();
  for (const artifact of listArtifactsForIssueByKind(issueId, "playbook_patch")) {
    try {
      const playbookId = (JSON.parse(artifact.contentJson ?? "{}") as { playbookId?: string }).playbookId;
      if (playbookId) ids.add(playbookId);
    } catch {
      // malformed content — nothing to skip on its account
    }
  }
  return ids;
}

function recordStatus(issueId: string, content: Record<string, unknown>): void {
  createIssueArtifact({ issueId, kind: "reflect_status", author: "system", content });
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
    recordStatus(issueId, { status: "skipped", reason: "Agent Deck offline" });
    return "skipped";
  }

  const attemptId = randomUUID();
  const rationale = buildRationale(issueId);
  const alreadyProposed = alreadyProposedPlaybookIds(issueId);
  let anySucceeded = false;
  let anyFailed = false;

  for (const playbookId of playbookIds) {
    if (alreadyProposed.has(playbookId)) {
      // A prior attempt for this issue already proposed this playbook's patch — a retry
      // must not duplicate it (PR #21 review finding #1).
      anySucceeded = true;
      continue;
    }

    const playbook = await deps.callTool<{ id: string; title: string; body: string }>({
      deckId,
      toolName: "get_playbook",
      arguments: { playbook_id: playbookId },
      timeoutMs: REFLECT_TOOL_TIMEOUT_MS,
    });
    if (!playbook.ok) {
      recordStatus(issueId, { status: "failed", attemptId, error: playbook.reason });
      anyFailed = true;
      continue;
    }

    const proposed = await deps.callTool<{ id: string; playbookId: string | null }>({
      deckId,
      toolName: "propose_playbook_patch",
      arguments: {
        kind: "update",
        playbook_id: playbookId,
        ops: [{ op: "add_item", section: "Notes", text: rationale }],
        rationale,
      },
      timeoutMs: REFLECT_TOOL_TIMEOUT_MS,
    });
    if (!proposed.ok) {
      recordStatus(issueId, { status: "failed", attemptId, error: proposed.reason });
      anyFailed = true;
      continue;
    }

    createIssueArtifact({
      issueId,
      kind: "playbook_patch",
      author: "system",
      content: {
        patchId: proposed.data.id,
        playbookId,
        playbookTitle: playbook.data.title,
        rationale,
        status: "proposed",
      },
    });
    anySucceeded = true;
  }

  recordStatus(issueId, {
    status: anySucceeded ? (anyFailed ? "partial" : "completed") : "failed",
    attemptId,
    playbookCount: playbookIds.length,
  });
  return anySucceeded ? "triggered" : "failed";
}

/**
 * Resolves an open `reflection_interaction_required` action. Deliberately bypasses
 * `resolveHumanActionAndAdvance`'s workflow state machine entirely (commands.ts) — that
 * machine requires an active workflow instance to advance, but this action is raised
 * against an issue that is already `done` with no active instance, and resolving it must
 * never reopen the issue or enqueue developer/reviewer work (NOT-94). `retry` starts a
 * brand new correlated reflection attempt with its own new authority; `dismiss` makes no
 * further Deck call.
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

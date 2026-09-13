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
// NOT-94: every Deck call this makes (get_playbook, propose_playbook_patch) runs under a
// freshly minted, short-lived execution authority scoped to the frozen deck/playbook
// snapshot — never `x-agent-deck-client`, dashboard headers, copied workspace grants, or
// agent-admin (NOT-85's contract). Each call goes through the coordinator's own
// authority-authenticated MCP connection (adapters/reflect-authority.ts), the same
// principal shape a worker's isolated MCP config carries. A Deck-side `INTERACTION_REQUIRED`
// for the mint or any tool call durably parks that one reflection attempt behind a
// `reflection_interaction_required` human action — deliberately never routed through
// `resolveHumanActionAndAdvance`'s workflow state machine: the issue is already `done`, and
// resolving this action must never reopen it or enqueue developer/reviewer work. Retrying
// starts a brand new correlated attempt with a fresh authority; dismissing makes no further
// Deck call.
import type { Issue } from "@agent-dealer/shared";
import { parseProfileSnapshot } from "@agent-dealer/shared";
import { randomUUID } from "node:crypto";
import { checkAgentDeckHealth } from "../adapters/agent-deck.js";
import { mintAuthority, revokeAuthority, type MintAuthorityResult } from "../adapters/execution-authority.js";
import { callAuthorizedDeckTool, type AuthorizedDeckCallResult } from "../adapters/reflect-authority.js";
import { getIssue } from "../repository/issues.js";
import { getAgent } from "../repository/agents.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { createIssueArtifact, latestIssueArtifact } from "../repository/artifacts.js";
import { listArtifactsForIssue } from "../repository/artifacts-for-issue.js";
import {
  createHumanAction,
  findOpenHumanActionByRequestId,
  getHumanAction,
  resolveHumanAction,
} from "../repository/human-actions.js";
import { buildProfileSnapshot } from "./profile-snapshot.js";

/** One attempt's worth of work — long enough to fetch/propose every playbook in the
 * snapshot sequentially, never a session-long grant (NOT-85 §5.2). */
const REFLECT_AUTHORITY_TTL_MS = 5 * 60_000;
const REFLECT_TOOL_TIMEOUT_MS = 15_000;

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
  mintAuthority: typeof mintAuthority;
  revokeAuthority: typeof revokeAuthority;
  callTool: typeof callAuthorizedDeckTool;
}

const defaultDeps: ReflectDeps = {
  checkHealth: checkAgentDeckHealth,
  mintAuthority,
  revokeAuthority,
  callTool: callAuthorizedDeckTool,
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
 */
function alreadyProposedPlaybookIds(issueId: string): Set<string> {
  const ids = new Set<string>();
  for (const artifact of listArtifactsForIssue(issueId, { limit: 200 })) {
    if (artifact.kind !== "playbook_patch") continue;
    try {
      const playbookId = (JSON.parse(artifact.contentJson ?? "{}") as { playbookId?: string }).playbookId;
      if (playbookId) ids.add(playbookId);
    } catch {
      // malformed content — nothing to skip on its account
    }
  }
  return ids;
}

/**
 * Raises (or dedupes onto) the one open `reflection_interaction_required` action for this
 * issue/requestId (NOT-93's requestId-dedupe pattern, mirrored here for reflection instead
 * of a worker attempt). Deliberately never touches issue status or workflow instances —
 * the issue is already `done`.
 */
function parkReflectAttempt(issueId: string, reason: string, requestId?: string): void {
  if (requestId) {
    const existing = findOpenHumanActionByRequestId(issueId, "reflection_interaction_required", requestId);
    if (existing) return;
  }
  createHumanAction({
    issueId,
    actionType: "reflection_interaction_required",
    reason,
    question: `${reason} Retry the reflection, or dismiss?`,
    responseOptions: [
      { choice: "retry", label: "Retry reflection" },
      { choice: "dismiss", label: "Dismiss" },
    ],
    requestId: requestId ?? null,
  });
}

function recordStatus(issueId: string, content: Record<string, unknown>): void {
  createIssueArtifact({ issueId, kind: "reflect_status", author: "system", content });
}

/**
 * Fires once per completed workflow instance, only on final_review:complete. Never throws —
 * every failure mode (no deck/playbooks configured, Agent Deck offline, a denied mint, a
 * failed or parked patch proposal) is recorded as a `reflect_status`/`playbook_patch`
 * artifact (and, for a control-plane requirement, a `reflection_interaction_required`
 * human action) and reported back as a result the caller can log, not an exception that
 * would undo the already-committed human-action resolution.
 */
export async function triggerIssueReflect(
  issueId: string,
  deps: ReflectDeps = defaultDeps
): Promise<"triggered" | "skipped" | "failed" | "parked"> {
  const issue = getIssue(issueId);
  if (!issue) return "skipped";

  const { deckId, playbookIds } = resolveReflectTargets(issue);
  if (!deckId || playbookIds.length === 0) return "skipped";

  const healthy = await deps.checkHealth().catch(() => false);
  if (!healthy) {
    recordStatus(issueId, { status: "skipped", reason: "Agent Deck offline" });
    return "skipped";
  }

  // A fresh, correlated attempt id every call — never reused across retries (NOT-85 §6.2,
  // §8): it doubles as the mint idempotency key and as the correlation Deck's own audit
  // trail and this attempt's artifacts share.
  const attemptId = randomUUID();
  const minted: MintAuthorityResult = await deps.mintAuthority({
    runId: issueId,
    attemptId,
    deckId,
    ttlMs: REFLECT_AUTHORITY_TTL_MS,
    idempotencyKey: attemptId,
  });
  if (!minted.ok) {
    if (minted.code === "INTERACTION_REQUIRED") {
      parkReflectAttempt(issueId, minted.message, minted.requestId);
      recordStatus(issueId, { status: "parked", attemptId, reason: minted.message });
      return "parked";
    }
    recordStatus(issueId, { status: "failed", attemptId, error: `${minted.code}: ${minted.message}` });
    return "failed";
  }
  const { authority } = minted;
  if (!authority.authoritySecret) {
    // Idempotent remint of a still-live authority under the same idempotency key never
    // re-issues the secret (NOT-85 §7) — shouldn't happen since attemptId is fresh every
    // call, but surface as infra rather than silently proceeding secret-less.
    await deps.revokeAuthority(authority.authorityId);
    recordStatus(issueId, {
      status: "failed",
      attemptId,
      error: `authority ${authority.authorityId} minted without a secret (idempotent remint)`,
    });
    return "failed";
  }

  const rationale = buildRationale(issueId);
  const alreadyProposed = alreadyProposedPlaybookIds(issueId);
  let anySucceeded = false;
  let anyFailed = false;
  let parked = false;

  /** Records a plain infra failure and returns false, or parks the attempt (recording a
   * `reflection_interaction_required` action) and returns true. */
  const handleToolFailure = (result: Extract<AuthorizedDeckCallResult<unknown>, { ok: false }>): boolean => {
    if (result.kind === "interaction_required") {
      parkReflectAttempt(issueId, result.reason, result.requestId);
      return true;
    }
    recordStatus(issueId, { status: "failed", attemptId, error: result.reason });
    return false;
  };

  try {
    for (const playbookId of playbookIds) {
      if (alreadyProposed.has(playbookId)) {
        // A prior attempt for this issue already proposed this playbook's patch — a retry
        // must not duplicate it (PR #21 review finding #1).
        anySucceeded = true;
        continue;
      }

      const playbook = await deps.callTool<{ id: string; title: string; body: string }>({
        authorityId: authority.authorityId,
        authoritySecret: authority.authoritySecret,
        toolName: "get_playbook",
        arguments: { playbook_id: playbookId },
        timeoutMs: REFLECT_TOOL_TIMEOUT_MS,
      });
      if (!playbook.ok) {
        if (handleToolFailure(playbook)) {
          parked = true;
          break;
        }
        anyFailed = true;
        continue;
      }

      const proposed = await deps.callTool<{ id: string; playbookId: string | null }>({
        authorityId: authority.authorityId,
        authoritySecret: authority.authoritySecret,
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
        if (handleToolFailure(proposed)) {
          parked = true;
          break;
        }
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
  } finally {
    await deps.revokeAuthority(authority.authorityId);
  }

  if (parked) {
    recordStatus(issueId, { status: "parked", attemptId, playbookCount: playbookIds.length });
    return "parked";
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

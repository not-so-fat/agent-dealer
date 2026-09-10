import type { FastifyInstance } from "fastify";
import type { HumanAction } from "@agent-dealer/shared";
import { getDb } from "../db/index.js";
import { listOpenHumanActions, resolveHumanAction, getHumanAction } from "../repository/human-actions.js";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import { createWorkerSession } from "../repository/worker-sessions.js";
import { completeWorkflowInstance, listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { parseHumanResolution, resolveHumanActionOutcome } from "../coordinator/human-resolution.js";
import { triggerReflectOnComplete } from "../coordinator/reflect-trigger.js";
import { resolveProfile } from "../coordinator/session-lifecycle.js";
import { getAgent } from "../repository/agents.js";

export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());

  app.post("/api/human-actions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy: string; choice: string };

    const existing = getHumanAction(id);
    if (!existing) return reply.status(404).send({ error: "Human action not found" });

    // Validate the choice against this action type's allowed response options before
    // touching any state — an unrecognized choice is a 400, never a silent "close".
    const resolution = parseHumanResolution(existing.actionType, body.choice);
    if (!resolution) {
      return reply.status(400).send({ error: `Invalid choice "${body.choice}" for action type "${existing.actionType}"` });
    }

    // Idempotent: resolveHumanAction's UPDATE ... WHERE status='open' is a silent no-op on
    // an already-resolved action (it re-reads and returns the same resolved row rather than
    // throwing), so "was this call the one that actually resolved it" must be checked
    // before resolving, not inferred from an exception that never comes.
    const wasOpen = existing.status === "open";
    if (!wasOpen) {
      return existing;
    }

    const issue = getIssue(existing.issueId);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const outcome = resolveHumanActionOutcome(resolution);

    // All the synchronous DB writes — resolving the action, transitioning the issue,
    // completing the workflow instance, and (if applicable) starting the next round —
    // commit or roll back together. A failure partway through must not leave a resolved
    // action with an issue stuck in its pre-resolution state.
    const action: HumanAction = getDb().transaction(() => {
      const resolved = resolveHumanAction(id, body.resolvedBy, { choice: body.choice });

      transitionIssue(issue.id, outcome.issueStatus, {
        currentOwner: outcome.issueStatus === "developing" || outcome.issueStatus === "repairing" ? "developer" : "system",
      });

      if (outcome.workflowOutcome) {
        const events = listWorkflowEventsForIssue(issue.id);
        const instanceId = events.find((e) => e.workflowInstanceId)?.workflowInstanceId;
        if (instanceId) completeWorkflowInstance(instanceId, outcome.workflowOutcome);
      }

      if (outcome.startNewRound) {
        incrementIssueRound(issue.id);
        const next = getIssue(issue.id)!;
        const developerProfile = resolveProfile(issue.developerAgentId);
        createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: developerProfile.runtime, model: developerProfile.model });
      }

      return resolved;
    })();

    // Reflect is a best-effort network call to Agent Deck — it cannot run inside a
    // synchronous better-sqlite3 transaction, so it happens after the state above has
    // already committed. Its own failure does not roll back the resolution.
    if (outcome.triggerReflect) {
      const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
      await triggerReflectOnComplete(issue.id, developerAgent?.deckId ?? null, developerAgent?.playbookId ?? null);
    }

    return action;
  });
}

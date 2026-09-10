import type { FastifyInstance } from "fastify";
import { listOpenHumanActions, resolveHumanAction } from "../repository/human-actions.js";
import { getIssue, transitionIssue, incrementIssueRound } from "../repository/issues.js";
import { createWorkerSession } from "../repository/worker-sessions.js";
import { completeWorkflowInstance, listWorkflowEventsForIssue } from "../repository/workflow-events.js";
import { resolveHumanActionOutcome, type HumanResolution } from "../coordinator/human-resolution.js";
import { triggerReflectOnComplete } from "../coordinator/reflect-trigger.js";
import { getAgent } from "../repository/agents.js";

export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());

  app.post("/api/human-actions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy: string; choice: string };

    // Determine idempotency *before* resolving: resolveHumanAction only throws when the
    // action id doesn't exist at all — resolving an already-resolved action is a silent
    // no-op UPDATE that returns the (already resolved) row rather than throwing. So the
    // only reliable way to detect "this call is the one that actually resolved it" is to
    // check open-ness first, not to catch an exception that never comes on a double-resolve.
    const wasOpen = listOpenHumanActions().some((a) => a.id === id);

    let action;
    try {
      action = resolveHumanAction(id, body.resolvedBy, { choice: body.choice });
    } catch {
      return reply.status(404).send({ error: "Human action not found" });
    }

    if (!wasOpen) {
      // Idempotent: already resolved by a prior call. Return its resolved state without
      // re-applying side effects (transitionIssue would reject a terminal->terminal
      // self-transition like done->done, and we must not double-increment rounds or
      // double-fire reflect).
      return action;
    }

    const issue = getIssue(action.issueId);
    if (!issue) return reply.status(404).send({ error: "Issue not found" });

    const resolution = { actionType: action.actionType, choice: body.choice } as HumanResolution;
    const outcome = resolveHumanActionOutcome(resolution);

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
      createWorkerSession({ issueId: issue.id, role: "developer", round: next.currentRound, agentId: issue.developerAgentId, runtime: "claude_code" });
    }

    if (outcome.triggerReflect) {
      const developerAgent = issue.developerAgentId ? getAgent(issue.developerAgentId) : null;
      await triggerReflectOnComplete(issue.id, developerAgent?.deckId ?? null, developerAgent?.playbookId ?? null);
    }

    return action;
  });
}

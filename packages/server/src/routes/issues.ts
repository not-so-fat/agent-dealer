// packages/server/src/routes/issues.ts
import type { FastifyInstance } from "fastify";
import { CreateIssueInput, IssueStatus, UpdateIssueInput } from "@agent-dealer/shared";
import { createIssue, getIssue, listIssues, findIssueByExternalId, updateIssue } from "../repository/issues.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { listArtifactsForIssue } from "../repository/artifacts-for-issue.js";
import { listUsageEventsForIssue, summarizeIssueUsage } from "../repository/usage-events.js";
import {
  listWorkflowEventsForIssue,
  appendWorkflowEvent,
  listWorkflowInstancesForIssue,
  getActiveWorkflowInstance,
} from "../repository/workflow-events.js";
import { listHumanActionsForIssue, listOpenHumanActions } from "../repository/human-actions.js";
import { listFindingsForIssue } from "../repository/findings.js";
import { checkIssueReadiness, startWorkflow } from "../coordinator/commands.js";
import { computeHumanWaitMs } from "../coordinator/metrics.js";

export async function registerIssueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/issues", async (req) => {
    const status = (req.query as { status?: string }).status;
    const issues = status ? listIssues(status.split(",") as IssueStatus[]) : listIssues();
    const openActionIssueIds = new Set(listOpenHumanActions().map((a) => a.issueId));
    return issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      currentOwner: issue.currentOwner,
      currentIntent: issue.currentIntent,
      updatedAt: issue.updatedAt,
      hasOpenHumanAction: openActionIssueIds.has(issue.id),
    }));
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const humanActions = listHumanActionsForIssue(id);
    const instances = listWorkflowInstancesForIssue(id);
    return {
      issue,
      timeline: listWorkflowEventsForIssue(id),
      humanActions,
      findings: listFindingsForIssue(id),
      usageSummary: summarizeIssueUsage(id),
      readiness: checkIssueReadiness(issue),
      humanWaitMs: computeHumanWaitMs(humanActions),
      interventionCount: humanActions.length,
      // Last element, not the active one: a completed/closed issue's duration is still
      // wall-clock start→completion of its (now-finished) workflow instance.
      latestWorkflowInstance: instances.length ? instances[instances.length - 1] : null,
    };
  });

  app.get("/api/issues/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { limit, before } = req.query as { limit?: string; before?: string };
    return {
      workerSessions: listWorkerSessionsForIssue(id),
      artifacts: listArtifactsForIssue(id, { limit: limit ? Number(limit) : undefined, before }),
      usageEvents: listUsageEventsForIssue(id),
    };
  });

  app.post("/api/issues", async (req, reply) => {
    const parsed = CreateIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const input = parsed.data;
    if (input.externalId) {
      const existing = findIssueByExternalId(input.source, input.externalId);
      if (existing) return existing;
    }
    const issue = createIssue(input);
    appendWorkflowEvent({ issueId: issue.id, type: "issue.created", actorType: "human", stage: issue.status });
    return issue;
  });

  app.patch("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const parsed = UpdateIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    // Editable only pre-start or parked back on needs_human — a running workflow owns
    // the frozen task snapshot (commands.ts's freezeTaskSnapshot), so an edit here must
    // never race or silently diverge from what a queued/running session already saw.
    if (getActiveWorkflowInstance(id)) {
      return reply.status(409).send({ error: "Cannot edit an issue with an active workflow" });
    }
    return updateIssue(id, parsed.data);
  });

  app.post("/api/issues/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = startWorkflow(id);
    if (result.ok === true) return { instance: result.instance, workItem: result.workItem };
    if (result.ok === "needs_scope_decision") return { needsScopeDecision: result.action };
    return reply.status(result.code).send({ error: result.error });
  });

  app.post("/api/issues/:id/guidance", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(id);
    if (!issue) return reply.status(404).send({ error: "Not found" });
    const { markdown } = req.body as { markdown: string };
    if (!markdown?.trim()) return reply.status(400).send({ error: "markdown is required" });
    const event = appendWorkflowEvent({ issueId: id, type: "guidance.added", actorType: "human", stage: issue.status, payload: { markdown } });
    return event;
  });
}

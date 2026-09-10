// packages/server/src/routes/issues.ts
import type { FastifyInstance } from "fastify";
import { CreateIssueInput, IssueStatus } from "@agent-dealer/shared";
import { createIssue, getIssue, listIssues, findIssueByExternalId } from "../repository/issues.js";
import { listWorkerSessionsForIssue } from "../repository/worker-sessions.js";
import { listArtifactsForIssue } from "../repository/artifacts-for-issue.js";
import { listUsageEventsForIssue, summarizeIssueUsage } from "../repository/usage-events.js";
import { listWorkflowEventsForIssue, appendWorkflowEvent } from "../repository/workflow-events.js";
import { listHumanActionsForIssue, listOpenHumanActions } from "../repository/human-actions.js";
import { listFindingsForIssue } from "../repository/findings.js";

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
    return {
      issue,
      timeline: listWorkflowEventsForIssue(id),
      humanActions: listHumanActionsForIssue(id),
      findings: listFindingsForIssue(id),
      usageSummary: summarizeIssueUsage(id),
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

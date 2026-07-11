import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import {
  CreateRunInput,
  AgentConfigInput,
  AgentDeckConfigPatch,
  CreateAgentInput,
  UpdateAgentInput,
  DraftPlanInput,
  KickRunInput,
  PlanAnswersInput,
  ResultQaInput,
  LinearIntakeConfigPatch,
  PromoteLinearInput,
  RetryRunInput,
  Runtime,
  UpdatePlanInput,
  BUILTIN_AGENT_CLAUDE_ID,
} from "@agent-dealer/shared";
import { parseRunBudget } from "@agent-dealer/shared";
import {
  addArtifact,
  createRun,
  findActiveByExternalId,
  getRun,
  listArtifacts,
  listEvents,
  listRuns,
  updateRunFields,
  transitionRun,
  getLatestArtifact,
  markPlanTriageConsumed,
  patchRunPhaseBudget,
  updateRunBudget,
} from "../repository/runs.js";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "../repository/agents.js";
import { listAgentsWithHealth } from "../adapters/agent-health.js";
import {
  forceDispatch,
  getSnapshotAsync,
  kickRun,
  schedulePlanDraft,
  scheduleRedraft,
  scheduleReflect,
  submitPlanAnswers,
  subscribe,
} from "../queue/dispatcher.js";
import { approveRunWithDeliver } from "../queue/approve-deliver.js";
import { recordPlanDelegation } from "../queue/plan-delegation.js";
import { askResultQuestion } from "../queue/result-qa.js";
import { rejectPendingOutboundDrafts } from "../repository/outbound-drafts.js";
import { fetchAgentDeckDecks } from "../adapters/agent-deck.js";
import { testAgentDeckConnection } from "../adapters/agent-deck.js";
import {
  getLinearIssue,
  listLinearCandidates,
  testLinearConnection,
} from "../adapters/linear-inbox.js";
import { syncLinearForRun } from "../adapters/linear-sync.js";
import { buildLineageUsageSummary } from "../usage-summary.js";
import { buildLineageTraceSummary } from "../trace-summary.js";
import {
  getLinearIntakeConfig,
  getLinearIntakeConfigView,
  patchLinearIntakeConfig,
  getAgentDeckConfig,
  patchAgentDeckConfig,
} from "../repository/intake-settings.js";
import { resolveAgentForIssue } from "../intake/agent-routing.js";
import { listRuntimeModels } from "../runners/models.js";

async function resolveDeckName(deckId?: string): Promise<string | null> {
  if (!deckId) return null;
  try {
    const decksRes = (await fetchAgentDeckDecks()) as {
      data?: Array<{ id: string; name: string }>;
    };
    return decksRes.data?.find((d) => d.id === deckId)?.name ?? null;
  } catch {
    return null;
  }
}

function assertAgentConfigured(run: NonNullable<ReturnType<typeof getRun>>): void {
  if (!run.runtime) {
    throw new Error("Select an agent runtime before plan mode or execution");
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { runtime: string }; Querystring: { refresh?: string } }>(
    "/api/runtimes/:runtime/models",
    async (req, reply) => {
      const parsed = Runtime.safeParse(req.params.runtime);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid runtime" });
      }
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const { models, source } = await listRuntimeModels(parsed.data, { refresh });
      return { runtime: parsed.data, models, source };
    }
  );

  app.get("/api/runs", async (req) => {
    const status = (req.query as { status?: string }).status;
    if (!status) return listRuns();
    const statuses = status.split(",") as Parameters<typeof listRuns>[0];
    return listRuns(statuses);
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    const artifacts = listArtifacts(id);
    return {
      run,
      artifacts,
      events: listEvents(id),
      usageSummary: buildLineageUsageSummary(run, { artifactsByRunId: { [id]: artifacts } }),
      traceSummary: buildLineageTraceSummary(run),
    };
  });

  /** Tail NDJSON log — transcript or stream_trace artifact. */
  app.get("/api/runs/:id/log-tail", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    const kind = (req.query as { kind?: string }).kind ?? "transcript";
    const artifacts = listArtifacts(id);
    const artifact =
      artifacts.find((a) => a.kind === kind && a.blobPath) ??
      artifacts.find((a) => a.kind === "transcript" && a.blobPath) ??
      artifacts.find((a) => a.kind === "stream_trace" && a.blobPath);
    if (!artifact?.blobPath) return reply.status(404).send({ error: "No log artifact" });
    if (!fs.existsSync(artifact.blobPath)) {
      return reply.status(404).send({ error: "Log file missing on disk" });
    }
    const max = Math.min(Number((req.query as { max?: string }).max ?? 50000), 200000);
    const raw = fs.readFileSync(artifact.blobPath, "utf8");
    return { content: raw.slice(-max), path: artifact.blobPath, kind: artifact.kind };
  });

  app.get("/api/intake/linear/status", async () => testLinearConnection());

  app.get("/api/intake/linear/config", async () => getLinearIntakeConfigView());

  app.patch("/api/intake/linear/config", async (req, reply) => {
    try {
      const patch = LinearIntakeConfigPatch.parse(req.body);
      return patchLinearIntakeConfig(patch);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  app.get("/api/intake/linear", async (_req, reply) => {
    try {
      const candidates = await listLinearCandidates();
      return { candidates };
    } catch (e) {
      return reply.status(502).send({ error: String(e), candidates: [] });
    }
  });

  app.post("/api/intake/linear/:issueId/resolve-agent", async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    let issue;
    try {
      issue = await getLinearIssue(issueId);
    } catch (e) {
      return reply.status(502).send({ error: String(e) });
    }
    if (!issue) return reply.status(404).send({ error: "Linear issue not found" });

    try {
      const settings = getLinearIntakeConfig();
      const resolved = await resolveAgentForIssue(issue, settings);
      return resolved;
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  app.post("/api/intake/linear/:issueId/promote", async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const input = PromoteLinearInput.parse(req.body);

    let issue;
    try {
      issue = await getLinearIssue(issueId);
    } catch (e) {
      return reply.status(502).send({ error: String(e) });
    }
    if (!issue) return reply.status(404).send({ error: "Linear issue not found" });

    const active = findActiveByExternalId("linear", issue.id);
    if (active) {
      return reply.status(409).send({
        error: "Active run already exists for this issue",
        runId: active.id,
      });
    }

    let agentId: string;
    try {
      const settings = getLinearIntakeConfig();
      const resolved = await resolveAgentForIssue(issue, settings, input.agentId);
      agentId = resolved.agentId;
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }

    if (!getAgent(agentId)) {
      return reply.status(400).send({ error: "Agent not found" });
    }

    let run;
    try {
      run = createRun(
        {
          title: `${issue.identifier}: ${issue.title}`,
          description: issue.description,
          taskCategory: "code",
          status: "plan_pending",
          agentId,
          planModel: input.planModel ?? undefined,
        },
        { source: "linear", externalId: issue.id, externalLabel: issue.identifier }
      );
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    addArtifact(
      run.id,
      "task_snapshot",
      {
        title: issue.title,
        description: issue.description,
        source: "linear",
        externalId: issue.identifier,
        url: issue.url,
        agent: {
          agentId: run.agentId,
          agentName: run.agentName,
          runtime: run.runtime,
          deckId: run.deckId,
          deckName: run.deckName,
          playbookId: run.playbookId,
        },
      },
      "system"
    );
    schedulePlanDraft(run);
    return reply.status(201).send(run);
  });

  app.post("/api/runs", async (req, reply) => {
    const input = CreateRunInput.parse(req.body);
    if (!getAgent(input.agentId)) {
      return reply.status(400).send({ error: "Agent not found" });
    }
    let run;
    try {
      run = createRun(input);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    addArtifact(
      run.id,
      "task_snapshot",
      {
        title: run.title,
        description: run.description,
        source: run.source,
        externalId: run.externalId,
        agent: {
          agentId: run.agentId,
          agentName: run.agentName,
          runtime: run.runtime,
          deckId: run.deckId,
          deckName: run.deckName,
          playbookId: run.playbookId,
        },
      },
      "system"
    );
    if (input.acceptanceCriteria) {
      addArtifact(run.id, "acceptance_criteria", { markdown: input.acceptanceCriteria }, "human");
    }
    schedulePlanDraft(run);
    return reply.status(201).send(run);
  });

  app.patch("/api/runs/:id/agent", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    if (!["plan_pending", "queued"].includes(run.status)) {
      return reply.status(400).send({ error: "Agent config locked after plan approval" });
    }
    const input = AgentConfigInput.parse(req.body);
    const deckName = await resolveDeckName(input.deckId);
    const updated = updateRunFields(id, {
      runtime: input.runtime,
      deck_id: input.deckId ?? null,
      deck_name: deckName,
      playbook_id: input.playbookId ?? null,
      plan_model: input.planModel !== undefined ? input.planModel : undefined,
      execute_model: input.executeModel !== undefined ? input.executeModel : undefined,
    });
    if (input.budget !== undefined) {
      return updateRunBudget(id, input.budget);
    }
    return updated;
  });

  app.post("/api/runs/:id/draft-plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    if (!["plan_pending", "queued"].includes(run.status)) {
      return reply.status(400).send({ error: "Re-draft only in plan_pending" });
    }
    const input = DraftPlanInput.parse(req.body ?? {});
    if (input.planModel !== undefined) {
      updateRunFields(id, { plan_model: input.planModel });
    }
    if (input.planBudget !== undefined) {
      patchRunPhaseBudget(id, "plan", input.planBudget);
    }
    try {
      assertAgentConfigured(getRun(id)!);
      const scheduled = scheduleRedraft(getRun(id)!, {
        feedback: input.feedback,
        editedMarkdown: input.editedMarkdown,
      });
      if (!scheduled) {
        return reply.status(409).send({ error: "Plan draft already in progress" });
      }
      return reply.status(202).send(getRun(id)!);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  app.patch("/api/runs/:id/plan", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    const input = UpdatePlanInput.parse(req.body);

    if (input.approve) {
      const hasPlan =
        listArtifacts(id).some((a) => a.kind === "draft_plan") ||
        input.planMarkdown.trim().length > 0;
      if (!hasPlan) {
        return reply.status(400).send({ error: "Plan not ready — wait for the agent to finish planning" });
      }
      assertAgentConfigured(run);
      const patch: {
        plan_model?: string | null;
        execute_model?: string | null;
      } = {};
      if (input.planModel !== undefined) {
        patch.plan_model = input.planModel;
      }
      // null/empty = "Default" — do not wipe a seeded execute_model; only set explicit picks
      if (input.executeModel?.trim()) {
        patch.execute_model = input.executeModel.trim();
      } else if (input.planModel?.trim()) {
        patch.execute_model = input.planModel.trim();
      }
      if (Object.keys(patch).length > 0) {
        updateRunFields(id, patch);
      }
      if (input.planBudget !== undefined) {
        patchRunPhaseBudget(id, "plan", input.planBudget);
      }
      if (input.executeBudget !== undefined) {
        patchRunPhaseBudget(id, "execute", input.executeBudget);
      }
      recordPlanDelegation(id);
      markPlanTriageConsumed(id);
      try {
        transitionRun(id, "plan_approved");
      } catch (e) {
        return reply.status(409).send({ error: String(e) });
      }
      addArtifact(id, "approved_plan", { markdown: input.planMarkdown }, "human");
      const updated = getRun(id)!;
      syncLinearForRun(updated, "plan_approved").catch((e) =>
        console.error("[linear-sync] plan_approved:", e)
      );
      await forceDispatch();
      return updated;
    }

    addArtifact(id, "draft_plan", { markdown: input.planMarkdown }, "human");
    markPlanTriageConsumed(id);
    if (run.status === "queued") {
      return transitionRun(id, "plan_pending");
    }
    return getRun(id);
  });

  app.post("/api/runs/:id/plan/answers", async (req, reply) => {
    const { id } = req.params as { id: string };
    let input;
    try {
      input = PlanAnswersInput.parse(req.body);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    const result = submitPlanAnswers(id, input);
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return { run: result.run, outcome: result.outcome };
  });

  app.post("/api/runs/:id/qa", async (req, reply) => {
    const { id } = req.params as { id: string };
    let input;
    try {
      input = ResultQaInput.parse(req.body);
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
    const result = askResultQuestion(id, input.question);
    if (!result.ok) return reply.status(result.code).send({ error: result.error });
    return reply.status(202).send({ exchange: result.exchange });
  });

  app.post("/api/runs/:id/kick", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    const input = KickRunInput.parse(req.body ?? {});

    const runtime = input.runtime ?? run.runtime;
    if (!runtime) {
      return reply.status(400).send({ error: "Select an agent runtime before execution" });
    }

    const deckId = input.deckId ?? run.deckId ?? undefined;
    const playbookId = input.playbookId ?? run.playbookId ?? undefined;
    const deckName = deckId ? await resolveDeckName(deckId) : run.deckName;

    const patch: {
      deck_id: string | null;
      deck_name: string | null;
      playbook_id: string | null;
      runtime: string;
      execute_model?: string | null;
    } = {
      deck_id: deckId ?? null,
      deck_name: deckName ?? null,
      playbook_id: playbookId ?? null,
      runtime,
    };
    if (input.executeModel?.trim()) {
      patch.execute_model = input.executeModel.trim();
    }

    if (run.status === "plan_pending") {
      return reply.status(400).send({ error: "Approve the plan before starting execution" });
    }
    if (run.status !== "plan_approved") {
      return reply.status(400).send({ error: `Cannot kick from status ${run.status}` });
    }

    updateRunFields(id, patch);
    if (input.executeBudget !== undefined) {
      patchRunPhaseBudget(id, "execute", input.executeBudget);
    }
    const updated = getRun(id)!;
    await kickRun(updated);
    await forceDispatch();
    return getRun(id);
  });

  app.post("/api/runs/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await approveRunWithDeliver(id);
    if (!result.ok) {
      return reply.status(result.code).send({ error: result.error });
    }
    return result.run;
  });

  app.post("/api/runs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    if (run.status !== "review" && run.status !== "failed") {
      return reply.status(400).send({ error: "Retry only from review or failed" });
    }

    const approvedPlan = getLatestArtifact(id, "approved_plan");
    if (!approvedPlan?.contentJson) {
      return reply.status(400).send({ error: "No approved plan — cannot retry execution" });
    }

    const input = RetryRunInput.parse(req.body);
    addArtifact(id, "feedback", { markdown: input.feedback }, "human");
    rejectPendingOutboundDrafts(id);

    const retry = createRun(
      {
        title: run.title,
        description: run.description ?? undefined,
        taskCategory: run.taskCategory,
        repo: run.repo ?? undefined,
        artifactWorkspace: run.artifactWorkspace ?? undefined,
        acceptanceCriteria: run.acceptanceCriteria ?? undefined,
        status: "plan_approved",
        agentId: run.agentId ?? BUILTIN_AGENT_CLAUDE_ID,
        planModel: run.planModel ?? undefined,
        budget: parseRunBudget(run.budgetJson),
      },
      { source: run.source, externalId: run.externalId ?? undefined, externalLabel: run.externalLabel ?? undefined, lineageId: run.lineageId ?? run.id }
    );
    updateRunFields(retry.id, {
      deck_id: run.deckId,
      deck_name: run.deckName,
      playbook_id: run.playbookId,
      runtime: run.runtime,
      execute_model: input.executeModel ?? input.planModel ?? run.executeModel,
    });
    if (input.executeBudget !== undefined) {
      patchRunPhaseBudget(retry.id, "execute", input.executeBudget);
    }

    try {
      addArtifact(retry.id, "approved_plan", JSON.parse(approvedPlan.contentJson), approvedPlan.author);
    } catch {
      return reply.status(500).send({ error: "Failed to copy approved plan" });
    }

    const parentSnap = getLatestArtifact(id, "task_snapshot");
    if (parentSnap?.contentJson) {
      try {
        addArtifact(retry.id, "task_snapshot", JSON.parse(parentSnap.contentJson), "system");
      } catch {
        /* keep retry run usable without snapshot */
      }
    }
    addArtifact(retry.id, "feedback", { markdown: input.feedback }, "human");

    const parentDoc = getLatestArtifact(id, "document");
    if (parentDoc?.contentJson) {
      try {
        addArtifact(retry.id, "document", JSON.parse(parentDoc.contentJson), "system");
      } catch {
        /* deliverable will be seeded at execution if needed */
      }
    }

    const retryRun = getRun(retry.id)!;
    addArtifact(id, "feedback", { supersededBy: retry.id, note: "Retry — replaced by new run" }, "system");
    transitionRun(id, "cancelled");
    syncLinearForRun(retryRun, "retry").catch((e) => console.error("[linear-sync] retry:", e));
    scheduleReflect(run, { trigger: "retry", feedback: input.feedback });
    await forceDispatch();
    return reply.status(201).send(retryRun);
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getRun(id);
    if (!run) return reply.status(404).send({ error: "Not found" });
    return transitionRun(id, "cancelled");
  });

  app.get("/api/snapshot", async () => getSnapshotAsync());

  app.get("/api/agents", async () => {
    const agents = await listAgentsWithHealth(listAgents());
    return {
      agents,
      issueCount: agents.filter((a) => !a.healthy).length,
    };
  });

  app.post("/api/agents", async (req, reply) => {
    const input = CreateAgentInput.parse(req.body);
    const deckName = await resolveDeckName(input.deckId);
    const agent = createAgent(input, deckName);
    const [withHealth] = await listAgentsWithHealth([agent]);
    return reply.status(201).send(withHealth);
  });

  app.patch("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = UpdateAgentInput.parse(req.body);
    const deckName = input.deckId ? await resolveDeckName(input.deckId ?? undefined) : undefined;
    const agent = updateAgent(id, input, deckName);
    if (!agent) return reply.status(404).send({ error: "Not found" });
    const [withHealth] = await listAgentsWithHealth([agent]);
    return withHealth;
  });

  app.delete("/api/agents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deleteAgent(id);
    if (!ok) return reply.status(404).send({ error: "Agent not found" });
    return { ok: true };
  });

  app.get("/api/agent-deck/status", async () => testAgentDeckConnection());

  app.get("/api/agent-deck/config", async () => getAgentDeckConfig());

  app.patch("/api/agent-deck/config", async (req, reply) => {
    try {
      const patch = AgentDeckConfigPatch.parse(req.body);
      const config = patchAgentDeckConfig(patch);
      return config;
    } catch (e) {
      return reply.status(400).send({ error: String(e) });
    }
  });

  app.get("/api/agent-deck/decks", async (_req, reply) => {
    try {
      return await fetchAgentDeckDecks();
    } catch (e) {
      return reply.status(502).send({ error: String(e), data: [] });
    }
  });

  app.get("/api/agent-deck/decks/:deckId/playbooks", async (req, reply) => {
    const { deckId } = req.params as { deckId: string };
    const { getAgentDeckApiUrl } = await import("../adapters/agent-deck.js");
    const base = getAgentDeckApiUrl();
    try {
      const res = await fetch(`${base}/api/decks/${deckId}/playbooks`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Agent Deck API error: ${res.status}`);
      return res.json();
    } catch (e) {
      return reply.status(502).send({ error: String(e), data: [] });
    }
  });

  app.get("/api/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = async () => {
      const snap = await getSnapshotAsync();
      reply.raw.write(`data: ${JSON.stringify(snap)}\n\n`);
    };

    await send();
    const unsub = subscribe(() => {
      send().catch(console.error);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15000);

    req.raw.on("close", () => {
      unsub();
      clearInterval(heartbeat);
    });
  });
}

import type { FastifyInstance } from "fastify";
import { CreateAgentInput, UpdateAgentInput, Runtime } from "@agent-dealer/shared";
import {
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
} from "../repository/agents.js";
import { listAgentsWithHealth } from "../adapters/agent-health.js";
import { fetchDecks } from "../adapters/agent-deck.js";
import { testAgentDeckConnection } from "../adapters/agent-deck.js";
import {
  listLinearCandidates,
  lookupLinearIssue,
  parseLinearIssueRef,
} from "../adapters/linear-inbox.js";
import { listRuntimeModels } from "../runners/models.js";

async function resolveDeckName(deckId?: string): Promise<string | null> {
  if (!deckId) return null;
  const result = await fetchDecks();
  if (!result.ok) return null;
  return result.decks.find((d) => d.id === deckId)?.name ?? null;
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

  // Linear lookup for the Issues home "New issue" flow — the only intake surface left
  // after NOT-71 removed the Inbox page and its promote-to-run pipeline.
  app.get("/api/intake/linear", async (_req, reply) => {
    try {
      const candidates = await listLinearCandidates();
      return { candidates };
    } catch (e) {
      return reply.status(502).send({ error: String(e), candidates: [] });
    }
  });

  /** Free-form kick lookup: `?q=NOT-103` or a Linear issue URL. */
  app.get("/api/intake/linear/lookup", async (req, reply) => {
    const q = typeof (req.query as { q?: unknown }).q === "string" ? (req.query as { q: string }).q : "";
    if (!parseLinearIssueRef(q)) {
      return reply.status(400).send({ error: "Provide a Linear identifier (e.g. NOT-103) or issue URL" });
    }
    try {
      const candidate = await lookupLinearIssue(q);
      if (!candidate) return reply.status(404).send({ error: "Linear issue not found" });
      return { candidate };
    } catch (e) {
      return reply.status(502).send({ error: String(e) });
    }
  });

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

  app.get("/api/agent-deck/decks", async (_req, reply) => {
    const result = await fetchDecks();
    if (!result.ok) {
      const status = result.code === "DECK_UNAVAILABLE" ? 502 : 403;
      return reply.status(status).send({ error: result.message, code: result.code, data: [] });
    }
    return { data: result.decks };
  });

  app.get("/api/agent-deck/decks/:deckId/playbooks", async (req, reply) => {
    const { deckId } = req.params as { deckId: string };
    const { getAgentDeckApiUrl } = await import("../adapters/agent-deck.js");
    const base = getAgentDeckApiUrl();
    try {
      const res = await fetch(`${base}/api/launch/decks/${encodeURIComponent(deckId)}/playbooks`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Agent Deck API error: ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: Array<{ id: string; title: string }> | { playbooks?: Array<{ id: string; title: string }> };
        message?: string;
      };
      if (json.success === false) throw new Error(json.message ?? "Agent Deck playbooks request failed");
      const playbooks = Array.isArray(json.data) ? json.data : (json.data?.playbooks ?? []);
      return { data: playbooks };
    } catch (e) {
      return reply.status(502).send({ error: String(e), data: [] });
    }
  });
}

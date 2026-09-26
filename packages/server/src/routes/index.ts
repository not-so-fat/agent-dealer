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
import { getLinearUsageSnapshot } from "../adapters/linear-graphql.js";
import { listRuntimeModels } from "../runners/models.js";
import { configuredCapacityRuntimes, getRuntimeCapacitySnapshot } from "../capacity/service.js";
import { refreshClaudeCapacityIfStale } from "../capacity/claude-local-cache.js";
import { maybeRefreshMuseCapacityFromServe } from "../capacity/muse.js";
import { refreshCodexCapacityIfStale } from "../capacity/codex-app-server.js";
import {
  getCursorTeamBillingSnapshot,
  refreshCursorTeamBillingIfStale,
} from "../capacity/cursor-team.js";
import {
  getCursorIndividualBillingSnapshot,
  refreshCursorIndividualBillingIfStale,
  refreshCursorIndividualCapacityIfStale,
} from "../capacity/cursor-individual.js";

async function resolveDeckName(deckId?: string): Promise<string | null> {
  if (!deckId) return null;
  const result = await fetchDecks();
  if (!result.ok) return null;
  return result.decks.find((d) => d.id === deckId)?.name ?? null;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  // NOT-159: process-lifetime Linear GraphQL counters (API-key bucket diagnostics).
  app.get("/api/debug/linear-usage", async () => getLinearUsageSnapshot());

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

  // NOT-245: provider-neutral capacity read model — one entry per configured
  // runtime account with its windows, freshness, and explicit unavailable
  // reasons. Normalized snapshots only; evidence stays server-side.
  // NOT-247: the only production trigger for the Muse adapter — a throttled
  // (default 5 min), bounded, best-effort refresh when `muse_code` is
  // configured. The refresh runs in the background without blocking the
  // read: GET serves the last-known snapshot immediately so a slow or
  // hanging `muse serve` (bounded by the capacity timeout) can never stall
  // the Agents page. Failures persist as N/A and never fail the read.
  // NOT-246: on-demand Codex refresh — when the stored Codex snapshot is
  // stale the read triggers one bounded, non-billable App Server poll
  // (single-flight, never health rows, never throws); fresh snapshots and
  // runtimes without a configured Codex account serve stored data with no
  // subprocess.
  // NOT-268: Claude local-first ladder — one background refresh ingests
  // Claude Code's own free cache (plain file read, never a spawn) and then
  // considers the paid probe without blocking the read: a bounded Haiku
  // probe fires at most once per hour and only under the explicit
  // `AGENT_DEALER_CLAUDE_CAPACITY_REFRESH=paid-after-1h` opt-in when every
  // valid 5H/1W observation is older than 60 minutes. Disabled is a strict
  // no-op (no spawn, no spend). Failures never break the read below.
  app.get("/api/runtime-capacity", async () => {
    try {
      void refreshClaudeCapacityIfStale().catch(() => {
        // Best-effort: failures persist via the probe diagnostic log.
      });
    } catch {
      // Best-effort: serve the last-known snapshot below.
    }
    try {
      if (configuredCapacityRuntimes().includes("muse_code")) {
        void maybeRefreshMuseCapacityFromServe().catch(() => {
          // Best-effort: failures persist as N/A via the ingest path.
        });
      }
    } catch {
      // Best-effort: serve the last-known snapshot below.
    }
    try {
      await refreshCodexCapacityIfStale();
    } catch {
      // A refresh failure must never break the read — stored snapshots still
      // served below with their explicit N/A reasons.
    }
    try {
      // NOT-250: opted-in experimental Individual billing-cycle window for
      // `cursor_local`. Disabled is a strict no-op (no credential, no HTTP);
      // failures never break the read below.
      await refreshCursorIndividualCapacityIfStale();
    } catch {
      // Stored snapshots still serve below with their explicit N/A reasons.
    }
    return getRuntimeCapacitySnapshot();
  });

  // NOT-249: team-level Cursor billing from the official Admin API — separate
  // from per-runtime quota above and from `cursor_local` connection health.
  // Optional: without `CURSOR_ADMIN_API_KEY` this reads `configured: false`.
  // Normalized snapshots only; the key never leaves the server.
  // On-demand stale refresh mirrors the Codex path: a missing/stale stored
  // snapshot triggers one bounded Admin API poll (single-flight, never
  // health rows, never throws); fresh snapshots serve stored data with no
  // HTTP, and `AGENT_DEALER_CURSOR_TEAM_CAPACITY_REFRESH=off` disables it.
  app.get("/api/cursor-team-billing", async () => {
    try {
      await refreshCursorTeamBillingIfStale();
    } catch {
      // A refresh failure must never break the read — the stored snapshot
      // still serves below with its explicit N/A reason.
    }
    return getCursorTeamBillingSnapshot();
  });

  // NOT-250: monthly/billing-cycle capacity for Cursor Individual accounts
  // via the opt-in EXPERIMENTAL dashboard adapter (undocumented endpoints,
  // local-login credential — no supported contract, no support guarantee).
  // Disabled by default: without `AGENT_DEALER_CURSOR_INDIVIDUAL_CAPACITY=
  // experimental` this reads `enabled: false` with no credential or endpoint
  // access. Normalized snapshots only; the credential never leaves the
  // server. On-demand stale refresh mirrors the Team path: a missing/stale
  // stored snapshot triggers one bounded dashboard poll (single-flight,
  // never health rows, never throws); fresh snapshots serve stored data with
  // no HTTP, and `AGENT_DEALER_CURSOR_INDIVIDUAL_REFRESH=off` disables it.
  // The browser must surface the `experimental_api` source with the local
  // setting that disables it (see CursorIndividualBillingCard).
  app.get("/api/cursor-individual-billing", async () => {
    try {
      await refreshCursorIndividualBillingIfStale();
    } catch {
      // A refresh failure must never break the read — the stored snapshot
      // still serves below with its explicit N/A reason.
    }
    return getCursorIndividualBillingSnapshot();
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

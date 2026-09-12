import type { FastifyInstance } from "fastify";
import { getHumanAction, listOpenHumanActions } from "../repository/human-actions.js";
import { resolveHumanActionAndAdvance } from "../coordinator/commands.js";
import { triggerIssueReflect } from "../coordinator/reflect-trigger.js";

export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());

  app.post("/api/human-actions/:id/resolve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { resolvedBy?: string; choice?: string };
    if (!body?.resolvedBy?.trim() || !body?.choice?.trim()) {
      return reply.status(400).send({ error: "resolvedBy and choice are required" });
    }

    // Read before resolving — the issue id this action belongs to, needed for the reflect
    // trigger below and stable regardless of how resolution turns out.
    const action = getHumanAction(id);
    if (!action) return reply.status(404).send({ error: "Human action not found" });

    const result = resolveHumanActionAndAdvance(id, body.resolvedBy, body.choice);
    if (!result.ok) return reply.status(result.code).send({ error: result.error });

    // Reflect is a best-effort network call to Agent Deck — it cannot run inside
    // resolveHumanActionAndAdvance's synchronous DB transaction, so it happens after the
    // resolution has already committed. Its own outcome never changes this response; it
    // only ever adds artifacts a caller can inspect via GET /api/issues/:id/evidence.
    if (result.triggerReflect) {
      await triggerIssueReflect(action.issueId).catch(() => "failed" as const);
    }

    return {
      issueStatus: result.issueStatus,
      nextWorkItemId: result.nextWorkItemId,
      instanceCompleted: result.instanceCompleted,
      restarted: result.restarted,
    };
  });
}

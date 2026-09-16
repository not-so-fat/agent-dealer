// packages/server/src/routes/queue.ts
//
// NOT-103: operator enqueue / dequeue / list for the sequential admission queue.

import type { FastifyInstance } from "fastify";
import { EnqueueIssueInput } from "@agent-dealer/shared";
import {
  dequeueIssue,
  enqueueIssue,
  getQueuedEntryForIssue,
} from "../repository/queue-entries.js";
import { listQueuedEntriesForRead } from "../coordinator/admission.js";

export async function registerQueueRoutes(app: FastifyInstance): Promise<void> {
  /** NOT-118: positions are 1-based ranks and a full system derives its own
   * "waiting for slot — running: X" reason at read time (never written per tick). */
  app.get("/api/queue", async () => {
    return listQueuedEntriesForRead();
  });

  app.post("/api/queue", async (req, reply) => {
    const parsed = EnqueueIssueInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { issueId } = parsed.data;
    try {
      return enqueueIssue(issueId);
    } catch (err) {
      const code = (err as { code?: number }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 404) return reply.status(404).send({ error: message });
      if (code === 409) return reply.status(409).send({ error: message });
      throw err;
    }
  });

  app.delete("/api/queue/:issueId", async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    if (!getQueuedEntryForIssue(issueId)) {
      return reply.status(404).send({ error: "Issue is not in the queue" });
    }
    const removed = dequeueIssue(issueId);
    if (!removed) return reply.status(404).send({ error: "Issue is not in the queue" });
    return removed;
  });
}

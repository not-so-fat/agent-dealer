// packages/server/src/routes/queue.ts
//
// NOT-103: operator enqueue / dequeue / list for the sequential admission queue.
// NOT-112: relative reorder (top / bottom / before / after).

import type { FastifyInstance } from "fastify";
import { AdmissionSettingsInput, EnqueueIssueInput, MoveQueueEntryInput } from "@agent-dealer/shared";
import {
  dequeueIssue,
  enqueueIssue,
  getQueuedEntryForIssue,
  moveQueueEntry,
} from "../repository/queue-entries.js";
import { setMaxActiveIssues } from "../repository/admission-settings.js";
import { getAdmissionStatus, listQueuedEntriesForRead } from "../coordinator/admission.js";

export async function registerQueueRoutes(app: FastifyInstance): Promise<void> {
  /** NOT-118: positions are 1-based ranks and a full system derives its own
   * "waiting for slot — running: X" reason at read time (never written per tick). */
  app.get("/api/queue", async () => {
    return listQueuedEntriesForRead();
  });

  /** NOT-215: truthful Admission read model — `N active · M waiting · limit X`. */
  app.get("/api/queue/status", async () => {
    return getAdmissionStatus();
  });

  /**
   * NOT-215: operator-chosen active-issue limit (1–2, never above the effective
   * worker/spawn ceiling). Persisted in the DB — survives page reload and server
   * restart. Raising fills free slots on the next tick; lowering only pauses new
   * admissions, never interrupts running work.
   */
  app.put("/api/queue/settings", async (req, reply) => {
    const parsed = AdmissionSettingsInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      setMaxActiveIssues(parsed.data.maxActiveIssues);
      return getAdmissionStatus();
    } catch (err) {
      const code = (err as { code?: number }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 400) return reply.status(400).send({ error: message });
      throw err;
    }
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

  app.post("/api/queue/:issueId/move", async (req, reply) => {
    const { issueId } = req.params as { issueId: string };
    const parsed = MoveQueueEntryInput.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      return moveQueueEntry(issueId, parsed.data.to);
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

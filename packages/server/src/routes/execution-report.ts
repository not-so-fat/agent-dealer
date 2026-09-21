// packages/server/src/routes/execution-report.ts
//
// NOT-175: GET /api/execution-report — the fleet-level execution-comparison
// report. (NOT-173 owns GET /api/execution-analysis; Fastify rejects duplicate
// routes.) Bounded filters; the conservative 30-day window is the default when
// `from`/`to` are omitted (see shared defaultExecutionReportWindow).
import type { FastifyInstance } from "fastify";
import { ExecutionReportQuery } from "@agent-dealer/shared";
import { buildExecutionReport } from "../coordinator/execution-report.js";

export async function registerExecutionReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/execution-report", async (req, reply) => {
    const parsed = ExecutionReportQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const q = parsed.data;
    const status = q.status
      ? q.status.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    try {
      return buildExecutionReport({
        from: q.from,
        to: q.to,
        repo: q.repo,
        role: q.role,
        runtime: q.runtime,
        model: q.model,
        status,
        page: q.page,
        limit: q.limit,
      });
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

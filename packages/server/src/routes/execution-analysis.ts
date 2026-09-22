// packages/server/src/routes/execution-analysis.ts
//
// NOT-173: fleet-level execution-analysis report. Issue-level analysis lives
// next to the issue routes (routes/issues.ts); both compose in the dedicated
// read-model layer (read-models/execution-analysis.ts), never in the route.
import type { FastifyInstance } from "fastify";
import { CohortFilters } from "@agent-dealer/shared";
import { getCohortExecutionAnalysis } from "../read-models/execution-analysis.js";

export async function registerExecutionAnalysisRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/execution-analysis", async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const parsed = CohortFilters.safeParse({
      from: typeof query.from === "string" ? query.from : null,
      to: typeof query.to === "string" ? query.to : null,
      role: typeof query.role === "string" ? query.role : null,
      runtime: typeof query.runtime === "string" ? query.runtime : null,
      model: typeof query.model === "string" ? query.model : null,
      status: typeof query.status === "string" ? query.status : null,
      repo: typeof query.repo === "string" ? query.repo : null,
      limit: query.limit !== undefined ? Number(query.limit) : 50,
      offset: query.offset !== undefined ? Number(query.offset) : 0,
    });
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    // Invalid date bounds are 400s, not silent defaults.
    if (parsed.data.from !== null && !Number.isFinite(Date.parse(parsed.data.from))) {
      return reply.status(400).send({ error: "Invalid `from` date (expected ISO-8601 UTC)" });
    }
    if (parsed.data.to !== null && !Number.isFinite(Date.parse(parsed.data.to))) {
      return reply.status(400).send({ error: "Invalid `to` date (expected ISO-8601 UTC)" });
    }
    if (
      parsed.data.from !== null &&
      parsed.data.to !== null &&
      Date.parse(parsed.data.to) < Date.parse(parsed.data.from)
    ) {
      return reply.status(400).send({ error: "`to` must not precede `from`" });
    }
    return getCohortExecutionAnalysis(parsed.data);
  });
}

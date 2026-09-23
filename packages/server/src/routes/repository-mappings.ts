import type { FastifyInstance } from "fastify";
import {
  listRepositoryMappings,
  replaceRepositoryMappings,
} from "../repository/repository-mappings.js";

/** NOT-260: label → repository mapping settings (inline editor in New issue). */
export async function registerRepositoryMappingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/repository-mappings", async () => ({
    mappings: listRepositoryMappings(),
  }));

  app.put("/api/settings/repository-mappings", async (req, reply) => {
    const body = (req.body ?? {}) as { mappings?: unknown };
    if (!body || !Array.isArray(body.mappings)) {
      return reply.status(400).send({ error: "Body must be { mappings: [...] }" });
    }
    try {
      const mappings = replaceRepositoryMappings({
        mappings: body.mappings as Array<{ label: string; repository: string }>,
      });
      return { mappings };
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

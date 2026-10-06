import type { FastifyInstance } from "fastify";
import { LinearIntakeConfigPatch } from "@agent-dealer/shared";
import {
  fetchLinearIntakeMetadata,
} from "../adapters/linear-inbox.js";
import { LinearApiKeyMissingError } from "../adapters/linear-graphql.js";
import {
  getLinearIntakeConfigView,
  patchLinearIntakeConfig,
} from "../repository/intake-settings.js";

/**
 * NOT-361: Linear picker config + metadata for the inline New issue filter editor.
 * Local dealer API (same trust model as repository-mappings); Linear auth is the API key.
 */
export async function registerIntakeLinearConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/intake/linear/config", async () => getLinearIntakeConfigView());

  app.patch("/api/intake/linear/config", async (req, reply) => {
    try {
      const patch = LinearIntakeConfigPatch.parse(req.body ?? {});
      return patchLinearIntakeConfig(patch);
    } catch (e) {
      return reply.status(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/api/intake/linear/metadata", async (_req, reply) => {
    try {
      return await fetchLinearIntakeMetadata();
    } catch (e) {
      if (e instanceof LinearApiKeyMissingError) {
        return reply.status(503).send({ error: e.message });
      }
      return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

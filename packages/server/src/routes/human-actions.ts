import type { FastifyInstance } from "fastify";
import { listOpenHumanActions } from "../repository/human-actions.js";

/**
 * NOT-58 foundation: the global human-action queue is read-only here. Typed
 * resolution and workflow continuation land in NOT-64.
 */
export async function registerHumanActionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/human-actions", async () => listOpenHumanActions());
}

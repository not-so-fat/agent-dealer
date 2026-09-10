import {
  formatEnvStartupLine,
  loadAgentDealerEnv,
} from "./config/load-env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { enrichPathForCliTools } from "./cli-env.js";
import { migrate } from "./db/index.js";
import { registerRoutes } from "./routes/index.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerHumanActionRoutes } from "./routes/human-actions.js";
import { startQueue, recoverOrphanedRuns } from "./queue/dispatcher.js";
import { pollAndDispatch, reconcileStaleSessions } from "./coordinator/dispatcher.js";
import { registerStaticUi } from "./static-ui.js";

/** How often to check for queued issue coordinator sessions to advance. */
const COORDINATOR_POLL_MS = Number(process.env.COORDINATOR_POLL_INTERVAL_MS ?? 5000);
/** How often to sweep for worker_sessions whose heartbeat has gone stale (crashed process). */
const COORDINATOR_RECONCILE_MS = Number(process.env.COORDINATOR_RECONCILE_INTERVAL_MS ?? 60_000);
/** A "running" session with no heartbeat for this long is presumed dead. */
const COORDINATOR_STALE_THRESHOLD_MS = Number(process.env.COORDINATOR_STALE_THRESHOLD_MS ?? 30 * 60_000);

function startCoordinator(): void {
  const reconciled = reconcileStaleSessions(COORDINATOR_STALE_THRESHOLD_MS);
  if (reconciled.reconciled.length > 0) {
    console.warn(`[coordinator] reconciled ${reconciled.reconciled.length} stale worker_session(s) on startup`);
  }

  setInterval(() => {
    pollAndDispatch().catch((err) => console.error("[coordinator] pollAndDispatch failed:", err));
  }, COORDINATOR_POLL_MS);

  setInterval(() => {
    const result = reconcileStaleSessions(COORDINATOR_STALE_THRESHOLD_MS);
    if (result.reconciled.length > 0) {
      console.warn(`[coordinator] reconciled ${result.reconciled.length} stale worker_session(s)`);
    }
  }, COORDINATOR_RECONCILE_MS);
}

const { mode, envFile } = loadAgentDealerEnv();
console.log(formatEnvStartupLine(mode, envFile));

const port = Number(process.env.PORT ?? 2221);

async function main(): Promise<void> {
  enrichPathForCliTools();
  migrate();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  await registerIssueRoutes(app);
  await registerHumanActionRoutes(app);

  const uiDist = await registerStaticUi(app);
  const orphans = recoverOrphanedRuns();
  if (orphans > 0) {
    console.warn(`[startup] recovered ${orphans} orphaned running run(s) → failed`);
  }
  startQueue();
  startCoordinator();

  await app.listen({ port, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${port}`;
  console.log(`agent-dealer API ${base}`);
  if (uiDist) {
    console.log(`agent-dealer dashboard ${base}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
import { recoverCoordinator } from "./coordinator/recovery.js";
import { startCoordinatorLoop } from "./coordinator/worker-loop.js";
import { registerEffectHandler } from "./coordinator/effect-registry.js";
import { runDeveloperEffect } from "./coordinator/developer-effect.js";
import { runReviewerEffect } from "./coordinator/reviewer-effect.js";
import { registerStaticUi } from "./static-ui.js";

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

  // Without this, getEffectHandler() falls back to the always-session_failed placeholders
  // (effect-registry.ts) and every started issue would burn its infra retries and
  // escalate without ever launching an agent, creating a worktree, or opening a PR.
  registerEffectHandler("developer", (ctx) => runDeveloperEffect(ctx));
  registerEffectHandler("reviewer", (ctx) => runReviewerEffect(ctx));

  const coordinatorRecovery = recoverCoordinator();
  if (coordinatorRecovery.reclaimed.length || coordinatorRecovery.deadLettered.length) {
    console.warn(
      `[startup] coordinator recovery: reclaimed ${coordinatorRecovery.reclaimed.length}, dead-lettered ${coordinatorRecovery.deadLettered.length}`
    );
  }
  startCoordinatorLoop();

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

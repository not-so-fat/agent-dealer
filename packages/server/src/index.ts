import {
  formatEnvStartupLine,
  loadAgentDealerEnv,
} from "./config/load-env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { enrichPathForCliTools } from "./cli-env.js";
import { migrate } from "./db/index.js";
import { writeServerPidFile, removeServerPidFile } from "./server-liveness.js";
import { registerRoutes } from "./routes/index.js";
import { registerIssueRoutes } from "./routes/issues.js";
import { registerHumanActionRoutes } from "./routes/human-actions.js";
import { startQueue, recoverOrphanedRuns } from "./queue/dispatcher.js";
import { recoverCoordinator } from "./coordinator/recovery.js";
import { reconcileAuthoritiesAtStartup } from "./adapters/authority-lifecycle.js";
import { startCoordinatorLoop } from "./coordinator/worker-loop.js";
import { registerEffectHandler } from "./coordinator/effect-registry.js";
import { runDeveloperEffect } from "./coordinator/developer-effect.js";
import { runReviewerEffect } from "./coordinator/reviewer-effect.js";
import { registerStaticUi } from "./static-ui.js";
import { cleanupOrphanedWorkerMcpConfig } from "./paths.js";

const { mode, envFile } = loadAgentDealerEnv();
console.log(formatEnvStartupLine(mode, envFile));

const port = Number(process.env.PORT ?? 2221);

async function main(): Promise<void> {
  enrichPathForCliTools();

  // Written before migrate() touches the database, and independent of how this process
  // was launched — see server-liveness.ts for why this exists alongside the CLI's own
  // run.json. Cleaned up on a normal shutdown; a stale file from a crash is harmless since
  // every reader checks the pid is actually alive, not just that the file exists.
  //
  // A false return means a different, still-alive process already owns this
  // AGENT_DEALER_HOME — this must be fatal, not merely logged: a server that continued
  // unmonitored (e.g. on a different port than the owner, so app.listen() below would
  // have succeeded) would run invisibly to isServiceRunning()/the migration guard, and to
  // the owner's own eventual shutdown, which only ever removes a marker it still owns —
  // so a second, unclaimed server surviving past the first one's clean exit would leave
  // nothing recording that it is still running against this same database.
  if (!writeServerPidFile(port)) {
    console.error(
      "[startup] another live process already owns this AGENT_DEALER_HOME's liveness marker — refusing to start. " +
        "Stop it first, or point AGENT_DEALER_HOME at a different directory."
    );
    process.exit(1);
  }
  process.on("SIGINT", () => {
    removeServerPidFile();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    removeServerPidFile();
    process.exit(0);
  });
  process.on("exit", removeServerPidFile);

  migrate();
  cleanupOrphanedWorkerMcpConfig();

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
  // NOT-91: revoke every execution-authority ledger row a crashed coordinator left open —
  // a fresh process boundary means nothing still `acquiring`/`active` from before this
  // boot can be legitimately in flight (see reconcileAuthoritiesAtStartup's doc comment).
  const authorityRecovery = await reconcileAuthoritiesAtStartup();
  if (authorityRecovery.revoked.length) {
    console.warn(`[startup] revoked ${authorityRecovery.revoked.length} orphaned execution authority attempt(s)`);
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

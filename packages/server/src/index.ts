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
import { reconcileAuthoritiesAtStartup, retryStaleAuthorityAttempts } from "./adapters/authority-lifecycle.js";
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
  if (authorityRecovery.unresolved.length) {
    console.warn(
      `[startup] ${authorityRecovery.unresolved.length} execution authority attempt(s) left unresolved ` +
        `(Deck unreachable or another ambiguous mint response) — durably flagged for the periodic reconciliation sweep`
    );
  }
  // NOT-91 review round 3/4/5: a row left unresolved above (or one that only becomes stale
  // later, e.g. via a cancellation while Deck happens to be unreachable) has no other path to
  // eventually close once Deck becomes reachable again — a leftover `acquiring` row would
  // otherwise wait for another full process restart. Retried on a bounded interval,
  // independent of the coordinator's own (much tighter) work-item poll loop, since this makes
  // a network call to Deck per stale row. Queries the durable `stale_at` marker fresh every
  // tick (retryStaleAuthorityAttempts) rather than tracking any in-memory list across ticks —
  // every one of the four paths that can flag a row stale (startup sweep, cancellation,
  // worker-death reclaim, revoke-before-new-attempt) becomes visible here automatically,
  // whenever it happened, and this never re-derives staleness from a fresh scan of every open
  // row the way the startup-only sweep does.
  const authorityReconcileIntervalMs = Number(process.env.AUTHORITY_RECONCILE_INTERVAL_MS ?? 300_000);
  setInterval(() => {
    retryStaleAuthorityAttempts()
      .then((result) => {
        if (result.unresolved.length) {
          console.warn(
            `[coordinator] authority reconciliation retry: ${result.unresolved.length} attempt(s) still unresolved`
          );
        }
      })
      .catch((err) => console.error("[coordinator] authority reconciliation retry", err));
  }, authorityReconcileIntervalMs);
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

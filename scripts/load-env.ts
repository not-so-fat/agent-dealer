/** Shared env bootstrap for .temporal/scripts — re-exports server loader. */
export {
  formatEnvStartupLine,
  getRepoRoot,
  loadAgentDealerEnv,
  resolveAgentDealerEnv,
  type AgentDealerEnv,
} from "../packages/server/src/config/load-env.ts";

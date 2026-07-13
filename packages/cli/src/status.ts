import { formatPortConflict, isTcpPortOpen, probeAgentDealer } from "./ports.js";
import { isProcessAlive, readRunState } from "./runtime-state.js";
import { getVersion } from "./version.js";
import { loadProdEnvFile, resolveBundledListenPort } from "./env.js";

export async function runStatus(): Promise<number> {
  loadProdEnvFile();
  const host = "127.0.0.1";
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();

  const probe = await probeAgentDealer(host, port);

  console.log(`CLI package ${getVersion()}`);
  console.log(`Configured host ${host}  port :${port}`);
  console.log("");

  if (probe.up) {
    console.log("Status: running");
    console.log(`  Dashboard  ${probe.url}`);
    console.log(`  API health ${probe.url}/health`);
  } else {
    console.log("Status: not running");
  }

  if (state) {
    console.log("");
    console.log("Last run.json:");
    console.log(`  started ${state.startedAt}`);
    console.log(
      `  pids server=${state.serverPid}${isProcessAlive(state.serverPid) ? "" : " (dead)"}  ` +
        `cli=${state.cliPid}${isProcessAlive(state.cliPid) ? "" : " (dead)"}`,
    );
  }

  const portBusy = await isTcpPortOpen(host, port);
  if (portBusy && !probe.up) {
    console.log("");
    console.warn(formatPortConflict(port, "dashboard/API", host, false));
  }

  return probe.up ? 0 : 1;
}

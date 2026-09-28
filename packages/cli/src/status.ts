import { fetchRunningBackendVersion, formatPortConflict, isTcpPortOpen, probeAgentDealer } from "./ports.js";
import { isProcessAlive, readRunState } from "./runtime-state.js";
import { getVersion } from "./version.js";
import { loadProdEnvFile, resolveBundledListenPort } from "./env.js";
import { readPendingManagedVersion } from "./managed/index.js";

const RESTART_ACTION = "restart after current execution finishes: agent-dealer start --force";

export async function runStatus(): Promise<number> {
  loadProdEnvFile();
  const host = "127.0.0.1";
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();

  const probe = await probeAgentDealer(host, port);
  const installed = getVersion();

  console.log(`Agent Dealer version ${installed}`);
  console.log(`Configured host ${host}  port :${port}`);
  console.log("");

  // NOT-279: the running version comes only from the backend itself. The installed CLI (and the
  // managed `current` link) can be ahead of a server that was started before an update.
  const running = probe.up ? await fetchRunningBackendVersion(host, port) : null;
  const pending = readPendingManagedVersion();

  if (probe.up) {
    console.log("Status: running");
    console.log(`  Dashboard  ${probe.url}`);
    console.log(`  API health ${probe.url}/health`);
    console.log(
      running
        ? `  Backend    running version ${running}`
        : "  Backend    running version unknown (backend did not report it — installed CLI version is not assumed)",
    );
  } else {
    console.log("Status: not running");
  }

  console.log(`  Installed  CLI version ${installed}`);
  if (pending) {
    console.log(`  Pending    managed version ${pending} (downloaded, not active)`);
  }

  if (probe.up) {
    if (running && running !== installed) {
      console.log("");
      console.log(`Version mismatch: backend is running ${running}, installed CLI is ${installed} — ${RESTART_ACTION}`);
    }
    if (pending) {
      console.log("");
      console.log(`Update pending: ${pending} activates only on restart — ${RESTART_ACTION}`);
    }
  } else if (pending) {
    console.log("");
    console.log(`Update pending: ${pending} activates on the next \`agent-dealer start\`.`);
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

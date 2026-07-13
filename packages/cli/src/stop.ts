import { listListeningPids, probeAgentDealer } from "./ports.js";
import { clearRunState, isProcessAlive, readRunState } from "./runtime-state.js";
import { loadProdEnvFile, resolveBundledListenPort } from "./env.js";

function terminatePid(pid: number, label: string): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[agent-dealer] Stopped ${label} (pid ${pid})`);
    return true;
  } catch (error) {
    console.warn(
      `[agent-dealer] Could not stop ${label} (pid ${pid}): ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}

async function waitForShutdown(host: string, port: number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const probe = await probeAgentDealer(host, port);
    if (!probe.up) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runStop(): Promise<number> {
  loadProdEnvFile();
  const host = "127.0.0.1";
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();
  let stopped = 0;

  if (state) {
    if (terminatePid(state.serverPid, "server")) {
      stopped += 1;
    }
    if (terminatePid(state.cliPid, "CLI supervisor")) {
      stopped += 1;
    }
    clearRunState();
  }

  let probe = await probeAgentDealer(host, port);
  if (probe.up) {
    for (const pid of listListeningPids(port)) {
      if (terminatePid(pid, `listener on :${port}`)) {
        stopped += 1;
      }
    }
    await waitForShutdown(host, port);
    probe = await probeAgentDealer(host, port);
  }

  if (probe.up) {
    console.warn("[agent-dealer] agent-dealer still responds on configured port. Kill remaining processes manually:");
    console.warn(`  lsof -ti :${port} -sTCP:LISTEN | xargs kill`);
    return 1;
  }

  if (stopped === 0) {
    console.log("[agent-dealer] No running agent-dealer instance found.");
  } else {
    console.log("[agent-dealer] agent-dealer stopped.");
  }

  return 0;
}

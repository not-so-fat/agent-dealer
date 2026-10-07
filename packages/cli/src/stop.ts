import { listListeningPids, probeAgentDealer, type AgentDealerProbe } from "./ports.js";
import { clearRunState, isProcessAlive, readRunState } from "./runtime-state.js";
import { loadProdEnvFile, resolveBundledListenPort } from "./env.js";

export interface StopDeps {
  /** Override for unit tests; production always uses the real health probe. */
  probe?: typeof probeAgentDealer;
}

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

// NOT-370: a probe that rejects (reset listener, torn-down socket) means "down", never a
// crash — stop already signaled the PIDs and must still report and exit.
async function safeProbe(
  host: string,
  port: number,
  probe: typeof probeAgentDealer,
): Promise<AgentDealerProbe> {
  try {
    return await probe(host, port);
  } catch {
    return { up: false, url: `http://${host}:${port}` };
  }
}

async function waitForShutdown(host: string, port: number, probe: typeof probeAgentDealer): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const result = await safeProbe(host, port, probe);
    if (!result.up) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runStop(deps: StopDeps = {}): Promise<number> {
  loadProdEnvFile();
  const host = "127.0.0.1";
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();
  const probeFn = deps.probe ?? probeAgentDealer;
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

  // An explicit AGENT_DEALER_HOME means "only this home" (smoke tests, side-by-side installs).
  // Its run.json is the sole proof of ownership, so never sweep the port: with no run state the
  // port falls back to the bundled 2222, which belongs to the default install.
  const isolatedHome = Boolean(process.env.AGENT_DEALER_HOME?.trim());

  let probe = await safeProbe(host, port, probeFn);
  if (probe.up) {
    if (!isolatedHome) {
      for (const pid of listListeningPids(port)) {
        if (terminatePid(pid, `listener on :${port}`)) {
          stopped += 1;
        }
      }
    }
    if (!isolatedHome || state) {
      await waitForShutdown(host, port, probeFn);
      probe = await safeProbe(host, port, probeFn);
    }
  }

  if (probe.up && (!isolatedHome || state)) {
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

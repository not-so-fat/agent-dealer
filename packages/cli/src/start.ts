import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  loadProdEnvFile,
  prodEnvFilePath,
  prodHomeDir,
  resolveBundledListenPort,
  shortenHome,
} from "./env.js";
import {
  appendDaemonLogLine,
  openDaemonLogFd,
  resolveCliEntry,
  resolveDaemonLogPath,
  resolveDaemonLogsDir,
} from "./daemon-logs.js";
import { formatPortConflict, isTcpPortOpen, probeAgentDealer } from "./ports.js";
import { resolveServerEntry, resolveUiDist } from "./paths.js";
import { clearRunState, writeRunState } from "./runtime-state.js";
import { runStop } from "./stop.js";

export interface StartOptions {
  port?: number;
  open?: boolean;
  force?: boolean;
  /** Detach a background supervisor (survives terminal close). */
  daemon?: boolean;
  /** Internal: detached supervisor child (set via --_supervisor or AGENT_DEALER_SUPERVISOR). */
  supervisor?: boolean;
}

type SpawnIoMode = "inherit" | "file";

const children: ChildProcess[] = [];
let shuttingDown = false;

function isSupervisorMode(options: StartOptions): boolean {
  return options.supervisor === true || process.env.AGENT_DEALER_SUPERVISOR === "1";
}

async function waitForHealth(url: string, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function resolveServiceStdio(ioMode: SpawnIoMode): StdioOptions {
  if (ioMode === "inherit") {
    return "inherit";
  }
  const fd = openDaemonLogFd("server");
  return ["ignore", fd, fd];
}

function spawnServer(env: Record<string, string>, ioMode: SpawnIoMode): ChildProcess {
  const entry = resolveServerEntry();
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: resolveServiceStdio(ioMode),
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    const message = `[agent-dealer] server exited (${detail})`;
    if (ioMode === "file") {
      appendDaemonLogLine("supervisor", `${new Date().toISOString()} ${message}`);
    } else {
      console.error(message);
    }
    void shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (isSupervisorMode({})) {
    appendDaemonLogLine(
      "supervisor",
      `${new Date().toISOString()} [agent-dealer] supervisor shutting down (exit ${exitCode})`,
    );
  }

  clearRunState();

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(exitCode);
}

function printRunningEndpoints(base: string, uiDist: string | undefined): void {
  console.log("");
  console.log("agent-dealer is running");
  console.log(`  Dashboard  ${uiDist ? base : "(UI bundle missing — API only)"}`);
  console.log(`  API health ${base}/health`);
  console.log("");
}

function buildSupervisorArgs(options: StartOptions): string[] {
  const args = ["start", "--_supervisor"];
  if (options.open) {
    args.push("--open");
  }
  if (options.force) {
    args.push("--force");
  }
  if (options.port !== undefined) {
    args.push("--port", String(options.port));
  }
  return args;
}

async function runDaemonLauncher(options: StartOptions): Promise<number> {
  const port = resolveBundledListenPort(options.port);
  const base = `http://127.0.0.1:${port}`;

  const supervisorLogFd = openDaemonLogFd("supervisor");
  const cliEntry = resolveCliEntry();

  const child = spawn(process.execPath, [cliEntry, ...buildSupervisorArgs(options)], {
    detached: true,
    stdio: ["ignore", supervisorLogFd, supervisorLogFd],
    env: { ...process.env, AGENT_DEALER_SUPERVISOR: "1" },
  });

  child.unref();

  const healthy = await waitForHealth(`${base}/health`);
  if (!healthy) {
    console.error("[agent-dealer] Daemon supervisor failed health check.");
    console.error(`[agent-dealer] See ${resolveDaemonLogPath("supervisor")}`);
    return 1;
  }

  console.log("");
  console.log("agent-dealer started in background");
  console.log(`  Dashboard  ${base}`);
  console.log(`  Logs       ${resolveDaemonLogsDir()}/`);
  console.log("  Stop       agent-dealer stop");
  console.log("");

  return 0;
}

async function ensurePortAvailable(host: string, port: number, probe: AgentDealerProbe): Promise<number | null> {
  const portBusy = await isTcpPortOpen(host, port);
  if (portBusy && !probe.up) {
    console.error(`[agent-dealer] ${formatPortConflict(port, "dashboard/API", host, false)}`);
    return 1;
  }
  return null;
}

type AgentDealerProbe = Awaited<ReturnType<typeof probeAgentDealer>>;

export async function runStart(options: StartOptions = {}): Promise<number> {
  const envFile = loadProdEnvFile();
  const home = prodHomeDir();
  const uiDist = resolveUiDist();
  const port = resolveBundledListenPort(options.port);
  const host = "127.0.0.1";
  const base = `http://${host}:${port}`;

  if (envFile) {
    console.log(`Config: ${shortenHome(envFile)}`);
  } else {
    console.warn(`No config at ${shortenHome(prodEnvFilePath())} — run: agent-dealer setup`);
  }

  const supervisor = isSupervisorMode(options);

  if (options.daemon && !supervisor) {
    const probe = await probeAgentDealer(host, port);
    if (probe.up) {
      if (options.force) {
        console.log("[agent-dealer] Restarting existing instance (--force) ...");
        await runStop();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } else {
        printRunningEndpoints(base, uiDist);
        console.log("Already running. Use `agent-dealer stop` or `agent-dealer start --daemon --force` to restart.");
        return 0;
      }
    }

    const refreshedProbe = options.force ? await probeAgentDealer(host, port) : probe;
    const portError = await ensurePortAvailable(host, port, refreshedProbe);
    if (portError !== null) {
      return portError;
    }

    return runDaemonLauncher(options);
  }

  const ioMode: SpawnIoMode = supervisor ? "file" : "inherit";

  const probe = await probeAgentDealer(host, port);
  if (probe.up) {
    if (options.force) {
      console.log("[agent-dealer] Restarting existing instance (--force) ...");
      await runStop();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } else {
      printRunningEndpoints(base, uiDist);
      console.log("Already running. Use `agent-dealer stop` or `agent-dealer start --force` to restart.");
      return 0;
    }
  }

  const refreshedProbe = options.force ? await probeAgentDealer(host, port) : probe;
  const portError = await ensurePortAvailable(host, port, refreshedProbe);
  if (portError !== null) {
    return portError;
  }

  if (!uiDist) {
    const warnUi = "[agent-dealer] Dashboard UI bundle not found. API will still start.";
    const warnDist = "[agent-dealer] Set AGENT_DEALER_UI_DIST or run from a published npm package build.";
    if (ioMode === "file") {
      appendDaemonLogLine("supervisor", warnUi);
      appendDaemonLogLine("supervisor", warnDist);
    } else {
      console.warn(warnUi);
      console.warn(warnDist);
    }
  }

  const serverEnv: Record<string, string> = {
    AGENT_DEALER_ENV: "production",
    AGENT_DEALER_HOME: home,
    PORT: String(port),
    WEB_PORT: String(port),
    AGENT_DEALER_WEB_URL: `http://localhost:${port}`,
    AGENT_DEALER_API: base,
  };

  if (uiDist) {
    serverEnv.AGENT_DEALER_UI_DIST = uiDist;
  }

  const logStart = (line: string) => {
    if (ioMode === "file") {
      appendDaemonLogLine("supervisor", `${new Date().toISOString()} ${line}`);
    } else {
      console.log(line);
    }
  };

  logStart("[agent-dealer] Starting server ...");
  const serverChild = spawnServer(serverEnv, ioMode);

  const healthy = await waitForHealth(`${base}/health`);
  if (!healthy) {
    const failMsg = "[agent-dealer] Server failed health check (port conflict or crash).";
    if (ioMode === "file") {
      appendDaemonLogLine("supervisor", failMsg);
    } else {
      console.error(failMsg);
      console.error("[agent-dealer] Run: agent-dealer status");
    }
    await shutdown(1);
    return 1;
  }

  writeRunState({
    host,
    port,
    serverPid: serverChild.pid ?? 0,
    cliPid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const runningLines = [
    "",
    "agent-dealer is running",
    `  Dashboard  ${uiDist ? base : "(UI bundle missing — API only)"}`,
    `  API health ${base}/health`,
    "",
  ];

  if (ioMode === "file") {
    for (const line of runningLines) {
      if (line) {
        appendDaemonLogLine("supervisor", line);
      }
    }
  } else {
    for (const line of runningLines) {
      console.log(line);
    }
  }

  if (options.open && uiDist) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [base], { stdio: "ignore", shell: process.platform === "win32" });
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  await new Promise<void>(() => {
    // keep alive until signal or server exit
  });
  return 0;
}

export function printStartHelp(): void {
  console.log(`Usage:
  agent-dealer start [--daemon] [--port PORT] [--open] [--force]

Runs the API and bundled dashboard (production mode).
  --daemon   Detached background supervisor (survives terminal close)
  --force    Restart if already running`);
}

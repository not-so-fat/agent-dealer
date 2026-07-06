import { spawn, type ChildProcess } from "node:child_process";
import {
  loadProdEnvFile,
  prodEnvFilePath,
  prodHomeDir,
  resolveBundledListenPort,
  shortenHome,
} from "./env.js";
import { resolveServerEntry, resolveUiDist } from "./paths.js";

export interface StartOptions {
  port?: number;
  open?: boolean;
}

let child: ChildProcess | null = null;

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

export async function runStart(options: StartOptions = {}): Promise<number> {
  const envFile = loadProdEnvFile();
  const home = prodHomeDir();
  const uiDist = resolveUiDist();
  const port = resolveBundledListenPort(options.port);
  const entry = resolveServerEntry();

  if (envFile) {
    console.log(`Config: ${shortenHome(envFile)}`);
  } else {
    console.warn(`No config at ${shortenHome(prodEnvFilePath())} — run: agent-dealer setup`);
  }

  const env: Record<string, string> = {
    ...process.env,
    AGENT_DEALER_ENV: "production",
    AGENT_DEALER_HOME: home,
    PORT: String(port),
    WEB_PORT: String(port),
    AGENT_DEALER_WEB_URL: `http://localhost:${port}`,
    AGENT_DEALER_API: `http://127.0.0.1:${port}`,
  };

  if (uiDist) {
    env.AGENT_DEALER_UI_DIST = uiDist;
  }

  child = spawn(process.execPath, [entry], {
    env,
    stdio: "inherit",
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (child && !child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const base = `http://127.0.0.1:${port}`;
  const healthy = await waitForHealth(`${base}/health`);
  if (!healthy) {
    console.error("agent-dealer failed to become healthy");
    child.kill("SIGTERM");
    return 1;
  }

  console.log(`agent-dealer running at ${base}`);
  if (options.open && uiDist) {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(openCmd, [base], { stdio: "ignore", shell: process.platform === "win32" });
  }

  return new Promise((resolve) => {
    child?.on("exit", (code) => resolve(code ?? 0));
  });
}

export function printStartHelp(): void {
  console.log(`Usage:
  agent-dealer start [--port PORT] [--open]

Runs the API and bundled dashboard (production mode).`);
}

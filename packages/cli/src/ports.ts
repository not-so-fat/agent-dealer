import { execSync } from "node:child_process";
import net from "node:net";

export interface AgentDealerProbe {
  up: boolean;
  url: string;
}

async function fetchJson(url: string, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function isTcpPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1500);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

export async function probeAgentDealer(host: string, port: number): Promise<AgentDealerProbe> {
  const url = `http://${host}:${port}`;
  const health = await fetchJson(`${url}/health`);
  return {
    up: health?.ok === true,
    url,
  };
}

export function listListeningPids(port: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  try {
    const output = execSync(`lsof -ti :${port} -sTCP:LISTEN`, { encoding: "utf8" }).trim();
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function formatPortConflict(port: number, label: string, host: string, isAgentDealer: boolean): string {
  const pids = listListeningPids(port);
  const pidHint =
    pids.length > 0
      ? ` Listening PID(s): ${pids.join(", ")}.`
      : process.platform === "win32"
        ? ""
        : ` Check: lsof -i :${port}`;

  if (isAgentDealer) {
    return `Port ${port} (${label}) is already used by a running agent-dealer instance on ${host}.${pidHint}`;
  }

  return (
    `Port ${port} (${label}) is in use by another program on ${host}.${pidHint}\n` +
    `  • Free the port, or start on a different port: agent-dealer start --port <port>`
  );
}

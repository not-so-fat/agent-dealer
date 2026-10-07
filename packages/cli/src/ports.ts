import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface AgentDealerProbe {
  up: boolean;
  url: string;
}

// NOT-370: local probes intentionally use node:http instead of the global fetch (undici).
// When a localhost peer has just been killed, undici's HTTP/1.1 write path can throw
// `setTypeOfService EINVAL` synchronously outside the fetch promise (notably on macOS),
// which no try/catch around fetch can observe and which crashes the CLI. node:http
// surfaces the same resets/refusals as ordinary request errors, which resolve to null.
async function fetchJson(url: string, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Record<string, unknown> | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      request?.destroy();
      done(null);
    }, timeoutMs);
    // A stuck probe must never keep a lifecycle command alive on its own.
    timer.unref?.();

    let request: http.ClientRequest | undefined;
    try {
      const transport = url.startsWith("https:") ? https : http;
      request = transport.get(url, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            done(parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
          } catch {
            done(null);
          }
        });
        response.on("error", () => done(null));
      });
    } catch {
      done(null);
      return;
    }
    request.on("error", () => done(null));
  });
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

/**
 * NOT-279: the version the live backend reports about itself, or null when it is down, the
 * request fails, or it predates `/api/version`. Callers must show "unknown" for null —
 * never substitute the installed CLI version, which may be ahead of the running server.
 */
export async function fetchRunningBackendVersion(host: string, port: number): Promise<string | null> {
  const body = await fetchJson(`http://${host}:${port}/api/version`);
  const version = body?.version;
  return typeof version === "string" && version.trim() ? version : null;
}

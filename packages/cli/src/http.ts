import { readRunState } from "./runtime-state.js";
import { loadProdEnvFile, resolveBundledListenPort } from "./env.js";

export function resolveApiBase(): string {
  loadProdEnvFile();
  const state = readRunState();
  const port = state?.port ?? resolveBundledListenPort();
  return `http://127.0.0.1:${port}`;
}

export async function apiFetch(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: opts?.method ?? "GET",
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

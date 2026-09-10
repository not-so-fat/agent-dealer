import { resolveApiBase } from "./issue.js";

async function apiFetch(path: string, opts?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: opts?.method ?? "GET",
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function runActionCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === "list") {
      const result = await apiFetch("/api/human-actions");
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (subcommand === "resolve") {
      const id = rest[0];
      const choiceIdx = rest.indexOf("--choice");
      const choice = choiceIdx >= 0 ? rest[choiceIdx + 1] : undefined;
      if (!id || !choice) {
        console.error("resolve requires an action id and --choice");
        return 1;
      }
      const result = await apiFetch(`/api/human-actions/${id}/resolve`, { method: "POST", body: { resolvedBy: "cli", choice } });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.error(`Unknown action subcommand: ${subcommand}`);
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

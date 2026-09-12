import { resolveApiBase } from "./issue.js";
import type { HumanAction } from "@agent-dealer/shared";

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

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/** Surfaces the allowed choices as structured data alongside the raw JSON string, so a
 * coding agent driving the CLI doesn't have to parse the double-encoded field itself. */
function withChoices(action: HumanAction): HumanAction & { choices: Array<{ choice: string; label: string }> } {
  let choices: Array<{ choice: string; label: string }> = [];
  if (action.responseOptionsJson) {
    try {
      choices = JSON.parse(action.responseOptionsJson);
    } catch {
      choices = [];
    }
  }
  return { ...action, choices };
}

export async function runActionCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  try {
    if (subcommand === "list") {
      const result = (await apiFetch("/api/human-actions")) as HumanAction[];
      console.log(JSON.stringify(result.map(withChoices), null, 2));
      return 0;
    }
    if (subcommand === "resolve") {
      const id = rest[0];
      const choice = flag(rest, "--choice");
      const resolvedBy = flag(rest, "--by");
      if (!id || !choice || !resolvedBy) {
        console.error("resolve requires an action id, --choice, and --by");
        return 1;
      }
      const result = await apiFetch(`/api/human-actions/${id}/resolve`, {
        method: "POST",
        body: { choice, resolvedBy },
      });
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

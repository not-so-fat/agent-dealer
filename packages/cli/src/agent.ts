import { resolveApiBase } from "./issue.js";

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${resolveApiBase()}${path}`);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export async function runAgentCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  try {
    if (subcommand === "list") {
      const result = await apiFetch("/api/agents");
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.error(`Unknown agent subcommand: ${subcommand}`);
    return 1;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

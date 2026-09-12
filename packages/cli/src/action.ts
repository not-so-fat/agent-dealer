import { apiFetch } from "./http.js";
import type { HumanAction } from "@agent-dealer/shared";

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/** Parses responseOptionsJson so `action list` surfaces the valid choices directly,
 * instead of forcing the caller to decode a JSON-encoded string within the JSON output. */
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

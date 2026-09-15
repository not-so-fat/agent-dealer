import { apiFetch } from "./http.js";

export type ParsedQueueArgs =
  | { subcommand: "add"; issueId: string }
  | { subcommand: "remove"; issueId: string }
  | { subcommand: "list" };

export function parseQueueArgs(args: string[]): ParsedQueueArgs {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "add": {
      const issueId = rest[0];
      if (!issueId) throw new Error("queue add requires an issue id");
      return { subcommand: "add", issueId };
    }
    case "remove": {
      const issueId = rest[0];
      if (!issueId) throw new Error("queue remove requires an issue id");
      return { subcommand: "remove", issueId };
    }
    case "list":
      return { subcommand: "list" };
    default:
      throw new Error(`Unknown queue subcommand: ${subcommand ?? "(none)"}`);
  }
}

export async function runQueueCommand(args: string[]): Promise<number> {
  let parsed: ParsedQueueArgs;
  try {
    parsed = parseQueueArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  try {
    switch (parsed.subcommand) {
      case "add": {
        const result = await apiFetch("/api/queue", {
          method: "POST",
          body: { issueId: parsed.issueId },
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "remove": {
        const result = await apiFetch(`/api/queue/${encodeURIComponent(parsed.issueId)}`, {
          method: "DELETE",
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "list": {
        const result = await apiFetch("/api/queue");
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

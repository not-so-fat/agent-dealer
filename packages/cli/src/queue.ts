import type { QueueMoveTarget } from "@agent-dealer/shared";
import { apiFetch } from "./http.js";

export type ParsedQueueArgs =
  | { subcommand: "add"; issueId: string }
  | { subcommand: "remove"; issueId: string }
  | { subcommand: "list" }
  | { subcommand: "move"; issueId: string; to: QueueMoveTarget };

function parseMoveFlags(flags: string[]): QueueMoveTarget {
  let to: QueueMoveTarget | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    let next: QueueMoveTarget;
    if (flag === "--top") {
      next = "top";
    } else if (flag === "--bottom") {
      next = "bottom";
    } else if (flag === "--before") {
      const id = flags[++i];
      if (!id) throw new Error("queue move --before requires an issue id");
      next = { before: id };
    } else if (flag === "--after") {
      const id = flags[++i];
      if (!id) throw new Error("queue move --after requires an issue id");
      next = { after: id };
    } else {
      throw new Error(`Unknown queue move flag: ${flag}`);
    }
    if (to !== undefined) {
      throw new Error("queue move accepts exactly one of --top|--bottom|--before|--after");
    }
    to = next;
  }
  if (to === undefined) {
    throw new Error("queue move requires --top|--bottom|--before <id>|--after <id>");
  }
  return to;
}

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
    case "move": {
      const issueId = rest[0];
      if (!issueId) throw new Error("queue move requires an issue id");
      return { subcommand: "move", issueId, to: parseMoveFlags(rest.slice(1)) };
    }
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
      case "move": {
        const result = await apiFetch(
          `/api/queue/${encodeURIComponent(parsed.issueId)}/move`,
          {
            method: "POST",
            body: { to: parsed.to },
          }
        );
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

import type { CreateIssueResult, StartIssueResponse } from "@agent-dealer/shared";
import { apiFetch } from "./http.js";

/**
 * NOT-141: the hint reports what the server *did*, never what was requested. Printing
 * "Queued for admission" off the request flag told operators a queue happened when a
 * re-import had matched an existing issue and queued nothing.
 */
function createOutcomeHint(result: CreateIssueResult): string {
  if (!result.created) {
    const matched = `Matched existing issue ${result.id} (${result.status}) — nothing new was created`;
    switch (result.queue) {
      // Enqueue is idempotent: an issue already waiting is not a queue action, so the hint
      // must not claim one. `queue list` is the honest next step.
      case "already_queued":
        return `${matched}, and it was already in the admission queue — nothing was queued. \`agent-dealer queue list\` shows its position and wait reason.`;
      case "enqueued":
        return `${matched}; it was put back in the admission queue.`;
      case "not_queued":
        return `${matched} and nothing was queued.`;
    }
  }
  const pass =
    result.priorPasses > 0
      ? ` This is pass ${result.priorPasses + 1} on ${result.externalLabel ?? result.externalId} — ${result.priorPasses} earlier pass(es) already finished.`
      : "";
  return result.queue === "enqueued"
    ? `Queued for admission — \`agent-dealer queue list\` shows position and wait reason.${pass}`
    : `Created as a draft (not queued) — \`agent-dealer queue add <id>\` when it is ready.${pass}`;
}

export type ParsedIssueArgs =
  | { subcommand: "create"; title: string; repo: string; developerAgentId: string; reviewerAgentId: string; description?: string; acceptanceCriteria?: string; baseBranch?: string; enqueue: boolean }
  | { subcommand: "import"; externalId: string; externalLabel?: string; title: string; repo: string; developerAgentId: string; reviewerAgentId: string }
  | { subcommand: "list"; status?: string }
  | { subcommand: "show"; id: string; includeEvidence: boolean }
  | { subcommand: "start"; id: string }
  | { subcommand: "guide"; id: string; message: string };

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function parseIssueArgs(args: string[]): ParsedIssueArgs {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "create":
    case "import": {
      const title = flag(rest, "--title");
      const repo = flag(rest, "--repo");
      const developerAgentId = flag(rest, "--developer-agent");
      const reviewerAgentId = flag(rest, "--reviewer-agent");
      if (!title || !repo || !developerAgentId || !reviewerAgentId) {
        throw new Error(`${subcommand} requires --title, --repo, --developer-agent, --reviewer-agent`);
      }
      if (subcommand === "import") {
        const externalId = flag(rest, "--external-id");
        if (!externalId) throw new Error("import requires --external-id");
        return { subcommand: "import", externalId, externalLabel: flag(rest, "--external-label"), title, repo, developerAgentId, reviewerAgentId };
      }
      // NOT-118: create enqueues for admission by default; --no-enqueue leaves a draft out.
      return { subcommand: "create", title, repo, developerAgentId, reviewerAgentId, description: flag(rest, "--description"), acceptanceCriteria: flag(rest, "--acceptance-criteria"), baseBranch: flag(rest, "--base-branch"), enqueue: !rest.includes("--no-enqueue") };
    }
    case "list": {
      return { subcommand: "list", status: flag(rest, "--status") };
    }
    case "show": {
      const id = rest[0];
      if (!id) throw new Error("show requires an issue id");
      return { subcommand: "show", id, includeEvidence: rest.includes("--include") && rest[rest.indexOf("--include") + 1] === "evidence" };
    }
    case "start": {
      const id = rest[0];
      if (!id) throw new Error("start requires an issue id");
      return { subcommand: "start", id };
    }
    case "guide": {
      const id = rest[0];
      const message = flag(rest, "--message");
      if (!id || !message) throw new Error("guide requires an issue id and --message");
      return { subcommand: "guide", id, message };
    }
    default:
      throw new Error(`Unknown issue subcommand: ${subcommand}`);
  }
}

export async function runIssueCommand(args: string[]): Promise<number> {
  let parsed: ParsedIssueArgs;
  try {
    parsed = parseIssueArgs(args);
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  try {
    switch (parsed.subcommand) {
      case "create": {
        const result = (await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, description: parsed.description, acceptanceCriteria: parsed.acceptanceCriteria, baseBranch: parsed.baseBranch, source: "agent", enqueue: parsed.enqueue } })) as CreateIssueResult;
        console.log(JSON.stringify(result, null, 2));
        // stdout stays pure JSON for agents that pipe it — the hint goes to stderr.
        console.error(createOutcomeHint(result));
        return 0;
      }
      case "import": {
        // A re-import of a ticket already in flight answers 409 (apiFetch throws) — the
        // operator sees the conflicting issue id instead of a 200 they cannot interpret.
        const result = (await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, source: "linear", externalId: parsed.externalId, externalLabel: parsed.externalLabel } })) as CreateIssueResult;
        console.log(JSON.stringify(result, null, 2));
        console.error(createOutcomeHint(result));
        return 0;
      }
      case "list": {
        const query = parsed.status ? `?status=${encodeURIComponent(parsed.status)}` : "";
        const result = await apiFetch(`/api/issues${query}`);
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "show": {
        const result = await apiFetch(`/api/issues/${parsed.id}`);
        if (parsed.includeEvidence) {
          const evidence = await apiFetch(`/api/issues/${parsed.id}/evidence`);
          console.log(JSON.stringify({ ...(result as object), evidence }, null, 2));
        } else {
          console.log(JSON.stringify(result, null, 2));
        }
        return 0;
      }
      case "start": {
        // NOT-118: start moves the issue to the front of the admission queue. It either
        // admits it right away or leaves it waiting at position 1 — never a queue bypass.
        const result = (await apiFetch(`/api/issues/${parsed.id}/start`, { method: "POST" })) as StartIssueResponse;
        console.log(JSON.stringify(result, null, 2));
        console.error(
          result.state === "admitted"
            ? "Admitted — the workflow started."
            : `Queued at position ${result.position}${result.waitReason ? ` — ${result.waitReason}` : ""}.`
        );
        return 0;
      }
      case "guide": {
        const result = await apiFetch(`/api/issues/${parsed.id}/guidance`, { method: "POST", body: { markdown: parsed.message } });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

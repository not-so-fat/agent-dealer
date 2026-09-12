import { apiFetch } from "./http.js";

export { resolveApiBase } from "./http.js";

export type ParsedIssueArgs =
  | { subcommand: "create"; title: string; repo: string; developerAgentId: string; reviewerAgentId: string; description?: string; acceptanceCriteria?: string; baseBranch?: string }
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
      return { subcommand: "create", title, repo, developerAgentId, reviewerAgentId, description: flag(rest, "--description"), acceptanceCriteria: flag(rest, "--acceptance-criteria"), baseBranch: flag(rest, "--base-branch") };
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
        const result = await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, description: parsed.description, acceptanceCriteria: parsed.acceptanceCriteria, baseBranch: parsed.baseBranch, source: "agent" } });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "import": {
        const result = await apiFetch("/api/issues", { method: "POST", body: { title: parsed.title, repo: parsed.repo, developerAgentId: parsed.developerAgentId, reviewerAgentId: parsed.reviewerAgentId, source: "linear", externalId: parsed.externalId, externalLabel: parsed.externalLabel } });
        console.log(JSON.stringify(result, null, 2));
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
        const result = await apiFetch(`/api/issues/${parsed.id}/start`, { method: "POST" });
        console.log(JSON.stringify(result, null, 2));
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

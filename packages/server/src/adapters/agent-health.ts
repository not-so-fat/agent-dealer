import { spawn } from "node:child_process";
import fs from "node:fs";
import type { AgentHealthIssue, AgentProfile, AgentWithHealth, Runtime } from "@agent-dealer/shared";
import {
  claudeBinExists,
  cursorBinExists,
  resolveClaudeBin,
  cursorInvokeArgs,
  resolveCursorBin,
  resolveCodexBin,
  codexBinExists,
} from "../cli-env.js";
import { checkAgentDeckHealth, fetchAuthorizedDecks, isAgentDeckMcpRegistered } from "./agent-deck.js";

const RUNTIME_CACHE_MS = 60_000;
const runtimeIssueCache = new Map<Runtime, { at: number; issues: AgentHealthIssue[] }>();

function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 8000
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, output: output || "timeout" });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d) => {
      output += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
  });
}

async function runtimeIssuesUncached(runtime: Runtime): Promise<AgentHealthIssue[]> {
  if (runtime === "claude_code") {
    if (claudeBinExists()) return [];
    const ver = await runCommand(resolveClaudeBin(), ["--version"]);
    if (!ver.ok) {
      return [{ code: "cli_missing", message: "Claude CLI not found — install Claude Code" }];
    }
    return [];
  }

  if (runtime === "codex_local") {
    if (!codexBinExists()) {
      const ver = await runCommand(resolveCodexBin(), ["--version"]);
      if (!ver.ok) {
        return [{ code: "cli_missing", message: "Codex CLI not found — install Codex (`codex`)" }];
      }
    }
    const ver = await runCommand(resolveCodexBin(), ["--version"]);
    if (!ver.ok) {
      return [{ code: "cli_missing", message: "Codex CLI not found — install Codex (`codex`)" }];
    }
    // `codex --version` succeeds without auth — use login status for auth health.
    const login = await runCommand(resolveCodexBin(), ["login", "status"]);
    const out = login.output.toLowerCase();
    const loggedIn =
      login.ok &&
      (out.includes("logged in") || out.includes("authenticated") || out.includes("api key"));
    if (!loggedIn) {
      return [
        {
          code: "runtime_auth",
          message: "Run `codex login` (or set OPENAI_API_KEY for automation)",
        },
      ];
    }
    return [];
  }

  const status = await runCommand(resolveCursorBin(), cursorInvokeArgs(["status"]));
  if (!status.ok && !status.output.trim() && !cursorBinExists()) {
    return [{ code: "cli_missing", message: "cursor-agent not found — run: curl https://cursor.com/install -fsS | bash" }];
  }
  const out = status.output.toLowerCase();
  if (out.includes("not logged in") || out.includes("login required") || out.includes("not authenticated")) {
    return [{ code: "runtime_auth", message: "Run cursor-agent login" }];
  }
  return [];
}

async function runtimeIssues(runtime: Runtime): Promise<AgentHealthIssue[]> {
  const cached = runtimeIssueCache.get(runtime);
  if (cached && Date.now() - cached.at < RUNTIME_CACHE_MS) {
    return cached.issues;
  }
  const issues = await runtimeIssuesUncached(runtime);
  runtimeIssueCache.set(runtime, { at: Date.now(), issues });
  return issues;
}

function agentSpecificIssues(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  mcpRegistered: boolean,
  deckAccessError: string | null
): AgentHealthIssue[] {
  const issues: AgentHealthIssue[] = [];
  if (!agent.workspaceRoot) {
    issues.push({ code: "workspace_missing", message: "Set workspace on Agents page" });
  } else if (!fs.existsSync(agent.workspaceRoot)) {
    issues.push({
      code: "workspace_missing",
      message: `Workspace path not found: ${agent.workspaceRoot}`,
    });
  }
  if (agent.deckId && !agentDeckOnline) {
    issues.push({ code: "deck_offline", message: "Agent Deck offline — deck MCP unavailable" });
  }
  // resolveDeckName silently returns null on this same failure elsewhere (route/index.ts) —
  // surface it here so a bound deck that can no longer be read isn't just a quiet no-op.
  if (agent.deckId && agentDeckOnline && deckAccessError) {
    issues.push({ code: "deck_unauthorized", message: deckAccessError });
  }
  if (agent.deckId && agent.runtime === "claude_code" && agentDeckOnline && !mcpRegistered) {
    issues.push({
      code: "mcp_not_registered",
      message: "Run agent-deck setup --client claude --start (Claude MCP not registered)",
    });
  }
  // Codex deck binding uses the Agent Deck marketplace plugin (not `agent-deck use --client codex`).
  return issues;
}

export async function healthForAgent(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  runtimeIssuesByRuntime?: Map<Runtime, AgentHealthIssue[]>,
  mcpRegistered?: boolean,
  deckAccessError: string | null = null
): Promise<AgentWithHealth> {
  const runtime =
    runtimeIssuesByRuntime !== undefined
      ? (runtimeIssuesByRuntime.get(agent.runtime) ?? [])
      : await runtimeIssues(agent.runtime);
  const deckMcpOk = mcpRegistered ?? isAgentDeckMcpRegistered();
  const issues: AgentHealthIssue[] = [
    ...runtime,
    ...agentSpecificIssues(agent, agentDeckOnline, deckMcpOk, deckAccessError),
  ];
  return {
    ...agent,
    healthy: issues.length === 0,
    issues,
  };
}

export async function listAgentsWithHealth(agents: AgentProfile[]): Promise<AgentWithHealth[]> {
  const agentDeckOnline = await checkAgentDeckHealth();
  const mcpRegistered = isAgentDeckMcpRegistered();
  const needsDeckAccess = agents.some((a) => a.deckId);
  const deckAccessResult = agentDeckOnline && needsDeckAccess ? await fetchAuthorizedDecks() : null;
  const deckAccessError = deckAccessResult && !deckAccessResult.ok ? deckAccessResult.message : null;
  const runtimes = [...new Set(agents.map((a) => a.runtime))];
  const runtimeIssuesByRuntime = new Map<Runtime, AgentHealthIssue[]>();
  await Promise.all(
    runtimes.map(async (runtime) => {
      runtimeIssuesByRuntime.set(runtime, await runtimeIssues(runtime));
    })
  );
  return Promise.all(
    agents.map((a) =>
      healthForAgent(a, agentDeckOnline, runtimeIssuesByRuntime, mcpRegistered, deckAccessError)
    )
  );
}

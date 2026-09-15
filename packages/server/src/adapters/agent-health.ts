import { spawn, spawnSync } from "node:child_process";
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
import { checkAgentDeckHealth, fetchDecks, isAgentDeckMcpRegistered, type DeckAccessResult } from "./agent-deck.js";
import { runtimeAvailability } from "../repository/runtime-availability.js";

const RUNTIME_LABEL: Record<Runtime, string> = {
  claude_code: "Claude",
  cursor_local: "Cursor",
  codex_local: "Codex",
};

function capHealthIssues(runtime: Runtime): AgentHealthIssue[] {
  const avail = runtimeAvailability(runtime);
  if (avail.available) return [];
  const until = new Date(avail.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [
    {
      code: "usage_capped",
      message: `${RUNTIME_LABEL[runtime]} capped until ${until}`,
    },
  ];
}

const RUNTIME_CACHE_MS = 60_000;
const runtimeIssueCache = new Map<Runtime, { at: number; issues: AgentHealthIssue[] }>();
let githubIssueCache: { at: number; issues: AgentHealthIssue[] } | null = null;

/** Exported for tests — clears the shared github + runtime health caches. */
export function clearAgentHealthCaches(): void {
  runtimeIssueCache.clear();
  githubIssueCache = null;
}

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

/** Exported for direct testing — bypasses the 60s cache in runtimeIssues(). */
export async function runtimeIssuesUncached(runtime: Runtime): Promise<AgentHealthIssue[]> {
  const issues: AgentHealthIssue[] = [];

  if (runtime === "claude_code") {
    if (claudeBinExists()) return issues;
    const ver = await runCommand(resolveClaudeBin(), ["--version"]);
    if (!ver.ok) {
      issues.push({ code: "cli_missing", message: "Claude CLI not found — install Claude Code" });
    }
    return issues;
  }

  if (runtime === "codex_local") {
    if (!codexBinExists()) {
      const ver = await runCommand(resolveCodexBin(), ["--version"]);
      if (!ver.ok) {
        issues.push({ code: "cli_missing", message: "Codex CLI not found — install Codex (`codex`)" });
        return issues;
      }
    }
    // `codex --version` succeeds without auth — use login status for auth health.
    const login = await runCommand(resolveCodexBin(), ["login", "status"]);
    const out = login.output.toLowerCase();
    const loggedIn =
      login.ok &&
      (out.includes("logged in") || out.includes("authenticated") || out.includes("api key"));
    if (!loggedIn) {
      issues.push({
        code: "runtime_auth",
        message: "Run `codex login` (or set OPENAI_API_KEY for automation)",
      });
    }
    return issues;
  }

  const status = await runCommand(resolveCursorBin(), cursorInvokeArgs(["status"]));
  if (!status.ok && !status.output.trim() && !cursorBinExists()) {
    issues.push({ code: "cli_missing", message: "cursor-agent not found — run: curl https://cursor.com/install -fsS | bash" });
    return issues;
  }
  const out = status.output.toLowerCase();
  if (out.includes("not logged in") || out.includes("login required") || out.includes("not authenticated")) {
    issues.push({ code: "runtime_auth", message: "Run cursor-agent login" });
  }
  return issues;
}

/**
 * Issue workflows always use `gh` after a developer session (draft PR + checks). A bad
 * or missing GitHub CLI auth wastes a full agent run and lands as `adapter_failure` —
 * surface it on every agent so Start / intake can refuse before that spend.
 */
export async function githubIssuesUncached(): Promise<AgentHealthIssue[]> {
  const status = await runCommand("gh", ["auth", "status"]);
  const out = status.output.toLowerCase();
  if (
    out.includes("enoent") ||
    out.includes("not found") ||
    out.includes("no such file") ||
    (out.includes("spawn") && out.includes("gh"))
  ) {
    return [{ code: "github_cli_missing", message: "gh CLI not found — install GitHub CLI (`gh`)" }];
  }
  if (
    !status.ok ||
    out.includes("not logged in") ||
    out.includes("failed to log in") ||
    out.includes("token in keyring is invalid") ||
    out.includes("re-authenticate") ||
    out.includes("to re-authenticate")
  ) {
    return [
      {
        code: "github_auth",
        message: "Run `gh auth login` — GitHub CLI auth required to open PRs",
      },
    ];
  }
  return [];
}

/**
 * Unit/CI tests must not call the real `gh auth status` — runners usually have no
 * usable token, and the startWorkflow preflight would refuse every kick. Set
 * `AGENT_DEALER_SKIP_GITHUB_HEALTH=1` in `test:unit` / `test:ci`. Production and
 * local `npm run dev` leave it unset so Start still refuses bad auth.
 */
function githubHealthSkippedForTests(): boolean {
  return process.env.AGENT_DEALER_SKIP_GITHUB_HEALTH === "1";
}

/** Synchronous for startWorkflow — issue kick must refuse before spending a developer round. */
export function githubIssuesSync(): AgentHealthIssue[] {
  if (githubHealthSkippedForTests()) return [];
  if (githubIssueCache && Date.now() - githubIssueCache.at < RUNTIME_CACHE_MS) {
    return githubIssueCache.issues;
  }
  const result = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    timeout: 8000,
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
  const out = output.toLowerCase();
  let issues: AgentHealthIssue[] = [];
  if (
    result.error ||
    out.includes("enoent") ||
    out.includes("not found") ||
    out.includes("no such file")
  ) {
    issues = [{ code: "github_cli_missing", message: "gh CLI not found — install GitHub CLI (`gh`)" }];
  } else if (
    result.status !== 0 ||
    out.includes("not logged in") ||
    out.includes("failed to log in") ||
    out.includes("token in keyring is invalid") ||
    out.includes("re-authenticate") ||
    out.includes("to re-authenticate")
  ) {
    issues = [
      {
        code: "github_auth",
        message: "Run `gh auth login` — GitHub CLI auth required to open PRs",
      },
    ];
  }
  githubIssueCache = { at: Date.now(), issues };
  return issues;
}

async function githubIssues(): Promise<AgentHealthIssue[]> {
  if (githubIssueCache && Date.now() - githubIssueCache.at < RUNTIME_CACHE_MS) {
    return githubIssueCache.issues;
  }
  const issues = await githubIssuesUncached();
  githubIssueCache = { at: Date.now(), issues };
  return issues;
}

async function runtimeIssues(runtime: Runtime): Promise<AgentHealthIssue[]> {
  const capIssues = capHealthIssues(runtime);
  const cached = runtimeIssueCache.get(runtime);
  if (cached && Date.now() - cached.at < RUNTIME_CACHE_MS) {
    return [...capIssues, ...cached.issues];
  }
  const issues = await runtimeIssuesUncached(runtime);
  const nonCap = issues.filter((i) => i.code !== "usage_capped");
  runtimeIssueCache.set(runtime, { at: Date.now(), issues: nonCap });
  return [...capIssues, ...nonCap];
}

function agentSpecificIssues(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  mcpRegistered: boolean,
  deckAccessResult: DeckAccessResult | null
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
  // surface it here so a bound deck that can no longer be read isn't just a quiet no-op. A
  // *successful* metadata call that simply doesn't include this deck (deleted) is the same
  // user-visible failure as the call itself failing.
  if (agent.deckId && agentDeckOnline && deckAccessResult) {
    if (!deckAccessResult.ok) {
      issues.push({ code: "deck_unauthorized", message: deckAccessResult.message });
    } else if (!deckAccessResult.decks.some((d) => d.id === agent.deckId)) {
      issues.push({
        code: "deck_unauthorized",
        message: `Deck ${agent.deckName ?? agent.deckId} is not available from Agent Deck (deleted or unreachable)`,
      });
    }
  }
  if (agent.deckId && agent.runtime === "claude_code" && agentDeckOnline && !mcpRegistered) {
    issues.push({
      code: "mcp_not_registered",
      message: "Run agent-deck setup --client claude --start (Claude MCP not registered)",
    });
  }
  return issues;
}

export async function healthForAgent(
  agent: AgentProfile,
  agentDeckOnline: boolean,
  runtimeIssuesByRuntime?: Map<Runtime, AgentHealthIssue[]>,
  mcpRegistered?: boolean,
  deckAccessResult: DeckAccessResult | null = null,
  githubIssuesList?: AgentHealthIssue[]
): Promise<AgentWithHealth> {
  const runtime =
    runtimeIssuesByRuntime !== undefined
      ? (runtimeIssuesByRuntime.get(agent.runtime) ?? [])
      : await runtimeIssues(agent.runtime);
  const deckMcpOk = mcpRegistered ?? isAgentDeckMcpRegistered();
  const github = githubIssuesList ?? (await githubIssues());
  const issues: AgentHealthIssue[] = [
    ...runtime,
    ...github,
    ...agentSpecificIssues(agent, agentDeckOnline, deckMcpOk, deckAccessResult),
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
  const deckAccessResult = agentDeckOnline && needsDeckAccess ? await fetchDecks() : null;
  const runtimes = [...new Set(agents.map((a) => a.runtime))];
  const runtimeIssuesByRuntime = new Map<Runtime, AgentHealthIssue[]>();
  const [, githubIssuesList] = await Promise.all([
    Promise.all(
      runtimes.map(async (runtime) => {
        runtimeIssuesByRuntime.set(runtime, await runtimeIssues(runtime));
      })
    ),
    githubIssues(),
  ]);
  return Promise.all(
    agents.map((a) =>
      healthForAgent(
        a,
        agentDeckOnline,
        runtimeIssuesByRuntime,
        mcpRegistered,
        deckAccessResult,
        githubIssuesList
      )
    )
  );
}

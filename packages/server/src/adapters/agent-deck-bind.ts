// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session (NOT-106). Before a
// developer/reviewer session spawns, the coordinator materializes a per-attempt,
// runtime-specific MCP config that sends `x-agent-deck-deck-id` (+ workspace) with
// **no** Authorization — Agent Deck's launch-fixed deck session (NOT-105). Then it
// verifies with a live `get_bound_deck` before spawn.
//
// Worker prompts still instruct `bind_workspace` first; under a launch-fixed deck that
// bind confirms the equipped deck (and rejects a different one with DECK_FIXED).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Runtime } from "@agent-dealer/shared";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import { getExecutionAuthorityConfigDir } from "../paths.js";
import { resolveAmbientCodexHome } from "../cli-env.js";

const CODEX_HOME_ENV_VAR = "CODEX_HOME";

/** One tool call within a single connected MCP session. */
export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type WorkerDeckConnectionOutcome =
  | {
      ok: true;
      /** Runtime-specific: a claude `--mcp-config` file, a codex `CODEX_HOME` directory,
       * or the cursor worktree `.cursor/mcp.json` path. */
      mcpConfigPath: string;
      /** Extra env the spawned CLI needs — codex needs `CODEX_HOME` pointed at the scoped directory. */
      mcpEnv?: Record<string, string>;
    }
  | { ok: false; kind: "infra_failure"; reason: string };

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  return Array.isArray(content)
    ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("\n").trim()
    : "";
}

/** MCP surfaces tool failures as `{ isError: true }` results, not thrown errors. */
export function assertToolResultOk(result: unknown, name: string): void {
  if ((result as { isError?: boolean } | null)?.isError) {
    throw new Error(`${name} returned an error: ${resultText(result) || "(no detail)"}`);
  }
}

/**
 * Parse Deck's typed `INTERACTION_REQUIRED` contract error from an MCP tool result.
 * Kept for callers that still inspect tool results (e.g. legacy paths); launch-fixed
 * deck sessions no longer park on this for worker/coordinator Deck connects.
 */
export function parseInteractionRequired(result: unknown): { requestId?: string; message?: string } | null {
  if (!(result as { isError?: boolean } | null)?.isError) return null;
  try {
    const body = parseDeckToolResult(result) as {
      error_code?: string;
      message?: string;
      correlation?: { requestId?: string };
    };
    if (body.error_code !== "INTERACTION_REQUIRED") return null;
    return { requestId: body.correlation?.requestId, message: body.message };
  } catch {
    return null;
  }
}

/** Pull the text payload out of a (non-error) MCP tool result and JSON-parse it. */
export function parseDeckToolResult(result: unknown): Record<string, unknown> {
  const text = resultText(result);
  if (!text) throw new Error("empty tool result");
  return JSON.parse(text) as Record<string, unknown>;
}

interface MaterializedMcpConfig {
  mcpConfigPath: string;
  mcpEnv?: Record<string, string>;
}

const CODEX_AUTH_POLICY_KEYS = [
  "cli_auth_credentials_store",
  "chatgpt_base_url",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
] as const;

function readAmbientCodexAuthPolicy(ambientCodexHome: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(path.join(ambientCodexHome, "config.toml"), "utf8");
    const root = parseToml(raw) as Record<string, unknown>;
    const policy: Record<string, unknown> = {};
    for (const key of CODEX_AUTH_POLICY_KEYS) {
      if (key in root && (typeof root[key] === "string" || typeof root[key] === "number" || typeof root[key] === "boolean")) {
        policy[key] = root[key];
      }
    }
    return policy;
  } catch {
    return {};
  }
}

function deckLaunchHeaders(deckId: string, worktreePath: string): Record<string, string> {
  return {
    "x-agent-deck-deck-id": deckId,
    "x-agent-deck-workspace": worktreePath,
  };
}

/** claude's `--mcp-config` file schema — deck headers only, no Authorization. */
function urlHeaderMcpConfig(mcpUrl: string, deckId: string, worktreePath: string) {
  return {
    mcpServers: {
      "agent-deck": {
        type: "http",
        url: mcpUrl,
        headers: deckLaunchHeaders(deckId, worktreePath),
      },
    },
  };
}

function gitCaptured(worktreePath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", ["-C", worktreePath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout ?? "", stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
  }
}

function isCursorMcpTracked(worktreePath: string): boolean {
  const result = gitCaptured(worktreePath, ["ls-files", "--error-unmatch", ".cursor/mcp.json"]);
  return result.ok;
}

/** Append `/.cursor/mcp.json` idempotently to git's info/exclude.
 *
 * Note: for a linked worktree, `git rev-parse --git-path info/exclude` resolves to the
 * *main* repository's `.git/info/exclude` (shared across all worktrees of that repo), not
 * a per-worktree file. The `/.cursor/mcp.json` pattern is still correct per worktree root;
 * we rewrite with a single occurrence so concurrent preparations can't leave duplicate lines. */
function ensureCursorMcpExcluded(worktreePath: string): void {
  const excludePathResult = gitCaptured(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludePathResult.ok) {
    throw new Error(`could not resolve git info/exclude: ${excludePathResult.stderr || "unknown error"}`);
  }
  const excludePath = path.resolve(worktreePath, excludePathResult.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const line = "/.cursor/mcp.json";
  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && l.trim() !== line);
  kept.push(line);
  fs.writeFileSync(excludePath, `${kept.join("\n")}\n`, { mode: 0o644 });
}

/**
 * Writes this attempt's deck-launch MCP config as the spawned worker's route to Agent Deck
 * (NOT-106) — no mint, no Authorization.
 *
 * - claude: JSON file outside the worktree (`--mcp-config --strict-mcp-config`).
 * - codex: per-attempt `CODEX_HOME` outside the worktree with `http_headers` in config.toml.
 * - cursor: `<worktree>/.cursor/mcp.json` + info/exclude so the worktree stays porcelain-clean.
 */
async function materializeWorkerMcpConfig(opts: {
  runtime: Runtime;
  deckId: string;
  worktreePath: string;
}): Promise<MaterializedMcpConfig> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const mcpUrl = `${mcpBase}/mcp`;
  const headers = deckLaunchHeaders(opts.deckId, opts.worktreePath);

  if (opts.runtime === "codex_local") {
    const codexHome = path.join(getExecutionAuthorityConfigDir(), `codex-home-${opts.deckId.slice(0, 8)}-${randomUUID()}`);
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    try {
      const ambientHome = resolveAmbientCodexHome();
      try {
        const ambientAuthPath = path.join(ambientHome, "auth.json");
        if (fs.existsSync(ambientAuthPath)) {
          fs.symlinkSync(ambientAuthPath, path.join(codexHome, "auth.json"));
        }
      } catch {
        // best-effort — OS-keychain-backed hosts have no auth.json
      }
      const toml = stringifyToml({
        ...readAmbientCodexAuthPolicy(ambientHome),
        mcp_servers: {
          "agent-deck": { url: mcpUrl, http_headers: headers },
        },
      });
      fs.writeFileSync(path.join(codexHome, "config.toml"), toml, { mode: 0o600 });
    } catch (err) {
      fs.rmSync(codexHome, { recursive: true, force: true });
      throw err;
    }
    return {
      mcpConfigPath: codexHome,
      mcpEnv: { [CODEX_HOME_ENV_VAR]: codexHome },
    };
  }

  if (opts.runtime === "cursor_local") {
    if (isCursorMcpTracked(opts.worktreePath)) {
      throw new Error(
        ".cursor/mcp.json is tracked in this repository — refusing to overwrite a tracked file for the worker MCP config"
      );
    }
    ensureCursorMcpExcluded(opts.worktreePath);
    const cursorDir = path.join(opts.worktreePath, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const filePath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { "agent-deck": { url: mcpUrl, headers } } }, null, 2) + "\n",
      { mode: 0o600 }
    );
    return { mcpConfigPath: filePath };
  }

  // claude_code
  const dir = getExecutionAuthorityConfigDir();
  const filePath = path.join(dir, `claude-mcp-${opts.deckId.slice(0, 8)}-${randomUUID()}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(urlHeaderMcpConfig(mcpUrl, opts.deckId, opts.worktreePath)), { mode: 0o600 });
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }
  return { mcpConfigPath: filePath };
}

/** `get_bound_deck`'s deck-identity field. */
function assertBoundDeckMatches(result: unknown, expectedDeckId: string): void {
  const payload = parseDeckToolResult(result);
  const boundDeckId = typeof payload.id === "string" ? payload.id : undefined;
  if (boundDeckId !== expectedDeckId) {
    throw new Error(`get_bound_deck returned deck ${boundDeckId ?? "(missing id)"}, expected ${expectedDeckId}`);
  }
}

type VerifyDeckResult = { ok: true } | { ok: false; kind: "infra_failure"; reason: string };

async function verifyDeckConnection(opts: {
  deckId: string;
  worktreePath: string;
  callTool?: DeckToolCaller;
  timeoutMs: number;
}): Promise<VerifyDeckResult> {
  if (opts.callTool) {
    let result: unknown;
    try {
      result = await opts.callTool("get_bound_deck", {});
    } catch (err) {
      return { ok: false, kind: "infra_failure", reason: (err as Error).message };
    }
    try {
      assertToolResultOk(result, "get_bound_deck");
      assertBoundDeckMatches(result, opts.deckId);
      return { ok: true };
    } catch (err) {
      return { ok: false, kind: "infra_failure", reason: (err as Error).message };
    }
  }
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: deckLaunchHeaders(opts.deckId, opts.worktreePath) },
  });
  const client = new Client({ name: "agent-dealer-deck-preflight", version: "0.0.1" });
  try {
    await client.connect(transport);
    try {
      const result = await Promise.race([
        client.callTool({ name: "get_bound_deck", arguments: {} }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`get_bound_deck timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs)
        ),
      ]);
      assertToolResultOk(result, "get_bound_deck");
      assertBoundDeckMatches(result, opts.deckId);
      return { ok: true };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: (err as Error).message };
  }
}

/**
 * Materialize a per-attempt MCP config for the profile's deck and verify with
 * `get_bound_deck` before spawn. No mint, no ledger, no Authorization.
 */
export async function prepareWorkerDeckConnection(opts: {
  deckId: string;
  worktreePath: string;
  runtime: Runtime;
  verifyCallTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<WorkerDeckConnectionOutcome> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);

  let materialized: MaterializedMcpConfig;
  try {
    materialized = await materializeWorkerMcpConfig({
      runtime: opts.runtime,
      deckId: opts.deckId,
      worktreePath: opts.worktreePath,
    });
  } catch (err) {
    return { ok: false, kind: "infra_failure", reason: `deck MCP materialization failed: ${(err as Error).message}` };
  }

  const verified = await verifyDeckConnection({
    deckId: opts.deckId,
    worktreePath: opts.worktreePath,
    callTool: opts.verifyCallTool,
    timeoutMs,
  });
  if (!verified.ok) {
    try {
      fs.rmSync(materialized.mcpConfigPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return { ok: false, kind: "infra_failure", reason: `deck preflight failed: ${verified.reason}` };
  }

  return { ok: true, mcpConfigPath: materialized.mcpConfigPath, mcpEnv: materialized.mcpEnv };
}

/** Best-effort cleanup of the on-disk MCP config after a spawn ends. */
export async function releaseWorkerDeckConnection(opts: { mcpConfigPath: string }): Promise<void> {
  try {
    fs.rmSync(opts.mcpConfigPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

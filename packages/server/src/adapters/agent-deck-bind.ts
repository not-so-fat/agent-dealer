// packages/server/src/adapters/agent-deck-bind.ts
//
// Server-side Agent Deck preflight for a worker session (NOT-87/92). A generated worktree
// must never inherit a persistent, path-scoped credential, so before a developer/reviewer
// session spawns the coordinator mints a short-lived execution authority for this specific
// attempt (NOT-85 §5.2), materializes a per-attempt, runtime-specific MCP config carrying
// that authority as the spawned worker's *only* way to reach Agent Deck (see
// `materializeWorkerMcpConfig`), and hands the result back for `spawn.ts` to wire into the
// runtime's own CLI invocation.
//
// This replaces the NOT-60 `bindAndVerify`/`bind_workspace` preflight: under execution
// authority, `bind_workspace` is deny-by-default control-plane (Deck returns
// INTERACTION_REQUIRED for it unconditionally — the deck/scope is already pinned by the
// authority at mint time, per NOT-86's as-built `EXECUTION_AUTHORITY_ALLOWED_TOOLS`
// allowlist). A live `get_bound_deck` round-trip using the freshly minted authority
// stands in for the old bind+verify round-trip, catching a bad mint (wrong deck,
// audience mismatch) before the paid worker session ever spawns.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Runtime } from "@agent-dealer/shared";
import { getAgentDeckMcpUrl } from "./agent-deck.js";
import { worktreeGitDir } from "./git-worktree.js";
import { mintAuthority as defaultMintAuthority, revokeAuthority, type MintAuthorityInput, type MintAuthorityResult } from "./execution-authority.js";
import { getExecutionAuthorityConfigDir } from "../paths.js";

export { revokeAuthority };

const DEFAULT_TTL_MS = 30 * 60_000;

const CODEX_BEARER_ENV_VAR = "AGENT_DECK_AUTHORITY_BEARER";

/** One tool call within a single connected MCP session. */
export type DeckToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type WorkerAuthorityOutcome =
  | {
      ok: true;
      authorityId: string;
      /** Runtime-specific: a claude `--mcp-config` file, a codex `CODEX_HOME` directory,
       * or (cursor) a scoped `.cursor/mcp.json` written *inside* the worktree — see
       * `materializeWorkerMcpConfig`. */
      mcpConfigPath: string;
      /** Extra env the spawned CLI needs to resolve mcpConfigPath — only codex uses this
       * (its bearer token is read from an env var, never written to config.toml). */
      mcpEnv?: Record<string, string>;
      expiresAt: string;
    }
  /** Deck returned a typed control-plane requirement — never retried with the same inputs;
   * the caller must release the worker and route to a human action (NOT-87 §6.3). */
  | { ok: false; kind: "interaction_required"; reason: string }
  /** Enrollment/config/network failure — the caller's existing bounded infra-retry policy applies. */
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

/** Shared by claude's `--mcp-config` file and cursor's `.cursor/mcp.json` — same schema. */
function urlHeaderMcpConfig(mcpUrl: string, authorityId: string, authoritySecret: string, worktreePath: string) {
  return {
    mcpServers: {
      "agent-deck": {
        type: "http",
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${authorityId}:${authoritySecret}`,
          "x-agent-deck-workspace": worktreePath,
        },
      },
    },
  };
}

/**
 * Writes this attempt's execution authority as the spawned worker's *only* route to
 * Agent Deck (NOT-87/92) — never merged with, or falling back to, any ambient/user MCP
 * config. Where the config can live is runtime-specific:
 *
 * - claude: a JSON file outside the worktree (`--mcp-config --strict-mcp-config`).
 * - codex: a per-attempt `CODEX_HOME` directory outside the worktree, whose
 *   `config.toml` names the server and an env-var to read the bearer token from —
 *   the secret itself is passed via that env var at spawn time, never written to disk.
 * - cursor: cursor-agent has no flag to source MCP config from outside the directory
 *   it's already operating in, so the scoped config is written to the worktree's own
 *   `.cursor/mcp.json` and removed by `releaseWorkerAuthority` before the worktree is
 *   ever pushed or reused (owner-accepted tradeoff — see NOT-92).
 */
async function materializeWorkerMcpConfig(opts: {
  runtime: Runtime;
  authorityId: string;
  authoritySecret: string;
  worktreePath: string;
}): Promise<MaterializedMcpConfig> {
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const mcpUrl = `${mcpBase}/mcp`;

  if (opts.runtime === "cursor_local") {
    const cursorDir = path.join(opts.worktreePath, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const filePath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify(urlHeaderMcpConfig(mcpUrl, opts.authorityId, opts.authoritySecret, opts.worktreePath)),
      { mode: 0o600 }
    );
    // A developer worktree is writable and has ordinary Bash/git access — the worker's
    // own `git add -A && git push` (its normal way of delivering the change, see
    // git-worktree.ts's `createRoleWorktree` doc comment) could otherwise stage and push
    // this secret before the coordinator ever gets a chance to revoke and delete it
    // post-spawn. `info/exclude` is this worktree's own private git metadata — never
    // committed, never shared with the target repo's tracked `.gitignore` — so this is
    // safe to do unconditionally, including against a repo the worker also controls.
    try {
      const gitDir = await worktreeGitDir(opts.worktreePath);
      const infoDir = path.join(gitDir, "info");
      fs.mkdirSync(infoDir, { recursive: true });
      fs.appendFileSync(path.join(infoDir, "exclude"), "\n/.cursor/mcp.json\n");
    } catch {
      // best-effort: worst case the file is merely untracked, not un-stageable
    }
    return { mcpConfigPath: filePath };
  }

  if (opts.runtime === "codex_local") {
    const codexHome = path.join(getExecutionAuthorityConfigDir(), `codex-home-${opts.authorityId}-${randomUUID()}`);
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const toml = [
      "[mcp_servers.agent-deck]",
      `url = ${JSON.stringify(mcpUrl)}`,
      `bearer_token_env_var = ${JSON.stringify(CODEX_BEARER_ENV_VAR)}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(codexHome, "config.toml"), toml, { mode: 0o600 });
    return {
      mcpConfigPath: codexHome,
      mcpEnv: { [CODEX_BEARER_ENV_VAR]: `${opts.authorityId}:${opts.authoritySecret}` },
    };
  }

  const dir = getExecutionAuthorityConfigDir();
  const filePath = path.join(dir, `${opts.authorityId}-${randomUUID()}.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(urlHeaderMcpConfig(mcpUrl, opts.authorityId, opts.authoritySecret, opts.worktreePath)),
    { mode: 0o600 }
  );
  return { mcpConfigPath: filePath };
}

async function verifyAuthority(opts: {
  authorityId: string;
  authoritySecret: string;
  callTool?: DeckToolCaller;
  timeoutMs: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.callTool) {
    try {
      const result = await opts.callTool("get_bound_deck", {});
      assertToolResultOk(result, "get_bound_deck");
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
  const mcpBase = getAgentDeckMcpUrl().replace(/\/mcp\/?$/, "");
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${opts.authorityId}:${opts.authoritySecret}` } },
  });
  const client = new Client({ name: "agent-dealer-authority-preflight", version: "0.0.1" });
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
      return { ok: true };
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function interactionRequiredReason(result: Extract<MintAuthorityResult, { ok: false }>): string {
  return result.message || "Agent Deck requires a control-plane decision before this attempt can continue.";
}

export async function acquireWorkerAuthority(opts: {
  deckId: string;
  runId: string;
  attemptId: string;
  idempotencyKey: string;
  worktreePath: string;
  runtime: Runtime;
  ttlMs?: number;
  mint?: (input: MintAuthorityInput) => Promise<MintAuthorityResult>;
  verifyCallTool?: DeckToolCaller;
  timeoutMs?: number;
}): Promise<WorkerAuthorityOutcome> {
  const mint = opts.mint ?? defaultMintAuthority;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DECK_BIND_TIMEOUT_MS ?? 30_000);

  const minted = await mint({
    runId: opts.runId,
    attemptId: opts.attemptId,
    deckId: opts.deckId,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    idempotencyKey: opts.idempotencyKey,
  });
  if (!minted.ok) {
    if (minted.code === "INTERACTION_REQUIRED") {
      return { ok: false, kind: "interaction_required", reason: interactionRequiredReason(minted) };
    }
    return { ok: false, kind: "infra_failure", reason: `${minted.code}: ${minted.message}` };
  }
  const { authority } = minted;
  if (!authority.authoritySecret) {
    // Idempotent remint of a still-live authority under the same (enrollmentId,
    // idempotencyKey) never re-issues the secret (NOT-85 §7) — this attempt has none to
    // use. Each physical claim mints with a fresh idempotency key, so this should not
    // happen in normal operation; surface it as infra rather than silently proceeding
    // secret-less.
    return {
      ok: false,
      kind: "infra_failure",
      reason: `authority ${authority.authorityId} minted without a secret (idempotent remint) — retry with a fresh attempt`,
    };
  }

  const verified = await verifyAuthority({
    authorityId: authority.authorityId,
    authoritySecret: authority.authoritySecret,
    callTool: opts.verifyCallTool,
    timeoutMs,
  });
  if (!verified.ok) {
    await revokeAuthority(authority.authorityId);
    return { ok: false, kind: "infra_failure", reason: `authority preflight failed: ${verified.reason}` };
  }

  const { mcpConfigPath, mcpEnv } = await materializeWorkerMcpConfig({
    runtime: opts.runtime,
    authorityId: authority.authorityId,
    authoritySecret: authority.authoritySecret,
    worktreePath: opts.worktreePath,
  });
  return { ok: true, authorityId: authority.authorityId, mcpConfigPath, mcpEnv, expiresAt: authority.expiresAt };
}

/**
 * Best-effort — never leaves a live authority or its on-disk config around after a spawn
 * ends. `recursive: true` covers codex's directory-shaped config as well as claude/
 * cursor's single file; cursor's is removed from inside the worktree specifically so it
 * never reaches a push or a later reused worktree.
 */
export async function releaseWorkerAuthority(opts: { authorityId: string; mcpConfigPath: string }): Promise<void> {
  try {
    fs.rmSync(opts.mcpConfigPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  await revokeAuthority(opts.authorityId);
}
